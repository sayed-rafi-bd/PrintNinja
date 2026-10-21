use anyhow::{anyhow, Result};
use std::path::PathBuf;

pub mod barcode;
// Launches headless Edge. Windows runs it for real; the unit tests build it
// everywhere so the profile logic is tested without Edge.
#[cfg(any(windows, test))]
mod edge;
pub mod handlebars;
pub mod raster;

pub struct PdfRenderer {
    cache_dir: PathBuf,
}

impl PdfRenderer {
    pub fn new(cache_dir: PathBuf) -> Self {
        Self { cache_dir }
    }

    /// Write one job's HTML to a **uniquely named** file and return the path.
    ///
    /// Every job shares this cache directory and jobs for different printers
    /// render in parallel, so the fixed `render.html` this used to write let
    /// one job hand its document to another printer (P6).
    pub async fn write_job_html(&self, html: &str) -> Result<PathBuf> {
        let path = self
            .cache_dir
            .join(format!("render-{}.html", uuid::Uuid::new_v4()));
        tokio::fs::write(&path, html).await?;
        // Keep the newest input next to `last-render.pdf` for debugging;
        // it is an artifact, never read back by a render.
        let _ = tokio::fs::copy(&path, self.cache_dir.join("last-render.html")).await;
        Ok(path)
    }

    /// Render `html` to a PDF.
    ///
    /// Page size and orientation arrive in the document's `@page` rule
    /// (`apply_layout`), so the parameters here are for the log line.
    ///
    /// Failure is an error, never a placeholder (P5). When Edge was missing
    /// or failed — and on every non-Windows platform — this used to return a
    /// stub PDF containing the word "PrintNinja" and the job reported success,
    /// so the operator saw a printed page instead of their label.
    pub async fn html_to_pdf(
        &self,
        html: &str,
        page_width_mm: f64,
        page_height_mm: f64,
        orientation: &str,
    ) -> Result<Vec<u8>> {
        tracing::debug!(page_width_mm, page_height_mm, orientation, "rendering PDF");
        let html_path = self.write_job_html(html).await?;

        #[cfg(windows)]
        let result = self.webview2_print_to_pdf(&html_path).await;

        #[cfg(not(windows))]
        let result = Err(anyhow!(
            "no PDF renderer on this platform (printing needs Windows with Edge/WebView2); \
             refusing to send a placeholder instead of the document"
        ));

        // Per-job file: removed whether the render worked or not, so the
        // cache dir does not grow a file per print.
        let _ = tokio::fs::remove_file(&html_path).await;
        result
    }

    #[cfg(windows)]
    async fn webview2_print_to_pdf(&self, html_path: &PathBuf) -> Result<Vec<u8>> {
        // Unique per job: a shared `output.pdf` could be stale (Edge exits 0
        // without writing when it hands off to a running instance) or be
        // overwritten by a concurrent job.
        let job = uuid::Uuid::new_v4();
        let pdf_path = self.cache_dir.join(format!("output-{job}.pdf"));

        let edge_path = find_edge("PDF rendering")?;
        let html_url = format!("file:///{}", html_path.to_string_lossy().replace('\\', "/"));
        let mut args: Vec<String> = [
            "--headless",
            "--disable-gpu",
            "--no-first-run",
            "--no-default-browser-check",
            "--print-to-pdf-no-header",
            "--no-pdf-header-footer",
        ]
        .iter()
        .map(|a| a.to_string())
        .collect();
        args.push(format!("--print-to-pdf={}", pdf_path.to_string_lossy()));
        args.push(html_url.clone());

        // The profile (reusable, or a throwaway) is the launcher's business.
        let run = match edge::shared()
            .run(
                std::path::Path::new(edge_path),
                &self.cache_dir,
                &args,
                &pdf_path,
            )
            .await
        {
            Ok(run) => run,
            Err(e) => {
                let _ = std::fs::remove_file(&pdf_path);
                return Err(e);
            }
        };

        if run.output.status.success() && pdf_path.exists() {
            let bytes = tokio::fs::read(&pdf_path).await;
            // Keep the newest render next to last-render.html so it can be
            // opened directly to tell "Edge output is unstyled" apart from
            // "styling is lost later in the print path".
            let last = self.cache_dir.join("last-render.pdf");
            let _ = std::fs::copy(&pdf_path, &last);
            let _ = std::fs::remove_file(&pdf_path);
            tracing::info!(
                html = %html_url,
                pdf = %last.display(),
                bytes = bytes.as_ref().map_or(0, |b| b.len()),
                edge_ms = run.edge_ms,
                profile_cleanup_ms = run.cleanup_ms,
                warm_profile = run.warm,
                "rendered PDF with Edge"
            );
            return bytes.map_err(Into::into);
        }

        // Edge failed or wrote nothing. Report it; do not fall back to a
        // placeholder (P5).
        let stderr = String::from_utf8_lossy(&run.output.stderr);
        let _ = std::fs::remove_file(&pdf_path);
        Err(anyhow!(
            "Edge print-to-pdf did not produce a PDF (status {}, stderr: {})",
            run.output.status,
            stderr.trim()
        ))
    }

    /// Render `html` to a 1-bit raster at the printer's own resolution (P4).
    ///
    /// Headless Edge screenshots the page at exactly the window size the
    /// label prints at (1 CSS px = 1 printer dot), and the PNG is
    /// thresholded to dots. Same Edge dependency as [`Self::html_to_pdf`] —
    /// and the same rule: failure is an error, never a placeholder.
    pub async fn html_to_raster(
        &self,
        html: &str,
        w_px: usize,
        h_px: usize,
    ) -> Result<crate::render::raster::RasterImage> {
        tracing::debug!(w_px, h_px, "rasterizing for a command-language printer");
        let html_path = self.write_job_html(html).await?;

        #[cfg(windows)]
        let result = self.webview2_screenshot(&html_path, w_px, h_px).await;

        #[cfg(not(windows))]
        let result = Err(anyhow!(
            "no raster renderer on this platform (command-language printing needs \
             Windows with Edge/WebView2); refusing to send a placeholder instead of the label"
        ));

        // Per-job file: removed whether the render worked or not, so the
        // cache dir does not grow a file per print.
        let _ = tokio::fs::remove_file(&html_path).await;
        result
    }

    /// Headless Edge `--screenshot` at `w_px`×`h_px`, thresholded to dots.
    #[cfg(windows)]
    async fn webview2_screenshot(
        &self,
        html_path: &PathBuf,
        w_px: usize,
        h_px: usize,
    ) -> Result<crate::render::raster::RasterImage> {
        // Unique per job, like the PDF path: no shared screenshot target,
        // no stale hand-offs between concurrent jobs.
        let job = uuid::Uuid::new_v4();
        let png_path = self.cache_dir.join(format!("shot-{job}.png"));

        let edge_path = find_edge("raster printing")?;
        let html_url = format!("file:///{}", html_path.to_string_lossy().replace('\\', "/"));
        let mut args: Vec<String> = [
            "--headless",
            "--disable-gpu",
            "--no-first-run",
            "--no-default-browser-check",
            "--hide-scrollbars",
            // 1 CSS px = 1 printer dot: the PNG comes out exactly the
            // label in dots — no HiDPI scaling, no scrollbar gutters.
            "--force-device-scale-factor=1",
        ]
        .iter()
        .map(|a| a.to_string())
        .collect();
        args.push(format!("--window-size={w_px},{h_px}"));
        args.push(format!("--screenshot={}", png_path.to_string_lossy()));
        args.push(html_url);

        let run = match edge::shared()
            .run(
                std::path::Path::new(edge_path),
                &self.cache_dir,
                &args,
                &png_path,
            )
            .await
        {
            Ok(run) => run,
            Err(e) => {
                let _ = tokio::fs::remove_file(&png_path).await;
                return Err(e);
            }
        };

        if !(run.output.status.success() && png_path.exists()) {
            let stderr = String::from_utf8_lossy(&run.output.stderr);
            let _ = tokio::fs::remove_file(&png_path).await;
            return Err(anyhow!(
                "Edge screenshot did not produce a PNG (status {}, stderr: {})",
                run.output.status,
                stderr.trim()
            ));
        }
        tracing::info!(
            edge_ms = run.edge_ms,
            profile_cleanup_ms = run.cleanup_ms,
            warm_profile = run.warm,
            "rendered screenshot with Edge"
        );

        let raster = png_to_raster(&png_path).map_err(|e| anyhow!("screenshot decode: {e}"))?;

        // Keep the newest screenshot next to last-render.pdf for debugging
        // the hardware checklist; the per-job file is removed either way.
        let _ = tokio::fs::copy(&png_path, self.cache_dir.join("last-render.png")).await;
        let _ = tokio::fs::remove_file(&png_path).await;
        Ok(raster)
    }
}

/// Where Edge lives. Both Program Files locations are checked; `purpose`
/// names the render in the error so the operator knows what failed.
#[cfg(windows)]
fn find_edge(purpose: &str) -> Result<&'static str> {
    const EDGE_PATHS: [&str; 2] = [
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    ];
    EDGE_PATHS
        .iter()
        .copied()
        .find(|p| std::path::Path::new(p).exists())
        .ok_or_else(|| {
            anyhow!(
                "Microsoft Edge not found (looked in {}) — {purpose} needs \
                 Edge/WebView2; the job cannot print without it",
                EDGE_PATHS.join(", ")
            )
        })
}

/// Startup sweep: remove throwaway Edge profiles left behind by earlier
/// runs (P17 follow-up — the stray `.pem` next to `last-render.pdf`).
///
/// A print that cannot use the reusable `edge-warm-profile` makes a fresh
/// `edge-profile-{uuid}` dir and removes it after the render (with retries —
/// see `edge.rs`). A run killed mid-render still leaves its profile in the
/// cache dir, certificate-transparency material included, which looked like
/// the app had written a key file. The reusable profile is not swept: keeping
/// it is the point.
///
/// Called once from app setup **before the worker spawns**, so nothing in
/// flight owns these directories. `min_age` guards the one remaining race —
/// a second app instance starting while a render runs: profiles are seconds
/// old during a render, crashed leftovers are not.
pub fn sweep_leftover_edge_profiles(dir: &std::path::Path, min_age: std::time::Duration) {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        // Cache dir does not exist yet (first run) — nothing to sweep.
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if !name.starts_with("edge-profile-") {
            continue;
        }
        // Unknown age → leave it alone; only clearly stale profiles go.
        let Some(age) = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.elapsed().ok())
        else {
            continue;
        };
        if age < min_age {
            continue;
        }
        match std::fs::remove_dir_all(entry.path()) {
            Ok(()) => tracing::info!(
                dir = name,
                age_secs = age.as_secs(),
                "removed an Edge profile left behind by an earlier run"
            ),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => {
                tracing::warn!(dir = name, error = %e, "could not remove a leftover Edge profile")
            }
        }
    }
}

/// Decode a screenshot PNG and threshold it to 1-bit dots.
///
/// `EXPAND | STRIP_16` normalises every colour type to 8 bits. Text is
/// anti-aliased grey, so a midpoint threshold turns dark pixels into dots.
/// Rows are walked via `line_size`, so any row padding is respected.
///
/// Pure PNG logic, so `cfg(any(windows, test))`: the Windows print path
/// calls it, and the unit tests exercise it on every platform.
#[cfg(any(windows, test))]
fn png_to_raster(path: &std::path::Path) -> Result<crate::render::raster::RasterImage> {
    use crate::render::raster::RasterImage;

    let file = std::fs::File::open(path)?;
    let mut decoder = png::Decoder::new(std::io::BufReader::new(file));
    decoder.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
    let mut reader = decoder.read_info()?;
    let mut buf = vec![0u8; reader.output_buffer_size()];
    let info = reader.next_frame(&mut buf)?;

    let width = info.width as usize;
    let height = info.height as usize;
    let line = info.line_size;

    let mut gray = vec![0u8; width * height];
    for y in 0..height {
        let row = &buf[y * line..];
        for x in 0..width {
            let lum = match info.color_type {
                png::ColorType::Grayscale => row[x],
                png::ColorType::GrayscaleAlpha => row[x * 2],
                png::ColorType::Rgb | png::ColorType::Rgba => {
                    let step = if info.color_type == png::ColorType::Rgba {
                        4
                    } else {
                        3
                    };
                    let (r, g, b) = (row[x * step], row[x * step + 1], row[x * step + 2]);
                    (0.299 * f64::from(r) + 0.587 * f64::from(g) + 0.114 * f64::from(b)).round()
                        as u8
                }
                other => return Err(anyhow!("unexpected PNG colour type {other:?}")),
            };
            gray[y * width + x] = lum;
        }
    }

    let mut raster = RasterImage::new(width, height);
    raster.threshold(&gray, width, height, 128);
    Ok(raster)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Encode pixel data as a PNG file, as Edge's `--screenshot` would.
    fn write_png(
        dir: &std::path::Path,
        color: png::ColorType,
        width: u32,
        height: u32,
        data: &[u8],
    ) -> std::path::PathBuf {
        let path = dir.join(format!("shot-{}.png", uuid::Uuid::new_v4()));
        let mut encoder = png::Encoder::new(std::fs::File::create(&path).unwrap(), width, height);
        encoder.set_color(color);
        encoder.set_depth(png::BitDepth::Eight);
        encoder
            .write_header()
            .unwrap()
            .write_image_data(data)
            .unwrap();
        path
    }

    /// Startup sweep: only `edge-profile-*` dirs go, and only when they are
    /// old enough — a fresh one may belong to a render in flight (e.g. a
    /// second app instance starting mid-print).
    #[test]
    fn the_startup_sweep_only_takes_stale_edge_profiles() {
        let dir = std::env::temp_dir().join(format!("pn-sweep-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("edge-profile-crashed")).unwrap();
        std::fs::write(dir.join("edge-profile-crashed").join("junk.pem"), b"cert").unwrap();
        std::fs::create_dir_all(dir.join("edge-profile-live")).unwrap();
        // Content is irrelevant to the sweep; deliberately not a PDF header
        // magic: `print_correctness`'s P5 tripwire greps this whole file and
        // only placeholder-PDF bytes may not appear in it.
        std::fs::write(dir.join("last-render.pdf"), b"render artifact").unwrap();

        // Younger than an hour: may belong to a running render — keep both.
        sweep_leftover_edge_profiles(&dir, std::time::Duration::from_secs(60 * 60));
        assert!(dir.join("edge-profile-crashed").exists());
        assert!(dir.join("edge-profile-live").exists());

        // No age limit: the stale profile goes — its junk `.pem` with it —
        // and everything that is not an Edge profile stays put.
        sweep_leftover_edge_profiles(&dir, std::time::Duration::ZERO);
        assert!(!dir.join("edge-profile-crashed").exists());
        assert!(!dir.join("edge-profile-live").exists());
        assert!(dir.join("last-render.pdf").exists());

        // A cache dir that does not exist yet (first run) is a no-op.
        sweep_leftover_edge_profiles(&dir.join("missing"), std::time::Duration::ZERO);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// P4: the decode path a Windows print takes — a screenshot PNG becomes
    /// exactly the thresholded dots, at the screenshot's own size.
    #[test]
    fn an_rgb_screenshot_becomes_thresholded_dots() {
        let dir = std::env::temp_dir();
        // 2×1: black then white — the two ends of the midpoint cut.
        let path = write_png(&dir, png::ColorType::Rgb, 2, 1, &[0, 0, 0, 255, 255, 255]);
        let raster = png_to_raster(&path).expect("decode");
        let _ = std::fs::remove_file(&path);

        assert_eq!((raster.width, raster.height), (2, 1));
        assert!(raster.get_bit(0, 0), "black must become a dot");
        assert!(!raster.get_bit(1, 0), "white must stay blank");
    }

    /// Every colour type Edge might hand back (post-`EXPAND`) is handled,
    /// including the alpha variants, whose alpha must not darken anything.
    #[test]
    fn grayscale_and_alpha_screenshots_decode() {
        let dir = std::env::temp_dir();

        // Grayscale: 64 → dot, 200 → no dot.
        let path = write_png(&dir, png::ColorType::Grayscale, 2, 1, &[64, 200]);
        let raster = png_to_raster(&path).expect("decode gray");
        let _ = std::fs::remove_file(&path);
        assert!(raster.get_bit(0, 0) && !raster.get_bit(1, 0));

        // GrayscaleAlpha: the opaque/d transparent second pixels decide by
        // luminance only — full transparency must not flip the other way.
        let path = write_png(
            &dir,
            png::ColorType::GrayscaleAlpha,
            2,
            1,
            &[64, 255, 200, 0],
        );
        let raster = png_to_raster(&path).expect("decode gray+alpha");
        let _ = std::fs::remove_file(&path);
        assert!(raster.get_bit(0, 0) && !raster.get_bit(1, 0));

        // RGBA: red-ish text is *dark* under the luminance weights
        // (0.299·200 + 0.587·50 + 0.114·50 ≈ 95 < 128), so it prints.
        let path = write_png(
            &dir,
            png::ColorType::Rgba,
            2,
            1,
            &[200, 50, 50, 255, 255, 255, 255, 0],
        );
        let raster = png_to_raster(&path).expect("decode rgba");
        let _ = std::fs::remove_file(&path);
        assert!(
            raster.get_bit(0, 0),
            "coloured text must threshold to a dot"
        );
        assert!(!raster.get_bit(1, 0));
    }
}
