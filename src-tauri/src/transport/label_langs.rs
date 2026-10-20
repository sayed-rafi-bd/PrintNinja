//! Label printer command language encoders

/// TSPL/TSPL2 encoder for thermal label printers
pub mod tspl {
    use crate::render::raster::RasterImage;

    pub fn init(dpi: u32) -> String {
        let _ = dpi;
        // SIZE, GAP, DIRECTION commands
        String::new()
    }

    /// Canonical TSPL2: setup commands, then `BITMAP x,y,width-bytes,
    ///height,mode` followed by the **raw packed bytes** (not their hex —
    /// TSPL's BITMAP takes binary data), then `PRINT`.
    ///
    /// Commands are `\r\n`-terminated like the real dialect. The image's own
    /// row packing (`width.div_ceil(8)` bytes per row) is what BITMAP's
    /// width-bytes argument counts.
    pub fn print_bitmap(
        image: &RasterImage,
        label_w_mm: f64,
        label_h_mm: f64,
        gap_mm: f64,
        _dpi: u32,
    ) -> Vec<u8> {
        let bytes_per_row = image.width.div_ceil(8);

        let mut cmd = Vec::new();
        cmd.extend_from_slice(format!("SIZE {} mm,{} mm\r\n", label_w_mm, label_h_mm).as_bytes());
        cmd.extend_from_slice(format!("GAP {} mm,0 mm\r\n", gap_mm).as_bytes());
        cmd.extend_from_slice(b"DIRECTION 1\r\n");
        cmd.extend_from_slice(b"REFERENCE 0,0\r\n");
        cmd.extend_from_slice(b"CLS\r\n");
        cmd.extend_from_slice(
            format!("BITMAP 0,0,{},{},0\r\n", bytes_per_row, image.height).as_bytes(),
        );
        cmd.extend_from_slice(&image.dots);
        cmd.extend_from_slice(b"\r\nPRINT 1\r\n");
        cmd
    }
}

/// ZPL (Zebra) encoder for thermal label printers
pub mod zpl {
    use crate::render::raster::RasterImage;

    pub fn init() -> String {
        "^XA\n".to_string() // Start format
    }

    pub fn print_bitmap(
        image: &RasterImage,
        _label_w_mm: f64,
        _label_h_mm: f64,
        _dpi: u32,
    ) -> String {
        let bytes_per_row = image.width.div_ceil(8);
        let total_bytes = bytes_per_row * image.height;

        let mut cmd = String::new();
        cmd.push_str("^XA\n"); // Start format
        cmd.push_str("^MMT\n"); // Media tracking
        cmd.push_str("^PR6\n"); // Print rate
                                // Graphic field command
        cmd.push_str(&format!(
            "^FO0,0^GFA,{},{}",
            total_bytes,
            bytes_per_row * image.height
        ));
        cmd.push_str(&format!(",{},", bytes_per_row));

        for byte in &image.dots {
            cmd.push_str(&format!("{:02X}", byte));
        }

        cmd.push_str("^FS\n");
        cmd.push_str("^XZ\n"); // End format
        cmd
    }
}

/// CPCL (Comtec) encoder for thermal label printers
pub mod cpcl {
    use crate::render::raster::RasterImage;

    pub fn init() -> String {
        "! 0 200 200 210 1\r\n".to_string()
    }

    pub fn print_bitmap(image: &RasterImage, label_w_mm: f64, dpi: u32) -> String {
        let dots_per_mm = dpi as f64 / 25.4;
        let width_dots = (label_w_mm * dots_per_mm) as usize;
        let bytes_per_row = width_dots.div_ceil(8);

        let mut cmd = String::new();
        cmd.push_str(&format!("! 0 200 200 {} 1\r\n", image.height));
        cmd.push_str(&format!("CG {} {} 0 0\r\n", width_dots, bytes_per_row));

        for row in image.dots.chunks(bytes_per_row) {
            for byte in row {
                cmd.push_str(&format!("{:02X}", byte));
            }
            cmd.push_str("\r\n");
        }

        cmd.push_str("PRINT\r\n");
        cmd
    }
}

/// Printer connection and data sending
pub struct LabelPrinterTransport {
    pub language: String,
    pub dpi: u32,
    pub label_w_mm: f64,
    pub label_h_mm: f64,
    pub gap_mm: f64,
    pub address: String,
    pub port: u16,
}

impl LabelPrinterTransport {
    pub fn encode(&self, image: &crate::render::raster::RasterImage) -> Vec<u8> {
        match self.language.as_str() {
            "tspl" => tspl::print_bitmap(
                image,
                self.label_w_mm,
                self.label_h_mm,
                self.gap_mm,
                self.dpi,
            ),
            "zpl" => {
                zpl::print_bitmap(image, self.label_w_mm, self.label_h_mm, self.dpi).into_bytes()
            }
            "cpcl" => cpcl::print_bitmap(image, self.label_w_mm, self.dpi).into_bytes(),
            _ => {
                // Fallback: raw ESC/POS
                let mut data = Vec::new();
                data.extend_from_slice(&crate::transport::escpos::EscPosEncoder::init());
                data.extend_from_slice(&crate::transport::escpos::EscPosEncoder::print_raster(
                    image,
                ));
                data
            }
        }
    }
}
