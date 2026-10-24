//! Print layout contract: the placement of a design page on the paper.
//!
//! The cases live in `tests/fixtures/layout_cases.json` and run here and
//! against the Print page preview (`src/test/printLayout.test.ts`), so the
//! preview and the printed page cannot drift apart.

use printninja_lib::render::layout::{compute, Margins};
use serde_json::Value;

fn num(v: &Value) -> f64 {
    v.as_f64().expect("number in fixture")
}

#[test]
fn layout_matches_the_shared_fixture() {
    let text = std::fs::read_to_string("tests/fixtures/layout_cases.json")
        .expect("read layout_cases.json");
    let doc: Value = serde_json::from_str(&text).expect("parse layout_cases.json");
    let cases = doc["cases"].as_array().expect("cases array");
    assert!(!cases.is_empty());

    for case in cases {
        let name = case["name"].as_str().unwrap_or("?");
        let m = &case["margins"];
        let layout = compute(
            case["fit_mode"].as_str().unwrap(),
            num(&case["design"][0]),
            num(&case["design"][1]),
            num(&case["paper"][0]),
            num(&case["paper"][1]),
            Margins {
                top: num(&m["top"]),
                right: num(&m["right"]),
                bottom: num(&m["bottom"]),
                left: num(&m["left"]),
            },
        );
        let want = &case["expect"];
        // The fixture stores four decimals.
        let close = |a: f64, b: f64| (a - b).abs() < 1e-3;

        assert!(close(layout.scale, num(&want["scale"])), "{name}: scale");
        let content = [
            layout.content_x,
            layout.content_y,
            layout.content_w,
            layout.content_h,
        ];
        for (i, got) in content.iter().enumerate() {
            assert!(
                close(*got, num(&want["content"][i])),
                "{name}: content[{i}]"
            );
        }
        let placements = want["placements"].as_array().unwrap();
        assert_eq!(layout.placements.len(), placements.len(), "{name}: sheets");
        for (p, w) in layout.placements.iter().zip(placements) {
            assert!(close(p.offset_x, num(&w[0])), "{name}: offset_x");
            assert!(close(p.offset_y, num(&w[1])), "{name}: offset_y");
        }
    }
}
