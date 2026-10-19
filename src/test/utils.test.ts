import { describe, it, expect } from "vitest";
import { cn } from "@/lib/utils";

describe("cn with density classes", () => {
  it("lets an explicit height replace h-control", () => {
    expect(cn("h-control px-4", "h-8")).toBe("px-4 h-8");
  });
  it("lets h-control replace an earlier height", () => {
    expect(cn("h-8", "h-control")).toBe("h-control");
  });
  it("lets an explicit width replace w-control", () => {
    expect(cn("h-control w-control", "h-8 w-8")).toBe("h-8 w-8");
  });
});
