/// ESC/POS command encoder for thermal receipt printers
pub struct EscPosEncoder;

impl EscPosEncoder {
    /// Initialize printer
    pub fn init() -> Vec<u8> {
        vec![0x1B, 0x40]
    }

    /// Set text alignment (0=left, 1=center, 2=right)
    pub fn set_alignment(align: u8) -> Vec<u8> {
        vec![0x1B, 0x61, align]
    }

    /// Set text size (1x1 to 8x8)
    pub fn set_text_size(width: u8, height: u8) -> Vec<u8> {
        let combined = (height << 4) | width;
        vec![0x1D, 0x21, combined]
    }

    /// Bold on/off
    pub fn set_bold(on: bool) -> Vec<u8> {
        vec![0x1B, 0x45, if on { 0x01 } else { 0x00 }]
    }

    /// Print text with newline
    pub fn text(text: &str) -> Vec<u8> {
        let mut bytes = text.as_bytes().to_vec();
        bytes.push(0x0A);
        bytes
    }

    /// Print raster bitmap (GS v 0)
    pub fn print_raster(image: &crate::render::raster::RasterImage) -> Vec<u8> {
        let width_bytes = image.width.div_ceil(8);
        let height = image.height;

        let mut cmd = vec![
            0x1D,
            0x76,
            0x30,
            0x00, // GS v 0, mode: normal
            (width_bytes & 0xFF) as u8,
            (width_bytes >> 8) as u8,
            (height & 0xFF) as u8,
            ((height >> 8) & 0xFF) as u8,
        ];
        cmd.extend_from_slice(&image.dots);
        cmd
    }

    /// Feed lines
    pub fn feed(lines: u8) -> Vec<u8> {
        vec![0x1B, 0x64, lines]
    }

    /// Cut paper (full or partial)
    pub fn cut(partial: bool) -> Vec<u8> {
        if partial {
            vec![0x1D, 0x56, 0x01]
        } else {
            vec![0x1D, 0x56, 0x00]
        }
    }

    /// Open cash drawer (kick)
    pub fn open_drawer() -> Vec<u8> {
        vec![0x1B, 0x70, 0x00, 0x32, 0x32]
    }

    /// Set codepage for international characters
    pub fn set_codepage(codepage: u8) -> Vec<u8> {
        vec![0x1B, 0x74, codepage]
    }

    /// Build a complete receipt from a template
    pub fn build_receipt(
        image: &crate::render::raster::RasterImage,
        cut_after: bool,
        open_drawer: bool,
    ) -> Vec<u8> {
        let mut receipt = Vec::new();
        receipt.extend_from_slice(&Self::init());
        receipt.extend_from_slice(&Self::print_raster(image));
        receipt.extend_from_slice(&Self::feed(3));
        if cut_after {
            receipt.extend_from_slice(&Self::cut(false));
        }
        if open_drawer {
            receipt.extend_from_slice(&Self::open_drawer());
        }
        receipt
    }
}
