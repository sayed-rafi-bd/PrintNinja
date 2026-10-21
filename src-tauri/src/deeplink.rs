use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum DeepLinkAction {
    Print(DeepLinkPrint),
    Open(String),
    Template(String),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeepLinkPrint {
    pub preset: Option<String>,
    pub template: Option<String>,
    pub printer: Option<String>,
    pub url: Option<String>,
    pub copies: Option<u32>,
    pub orientation: Option<String>,
    pub fit: Option<String>,
    pub test: bool,
    pub confirm: bool,
    pub callback: Option<String>,
}

/// Parse a deep link URL into a structured action
pub fn parse_deep_link(url: &str) -> Result<DeepLinkAction, String> {
    let url = url.strip_prefix("printninja://").unwrap_or(url);

    let (path, query) = if let Some(idx) = url.find('?') {
        (&url[..idx], &url[idx + 1..])
    } else {
        (url, "")
    };

    let params = parse_query_params(query);

    match path {
        "print" => {
            let print = DeepLinkPrint {
                preset: params.get("preset").map(|s| s.to_string()),
                template: params.get("template").map(|s| s.to_string()),
                printer: params.get("printer").map(|s| s.to_string()),
                url: params.get("url").map(|s| s.to_string()),
                copies: params.get("copies").and_then(|s| s.parse().ok()),
                orientation: params.get("orientation").map(|s| s.to_string()),
                fit: params.get("fit").map(|s| s.to_string()),
                test: params
                    .get("test")
                    .map(|s| s == "1" || s == "true")
                    .unwrap_or(false),
                confirm: params
                    .get("confirm")
                    .map(|s| s != "0" && s != "false")
                    .unwrap_or(true),
                callback: params.get("callback").map(|s| s.to_string()),
            };
            Ok(DeepLinkAction::Print(print))
        }
        _ if path.starts_with("open/") => {
            let destination = path.strip_prefix("open/").unwrap_or("");
            Ok(DeepLinkAction::Open(destination.to_string()))
        }
        _ if path.starts_with("template/") => {
            let id = path.strip_prefix("template/").unwrap_or("");
            Ok(DeepLinkAction::Template(id.to_string()))
        }
        _ => Err(format!("Unknown deep link action: {}", path)),
    }
}

fn parse_query_params(query: &str) -> HashMap<String, String> {
    let mut params = HashMap::new();
    for pair in query.split('&') {
        if let Some((key, value)) = pair.split_once('=') {
            params.insert(percent_decode(key), percent_decode(value));
        }
    }
    params
}

fn percent_decode(s: &str) -> String {
    // Query strings encode space as `+`, not `%20`. The old decoder left `+`
    // verbatim, so `printninja://print?template=My+Receipt` became
    // `My+Receipt` instead of `My Receipt`.
    //
    // Delegate to the `urlencoding` crate already in Cargo.toml, which
    // handles invalid `%` sequences without dropping them.
    let plus_as_space = s.replace('+', " ");
    urlencoding::decode(&plus_as_space)
        .map(|cow| cow.into_owned())
        .unwrap_or(plus_as_space)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percent_decode_handles_plus_as_space() {
        assert_eq!(percent_decode("My+Receipt"), "My Receipt");
        assert_eq!(percent_decode("a+b+c"), "a b c");
        assert_eq!(percent_decode("hello+world"), "hello world");
    }

    #[test]
    fn percent_decode_handles_percent_encoding() {
        assert_eq!(percent_decode("hello%20world"), "hello world");
        assert_eq!(percent_decode("%2F"), "/");
        assert_eq!(percent_decode("a%2Bb"), "a+b");
    }

    #[test]
    fn percent_decode_handles_mixed_plus_and_percent() {
        // `+` becomes space before percent-decoding, so `%2B` stays `+`.
        assert_eq!(percent_decode("My+Receipt%20v2"), "My Receipt v2");
    }

    #[test]
    fn percent_decode_preserves_invalid_percent() {
        // Invalid `%` sequences must not be dropped.
        assert_eq!(percent_decode("100%"), "100%");
        assert_eq!(percent_decode("a%2"), "a%2");
        assert_eq!(percent_decode("a%ZZ"), "a%ZZ");
    }

    #[test]
    fn parse_deep_link_decodes_template_with_plus() {
        let action =
            parse_deep_link("printninja://print?template=My+Receipt&printer=Desk").unwrap();
        match action {
            DeepLinkAction::Print(p) => {
                assert_eq!(p.template.as_deref(), Some("My Receipt"));
                assert_eq!(p.printer.as_deref(), Some("Desk"));
            }
            _ => panic!("expected Print"),
        }
    }

    #[test]
    fn parse_deep_link_decodes_percent_encoded_url() {
        let action =
            parse_deep_link("printninja://print?url=https%3A%2F%2Fexample.com%2Fdata").unwrap();
        match action {
            DeepLinkAction::Print(p) => {
                assert_eq!(p.url.as_deref(), Some("https://example.com/data"));
            }
            _ => panic!("expected Print"),
        }
    }

    #[test]
    fn parse_deep_link_handles_copies_and_flags() {
        let action = parse_deep_link(
            "printninja://print?copies=3&test=1&confirm=false&orientation=landscape",
        )
        .unwrap();
        match action {
            DeepLinkAction::Print(p) => {
                assert_eq!(p.copies, Some(3));
                assert!(p.test);
                assert!(!p.confirm);
                assert_eq!(p.orientation.as_deref(), Some("landscape"));
            }
            _ => panic!("expected Print"),
        }
    }

    /// The contract the e2e fake mirrors (e2e/tests/deeplink.e2e.ts
    /// pins the same table against the JS implementation): garbage
    /// copies drop to None, confirm defaults on, open/template split
    /// on the first slash, unknown actions error.
    #[test]
    fn parse_deep_link_contract_table() {
        let print = |url: &str| match parse_deep_link(url).unwrap() {
            DeepLinkAction::Print(p) => p,
            other => panic!("expected Print for {url}, got {other:?}"),
        };

        let garbage = print("printninja://print?copies=lots");
        assert_eq!(garbage.copies, None);
        let negative = print("printninja://print?copies=-3");
        assert_eq!(negative.copies, None);
        let overflow = print("printninja://print?copies=99999999999");
        assert_eq!(overflow.copies, None);
        let defaults = print("printninja://print?template=Label");
        assert_eq!(defaults.copies, None);
        assert!(!defaults.test);
        assert!(defaults.confirm);
        assert_eq!(defaults.callback, None);
        let explicit = print(
            "printninja://print?callback=https%3A%2F%2Fexample.com%2Fdone&confirm=0",
        );
        assert!(!explicit.confirm);
        assert_eq!(
            explicit.callback.as_deref(),
            Some("https://example.com/done")
        );

        match parse_deep_link("printninja://open/history").unwrap() {
            DeepLinkAction::Open(destination) => assert_eq!(destination, "history"),
            other => panic!("expected Open, got {other:?}"),
        }
        match parse_deep_link("printninja://template/abc-123").unwrap() {
            DeepLinkAction::Template(id) => assert_eq!(id, "abc-123"),
            other => panic!("expected Template, got {other:?}"),
        }
        assert!(parse_deep_link("printninja://explode/now").is_err());
    }
}
