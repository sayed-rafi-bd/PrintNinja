# PrintNinja: Designer Layout Plan

Branch: `develop` · Status: Final · Phase 1 done, phases 2–4 not started · Date: 2026-10-20

Goal: make the Designer a code-first workspace where you can type and watch the page change at the same time. Controls move into a left accordion, the editor and the canvas sit side by side, and the unused Visual tab is removed. Mobile keeps today's single-column layout.

## 1. Why change it

What the current code does (`src/pages/Designer.tsx`, 1,294 lines):

- **Editing and previewing live on different tabs.** The Code tab has the HTML and CSS editors but no preview. The Canvas tab has the preview but no editor. After every edit you switch tabs to see the result.
- **The live loop already exists.** The canvas re-renders 300 ms after you stop typing (`debouncedHtml` and `debouncedCss`), so only the layout needs to change.
- **Canvas and Preview are near-duplicates.** Preview renders with `DEFAULT_MOCK_DATA` only, so it ignores the selected sample dataset and the zoom. It can show different output from Canvas.
- **The Properties card repeats other controls.** It shows page size, orientation and zoom, all already visible in Page Setup and the zoom buttons.
- **The Visual tab is a risk and a duplicate** (section 5).
- **The tooling is mostly in place.** The code editor is CodeMirror, and `react-resizable-panels` is already in `package.json` but unused. No accordion primitive is installed.

## 2. Target layout (desktop, `lg` and up)

```
┌───────────────────────────────────────────────────────────────────────────────┐
│ Designer · Receipt 120mm  [Draft] Save to server · Publish    New  Import  Export │
├────────────┬─────────────────────────────┬────────────────────────────────────┤
│ CONTROLS   │ EDITOR                      │ CANVAS         Fit ▾   −  100%  +  │
│ ▸ Templates│ [ HTML ][ CSS ][ README ]   │    ┌──────────────┐                │
│ ▾ Page     │                             │    │              │                │
│ ▸ Sample   │  CodeMirror                 │    │  live page   │                │
│   data     │                             │    │              │                │
│ ▸ Versions │                             │    └──────────────┘                │
│ ▸ Helpers  │ ◄───────── drag ──────────► │                                    │
└────────────┴─────────────────────────────┴────────────────────────────────────┘
   ~280 px        resizable, default 50 / 50; each pane scrolls on its own
```

Rules:

- The workspace fills the viewport height. The page itself does not scroll; each pane scrolls independently, so scrolling a long template never moves the canvas.
- The controls column is an accordion that allows several sections open at once. It remembers which are open. Default: only Page Setup open.
- The split between editor and canvas is draggable, and its size is remembered (`react-resizable-panels`, `autoSaveId`).

### Where each thing goes

| Today | After |
| --- | --- |
| Templates list, Page Setup, Versions (left cards) | Accordion sections, same content |
| Variables tab (sample datasets) | Accordion section **Sample data**. It controls what the canvas shows, so it is a control, not a view |
| Quick Helpers card (right) | Accordion section **Helpers**, with click-to-insert (section 4) |
| Canvas tab | Permanent right pane |
| Code tab (HTML and CSS side by side) | **HTML** and **CSS** tabs in the editor pane, because the pane is narrower |
| README tab | Stays as a tab in the editor pane |
| Visual tab | **Removed** (section 5) |
| Preview tab | **Removed** (duplicate of the canvas) |
| Properties card | **Removed** (repeats Page Setup and zoom) |
| Draft badge, Save to server, Publish (card above the canvas) | Header row next to the title, which frees vertical space |
| Zoom buttons | Canvas pane toolbar |

## 3. Mobile (below `lg`)

Kept as it is today: a single column with tabs. Two changes:

- The duplicate Preview tab is gone. Tabs are Canvas, HTML/CSS (Code), README and Sample data.
- The same accordion holds Templates, Page Setup and Versions, collapsed by default. Today about 700 px of those cards sit above the tabs, so the canvas is a long scroll away.

The mobile fixes already made in this branch (wrapping action bar, 44 px tap targets) must keep working. Re-run the phone screenshots after each phase.

## 4. Additions beyond the three requests

1. **Fit-to-width zoom, as the default.** An A4 page at 100% is about 794 px wide and does not fit half a laptop screen. Offer Fit, 50% and 100%.
2. **Collapse the controls column to a 48 px icon rail**, automatically below about 1440 px. On a 1366 px laptop the app nav (220 px) plus the controls (280 px) leaves about 430 px each for editor and canvas, which is too tight.
3. **Layout toggle:** side by side, stacked (editor above, canvas below), canvas only. Stacked suits tall portrait pages.
4. **Click-to-insert helpers.** Today a click copies `{{currency}}` and similar tokens to the clipboard. With the editor always visible, insert at the cursor instead.
5. **Mid-typing errors.** Check what the canvas shows when the template is momentarily invalid. Show an error banner rather than a blank or stale page. Not yet verified.

## 5. Remove the Visual tab

`src/components/VisualDesigner.tsx` (213 lines) is a GrapesJS editor. The card is titled "Visual Canvas". Reasons to remove it:

- **It can corrupt Handlebars templates.** GrapesJS parses and rewrites the HTML through the browser's HTML parser, and it writes its output back into the template on every change. Running that parser on a table with a loop:

  ```
  IN : <tbody>{{#each items}}<tr><td>{{name}}</td></tr>{{/each}}</tbody>
  OUT: {{#each items}}{{/each}}<table>…<tbody><tr><td>{{name}}</td></tr></tbody>
  ```

  the loop tags are hoisted out of the table and the row ends up outside the loop. This was tested against the parser, not against GrapesJS itself, because the sandbox cannot reach unpkg.
- **It loads code from the internet at runtime.** It injects a script and a stylesheet from `unpkg.com`. GrapesJS is not in `package.json`. `src-tauri/tauri.conf.json` sets `"csp": null`, so nothing blocks the script, and it would run with access to the app's backend commands. It also fails offline.
- **It duplicates the editor.** Its own "Code" sub-tab is a third HTML/CSS editor.
- **Nothing depends on it.** One component, one import in `Designer.tsx`, no tests. Saved templates are unaffected, so no data migration is needed.

## 6. Phases

Effort figures are rough estimates.

### Before starting

Commit the existing uncommitted work (single starter template; mobile fixes) so this refactor is a clean diff. Committing needs a git author identity.

### Phase 1: Prep and removal (about ½ day) — done

- Delete `VisualDesigner.tsx`, the Visual tab and its import.
- Delete the Preview tab and the Properties card.
- Split `Designer.tsx` into `ControlsAccordion`, `EditorPane` and `CanvasPane` (under `src/components/designer/`). Move the Draft/Save/Publish bar (`TemplateSyncBar`) into the page header.
- Update the README (lines mentioning the visual canvas and the five tabs) and `docs/UI_GUIDE.md` (the `/` and `/template/:id` row).
- Done when: the Designer looks almost the same as now minus the removed items, and `tsc`, Biome and all tests pass.

What Phase 1 did differently from the list above:

- `ControlsAccordion` is `DesignerSidebar` renamed. It is still plain cards; the Radix accordion arrives in Phase 2.
- `EditorPane` covers the Code tab (HTML and CSS) only. README stays a separate tab until Phase 2 folds it into the editor pane.
- `TemplateSyncBar` moved out of the canvas column to a full-width row directly under the title. Its notices ("not on the server yet", "private copy") need the width, so putting it inline next to the title is left to the Phase 2 shell.
- Quick Helpers and the Variables tab are untouched; they move in Phase 2.
- Not in the original list: the **Save & Preview** button switched to the Preview tab, so it now switches to Canvas. The `designer.preview` i18n key and the unused `canvasRef` were removed with the tab.

### Phase 2: New desktop shell (about 1 day)

- Add `@radix-ui/react-accordion` and a `src/components/ui/accordion.tsx` wrapper, plus a `resizable.tsx` wrapper around `react-resizable-panels`.
- Build the three-region workspace at `lg` and up: controls accordion, editor pane (HTML | CSS | README), canvas pane.
- Add Fit-to-width zoom and move the zoom controls into the canvas toolbar.
- Below `lg`, fall back to the existing tabs, with the accordion collapsed by default.
- Done when: typing in the HTML or CSS editor visibly updates the canvas without changing tabs, on desktop and on a phone-sized viewport.

### Phase 3: Polish (about ½ day)

- Layout toggle (side by side, stacked, canvas only).
- Remember pane sizes and open accordion sections.
- Click-to-insert helpers.
- Collapse the controls column to an icon rail below about 1440 px.
- Mid-typing error banner on the canvas.

### Phase 4: Verify

- Update `src/test/designer.test.tsx` (139 lines; it does not reference tab names, so little should change). Add tests for the accordion, the editor tabs, and the removed tabs being absent.
- Capture screenshots at 1920, 1440, 1366 and 390 px using the headless-browser approach from the mobile check. Confirm no horizontal overflow and tap targets of at least 44 px on touch.
- Done when: `pnpm test`, `tsc`, and Biome are clean, and the screenshots match section 2.

## 7. Risks

| Risk | Mitigation |
| --- | --- |
| Editor and canvas too narrow on a 1366 px laptop | Icon-rail collapse below about 1440 px, draggable split, layout toggle |
| Re-rendering the preview while typing resets its scroll position | Check during Phase 2; if it happens, keep the scroll offset across renders |
| Mobile regresses while the desktop shell changes | Keep the tab fallback below `lg`; re-run phone screenshots every phase |
| The refactor mixes with the earlier uncommitted mobile fixes in `Designer.tsx` | Commit those first |
| Existing installs still list the old Invoice and Shipping Label rows | Unrelated to the layout. The single-starter change only affects fresh installs; delete the extras by hand |

## 8. Decisions

All decided. No open questions remain.

| Topic | Decision |
| --- | --- |
| Accordion implementation | Add `@radix-ui/react-accordion` with a `src/components/ui/accordion.tsx` wrapper, matching the other Radix/shadcn components. No native `<details>` |
| Default open section | Page Setup only. The accordion allows several sections open at once and remembers them |
| Visual tab | Removed (section 5) |
| Preview tab and Properties card | Removed (section 2) |
| Mobile | Keep today's single-column tabs; accordion collapsed by default (section 3) |

## 9. Possible follow-ups (out of scope here)

- **Content Security Policy.** Set a real `csp` in `tauri.conf.json` instead of `null`. This is a hardening gap that exists independently of this refactor.
- **Click an element in the canvas to jump to its line in the HTML.** A better "visual" aid for a code-first workflow than GrapesJS, and it never rewrites the template.
