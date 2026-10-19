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
    }

    pub fn render(&self, template: &str, data: &serde_json::Value) -> Result<String> {
        let out = self.hb.render_template(template, data).map_err(|e| anyhow::anyhow!(e))?;
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
                            while l < chars.len()
                                && !chars[l].is_whitespace()
                                && chars[l] != '>'
                            {
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

    for needle in ["src=\"http", "src='http", "href=\"http", "href='http", "src=\"//", "href=\"//"] {
        if lower_html.contains(needle) {
            issues.push(format!("Remote reference in HTML: {} — use data: URIs", &needle[..20]));
        }
    }
    for needle in ["url(\"http", "url('http", "url(http", "url(\"//", "url('//", "url(//"] {
        if lower_html.contains(needle) || lower_css.contains(needle) {
            issues.push(format!("Remote url() in CSS/HTML: {} — use data: URIs", needle));
        }
    }
    if lower_html.contains("@import") && (lower_html.contains("http://") || lower_html.contains("https://") || lower_html.contains("//")) {
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

#[cfg(test)]
mod tests {
    use super::*;

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
