use crate::db::DbState;
use crate::error::{AppError, AppResult};
use crate::queue::PrintQueue;
use crate::render::handlebars::TemplateEngine;
use crate::render::PdfRenderer;
#[cfg(windows)]
use crate::transport::windows_spooler::WindowsSpooler;
use serde::{Deserialize, Serialize};
use std::time::Instant;
use tauri::{AppHandle, Manager, State};

#[derive(Debug, Clone, Deserialize)]
pub struct PrintRequest {
    pub printer_name: String,
    pub html: String,
    pub page_width_mm: Option<f64>,
    pub page_height_mm: Option<f64>,
    pub orientation: Option<String>,
    pub copies: Option<u32>,

    /// Layout options (mm). Defaults mirror the UI defaults.
    #[serde(default)]
    pub margin_top: Option<f64>,
    #[serde(default)]
    pub margin_right: Option<f64>,
    #[serde(default)]
    pub margin_bottom: Option<f64>,
    #[serde(default)]
    pub margin_left: Option<f64>,

    /// one of: actual | fit-width | fit-page | shrink | fill
    #[serde(default)]
    pub fit_mode: Option<String>,

    /// When set, render this template from the DB instead of raw HTML.
    #[serde(default)]
    pub template_id: Option<i64>,
    /// Pin to an exact template version (used by Reprint).
    #[serde(default)]
    pub template_version_id: Option<i64>,
    /// JSON payload merged into the template context.
    #[serde(default)]
    pub data: Option<serde_json::Value>,
    #[serde(default)]
    pub data_url: Option<String>,
    #[serde(default)]
    pub test: Option<bool>,
    #[serde(default)]
    pub source: Option<String>,
    /// Caller-supplied de-duplication key (REST `Idempotency-Key` header).
    ///
    /// It is persisted with the job row, because the replay guard in the API
    /// middleware works by looking for an existing row with this key. Before
    /// this existed the guard was dead code: nothing ever wrote the column, so
    /// a replayed request was never detected and printed twice.
    #[serde(default)]
    pub idempotency_key: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct PrintResponse {
    pub success: bool,
    pub job_id: String,
    pub duration_ms: u128,
    pub error: Option<String>,
}

/// Load template HTML/CSS for a job (pinned version, or current version).
fn resolve_template(
    conn: &rusqlite::Connection,
    template_id: i64,
    version_id: Option<i64>,
) -> AppResult<(String, String, i64, f64, f64)> {
    let version_id = match version_id {
        Some(v) => v,
        None => {
            let current: Option<i64> = conn
                .query_row(
                    "SELECT current_version_id FROM templates WHERE id = ?1",
                    [template_id],
                    |r| r.get(0),
                )
                .map_err(|_| AppError::NotFound(format!("Template {} not found", template_id)))?;
            current.ok_or_else(|| {
                AppError::NotFound(format!("Template {} has no versions", template_id))
            })?
        }
    };

    let (html, css): (String, String) = conn
        .query_row(
            "SELECT html, css FROM template_versions WHERE id = ?1 AND template_id = ?2",
            [version_id, template_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|_| AppError::NotFound(format!("Version {} not found", version_id)))?;

    let (w, h): (i64, i64) = conn
        .query_row(
            "SELECT page_w_mm, page_h_mm FROM templates WHERE id = ?1",
            [template_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|_| AppError::NotFound(format!("Template {} not found", template_id)))?;

    Ok((html, css, version_id, w as f64, h as f64))
}

/// Build the final HTML with `@page` size + margins injected so the PDF
/// renderer honours the layout form (PLANNING.md 7.7 profile settings).
pub fn apply_layout(html: &str, css: &str, w_mm: f64, h_mm: f64, req: &PrintRequest) -> String {
    let mt = req.margin_top.unwrap_or(5.0);
    let mr = req.margin_right.unwrap_or(5.0);
    let mb = req.margin_bottom.unwrap_or(5.0);
    let ml = req.margin_left.unwrap_or(5.0);

    let (pw, ph) = if req.orientation.as_deref() == Some("landscape") {
        (h_mm, w_mm)
    } else {
        (w_mm, h_mm)
    };

    // Strip any pre-existing @page so we don't end up with two conflicting rules.
    let cleaned_css = strip_at_page(css);

    let page_rule =
        format!("@page {{ size: {pw}mm {ph}mm; margin: {mt}mm {mr}mm {mb}mm {ml}mm; }}");

    let fit_rule = match req.fit_mode.as_deref().unwrap_or("fit-width") {
        "fit-width" => "html,body{width:100%;height:auto;}",
        "fit-page" | "fill" => "html,body{width:100%;height:100%;}",
        "shrink" => "@media print{html,body{-webkit-print-color-adjust:exact;}}",
        _ => "",
    };

    // The template's own CSS must survive layout injection. It used to be
    // dropped entirely whenever the HTML was a full document (which every
    // bundled starter template is), so custom styling never reached the
    // printer. User CSS first so the @page/fit rules win.
    let styles = format!("{cleaned_css}\n{page_rule}\n{fit_rule}");

    if let Some(idx) = html.find("</head>") {
        format!("{}<style>{}</style>{}", &html[..idx], styles, &html[idx..])
    } else if let Some(idx) = html.find("<body") {
        format!("{}<style>{}</style>{}", &html[..idx], styles, &html[idx..])
    } else {
        format!("<style>{styles}</style>{html}")
    }
}

/// Remove an existing `@page { ... }` block from user CSS.
fn strip_at_page(css: &str) -> String {
    let mut out = String::with_capacity(css.len());
    let mut rest = css;
    while let Some(idx) = rest.find("@page") {
        out.push_str(&rest[..idx]);
        let after = &rest[idx..];
        match after.find('{') {
            Some(brace) => match after.find('}') {
                Some(close) if close > brace => {
                    rest = &after[close + 1..];
                }
                _ => {
                    rest = "";
                    break;
                }
            },
            None => {
                rest = "";
                break;
            }
        }
    }
    out.push_str(rest);
    out
}

/// Tauri command wrapper around [`run_print`].
#[tauri::command]
pub async fn print_html(
    app: AppHandle,
    db: State<'_, DbState>,
    queue: State<'_, PrintQueue>,
    req: PrintRequest,
) -> AppResult<PrintResponse> {
    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| AppError::Internal(format!("No cache dir: {e}")))?;
    run_print(&cache_dir, &db, &queue, req).await
}

/// Render the document and send it to the printer, logging a history row.
///
/// Plain async function rather than only a `#[tauri::command]` so the REST
/// API routes can reuse the exact same pipeline. Both entry points therefore
/// share the render, the per-printer queue permit, and the history write — a
/// caller cannot accidentally get a path that skips one of them.
pub async fn run_print(
    cache_dir: &std::path::Path,
    db: &DbState,
    queue: &PrintQueue,
    req: PrintRequest,
) -> AppResult<PrintResponse> {
    let start = Instant::now();

    if req.printer_name.trim().is_empty() {
        return Err(AppError::Validation("Select a printer first".into()));
    }
    let copies = req.copies.unwrap_or(1).max(1);

    // ── 1. Resolve content ───────────────────────────────────────────
    let (mut html, css, template_version_id, mut w_mm, mut h_mm) = match req.template_id {
        Some(tid) => {
            let guard = db
                .lock()
                .map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
            let conn = guard.connection()?;
            let (h, c, vid, tw, th) = resolve_template(&conn, tid, req.template_version_id)?;
            (h, c, Some(vid), tw, th)
        }
        None => (
            req.html.clone(),
            String::new(),
            req.template_version_id,
            req.page_width_mm.unwrap_or(210.0),
            req.page_height_mm.unwrap_or(297.0),
        ),
    };

    if let (Some(w), Some(h)) = (req.page_width_mm, req.page_height_mm) {
        if req.template_id.is_none() {
            w_mm = w;
            h_mm = h;
        }
    }

    // Fetch live data when a URL is supplied and test mode is off.
    let mut fetched: Option<serde_json::Value> = req.data.clone();
    if !req.test.unwrap_or(false) {
        if let Some(url) = &req.data_url {
            if !url.trim().is_empty() {
                let opts = crate::data::fetcher::FetchOptions {
                    url: url.clone(),
                    method: "GET".to_string(),
                    headers: None,
                    timeout_secs: 15,
                    max_size_bytes: 5 * 1024 * 1024,
                    json_path: None,
                };
                match crate::data::fetcher::DataFetcher::new().fetch(&opts).await {
                    Ok(v) => fetched = Some(v),
                    Err(e) => {
                        record_job(
                            db,
                            &req,
                            "failed",
                            Some(e.to_string()),
                            &html,
                            None,
                            copies as i64,
                            start,
                        )?;
                        return Err(AppError::Internal(format!("Data fetch failed: {}", e)));
                    }
                }
            }
        }
    }

    // ── 2. Template render ──────────────────────────────────────────
    if let Some(data) = fetched {
        let engine = TemplateEngine::new();
        html = engine.render(&html, &data).unwrap_or(html);
    }

    // ── 3. Layout ───────────────────────────────────────────────────
    let final_html = apply_layout(&html, &css, w_mm, h_mm, &req);

    // ── 4. PDF ──────────────────────────────────────────────────────
    std::fs::create_dir_all(cache_dir)
        .map_err(|e| AppError::Internal(format!("Cannot create {}: {e}", cache_dir.display())))?;
    let renderer = PdfRenderer::new(cache_dir.to_path_buf());
    let pdf_bytes = match renderer
        .html_to_pdf(
            &final_html,
            w_mm,
            h_mm,
            req.orientation.as_deref().unwrap_or("portrait"),
        )
        .await
    {
        Ok(b) => b,
        Err(e) => {
            let msg = e.to_string();
            record_job(
                db,
                &req,
                "failed",
                Some(msg.clone()),
                &html,
                None,
                copies as i64,
                start,
            )?;
            return Ok(PrintResponse {
                success: false,
                job_id: String::new(),
                duration_ms: start.elapsed().as_millis(),
                error: Some(msg),
            });
        }
    };

    // ── 5. Send ─────────────────────────────────────────────────────
    // Resolve the stored printer row so the right transport is used and so
    // the queue can serialise on a stable key. A printer that is not in the
    // DB still prints, via the platform default.
    let printer = lookup_printer(db, &req.printer_name);

    let printer_type =
        crate::transport::parse_printer_type(printer.as_ref().map_or("", |p| p.0.as_str()));
    let address = printer.as_ref().map_or("", |p| p.1.as_str());

    // Hold this printer's permit across the whole send. Two jobs for the
    // same physical printer must never overlap, or their bytes interleave
    // and the label comes out garbled. Jobs for *different* printers are
    // unaffected — the semaphore is keyed per printer id.
    let result = queue
        .with_permit(&req.printer_name, async {
            // Admit the job so a full queue reports back-pressure instead of
            // silently dropping it.
            queue
                .submit(crate::queue::QueueJob {
                    job_id: format!("pending-{}", uuid::Uuid::new_v4()),
                    printer_id: req.printer_name.clone(),
                    data: pdf_bytes.clone(),
                    mime_type: "application/pdf".to_string(),
                    copies,
                })
                .await?;

            // `copies` used to be ignored entirely: exactly one copy reached
            // the printer no matter what the operator selected.
            for copy in 0..copies {
                crate::transport::TransportRegistry::send_to(
                    &printer_type,
                    &req.printer_name,
                    address,
                    crate::transport::RenderedJob {
                        job_id: format!("{}-{}", req.printer_name, copy + 1),
                        printer_id: req.printer_name.clone(),
                        data: pdf_bytes.clone(),
                        mime_type: "application/pdf".to_string(),
                        copies: 1,
                    },
                )
                .await
                .map_err(|e| {
                    if copy > 0 {
                        format!("copy {}/{copies}: {e}", copy + 1)
                    } else {
                        e
                    }
                })?;
            }
            Ok(())
        })
        .await;

    let duration = start.elapsed().as_millis();
    let (status, err) = match result {
        Ok(()) => ("success", None),
        Err(e) => ("failed", Some(e)),
    };

    // ── 6. History ──────────────────────────────────────────────────
    let job_id = record_job(
        db,
        &req,
        status,
        err.clone(),
        &html,
        template_version_id,
        copies as i64,
        start,
    )?;

    Ok(PrintResponse {
        success: status == "success",
        job_id,
        duration_ms: duration,
        error: err,
    })
}

/// Look up a printer's stored `(printer_type, address)` by name.
///
/// Returns `None` when the printer is not in the DB, which is legal: the
/// caller falls back to the platform default transport.
pub fn lookup_printer(db: &DbState, name: &str) -> Option<(String, String)> {
    let guard = db.lock().ok()?;
    let conn = guard.connection().ok()?;
    conn.query_row(
        "SELECT type, COALESCE(address, '') FROM printers WHERE name = ?1 COLLATE NOCASE",
        [name],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .ok()
}

fn is_sensitive_key(key: &str) -> bool {
    let k = key.to_ascii_lowercase();
    k.contains("token")
        || k.contains("password")
        || k.contains("secret")
        || k == "api_key"
        || k == "apikey"
        || k.contains("api-key")
        || k.contains("authorization")
        || k.contains("credential")
        || k == "key"
        || k == "auth"
}

fn collect_secrets(value: &serde_json::Value, out: &mut Vec<String>) {
    match value {
        serde_json::Value::Object(map) => {
            for (k, v) in map {
                if is_sensitive_key(k) {
                    if let serde_json::Value::String(s) = v {
                        if s.len() > 3 {
                            out.push(s.clone());
                        }
                    }
                }
                collect_secrets(v, out);
            }
        }
        serde_json::Value::Array(arr) => {
            for v in arr {
                collect_secrets(v, out);
            }
        }
        _ => {}
    }
}

fn redact_rendered_html(html: &str, req: &PrintRequest) -> String {
    let mut secrets = Vec::new();
    if let Some(data) = &req.data {
        collect_secrets(data, &mut secrets);
    }
    if secrets.is_empty() {
        return html.to_string();
    }
    let mut redacted = html.to_string();
    for s in secrets {
        // Avoid replacing short or common substrings; secrets are at least 4 chars.
        redacted = redacted.replace(&s, "***");
    }
    redacted
}

#[allow(clippy::too_many_arguments)]
pub fn record_job(
    db: &DbState,
    req: &PrintRequest,
    status: &str,
    error: Option<String>,
    rendered_html: &str,
    template_version_id: Option<i64>,
    copies: i64,
    start: Instant,
) -> AppResult<String> {
    let guard = db
        .lock()
        .map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
    let conn = guard.connection()?;

    let printer_id: Option<i64> = conn
        .query_row(
            "SELECT id FROM printers WHERE name = ?1 COLLATE NOCASE",
            [&req.printer_name],
            |r| r.get(0),
        )
        .ok();

    let settings = serde_json::json!({
        "copies": copies,
        "fit": req.fit_mode,
        "orientation": req.orientation,
        "margins": {
            "top": req.margin_top, "right": req.margin_right,
            "bottom": req.margin_bottom, "left": req.margin_left,
        },
    });

    // Redact secrets from history: tokens/passwords that were in `data`
    // must not be persisted verbatim (PLANNING.md keyring/redaction).
    let redacted_html = redact_rendered_html(rendered_html, req);

    conn.execute(
        "INSERT INTO print_jobs
           (template_id, template_version_id, printer_id, source, source_url,
            status, error, copies, settings_json, rendered_html, is_test,
            started_at, finished_at, duration_ms, idempotency_key)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11,
                 datetime('now'), datetime('now'), ?12, ?13)",
        rusqlite::params![
            req.template_id,
            template_version_id,
            printer_id,
            req.source.clone().unwrap_or_else(|| "ui".into()),
            req.data_url,
            status,
            error,
            copies,
            settings.to_string(),
            redacted_html,
            i64::from(req.test.unwrap_or(false)),
            start.elapsed().as_millis() as i64,
            req.idempotency_key,
        ],
    )?;

    Ok(conn.last_insert_rowid().to_string())
}

/// Enumerate system printers
#[tauri::command]
pub fn enumerate_system_printers() -> AppResult<Vec<crate::transport::PrinterInfo>> {
    #[cfg(windows)]
    {
        Ok(WindowsSpooler::enumerate_printers())
    }
    #[cfg(not(windows))]
    {
        Ok(vec![])
    }
}

/// Spike command: print a hard-coded test page
#[tauri::command]
pub async fn spike_test_print(
    app: AppHandle,
    db: State<'_, DbState>,
    queue: State<'_, PrintQueue>,
) -> AppResult<PrintResponse> {
    let req = PrintRequest {
        printer_name: "Microsoft Print to PDF".to_string(),
        html: r#"<!DOCTYPE html><html><head><title>PrintNinja Test</title></head>
<body><h1>PrintNinja Spike Test</h1>
<p>If you can read this, the silent print pipeline works!</p>
<hr><p><small>Generated by PrintNinja</small></p></body></html>"#
            .to_string(),
        page_width_mm: Some(210.0),
        page_height_mm: Some(297.0),
        orientation: Some("portrait".to_string()),
        copies: Some(1),
        margin_top: None,
        margin_right: None,
        margin_bottom: None,
        margin_left: None,
        fit_mode: None,
        template_id: None,
        template_version_id: None,
        data: None,
        data_url: None,
        test: None,
        source: Some("test".into()),
        idempotency_key: None,
    };

    print_html(app, db, queue, req).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req() -> PrintRequest {
        PrintRequest {
            printer_name: "P".into(),
            html: "<p>x</p>".into(),
            page_width_mm: Some(100.0),
            page_height_mm: Some(200.0),
            orientation: Some("portrait".into()),
            copies: Some(1),
            margin_top: Some(5.0),
            margin_right: Some(6.0),
            margin_bottom: Some(7.0),
            margin_left: Some(8.0),
            fit_mode: Some("fit-width".into()),
            template_id: None,
            template_version_id: None,
            data: None,
            data_url: None,
            test: Some(true),
            source: None,
            idempotency_key: None,
        }
    }

    #[test]
    fn layout_injects_page_size_and_margins() {
        let out = apply_layout(
            "<html><head></head><body>x</body></html>",
            "",
            100.0,
            200.0,
            &req(),
        );
        assert!(out.contains("size: 100mm 200mm"), "{}", out);
        assert!(out.contains("margin: 5mm 6mm 7mm 8mm"), "{}", out);
    }

    #[test]
    fn layout_swaps_dimensions_in_landscape() {
        let mut r = req();
        r.orientation = Some("landscape".into());
        let out = apply_layout("<head></head>", "", 100.0, 200.0, &r);
        assert!(out.contains("size: 200mm 100mm"), "{}", out);
    }

    #[test]
    fn strip_at_page_removes_existing_rule() {
        let css = "body{color:red} @page { size: 1mm 1mm; margin: 0; } p{margin:0}";
        let cleaned = strip_at_page(css);
        assert!(!cleaned.contains("@page"), "{}", cleaned);
        assert!(cleaned.contains("color:red"));
        assert!(cleaned.contains("p{margin:0}"));
    }

    #[test]
    fn layout_only_one_page_rule() {
        let css = "@page { size: 5mm 5mm; }";
        let out = apply_layout("<head></head>", css, 100.0, 200.0, &req());
        assert_eq!(out.matches("@page").count(), 1, "{}", out);
    }

    #[test]
    fn layout_keeps_template_css_for_full_documents() {
        // Regression: the </head> branch built its <style> from the page rule
        // and fit rule only, silently discarding the template's own CSS.
        let css = ".brand{color:#f00}";
        let out = apply_layout(
            "<!DOCTYPE html><html><head></head><body>x</body></html>",
            css,
            100.0,
            200.0,
            &req(),
        );
        assert!(out.contains(".brand{color:#f00}"), "{}", out);
        assert!(out.contains("size: 100mm 200mm"), "{}", out);
    }

    #[test]
    fn layout_keeps_template_css_for_fragments() {
        let css = ".brand{color:#f00}";
        let out = apply_layout("<p>x</p>", css, 100.0, 200.0, &req());
        assert!(out.contains(".brand{color:#f00}"), "{}", out);
    }

    #[test]
    fn layout_injects_before_body_when_there_is_no_head() {
        let out = apply_layout(
            "<html><body>x</body></html>",
            ".a{color:red}",
            100.0,
            200.0,
            &req(),
        );
        assert!(out.contains(".a{color:red}"), "{}", out);
        assert!(
            out.find("<style").unwrap() < out.find("<body").unwrap(),
            "{}",
            out
        );
    }

    #[test]
    fn layout_page_rule_comes_after_user_css() {
        // The injected @page must win over any user @page-ish rule.
        let css = "body{color:red}";
        let out = apply_layout("<head></head>", css, 100.0, 200.0, &req());
        let css_at = out.find("color:red").unwrap();
        let page_at = out.find("@page").unwrap();
        assert!(css_at < page_at, "{}", out);
    }

    #[test]
    fn layout_strips_user_page_rule_but_keeps_the_rest() {
        let css = "@page{size:1mm 1mm}.keep{color:blue}";
        let out = apply_layout("<head></head>", css, 100.0, 200.0, &req());
        assert_eq!(out.matches("@page").count(), 1, "{}", out);
        assert!(out.contains(".keep{color:blue}"), "{}", out);
    }

    #[test]
    fn layout_does_not_mutate_the_body_markup() {
        let out = apply_layout(
            "<html><head></head><body><p>hi</p></body></html>",
            "",
            100.0,
            200.0,
            &req(),
        );
        assert!(out.contains("<body><p>hi</p></body>"), "{}", out);
        assert_eq!(out.matches("</head>").count(), 1, "{}", out);
    }

    #[test]
    fn redact_replaces_token_values_in_rendered_html() {
        let mut r = req();
        r.data = Some(serde_json::json!({"token": "sk-live-12345", "name": "Alice"}));
        let html = "<p>sk-live-12345 by Alice</p>";
        let out = redact_rendered_html(html, &r);
        assert!(!out.contains("sk-live-12345"), "{}", out);
        assert!(out.contains("***"), "{}", out);
        assert!(out.contains("Alice"), "{}", out);
    }

    #[test]
    fn redact_handles_nested_and_multiple_keys() {
        let mut r = req();
        r.data = Some(serde_json::json!({
            "user": {"password": "hunter2", "email": "a@b.com"},
            "api_key": "key-999"
        }));
        let html = "hunter2 a@b.com key-999";
        let out = redact_rendered_html(html, &r);
        assert!(!out.contains("hunter2"), "{}", out);
        assert!(!out.contains("key-999"), "{}", out);
        assert!(out.contains("a@b.com"), "{}", out);
    }

    #[test]
    fn redact_is_case_insensitive_and_ignores_non_sensitive() {
        let mut r = req();
        r.data = Some(serde_json::json!({"Token": "ABC123", "order_id": "XYZ"}));
        let html = "ABC123 XYZ";
        let out = redact_rendered_html(html, &r);
        assert!(!out.contains("ABC123"), "{}", out);
        assert!(out.contains("XYZ"), "{}", out);
    }

    #[test]
    fn redact_does_nothing_without_secrets() {
        let r = req();
        let html = "<p>hello</p>";
        assert_eq!(redact_rendered_html(html, &r), html);
    }

    #[test]
    fn is_sensitive_key_matches_expected_patterns() {
        assert!(is_sensitive_key("token"));
        assert!(is_sensitive_key("api_key"));
        assert!(is_sensitive_key("authorization"));
        assert!(is_sensitive_key("password"));
        assert!(!is_sensitive_key("order_id"));
        assert!(!is_sensitive_key("name"));
    }
}
