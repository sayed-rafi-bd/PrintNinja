# Hardware checklist — one page, once per release

CI mocks what it can reach: the byte-level tests in
`src-tauri/tests/language_dispatch.rs` already pin what each command language
puts on the wire, and the mock IPP server pins the status handling. This
checklist is the part CI cannot do — how **real devices** react to real jobs,
plus the Windows spooler and USB. Run it on the Windows machine before
publishing (see [`RELEASE.md`](RELEASE.md)); it is also Phase 0 item 0.6's
second gate in [`REFACTORING.md`](../REFACTORING.md).

**Devices (plan question 12):** one ESC/POS printer, one ZPL **or** TSPL
printer, one network printer. CPCL and bare-raster have no device here and
stay CI-only; Android is outside this plan.

**Record:** date, commit/tag, printer models with connection (USB/network +
address), tester. File failures as issues — a failure on a gap marked ⚠ is
recorded as documented behaviour, not a release blocker.

## Before

- [ ] The tag commit is green on Linux **and** Windows CI
- [ ] Release MSI installed on a clean Windows machine; the app opens

## 1. Command languages (item 0.6, P4)

Add each printer in Settings with its language, open a 40 × 30 mm label,
print **3 copies**.

- [ ] **ESC/POS** printer prints the label at the head's own resolution —
      sharp text, correct size, nothing clipped or stretched
- [ ] **TSPL or ZPL** printer: media feeds and aligns correctly (TSPL:
      `SIZE`/`GAP`/`DIRECTION` honoured; ZPL: format renders), graphics and
      any barcode are crisp, no hex/garbage on the media
- [ ] Each label matches Print preview — the pipeline sent *that printer's*
      encoding, not PDF bytes
- [ ] 3 copies → 3 identical labels, one after another (the per-printer
      queue serialises them)

## 2. PDF path, spooler and worker (items 0.3, 0.4, P7, P15)

- [ ] A Windows **system printer** prints a PDF job; margins, orientation and
      size match Print preview — this is the *RAW spooler carrying PDF bytes*
      path listed as **Not verified** in `REFACTORING.md`; it is exercised
      here for the first time
- [ ] Network printer switched off or unreachable → the History row ends
      `failed` with an error, never `success` (the IPP response status is
      read, P7) and never stays `queued` (P3)
- [ ] While a long or multi-copy job runs, History shows it as running with a
      real `started_at`, then exactly one terminal status —
      `success` / `failed` / `cancelled` (P15, P8)
- [ ] A batch of 4 jobs ends `done 4 / failed 0` with every row terminal
      (item 0.4); retry of a failed row queues a new attempt

## 3. USB transport (⚠ known gap)

- [ ] With a USB printer connected: Test/Add finds it and a test print
      reaches it — **or record "not found"**: the transport is built with
      vendor and product id `0` (transport table in `REFACTORING.md`), and
      this run documents its real behaviour rather than being gated by it

## 4. Cache dir after prints (the stray `.pem` fix)

After several prints of both kinds, restart the app once, then inspect the app
cache dir — `%LOCALAPPDATA%\com.printninja.desktop` on Windows, the folder
that holds `last-render.pdf`:

- [ ] No `edge-profile-*` directories remain
- [ ] At most one Edge profile remains: `edge-warm-profile`, the reusable one
      that prints run on (`src-tauri/src/render/edge.rs`). Edge's own files,
      certificate and trust material included, live inside it and stay there
- [ ] No `.pem` or other certificate file appears **next to** `last-render.*`
      (directly in the cache dir, outside `edge-warm-profile`)

## Result

| | |
| --- | --- |
| Date / commit / build | |
| ESC/POS model, connection | |
| ZPL/TSPL model, connection | |
| Network/system printer | |
| Pass / failures (issue links) | |
