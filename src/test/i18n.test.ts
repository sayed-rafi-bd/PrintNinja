import { afterEach, beforeEach, describe, expect, it } from "vitest";
import i18n, {
  LANGUAGE_STORAGE_KEY,
  SUPPORTED_LANGUAGES,
  currentLanguage,
  detectLanguage,
  matchLanguage,
  setLanguage,
} from "@/lib/i18n";
import en from "@/lib/i18n/locales/en";
import ja from "@/lib/i18n/locales/ja";

type Tree = { [key: string]: string | Tree };

function flatten(tree: Tree, prefix = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(tree)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "string") out[key] = v;
    else Object.assign(out, flatten(v, key));
  }
  return out;
}

const placeholders = (s: string) =>
  [...s.matchAll(/\{\{\s*([a-zA-Z_][\w]*)\s*\}\}/g)].map((m) => m[1]).sort();

describe("locale files", () => {
  const enFlat = flatten(en as Tree);
  const jaFlat = flatten(ja as Tree);

  it("ja defines exactly the keys en defines", () => {
    expect(Object.keys(jaFlat).sort()).toEqual(Object.keys(enFlat).sort());
  });

  it("ja has no empty strings except the plural helper words", () => {
    const allowed = new Set(["templates.server_is", "templates.server_are"]);
    const empty = Object.entries(jaFlat)
      .filter(([k, v]) => v.trim() === "" && !allowed.has(k))
      .map(([k]) => k);
    expect(empty).toEqual([]);
  });

  it("ja uses only placeholders that en provides", () => {
    const bad: string[] = [];
    for (const [key, text] of Object.entries(jaFlat)) {
      const allowed = new Set(placeholders(enFlat[key] ?? ""));
      // `glue_message` contains Handlebars examples, not interpolation values.
      if (key === "designer.glue_message") continue;
      for (const name of placeholders(text)) {
        if (!allowed.has(name)) bad.push(`${key}: {{${name}}}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("ja keeps every placeholder that carries data", () => {
    // Word-order helpers (`plural`, `verb`) are English-only; everything else
    // must survive translation or a value would silently disappear.
    const skip = new Set(["plural", "verb"]);
    const missing: string[] = [];
    for (const [key, text] of Object.entries(enFlat)) {
      if (key === "designer.glue_message") continue;
      const have = new Set(placeholders(jaFlat[key] ?? ""));
      for (const name of placeholders(text)) {
        if (!skip.has(name) && !have.has(name))
          missing.push(`${key}: {{${name}}}`);
      }
    }
    expect(missing).toEqual([]);
  });
});

describe("language selection", () => {
  beforeEach(async () => {
    localStorage.clear();
    await i18n.changeLanguage("en");
  });
  afterEach(async () => {
    localStorage.clear();
    await i18n.changeLanguage("en");
  });

  it("lists English and Japanese", () => {
    expect(SUPPORTED_LANGUAGES.map((l) => l.code)).toEqual(["en", "ja"]);
  });

  it("matches regional tags to a supported language", () => {
    expect(matchLanguage("ja-JP")).toBe("ja");
    expect(matchLanguage("JA")).toBe("ja");
    expect(matchLanguage("en_GB")).toBe("en");
    expect(matchLanguage("fr-FR")).toBeNull();
    expect(matchLanguage(undefined)).toBeNull();
  });

  it("prefers a saved choice over the system language", () => {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, "ja");
    expect(detectLanguage()).toBe("ja");
  });

  it("ignores an unsupported saved value", () => {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, "xx");
    expect(detectLanguage()).toBe("en");
  });

  it("setLanguage switches the UI, persists, and updates <html lang>", async () => {
    expect(i18n.t("nav.print")).toBe("Print");
    await setLanguage("ja");
    expect(currentLanguage()).toBe("ja");
    expect(i18n.t("nav.print")).toBe("印刷");
    expect(localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe("ja");
    expect(document.documentElement.lang).toBe("ja");
  });

  it("interpolates values in Japanese", async () => {
    await setLanguage("ja");
    expect(
      i18n.t("history.bulk_done", {
        verb: i18n.t("history.bulk_verb_retry"),
        count: 3,
      }),
    ).toBe("3件のジョブを再キューに追加しました");
    expect(
      i18n.t("checklist.detail_count", {
        count: 2,
        unit: i18n.t("checklist.unit_printers"),
      }),
    ).toBe("2台");
  });
});
