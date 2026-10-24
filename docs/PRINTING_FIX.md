# Printing Fix — Final Plan

## Problem

1. Designer preview, print preview, and printed output do not match.
2. The designer's page size is not used when creating the PDF.
3. The page size from the UI is not used while printing.

## Core clarification

**Page size = the physical paper** the job lands on (A4, 80 mm label roll,
etc.). It is not the template's design size. Its main purpose is preview
fidelity: showing how the template looks on that paper. The template keeps
its own design size; **fit mode reconciles the two** by mapping the design
onto the paper.

## Root causes (verified in code)

- The backend silently drops the request's `page_width_mm`/`page_height_mm`
  whenever `template_id` is set — the PDF always renders at the template's
  stored size.
- The backend never reads the template's stored `orientation`; the Print
  page defaults to portrait for every template, so landscape templates print
  portrait unless the user flips the selector.
- The print preview ignores orientation (frame is always `w × h`), fit mode,
  and margins — the backend applies all three, so preview and printout
  diverge for any non-default setup.
- The Designer canvas shows live (possibly unsaved) state while printing
  uses the saved row — same template, three different sizes, no warning.
- Fallback defaults differ (80×200 frontend vs 210×297 backend); preview
  compiles CSS live while the backend uses stored `compiled_css`.

## The fix

### Step 1 — Split design size vs paper size

- Design size lives with the template (stored row, Designer canvas).
- Paper size comes from the request → template design size → one shared
  default (unify the two fallback pairs).
- Orientation applies to the paper (swap paper w/h for landscape), and the
  template's stored orientation becomes the default when the request omits
  it.

### Step 2 — Backend: paper wins, fit bridges the gap

- Remove the `template_id.is_none()` guard so the requested paper size
  reaches `@page`.
- The layout builder takes both sizes: `@page` = paper size, design mapped
  onto it per fit mode (`fit-width`, `fit-page`, `actual`, `shrink`, `fill` —
  exact behavior for design ≠ paper defined once, here).
- No persistence: paper size applies to that print only, never written back
  to the template.

### Step 3 — One shared layout implementation

- The same builder feeds the backend `@page`/fit injection and the frontend
  preview, so preview and printout match by construction.
- Print preview frame = paper size with the design fitted exactly as the
  backend will; Designer canvas keeps showing design size (correct — it's
  the artwork editor).
- Verify Designer save always refreshes `compiled_css` so backend CSS can't
  go stale behind a live preview.

### Step 4 — Print page: no separate advanced section

- Remove the collapsible "Advanced options" section entirely.
- Show all controls inline in the default section, above the Print button,
  in this order: printer, template, copies, test-data toggle, data
  fields/URL, orientation (initialized from the template, not hardcoded
  portrait), fit mode, **paper size** (presets — A4, Letter, common label
  widths — plus custom w×h), page range, margins, grayscale, then the Print
  button last.
- Paper-size / orientation / fit changes live-update the preview frame.
- Small preview label showing the mapping, e.g. "design 80×200 → paper
  A4 (fit-width)".
- Delete the now-dead toggle state, `showAdvanced`, and related test hooks;
  update the unit/e2e tests that open the collapsible.

### Step 5 — Lock it with tests

- Unit: paper-resolution precedence (request → template → default);
  fit-mapping matrix for design ≠ paper cases; orientation default from
  template.
- E2E: landscape + custom-paper template — preview frame dimensions equal
  the PDF page box; API print with `template_id` + explicit paper size uses
  the paper size; print page shows all controls without a collapsible.

## Order

1 → 2 (backend-only, small) → 3 (shared mapping, the heart of it) →
4 (UI) → 5 (tests). Do not start step N+1 until step N is green.
