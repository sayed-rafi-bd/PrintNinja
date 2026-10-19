# UI baseline

Screenshots of every route before the corporate redesign (Phase 0 of
`docs/UI_CORPORATE_PLAN.md`). They could not be generated in the sandbox this
work was done in, because it has no browser. Generate them from a clean `v2`
checkout:

```bash
git stash -u && git checkout v2
pnpm dev &
npx playwright install chromium
node scripts/capture-screens.mjs docs/ui-baseline
```

Run the same script with a different output folder on the redesign branch to
compare.

## Accessibility baseline on `v2` (axe-core, from `src/test/smoke.test.tsx`)

All findings below were fixed in Phase 2 of the redesign and the tests now fail on any violation.

| Route | Rule | Cause |
|---|---|---|
| /templates, /print, /history, /settings | button-name | Select triggers without an accessible name |
| /print, /printers, /settings | heading-order | `CardTitle` renders an `h3` straight after the page `h1` |

Colour contrast cannot be computed in jsdom. It is covered by
`src/test/tokens.test.ts` (added in Phase 1). The pre-redesign primary
button measured about 2.9:1 against its text.

## Windows scaling check (manual, 100 / 125 / 150 percent)

Not done in the build sandbox (no browser, no Windows). Do this once on a Windows 10 or 11 machine before a release:

1. Set Display → Scale to 100%, 125%, then 150%, and sign out and in if Windows asks.
2. Start the app. At each scale, open Print, History, Printers, Settings and the Designer, and check: nothing is clipped or overlaps, the Print button stays visible, text is not blurry, and the sidebar and top bar keep their height.
3. The smallest supported window is 800 × 600. At 150% on a 1366 × 768 screen the app sees about 911 × 512, so also check the window maximised there.
4. Try Compact density at 150%: rows should still be easy to click.

`node scripts/capture-screens.mjs docs/ui-dpi --dpi` approximates this in Chromium (four viewport and scale combinations) when a quick look is enough. It does not replace the check on real Windows.
