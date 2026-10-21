export interface DiagnosticEntry {
  timestamp: string;
  level: "info" | "warn" | "error";
  message: string;
  context?: Record<string, string>;
}

export class DiagnosticLog {
  private entries: DiagnosticEntry[] = [];
  private maxEntries = 1000;

  log(
    level: "info" | "warn" | "error",
    message: string,
    context?: Record<string, string>,
  ) {
    const entry: DiagnosticEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      context,
    };
    this.entries.push(entry);
    if (this.entries.length > this.maxEntries) {
      this.entries = this.entries.slice(-this.maxEntries);
    }
    if (level === "error") {
      console.error(`[PrintNinja][${level}] ${message}`, context);
    } else if (level === "warn") {
      console.warn(`[PrintNinja][${level}] ${message}`, context);
    } else {
      console.log(`[PrintNinja][${level}] ${message}`, context);
    }
  }

  info(message: string, context?: Record<string, string>) {
    this.log("info", message, context);
  }

  warn(message: string, context?: Record<string, string>) {
    this.log("warn", message, context);
  }

  error(message: string, context?: Record<string, string>) {
    this.log("error", message, context);
  }

  getEntries(): DiagnosticEntry[] {
    return [...this.entries];
  }

  private isSensitiveKey(key: string): boolean {
    const k = key.toLowerCase();
    return (
      k.includes("token") ||
      k.includes("password") ||
      k.includes("secret") ||
      k === "api_key" ||
      k.includes("authorization") ||
      k.includes("credential")
    );
  }

  private redactContext(
    context?: Record<string, string>,
  ): Record<string, string> | undefined {
    if (!context) return undefined;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(context)) {
      out[k] = this.isSensitiveKey(k) ? "***" : v;
    }
    return out;
  }

  private redactedEntries(): DiagnosticEntry[] {
    return this.entries.map((e) => ({
      ...e,
      context: this.redactContext(e.context),
      message: this.isSensitiveKey(e.message) ? "[redacted]" : e.message,
    }));
  }

  export(): string {
    return JSON.stringify(this.redactedEntries(), null, 2);
  }

  download() {
    const data = this.export();
    const blob = new Blob([data], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `printninja-diagnostics-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  clear() {
    this.entries = [];
  }
}

export const diagnostics = new DiagnosticLog();
