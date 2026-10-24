# Print Architecture

How data becomes dots on paper in PrintNinja. This document explains the
ideas; it deliberately contains no code and no file references.

## The pipeline at a glance

Printing is a chain of transformations. Raw business data goes in one end,
printer-specific bytes come out the other, and every step in between exists
to answer one question: what should each dot on the paper be?

```
Data  +  Template  →  Design pages  →  Sheets  →  Image or PDF  →  Printer language  →  Wire  →  Paper
```

The middle of that chain is the part to hold in your head. A template is
rendered into *design pages* exactly as it looks in the Designer, with no
knowledge of any paper. Only afterwards are those finished pages *placed* on
physical *sheets*. Rendering and placement are separate steps, and nothing
about the paper ever feeds back into the template.

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
the backend uses runs in the browser, one record per page, and the same
placement rules put each page on a drawn sheet of the chosen paper — so what
you see is what prints. A list of records prints one page each; a single
object repeats for as many copies or records as requested, with the preview
capped to the first few pages, and to a fixed number of drawn sheets, so a
thousand-record run or a very tall design doesn't freeze the screen.

Because the template is rendered only once per record, changing the paper,
orientation, margins, fit mode, or grayscale never re-renders anything. The
preview simply redraws the same finished pages in a new position and scale,
which is why those controls respond instantly.

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
swaps the paper, never the design.

The central rule is that **a design is never re-laid out for the paper.**
Each record is rendered once, at exactly the design size, inside its own
frame — the same way the Designer canvas shows it. That finished frame is
then scaled, as a picture would be, and positioned on the sheet. Line
breaks, wrapping, and aspect ratio therefore stay exactly as designed;
only where the finished page lands on the paper changes. Scaling is always
uniform on both axes, so a design is never stretched.

### Placement: how a design lands on a sheet

Placement happens inside the *printable area*: the paper minus its margins.
Margins belong to the paper alone; they are carved out of the sheet, never
out of the design. The fit mode then decides the scale and position:

- **Actual size** — one design millimetre is one paper millimetre, anchored
  at the top-left. A design taller than the printable area continues on the
  next sheet.
- **Fit to width** (the default) — scaled so the design spans the printable
  width, anchored at the top-left, continuing onto further sheets when it is
  taller than one.
- **Fit to page** — the largest scale at which the whole design fits,
  centred.
- **Shrink only** — like fit to page, but never enlarges, centred.
- **Fill** — the smallest scale that covers the whole printable area,
  centred and cropped to it.

A design that continues across sheets is sliced by simply moving it up by
one printable height per sheet; a design that lands exactly on a sheet
boundary uses one sheet, not two, and a hard cap stops a pathologically tall
design from producing an unbounded document. When design and paper are the
same size and margins are zero, the scale is exactly one and the design sits
precisely where it was authored.

Placement is the one piece of logic that exists twice — once in the browser
for the preview and once in the backend for the real output. Both are pinned
to a single shared table of expected results, so a change to one that isn't
mirrored in the other fails a test instead of silently making the preview
lie.

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
4. **Render the design pages.** The backend engine merges data into one
   page per record exactly as the preview did — same placeholders, same
   helpers. Each record becomes its own complete document at the design
   size, carrying the template's styling and nothing about paper. Any page
   size or margin the template's own CSS tries to declare is stripped, so
   the template cannot fight the layout step. Pages are joined with a fixed
   separator, and the stored job keeps that separator so a replayed job
   splits back into the same pages.
5. **Place the pages on sheets.** The backend builds one printable document
   made of *sheets*, each exactly the paper size. Every design page is
   dropped into a frame of its own design size, scaled and positioned by the
   placement rules above, inside a printable-area box that clips whatever
   the fit mode pushes outside it (fill's crop, the next sheet's slice). The
   document's own page margin is deliberately zero: margins are applied by
   the printable-area box alone, so the browser's handling of page margins
   can never disagree with the preview. Exact color reproduction and an
   optional grayscale conversion are applied on top.
6. **Produce output.** Either a PDF document or a bitmap image, depending on
   the printer's language (see §5) — always at the paper size, so the file's
   page box and the printed sheet agree. Before capturing, the renderer waits
   for web fonts to finish loading in every design frame, not just the outer
   document; otherwise a label could print in a fallback font.
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
command languages rather than documents. The sheet is photographed at exactly
the printer's dot density — one screen pixel per printer dot, so nothing is
resampled or blurred. Sheets are laid out in millimetres, so before the
photograph the whole sheet is scaled so the paper's width spans exactly the
printer's dot width: one millimetre of design becomes one millimetre of label
at that printer's resolution, rather than a small sheet floating in a large
capture area. The result is reduced to pure black and white and packed into
bits.
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
exported as a spreadsheet. The stored job keeps the design pages as rendered
— before any paper is involved — so a reprint is placed on sheets again from
those same pages using the job's saved settings. Reprinting
clones an old row and wakes the worker; retrying re-queues only jobs that ended in failure or cancellation.
