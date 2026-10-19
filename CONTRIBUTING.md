# Contributing to PrintNinja

## Branching and workflow

- `main` is the release branch. Push target is the fork `SAR-dev/PrintNinja` (`git push fork main`); `origin` (`sayed-rafi-bd/PrintNinja`) may be read-only in CI. After access was fixed, both remotes are writable — keep them in sync.
- One fix per commit, one `IMPROVEMENTS.md` row per commit when that file existed. Now that it is removed, keep commits focused and add a regression test for each bug fix.
- Conventional commits: `fix(scope): … (#n)` / `feat(print): …` / `chore: …`.

## Local setup

```bash
pnpm install
pnpm dev --host 0.0.0.0
cargo test --manifest-path src-tauri/Cargo.toml
```

If the disk is 32 G, `target/` can hit 5–7 G — `cargo clean` when needed and use `CARGO_INCREMENTAL=0 cargo test`.

In a browser (no Tauri IPC) settings fall back to the `localStorage` key `printninja-setting:<key>`.

## Code style

- **Biome** is minimal: `recommended` rules only, formatter disabled. Scope `src/**/*.{ts,tsx}`, `index.html`, `vite.config.ts`. Do not make it stricter.
- `tsc --noEmit` must be clean.
- Rust: `cargo clippy -- -D warnings` must pass (CI `rust-check` fails on warnings, no `|| true`).
- No emojis in code or commits unless requested.

## Frontend

- Tailwind is compiled per template, not loaded from a CDN and not shared. `compileTemplateCss` (Tailwind v4, installed as the `tailwind4` alias; the app shell stays on v3) compiles the classes `extractClasses` finds in a template's HTML and the result is stored with the version as `compiled_css`. The Rust print path inlines the same CSS.
- In a template, write every class name in full in each branch (`{{#if urgent}}bg-red-600{{else}}bg-green-600{{/if}}`). A name built from data (`bg-{{color}}-500`) cannot be compiled; use a CSS variable (`style="--c:{{color}}" class="bg-[var(--c)]"`).
- Changing `compileTemplateCss` output (its input CSS or post-processing)? Bump `COMPILER_REV`, which is part of the key stored with each compiled stylesheet. Existing versions are not recompiled automatically; they pick up the change when their template is next saved.
- Barcodes: `bwip-js` `toSVG()` → inline SVG via `buildBarcodeHtml` (no `canvas.toDataURL`). Friendly id → `bcid` mapping lives in `src/lib/utils/barcode.ts` (`itf→interleaved2of5`, `codabar→rationalizedCodabar`, `aztec→azteccode`, `qr→qrcode`).
- `renderTemplate` registers Handlebars helpers once (`helpersRegistered`); `padLeft` honours the pad char and `date` parses RFC 3339.
- `PrintQueue` is `Clone + Send + Sync` (`Arc<Mutex<HashMap<String, Semaphore>>>`, `&self` everywhere, `with_permit`). `PrinterTransport::discover(&self)` must stay `dyn`-dispatchable.
- `POST /v1/print` runs the real pipeline (`run_print` with `cache_dir` + `DbState` + `PrintQueue`) — it must not return a fake `202 queued`.

## Backend

- DB: `src-tauri/src/db/schema.sql` (11 tables, `IF NOT EXISTS`). `DbState = Arc<Mutex<Database>>` managed in `src-tauri/src/lib.rs:setup`; eager `rusqlite` `execute_batch` plus lazy `tauri-plugin-sql` migrations is intentional.
- `DataFetcher` whitelists methods (`GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS`, default `GET`) and enforces `max_size` on `bytes.len()` (not just `Content-Length`).
- `percent_decode` handles `+` → space and delegates to `urlencoding`.
- `verify_key` is constant-time XOR.

## Testing

Run before pushing:

```bash
pnpm lint
pnpm test
npx tsc --noEmit
cargo test --manifest-path src-tauri/Cargo.toml
```

Add a regression test for each fix (Vitest `src/test/*`, Rust `#[cfg(test)]` or `src-tauri/tests/*`).

## Release

Local-only signing. See `docs/RELEASE.md` and `scripts/release.sh` (rename app, bump version, `git tag`). CI builds Windows MSI only and Android `aarch64` only.

## Commit checklist

- [ ] `pnpm lint` / `pnpm test` / `tsc` / `cargo test` green
- [ ] New/changed behaviour has a regression test
- [ ] `COMPILER_REV` bumped if the compiled template CSS changes
- [ ] No `window.open` for preview (use `setActiveTab("preview")`), no `canvas.toDataURL("image/svg+xml")`, no `cdn.tailwindcss.com`
