# Mobile device test pass (PLAN.md Phase 4, item 12)

The automated checks (`e2e/tests/mobile.mobile.e2e.ts` on the Pixel 7 and
360px projects) cover layout, tap targets, screenshots, and axe. They run
in emulation. This checklist is the part that needs a human with hardware:
real touch gestures, safe areas, keyboards, and WebView quirks.

Scope: **both runtimes** — mobile web browser first, then the Tauri Android
app. Tick boxes as you go and report back per the template at the bottom.

## Setup

### A. Mobile web
1. On the dev machine: `pnpm dev --host 0.0.0.0 --port 1420`
2. On the phone (same Wi-Fi): open `http://<dev-machine-lan-ip>:1420`
   - Or expose it with `cloudflared tunnel --url http://localhost:1420 --http-host-header localhost:1420` and open the printed `https://*.trycloudflare.com` URL (needed for iOS Safari testing from outside the LAN).
3. Sign in (or seed via the fake agent for UI-only checks).

### B. Tauri Android app
1. Prereqs: Android Studio + SDK, USB debugging enabled, device connected
   (`adb devices` lists it).
2. From the repo root: `pnpm tauri android dev` (first run downloads the
   Android target and takes a while).
3. Sign in inside the app.

## Pass criteria (both runtimes unless marked)

### 1. Shell & navigation — `/print`, `/history`
- [ ] Bottom bar shows exactly 5 slots: Print, History, Templates, Printers, More.
- [ ] Each slot is thumb-tappable; active page is highlighted.
- [ ] More opens a bottom sheet with Designer, API Explorer, Settings; tapping one navigates and closes the sheet.
- [ ] Header shows a compact sync dot at 360px wide (no overlap, no truncation of the app name).
- [ ] Notch / gesture bar: header and bottom nav clear them (no overlap).
- [ ] Rotate to landscape: sidebar collapses to the icon rail, wide search becomes an icon, content is usable in ~340px height.

### 2. Print — `/print`
- [ ] Sticky `[Printer ▾] [Print]` bar stays visible while scrolling; Print state/disabled reason shows there.
- [ ] With "Use test data" on, Data URL / Method / Copies / Pages move into Advanced options; main card stays short.
- [ ] A real print (or test page) succeeds from the sticky bar.

### 3. History — `/history`
- [ ] Filters button opens a labeled bottom sheet (Status, Source, Test jobs, Printer, From, To) with Apply/Reset footer.
- [ ] Setting a filter shows a removable chip under the search box; removing the chip restores rows.
- [ ] Rows render as cards (job + status visible, no sideways scroll); ⋯ menu holds View/Reprint/Retry/Delete.
- [ ] Selecting rows shows the sticky bulk bar above the bottom nav.

### 4. Printers — `/printers`
- [ ] Connection tabs scroll with an edge fade; counts look right.
- [ ] Cards show name, address, status icon + word ("Not checked" has an icon), connection info, full-width Test print.
- [ ] ⋯ menu edits and removes (Remove confirms).

### 5. Templates — `/templates`
- [ ] Cards show name, summary, status, page size; Sort dropdown reorders them.
- [ ] ⋯ menu prints, saves, refreshes, deletes (each confirms where the desktop UI confirms).
- [ ] Tapping a Mine card opens the Designer.

### 6. Designer — `/` then a template
- [ ] Sticky bar holds the view tabs + Save; tabs switch Canvas/Code/README/Sample data.
- [ ] Settings button opens the bottom sheet (Templates/Page Setup/Custom input collapsed); expanding Page Setup edits width/height and the canvas resizes.
- [ ] Canvas toolbar shows real dimensions (`100 × 150 mm` style).
- [ ] **Pinch in/out scales the page**; **double-tap toggles 100%/fit**; one-finger drag still pans.
- [ ] Code tab: lines wrap (no horizontal scroll inside the editor), Done dismisses the keyboard.
- [ ] Edit → Save reaches the server (or the expected offline error).

### 7. Settings — `/settings`
- [ ] Phone shows a section list (8 rows with summaries), not the tab strip.
- [ ] Tapping a section opens it with a Back arrow; Back returns to the list.
- [ ] Deep link `/settings?section=api` opens the detail directly.
- [ ] curl sample wraps instead of clipping.

### 8. Keyboard & inputs (web: iOS Safari matters most)
- [ ] Focusing any field does **not** auto-zoom the page (16px rule).
- [ ] Soft keyboard opens/closes cleanly on every form; sticky bars (Print, Designer save, History bulk) stay reachable with the keyboard open.

### 9. Offline (both runtimes)
- [ ] Airplane mode: header shows the offline badge, banner appears, cached pages still render.
- [ ] Reconnect: state recovers without a reload.

### 10. Tauri WebView flags (Android app only)
- [ ] Status-bar / gesture-nav insets: no overlap (compare with Chrome on the same device).
- [ ] System back button/gesture navigates back (does not kill the app from a sub-page).
- [ ] No jank in canvas pinch or long card lists; cold start time is sane.

## Report back

One entry per failure (a passing run needs only "all green + device/runtime"):

```
Device: <e.g. Pixel 8 / Chrome 131> / <e.g. Galaxy A54 / Tauri app>
Area: <e.g. Designer canvas>
Expected: <pinch scales the page>
Actual: <page jumps to 25% and sticks>
Screenshot/recording: <attached>
```

Fixes land as follow-ups on `develop`; re-run the affected section after each fix.
