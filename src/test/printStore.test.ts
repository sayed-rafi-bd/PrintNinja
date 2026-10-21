import { describe, it, expect, beforeEach } from "vitest";
import { usePrintStore } from "@/lib/store/printStore";

describe("printStore", () => {
  beforeEach(() => {
    usePrintStore.setState({
      printerId: "",
      templateId: "",
      dataUrl: "",
      httpMethod: "GET",
      orientation: "portrait",
      marginTop: 5,
      marginRight: 5,
      marginBottom: 5,
      marginLeft: 5,
      fitMode: "fit-width",
      copies: 1,
      useTestData: false,
      pageRange: "",
      grayscale: false,
      status: "idle",
      error: "",
      durationMs: 0,
      batchMode2: "per_record",
    });
  });

  it("sets printer ID", () => {
    usePrintStore.getState().setPrinterId("front-desk");
    expect(usePrintStore.getState().printerId).toBe("front-desk");
  });

  it("sets orientation", () => {
    usePrintStore.getState().setOrientation("landscape");
    expect(usePrintStore.getState().orientation).toBe("landscape");
  });

  it("sets fit mode", () => {
    usePrintStore.getState().setFitMode("fit-page");
    expect(usePrintStore.getState().fitMode).toBe("fit-page");
  });

  it("toggles test data", () => {
    usePrintStore.getState().setUseTestData(true);
    expect(usePrintStore.getState().useTestData).toBe(true);
  });

  it("sets copies", () => {
    usePrintStore.getState().setCopies(3);
    expect(usePrintStore.getState().copies).toBe(3);
  });

  it("sets margins", () => {
    usePrintStore.getState().setMarginTop(10);
    usePrintStore.getState().setMarginBottom(10);
    expect(usePrintStore.getState().marginTop).toBe(10);
    expect(usePrintStore.getState().marginBottom).toBe(10);
  });

  it("updates status", () => {
    usePrintStore.getState().setStatus("printing");
    expect(usePrintStore.getState().status).toBe("printing");
  });
});
