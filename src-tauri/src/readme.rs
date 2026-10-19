use crate::error::{AppError, AppResult};

/// Maximum README size: 64 KiB, validated in Rust locally and again by the
/// service (V2.md §8.2 + §10).
pub const README_MAX_BYTES: usize = 64 * 1024;

/// Base scaffold — outer fence is logical, not literal. The `{{template_name}}`
/// token is substituted at creation (V2.md §8.1).
const SCAFFOLD_BASE: &str = r#"# {{template_name}}

<!-- One line: what is this template for? -->

## What it prints
<!-- e.g. An 80mm thermal receipt with items, totals and a QR code. -->

## Data contract
<!-- The JSON keys this template reads. Keep in sync with Placeholders. -->

```json
{
  "store":  { "name": "", "address": "" },
  "order":  { "number": "", "date": "" },
  "items":  [ { "name": "", "qty": 1, "price": 0.0, "total": 0.0 } ],
  "totals": { "subtotal": 0.0, "tax": 0.0, "total": 0.0 }
}
```

## Placeholders
<!-- Which {{helper}} produces which field. -->

## Printer requirements
- Paper:
- Language:
- DPI:
- Margins:

## Changelog
- v1 — initial version
"#;

/// Generate a scaffold for a template name, with no placeholder pre-fill.
pub fn readme_scaffold(template_name: &str) -> String {
    SCAFFOLD_BASE.replace("{{template_name}}", template_name)
}

/// Extract `{{…}}` tokens from HTML — handles `{{store.name}}`,
/// `{{#each items}}`, `{{currency price}}`, `{{upper name}}` etc.
/// Returns sorted unique placeholder strings stripped of helper prefixes.
pub fn extract_placeholders(html: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut i = 0;
    let bytes = html.as_bytes();
    while i + 1 < bytes.len() {
        if bytes[i] == b'{' && bytes[i + 1] == b'{' {
            if let Some(end) = html[i + 2..].find("}}") {
                let inner = html[i + 2..i + 2 + end].trim();
                if !inner.is_empty() && !inner.starts_with('!') && !inner.starts_with('/') {
                    // Strip block helpers (#each, #if) and extract first arg if helper
                    let token = extract_token(inner);
                    if !token.is_empty() && seen.insert(token.clone()) {
                        out.push(token);
                    }
                }
                i += 2 + end + 2;
                continue;
            }
        }
        i += 1;
    }
    out.sort();
    out
}

fn extract_token(inner: &str) -> String {
    let s = inner.trim();
    // Handle block helpers: "#each items" -> "items", "#if cond" -> "cond"
    let s = if s.starts_with('#') || s.starts_with('/') {
        s[1..].trim()
    } else {
        s
    };
    // For helpers like "currency price" -> "price", "padLeft order.number 10" -> "order.number"
    // Take the last token that looks like a path (contains . or is simple)
    let parts: Vec<&str> = s.split_whitespace().collect();
    if parts.is_empty() {
        return String::new();
    }
    // If single token like "store.name" or "items", return it
    // If helper + arg(s), return the first arg that contains '.' or the last part
    if parts.len() == 1 {
        // Check if it's a helper without arg (e.g. "upper") - skip? Keep as is
        return parts[0].to_string();
    }
    // Helper form: pick the second part which is likely the data path
    // e.g. "currency total" -> "total", "upper store.name" -> "store.name"
    // For "#each items" we already stripped #, so parts[0] is "each", parts[1] is "items"
    if parts[0] == "each" || parts[0] == "if" || parts[0] == "unless" || parts[0] == "with" {
        return parts.get(1).unwrap_or(&"").to_string();
    }
    // Generic helper: second token
    parts[1].to_string()
}

/// Generate scaffold with placeholders pre-filled (V2.md §7).
/// If `html` contains `{{…}}` tokens, the `## Placeholders` section is
/// replaced with a bullet list of those tokens.
pub fn readme_scaffold_with_placeholders(template_name: &str, html: &str) -> String {
    let placeholders = extract_placeholders(html);
    let mut scaffold = readme_scaffold(template_name);
    if !placeholders.is_empty() {
        let list = placeholders
            .iter()
            .map(|p| format!("- `{{{{{}}}}}`", p))
            .collect::<Vec<_>>()
            .join("\n");
        let replacement = format!("## Placeholders\n{}", list);
        scaffold = scaffold.replace(
            "## Placeholders\n<!-- Which {{helper}} produces which field. -->",
            &replacement,
        );
    }
    scaffold
}

/// Validate README size cap.
pub fn validate_readme(readme: &str) -> AppResult<()> {
    if readme.len() > README_MAX_BYTES {
        return Err(AppError::Validation(format!(
            "README exceeds 64 KiB ({} bytes)",
            readme.len()
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scaffold_has_every_heading() {
        let s = readme_scaffold("Invoice");
        assert!(s.contains("# Invoice"), "title");
        assert!(s.contains("## What it prints"));
        assert!(s.contains("## Data contract"));
        assert!(s.contains("## Placeholders"));
        assert!(s.contains("## Printer requirements"));
        assert!(s.contains("## Changelog"));
        assert!(s.contains("```json"));
    }

    #[test]
    fn scaffold_substitutes_name() {
        let s = readme_scaffold("My Label");
        assert!(s.contains("# My Label"));
        assert!(!s.contains("{{template_name}}"));
    }

    #[test]
    fn extract_placeholders_finds_tokens() {
        let html = r#"<div>{{store.name}} {{order.number}} {{#each items}}{{name}} {{currency price}}{{/each}}</div>"#;
        let mut ph = extract_placeholders(html);
        ph.sort();
        // Should find store.name, order.number, items, name, price etc.
        assert!(ph.contains(&"store.name".to_string()));
        assert!(ph.contains(&"order.number".to_string()));
    }

    #[test]
    fn scaffold_with_placeholders_fills_section() {
        let html = "<p>{{store.name}} and {{order.number}}</p>";
        let s = readme_scaffold_with_placeholders("Test", html);
        assert!(s.contains("store.name"));
        assert!(s.contains("order.number"));
        assert!(!s.contains("Which {{helper}}"));
    }

    #[test]
    fn readme_cap_rejects_oversize() {
        let big = "a".repeat(README_MAX_BYTES + 1);
        assert!(validate_readme(&big).is_err());
        let ok = "a".repeat(README_MAX_BYTES);
        assert!(validate_readme(&ok).is_ok());
    }

    #[test]
    fn xss_payload_in_readme_renders_as_text() {
        // This is a frontend guarantee (react-markdown without rehype-raw),
        // but the Rust side must not execute it either — it's inert text.
        let payload = "<script>alert(1)</script>";
        // Scaffold generation must not execute it
        let s = readme_scaffold(payload);
        assert!(s.contains(payload));
        // Validation just checks size, not execution
        assert!(validate_readme(payload).is_ok());
    }
}
