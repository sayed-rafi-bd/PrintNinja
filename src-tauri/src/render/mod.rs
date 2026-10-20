use anyhow::{anyhow, Result};
use std::path::PathBuf;

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
        use std::os::windows::process::CommandExt;
        use std::process::Command;
        use windows::Win32::System::Threading::CREATE_NO_WINDOW;

        // Unique per job: a shared `output.pdf` could be stale (Edge exits 0
        // without writing when it hands off to a running instance) or be
        // overwritten by a concurrent job.
        let job = uuid::Uuid::new_v4();
        let pdf_path = self.cache_dir.join(format!("output-{job}.pdf"));
        // A throwaway profile makes headless Edge start its own process
        // instead of delegating to the user's already-open Edge window.
        let profile_dir = self.cache_dir.join(format!("edge-profile-{job}"));

        let edge_paths = [
            r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
            r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
        ];

        let edge_path = edge_paths
            .iter()
            .find(|p| std::path::Path::new(p).exists())
            .ok_or_else(|| {
                anyhow!(
                    "Microsoft Edge not found (looked in {}) — PDF rendering needs \
                     Edge/WebView2; the job cannot print without it",
                    edge_paths.join(", ")
                )
            })?;

        let html_url = format!("file:///{}", html_path.to_string_lossy().replace('\\', "/"));
        let output = Command::new(edge_path)
            .args(&[
                "--headless",
                "--disable-gpu",
                "--no-first-run",
                "--no-default-browser-check",
                "--print-to-pdf-no-header",
                "--no-pdf-header-footer",
                &format!("--user-data-dir={}", profile_dir.to_string_lossy()),
                &format!("--print-to-pdf={}", pdf_path.to_string_lossy()),
                &html_url,
            ])
            .creation_flags(CREATE_NO_WINDOW.0)
            .output()?;

        let _ = std::fs::remove_dir_all(&profile_dir);

        if output.status.success() && pdf_path.exists() {
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
                "rendered PDF with Edge"
            );
            return bytes.map_err(Into::into);
        }

        // Edge failed or wrote nothing. Report it; do not fall back to a
        // placeholder (P5).
        let stderr = String::from_utf8_lossy(&output.stderr);
        let _ = std::fs::remove_file(&pdf_path);
        Err(anyhow!(
            "Edge print-to-pdf did not produce a PDF (status {}, stderr: {})",
            output.status,
            stderr.trim()
        ))
    }
}
