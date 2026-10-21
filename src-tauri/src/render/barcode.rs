//! Inline-SVG barcodes and QR codes for the `{{barcode}}` / `{{qrcode}}`
//! template helpers.
//!
//! The Designer preview renders with handlebars.js and printing renders here,
//! so both sides must register the same helpers (REFACTORING.md decision #13).
//! The symbology ids are the ones in `src/lib/utils/barcode.ts`
//! (`PRINT_SYMBOLOGIES`); anything else renders nothing rather than failing the
//! whole print job.
//!
//! The SVG is drawn here from the encoder's module pattern instead of using a
//! crate's SVG generator, so the output has no external dependency, scales to
//! a physical width, and escapes the human-readable text.

use barcoders::sym::{
    codabar::Codabar, code128::Code128, code39::Code39, code93::Code93, ean13::EAN13, ean8::EAN8,
    tf::TF,
};
use qrcode::{Color, EcLevel, QrCode};

/// Default printed width of a linear barcode, in millimetres.
pub const DEFAULT_BARCODE_WIDTH_MM: f64 = 40.0;
/// Default printed size of a QR code, in millimetres.
pub const DEFAULT_QR_SIZE_MM: f64 = 25.0;

const MIN_MM: f64 = 5.0;
const MAX_MM: f64 = 200.0;
/// Quiet zone on each side of a linear barcode, in modules.
const QUIET_MODULES: usize = 10;
/// Quiet zone around a QR code, in modules (the spec asks for 4).
const QR_QUIET_MODULES: usize = 4;
/// Height of the human-readable text line, in modules.
const TEXT_HEIGHT: f64 = 9.0;

/// The symbology ids a template may pass to `{{barcode}}`.
pub const SYMBOLOGIES: &[&str] = &[
    "code128", "code39", "code93", "ean13", "ean8", "upca", "itf", "codabar",
];

/// Render a linear barcode as a `<div class="barcode">` holding an inline SVG.
///
/// Returns `None` for an unknown symbology, an empty value, or a value the
/// symbology cannot encode, so the caller can print an empty spot.
pub fn barcode_html(kind: &str, value: &str, width_mm: f64, show_text: bool) -> Option<String> {
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    let modules = encode_linear(kind, value)?;
    let svg = linear_svg(&modules, value, clamp_mm(width_mm), show_text);
    Some(wrap(&svg))
}

/// Render a QR code as a `<div class="barcode">` holding an inline SVG.
pub fn qr_html(value: &str, size_mm: f64) -> Option<String> {
    if value.trim().is_empty() {
        return None;
    }
    let code = QrCode::with_error_correction_level(value.as_bytes(), EcLevel::M).ok()?;
    let side = code.width();
    let colors = code.to_colors();
    let total = side + 2 * QR_QUIET_MODULES;

    // One rectangle per horizontal run of dark modules keeps the SVG small.
    let mut path = String::new();
    for y in 0..side {
        let mut x = 0;
        while x < side {
            if colors[y * side + x] == Color::Dark {
                let start = x;
                while x < side && colors[y * side + x] == Color::Dark {
                    x += 1;
                }
                path.push_str(&format!(
                    "M{},{}h{}v1h-{}z",
                    start + QR_QUIET_MODULES,
                    y + QR_QUIET_MODULES,
                    x - start,
                    x - start
                ));
            } else {
                x += 1;
            }
        }
    }

    let size = clamp_mm(size_mm);
    let svg = format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 {total} {total}\" \
         width=\"{size}mm\" height=\"{size}mm\" shape-rendering=\"crispEdges\" role=\"img\" \
         aria-label=\"QR code\"><rect width=\"{total}\" height=\"{total}\" fill=\"#fff\"/>\
         <path d=\"{path}\" fill=\"#000\"/></svg>"
    );
    Some(wrap(&svg))
}

fn wrap(svg: &str) -> String {
    format!("<div class=\"barcode\">{svg}</div>")
}

fn clamp_mm(mm: f64) -> f64 {
    if mm.is_finite() {
        mm.clamp(MIN_MM, MAX_MM)
    } else {
        DEFAULT_BARCODE_WIDTH_MM
    }
}

/// Encode `value` as the dark/light module pattern of a linear symbology.
fn encode_linear(kind: &str, value: &str) -> Option<Vec<u8>> {
    let all_digits = value.chars().all(|c| c.is_ascii_digit());
    match kind {
        // Code 128 needs a character-set prefix; Ɓ selects set B (ASCII 32-127).
        "code128" => {
            if !value.is_ascii() {
                return None;
            }
            Code128::new(format!("\u{0181}{value}"))
                .ok()
                .map(|b| b.encode())
        }
        "code39" => Code39::new(value.to_uppercase()).ok().map(|b| b.encode()),
        "code93" => Code93::new(value.to_uppercase()).ok().map(|b| b.encode()),
        // The encoders accept a missing check digit and add it; templates must
        // supply the full number, as the Designer's validation requires.
        "ean13" if all_digits && value.len() == 13 => EAN13::new(value).ok().map(|b| b.encode()),
        "ean8" if all_digits && value.len() == 8 => EAN8::new(value).ok().map(|b| b.encode()),
        // UPC-A is EAN-13 with a leading zero.
        "upca" if all_digits && value.len() == 12 => {
            EAN13::new(format!("0{value}")).ok().map(|b| b.encode())
        }
        "itf" if all_digits && value.len().is_multiple_of(2) => {
            TF::interleaved(value).ok().map(|b| b.encode())
        }
        "codabar" => Codabar::new(value.to_uppercase()).ok().map(|b| b.encode()),
        _ => None,
    }
}

fn linear_svg(modules: &[u8], value: &str, width_mm: f64, show_text: bool) -> String {
    let total = modules.len() + 2 * QUIET_MODULES;
    let bar_height = ((total as f64) * 0.3).clamp(18.0, 60.0);
    let height = if show_text {
        bar_height + TEXT_HEIGHT + 1.0
    } else {
        bar_height
    };

    let mut path = String::new();
    let mut i = 0;
    while i < modules.len() {
        if modules[i] == 1 {
            let start = i;
            while i < modules.len() && modules[i] == 1 {
                i += 1;
            }
            path.push_str(&format!(
                "M{},0h{}v{}h-{}z",
                start + QUIET_MODULES,
                i - start,
                bar_height,
                i - start
            ));
        } else {
            i += 1;
        }
    }

    let text = if show_text {
        // Shrink very long values to the printable width instead of overflowing.
        let available = (total - 2 * QUIET_MODULES) as f64;
        let estimated = value.chars().count() as f64 * TEXT_HEIGHT * 0.6;
        let fit = if estimated > available {
            format!(" textLength=\"{available}\" lengthAdjust=\"spacingAndGlyphs\"")
        } else {
            String::new()
        };
        format!(
            "<text x=\"{}\" y=\"{}\" font-family=\"monospace\" font-size=\"{}\" \
             text-anchor=\"middle\"{fit}>{}</text>",
            total as f64 / 2.0,
            bar_height + TEXT_HEIGHT,
            TEXT_HEIGHT,
            escape_xml(value)
        )
    } else {
        String::new()
    };

    format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 {total} {height}\" \
         width=\"{width_mm}mm\" shape-rendering=\"crispEdges\" role=\"img\" \
         aria-label=\"barcode {label}\"><rect width=\"{total}\" height=\"{height}\" fill=\"#fff\"/>\
         <path d=\"{path}\" fill=\"#000\"/>{text}</svg>",
        label = escape_xml(value)
    )
}

fn escape_xml(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn code128_renders_an_svg_with_the_value() {
        let html = barcode_html("code128", "ORD-1042", 40.0, true).unwrap();
        assert!(html.starts_with("<div class=\"barcode\"><svg"));
        assert!(html.contains("width=\"40mm\""));
        assert!(html.contains(">ORD-1042</text>"));
    }

    #[test]
    fn text_can_be_turned_off() {
        let html = barcode_html("code128", "ORD-1042", 40.0, false).unwrap();
        assert!(!html.contains("<text"));
    }

    #[test]
    fn value_is_escaped_in_the_label_and_text() {
        let html = barcode_html("code128", "A<B>&\"", 40.0, true).unwrap();
        assert!(!html.contains("<B>"));
        assert!(html.contains("A&lt;B&gt;&amp;&quot;"));
    }

    #[test]
    fn empty_or_unknown_renders_nothing() {
        assert!(barcode_html("code128", "  ", 40.0, true).is_none());
        assert!(barcode_html("nope", "123", 40.0, true).is_none());
        // Data Matrix is preview-only; it is not in SYMBOLOGIES.
        assert!(barcode_html("datamatrix", "123", 40.0, true).is_none());
    }

    #[test]
    fn digit_symbologies_validate_length_and_check_digit() {
        assert!(barcode_html("ean13", "5901234123457", 40.0, true).is_some());
        assert!(barcode_html("ean13", "5901234123458", 40.0, true).is_none());
        assert!(barcode_html("ean13", "590123412345", 40.0, true).is_none());
        assert!(barcode_html("ean8", "55123457", 40.0, true).is_some());
        assert!(barcode_html("upca", "036000291452", 40.0, true).is_some());
        assert!(barcode_html("upca", "03600029145", 40.0, true).is_none());
        assert!(barcode_html("itf", "1234567890", 40.0, true).is_some());
        assert!(barcode_html("itf", "123456789", 40.0, true).is_none());
    }

    #[test]
    fn every_listed_symbology_encodes_a_sample() {
        let samples = [
            ("code128", "HELLO123"),
            ("code39", "HELLO-123"),
            ("code93", "HELLO123"),
            ("ean13", "5901234123457"),
            ("ean8", "55123457"),
            ("upca", "036000291452"),
            ("itf", "1234567890"),
            ("codabar", "A12345B"),
        ];
        for kind in SYMBOLOGIES {
            let (_, value) = samples.iter().find(|(k, _)| k == kind).unwrap();
            assert!(
                barcode_html(kind, value, 40.0, true).is_some(),
                "{kind} failed to encode {value}"
            );
        }
    }

    #[test]
    fn width_is_clamped() {
        let html = barcode_html("code128", "X", 9999.0, false).unwrap();
        assert!(html.contains("width=\"200mm\""));
        let html = barcode_html("code128", "X", 0.0, false).unwrap();
        assert!(html.contains("width=\"5mm\""));
    }

    #[test]
    fn qr_renders_a_square_svg() {
        let html = qr_html("https://example.com/o/1042", 25.0).unwrap();
        assert!(html.contains("width=\"25mm\" height=\"25mm\""));
        assert!(html.contains("<path d=\"M"));
        assert!(qr_html("", 25.0).is_none());
    }
}
