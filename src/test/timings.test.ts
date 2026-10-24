import { describe, expect, it } from "vitest";
import { formatPercent, formatSeconds } from "@/lib/timings";

describe("timing formatters", () => {
  it("converts milliseconds to seconds", () => {
    expect(formatSeconds(0)).toBe("0.000 s");
    expect(formatSeconds(7)).toBe("0.007 s");
    expect(formatSeconds(744)).toBe("0.744 s");
    expect(formatSeconds(12_345)).toBe("12.35 s");
    expect(formatSeconds(-5)).toBe("0.000 s");
  });

  it("formats a stage's share of the total", () => {
    expect(formatPercent(558, 744)).toBe("75%");
    expect(formatPercent(0, 744)).toBe("0%");
    expect(formatPercent(1, 744)).toBe("<1%");
    expect(formatPercent(800, 744)).toBe("100%");
    expect(formatPercent(5, 0)).toBe("0%");
  });
});
