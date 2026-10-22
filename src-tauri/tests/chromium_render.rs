//! Real-Chromium render check (Linux only, opt-in).
//!
//! The committed suite proves the plumbing with a fake browser script
//! (see `render::tests::chromium_override_and_root_retry`). This test
//! proves the other end: a real system Chromium turns the `@page`-sized
//! HTML into a PDF through the shipping `PdfRenderer`.
//!
//! Run it where a Chromium is installed:
//! `PRINTNINJA_TEST_REAL_CHROMIUM=1 cargo test --test chromium_render`
//! Everywhere else (including CI without a browser) it skips.
use printninja_lib::render::PdfRenderer;

#[tokio::test]
async fn real_chromium_renders_label_pdf() {
    if std::env::var_os("PRINTNINJA_TEST_REAL_CHROMIUM").is_none() {
        eprintln!("skipped: set PRINTNINJA_TEST_REAL_CHROMIUM=1 with a system chromium");
        return;
    }
    let dir = std::env::temp_dir().join(format!("pn-real-chromium-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let renderer = PdfRenderer::new(dir.clone());
    let html = "<!DOCTYPE html><html><head><style>@page { size: 100mm 150mm; margin: 5mm; }</style></head><body><h1>PrintNinja Linux probe</h1></body></html>";
    let bytes = renderer
        .html_to_pdf(html, 100.0, 150.0, "portrait")
        .await
        .expect("system chromium must render");
    assert!(
        bytes.starts_with(b"%PDF"),
        "not a pdf: {:?}",
        &bytes[..20.min(bytes.len())]
    );
    assert!(bytes.len() > 1000, "suspiciously small: {}", bytes.len());
    let _ = std::fs::remove_dir_all(&dir);
}
