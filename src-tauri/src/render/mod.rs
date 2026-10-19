use anyhow::Result;
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

    pub async fn html_to_pdf(
        &self,
        html: &str,
        page_width_mm: f64,
        page_height_mm: f64,
        orientation: &str,
    ) -> Result<Vec<u8>> {
        let html_path = self.cache_dir.join("render.html");
        tokio::fs::write(&html_path, html).await?;

        #[cfg(windows)]
        {
            self.webview2_print_to_pdf(&html_path, page_width_mm, page_height_mm, orientation)
                .await
        }

        #[cfg(not(windows))]
        {
            self.fallback_pdf(page_width_mm, page_height_mm, orientation)
        }
    }

    #[cfg(windows)]
    async fn webview2_print_to_pdf(
        &self,
        html_path: &PathBuf,
        page_width_mm: f64,
        page_height_mm: f64,
        orientation: &str,
    ) -> Result<Vec<u8>> {
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
        let width_in = page_width_mm / 25.4;
        let height_in = page_height_mm / 25.4;
        let (w, h) = if orientation == "landscape" {
            (height_in, width_in)
        } else {
            (width_in, height_in)
        };

        let edge_paths = [
            r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
            r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
        ];

        let edge_path = edge_paths.iter().find(|p| std::path::Path::new(p).exists());

        if let Some(edge) = edge_path {
            let html_url = format!("file:///{}", html_path.to_string_lossy().replace('\\', "/"));
            let output = Command::new(edge)
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
                let _ = std::fs::remove_file(&pdf_path);
                tracing::info!(html = %html_url, bytes = bytes.as_ref().map_or(0, |b| b.len()), "rendered PDF with Edge");
                return bytes.map_err(Into::into);
            }

            tracing::warn!(
                status = ?output.status,
                pdf_written = pdf_path.exists(),
                stderr = %String::from_utf8_lossy(&output.stderr),
                "Edge print-to-pdf did not produce a PDF"
            );
        }

        tracing::warn!("Edge print-to-pdf failed or msedge.exe not found; using placeholder PDF");
        self.fallback_pdf(w * 25.4, h * 25.4, orientation)
    }

    fn fallback_pdf(
        &self,
        page_width_mm: f64,
        page_height_mm: f64,
        orientation: &str,
    ) -> Result<Vec<u8>> {
        let width_pt = page_width_mm * 2.83465;
        let height_pt = page_height_mm * 2.83465;
        let (final_width, final_height) = if orientation == "landscape" {
            (height_pt, width_pt)
        } else {
            (width_pt, height_pt)
        };

        let pdf = format!(
            "%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {:.2} {:.2}] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n4 0 obj\n<< /Length 44 >>\nstream\nBT /F1 12 Tf 100 700 Td (PrintNinja) Tj ET\nendstream\nendobj\n5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\nxref\n0 6\n0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \n0000000115 00000 n \n0000000266 00000 n \n0000000360 00000 n \ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n437\n%%EOF",
            final_width, final_height
        );
        Ok(pdf.into_bytes())
    }
}
