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
- [ ] With the media removed, the next print **fails with the reason**: the
      response and the History row read "it is out of paper" (plus the raw
      evidence, e.g. `DLE EOT 4 = 0x72`) and nothing is printed. Reload the
      media and the next print goes through. This only applies to printers
      with a command language — ESC/POS, ZPL, TSPL are asked before every
      job; PDF, raster and CPCL printers are not (`transport::status`), and
      a printer that has never answered a status query prints as before

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

## Appendix L. Linux (deb + AppImage, §5 of IMPROVEMENTS.md)

Run on a clean Debian/Ubuntu machine (VM is fine) before publishing.
Linux v1 serves **IPP + raw TCP** printers rendered by a **system
Chromium**; USB and the system spooler stay Windows-only and must fail
with the platform message, never silently.

- [ ] `.deb` installs (`dpkg -i`); the app opens from the launcher icon
- [ ] `dpkg -s print-ninja` shows the `libayatana-appindicator3`
      dependency; tray icon appears (KDE: always; stock GNOME: only
      with an AppIndicator extension — record which shell was tested)
- [ ] Tray menu: Show focuses the window, left-click toggles, Quit exits
- [ ] Close hides to the tray; minimize hides when enabled; Quit from the
      tray ends the process (no orphan `printninja`)
- [ ] Fresh install does **not** autostart; enabling it writes
      `~/.config/autostart/` and the next login opens minimized when set
- [ ] An IPP printer prints a PDF job; `@page` size matches the template
      (measure the label, not the screen)
- [ ] With no Chromium installed, a print fails loudly naming the missing
      browser (`PRINTNINJA_CHROMIUM_BIN` documented); installing
      `chromium` makes the same job print
- [ ] A raw TCP printer prints; a switched-off printer ends `failed`
      with the reason, never `success`
- [ ] USB/system printer setup is refused with the platform message
- [ ] No udev rules, `dialout`/`lp` groups, or permission tweaks are
      needed: USB is unsupported-by-design on Linux v1 (not a
      permissions problem), so there is nothing to grant
- [ ] AppImage runs from a download folder with no install (`chmod +x`)

## Appendix M. Android foreground service (manual — no emulator in CI)

On a physical device with a debug APK (`android-build` CI artifact):
- [ ] Launching the app shows the persistent notification "PrintNinja
      print service is running"; tapping it reopens the app
- [ ] Notification has a working Stop action; stopping removes the
      notification without crashing the app
- [ ] Print a job, swipe the app away mid-queue, confirm the job still
      completes (foreground service survived the swipe)
- [ ] Reboot the phone: service is stopped (no autostart — by design);
      launching the app starts it again
- [ ] Settings → Background shows the service status and the battery
      exemption row (desktop tray toggles are hidden on Android);
      "Request exemption" opens the system screen, and granting it
      flips the status to allowed
- [ ] With Battery Saver on and no exemption, a queued print still
      completes (may be deferred by Doze — record the delay)
