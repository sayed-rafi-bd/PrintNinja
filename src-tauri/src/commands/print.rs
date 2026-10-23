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

    /// 1-based page selector, e.g. "1-3", "2,5-7". Empty means all pages.
    /// Validated syntactically on intake; page slicing happens where the
    /// transport supports it and the range is always recorded in
    /// `settings_json` so History shows what was requested.
    #[serde(default)]
    pub page_range: Option<String>,

    /// When true, render in grayscale (`filter: grayscale(1)` injected
    /// with the layout CSS, honoured by the Chromium PDF path).
    #[serde(default)]
    pub grayscale: Option<bool>,

    /// When set, render this template from the DB instead of raw HTML.
    #[serde(default)]
    pub template_id: Option<i64>,
    /// JSON payload merged into the template context.
    #[serde(default)]
    pub data: Option<serde_json::Value>,
    #[serde(default)]
    pub data_url: Option<String>,
    /// HTTP method for fetching `data_url`: GET (default) or POST.
    /// Anything else is rejected on intake so the preview (which uses
    /// the same choice) and the pipeline can never disagree.
    #[serde(default)]
    pub http_method: Option<String>,
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

/// Where one job's time went, in whole milliseconds per pipeline stage.
///
/// Logged as the `print job timing` line, stored on the job row
/// (`print_jobs.timings_json`) so History can show it, and returned in the
/// [`PrintResponse`] so the Print page can show it right after the print.
///
/// A stage the job never reached stays `0`. `render_ms` is the PDF/raster
/// render, `send_ms` the hand-off to the printer (queue wait included) and
/// `history_ms` the write that closes the job row.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct StageTimings {
    pub fetch_ms: u64,
    pub template_ms: u64,
    pub layout_ms: u64,
    pub render_ms: u64,
    pub send_ms: u64,
    pub history_ms: u64,
    pub total_ms: u64,
}

#[derive(Debug, Serialize)]
pub struct PrintResponse {
    pub success: bool,
    pub job_id: String,
    pub duration_ms: u128,
    pub error: Option<String>,
    /// Per-stage breakdown; `None` when the job failed before any stage ran.
    pub timings: Option<StageTimings>,
}

/// The render stage of the print pipeline, as a trait.
///
/// Integration tests substitute it so a job can reach the real queue permit,
/// transport and history without a browser, or hold mid-render to observe the
/// `printing` row (P7, P15). Production passes the [`PdfRenderer`]; nothing
/// else in the pipeline is substitutable.
#[async_trait::async_trait]
pub trait JobRenderer: Send + Sync {
    async fn render(
        &self,
        final_html: &str,
        w_mm: f64,
        h_mm: f64,
        orientation: &str,
    ) -> anyhow::Result<Vec<u8>>;

    /// Rasterize `final_html` at exactly `w_px` × `h_px` dots (P4), for
    /// printers that speak a command language instead of taking a PDF.
    ///
    /// The default refuses: a renderer that cannot rasterize must fail the
    /// job loudly, never fall back to PDF bytes on a printer that would drop
    /// them. [`PdfRenderer`] overrides this with the browser-backed
    /// screenshot path; integration tests can substitute their own.
    async fn rasterize(
        &self,
        final_html: &str,
        w_px: usize,
        h_px: usize,
    ) -> anyhow::Result<crate::render::raster::RasterImage> {
        let _ = (final_html, w_px, h_px);
        Err(anyhow::anyhow!(
            "this renderer cannot rasterize HTML to dots; command-language printers \
             need the browser-backed renderer"
        ))
    }
}

#[async_trait::async_trait]
impl JobRenderer for PdfRenderer {
    async fn render(
        &self,
        final_html: &str,
        w_mm: f64,
        h_mm: f64,
        orientation: &str,
    ) -> anyhow::Result<Vec<u8>> {
        self.html_to_pdf(final_html, w_mm, h_mm, orientation).await
    }

    async fn rasterize(
        &self,
        final_html: &str,
        w_px: usize,
        h_px: usize,
    ) -> anyhow::Result<crate::render::raster::RasterImage> {
        self.html_to_raster(final_html, w_px, h_px).await
    }
}

/// Load template HTML/CSS for a job directly from the template row.
/// The tuple is `(html, css, compiled_css, width_mm, height_mm)`.
fn resolve_template(conn: &rusqlite::Connection, template_id: i64) -> AppResult<(String, String, String, f64, f64)> {
    conn.query_row(
        "SELECT html, css, compiled_css, page_w_mm, page_h_mm FROM templates WHERE id = ?1",
        [template_id],
        |r| {
            let html: String = r.get(0)?;
            let css: String = r.get(1)?;
            let compiled: String = r.get(2)?;
            let w: i64 = r.get(3)?;
            let h: i64 = r.get(4)?;
            Ok((html, css, compiled, w as f64, h as f64))
        },
    )
    .map_err(|_| AppError::NotFound(format!("Template {} not found", template_id)))
}

/// Base print stylesheet, byte-identical to `TEMPLATE_BASE_CSS` in
/// `src/lib/templates/templateCss.ts`, which the Designer/Print preview inlines.
///
/// Templates are authored with Tailwind utility classes (`text-xs`,
/// `border-b-2`, `flex`, ...). Each template version carries its own stylesheet
/// compiled from the classes it uses (`compiled_css`), so the utilities are not
/// bundled here.
const TEMPLATE_BASE_CSS: &str = include_str!("../../assets/template-base.css");

/// Base reset, then the version's compiled Tailwind CSS, then the template's
/// own CSS last so it wins (same order as the frontend).
///
/// `compiled_css` is empty for a version saved before per-template compilation
/// existed, or whose compile failed; it then prints with the base rules and its
/// own CSS only. Re-saving the template compiles it.
fn build_template_css(user_css: &str, compiled_css: &str) -> String {
    let mut parts = vec![TEMPLATE_BASE_CSS.trim()];
    if !compiled_css.trim().is_empty() {
        parts.push(compiled_css.trim());
    }
    if !user_css.trim().is_empty() {
        parts.push(user_css);
    }
    parts.join("\n")
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
    // Chromium drops background colours/images when printing unless told
    // otherwise, which looks like "CSS not applied" (shaded headers, table
    // fills, badges vanish). Force them on for every element.
    let color_rule = "*{-webkit-print-color-adjust:exact;print-color-adjust:exact;}";
    let gray_rule = if req.grayscale == Some(true) {
        "html{filter:grayscale(1) !important;}"
    } else {
        ""
    };
    let styles = format!("{cleaned_css}\n{page_rule}\n{fit_rule}\n{color_rule}\n{gray_rule}");

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
        let Some(open) = after.find('{') else {
            rest = "";
            break;
        };
        // Match braces by depth: `@page { @bottom-center { ... } }` nests, and
        // stopping at the first `}` left a stray `}` that made the browser
        // drop the next rule.
        let mut depth = 0usize;
        let mut end = None;
        for (i, ch) in after[open..].char_indices() {
            match ch {
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        end = Some(open + i + 1);
                        break;
                    }
                }
                _ => {}
            }
        }
        match end {
            Some(e) => rest = &after[e..],
            None => {
                rest = "";
                break;
            }
        }
    }
    out.push_str(rest);
    out
}

/// A page range is a comma-separated list of 1-based pages or spans:
/// "3", "1-5", "1,3,5-7". Empty/blank means all pages.
pub fn validate_page_range(raw: Option<&str>) -> AppResult<()> {
    let Some(text) = raw.map(str::trim).filter(|s| !s.is_empty()) else {
        return Ok(());
    };
    for part in text.split(',') {
        let part = part.trim();
        if part.is_empty() {
            return Err(AppError::Validation(format!(
                "invalid page range {text:?}: empty section"
            )));
        }
        if let Some((lo, hi)) = part.split_once('-') {
            let (Ok(lo), Ok(hi)) = (lo.trim().parse::<u32>(), hi.trim().parse::<u32>()) else {
                return Err(AppError::Validation(format!(
                    "invalid page range {text:?}: expected pages like \"1-3\""
                )));
            };
            if lo < 1 || hi < 1 || lo > hi {
                return Err(AppError::Validation(format!(
                    "invalid page range {text:?}: spans must satisfy 1 <= first <= last"
                )));
            }
        } else if part.parse::<u32>().ok().filter(|n| *n >= 1).is_none() {
            return Err(AppError::Validation(format!(
                "invalid page range {text:?}: expected pages like \"1-3\""
            )));
        }
    }
    Ok(())
}

/// HTTP method for fetching `data_url`: GET (default) or POST.
/// Anything else is rejected so the preview (which offers the same
/// choice) and the pipeline can never disagree on how data loads.
pub fn validate_http_method(raw: Option<&str>) -> AppResult<String> {
    match raw.map(str::trim).unwrap_or("") {
        "" | "GET" | "get" => Ok("GET".to_string()),
        "POST" | "post" => Ok("POST".to_string()),
        other => Err(AppError::Validation(format!(
            "invalid HTTP method {other:?}: expected GET or POST"
        ))),
    }
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
    let renderer = PdfRenderer::new(cache_dir.to_path_buf());
    run_print_with(cache_dir, db, queue, req, &renderer).await
}

/// The pipeline with the render step injected (see [`JobRenderer`]).
pub async fn run_print_with(
    cache_dir: &std::path::Path,
    db: &DbState,
    queue: &PrintQueue,
    req: PrintRequest,
    renderer: &dyn JobRenderer,
) -> AppResult<PrintResponse> {
    let start = Instant::now();

    if req.printer_name.trim().is_empty() {
        return Err(AppError::Validation("Select a printer first".into()));
    }
    validate_page_range(req.page_range.as_deref())?;
    // Fail fast on an unsupported fetch method, before the job row exists.
    validate_http_method(req.http_method.as_deref())?;
    let copies = req.copies.unwrap_or(1).max(1);

    // ── 1. Resolve content ───────────────────────────────────────────
    let content = resolve_content(db, &req)?;

    // P15: the row exists before anything that can take time, in `printing`
    // state with the real start time. Later stages only update it, so a
    // running job is visible in History and every failure path — fetch,
    // render, send — leaves a row that already carries its own id.
    let job_id = begin_job(
        db,
        &req,
        copies as i64,
        (content.w_mm, content.h_mm),
    )?;

    run_stages(
        cache_dir,
        db,
        queue,
        req,
        renderer,
        JobRun {
            job_id,
            started: start,
        },
        content,
    )
    .await
}

/// Run a row the worker already claimed (`queued` → `printing`) — the P3
/// path that reprint, retry, batch and `POST /v1/print/batch` all queue
/// into.
///
/// The request comes from the row, not from a caller: the printer it was
/// queued for, the pinned template version, the copies and settings, and
/// the payload in `data_json`. A row that also carries `rendered_html`
/// replays that HTML exactly as it printed the first time; a row with a
/// template re-renders it from the stored payload. Every failure ends the
/// row `failed` with the reason — a claimed row is never left `printing`.
pub async fn run_claimed_job(
    cache_dir: &std::path::Path,
    db: &DbState,
    queue: &PrintQueue,
    job_id: i64,
    renderer: &dyn JobRenderer,
) -> AppResult<PrintResponse> {
    let start = Instant::now();

    let (req, replay) = match load_job_request(db, job_id) {
        Ok(v) => v,
        Err(e) => {
            close_job(db, job_id, "failed", Some(e.to_string()), "", &[], 0)?;
            return Ok(PrintResponse {
                success: false,
                job_id: job_id.to_string(),
                duration_ms: 0,
                error: Some(e.to_string()),
                timings: None,
            });
        }
    };

    let content = match replay {
        Some(rendered) => ResolvedContent {
            html: rendered,
            css: String::new(),
            w_mm: req.page_width_mm.unwrap_or(100.0),
            h_mm: req.page_height_mm.unwrap_or(150.0),
            render_template: false,
        },
        None => match resolve_content(db, &req) {
            Ok(c) => c,
            Err(e) => {
                let msg = e.to_string();
                close_job(
                    db,
                    job_id,
                    "failed",
                    Some(msg.clone()),
                    "",
                    &secrets_of(&req),
                    0,
                )?;
                return Ok(PrintResponse {
                    success: false,
                    job_id: job_id.to_string(),
                    duration_ms: 0,
                    error: Some(msg),
                    timings: None,
                });
            }
        },
    };

    run_stages(
        cache_dir,
        db,
        queue,
        req,
        renderer,
        JobRun {
            job_id,
            started: start,
        },
        content,
    )
    .await
}

/// The document a job prints: markup, stylesheet, page size — plus which
/// template version produced it and whether the engine still has to run.
/// `render_template` is false for a replayed job (P3): its HTML already
/// went through the engine when it first printed, and running it again
/// could mangle literal braces that came from the data.
struct ResolvedContent {
    html: String,
    css: String,
    w_mm: f64,
    h_mm: f64,
    render_template: bool,
}

/// One job's run: the row it writes (P15) and when it started.
struct JobRun {
    job_id: i64,
    started: Instant,
}

/// Step 1: the document to print — the pinned template version's HTML and
/// CSS, or the request's own HTML — plus the page size it prints at.
fn resolve_content(db: &DbState, req: &PrintRequest) -> AppResult<ResolvedContent> {
    let (html, css, mut w_mm, mut h_mm) = match req.template_id {
        Some(tid) => {
            let guard = db
                .lock()
                .map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
            let conn = guard.connection();
            let (h, c, compiled, tw, th) = resolve_template(conn, tid)?;
            (h, build_template_css(&c, &compiled), tw, th)
        }
        None => (
            req.html.clone(),
            String::new(),
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

    Ok(ResolvedContent {
        html,
        css,
        w_mm,
        h_mm,
        render_template: true,
    })
}

/// Whole milliseconds since `since`, for the per-stage timing log.
fn ms(since: Instant) -> u64 {
    since.elapsed().as_millis() as u64
}

/// Store a job's stage breakdown on its history row (`timings_json`).
///
/// Best-effort: the print already happened, so a failed write here is logged
/// and never turns a finished job into an error. Not guarded on status — a
/// job cancelled mid-print keeps its timings too.
fn save_timings(db: &DbState, job_id: i64, timings: &StageTimings) {
    let json = match serde_json::to_string(timings) {
        Ok(j) => j,
        Err(e) => {
            tracing::warn!(job_id, error = %e, "could not encode job timings");
            return;
        }
    };
    let Ok(guard) = db.lock() else {
        tracing::warn!(job_id, "DB lock poisoned; job timings not saved");
        return;
    };
    if let Err(e) = guard.connection().execute(
        "UPDATE print_jobs SET timings_json = ?2 WHERE id = ?1",
        rusqlite::params![job_id, json],
    ) {
        tracing::warn!(job_id, error = %e, "could not save job timings");
    }
}

/// Everything after the job row exists: fetch, template render, layout,
/// PDF, the per-printer permit, the send and the history write.
async fn run_stages(
    cache_dir: &std::path::Path,
    db: &DbState,
    queue: &PrintQueue,
    req: PrintRequest,
    renderer: &dyn JobRenderer,
    run: JobRun,
    content: ResolvedContent,
) -> AppResult<PrintResponse> {
    let JobRun {
        job_id,
        started: start,
    } = run;
    let ResolvedContent {
        mut html,
        css,
        w_mm,
        h_mm,
        render_template,
        ..
    } = content;
    let copies = req.copies.unwrap_or(1).max(1);

    // Where the time goes, filled in as each stage finishes and saved on the
    // job row on every exit path, so History can show it.
    let mut timings = StageTimings::default();

    // Fetch live data when a URL is supplied and test mode is off.
    let t_fetch = Instant::now();
    let mut fetched: Option<serde_json::Value> = req.data.clone();
    if !req.test.unwrap_or(false) {
        if let Some(url) = &req.data_url {
            if !url.trim().is_empty() {
                let method = validate_http_method(req.http_method.as_deref())?;
                let opts = crate::data::fetcher::FetchOptions {
                    url: url.clone(),
                    method,
                    headers: None,
                    timeout_secs: 15,
                    max_size_bytes: 5 * 1024 * 1024,
                    json_path: None,
                };
                match crate::data::fetcher::DataFetcher::new().fetch(&opts).await {
                    Ok(v) => fetched = Some(v),
                    Err(e) => {
                        // Nothing was rendered yet, so there is nothing to
                        // replay: store empty HTML (P3) and fail the row.
                        finish_job(
                            db,
                            job_id,
                            "failed",
                            Some(e.to_string()),
                            "",
                            &req,
                            start.elapsed().as_millis() as i64,
                        )?;
                        timings.fetch_ms = ms(t_fetch);
                        timings.total_ms = ms(start);
                        save_timings(db, job_id, &timings);
                        return Err(AppError::Internal(format!("Data fetch failed: {}", e)));
                    }
                }
            }
        }
    }

    let fetch_ms = ms(t_fetch);
    timings.fetch_ms = fetch_ms;

    // ── 2. Template render ──────────────────────────────────────────
    let t_template = Instant::now();
    // P14: always run the engine — with the job's data, or an empty context
    // when it has none, exactly like the preview (handlebars.js). It used to
    // be skipped without data and to swallow errors with `unwrap_or(html)`,
    // printing the raw template source instead of failing. A replayed job is
    // the exception: its HTML already went through the engine once.
    if render_template {
        let context = fetched.unwrap_or_else(|| serde_json::json!({}));
        let engine = TemplateEngine::new();
        html = match engine.render(&html, &context) {
            Ok(rendered) => rendered,
            Err(e) => {
                let msg = format!("Template render failed: {e}");
                // No rendered content to replay (P3): store none.
                finish_job(
                    db,
                    job_id,
                    "failed",
                    Some(msg.clone()),
                    "",
                    &req,
                    start.elapsed().as_millis() as i64,
                )?;
                timings.template_ms = ms(t_template);
                timings.total_ms = ms(start);
                save_timings(db, job_id, &timings);
                return Ok(PrintResponse {
                    success: false,
                    job_id: job_id.to_string(),
                    duration_ms: start.elapsed().as_millis(),
                    error: Some(msg),
                    timings: Some(timings),
                });
            }
        };
    }

    let template_ms = ms(t_template);
    timings.template_ms = template_ms;

    // ── 3. Layout ───────────────────────────────────────────────────
    let t_layout = Instant::now();
    let final_html = apply_layout(&html, &css, w_mm, h_mm, &req);
    let layout_ms = ms(t_layout);
    timings.layout_ms = layout_ms;

    // ── 4. Render ────────────────────────────────────────────────────
    // What the printer takes is a property of its stored row: a PDF printer
    // gets document bytes, a command-language printer (escpos/tspl/zpl/
    // cpcl/raster) gets a raster rasterized at its head's own resolution
    // and encoded for its dialect (P4). Look the row up *before* rendering:
    // the language decides which renderer call is even made. A printer that
    // is not in the DB still prints — language falls back to Pdf, exactly
    // the pre-dispatch behaviour.
    std::fs::create_dir_all(cache_dir)
        .map_err(|e| AppError::Internal(format!("Cannot create {}: {e}", cache_dir.display())))?;
    let printer = lookup_printer(db, &req.printer_name);
    let language = printer
        .as_ref()
        .map_or(crate::transport::PrinterLanguage::Pdf, |p| {
            crate::transport::parse_printer_language(&p.language)
        });
    // `printers.dpi` defaults to 203 (the common thermal head); the clamp
    // only bites on a hand-edited row.
    let dpi = printer
        .as_ref()
        .and_then(|p| p.dpi)
        .unwrap_or(203)
        .clamp(1, 1200) as u32;

    let t_render = Instant::now();
    let rendered: anyhow::Result<(Vec<u8>, &'static str)> = match language {
        crate::transport::PrinterLanguage::Pdf => renderer
            .render(
                &final_html,
                w_mm,
                h_mm,
                req.orientation.as_deref().unwrap_or("portrait"),
            )
            .await
            .map(|b| (b, "application/pdf")),
        ref lang => {
            // 1 CSS px = 1 printer dot: ask for exactly the label's dots so
            // nothing is resampled on the way to the head.
            let (w_px, h_px) = (
                crate::render::raster::dots_for_mm(w_mm, dpi),
                crate::render::raster::dots_for_mm(h_mm, dpi),
            );
            renderer
                .rasterize(&final_html, w_px, h_px)
                .await
                .and_then(|raster| {
                    crate::transport::encode_for_language(lang, &raster, w_mm, h_mm, dpi)
                        .map_err(|e| anyhow::anyhow!(e))
                })
        }
    };
    let render_ms = ms(t_render);
    timings.render_ms = render_ms;
    let (payload, mime_type) = match rendered {
        Ok(v) => v,
        Err(e) => {
            let msg = e.to_string();
            tracing::warn!(
                job_id,
                printer = %req.printer_name,
                fetch_ms,
                template_ms,
                layout_ms,
                render_ms,
                total_ms = ms(start),
                "print render failed"
            );
            finish_job(
                db,
                job_id,
                "failed",
                Some(msg.clone()),
                &html,
                &req,
                start.elapsed().as_millis() as i64,
            )?;
            timings.total_ms = ms(start);
            save_timings(db, job_id, &timings);
            return Ok(PrintResponse {
                success: false,
                job_id: job_id.to_string(),
                duration_ms: start.elapsed().as_millis(),
                error: Some(msg),
                timings: Some(timings),
            });
        }
    };

    // ── 5. Send ─────────────────────────────────────────────────────
    // The row resolved above also picks the transport and the queue key.
    let printer_type = crate::transport::parse_printer_type(
        printer.as_ref().map_or("", |p| p.printer_type.as_str()),
    );
    let address = printer.as_ref().map_or("", |p| p.address.as_str());
    tracing::info!(
        printer = %req.printer_name,
        ?printer_type,
        ?language,
        %address,
        dpi,
        paper_width_mm = ?printer.as_ref().and_then(|p| p.paper_width_mm),
        found = printer.is_some(),
        "sending print job"
    );

    // Hold this printer's permit across the whole send. Two jobs for the
    // same physical printer must never overlap, or their bytes interleave
    // and the label comes out garbled. Jobs for *different* printers are
    // unaffected — the semaphore is keyed per printer id.
    let t_send = Instant::now();
    let result = queue
        .with_permit(&req.printer_name, async {
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
                        data: payload.clone(),
                        mime_type: mime_type.to_string(),
                        copies: 1,
                        language: language.clone(),
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
    // Includes any wait for this printer's turn, not just the transport.
    let send_ms = ms(t_send);
    timings.send_ms = send_ms;

    let duration = start.elapsed().as_millis();
    let (status, err) = match result {
        Ok(()) => ("success", None),
        Err(e) => {
            tracing::error!(printer = %req.printer_name, error = %e, "print send failed");
            ("failed", Some(e))
        }
    };

    // ── 6. History ──────────────────────────────────────────────────
    let t_history = Instant::now();
    finish_job(
        db,
        job_id,
        status,
        err.clone(),
        &html,
        &req,
        duration as i64,
    )?;
    let history_ms = ms(t_history);
    timings.history_ms = history_ms;

    // One line per job with where the time went, so a slow print can be
    // read off the log instead of guessed at. `render_ms` is the Edge render
    // (the `rendered PDF with Edge` line next to it splits it further);
    // `send_ms` is the hand-off to the printer, queue wait included.
    tracing::info!(
        job_id,
        printer = %req.printer_name,
        status,
        copies,
        fetch_ms,
        template_ms,
        layout_ms,
        render_ms,
        send_ms,
        history_ms,
        total_ms = ms(start),
        "print job timing"
    );

    // The history write cannot time itself, so the breakdown goes onto the
    // row in a second, best-effort write once every stage is known.
    timings.total_ms = ms(start);
    save_timings(db, job_id, &timings);

    Ok(PrintResponse {
        success: status == "success",
        job_id: job_id.to_string(),
        duration_ms: duration,
        error: err,
        timings: Some(timings),
    })
}

/// The printer columns the print pipeline needs after render (P4).
///
/// `lookup_printer` used to return `(type, address)`; dispatch needs the
/// language and the head resolution too (the send log also wants the media
/// width), and every stage must consult the *same* row.
#[derive(Debug, Clone)]
pub struct StoredPrinter {
    pub printer_type: String,
    pub address: String,
    pub language: String,
    pub paper_width_mm: Option<i64>,
    pub dpi: Option<i64>,
}

/// Look up a printer's stored row by name.
///
/// Returns `None` when the printer is not in the DB, which is legal: the
/// caller falls back to the platform default — type `system`, language
/// `pdf` — exactly as before dispatch existed.
pub fn lookup_printer(db: &DbState, name: &str) -> Option<StoredPrinter> {
    let guard = db.lock().ok()?;
    let conn = guard.connection();
    conn.query_row(
        "SELECT type, COALESCE(address, ''), COALESCE(language, 'pdf'), \
                paper_width_mm, dpi \
         FROM printers WHERE name = ?1 COLLATE NOCASE",
        [name],
        |r| {
            Ok(StoredPrinter {
                printer_type: r.get(0)?,
                address: r.get(1)?,
                language: r.get(2)?,
                paper_width_mm: r.get(3)?,
                dpi: r.get(4)?,
            })
        },
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

/// Replace every occurrence of a job's secret values with `***`.
fn redact_with_secrets(html: &str, secrets: &[String]) -> String {
    if secrets.is_empty() {
        return html.to_string();
    }
    let mut redacted = html.to_string();
    for s in secrets {
        // Avoid replacing short or common substrings; secrets are at least 4 chars.
        redacted = redacted.replace(s, "***");
    }
    redacted
}

/// Insert the job row as `printing` with the real start time (P15).
///
/// Called once, after the request resolves and before any stage that can take
/// time or fail, so a running print is visible in History and the `job_id`
/// reported by a failure is the row's own id. The row used to be written
/// only *after* printing ended, with `started_at` equal to `finished_at`
/// (both stamped at the same moment) and a running job invisible.
///
/// Also the atomic reservation of the request's idempotency key (P12): the
/// unique index on `idempotency_key` makes this INSERT the point where the
/// key is taken — before render and before send — so two simultaneous
/// requests with one key insert once and print once.
fn begin_job(db: &DbState, req: &PrintRequest, copies: i64, page_mm: (f64, f64)) -> AppResult<i64> {
    let guard = db
        .lock()
        .map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
    let conn = guard.connection();

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
        "page_range": req.page_range,
        "grayscale": req.grayscale.unwrap_or(false),
        "http_method": req.http_method,
        "margins": {
            "top": req.margin_top, "right": req.margin_right,
            "bottom": req.margin_bottom, "left": req.margin_left,
        },
        "page": {"width_mm": page_mm.0, "height_mm": page_mm.1},
    });

    // The job's input payload, kept so a queued row can run again — retry
    // and reprint are rows the worker replays (P3). This is run-input, not
    // a history view: it is never selected into `PrintJob` (IPC/REST), and
    // the displayed artifact, `rendered_html`, stays secret-redacted below.
    let data_json = req
        .data
        .as_ref()
        .and_then(|d| serde_json::to_string(d).ok());

    match conn.execute(
        "INSERT INTO print_jobs
           (template_id, printer_id, source, source_url,
            status, copies, settings_json, rendered_html, is_test,
            started_at, idempotency_key, data_json)
         VALUES (?1, ?2, ?3, ?4, 'printing', ?5, ?6, '', ?7,
                 datetime('now'), ?8, ?9)",
        rusqlite::params![
            req.template_id,
            printer_id,
            req.source.clone().unwrap_or_else(|| "ui".into()),
            req.data_url,
            copies,
            settings.to_string(),
            i64::from(req.test.unwrap_or(false)),
            req.idempotency_key,
            data_json,
        ],
    ) {
        Ok(_) => Ok(conn.last_insert_rowid()),
        // The unique index on `idempotency_key` makes this insert the atomic
        // reservation of the key (P12): two simultaneous requests with one
        // key insert once, so they print once — and both record the key
        // before any send. Only the key can collide (the id is
        // autoincrement), and the loser gets the winner's job id to report
        // as the duplicate response.
        Err(rusqlite::Error::SqliteFailure(e, _))
            if e.extended_code == rusqlite::ffi::SQLITE_CONSTRAINT_UNIQUE
                || e.extended_code == rusqlite::ffi::SQLITE_CONSTRAINT_PRIMARYKEY =>
        {
            let existing: Option<i64> = req.idempotency_key.as_ref().and_then(|key| {
                conn.query_row(
                    "SELECT id FROM print_jobs WHERE idempotency_key = ?1",
                    [key],
                    |r| r.get(0),
                )
                .ok()
            });
            match existing {
                Some(id) => Err(AppError::DuplicateJob(id)),
                None => Err(AppError::Database(
                    "job insert hit an unexpected unique constraint".into(),
                )),
            }
        }
        Err(e) => Err(e.into()),
    }
}

/// Close a job opened by [`begin_job`]: terminal status, error, the
/// (secret-redacted) HTML, the finish time and the real duration.
fn finish_job(
    db: &DbState,
    job_id: i64,
    status: &str,
    error: Option<String>,
    rendered_html: &str,
    req: &PrintRequest,
    duration_ms: i64,
) -> AppResult<()> {
    close_job(
        db,
        job_id,
        status,
        error,
        rendered_html,
        &secrets_of(req),
        duration_ms,
    )
}

/// The secret values a job's `data` carries, for redaction from history.
fn secrets_of(req: &PrintRequest) -> Vec<String> {
    let mut secrets = Vec::new();
    if let Some(data) = &req.data {
        collect_secrets(data, &mut secrets);
    }
    secrets
}

/// Close a claimed job row: terminal status, error, the (secret-redacted)
/// HTML, the finish time and the real duration. Shared by the direct
/// pipeline ([`finish_job`]) and the worker's claimed-job path.
///
/// The `status = 'printing'` guard keeps a row that was already terminal —
/// cancelled out from under a running print — from being resurrected; such a
/// row keeps its state.
fn close_job(
    db: &DbState,
    job_id: i64,
    status: &str,
    error: Option<String>,
    rendered_html: &str,
    secrets: &[String],
    duration_ms: i64,
) -> AppResult<()> {
    let guard = db
        .lock()
        .map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
    let conn = guard.connection();

    // Redact secrets from history: tokens/passwords that were in `data`
    // must not be persisted verbatim (PLANNING.md keyring/redaction).
    let redacted_html = redact_with_secrets(rendered_html, secrets);

    let transitioned = conn.execute(
        "UPDATE print_jobs
         SET status = ?2, error = ?3, rendered_html = ?4,
             finished_at = datetime('now'), duration_ms = ?5
         WHERE id = ?1 AND status = 'printing'",
        rusqlite::params![job_id, status, error, redacted_html, duration_ms],
    )?;

    // Count only real transitions: a finish racing a cancel lands on an
    // already-terminal row and must not inflate the totals.
    if transitioned == 1 {
        crate::metrics::count_finished(status);
    }

    Ok(())
}

/// Rebuild the print request a queued row describes (P3).
///
/// The row is the job: the printer it was queued for, the pinned template
/// version, the copies and settings, and the input payload batches store in
/// `data_json`. A row that also carries `rendered_html` replays that HTML
/// as-is — the content it printed the first time — and needs neither
/// template nor data; its `data_url` is dropped so a replay cannot fail on
/// a fetch it does not need. A row with neither fails here, and the worker
/// ends it `failed` with this error.
/// The columns [`load_job_request`] reads to rebuild a queued job.
struct JobRow {
    printer_id: Option<i64>,
    printer_name: Option<String>,
    template_id: Option<i64>,
    source: String,
    source_url: Option<String>,
    copies: i64,
    settings_json: Option<String>,
    rendered_html: Option<String>,
    is_test: i64,
    data_json: Option<String>,
}

fn load_job_request(db: &DbState, job_id: i64) -> AppResult<(PrintRequest, Option<String>)> {
    let guard = db
        .lock()
        .map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
    let conn = guard.connection();

    let JobRow {
        printer_id,
        printer_name,
        template_id,
        source,
        source_url,
        copies,
        settings_json,
        rendered_html,
        is_test,
        data_json,
    } = conn.query_row(
        "SELECT j.printer_id, p.name, j.template_id, j.source,
                j.source_url, j.copies, j.settings_json, j.rendered_html, j.is_test,
                j.data_json
         FROM print_jobs j LEFT JOIN printers p ON p.id = j.printer_id
         WHERE j.id = ?1",
        [job_id],
        |r| {
            Ok(JobRow {
                printer_id: r.get(0)?,
                printer_name: r.get(1)?,
                template_id: r.get(2)?,
                source: r.get(3)?,
                source_url: r.get(4)?,
                copies: r.get(5)?,
                settings_json: r.get(6)?,
                rendered_html: r.get(7)?,
                is_test: r.get(8)?,
                data_json: r.get(9)?,
            })
        },
    )?;

    let printer_name = printer_name.ok_or_else(|| {
        AppError::Validation(format!(
            "the printer this job was queued for (printer id {printer_id:?}) no longer exists"
        ))
    })?;

    let replay = rendered_html.filter(|h| !h.trim().is_empty());

    let data: Option<serde_json::Value> = match data_json {
        Some(s) if !s.trim().is_empty() => Some(serde_json::from_str(&s).map_err(|e| {
            AppError::Internal(format!("stored data for job {job_id} is unreadable: {e}"))
        })?),
        _ => None,
    };

    if replay.is_none() && template_id.is_none() {
        return Err(AppError::Validation(
            "this job has nothing to print: no stored HTML and no template".into(),
        ));
    }

    let settings: serde_json::Value = settings_json
        .as_deref()
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or(serde_json::json!({}));
    let margins = settings.get("margins");
    let page = settings.get("page");

    let req = PrintRequest {
        printer_name,
        // Content comes from the row's replay or its template, never here.
        html: String::new(),
        page_width_mm: page.and_then(|p| p.get("width_mm").and_then(|v| v.as_f64())),
        page_height_mm: page.and_then(|p| p.get("height_mm").and_then(|v| v.as_f64())),
        orientation: settings
            .get("orientation")
            .and_then(|v| v.as_str())
            .map(String::from),
        copies: Some(copies.max(1) as u32),
        margin_top: margins.and_then(|m| m.get("top").and_then(|v| v.as_f64())),
        margin_right: margins.and_then(|m| m.get("right").and_then(|v| v.as_f64())),
        margin_bottom: margins.and_then(|m| m.get("bottom").and_then(|v| v.as_f64())),
        margin_left: margins.and_then(|m| m.get("left").and_then(|v| v.as_f64())),
        fit_mode: settings
            .get("fit")
            .and_then(|v| v.as_str())
            .map(String::from),
        page_range: settings
            .get("page_range")
            .and_then(|v| v.as_str())
            .map(String::from),
        grayscale: settings.get("grayscale").and_then(|v| v.as_bool()),
        http_method: settings
            .get("http_method")
            .and_then(|v| v.as_str())
            .map(String::from),
        template_id,
        data,
        // A replay prints the HTML on the row; it needs no live data.
        data_url: if replay.is_some() { None } else { source_url },
        test: Some(is_test != 0),
        source: Some(source),
        idempotency_key: None,
    };
    Ok((req, replay))
}

/// Enumerate system printers
#[tauri::command]
pub fn enumerate_system_printers() -> AppResult<Vec<crate::transport::PrinterInfo>> {
    #[cfg(windows)]
    {
        Ok(WindowsSpooler::enumerate_printers())
    }
    #[cfg(target_os = "linux")]
    {
        Ok(crate::transport::cups::list_blocking())
    }
    #[cfg(not(any(windows, target_os = "linux")))]
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
        page_range: None,
        grayscale: None,
        template_id: None,
        data: None,
        data_url: None,
        http_method: None,
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
            page_range: None,
            grayscale: None,
            template_id: None,
            data: None,
            data_url: None,
            http_method: None,
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
    fn layout_injects_grayscale_only_when_enabled() {
        let out = apply_layout("<head></head>", "", 100.0, 200.0, &req());
        assert!(!out.contains("grayscale(1)"), "{}", out);
        let mut r = req();
        r.grayscale = Some(true);
        let out = apply_layout("<head></head>", "", 100.0, 200.0, &r);
        assert!(out.contains("grayscale(1)"), "{}", out);
    }

    #[test]
    fn page_range_accepts_pages_and_spans() {
        for valid in ["", "  ", "3", "1-5", "1,3,5-7", " 2 , 4 - 6 "] {
            assert!(
                validate_page_range(Some(valid)).is_ok(),
                "expected ok for {valid:?}"
            );
        }
        assert!(validate_page_range(None).is_ok());
    }

    #[test]
    fn page_range_rejects_garbage() {
        for invalid in ["0", "1-0", "5-2", "a", "1-", "-3", "1,,2", "1.5", ","] {
            assert!(
                validate_page_range(Some(invalid)).is_err(),
                "expected err for {invalid:?}"
            );
        }
    }

    #[test]
    fn http_method_defaults_to_get_and_rejects_the_rest() {
        assert_eq!(validate_http_method(None).unwrap(), "GET");
        assert_eq!(validate_http_method(Some("")).unwrap(), "GET");
        assert_eq!(validate_http_method(Some("GET")).unwrap(), "GET");
        assert_eq!(validate_http_method(Some("post")).unwrap(), "POST");
        for invalid in ["PUT", "DELETE", "getx", "javascript:alert(1)"] {
            assert!(
                validate_http_method(Some(invalid)).is_err(),
                "expected err for {invalid:?}"
            );
        }
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
    fn strip_at_page_handles_nested_margin_boxes() {
        let css = "@page { margin: 4mm; @bottom-center { content: counter(page); } }\n* { box-sizing: border-box; }";
        let cleaned = strip_at_page(css);
        assert!(!cleaned.contains("@page"), "{}", cleaned);
        assert!(!cleaned.contains("counter(page)"), "{}", cleaned);
        assert!(
            cleaned.contains("* { box-sizing: border-box; }"),
            "{}",
            cleaned
        );
        assert_eq!(
            cleaned.matches('}').count(),
            cleaned.matches('{').count(),
            "{}",
            cleaned
        );
    }

    #[test]
    fn template_css_is_base_compiled_then_user_css() {
        let css = build_template_css(".brand{color:#f00}", ".w-\\[37mm\\]{width:37mm}");
        assert!(css.starts_with(TEMPLATE_BASE_CSS.trim()));
        let compiled = css.find("37mm").expect("compiled css missing");
        let user = css.find(".brand{color:#f00}").expect("user css missing");
        assert!(compiled < user, "user css must come last so it wins");
        assert!(css.trim_end().ends_with(".brand{color:#f00}"));
    }

    #[test]
    fn blank_compiled_css_leaves_base_and_user_css_only() {
        let css = build_template_css(".brand{color:#f00}", "  \n ");
        assert_eq!(
            css,
            format!("{}\n.brand{{color:#f00}}", TEMPLATE_BASE_CSS.trim())
        );
        assert_eq!(build_template_css("", ""), TEMPLATE_BASE_CSS.trim());
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
        let out = redact_with_secrets(html, &secrets_of(&r));
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
        let out = redact_with_secrets(html, &secrets_of(&r));
        assert!(!out.contains("hunter2"), "{}", out);
        assert!(!out.contains("key-999"), "{}", out);
        assert!(out.contains("a@b.com"), "{}", out);
    }

    #[test]
    fn redact_is_case_insensitive_and_ignores_non_sensitive() {
        let mut r = req();
        r.data = Some(serde_json::json!({"Token": "ABC123", "order_id": "XYZ"}));
        let html = "ABC123 XYZ";
        let out = redact_with_secrets(html, &secrets_of(&r));
        assert!(!out.contains("ABC123"), "{}", out);
        assert!(out.contains("XYZ"), "{}", out);
    }

    #[test]
    fn redact_does_nothing_without_secrets() {
        let r = req();
        let html = "<p>hello</p>";
        assert_eq!(redact_with_secrets(html, &secrets_of(&r)), html);
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
