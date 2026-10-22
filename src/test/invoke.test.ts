import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const tauriInvoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...a: unknown[]) => tauriInvoke(...a),
}));

import { invoke, redactInvokeArgs } from "@/lib/invoke";

describe("redactInvokeArgs", () => {
  it("redacts credentials but keeps the shape", () => {
    const out = redactInvokeArgs({
      req: { name: "Dock", token: "abc123", nested: { api_key: "k" } },
    }) as Record<string, Record<string, unknown>>;
    expect(out.req.name).toBe("Dock");
    expect(out.req.token).toBe("[redacted]");
    expect((out.req.nested as Record<string, unknown>).api_key).toBe(
      "[redacted]",
    );
  });

  it("summarizes bulky payloads instead of dumping them", () => {
    const out = redactInvokeArgs({
      req: { html: "<p>x</p>".repeat(100), printer_name: "Dock" },
    }) as Record<string, Record<string, unknown>>;
    expect(out.req.html).toMatch(/\[\d+ chars\]/);
    expect(out.req.printer_name).toBe("Dock");
  });

  it("truncates stray long strings and passes scalars through", () => {
    const out = redactInvokeArgs({ note: "y".repeat(500), n: 3 }) as Record<
      string,
      unknown
    >;
    expect(String(out.note)).toMatch(/\[500 chars\]/);
    expect(out.n).toBe(3);
  });
});

describe("invoke", () => {
  let debug: ReturnType<typeof vi.spyOn>;
  let error: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    tauriInvoke.mockReset();
    debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    error = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    debug.mockRestore();
    error.mockRestore();
  });

  it("sends the real args but logs only the redacted copy", async () => {
    tauriInvoke.mockResolvedValue("ok");
    const args = { req: { token: "live-secret", printer_name: "Dock" } };
    await expect(invoke("print_html", args)).resolves.toBe("ok");
    // The wire gets the untouched secret.
    expect(tauriInvoke).toHaveBeenCalledWith("print_html", args);
    // The console gets the redacted copy.
    expect(debug).toHaveBeenCalledOnce();
    const logged = debug.mock.calls[0][1] as {
      req: Record<string, unknown>;
    };
    expect(logged.req.token).toBe("[redacted]");
    expect(logged.req.printer_name).toBe("Dock");
  });

  it("logs failures redacted too", async () => {
    tauriInvoke.mockRejectedValue(new Error("nope"));
    await expect(invoke("print_html", { password: "hunter2" })).rejects.toThrow(
      "nope",
    );
    expect(error).toHaveBeenCalledOnce();
    const logged = error.mock.calls[0][1] as Record<string, unknown>;
    expect(logged.password).toBe("[redacted]");
  });
});
