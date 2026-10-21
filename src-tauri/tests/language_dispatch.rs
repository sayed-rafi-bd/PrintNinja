//! Phase 0 item 0.6 (P4): the print pipeline dispatches on
//! `printers.language`.
//!
//! Byte-level loopback — no hardware and no browser: a raw-TCP printer on a
//! random loopback port receives each command language's own bytes, and the
//! `pdf` language still sends the renderer's PDF untouched. The encoders and
//! `render/raster.rs` are finally called by the pipeline.

use printninja_lib::commands::print::{run_print_with, JobRenderer, PrintRequest};
use printninja_lib::db::Database;
use printninja_lib::queue::PrintQueue;
use printninja_lib::render::raster::RasterImage;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

type Db = Arc<Mutex<Database>>;

fn test_db() -> Db {
    let path = std::env::temp_dir().join(format!("printninja_lang_{}.db", uuid::Uuid::new_v4()));
    let db = Database::open(&format!("sqlite:{}", path.display())).expect("open db");
    Arc::new(Mutex::new(db))
}

fn cache_dir() -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("printninja_p06_{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).expect("create cache dir");
    dir
}

/// A 16×8 image with a known dot pattern, so every assertion can check the
/// encoded bytes down to the bit.
fn test_raster() -> RasterImage {
    let mut img = RasterImage::new(16, 8);
    // Top row all set, a diagonal, and the bottom-right pixel.
    for x in 0..16 {
        img.set_bit(x, 0, true);
    }
    for i in 0..8 {
        img.set_bit(i, i, true);
    }
    img.set_bit(15, 7, true);
    img
}

/// Substitutes the raster step only: the pipeline still runs the layout,
/// the queue permit, the real encoders and the real TCP transport.
struct StubRenderer {
    raster: RasterImage,
    seen: Arc<Mutex<Option<(usize, usize)>>>,
}

#[async_trait::async_trait]
impl JobRenderer for StubRenderer {
    async fn render(&self, _: &str, _: f64, _: f64, _: &str) -> anyhow::Result<Vec<u8>> {
        panic!("a command-language job must never run the PDF renderer");
    }

    async fn rasterize(
        &self,
        _html: &str,
        w_px: usize,
        h_px: usize,
    ) -> anyhow::Result<RasterImage> {
        *self.seen.lock().unwrap() = Some((w_px, h_px));
        Ok(self.raster.clone())
    }
}

/// A renderer that serves only the PDF path.
struct PdfStub;

#[async_trait::async_trait]
impl JobRenderer for PdfStub {
    async fn render(&self, _: &str, _: f64, _: f64, _: &str) -> anyhow::Result<Vec<u8>> {
        Ok(b"%PDF-1.4 fake".to_vec())
    }
}

fn seed_printer(db: &Db, name: &str, language: &str, port: u16) {
    let guard = db.lock().unwrap();
    guard
        .connection()
        .execute(
            "INSERT INTO printers (name, type, address, language, paper_width_mm, dpi)
             VALUES (?1, 'raw_tcp', ?2, ?3, 40, 203)",
            rusqlite::params![name, format!("127.0.0.1:{port}"), language],
        )
        .expect("seed printer");
}

fn print_request(printer: &str) -> PrintRequest {
    PrintRequest {
        printer_name: printer.to_string(),
        html: "<html><body><p>label</p></body></html>".to_string(),
        page_width_mm: Some(40.0),
        page_height_mm: Some(30.0),
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
        source: Some("ui".to_string()),
        idempotency_key: None,
    }
}

/// What a healthy printer says to a status query, in each dialect that has
/// one — written out by hand, so the assertion about being able to print is
/// not derived from the code under test.
fn healthy_answer(language: &str) -> &'static [u8] {
    match language {
        "escpos" => &[0x12, 0x12, 0x12, 0x12],
        "zpl" => b"\x02030,0,0,0\x03\r\n\x02000,0\x03\r\n\x020000,0\x03\r\n",
        "tspl" => &[0x00],
        _ => &[],
    }
}

/// Bind a loopback listener on a random port: `(port, capture task)`.
///
/// A job does not arrive on the connection that opens the conversation
/// anymore: a printer that speaks a status dialect is asked whether it can
/// print first, on its own connection. So this accepts until the client goes
/// away and returns the last thing it was sent — the job — while answering
/// the probe healthily, which is what lets the job go out at all.
async fn loopback(language: &str) -> (u16, tokio::task::JoinHandle<Vec<u8>>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind loopback");
    let port = listener.local_addr().unwrap().port();
    let answer = healthy_answer(language).to_vec();
    let handle = tokio::spawn(async move {
        let mut last = Vec::new();
        let mut first = true;
        loop {
            let accepted =
                tokio::time::timeout(Duration::from_millis(250), listener.accept()).await;
            let Ok(Ok((mut sock, _))) = accepted else {
                break;
            };
            if first && !answer.is_empty() {
                sock.write_all(&answer)
                    .await
                    .expect("answer the status query");
            }
            first = false;
            let mut buf = Vec::new();
            sock.read_to_end(&mut buf).await.expect("read");
            if !buf.is_empty() {
                last = buf;
            }
        }
        last
    });
    (port, handle)
}

/// Print one job to a loopback printer speaking `language` and return the
/// exact bytes of the job.
///
/// The status query that a dialect-speaking printer is asked first comes on
/// its own connection and is answered, not returned: what is asserted here
/// is what the printer was sent to print.
async fn capture(language: &str) -> (Vec<u8>, Option<(usize, usize)>) {
    let db = test_db();
    let (port, capture) = loopback(language).await;
    seed_printer(&db, "Thermal", language, port);
    let queue = PrintQueue::new();
    let cache = cache_dir();
    let seen = Arc::new(Mutex::new(None));
    let renderer = StubRenderer {
        raster: test_raster(),
        seen: seen.clone(),
    };
    let res = run_print_with(&cache, &db, &queue, print_request("Thermal"), &renderer)
        .await
        .expect("pipeline");
    assert!(res.success, "job must succeed: {:?}", res.error);
    let bytes = capture.await.expect("capture");
    let seen = seen.lock().unwrap().take();
    (bytes, seen)
}

#[tokio::test]
async fn zpl_printers_receive_zpl() {
    let (bytes, _) = capture("zpl").await;
    let text = String::from_utf8_lossy(&bytes);
    assert!(text.starts_with("^XA"), "{text}");
    assert!(text.contains("^GFA"), "{text}");
    assert!(text.trim_end().ends_with("^XZ"), "{text}");
    // ^GFA wants the packed dots as hex — the exact raster, byte for byte.
    let hex: String = test_raster()
        .dots
        .iter()
        .map(|b| format!("{b:02X}"))
        .collect();
    assert!(
        text.contains(&hex),
        "bitmap hex must be the raster's dots: {text}"
    );
}

#[tokio::test]
async fn tspl_printers_receive_tspl_with_raw_bitmap() {
    let (bytes, _) = capture("tspl").await;
    let text = String::from_utf8_lossy(&bytes);
    assert!(text.starts_with("SIZE 40 mm"), "{text}");
    assert!(text.contains("BITMAP "), "{text}");
    assert!(text.contains("PRINT 1"), "{text}");
    // Canonical TSPL: the BITMAP command is followed by the raw packed
    // dots, not their hex.
    let marker = text.find("BITMAP").expect("BITMAP command");
    let after = &bytes[marker..];
    let newline = after
        .iter()
        .position(|b| *b == b'\n')
        .expect("BITMAP line ends");
    let body = &after[newline + 1..];
    assert!(
        body.starts_with(&test_raster().dots),
        "raw bitmap bytes must follow the BITMAP command"
    );
}

#[tokio::test]
async fn escpos_printers_receive_escpos() {
    let (bytes, _) = capture("escpos").await;
    assert!(
        bytes.starts_with(&[0x1B, 0x40]),
        "must open with ESC @ init: {bytes:?}"
    );
    assert!(
        bytes.windows(4).any(|w| w == [0x1D, 0x76, 0x30, 0x00]),
        "must carry the GS v 0 raster command: {bytes:?}"
    );
    assert!(
        bytes.ends_with(&test_raster().dots),
        "the raster's dots must close the stream"
    );
}

#[tokio::test]
async fn cpcl_printers_receive_cpcl() {
    let (bytes, _) = capture("cpcl").await;
    let text = String::from_utf8_lossy(&bytes);
    assert!(text.starts_with("! 0 200 200"), "{text}");
    assert!(text.contains("CG "), "{text}");
    assert!(text.trim_end().ends_with("PRINT"), "{text}");
    let hex: String = test_raster()
        .dots
        .iter()
        .map(|b| format!("{b:02X}"))
        .collect();
    assert!(
        text.contains(&hex),
        "bitmap hex must be the raster's dots: {text}"
    );
}

#[tokio::test]
async fn raster_language_sends_the_packed_dots_alone() {
    let (bytes, _) = capture("raster").await;
    assert_eq!(bytes, test_raster().dots, "raster is the bare 1-bit dump");
}

#[tokio::test]
async fn pdf_printers_still_receive_pdf() {
    let db = test_db();
    let (port, capture) = loopback("pdf").await;
    seed_printer(&db, "Office", "pdf", port);
    let queue = PrintQueue::new();
    let cache = cache_dir();
    let res = run_print_with(&cache, &db, &queue, print_request("Office"), &PdfStub)
        .await
        .expect("pipeline");
    assert!(res.success, "job must succeed: {:?}", res.error);
    let bytes = capture.await.expect("capture");
    assert_eq!(
        bytes, b"%PDF-1.4 fake",
        "pdf language sends the PDF untouched"
    );
}

#[tokio::test]
async fn an_unrecognised_language_falls_back_to_the_pdf_path() {
    // The schema's CHECK constraint stops this through the app; a hand-edited
    // row can still carry anything. It must behave like `pdf`, not crash.
    let db = test_db();
    let (port, capture) = loopback("telepathy").await;
    {
        let guard = db.lock().unwrap();
        // The schema's CHECK stops 'telepathy' through the app; a hand-edited
        // row (sqlite3 CLI, another connection) can carry anything, and this
        // is exactly how it would get there. The pragma is per-connection —
        // `Database` holds one — and is re-armed immediately, so only this
        // INSERT sees it; the row itself survives validation-free.
        guard
            .connection()
            .execute_batch("PRAGMA ignore_check_constraints = ON;")
            .expect("relax check for a hand-edited row");
        guard
            .connection()
            .execute(
                "INSERT INTO printers (name, type, address, language)
                 VALUES ('Odd', 'raw_tcp', ?1, 'telepathy')",
                [format!("127.0.0.1:{port}")],
            )
            .expect("seed odd printer");
        guard
            .connection()
            .execute_batch("PRAGMA ignore_check_constraints = OFF;")
            .expect("re-arm check");
    }
    let queue = PrintQueue::new();
    let cache = cache_dir();
    let res = run_print_with(&cache, &db, &queue, print_request("Odd"), &PdfStub)
        .await
        .expect("pipeline");
    assert!(res.success, "job must succeed: {:?}", res.error);
    let bytes = capture.await.expect("capture");
    assert_eq!(bytes, b"%PDF-1.4 fake");
}

#[tokio::test]
async fn the_raster_is_sized_in_the_printers_own_dots() {
    // 40 mm × 30 mm at 203 dpi = 319.69 × 239.76 → 320 × 240 dots: the
    // browser must be asked for the printer's resolution, not the screen's.
    let (_, seen) = capture("zpl").await;
    assert_eq!(seen, Some((320, 240)));
}
