use super::barcode;
use anyhow::Result;
use handlebars::Handlebars;

pub struct TemplateEngine {
    hb: Handlebars<'static>,
}

impl TemplateEngine {
    pub fn new() -> Self {
        let mut hb = Handlebars::new();
        Self::register_helpers(&mut hb);
        Self { hb }
    }

    fn register_helpers(hb: &mut Handlebars<'static>) {
        hb.register_helper("currency", Box::new(currency_helper));
        hb.register_helper("date", Box::new(date_helper));
        hb.register_helper("upper", Box::new(upper_helper));
        hb.register_helper("lower", Box::new(lower_helper));
        hb.register_helper("padLeft", Box::new(pad_left_helper));
        hb.register_helper("number", Box::new(number_helper));
        hb.register_helper("barcode", Box::new(barcode_helper));
        hb.register_helper("qrcode", Box::new(qrcode_helper));
    }

    pub fn render(&self, template: &str, data: &serde_json::Value) -> Result<String> {
        let out = self
            .hb
            .render_template(template, data)
            .map_err(|e| anyhow::anyhow!(e))?;
        Ok(sanitize_html(&out))
    }
}

impl Default for TemplateEngine {
    fn default() -> Self {
        Self::new()
    }
}

/// Strip <script> tags and event-handler attributes (V2.md §8.3).
/// Used on every render so a compromised server row cannot execute.
pub fn sanitize_html(input: &str) -> String {
    let mut out = input.to_string();

    // Strip <script ...>...</script> case-insensitive
    loop {
        let lower = out.to_lowercase();
        if let Some(start) = lower.find("<script") {
            if let Some(end) = lower[start..].find("</script>") {
                let end_idx = start + end + "</script>".len();
                out.replace_range(start..end_idx, "");
                continue;
            } else if let Some(tag_end) = lower[start..].find('>') {
                let end_idx = start + tag_end + 1;
                out.replace_range(start..end_idx, "");
                continue;
            } else {
                out.replace_range(start.., "");
                break;
            }
        }
        break;
    }
    // Self-closing script tags
    loop {
        let lower = out.to_lowercase();
        if let Some(start) = lower.find("<script") {
            if let Some(end) = lower[start..].find('>') {
                out.replace_range(start..start + end + 1, "");
                continue;
            }
            break;
        }
        break;
    }

    // Strip on* handler attributes:  onxxx="..."  onxxx='...'  onxxx=unquoted
    // UTF-8 safe: iterate over chars, not bytes.
    let chars: Vec<char> = out.chars().collect();
    let mut result = String::with_capacity(out.len());
    let mut i = 0;
    while i < chars.len() {
        if chars[i].is_whitespace() {
            let mut j = i + 1;
            while j < chars.len() && chars[j].is_whitespace() {
                j += 1;
            }
            if j + 2 < chars.len()
                && (chars[j] == 'o' || chars[j] == 'O')
                && (chars[j + 1] == 'n' || chars[j + 1] == 'N')
            {
                let mut k = j + 2;
                while k < chars.len() && chars[k].is_alphanumeric() {
                    k += 1;
                }
                let mut l = k;
                while l < chars.len() && chars[l].is_whitespace() {
                    l += 1;
                }
                if l < chars.len() && chars[l] == '=' {
                    l += 1;
                    while l < chars.len() && chars[l].is_whitespace() {
                        l += 1;
                    }
                    if l < chars.len() {
                        if chars[l] == '"' || chars[l] == '\'' {
                            let quote = chars[l];
                            l += 1;
                            while l < chars.len() && chars[l] != quote {
                                l += 1;
                            }
                            if l < chars.len() {
                                l += 1;
                            }
                        } else {
                            while l < chars.len() && !chars[l].is_whitespace() && chars[l] != '>' {
                                l += 1;
                            }
                        }
                    }
                    i = l;
                    continue;
                }
            }
        }
        result.push(chars[i]);
        i += 1;
    }
    out = result;

    // Strip javascript: URLs
    let mut cleaned = out;
    for pat in ["javascript:", "JAVASCRIPT:", "Javascript:"] {
        cleaned = cleaned.replace(pat, "");
    }
    // Also handle href/src with javascript: inside quotes — already stripped above generically,
    // but this catches remaining.
    cleaned
}

/// Detect remote references that should be rejected on publish (V2.md §8.3).
/// Returns Some(messages) if found, None if clean.
pub fn find_remote_refs(html: &str, css: &str) -> Option<Vec<String>> {
    let mut issues = Vec::new();
    let lower_html = html.to_lowercase();
    let lower_css = css.to_lowercase();

    for needle in [
        "src=\"http",
        "src='http",
        "href=\"http",
        "href='http",
        "src=\"//",
        "href=\"//",
    ] {
        if lower_html.contains(needle) {
            issues.push(format!(
                "Remote reference in HTML: {} — use data: URIs",
                &needle[..20]
            ));
        }
    }
    for needle in [
        "url(\"http",
        "url('http",
        "url(http",
        "url(\"//",
        "url('//",
        "url(//",
    ] {
        if lower_html.contains(needle) || lower_css.contains(needle) {
            issues.push(format!(
                "Remote url() in CSS/HTML: {} — use data: URIs",
                needle
            ));
        }
    }
    if lower_html.contains("@import")
        && (lower_html.contains("http://")
            || lower_html.contains("https://")
            || lower_html.contains("//"))
    {
        issues.push("@import with remote URL — use data: URIs".to_string());
    }

    if issues.is_empty() {
        None
    } else {
        Some(issues)
    }
}

fn currency_helper(
    h: &handlebars::Helper,
    _: &handlebars::Handlebars,
    _: &handlebars::Context,
    _: &mut handlebars::RenderContext,
    out: &mut dyn handlebars::Output,
) -> handlebars::HelperResult {
    let value = h.param(0).and_then(|v| v.value().as_f64()).unwrap_or(0.0);
    let symbol = h.param(1).and_then(|v| v.value().as_str()).unwrap_or("$");
    out.write(&format!("{}{:.2}", symbol, value))?;
    Ok(())
}

fn date_helper(
    h: &handlebars::Helper,
    _: &handlebars::Handlebars,
    _: &handlebars::Context,
    _: &mut handlebars::RenderContext,
    out: &mut dyn handlebars::Output,
) -> handlebars::HelperResult {
    let value = h.param(0).and_then(|v| v.value().as_str()).unwrap_or("");
    if value.is_empty() {
        return Ok(());
    }

    // Parse ISO-8601 / RFC-3339 first, then fall back to the raw string so a
    // non-date value is never silently mangled. (The previous version just
    // echoed `"<value> (<format>)"`, which is not a date formatter at all.)
    let parsed = chrono::DateTime::parse_from_rfc3339(value)
        .map(|dt| dt.with_timezone(&chrono::Local))
        .ok();

    let Some(dt) = parsed else {
        out.write(value)?;
        return Ok(());
    };

    let format = h
        .param(1)
        .and_then(|v| v.value().as_str())
        .unwrap_or("%Y-%m-%d");
    let rendered = match format {
        "short" => dt.format("%d %b %Y").to_string(),
        "long" => dt.format("%d %B %Y, %H:%M").to_string(),
        "time" => dt.format("%H:%M").to_string(),
        "datetime" => dt.format("%Y-%m-%d %H:%M").to_string(),
        // Anything else is treated as a strftime pattern.
        other => dt.format(other).to_string(),
    };

    out.write(&rendered)?;
    Ok(())
}

fn upper_helper(
    h: &handlebars::Helper,
    _: &handlebars::Handlebars,
    _: &handlebars::Context,
    _: &mut handlebars::RenderContext,
    out: &mut dyn handlebars::Output,
) -> handlebars::HelperResult {
    let value = h.param(0).and_then(|v| v.value().as_str()).unwrap_or("");
    out.write(&value.to_uppercase())?;
    Ok(())
}

fn lower_helper(
    h: &handlebars::Helper,
    _: &handlebars::Handlebars,
    _: &handlebars::Context,
    _: &mut handlebars::RenderContext,
    out: &mut dyn handlebars::Output,
) -> handlebars::HelperResult {
    let value = h.param(0).and_then(|v| v.value().as_str()).unwrap_or("");
    out.write(&value.to_lowercase())?;
    Ok(())
}

fn pad_left_helper(
    h: &handlebars::Helper,
    _: &handlebars::Handlebars,
    _: &handlebars::Context,
    _: &mut handlebars::RenderContext,
    out: &mut dyn handlebars::Output,
) -> handlebars::HelperResult {
    let value = h.param(0).and_then(|v| v.value().as_str()).unwrap_or("");
    let width = h.param(1).and_then(|v| v.value().as_u64()).unwrap_or(0) as usize;

    // The custom pad character was read but never used: `{:>width$}` always
    // pads with spaces. Honour it now.
    let pad_char = h
        .param(2)
        .and_then(|v| v.value().as_str())
        .and_then(|s| s.chars().next())
        .unwrap_or(' ');

    let current = value.chars().count();
    if current >= width {
        out.write(value)?;
        return Ok(());
    }

    let padding: String = std::iter::repeat_n(pad_char, width - current).collect();
    out.write(&padding)?;
    out.write(value)?;
    Ok(())
}

fn number_helper(
    h: &handlebars::Helper,
    _: &handlebars::Handlebars,
    _: &handlebars::Context,
    _: &mut handlebars::RenderContext,
    out: &mut dyn handlebars::Output,
) -> handlebars::HelperResult {
    let value = h.param(0).and_then(|v| v.value().as_f64()).unwrap_or(0.0);
    let decimals = h.param(1).and_then(|v| v.value().as_u64()).unwrap_or(0) as usize;
    out.write(&format!("{:.*}", decimals, value))?;
    Ok(())
}

/// A helper argument as text: strings as-is, numbers and booleans formatted,
/// anything else (missing, null, objects) as empty.
fn value_as_text(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Number(n) => n.to_string(),
        serde_json::Value::Bool(b) => b.to_string(),
        _ => String::new(),
    }
}

/// `{{barcode "code128" order.id}}`, optionally `width=50` (mm) and `text=false`.
fn barcode_helper(
    h: &handlebars::Helper,
    _: &handlebars::Handlebars,
    _: &handlebars::Context,
    _: &mut handlebars::RenderContext,
    out: &mut dyn handlebars::Output,
) -> handlebars::HelperResult {
    let kind = h
        .param(0)
        .map(|v| value_as_text(v.value()))
        .unwrap_or_default();
    let value = h
        .param(1)
        .map(|v| value_as_text(v.value()))
        .unwrap_or_default();
    let width = h
        .hash_get("width")
        .and_then(|v| v.value().as_f64())
        .unwrap_or(barcode::DEFAULT_BARCODE_WIDTH_MM);
    let show_text = hash_flag(h, "text", true);

    // An unencodable value prints nothing; it must not fail the whole job.
    if let Some(html) = barcode::barcode_html(&kind, &value, width, show_text) {
        out.write(&html)?;
    }
    Ok(())
}

/// `{{qrcode order.url}}`, optionally `size=30` (mm).
fn qrcode_helper(
    h: &handlebars::Helper,
    _: &handlebars::Handlebars,
    _: &handlebars::Context,
    _: &mut handlebars::RenderContext,
    out: &mut dyn handlebars::Output,
) -> handlebars::HelperResult {
    let value = h
        .param(0)
        .map(|v| value_as_text(v.value()))
        .unwrap_or_default();
    let size = h
        .hash_get("size")
        .and_then(|v| v.value().as_f64())
        .unwrap_or(barcode::DEFAULT_QR_SIZE_MM);

    if let Some(html) = barcode::qr_html(&value, size) {
        out.write(&html)?;
    }
    Ok(())
}

/// A boolean hash option: `false` / `"false"` / `0` turn it off.
fn hash_flag(h: &handlebars::Helper, name: &str, default: bool) -> bool {
    match h.hash_get(name).map(|v| v.value()) {
        Some(serde_json::Value::Bool(b)) => *b,
        Some(serde_json::Value::String(s)) => !s.eq_ignore_ascii_case("false"),
        Some(serde_json::Value::Number(n)) => n.as_f64() != Some(0.0),
        _ => default,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn barcode_helper_reads_the_value_from_data() {
        let engine = TemplateEngine::new();
        let data = serde_json::json!({ "order": { "id": "ORD-1042" } });
        let out = engine
            .render("{{barcode \"code128\" order.id}}", &data)
            .unwrap();
        assert!(out.contains("<svg"));
        assert!(out.contains(">ORD-1042</text>"));
    }

    #[test]
    fn barcode_helper_accepts_numbers_and_hash_options() {
        let engine = TemplateEngine::new();
        let data = serde_json::json!({ "n": 1042 });
        let out = engine
            .render("{{barcode \"code128\" n width=60 text=false}}", &data)
            .unwrap();
        assert!(out.contains("width=\"60mm\""));
        assert!(!out.contains("<text"));
    }

    #[test]
    fn barcode_helper_prints_nothing_for_missing_or_invalid_values() {
        let engine = TemplateEngine::new();
        let data = serde_json::json!({ "bad": "123" });
        assert_eq!(
            engine
                .render("{{barcode \"code128\" nope}}", &data)
                .unwrap(),
            ""
        );
        // EAN-13 needs 13 digits.
        assert_eq!(
            engine.render("{{barcode \"ean13\" bad}}", &data).unwrap(),
            ""
        );
        assert_eq!(
            engine
                .render("{{barcode \"datamatrix\" bad}}", &data)
                .unwrap(),
            ""
        );
    }

    #[test]
    fn qrcode_helper_reads_the_value_from_data() {
        let engine = TemplateEngine::new();
        let data = serde_json::json!({ "url": "https://example.com/o/1" });
        let out = engine.render("{{qrcode url size=30}}", &data).unwrap();
        assert!(out.contains("width=\"30mm\" height=\"30mm\""));
    }

    #[test]
    fn barcode_survives_the_sanitizer() {
        let engine = TemplateEngine::new();
        let data = serde_json::json!({ "id": "A1" });
        let out = engine.render("{{barcode \"code39\" id}}", &data).unwrap();
        assert!(out.contains("<path d=\"M"));
        assert!(out.contains("<rect"));
    }

    #[test]
    fn test_currency_helper() {
        let engine = TemplateEngine::new();
        let data = serde_json::json!({"price": 19.99});
        let result = engine.render("{{currency price}}", &data).unwrap();
        assert_eq!(result, "$19.99");
    }

    #[test]
    fn test_upper_helper() {
        let engine = TemplateEngine::new();
        let data = serde_json::json!({"name": "hello"});
        let result = engine.render("{{upper name}}", &data).unwrap();
        assert_eq!(result, "HELLO");
    }

    #[test]
    fn test_loop() {
        let engine = TemplateEngine::new();
        let data = serde_json::json!({
            "items": [
                {"name": "Tea", "price": 3.5},
                {"name": "Coffee", "price": 4.0}
            ]
        });
        let template = "{{#each items}}{{name}}: {{currency price}}\n{{/each}}";
        let result = engine.render(template, &data).unwrap();
        assert!(result.contains("Tea: $3.50"));
        assert!(result.contains("Coffee: $4.00"));
    }

    #[test]
    fn pad_left_uses_custom_pad_character() {
        let engine = TemplateEngine::new();
        let data = serde_json::json!({ "n": "42" });
        // The old implementation always padded with spaces.
        let out = engine.render("{{padLeft n 5 \"0\"}}", &data).unwrap();
        assert_eq!(out, "00042");
    }

    #[test]
    fn pad_left_defaults_to_spaces() {
        let engine = TemplateEngine::new();
        let data = serde_json::json!({ "n": "42" });
        let out = engine.render("{{padLeft n 5}}", &data).unwrap();
        assert_eq!(out, "   42");
    }

    #[test]
    fn pad_left_does_not_truncate_when_already_wide() {
        let engine = TemplateEngine::new();
        let data = serde_json::json!({ "n": "abcdef" });
        let out = engine.render("{{padLeft n 3}}", &data).unwrap();
        assert_eq!(out, "abcdef");
    }

    #[test]
    fn date_formats_iso_timestamp() {
        let engine = TemplateEngine::new();
        let data = serde_json::json!({ "d": "2026-10-17T12:30:00Z" });
        let out = engine.render("{{date d \"short\"}}", &data).unwrap();
        assert_eq!(out, "17 Oct 2026");

        let out = engine.render("{{date d \"time\"}}", &data).unwrap();
        assert!(out.contains(':'));
    }

    #[test]
    fn date_passes_through_unparseable_values() {
        let engine = TemplateEngine::new();
        let data = serde_json::json!({ "d": "not-a-date" });
        // Must not produce "not-a-date (%Y-%m-%d)".
        assert_eq!(engine.render("{{date d}}", &data).unwrap(), "not-a-date");
    }

    #[test]
    fn date_of_empty_is_empty() {
        let engine = TemplateEngine::new();
        let data = serde_json::json!({ "d": "" });
        assert_eq!(engine.render("{{date d}}", &data).unwrap(), "");
    }

    #[test]
    fn currency_handles_missing_values() {
        let engine = TemplateEngine::new();
        let data = serde_json::json!({});
        assert_eq!(engine.render("{{currency nope}}", &data).unwrap(), "$0.00");
    }

    #[test]
    fn currency_supports_custom_symbol() {
        let engine = TemplateEngine::new();
        let data = serde_json::json!({ "p": 3 });
        assert_eq!(
            engine.render("{{currency p \"€\"}}", &data).unwrap(),
            "€3.00"
        );
    }
}
