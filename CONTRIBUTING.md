# Contributing to PrintNinja

Thanks for helping. This page covers how to set up, what to run before you push, and the project rules that CI and reviewers expect. For an overview of the app, see the [README](README.md).

## Workflow

- `develop` is the integration branch. Open pull requests against it.
- `main` is the release branch. Release tags must point at a commit on `main`.
- Keep commits small and focused: one change per commit, with a regression test for every bug fix.
- Use conventional commit messages: `feat(print): …`, `fix(designer): …`, `docs: …`, `chore: …`.
- CI runs on pushes and pull requests to `develop` and `main`. Release jobs run only on `v*` tags.

## Setup

You need Node 22 or newer, pnpm 10 and Rust 1.90 (pinned in `rust-toolchain.toml`). For Android you also need Java 17 and the Android SDK and NDK.

```bash
pnpm install
pnpm dev                 # web preview at http://localhost:1420
pnpm tauri:dev           # desktop app
```

In a browser there is no Tauri backend, so settings fall back to `localStorage` (key `printninja-setting:<key>`).

For the share service, copy `server/env.example` to `server/.env` and run `pnpm --filter server db:generate` once on a fresh clone, because the Prisma client is gitignored. Every variable is explained in [`docs/ENV.md`](docs/ENV.md).

## Before you push

CI runs these checks. Run the ones that match what you changed.

| Area | Commands |
|---|---|
| App | `pnpm lint`, `pnpm check:tauri-args`, `pnpm build`, `pnpm test` |
| API types | `pnpm gen:api`, then confirm `git diff` is empty |
| Rust | `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`, `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`, `cargo test --manifest-path src-tauri/Cargo.toml` |
| Share service | `pnpm --filter server typecheck`, `pnpm --filter server arch`, `pnpm --filter server test` |
| OpenAPI | `pnpm --filter server openapi:generate`, then confirm `server/openapi/openapi.json` is unchanged |
| End to end | `pnpm e2e` (starts its own local servers and SQLite files, no Docker) |

On a machine with little disk space, `target/` can grow to several GB. Run `cargo clean` when needed and use `CARGO_INCREMENTAL=0 cargo test`.

## Code style

- **TypeScript:** Biome handles formatting (2 spaces) and a small set of lint rules. Run `pnpm lint:fix` and `pnpm format`. Do not make the rules stricter. `tsc` must be clean.
- **Rust:** `cargo fmt` and `cargo clippy -- -D warnings` must pass. Warnings fail CI.
- Keep comments for the "why". No emojis in code or commit messages.

## Project rules

### Frontend

- **Template CSS is compiled per template.** Tailwind v4 (installed as the `tailwind4` alias, the app shell stays on v3) compiles the classes found in a template's HTML, and the result is stored as `compiled_css`. If you change what `compileTemplateCss` outputs, bump `COMPILER_REV`. Existing versions pick up the change the next time their template is saved.
- **Write full class names in templates.** Use `{{#if urgent}}bg-red-600{{else}}bg-green-600{{/if}}` or a CSS variable. A name built from data, such as `bg-{{color}}-500`, cannot be compiled.
- **Barcodes exist twice.** `src/lib/utils/barcode.ts` (bwip-js) draws the preview and `src-tauri/src/render/barcode.rs` draws the print. Change both together so print matches the preview.
- **Tauri command arguments are snake_case.** A command with a multi-word argument needs `#[tauri::command(rename_all = "snake_case")]`. The unit and e2e tests use a fake agent that cannot catch this, so `pnpm check:tauri-args` does.
- **Phones count.** Use the coarse-pointer variant for touch targets (`[@media(pointer:coarse)]:min-h-11`) and the shared queries in `src/lib/hooks/useMediaQuery.ts` for phone layouts. New tables should offer a card layout below `md`.
- **API types are generated.** Do not edit `src/lib/api/schema.d.ts`. Change the server schemas and run `pnpm gen:api`.

### Rust core

- Printing always goes through the real pipeline: data fetch, Handlebars, layout, render, per-printer queue, transport, history. `POST /v1/print`, deep links and the UI share it. Never return a fake "queued" response.
- `PrintQueue` is `Clone + Send + Sync`, and each printer has its own semaphore so jobs never interleave. `PrinterTransport` must stay usable as `dyn` through `TransportRegistry`.
- `DbState` is `Arc<Mutex<Database>>`, managed as Tauri state.

### Share service (`server/`)

- Layers are enforced by `pnpm --filter server arch`: `domain` imports neither `http` nor `infra`, `http` imports only `domain`, and Prisma stays inside `infra`.
- Every error uses the `{ error: { code, message, details?, request_id } }` envelope. `server/openapi/openapi.json` is the contract, and CI fails if it drifts.
- Change the schema with `pnpm --filter server db:migrate` (Prisma migrate dev). Migrations are applied at boot by `db:apply`.

## Testing

Add a regression test for every fix.

- **App:** Vitest and Testing Library in `src/test/`. jsdom has no `matchMedia`, so phone behaviour is tested by stubbing it (see `src/test/mobile.test.tsx`).
- **Rust:** unit tests next to the code and integration tests in `src-tauri/tests/`. `virtual_printer.rs` builds a small virtual printer (vendored in `e2e/support/virtual-printer`) and switches it between `ok`, `paperout`, `jam`, `offline`, `hang` and `drop`. It needs only `cargo` and never skips.
- **Share service:** unit and integration tests in `server/test/` run against local SQLite files. `pnpm --filter server test:e2e` runs over HTTP against a Docker stack (`pnpm --filter server test:e2e:stack`).
- **End to end:** Playwright in `e2e/tests/`. Desktop projects run Chromium. The `mobile-pixel7` and `mobile-small` projects run `*.mobile.e2e.ts` and check sideways scrolling, 44px tap targets, screenshots and axe. Screenshot baselines are Linux images. To update them after an intended layout change, run `pnpm --filter e2e exec playwright test --project=mobile-pixel7 --project=mobile-small --update-snapshots` on Linux and review the diff.

## Releasing

```bash
pnpm release patch       # or minor, major, or X.Y.Z; add --push to push the tag
```

This bumps the version in every manifest CI compares (`pnpm version:set` does only that), commits and tags. Pushing a `v*` tag from `main` builds the Windows MSI, Linux packages and Android APK and attaches them to a draft GitHub Release. Signing is done locally. See [`docs/RELEASE.md`](docs/RELEASE.md) and [`docs/SIGNING.md`](docs/SIGNING.md).

## Pull request checklist

- [ ] The checks above for the code you changed pass
- [ ] New or changed behaviour has a regression test
- [ ] `COMPILER_REV` is bumped if compiled template CSS changes
- [ ] `openapi.json` and `schema.d.ts` are regenerated if the API changed
