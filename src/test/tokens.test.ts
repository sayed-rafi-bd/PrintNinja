import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// Reads the real stylesheet so the test fails if a token drifts below the bar.
const css = readFileSync(path.resolve(__dirname, "../index.css"), "utf8");

function token(name: string): [number, number, number] {
  const m = css.match(new RegExp(`--${name}:\\s*(\\d+(?:\\.\\d+)?)\\s+(\\d+(?:\\.\\d+)?)%\\s+(\\d+(?:\\.\\d+)?)%`));
  if (!m) throw new Error(`token --${name} not found`);
  return [Number(m[1]), Number(m[2]) / 100, Number(m[3]) / 100];
}

function toRgb([h, s, l]: [number, number, number]): [number, number, number] {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0), f(8), f(4)];
}

function luminance(name: string): number {
  const [r, g, b] = toRgb(token(name)).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// Text pairs need 4.5:1 (WCAG 1.4.3).
const TEXT_PAIRS: Array<[string, string]> = [
  ["foreground", "background"],
  ["foreground", "card"],
  ["primary-foreground", "primary"],
  ["destructive-foreground", "destructive"],
  ["secondary-foreground", "secondary"],
  ["muted-foreground", "background"],
  ["muted-foreground", "card"],
  ["muted-foreground", "muted"],
  ["accent-foreground", "accent"],
  ["primary", "background"],
  ["primary", "card"],
  ["success", "success-soft"],
  ["warning", "warning-soft"],
  ["danger", "danger-soft"],
  ["info", "info-soft"],
  ["neutral", "neutral-soft"],
];

describe("design tokens", () => {
  it.each(TEXT_PAIRS)("%s on %s meets 4.5:1", (fg, bg) => {
    expect(contrast(fg, bg)).toBeGreaterThanOrEqual(4.5);
  });

  // Non-text UI (form control borders, focus ring) needs 3:1 (WCAG 1.4.11).
  it.each([
    ["input", "card"],
    ["input", "background"],
    ["ring", "background"],
  ])("%s against %s meets 3:1", (a, b) => {
    expect(contrast(a, b)).toBeGreaterThanOrEqual(3);
  });

  it("is a single light theme", () => {
    expect(css).not.toMatch(/\.dark\s*\{/);
    expect(css).toMatch(/color-scheme:\s*light/);
  });
});
