# UI guide

How the PrintNinja interface is put together, so new screens match the rest.

## Principles

- Restrained and legible. Teal marks the brand and the active place; it is never used for success or failure.
- One light theme. No dark variants, no `dark:` classes.
- State is always colour **and** icon **and** word.
- Sentence case. Buttons name the action ("Save changes", "Publish template"), and the toast repeats the verb.

## Tokens

All colours are CSS variables in `src/index.css`, exposed as Tailwind colours. Use these, never raw palette classes (`emerald`, `amber`, `slate`…). `src/test/noRawColors.test.ts` fails the build if one appears.

| Token | Value | Use |
|---|---|---|
| `foreground` | `#14252B` | Body text |
| `background` | `#F4F7F7` | App surface |
| `card` | `#FFFFFF` | Cards, tables, dialogs, top bar |
| `border` | `#D6E0E0` | Dividers |
| `input` | `#7A8C91` | Form-control borders (3:1 against the surface) |
| `primary` | `#0F6B6B` | Primary actions, focus ring, active nav |
| `accent` | `#E3F1F0` | Selected row, active nav background |
| `muted-foreground` | `#44575D` | Secondary text |

Contrast pairs are asserted in `src/test/tokens.test.ts`; change a token and that test tells you if it broke AA.

**Type.** IBM Plex Sans for the UI, IBM Plex Mono for IDs, addresses, JSON and code (bundled, so it also works offline). Base size 14 px; scale 12 / 13 / 14 / 16 / 20 / 24. Tables use tabular numerals.

**Shape.** 6 px radius on controls and cards, 4 px on badges. Cards have a border and no shadow; only overlays get a shadow.

## Status vocabulary

Every job, template, and printer state comes from one table in `src/components/StatusBadge.tsx`. Add new states there, not in pages.

| State | Tone | Icon | Used for |
|---|---|---|---|
| `success` | Success | Check circle | Printed |
| `failed` | Danger | X circle | Failed |
| `queued` | Warning | Clock | Queued, To do |
| `printing` | Info | Spinner | Printing |
| `cancelled` | Neutral | Ban | Cancelled |
| `draft` | Warning | Pencil | Draft, unpublished changes |
| `published` | Success | Globe | Published |
| `saved` | Info | Bookmark | Saved copy |
| `withdrawn` | Neutral | Eye off | Withdrawn by author |
| `online` | Success | Wifi | Printer or share service reachable |
| `offline` | Danger | Wifi off | Unreachable |

`StatusBadge` accepts a `label` override ("Done", "Yours") when the icon and tone fit but the word should differ. Show a state only when it is known: an unchecked printer says "Not checked", not "Offline".

## Components

| Need | Use |
|---|---|
| Page title, description, actions | `PageHeader` (one per page, the only `h1`) |
| A list the user scans, sorts, or acts on per row | `DataTable` |
| A state | `StatusBadge` |
| "Are you sure?" | `ConfirmDialog`, naming the thing ("Delete template “Shipping label”?") |
| Nothing here yet | `EmptyState`, saying what happened and what to do next |
| Anything else | The primitives in `src/components/ui/` |

A live reference of every primitive in every state is at `/__ui` in dev builds (`pnpm dev`). It is excluded from production builds.

## Table or card?

- **Table** when people compare rows, sort, filter, or act per row: History, Printers, Templates (Mine and Saved).
- **Card** only when a preview is the point of browsing: the Community gallery.
- **Form** content caps at 720 px. Tables and the Designer use the full width.

## Density

Settings → General offers **Comfortable** (default) and **Compact**. It sets `data-density` on `<html>`, which changes three variables:

| Variable | Comfortable | Compact | Used by |
|---|---|---|---|
| `--control-h` | 36 px | 32 px | `h-control` on Button, Input, Select, nav links |
| `--head-h` | 40 px | 32 px | Table header height |
| `--cell-py` | 10 px | 4 px | Table cell padding |

Touch screens (`pointer: coarse`) ignore Compact and every control keeps a 44 px minimum. Use `h-control` / `w-control` for anything that should follow density, not a fixed `h-9`.

## Branding

Optional. Settings → General stores an app name and logo (PNG, JPEG, WebP or SVG up to 256 KB) as the `brand_name` and `brand_logo` settings. They apply to the top bar, the window title, and the welcome screen. Leaving them empty gives PrintNinja. Read them with `usePrefs()` rather than hardcoding the product name in new UI.

## Page checklist

- `PageHeader`; semantic tokens and `StatusBadge` only.
- Loading, empty, error, and offline states each say what happened and what to do.
- Destructive actions name the item and ask first.
- Works at 390 px and 1440 px, and at 125% and 150% Windows scaling.
- Full keyboard path, visible focus, names on icon-only buttons.
- Added to the route smoke tests, which run axe on every page.

## Windows and Android

- **Windows:** `tauri.conf.json` forces the light window theme and a matching background, so the title bar is light whatever the OS theme is.
- **Android:** the project in `src-tauri/gen/android` is generated. After `tauri android init`, run `node scripts/patch-android-theme.mjs` (CI does this) for light status and navigation bars.
- **Scaling:** see the manual check in `docs/ui-baseline/README.md`.

## Not translated yet

Strings are English. Some pages still use `react-i18next` keys and others plain text. Moving everything into `src/lib/i18n` is deferred until a second language is needed.
