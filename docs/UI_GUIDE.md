# UI guide

How the PrintNinja interface is put together, so new screens match the rest.

Read this before adding a page or a component. The code is the source of truth: where this
guide names a file, open it for the exact behaviour.

## Contents

1. [Principles](#principles)
2. [Where things live](#where-things-live)
3. [App shell and navigation](#app-shell-and-navigation)
4. [Pages](#pages)
5. [Tokens, type and shape](#tokens-type-and-shape)
6. [Status vocabulary](#status-vocabulary)
7. [Components](#components)
8. [Feedback and states](#feedback-and-states)
9. [Forms](#forms)
10. [Dialogs and sheets](#dialogs-and-sheets)
11. [Table or card?](#table-or-card)
12. [Density](#density)
13. [Branding](#branding)
14. [Responsive and touch](#responsive-and-touch)
15. [Accessibility](#accessibility)
16. [Copy and translation](#copy-and-translation)
17. [Page checklist](#page-checklist)
18. [Tests that guard the UI](#tests-that-guard-the-ui)
19. [Windows and Android](#windows-and-android)
20. [Known gaps](#known-gaps)

## Principles

- Restrained and legible. Teal marks the brand and the active place; it is never used for success or failure.
- One light theme. No dark variants, no `dark:` classes.
- State is always colour **and** icon **and** word.
- Sentence case. Buttons name the action ("Save changes", "Publish template"), and the toast repeats the verb.
- Printing is physical, so anything that sends a job or deletes data names the thing and asks first.
- The app keeps working when the network does not. Printing and local editing never wait for the share service.

## Where things live

| What | Where |
|---|---|
| Routes and start-up order | `src/App.tsx` |
| Providers (query client, prefs, toaster) | `src/main.tsx` |
| Pages | `src/pages/` |
| Shared components | `src/components/` |
| Designer pieces | `src/components/designer/` |
| Primitives (shadcn style, built on Radix) | `src/components/ui/` |
| Navigation list and "G then key" shortcuts | `src/lib/shell/nav.ts`, `src/lib/shell/useGlobalShortcuts.ts` |
| Colours, density, base styles | `src/index.css` |
| Tailwind theme (`h-control`, status colours) | `tailwind.config.ts` |
| Appearance and branding settings | `src/lib/prefs/` |
| Translations | `src/lib/i18n/index.ts` |
| Live component reference (dev only) | `src/pages/UiKit.tsx`, served at `/__ui` |

Libraries in use: Tailwind CSS, Radix UI primitives, `lucide-react` icons, `sonner` toasts,
`@tanstack/react-table`, `cmdk` (command palette), `react-i18next`. Use these rather than
adding a second library for the same job. Join class names with `cn()` from `src/lib/utils.ts`.

## App shell and navigation

### Start-up order

`AuthGate` → first-run `Onboarding` → `Layout` with the routes.

- **AuthGate** shows a spinner while it checks the session, `SignInScreen` when there is no
  valid session, and `ServerUnreachableScreen` (Retry, Change server) when the share service
  cannot be reached at start-up. Nothing inside it is mounted until the server accepts a session.
- Once the app has opened, the gate never blocks on the network. If the server drops, printing
  and local editing carry on. Only a 401 or an explicit sign-out brings the sign-in screen
  back, and the app stays mounted but hidden, so unsaved edits are still there after signing in.
- **Onboarding** is for operators only: three steps and two buttons, "Start printing" (opens
  `/print`) and "Set up this workstation" (opens `/settings?section=setup`). Printer, template
  and sharing setup is an admin job and lives in the Settings checklist.

### Layout

`src/components/Layout.tsx` is the only shell. Pages render inside it and never draw their own
top bar or sidebar.

- **Top bar** (48 px): logo and app name (from branding), search field that opens the command
  palette, share-service indicator, help button.
- **Sidebar** (desktop, `md` and up): grouped by the job being done, collapsible to icons.
  The collapsed state is remembered in `localStorage`.
- **Bottom bar** (phones): the same items and labels as the sidebar.
- **Main area**: `<main id="main">`, content capped at 1600 px, with a "Skip to content" link
  as the first focusable element.

### Navigation list

`src/lib/shell/nav.ts` is the single list the sidebar, bottom bar, command palette and
shortcut help all read.

| Group | Items |
|---|---|
| Work | Print, History |
| Build | Designer, Templates |
| Admin | Printers, Settings |

Groups follow the job someone is doing, not the feature list. The Designer is active on both
`/` and `/template/:id`.

### Keyboard shortcuts

| Keys | Action |
|---|---|
| `Ctrl+K` / `⌘K` | Open the command palette (pages, "New template", "Reprint last job", up to 50 templates) |
| `?` | Show the shortcut list |
| `G` then a letter | Go to a page: `P` Print, `H` History, `D` Designer, `T` Templates, `R` Printers, `S` Settings |

Letter shortcuts never fire while typing in an input, textarea, select, editable element or
the code editor. "Reprint last job" asks for confirmation before it prints.

### Adding a page

1. Create the page in `src/pages/` with a `PageHeader`.
2. Add its `<Route>` in `src/App.tsx`.
3. Add an entry to a group in `src/lib/shell/nav.ts` with an icon, a label key and an unused
   shortcut letter. The sidebar, palette and shortcut list pick it up.
4. Add the `nav.*` label key in `src/lib/i18n/index.ts`.
5. Add the route to `ROUTES` in `src/test/smoke.test.tsx`.

## Pages

| Route | Page | Main building blocks |
|---|---|---|
| `/` and `/template/:id` | Designer | `PageHeader` with `DesignerToolbar` (New, Import, Export); `TemplateSyncBar` (Save, Refresh, Publish, Unpublish) under the title row; At `lg` and up a three-region workspace that fills the viewport: `ControlsAccordion` (Templates, Page Setup, Versions, Helpers), `EditorPane` (tabs **HTML**, **CSS**, **README**, **Sample data**) and `CanvasWorkspace` (toolbar with Fit/zoom, then `CanvasPane`), the last two split by a draggable `ResizableHandle`. Below `lg`: a collapsed `ControlsAccordion`, then tabs **Canvas**, **Code** (`CodeEditors`), **README** and **Sample data** |
| `/templates` | Templates | Tabs **Mine**, **Saved**, **Community**. Mine and Saved are `DataTable`s; Community is a card gallery with sort and a preview dialog |
| `/print` | Print | "Print job" card (printer, template, copies, options such as grayscale and test data), a live preview, and a banner that says "Print sent" or "Print failed" |
| `/printers` | Printers | `DataTable` of printers with their status; "Add printer" opens a side sheet |
| `/history` | History | `DataTable` of jobs with `JobStatusBadge`; reprint, retry and delete, one at a time or in bulk, with a confirmation |
| `/settings` | Settings | Sections opened with `?section=`: `setup` (checklist), `general` (appearance, branding, density), `share`, `api`, `data`, `retention`, `diagnostics`. An unknown value opens General |
| `/__ui` | UI kit | Development only; not in production builds |

Unknown paths redirect to `/`.

## Tokens, type and shape

All colours are CSS variables in `src/index.css` (HSL triplets, so opacity modifiers work),
exposed as Tailwind colours in `tailwind.config.ts`. Use these, never raw palette classes
(`emerald`, `amber`, `slate`…) and never hex values in components.

### Surface and text

| Token | Value | Use |
|---|---|---|
| `foreground` | `#14252B` | Body text |
| `background` | `#F4F7F7` | App surface |
| `card` | `#FFFFFF` | Cards, tables, dialogs, top bar, inputs |
| `popover` | `#FFFFFF` | Menus, tooltips |
| `muted` / `secondary` | `#EBF0F0` | Quiet fills (skeletons, icon tiles, secondary buttons) |
| `muted-foreground` | `#44575D` | Secondary text |
| `border` | `#D6E0E0` | Dividers and card borders (decorative) |
| `input` | `#7A8C91` | Form-control borders (3:1 against the surface) |
| `primary` | `#0F6B6B` | Primary actions, focus ring, active nav, links |
| `accent` | `#E3F1F0` | Selected row, active nav background, hover on quiet controls |
| `ring` | `#0F6B6B` | Focus ring |
| `destructive` | `#B42318` | Destructive buttons and form errors |

`*-foreground` tokens pair with their background (`primary-foreground` is white).

### Status colours

Each state is a text colour on its own tint. Use them through `StatusBadge`, not by hand.

| Tone | Text | Tint |
|---|---|---|
| `success` | `#3B6D11` | `#EAF3DE` |
| `warning` | `#9A5B00` | `#FDF1DC` |
| `danger` | `#B42318` | `#FDE8E6` |
| `info` | `#0F6B6B` | `#E3F1F0` |
| `neutral` | `#44575D` | `#EBF0F0` |

`info` shares the brand teal, so an info state never means "good" or "bad". Success and
failure always use green and red, together with an icon and a word.

Contrast pairs are asserted in `src/test/tokens.test.ts`; change a token and that test tells
you if it broke AA (4.5:1 for text, 3:1 for control borders and the focus ring).

### Type

IBM Plex Sans for the UI, IBM Plex Mono for IDs, addresses, JSON, code and `kbd` (bundled via
`@fontsource`, so it works offline). Body text is 14 px with a 1.5 line height. Sizes in use:

| Class | Size | Use |
|---|---|---|
| `text-xs` | 12 px | Badges, hints, table meta, keyboard hints |
| `text-sm` | 14 px | Body, controls, table cells |
| `text-base` | 16 px | Card titles, dialog titles, empty-state titles |
| `text-xl` | 20 px | Page title (`PageHeader`), welcome screen |

Tables use tabular numerals. Do not add other sizes. The only app UI that does is a code sample in Settings (`text-[11px]`); print templates have their own CSS and are not part of this scale.

### Shape and elevation

The base radius is `--radius: 6px`. Tailwind's radius classes derive from it:

| Class | Size | Use |
|---|---|---|
| `rounded-lg` | 6 px | Cards, tables, dialogs |
| `rounded-md` | 4 px | Buttons, inputs, selects, menu items |
| `rounded-sm` | 2 px | Badges and status pills |

Cards and tables have a border and no shadow. Only overlays (dialogs, sheets, menus, toasts,
tooltips) get a shadow, over a 80% black backdrop.

### Motion and focus

- Keyboard focus is a 2 px ring in `ring` with a 2 px offset on every element, including ones
  without a ring utility.
- `prefers-reduced-motion` shortens all animation and transitions. The spinner in
  `StatusBadge` only spins under `motion-safe`.

## Status vocabulary

Every job, template and printer state comes from one table in `src/components/StatusBadge.tsx`.
Add new states there, not in pages.

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

- `StatusBadge` takes a `status` key and an optional `label` override ("Done", "Yours") when
  the icon and tone fit but the word should differ. Default labels come from the `status.*`
  translation keys.
- `JobStatusBadge` is for values that come from data (`job.status`). Unknown values render as a
  neutral badge with the raw text instead of crashing.
- Show a state only when it is known: an unchecked printer or setup step says "Not checked" in
  muted text, not "Offline" or "To do".

## Components

### Shared components

| Need | Use |
|---|---|
| Page title, description, actions | `PageHeader` (one per page, the only `h1`; the primary action goes last) |
| A list the user scans, sorts, or acts on per row | `DataTable` |
| A state | `StatusBadge` / `JobStatusBadge` |
| "Are you sure?" | `ConfirmDialog`, naming the thing ("Delete template “Shipping label”?") |
| Nothing here yet | `EmptyState`, saying what happened and what to do next |
| Template sync state with the server | `TemplateSyncBar` |
| Logo with fallback | `AppLogo` |
| First-run, sign-in and unreachable screens | `Onboarding`, `SignInScreen`, `ServerUnreachableScreen` (rendered by `AuthGate` and `App`) |
| Setup progress | `SetupChecklist` (Settings → Setup) |

**`DataTable`** (wraps TanStack Table):

- `caption` is required. It is read by screen readers and not shown.
- Sorting is opt in per column with `enableSorting: true`; sortable headers are buttons with
  `aria-sort`.
- `loading` shows five skeleton rows. `empty` renders an `EmptyState` inside the table.
- `onRowActivate` makes rows focusable and activates them on click, Enter or Space; Up and Down
  arrows move between rows. Pair it with `selectedRowId`.
- `selection` adds a checkbox column with select-all and an indeterminate state.
- `maxHeight` scrolls the body and keeps the header visible; `footer` adds a summary line.
- Hide columns on small screens with `meta: { className: "hidden md:table-cell" }`.

**`EmptyState`** takes `title`, optional `description`, optional `icon` and one optional
`action`. Say what happened and what to do next, for example "No published templates yet" /
"Publish one from Designer to see it here."

**`ConfirmDialog`** takes `title`, `description`, a verb-phrase `confirmLabel`
("Delete template"), `destructive`, `busy` and `onConfirm`. Cancel sits on the left, the
action on the right. Set `destructive` for deletes.

### Primitives in `src/components/ui/`

`Button` (variants `default`, `secondary`, `outline`, `ghost`, `destructive`, `link`; sizes
`default`, `sm`, `lg`, `icon`), `Input`, `Textarea`, `Label`, `Select`, `Switch`, `Tabs`,
`Card`, `Badge`, `Dialog`, `Sheet`, `DropdownMenu`, `Table`, `Skeleton`, `Progress`,
`Separator`, `Tooltip`, and the `Toaster`.

- Use `Button` with `asChild` around a `Link` when a button navigates.
- Use `Badge` only for plain labels. For states use `StatusBadge`.
- Icons come from `lucide-react`, sized `h-4 w-4` inside buttons and `aria-hidden="true"` when
  next to text.
- For short hints on icon buttons the app uses the native `title` attribute. The `Tooltip`
  primitive exists but nothing uses it yet.

A live reference of every primitive in every state is at `/__ui` in dev builds (`pnpm dev`).
It is excluded from production builds. When you add a shared component, add it there.

## Feedback and states

Every screen that loads data handles four states, each saying what happened and what to do:

| State | Pattern |
|---|---|
| Loading | `Skeleton` rows (the `DataTable` does this with `loading`) or a small spinner when a whole screen is waiting (sign-in check, first-run check) |
| Empty | `EmptyState` with a next action |
| Error | Inline message with a retry action, for example "Can’t reach the share service" with "Try again" |
| Offline or not configured | Say so and point to the fix ("Add a share service address in Settings"). Local features keep working. |

**Toasts** (`sonner`, from `toast`) confirm the result of an action the person just took.
The `Toaster` is mounted once in `src/main.tsx`; do not mount another.

- Success: repeat the verb ("Template exported", "Version 3 saved", "Unpublished").
- Error: say what failed, not just "Error" ("Template name required"). When an exception
  has a useful message, show it.
- Toasts disappear, so never put the only copy of important information in one. Errors that
  need a decision stay on the page.

**Inline messages** use `role="alert"` and the `danger` or `destructive` text colour. A
blocking problem inside a panel can use a `danger-soft` background with a `danger` border
(see the Templates preview error).

## Forms

- Every control has a visible `Label`, or an `aria-label` when the context makes a visible one
  redundant (search fields, table checkboxes).
- Explain format and limits next to the field in `text-xs text-muted-foreground`, and link it
  with `aria-describedby`.
- On error set `aria-invalid` on the field, show the message below it with `role="alert"`, and
  link it with `aria-describedby`.
- Disable the action button while it runs and change its label (the Retry button on the unreachable screen becomes "Trying again..."). `ConfirmDialog` does this with `busy`.
- Form content in Settings is capped at `max-w-3xl` (768 px) so lines stay readable. Tables
  and the Designer use the full width.
- Controls in use: `Switch` for on or off (Print options, Settings), `Select` for a list of
  choices, and `Tabs` to switch between views of the same page (Templates, Settings, Printers).

## Dialogs and sheets

- **Dialog** for a decision or a short task: confirm, rename, preview, "Get from server".
  Default width is `max-w-lg`; wide previews use `max-w-2xl` or `max-w-3xl`.
- **Sheet** (slides in from the side) for a longer form that should keep the list visible
  behind it. The "Add printer" panel on the Printers page is the only use today.
- Title says what the dialog does, in the same words as the button that opened it. The close
  button and Escape always work.
- Footer: Cancel on the left, the action on the right, destructive actions in the `destructive`
  variant. On phones the footer stacks with the action on top.

## Table or card?

- **Table** when people compare rows, sort, filter, or act per row: History, Printers,
  Templates (Mine and Saved).
- **Card** only when a preview is the point of browsing: the Community gallery.
- Cards also group related content on Settings and the first-run screens.

## Density

Settings → General offers **Comfortable** (default) and **Compact**. It sets `data-density` on
`<html>`, which changes three variables:

| Variable | Comfortable | Compact | Used by |
|---|---|---|---|
| `--control-h` | 36 px | 32 px | `h-control` on Button, Input, Select, nav links |
| `--head-h` | 40 px | 32 px | Table header height |
| `--cell-py` | 10 px | 4 px | Table cell padding |

Touch screens (`pointer: coarse`) ignore Compact and keep the Comfortable sizes. Use
`h-control` / `w-control` for anything that should follow density, not a fixed `h-9`.

## Branding

Optional. Settings → General stores an app name and logo (PNG, JPEG, WebP or SVG up to 256 KB)
as the `brand_name` and `brand_logo` settings. They apply to the top bar, the window title and
the welcome screen. Leaving them empty gives PrintNinja. Read them with `usePrefs()` rather
than hardcoding the product name in new UI, and use `AppLogo` to show the logo.

## Responsive and touch

- The layout switches at the `md` breakpoint (768 px): sidebar and search field above, bottom
  bar and a search icon below.
- The share indicator is hidden below `sm`. Do not rely on anything in the top bar being
  visible on a phone.
- The top and bottom bars respect the device safe areas (`env(safe-area-inset-*)`).
- On touch screens, buttons, inputs, selects and palette rows keep a 44 px minimum height.
- Test at 390 px and 1440 px, and at 125% and 150% Windows scaling (see
  [Windows and Android](#windows-and-android)).

## Accessibility

- One `h1` per page, supplied by `PageHeader`. Section headings follow in order.
- The first focusable element is the "Skip to content" link, and `main` receives focus when it
  is used.
- Active navigation uses `aria-current="page"`. Navigation regions have a label.
- Icon-only buttons have an `aria-label` (and a `title` for sighted users). Decorative icons are
  `aria-hidden`.
- Tables have a `caption`; sortable headers expose `aria-sort`.
- State is never colour alone: always an icon and a word.
- Everything works with the keyboard alone, with a visible focus ring. Dialogs trap focus and
  return it to the control that opened them (Radix does this; do not break it with custom
  portals).
- Respect `prefers-reduced-motion`.

## Copy and translation

- Sentence case everywhere. Buttons are verbs naming the result. Dialog titles name the thing
  being changed. Errors say what happened and what to do next.
- The app currently ships English only (`lng: "en"`, one `en` resource in
  `src/lib/i18n/index.ts`). The shell (navigation, palette, shortcuts, sign-in) and status
  labels use `t()` keys. Some pages and components still use plain English strings
  (Onboarding, SetupChecklist, most Designer and Templates toasts).
- New shell, navigation and shared-component text should use a `t()` key. Page-level text
  may stay plain until everything moves into `src/lib/i18n`, which is deferred until a second
  language is needed. Do not mix a key and a literal in the same sentence.

## Page checklist

- `PageHeader`; semantic tokens and `StatusBadge` only.
- Loading, empty, error, and offline states each say what happened and what to do.
- Destructive actions name the item and ask first.
- Toasts repeat the verb; errors say what failed.
- Works at 390 px and 1440 px, and at 125% and 150% Windows scaling.
- Full keyboard path, visible focus, names on icon-only buttons.
- Added to the navigation list, the shortcut letter is unused, and the route is in the route
  smoke tests, which run axe on every page.
- Shown in `/__ui` if it adds a shared component.

## Tests that guard the UI

All run with `pnpm test` (Vitest) and in CI (`web-check`). A failing one blocks the release.

| Test | What it enforces |
|---|---|
| `src/test/noRawColors.test.ts` | No raw palette classes (`bg-emerald-500`, `text-slate-600`…) in `src/pages` or `src/components`. It does not catch arbitrary values like `bg-[#fff]`, so review those by eye |
| `src/test/tokens.test.ts` | Contrast pairs meet AA, the stylesheet has one light theme and no `.dark` block |
| `src/test/smoke.test.tsx` | Every route renders in the shell with no console errors, exactly one `main`, an `h1`, and no axe violations. Colour contrast and landmark-region rules are off because jsdom has no layout; contrast is covered by `tokens.test.ts` |
| `src/test/components.test.tsx` | `StatusBadge` (word and icon for every state), `PageHeader`, `DataTable` (sorting, keyboard, loading, empty) and `ConfirmDialog` |
| `src/test/shell.test.tsx` | Navigation groups, unique go-to keys, `Ctrl+K`, `G` then a letter, the help dialog, and that nothing fires while typing |
| `src/test/android-theme.test.ts` | The Android theme patch gives light bars and is safe to run twice |

When you add a page, add it to `ROUTES` in the smoke test. When you add a status, the
`StatusBadge` table is the only place to change.

## Windows and Android

- **Windows:** `tauri.conf.json` forces the light window theme and sets a matching background
  (`#F4F7F7`), so the title bar is light whatever the OS theme is. The window title follows the
  app name from branding.
- **Android:** the project in `src-tauri/gen/android` is generated. After `tauri android init`,
  run `node scripts/patch-android-theme.mjs` (CI does this) for light status and navigation
  bars.
- **Scaling check (manual):** screens must stay usable at 125% and 150% Windows scaling.
  `scripts/capture-screens.mjs` takes screenshots of every route:
    1. `pnpm dev` in one terminal.
    2. In another, once: `npx playwright install chromium` (Playwright is not a project
       dependency, so install it where you run the script).
    3. `node scripts/capture-screens.mjs` for desktop (1440 × 900) and phone (390 × 844), or add
       `--dpi` for 1080p and 768p screens at 125% and 150%. Screenshots go to `docs/ui-baseline`
       unless you pass another folder.
    4. Look for clipped text, hidden buttons and overflowing tables.

## Known gaps

Be aware of these before copying existing code:

- Quotes in toasts and titles are mixed: some use plain `"` and some use curly “ ”.
- Some fixed English strings sit inside shared components (`ConfirmDialog` default "Cancel",
  `Dialog` close label, `DataTable` checkbox labels), so they do not translate yet.
- `Tooltip` and `Progress` exist as primitives but nothing uses them yet; the app uses native
  `title` hints.
- The Designer and Print pages are large single files. Prefer extracting pieces into
  `src/components/designer/` rather than growing them.
