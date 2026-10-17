# PrintNinja

Silent print for Windows and Android — design HTML templates, fetch JSON data, print via IPP / raw TCP / USB / Bluetooth / system spooler, with history, batch, profiles, and automation.

![Tauri 2](https://img.shields.io/badge/Tauri-2-blue) ![React](https://img.shields.io/badge/React-19-blue) ![Rust](https://img.shields.io/badge/Rust-stable-orange)

## Features

- **Designer** — HTML/CSS (CodeMirror) + visual canvas, page presets (A4, 80 mm roll, 4×6 label…), zoom, Handlebars helpers (`currency`, `date`, `padLeft`…), `bwip-js` barcodes (14 symbologies → inline SVG), custom fonts, version history with diff/restore
- **Print** — printer + template selectors, data URL / test-data switch, orientation / margins / fit mode / copies, live preview, batch (JSON array or CSV upload with column mapping), per-printer profiles
- **Printer Setup** — Wi-Fi/LAN (IPP / raw TCP 9100), USB, Bluetooth, system spooler; test print, validation, language/paper/DPI
- **History** — filters (status/source/printer/search + date range), batch-grouped expandable rows, reprint/retry/delete, CSV export (RFC 4180), retention
- **Automation** — local REST API (`axum`, `127.0.0.1:17717`, Bearer + idempotency, CORS scoped, LAN off by default) and `printninja://` deep links with trust list and confirmation sheet
- **Queue** — per-printer `Semaphore` (no byte interleaving), bounded admission, `POST /v1/print` runs the same pipeline as the UI

## Tech Stack

| Layer | Choice |
|---|---|
| App shell | Tauri 2 (Windows + Android) |
| UI | React 19 + Vite 7 + TypeScript 5 + Tailwind 3 + shadcn/ui + Zustand + TanStack Query/Table |
| DB | SQLite (`tauri-plugin-sql` migrations + `rusqlite` commands) — 11 tables |
| Template | Handlebars (singleton registry), `buildTemplateCss` inlines a committed minified Tailwind bundle (`pnpm build:templates:css`) |
| Barcodes | `bwip-js` `toSVG()` (inline SVG, no canvas data-URI) |
| API | `axum` + `tower-http` |
| Secrets | `keyring` (redacted from `print_jobs` / diagnostics) |
| Android | Kotlin plugins: WebView → PDF, `UsbManager`, RFCOMM |

## Architecture

```
UI (Designer / Print / PrinterSetup / History) ──invoke()──► Rust core
                                                          Data fetcher → Handlebars → Layout (@page) → PDF → Queue (per-printer) → Transport (ipp/raw_tcp/usb/bt/spooler) → History
REST API ──┐
Deep link ─┼──► same queue/pipeline (idempotency, copies, redaction)
Batch ─────┘
```

`DbState = Arc<Mutex<Database>>` (`sqlite:` URL → `rusqlite` path) is `manage()`d as Tauri state; `PrintQueue` is `Clone + Send + Sync` with `Arc<Mutex<HashMap<String, Semaphore>>>`; `PrinterTransport::discover(&self)` is `dyn`-dispatchable via `TransportRegistry`.

## Data Model

`printers` · `templates` + `template_versions` · `sample_datasets` · `fonts` · `printer_profiles` (unique `printer_id, template_id`) · `presets` · `batches` · `print_jobs` (`batch_id` + `idempotency_key`) · `api_clients` · `settings` · see `src-tauri/src/db/schema.sql`.

## Project Structure

```
src/                         # React
  pages/Designer  Print  PrinterSetup  History  Settings
  components/ui  Layout  VisualDesigner
  lib/{store,render,templates,hooks,utils}
  styles/templates.src.css   # print stylesheet source → templates.generated.ts
src-tauri/src/
  commands/{print,printer,template,version,history,batch,font,profile,settings,api}
  api/{routes,auth,openapi}  queue.rs  transport/{ipp,raw_tcp,windows_*,android_bridge}
  data/fetcher.rs  deeplink.rs  render/handlebars.rs
```

## Getting Started

```bash
pnpm install
pnpm dev --host 0.0.0.0   # http://localhost:1420  (LAN http://<ip>:1420)
cargo test --manifest-path src-tauri/Cargo.toml
```

Prerequisites: Node 22, Rust stable, pnpm 10; for Android: Java 17, Android SDK/NDK 27+.

### Scripts

| Command | Purpose |
|---|---|
| `pnpm dev` | Vite dev server |
| `pnpm build` | `tsc -b && vite build` (runs `prebuild` → `build:templates:css`) |
| `pnpm build:templates:css` | Tailwind → `src/lib/templates/templates.generated.ts` (commit the output) |
| `pnpm lint` / `pnpm format` | Biome (`src/**/*.{ts,tsx}` + `index.html` + `vite.config.ts`) |
| `pnpm test` | Vitest (jsdom) |
| `pnpm test:e2e` | Playwright (`http://localhost:1420`, `localStorage["printninja-onboarding-complete"]="true"` bypass) |
| `cargo test` (in `src-tauri`) | Rust (lib + integration) — `CARGO_INCREMENTAL=0 cargo test` on low-disk hosts |

## Building

```bash
pnpm tauri:build              # Windows MSI (x86_64-pc-windows-msvc)
pnpm tauri:build -- --target aarch64-linux-android   # Android (arm64)
```

CI builds MSI only and Android `aarch64` only (unsigned, attached to a draft GitHub Release on `v*` tags); signing is local-only (`docs/RELEASE.md`, `scripts/release.sh`).

## REST API

Disabled by default, `127.0.0.1:17717`. `Authorization: Bearer pn_live_…`, optional `Idempotency-Key`. `POST /v1/print` requires `template` + `printer` + `data` and reports the real outcome (`200` success, `400` missing template, `404` printer/template, `500` transport). `GET /v1/openapi.json` is the contract (also behind auth).

## Deep Links

`printninja://print?template=…&printer=…&url=…&copies=…` etc.; `printninja://open/history`, `printninja://template/{id}`. Confirmation sheet unless source is trusted.

## Testing

- `vitest` — barcode SVG vs data-URI, encoder-name mapping, template helpers, Tailwind bundle safelist drift, history CSV/date logic
- `cargo test` — queue serialisation/parallelism, `Box<dyn PrinterTransport>` dispatch, idempotency, `print_runs_the_real_pipeline` (was lying `202 queued`)
- `playwright` — nav at 280–430 px, barcode dialog, batch, font, onboarding bypass

## License

Proprietary — all rights reserved. See `CONTRIBUTING.md` for development notes.
