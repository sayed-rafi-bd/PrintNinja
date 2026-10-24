# Print Architecture

How data becomes dots on paper in PrintNinja: from the Print page (or API,
deep link, reprint) through template rendering, raster/PDF generation, and
delivery to the printer over IPP, raw TCP, the OS spooler, USB, or Bluetooth.

## The pipeline at a glance

```
Data source ──┐
              ├─► Template render (Handlebars + helpers) ─► Layout (@page, fit, margins)
Template ─────┘                                                        │
                                                                       ▼
                                              ┌─ PDF language ──► html_to_pdf (Edge/Chromium)
                                              │                          │
                                              └─ label languages ─► html_to_raster (screenshot)
                                                                         │ threshold 128
                                                                         ▼
                                                              encode_for_language
                                              (ESC/POS GSv0 · TSPL BITMAP · ZPL ^GFA · CPCL · bare dots)
                                                                         │
                                                                         ▼
                                              Transport: IPP / Raw TCP / System spooler / USB / BT
                                                                         │
                                                                         ▼
                                                              print_jobs row → success|failed
```

Every stage is timed into `StageTimings`
(`fetch, template, layout, render, send, history, total_ms`), returned to the
caller and stored as `timings_json` on the job row.

## 1. Entry points

All entries converge on one backend function,
`run_print_with()` in `src-tauri/src/commands/print.rs:390`.

| Entry | What it does |
|---|---|
| Print page (`src/pages/Print.tsx`) | Collects printer, template, data source, page geometry, copies; calls `print_html`. |
| Designer test print | Same `print_html` command with `source: "test"` and inline mock data. |
| Local REST API (`POST /v1/print`, `src-tauri/src/api/routes.rs:164`) | Builds the same `PrintRequest` with `source: "api"`; honors `Idempotency-Key`. |
| Deep link (`printninja://print?...`) | Same request with `source: "deeplink"`; untrusted sources pause at a confirmation sheet. |
| Reprint (`history.rs:54`) / Retry (`history.rs:67`) | Clones a job row as `queued` (reprint) or re-queues `failed`/`cancelled` rows (retry), then wakes the background worker. Batch/API prints go through `batches`. |

## 2. Frontend: gathering data and previewing

State lives in `usePrintStore` (`src/lib/store/printStore.ts:18`):
printer, template, `dataUrl` + `httpMethod` (GET/POST), orientation, four
margins, `fitMode` (`actual | fit-width | fit-page | shrink | fill`), copies,
`records` (clamped 1–500), test-data toggle, page range, grayscale.

**Data resolution** (`src/pages/Print.tsx:105`):

- Test-data mode → `DEFAULT_MOCK_DATA`
  (`src/lib/templates/defaultTemplate.ts:50`: a shop/order/customer object).
- Otherwise the `dataUrl` is fetched client-side (`GET`, or `POST` with body
  `"{}"`) for the preview; on failure the preview falls back to mock data.
- Arrays print one record per page; a single object repeats for `records` pages
  (preview shows the first 10).

**Template rendering** (`src/lib/render/renderTemplate.ts:114`):

1. `Handlebars.compile(html)(record)` per record, pages joined with
   `break-before: page`; render errors become an escaped `<pre>` instead of a
   crash. Output is sanitized (scripts/event handlers stripped) and shown in a
   sandboxed `iframe srcdoc`.
2. Helpers mirror the backend one-for-one: `currency, date, upper, lower,
   number, padLeft, barcode, qrcode` (`renderTemplate.ts:20`).
3. Barcodes render to inline SVG via bwip-js
   (`src/lib/utils/barcode.ts:35`); `PRINT_SYMBOLOGIES` covers code128, code39,
   code93, ean13, ean8, upca, itf, codabar. Fixed values and data-field
   references (`{{barcode "code128" order.id}}`) both work.
4. CSS: Tailwind classes used by the template are compiled ahead of time
   (`compileTemplateCss`, memoized) and layered as base + compiled + author CSS
   (`src/lib/templates/templateCss.ts:46`).

**Submit** (`src/pages/Print.tsx:218` → `agent("print_html")`): sends a
`PrintHtmlReq` (`src/lib/agent/types.ts:137`) with printer name, template id,
page size, orientation, copies, records, margins, fit mode, page range,
grayscale, plus **either** inline `data` (test mode) **or** `data_url` +
`http_method` (real prints — the backend re-fetches, so the preview fetch is
never trusted for output).

## 3. Backend: `run_stages` (`src-tauri/src/commands/print.rs:597`)

1. **Resolve content** (`:531`): loads the template row from SQLite
   (`html, css, compiled_css, page size`) and rebuilds the CSS cascade; raw-HTML
   API prints default to 210×297 mm.
2. **Begin job** (`:1073`): INSERTs a `print_jobs` row in `printing` state with
   `settings_json`, `data_json`, `started_at`. The `idempotency_key` column is
   UNIQUE — a duplicate key returns the existing job id instead of printing
   twice.
3. **Fetch** (`:629`): server-side `DataFetcher` pulls `data_url` (15 s
   timeout, 5 MB cap); allowed domains and private-IP blocking apply.
4. **Template** (`:673`, `render/handlebars.rs`): the Rust engine renders one
   page per record (or one object × `records`), same helper set as the preview
   so WYSIWYG holds.
5. **Layout** (`:223`): injects `@page { size; margin }`, the fit-mode scaling,
   `print-color-adjust: exact`, and optional grayscale.
6. **Render dispatch** (`:779`): looks up the printer, parses its language
   (default 203 dpi, clamped 1–1200):
   - `Pdf` → `PdfRenderer::html_to_pdf` (`render/mod.rs:49`) via a persistent
     Edge CDP session on Windows (`render/cdp.rs`, warmed up at startup) or
     one-shot headless Edge; Chromium (`PRINTNINJA_CHROMIUM_BIN`,
     `chromium/chrome/edge` candidates, `--no-sandbox` retry for root) on
     Linux. Other OSes report “no renderer”.
   - Label languages → `html_to_raster` (`render/mod.rs:190`): headless
     `--screenshot` at `dots_for_mm(size, dpi)`, then `png_to_raster`
     (luminance threshold 128; optional Floyd–Steinberg dither) into packed
     `RasterImage` dots (`render/raster.rs`).
7. **Encode** (`transport/mod.rs:54`): raster → printer language —
   ESC/POS (`GS v 0`), TSPL (`SIZE/GAP/BITMAP`), ZPL (`^XA…^GFA`), CPCL
   (`!…PRINT`), or bare dots for `raster`.
8. **Send** (`:880`): takes the per-printer queue permit and calls
   `TransportRegistry::send_to(type, …)` once per copy:
   - **IPP** (`transport/ipp.rs`): bare addresses default to `:631/ipp/print`;
     sends an RFC 8011 Print-Job (`application/ipp`, with `copies`), 30 s
     timeout, then parses the response status, `job-state` (3/4/5/9 = done)
     and `printer-state-reasons` for the error message.
   - **Raw TCP** (`transport/raw_tcp.rs`): `host:port` (default 9100), 10 s
     connect / 30 s send; optional pre-send probe per dialect (ESC/POS
     `DLE EOT`, ZPL `~HS`, TSPL `ESC !?`), throttled and skipped for PDF/
     raster/CPCL.
   - **System** (`transport/cups.rs`, `windows_spooler.rs`): CUPS
     `CUPS-Get-Printers` over IPP `localhost:631` on Linux; Win32
     `OpenPrinter → StartDocPrinter(RAW) → WritePrinter → EndDoc` on Windows.
   - **USB** (`transport/windows_usb.rs`, Windows): rusb bulk write by
     VID/PID, spooler fallback. **Bluetooth** (`windows_bluetooth.rs`,
     Windows): serial-port (COM) write, spooler fallback. Off Windows these
     report “not supported on this platform”.
9. **Close** (`:1161`): UPDATEs the row to `success`/`failed` with the error,
   redacted `rendered_html`, `finished_at`/`duration_ms` — guarded by
   `WHERE status='printing'` so a cancelled job is never resurrected —
   bumps metrics and persists `timings_json`.

## 4. Printers

Configured in PrinterSetup and stored in the `printers` table (`type` /
`language` CHECK-constrained in `db/mod.rs:744`); the frontend mirrors the
enums in `src/lib/printerSchema.ts:9`.

| Type | Address | Languages | Platform |
|---|---|---|---|
| `ipp` | `http(s)://host[:port]/…` | pdf | all |
| `raw_tcp` | `host:port` (default 9100) | escpos, tspl, zpl, cpcl, raster | all |
| `usb` | VID/PID | label languages | Windows (rusb) |
| `bluetooth` | COM port | label languages | Windows (serial) |
| `system` | OS queue name | pdf | Windows spooler / Linux CUPS |

Discovery: `enumerate_system_printers` lists OS queues (CUPS on Linux,
`EnumPrintersA` on Windows); `test_printer` sends a probe page. `Test print`
on the Print page (`spike_test_print`) exercises the whole path with mock
data.

## 5. Printing across printer languages

The printer row's `language` decides what bytes leave the machine
(`transport/mod.rs:37`; unknown printer → `Pdf`). DPI defaults to 203 — the
common thermal head — clamped 1–1200. There are two fundamentally different
paths (`commands/print.rs:795`).

**PDF path** — for `Pdf` printers (office printers over IPP, OS queues).
`PdfRenderer` renders at the real page size in millimetres and the bytes go
out untouched as `application/pdf`: no screenshot, no encoding. IPP
advertises the MIME as the document format; the Win32 spooler and CUPS pass
it through as RAW/a PDF queue job.

**Raster path** — for every label/receipt language. The page is screenshotted
at exactly `dots_for_mm(size, dpi)` pixels, so 1 CSS px = 1 printer dot and
nothing is resampled on the way to the head. Luminance threshold 128 packs it
into a 1-bit `RasterImage` (rows padded to whole bytes; optional
Floyd–Steinberg dither in `render/raster.rs`). `encode_for_language`
(`transport/mod.rs:54`) then wraps those dots per language, all sent as
`application/octet-stream`:

| Language | Typical printer | Bytes on the wire |
|---|---|---|
| `Escpos` | Receipt printers | `ESC @` init + `GS v 0` (mode: normal) raster graphics (`transport/escpos.rs:6,33`) |
| `Tspl` | TSC / Godex label printers | `SIZE w mm,h mm` · `GAP 2 mm,0 mm` (repo default — the printers table has no gap column) · `DIRECTION 1` · `REFERENCE 0,0` · `CLS` · `BITMAP 0,0,row_bytes,height,0` + raw dots · `PRINT 1` |
| `Zpl` | Zebra | `^XA` `^MMT` `^PR6` `^FO0,0^GFA,total,total,row_bytes,` + dots as **hex ASCII** (doubles the payload vs raw) + `^FS` `^XZ` |
| `Cpcl` | Mobile / Comtec printers | `! 0 200 200 height 1` · `CG width_dots row_bytes 0 0` · one hex-ASCII line per row · `PRINT` |
| `Raster` | Spoolers / bridges that bitmap themselves | Bare packed dots, no command language at all |

Notes:

- Label dimensions in the TSPL/ZPL/CPCL headers come from the template's
  page size (`w_mm`/`h_mm` flow from the request into the encoder), so a
  wrong page size in Designer mis-sizes the label even when the artwork looks
  right in preview.
- Hex-ASCII encodings (ZPL, CPCL) are ~2× the raw bitmap; raw-binary ones
  (ESC/POS, TSPL) send the dots as-is.
- Copies are a send loop, not a language feature: the transport sends the
  finished payload once per copy (`RenderedJob { copies: 1 }` per send), and
  IPP additionally declares `copies` in the Print-Job attributes.

## 6. Printing across operating systems

The request pipeline (§3) is identical everywhere; what changes per OS is
how pages are rendered to bytes and which transports exist.

| | Windows | Linux | Android | macOS |
|---|---|---|---|---|
| PDF render | Persistent Edge CDP session (warmed up at startup, `render/cdp.rs`), one-shot headless Edge fallback (`render/edge.rs`) | Headless Chromium (`chromium`/`chrome`/`edge` candidates, `PRINTNINJA_CHROMIUM_BIN` override; `--no-sandbox` retry when running as root) | System WebView via the `android-print` plugin (`htmlToPdf`) | No renderer — reports “no renderer” |
| Raster render | Headless Edge screenshot | Headless Chromium screenshot | Same WebView path | Unsupported |
| IPP / Raw TCP | ✅ | ✅ | ✅ (printers found via `NsdManager` `_ipp._tcp` discovery) | — |
| System spooler | ✅ Win32 spooler (`OpenPrinter → WritePrinter`, RAW) | ✅ CUPS (`CUPS-Get-Printers` over IPP `localhost:631`) | — (system printing goes through the plugin) | — |
| USB / Bluetooth | ✅ rusb bulk write / COM serial (spooler fallback) | ❌ reports “not supported on this platform” | ✅ USB host API enumeration | — |
| Printer discovery | `EnumPrintersA` | CUPS printer list | mDNS + USB host API | — |

macOS is not a print target: rendering errors out and every transport
constructor returns `None`, so sends fail loudly instead of silently.

On Android the queue additionally survives the app being swiped away: the
`PrintNinjaService` background service (see Settings → Background) keeps the
worker draining, and the app asks for a battery-optimization exemption so
Doze doesn't defer prints.

## 7. Printing across app modes

| Mode | What works | What doesn't |
|---|---|---|
| Desktop app, online | Everything: local prints, share sync, remote `data_url` fetches, update checks. | — |
| Desktop app, offline | Local printing works fully — the backend, templates, and printers live on the machine. | Remote `data_url`s, share sync, release checks. (The “Working offline” banner refers to the *share server*, not printing.) |
| Web / browser preview | Client-side preview renders (Handlebars + helpers run in the browser); settings fall back to localStorage. | No printing: `agent()` calls need the Tauri backend, so submit fails. ApiExplorer says so explicitly. |
| Test print (`source: "test"`, `is_test`) | Full pipeline with mock data (`spike_test_print`, Designer test print, Print-page test toggle). | Test jobs are flagged and can be hidden in History (`Hide test`). |

Within a real print, `source` records *how* the job entered (`ui`, `api`,
`deeplink`, `batch`, `test`). Batch runs stamp `batch_id`/`record_index` so
one multi-row submission is traceable per row. Deep links from untrusted
sources pause at a confirmation sheet before anything renders.

## 8. Queue, worker, and history

- `PrintQueue` (`worker.rs` + `print.rs:880`): per-printer permits serialize
  sends; each copy is sent individually.
- Background `Worker::drain` (`worker.rs:161`, ≤4 in flight, 5 s sweep):
  on startup, rows stuck in `printing` become `failed` (crash recovery);
  then it atomically claims `queued → printing` rows and replays them through
  `run_stages` (reusing stored `rendered_html` when present, else re-rendering
  from the row).
- Cancel sets `cancelled`; the `close_job` guard keeps terminal states
  terminal.
- `print_jobs` (`db/schema.sql:55`): full settings/data/error/duration/timings
  per job, indexed by status, printer, template, batch, creation time.
- Retention (`history.rs:116`): `purge_old_jobs` enforces `retention_days` /
  `max_records` from Settings at startup and daily.

## 9. Android specifics

The Android-only pieces behind the rows above: PDF rendering goes through the
Android WebView (`htmlToPdf` in the `android-print` plugin), USB discovery
through the USB host API, and the service keeps the queue alive after the app
is swiped away (see the Background section in Settings). Off
Windows/Linux the desktop raster renderer and USB/Bluetooth transports are
stubs that report “unsupported” instead of failing silently.

## Key files

| Area | File |
|---|---|
| Print page + submit | `src/pages/Print.tsx` |
| Request/response shapes | `src/lib/agent/types.ts:79`, `:137` |
| Command surface | `src/lib/agent/commands.ts:123`, `:172` |
| Preview renderer + helpers | `src/lib/render/renderTemplate.ts` |
| Barcodes | `src/lib/utils/barcode.ts` |
| CSS compile | `src/lib/templates/compileTemplateCss.ts`, `extractClasses.ts` |
| Job history UI | `src/pages/History.tsx`, `src/lib/store/historyStore.ts` |
| Print command + stages | `src-tauri/src/commands/print.rs` |
| History commands | `src-tauri/src/commands/history.rs` |
| Rust template engine | `src-tauri/src/render/handlebars.rs` |
| PDF/raster renderers | `src-tauri/src/render/mod.rs`, `cdp.rs`, `edge.rs`, `raster.rs` |
| Transports | `src-tauri/src/transport/` (`ipp.rs`, `raw_tcp.rs`, `cups.rs`, `windows_*.rs`, `label_langs/`) |
| Queue worker | `src-tauri/src/worker.rs` |
| Schema | `src-tauri/src/db/schema.sql` |
| REST print route | `src-tauri/src/api/routes.rs:164` |
