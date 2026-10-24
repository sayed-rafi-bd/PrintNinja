# Print Architecture

How data becomes dots on paper in PrintNinja. This document explains the
ideas; it deliberately contains no code and no file references.

## The pipeline at a glance

Printing is a chain of transformations. Raw business data goes in one end,
printer-specific bytes come out the other, and every step in between exists
to answer one question: what should each dot on the paper be?

```
Data  +  Template  →  Pages  →  Layout  →  Image or PDF  →  Printer language  →  Wire  →  Paper
```

Each stage is timed, so a slow print can be traced to the exact step that
caused it — fetching data, rendering the template, laying out pages,
producing the image, sending it, or recording history.

## 1. Where a print can start

A print can be triggered from many places — the Print page, a test button in
the Designer, the local REST API, a deep link from another app, or by
reprinting an old job from history. But all of them converge on a single
pipeline. This is deliberate: there is exactly one place where pages are
rendered and sent, so a fix or improvement applies to every entry point at
once.

Each job remembers how it entered the system: through the UI, the API, a
deep link, a multi-row batch run, or as a test. Deep links from untrusted
sources pause at a confirmation sheet before anything renders, and every
reprint of a physical page asks for confirmation first — printing costs paper
and toner, so destructive actions are never one click.

## 2. Gathering the data and previewing

A print needs three things: a printer, a template, and data.

Data arrives in one of two ways. In test mode the app uses built-in mock
data shaped like a small shop — a store, a customer, an order with line
items — so layouts can be designed without a backend. In a real print the
user gives a data URL; the app fetches it (plain GET, or POST with an empty
JSON body) and the result becomes the data. If the fetch fails, the preview
falls back to the mock data and says so, rather than showing a blank page.

The preview is a real render, not a mock-up: the same template engine that
the backend uses runs in the browser, one record per page, so what you see
is what prints. A list of records prints one page each; a single object
repeats for as many copies or records as requested, with the preview capped
to the first few pages so a thousand-record run doesn't freeze the screen.

Templates are HTML with placeholders. A template engine merges each data
record into the HTML, producing finished pages. Small helpers format values
— currency, dates, upper/lower case, padded numbers — and two special
helpers draw barcodes and QR codes as inline vector graphics, either from a
fixed value or from a data field (so every label and every CSV row can carry
its own code). Styling comes in three layers: a base stylesheet, compiled
utility classes detected in the template, and the author's own CSS.

When the user presses Print, the app sends the printer name, the template,
the paper size (chosen in the Print page, or the template's own size when
left on automatic), the orientation (defaulting to the template's own, still
flippable per print), margins, fit mode, the copy count, and either the data
itself (test mode) or the data URL (real prints — the backend re-fetches it,
so the preview fetch is never trusted for output).

### Design size vs paper size

A template has a *design size*: the page it was authored at, shown in the
Designer and stored with the template. A print has a *paper size*: the
physical sheet it lands on, chosen per print and never written back to the
template. The preview draws the paper sheet and maps the design onto it,
exactly as the backend will — a mapping label under the preview spells it
out ("design 80×200 mm → paper 210×297 mm"), and the orientation selector
swaps the paper, never the design. When the two sizes match, the mapping is
the identity and the output is byte-for-byte what the old pipeline made.

## 3. The backend pipeline

The backend works through the same stages for every job:

1. **Resolve content.** Load the template and rebuild its full stylesheet
   from the three layers. Split the geometry: the design size comes from the
   template (raw HTML sent via the API defaults to A4), while the paper size
   is the request's explicit choice first, the design size second, A4 last —
   so an API or UI caller can print a template on different paper without
   touching the template. Orientation defaults to the template's stored
   value, overridable per request. Raw HTML sent via the API defaults to A4.
2. **Open a job record.** A row is written to the jobs database in the
   *printing* state, stamped with the settings, the data, and the start
   time. It carries an idempotency key stored under a uniqueness constraint:
   retrying the same request returns the existing job instead of printing
   twice.
3. **Fetch the data.** The backend pulls the data URL itself, with a timeout
   and a size cap. Domain allow-lists and private-network blocking apply, so
   a template can't be tricked into reading internal services.
4. **Render the template.** The backend engine merges data into pages exactly
   as the preview did — same placeholders, same helpers — so the preview
   guarantee holds.
5. **Lay out the pages.** The page box is the paper: size, margins, and a
   design→paper scale derived from the fit mode (actual size, fit to width,
   fit to page, fill, shrink) — the design is proportionally zoomed onto the
   paper content box, with no scaling at all when the two match. Exact color
   reproduction and an optional grayscale conversion are applied on top.
6. **Produce output.** Either a PDF document or a bitmap image, depending on
   the printer's language (see §5) — always rendered at the paper size, so
   the file's page box and the printed sheet agree.
7. **Send.** The finished bytes go to the printer through the transport
   matching its type (see §4), once per copy, holding that printer's turn so
   two jobs never interleave on the same machine.
8. **Close the job.** The row flips to *success* or *failed* with the error,
   the rendered output (redacted where sensitive), and the finish time. The
   update only applies while the job is still *printing*, so a cancelled job
   can never be resurrected as successful.

## 4. How the bytes reach the printer

Printers are configured with a type (how to reach them) and a language (what
they understand):

- **Network printers** are reached over the office protocol IPP
  (Print-Job requests, default port 631) or over a raw TCP socket (default
  port 9100 — bytes in, paper out). Before sending, the app can probe the
  printer in its own dialect to catch an offline or faulted machine early.
- **System printers** go through the operating system: the Windows spooler on
  Windows, CUPS on Linux. The app hands over finished bytes and lets the OS
  queue them.
- **USB and Bluetooth label printers** are spoken to directly on Windows;
  elsewhere the app reports them as unsupported instead of failing silently.

Discovery lists the machine's OS queues; a test print runs the entire
pipeline end to end with mock data to prove a new printer works.

## 5. Printing across printer languages

The printer's language decides what the backend produces. There are two
fundamentally different paths.

**The PDF path** is for office printers: the page is rendered at its real
size in millimetres and the resulting document is sent untouched. No
screenshot, no translation — the printer's own PDF interpreter does the
work.

**The bitmap path** is for receipt and label printers, which understand small
command languages rather than documents. The page is photographed at exactly
the printer's dot density — one screen pixel per printer dot, so nothing is
resampled or blurred — reduced to pure black and white, and packed into bits.
Those bits are then wrapped in the printer's dialect:

- **Receipt printers** get an initialize command followed by a raster-graphics
  command carrying the raw bitmap.
- **TSPL label printers** get a short script: label size, gap size, direction
  and origin, a clear command, the bitmap, and a print command.
- **Zebra printers** get a format frame with the bitmap encoded as
  hexadecimal text (readable, but roughly twice the size of raw bytes).
- **Mobile CPCL printers** get a compact header, one hex line per row, and a
  print command.
- **Bare-bitmap devices** (some spoolers and bridges) receive just the packed
  dots with no command language at all.

Two details matter in practice. First, the label dimensions in those headers
describe the paper, not the design: the size headers and the rendered dots
both use the paper dimensions, so the bytes and the sheet always agree — a
wrong paper choice in the Print page mis-sizes the label even when the
preview (which shows the same mapping) warned you. Second,
copies are a send loop, not a language feature: the finished payload is
transmitted once per copy.

## 6. Printing across operating systems

The pipeline is identical on every OS; what changes is how pages become
bytes and which transports exist.

- **Windows** renders PDFs through the built-in browser engine (kept warm in
  the background for speed) and reaches printers via network protocols, the
  system spooler, USB, or Bluetooth serial.
- **Linux** renders through headless Chromium and reaches printers via
  network protocols or CUPS. USB and Bluetooth label printers are not
  supported — the app says so plainly.
- **Android** renders through the system WebView, discovers network printers
  over local-network discovery and USB printers through the USB host API. A
  background service keeps the print queue draining even after the app is
  swiped away, and the app requests exemption from battery optimization so
  the system doesn't defer prints.
- **macOS** is not a print target: rendering and delivery both report
  unsupported rather than failing mysteriously.

## 7. Printing across app modes

- **Desktop app, online.** Everything works: local prints, shared templates,
  remote data, update checks.
- **Desktop app, offline.** Local printing works completely — the engine,
  templates, and printers all live on the machine. Only remote data sources,
  cloud sync, and release checks degrade. (The "working offline" banner
  refers to the sharing service, not to printing.)
- **Web preview.** The design surface and preview render in the browser, but
  nothing can print: there is no local backend to receive the job.
- **Test vs real.** Test prints run the full pipeline on mock data and are
  flagged in history, where they can be hidden to keep the log clean.

## 8. Queue, memory, and history

Printers print one thing at a time, so each printer has its own turn-taking
lock and every copy is sent individually — jobs to the same machine never
interleave. A background worker drains queued jobs a few at a time; if the
app crashes mid-print, rows stuck in *printing* are marked failed on the next
start, then queued rows resume. Cancelling a job is terminal: the close-out
guard guarantees a cancelled job can never flip to successful later.

Every job is remembered: settings, data, outcome, error, duration, and
per-stage timings, indexed for the history views. Old jobs are purged
automatically under the retention limits from Settings, and history can be
exported as a spreadsheet. Reprinting clones an old row and wakes the
worker; retrying re-queues only jobs that ended in failure or cancellation.
