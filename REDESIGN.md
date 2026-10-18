# PrintNinja — Corporate UI Redesign Plan

Status: **proposal, palette and single light theme decided (§3, §10), nothing implemented**
Base branch: `v2` (at `0869383`)
Suggested working branch: `v2-ui-corporate`

---

## 1. Goal

Make PrintNinja look and behave like software a company's IT, operations, and warehouse teams
can roll out to many people: calm, dense where it needs to be, predictable, accessible, and
easy to brand. No change to print output, the Rust core, the REST API, or the share service.

**Primary users (confirmed: all three equally):**

| Who | Main job | What they need from the UI |
|---|---|---|
| Print operator (warehouse, front desk) | Pick a template, print, reprint | Few clicks, large targets, clear success/failure |
| Template author (ops / IT) | Build and publish templates | Dense designer, fast preview, clear Draft/Published state |
| IT admin | Configure printers, share service, API | Reliable settings, diagnostics, auditable history |

**Non-goals:** new features in the print pipeline, new backend endpoints, SSO/roles (listed as
questions in §10), changes to template print CSS (`src/styles/templates.src.css`).

---

## 2. Where the UI stands today

Findings from reading `src/` on `v2` (6.5k lines of TSX across 6 pages, 17 `ui/` primitives).

| # | Finding | Evidence | Effect on a corporate look |
|---|---|---|---|
| 1 | Primary colour fails contrast | `--primary: 199 89% 48%` with near-white text is roughly 2.9:1 | Below WCAG AA (4.5:1) for every default button |
| 2 | Consumer-app styling | `--radius: 0.75rem`, `rounded-full` badges, cyan accent, "Tip: collapse for more canvas." in the sidebar | Reads as a hobby tool, not an enterprise one |
| 3 | Status colours are ad hoc | Raw `emerald`, `amber`, `violet`, `slate`, `green`, `yellow`, `cyan` classes in pages; `Badge` has `success` and `warning` but pages bypass them | Same state looks different on different screens |
| 4 | No shared page header | `h1` is `text-2xl` in Designer and Templates, `text-3xl` elsewhere | Pages feel unrelated |
| 5 | Nav semantics | Printers uses a `FileText` icon; logo is a generic `Printer` icon; mobile header and desktop header differ | Weak identity and wayfinding |
| 6 | Hardcoded strings | `"Templates"`, `"Visual"`, `"README"`, sidebar tip, `"Expand sidebar"` bypass `i18next` | Blocks localisation, which corporate rollouts need |
| 7 | Controls sized for touch everywhere | `h-10` default, `min-h-11` nav, `max-w-7xl` container with `p-8` | Wastes space on desktop where operators scan tables |
| 8 | Fonts depend on the machine | `Inter` is named but not bundled | Different rendering per workstation; offline-hostile |
| 9 | Large screen files | `Designer.tsx` 1,428 lines, `Print.tsx` 826, `Settings.tsx` 799 | Visual changes are risky unless structure is touched carefully |
| 10 | Tests cover logic only | `src/test/*` has store, render, barcode tests; no component or visual tests | No safety net for a UI overhaul |

---

## 3. Design direction

Corporate here means **restrained, legible, trustworthy**, not generic. The identity comes from
one deliberate choice and a quiet system around it.

**The memorable element:** the *status system*. Every job, template, and printer state uses one
shared vocabulary (colour + icon + word) everywhere it appears. People learn it once. Everything
else stays neutral.

### 3.1 Design tokens

**Colour** (single light theme; palette B, Slate teal, chosen)

| Token | Value | Role | Contrast note |
|---|---|---|---|
| `ink` | `#14252B` | Body text | 14.7:1 on surface |
| `surface` | `#F4F7F7` | App background | |
| `panel` | `#FFFFFF` | Cards, tables, dialogs | |
| `line` | `#D6E0E0` | Borders, dividers | |
| `brand` | `#0F6B6B` | Primary actions, focus ring, active nav | 6.3:1 with white text |
| `brand-soft` | `#E3F1F0` | Selected row, active nav background | 5.4:1 with `brand` text |

**Status palette** (always paired with an icon and a text label; never colour alone)

| State | Colour | Used for |
|---|---|---|
| Success | `#3B6D11` on `#EAF3DE` | Printed, Published, Online |
| Warning | `#9A5B00` on `#FDF1DC` | Draft, Queued, Unpublished changes |
| Danger | `#B42318` on `#FDE8E6` | Failed, Offline, Delete |
| Info | `#0F6B6B` on `#E3F1F0` | Printing, Saved copy |
| Neutral | `#475467` on `#EEF0F3` | Withdrawn, Archived, Disabled |

Teal (brand) and green (success) sit close on the hue wheel, so success uses a yellower green, and every status always carries an icon and a word. Teal is never used for success or failure.

This replaces the current emerald / amber / violet / slate mix. The violet "Saved" star becomes
Info; slate "withdrawn" becomes Neutral.

**Type**

| Role | Face | Notes |
|---|---|---|
| UI and body | IBM Plex Sans | Bundled with `@fontsource` so every workstation renders the same, including offline Tauri builds |
| IDs, paths, JSON, code | IBM Plex Mono | Printer addresses, job IDs, template variables |

Scale (px): 12 / 13 / 14 (base) / 16 / 20 / 24. Tabular numerals on for tables and counters.
Sentence case everywhere; no all-caps labels. Body line length stays under 80 characters in the
README viewer and help text.

**Shape and density**

- Radius `6px` for controls and cards, `4px` for badges and table chips (down from 12px and pill).
- Default control height `36px` on desktop; `44px` kept for touch (Android) via the existing
  breakpoint.
- Elevation: one 1px border plus a single subtle shadow for overlays only. No shadows on cards.
- Content width: tables and Designer use full width; forms cap at `720px`.

### 3.2 Layout concept

```
┌───────────────────────────────────────────────────────────────┐
│ ▣ PrintNinja            [ Search or jump to…  Ctrl+K ]  ◉ ⚙ │  top bar, 48px
├────────┬──────────────────────────────────────────────────────┤
│ Work   │  Page title                         [Secondary] [Primary]
│  Print │  One-line description                                 │
│  Hist. │ ───────────────────────────────────────────────────── │
│ Build  │  Filters / tabs                                       │
│  Design│ ┌───────────────────────────────────────────────────┐ │
│  Templ.│ │  table or form, full width, 36px rows             │ │
│ Admin  │ └───────────────────────────────────────────────────┘ │
│  Print.│                                                       │
│  Sett. │                                                       │
└────────┴──────────────────────────────────────────────────────┘
```

- Left aligned throughout. Page title, description, and actions share one `PageHeader`.
- Sidebar groups by job, not by feature list: **Work** (Print, History), **Build** (Designer,
  Templates), **Admin** (Printers, Settings). Collapsible as today; remembered per user.
- Top bar holds the command palette (`cmdk` is already a dependency), connection status of the
  share service, and the signed-in account menu.
- Mobile keeps the bottom bar but with the same grouping and labels; header matches desktop.

---

## 4. Plan review against the brief

Checked the direction above against "improve the UI and make it for corporate use".

- **Risk: generic navy-and-white enterprise template.** Counter: the status system is the one
  distinctive piece and is specific to a print product (job states, printer reachability,
  draft/publish). Palette stays quiet so that system is what people notice.
- **Risk: SaaS card grid.** Counter: History, Printers, and Templates (Mine/Saved) move to
  tables with row actions. Cards stay only for the Community gallery, where browsing
  previews is the point.
- **Changed after review:** dropped a proposed accent gradient on the top bar, and dropped
  numbered section markers in Settings because the sections are not a sequence.

---

## 5. Work plan

Each phase is one PR into `v2-ui-corporate`, and leaves the app working.

### Phase 0 — Baseline and safety net

- Capture screenshots of all 6 pages, at 1440 px and 390 px, before any change.
- Add Playwright (or Vitest browser mode) smoke tests: each route renders, no console errors,
  tab order reaches the main action.
- Add `eslint-plugin-jsx-a11y` rules or `axe-core` checks to the smoke tests.
- Confirm `pnpm test`, `pnpm lint`, `pnpm build` are green on `v2` first.

**Done when:** baseline screenshots committed under `docs/ui-baseline/`; CI runs the smoke tests.

### Phase 1 — Tokens and foundation

Files: `src/index.css`, `tailwind.config.ts`, `index.html`, `package.json`.

- Replace HSL variables with the tokens in §3.1; add `--success`, `--warning`, `--info`,
  `--neutral` (each with `-foreground` and `-soft`); no dark variants.
- Set `--radius` to `0.375rem`; update `Badge` from `rounded-full` to `rounded-sm`.
- Bundle IBM Plex Sans and Mono with `@fontsource`; remove reliance on installed Inter.
- Add `font-variant-numeric: tabular-nums` utility for tables.
- Add `prefers-reduced-motion` handling and a visible 2 px focus ring token.
- Do **not** touch `templates.src.css` or `templates.generated.ts`.

**Done when:** every button, input, and badge meets 4.5:1 text contrast
(checked with axe); app renders with the new palette and no layout regressions.

### Phase 2 — Primitives

Files: `src/components/ui/*`, new `PageHeader.tsx`, `StatusBadge.tsx`, `DataTable.tsx`.

- `StatusBadge`: one component mapping a state (`printed`, `failed`, `queued`, `draft`,
  `published`, `saved`, `withdrawn`, `online`, `offline`…) to colour, icon, and translated
  label. Replace all inline emerald/amber/violet/slate classes in pages.
- `PageHeader`: title, description, actions, optional breadcrumbs. Replaces the six ad hoc
  `h1`s.
- `DataTable`: wraps TanStack Table (already installed) with sticky header, column sizing,
  row selection, keyboard navigation, empty and loading states (uses existing `Skeleton`
  and `EmptyState`).
- Button sizes: `default` 36 px, `sm` 32 px, `lg` 44 px; add `touch` variant for Android.
- Dialog and Sheet: consistent header, footer with primary action on the right, destructive
  confirmations that name the thing being deleted.

**Done when:** no page uses raw colour utilities for status; Storybook-style demo route
(dev only) shows each primitive in each state.

### Phase 3 — Application shell

Files: `src/components/Layout.tsx`, `src/App.tsx`, `src/lib/theme/ThemeProvider.tsx`.

- Top bar with command palette (jump to page, template, printer; run "Print last job").
- Grouped sidebar (Work, Build, Admin) with correct icons (Printers gets a printer icon;
  the product mark becomes a proper logo, not a lucide placeholder).
- Share-service connection indicator and signed-in handle (data already in Settings → Share).
- Remove the "Tip: collapse for more canvas" text; move hints to a help menu.
- Unify mobile header with desktop; keep bottom navigation with the same labels.
- Keyboard shortcuts: `Ctrl+K` palette, `G` then `P/H/D/T` to go to pages; listed in a help
  dialog.

**Done when:** every page is reachable by keyboard only, and the shell is identical across
routes except for content.

### Phase 4 — Pages (one PR each, in this order)

| Order | Page | Lines | Main changes |
|---|---|---|---|
| 1 | History | 531 | `DataTable`, `StatusBadge`, saved filter sets, bulk reprint/retry, sticky filter bar, CSV export stays |
| 2 | Print | 826 | Operator-first layout: choose printer and template on the left, preview on the right, one primary **Print** button; advanced options (margins, fit, copies, batch) in a collapsible section; clear result banner |
| 3 | Templates | 443 | Mine and Saved as tables; Community stays a gallery with a tighter card; status chips via `StatusBadge`; search and sort bar aligned to `PageHeader` |
| 4 | Printers | 547 | Table with reachability status, test print per row, grouped by transport (LAN, USB, Bluetooth, spooler); setup moves into a side sheet |
| 5 | Settings | 799 | Two-column layout (section list left, form right); sections: General, Share, API and automation, Retention, Diagnostics; consistent save behaviour and inline validation |
| 6 | Designer | 1,428 | Last and most careful: split into `DesignerToolbar`, `DesignerSidebar`, and tab panels first (no visual change), then restyle; tabs reduced to a compact segmented control; Publish area shows Draft/Published via `StatusBadge` and keeps the unpublished-changes strip |

**Done when (per page):** matches the page-level checklist in §6; baseline screenshot diff
reviewed and approved.

### Phase 5 — Corporate readiness

- **i18n:** move all remaining hardcoded strings into `src/lib/i18n`; add a pseudo-locale test
  to catch overflow; keep English as default.
- **Branding (optional, can be cut):** app name and logo in Settings (stored in `settings`),
  applied to top bar and window title; default remains PrintNinja.
- **Density:** Comfortable (default) and Compact toggle in Settings, stored in `settings`.
- **Single light theme:** remove `next-themes` toggle behaviour and the `.dark` variables; keep `ThemeProvider` only if still needed for tokens, otherwise delete it.
- **Windows polish:** title bar and Android status bar use the light palette; DPI scaling checked at 100, 125,
  150 percent.
- **Onboarding:** shorten `Onboarding.tsx` to what an operator needs; admin setup steps move
  to a checklist in Settings.

### Phase 6 — Docs and release

- Update `README.md` Features section wording for the new UI; add screenshots.
- `CHANGELOG.md` entry; bump version per `docs/RELEASE.md`.
- Short `docs/UI_GUIDE.md`: tokens, status vocabulary, when to use table vs card.

---

## 6. Page-level checklist (applies to every page)

- Uses `PageHeader`; title, description, and actions in the same positions.
- Only `StatusBadge` and semantic tokens for state; no raw `emerald`, `amber`, `slate`, `cyan`.
- Loading, empty, error, and offline states all designed, each saying what happened and what to
  do next (for example, "Share service unreachable. Check the address in Settings → Share.").
- Button labels name the action ("Save changes", "Publish template"), and the toast after
  repeats the same verb ("Template published").
- Destructive actions name the item and ask for confirmation.
- Works at 390 px and 1440 px, light theme only.
- Full keyboard path; visible focus; screen-reader names on icon-only buttons.
- All strings come from i18n.

---

## 7. Accessibility and quality targets

- WCAG 2.1 AA as an internal bar (no formal compliance requirement): text 4.5:1, UI components 3:1, focus visible, no colour-only meaning.
- Touch targets at least 44 px on Android, 32 px minimum on desktop.
- `prefers-reduced-motion` respected; no non-essential motion (no entrance animations on
  sections or cards; motion only for opening, closing, and confirming actions).
- Zero axe violations on every route in CI.
- No change to Lighthouse performance budget; fonts are subsetted (Latin plus Latin-ext).

---

## 8. Testing strategy

| Layer | Tool | Scope |
|---|---|---|
| Unit | Vitest (existing) | `StatusBadge` state mapping, density/branding settings, i18n key coverage |
| Smoke and a11y | Playwright + axe | Every route, two viewport sizes |
| Visual | Playwright screenshots | Compare against Phase 0 baselines; reviewed manually per PR |
| Manual | Windows 10/11 and one Android device | Tauri shell, DPI scaling, USB/Bluetooth flows unchanged |

Existing logic tests (`printStore`, `templateStore`, `renderTemplate`, `barcode`,
`seedTemplates`) must pass unchanged on every PR.

---

## 9. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Restyling the 1.4k-line Designer breaks editing or preview | Refactor to components first with no visual change; screenshot diff before restyling |
| Print preview or output changes by accident | Template print CSS and the sandboxed preview iframe are out of scope; add a render test that asserts the generated CSS is byte-identical |
| Bundled fonts increase install size | Ship only the weights used (400, 500, 600) and Latin subsets; measure in Phase 1 |
| Scope creep into features | New capabilities (roles, audit export, SSO) are tracked in §10, not built here |
| Long-running branch diverges from `v2` | One PR per phase, merged promptly; rebase weekly |

---

## 10. Decisions and open questions

**Decided**

| Question | Answer | Effect on the plan |
|---|---|---|
| Main user | All equally | No persona is prioritised. Phase 4 keeps the order History, Print, Templates, Printers, Settings, Designer, and each page is judged against all three roles |
| Branding | PrintNinja's own corporate look | §3 palette and type stay as written. Custom company branding in Phase 5 becomes optional and can be cut |
| Platforms | Windows and Android equally | Every page is verified at desktop and 390 px width. Touch targets (44 px) apply on Android, compact density on Windows. Both get a manual test pass per phase |
| Theme | Single light theme, no dark mode | Removes dark variables, the theme toggle, and half the screenshot and test matrix. Saves roughly a day across Phases 1, 3, and 5 |
| Palette | B. Slate teal | Tokens in §3.1 updated to the chosen palette |
| Compliance | No formal requirement | No VPAT or EN 301 549 work. WCAG 2.1 AA stays as the internal quality bar because it is cheap to meet and the current contrast fails it |

**Still open** (not blocking Phases 0 to 3)

1. **Languages:** which locales are needed besides English? Decides how much Phase 5 i18n work is required.
2. **Governance features** (out of scope here, but they affect layout): will you need roles, audit-friendly history export, or SSO for the share service?

---

## 11. Suggested order and size

| Phase | Effort (1 developer) | Risk |
|---|---|---|
| 0 Baseline | 1 day | Low |
| 1 Tokens | 1–2 days | Low |
| 2 Primitives | 3–4 days | Medium |
| 3 Shell | 2–3 days | Medium |
| 4 Pages | 8–12 days (Designer about half) | Medium–High |
| 5 Corporate readiness | 3–4 days | Low |
| 6 Docs and release | 1 day | Low |
| **Total** | **about 3–4 weeks** | |

Smallest useful slice if time is short: Phases 0, 1, 2, and 3, then History and Print from
Phase 4. That fixes contrast, identity, status consistency, and the two screens operators use
most.