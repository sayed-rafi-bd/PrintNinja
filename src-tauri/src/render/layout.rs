//! Design → paper layout.
//!
//! A template is authored on a fixed design page (the Designer canvas, e.g.
//! 102 × 102 mm). Printing never re-lays that page out at another size: each
//! record is rendered once, at exactly the design size, inside its own
//! frame, and the *frame* is then scaled and positioned on the physical sheet
//! according to the print settings (paper size, orientation, margins, fit
//! mode). The template's own layout, line breaks and aspect ratio therefore
//! never change; only where the finished page lands on the paper does.
//!
//! [`compute`] is the single source of truth for that placement. The Print
//! page preview (`src/lib/render/printLayout.ts`) implements the same rules
//! and both are pinned to `tests/fixtures/layout_cases.json`, so what the
//! preview shows is what [`sheets_document`] sends to the PDF / raster
//! renderer.
//!
//! All lengths are millimetres.

/// Separator the print pipeline puts between rendered records. Stored job
/// HTML uses it too, so a replayed job splits back into the same pages.
pub const PAGE_SEPARATOR: &str = "\n<div style=\"break-before:page\"></div>\n";

/// A design taller than this many sheets is cut off instead of producing an
/// unbounded document (mirrors `MAX_SHEETS_PER_DESIGN` in printLayout.ts).
pub const MAX_SHEETS_PER_DESIGN: usize = 200;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Margins {
    pub top: f64,
    pub right: f64,
    pub bottom: f64,
    pub left: f64,
}

/// Where one design page sits on one sheet, relative to the content box's
/// top-left corner (the content box is the paper minus the margins).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Placement {
    pub offset_x: f64,
    pub offset_y: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PrintLayout {
    /// Printable area on the sheet (paper minus margins), in sheet mm.
    pub content_x: f64,
    pub content_y: f64,
    pub content_w: f64,
    pub content_h: f64,
    /// Design → paper scale. Uniform on both axes: the aspect ratio is kept.
    pub scale: f64,
    /// The design's size on the paper after scaling.
    pub draw_w: f64,
    pub draw_h: f64,
    /// One entry per sheet a single design page occupies.
    pub placements: Vec<Placement>,
}

/// How a fit mode maps the design onto the content box.
///
/// * `actual`    – 1:1, top-left; a taller design continues on the next sheet.
/// * `fit-width` – scaled to the content width, top-left; continues on the
///   next sheet when it is taller than the content box (the default).
/// * `fit-page`  – the largest scale at which the whole design fits; centred.
/// * `fill`      – the smallest scale that covers the content box; centred and
///   cropped to the content box.
/// * `shrink`    – like `fit-page` but never enlarges; centred.
fn scale_for(fit_mode: &str, dw: f64, dh: f64, pcw: f64, pch: f64) -> f64 {
    match fit_mode {
        "actual" => 1.0,
        "fit-page" => (pcw / dw).min(pch / dh),
        "fill" => (pcw / dw).max(pch / dh),
        "shrink" => (pcw / dw).min(pch / dh).min(1.0),
        _ => pcw / dw, // fit-width (default)
    }
}

/// Place a `design_w` × `design_h` page on a `paper_w` × `paper_h` sheet.
pub fn compute(
    fit_mode: &str,
    design_w: f64,
    design_h: f64,
    paper_w: f64,
    paper_h: f64,
    margins: Margins,
) -> PrintLayout {
    let dw = design_w.max(1.0);
    let dh = design_h.max(1.0);
    let pcw = (paper_w - margins.left - margins.right).max(1.0);
    let pch = (paper_h - margins.top - margins.bottom).max(1.0);

    let scale = scale_for(fit_mode, dw, dh, pcw, pch);
    let draw_w = dw * scale;
    let draw_h = dh * scale;

    let placements = match fit_mode {
        "fit-page" | "fill" | "shrink" => vec![Placement {
            offset_x: (pcw - draw_w) / 2.0,
            offset_y: (pch - draw_h) / 2.0,
        }],
        _ => {
            // Epsilon: a design exactly one content box tall is one sheet,
            // not two, whatever the float rounding says.
            let sheets = (((draw_h - 1e-6) / pch).ceil() as usize).clamp(1, MAX_SHEETS_PER_DESIGN);
            (0..sheets)
                .map(|k| Placement {
                    offset_x: 0.0,
                    offset_y: -(k as f64) * pch,
                })
                .collect()
        }
    };

    PrintLayout {
        content_x: margins.left,
        content_y: margins.top,
        content_w: pcw,
        content_h: pch,
        scale,
        draw_w,
        draw_h,
        placements,
    }
}

/// Four decimals, no trailing noise (`1.5` not `1.5000`). Matches
/// `fmt` in printLayout.ts.
fn fmt(v: f64) -> String {
    let s = format!("{v:.4}");
    let s = s.trim_end_matches('0').trim_end_matches('.');
    if s.is_empty() || s == "-" || s == "-0" {
        "0".to_string()
    } else {
        s.to_string()
    }
}

/// Escape a document for use inside a double-quoted `srcdoc` attribute.
pub fn escape_srcdoc(doc: &str) -> String {
    doc.replace('&', "&amp;").replace('"', "&quot;")
}

/// Build the printable document: one `.pn-sheet` per sheet, each exactly the
/// paper size, holding the design pages as scaled `<iframe>`s.
///
/// `design_docs` are complete HTML documents, one per record, each laid out
/// at `design_w` × `design_h` (the iframe is that size before scaling, like
/// the Designer canvas). `@page` margin is 0: the margins are applied by the
/// content box, so the preview and the printed page cannot disagree about
/// what the browser does with `@page` margins.
#[allow(clippy::too_many_arguments)]
pub fn sheets_document(
    design_docs: &[String],
    fit_mode: &str,
    design_w: f64,
    design_h: f64,
    paper_w: f64,
    paper_h: f64,
    margins: Margins,
    grayscale: bool,
) -> String {
    let layout = compute(fit_mode, design_w, design_h, paper_w, paper_h, margins);
    let gray = if grayscale {
        "html{filter:grayscale(1) !important;}\n"
    } else {
        ""
    };

    let mut out = String::new();
    out.push_str(&format!(
        "<!DOCTYPE html>\n<html>\n<head>\n<meta charset=\"UTF-8\">\n<style>\n\
@page{{size:{pw}mm {ph}mm;margin:0}}\n\
*{{box-sizing:border-box;-webkit-print-color-adjust:exact;print-color-adjust:exact}}\n\
html,body{{margin:0;padding:0;background:#fff}}\n\
.pn-sheet{{position:relative;width:{pw}mm;height:{ph}mm;overflow:hidden;break-inside:avoid;page-break-inside:avoid}}\n\
.pn-sheet+.pn-sheet{{break-before:page;page-break-before:always}}\n\
.pn-content{{position:absolute;overflow:hidden}}\n\
.pn-design{{position:absolute;border:0;margin:0;padding:0;transform-origin:0 0}}\n\
{gray}</style>\n</head>\n<body>\n",
        pw = fmt(paper_w),
        ph = fmt(paper_h),
    ));

    for doc in design_docs {
        let srcdoc = escape_srcdoc(doc);
        for p in &layout.placements {
            out.push_str(&format!(
                "<div class=\"pn-sheet\"><div class=\"pn-content\" style=\"left:{cx}mm;top:{cy}mm;width:{cw}mm;height:{ch}mm\">\
<iframe class=\"pn-design\" scrolling=\"no\" style=\"left:{ox}mm;top:{oy}mm;width:{dw}mm;height:{dh}mm;transform:scale({s})\" srcdoc=\"{srcdoc}\"></iframe>\
</div></div>\n",
                cx = fmt(layout.content_x),
                cy = fmt(layout.content_y),
                cw = fmt(layout.content_w),
                ch = fmt(layout.content_h),
                ox = fmt(p.offset_x),
                oy = fmt(p.offset_y),
                dw = fmt(design_w),
                dh = fmt(design_h),
                s = fmt(layout.scale),
            ));
        }
    }
    out.push_str("</body>\n</html>\n");
    out
}

/// Fit a finished sheets document into a raster viewport of `w_px` dots
/// across (1 CSS px = 1 printer dot). The sheet is `paper_w` mm wide, i.e.
/// `paper_w * 96 / 25.4` CSS px, so scaling it by `w_px / that` makes one
/// mm of design one mm of label at the printer's resolution instead of
/// leaving a small sheet in the corner of a large viewport.
pub fn fit_to_dots(sheets_html: &str, w_px: usize, paper_w: f64) -> String {
    let sheet_px = paper_w * 96.0 / 25.4;
    let k = if sheet_px > 0.0 {
        w_px as f64 / sheet_px
    } else {
        1.0
    };
    if (k - 1.0).abs() < 1e-9 {
        return sheets_html.to_string();
    }
    let rule = format!(
        "<style>html{{overflow:hidden}}body{{width:{sheet_px:.4}px;transform:scale({k:.6});transform-origin:0 0}}</style>"
    );
    match sheets_html.find("</head>") {
        Some(idx) => format!("{}{}{}", &sheets_html[..idx], rule, &sheets_html[idx..]),
        None => format!("{rule}{sheets_html}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const M5: Margins = Margins {
        top: 5.0,
        right: 5.0,
        bottom: 5.0,
        left: 5.0,
    };

    fn near(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-6
    }

    /// The A4 / 102 × 102 mm case from the bug report, per fit mode.
    #[test]
    fn a_square_design_on_a4_keeps_its_aspect_ratio_in_every_mode() {
        for mode in ["actual", "fit-width", "fit-page", "shrink", "fill"] {
            let l = compute(mode, 102.0, 102.0, 210.0, 297.0, M5);
            assert!(near(l.draw_w, l.draw_h), "{mode}: {l:?}");
        }
    }

    #[test]
    fn fit_modes_scale_differently() {
        let s = |m| compute(m, 102.0, 102.0, 210.0, 297.0, M5).scale;
        assert!(near(s("actual"), 1.0));
        assert!(near(s("fit-width"), 200.0 / 102.0));
        assert!(near(s("fit-page"), 200.0 / 102.0)); // width is the tighter axis
        assert!(near(s("fill"), 287.0 / 102.0)); // height covers, width is cropped
        assert!(near(s("shrink"), 1.0)); // 102 already fits: never enlarged
    }

    #[test]
    fn shrink_only_shrinks() {
        let l = compute("shrink", 300.0, 100.0, 210.0, 297.0, M5);
        assert!(near(l.scale, 200.0 / 300.0));
        let l = compute("shrink", 50.0, 50.0, 210.0, 297.0, M5);
        assert!(near(l.scale, 1.0));
    }

    #[test]
    fn fit_page_and_fill_are_centred_actual_and_fit_width_are_top_left() {
        let fp = compute("fit-page", 102.0, 102.0, 210.0, 297.0, M5);
        assert!(near(fp.placements[0].offset_x, 0.0));
        assert!(near(fp.placements[0].offset_y, (287.0 - fp.draw_h) / 2.0));
        let fill = compute("fill", 102.0, 102.0, 210.0, 297.0, M5);
        assert!(near(
            fill.placements[0].offset_x,
            (200.0 - fill.draw_w) / 2.0
        ));
        assert!(fill.placements[0].offset_x < 0.0, "cropped, not shifted");
        let act = compute("actual", 102.0, 102.0, 210.0, 297.0, M5);
        assert_eq!(
            act.placements,
            vec![Placement {
                offset_x: 0.0,
                offset_y: 0.0
            }]
        );
    }

    #[test]
    fn a_tall_design_continues_on_the_next_sheet_for_fit_width_and_actual() {
        // 80 × 400 mm onto A4 (content 200 × 287): fit-width → 2.5x → 1000 mm.
        let l = compute("fit-width", 80.0, 400.0, 210.0, 297.0, M5);
        assert_eq!(l.placements.len(), (1000.0_f64 / 287.0).ceil() as usize);
        assert!(near(l.placements[1].offset_y, -287.0));
        let a = compute("actual", 80.0, 400.0, 210.0, 297.0, M5);
        assert_eq!(a.placements.len(), 2);
        // fit-page never paginates: it shrinks to one sheet.
        assert_eq!(
            compute("fit-page", 80.0, 400.0, 210.0, 297.0, M5)
                .placements
                .len(),
            1
        );
    }

    #[test]
    fn a_design_exactly_one_content_box_tall_is_one_sheet() {
        let l = compute("actual", 50.0, 287.0, 210.0, 297.0, M5);
        assert_eq!(l.placements.len(), 1);
    }

    #[test]
    fn margins_shrink_the_content_box_not_the_design() {
        let m = Margins {
            top: 10.0,
            right: 20.0,
            bottom: 30.0,
            left: 40.0,
        };
        let l = compute("fit-page", 100.0, 100.0, 210.0, 297.0, m);
        assert!(near(l.content_w, 150.0) && near(l.content_h, 257.0));
        assert!(near(l.content_x, 40.0) && near(l.content_y, 10.0));
        assert!(near(l.scale, 1.5));
    }

    #[test]
    fn unknown_fit_mode_behaves_like_fit_width() {
        let a = compute("bogus", 102.0, 102.0, 210.0, 297.0, M5);
        let b = compute("fit-width", 102.0, 102.0, 210.0, 297.0, M5);
        assert_eq!(a, b);
    }

    #[test]
    fn degenerate_inputs_do_not_divide_by_zero() {
        let m = Margins {
            top: 500.0,
            right: 500.0,
            bottom: 500.0,
            left: 500.0,
        };
        let l = compute("fit-page", 0.0, 0.0, 10.0, 10.0, m);
        assert!(l.scale.is_finite() && l.scale > 0.0);
    }

    #[test]
    fn sheets_document_is_one_exact_paper_sized_sheet_per_page() {
        let docs = vec!["<p>a</p>".to_string(), "<p>b</p>".to_string()];
        let out = sheets_document(&docs, "fit-page", 102.0, 102.0, 210.0, 297.0, M5, false);
        assert!(out.contains("@page{size:210mm 297mm;margin:0}"), "{out}");
        assert_eq!(out.matches("class=\"pn-sheet\"").count(), 2, "{out}");
        // The design frame keeps the Designer size; only the transform scales it.
        assert!(
            out.contains("width:102mm;height:102mm;transform:scale(1.9608)"),
            "{out}"
        );
        assert!(!out.contains("grayscale"), "{out}");
    }

    #[test]
    fn sheets_document_escapes_the_design_for_srcdoc() {
        let docs = vec!["<p class=\"x\">Tom & Jerry</p>".to_string()];
        let out = sheets_document(&docs, "fit-width", 80.0, 80.0, 80.0, 80.0, M5, false);
        assert!(
            out.contains("srcdoc=\"<p class=&quot;x&quot;>Tom &amp; Jerry</p>\""),
            "{out}"
        );
    }

    #[test]
    fn sheets_document_repeats_a_page_per_sheet_it_spans() {
        let docs = vec!["<p>tall</p>".to_string()];
        let out = sheets_document(&docs, "fit-width", 80.0, 400.0, 210.0, 297.0, M5, false);
        assert!(out.matches("class=\"pn-sheet\"").count() >= 2, "{out}");
        assert!(out.contains("top:-287mm"), "{out}");
    }

    #[test]
    fn sheets_document_grayscale_only_when_enabled() {
        let docs = vec!["x".to_string()];
        let on = sheets_document(&docs, "fit-width", 80.0, 80.0, 80.0, 80.0, M5, true);
        assert!(on.contains("grayscale(1)"));
    }

    #[test]
    fn fit_to_dots_scales_the_sheet_to_the_viewport() {
        // 80 mm sheet = 302.36 px; 640 dots across → ×2.1166.
        let out = fit_to_dots("<html><head></head><body></body></html>", 640, 80.0);
        assert!(out.contains("transform:scale(2.116"), "{out}");
        // Already 1:1: untouched.
        let px = (96.0_f64 / 25.4 * 25.4).round() as usize; // 96 px = 25.4 mm
        let same = fit_to_dots("<html><head></head></html>", px, 25.4);
        assert!(!same.contains("transform"), "{same}");
    }

    #[test]
    fn fmt_trims_noise() {
        assert_eq!(fmt(1.5), "1.5");
        assert_eq!(fmt(102.0), "102");
        assert_eq!(fmt(-0.00001), "0");
        assert_eq!(fmt(1.96078431), "1.9608");
    }
}
