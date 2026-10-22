import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, loadEnvFile } from "../src/config.js";

const required = {
  CORS_ORIGINS: "http://localhost:1420",
  DATABASE_URL: "file:./dev.db",
};

describe("loadConfig", () => {
  it("applies the documented defaults", () => {
    const config = loadConfig(required);
    expect(config.nodeEnv).toBe("development");
    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(3001);
    expect(config.logLevel).toBe("info");
    expect(config.trustProxy).toBe(0);
    expect(config.sessionTtlDays).toBe(30);
    expect(config.sessionCleanupMinutes).toBe(60);
    expect(config.syncTombstoneDays).toBe(90);
    expect(config.syncPageBytes).toBe(8 * 1024 * 1024);
    expect(config.rateLimitMax).toBe(120);
    expect(config.rateLimitAuthMax).toBe(10);
    expect(config.rateLimitAuthWindowSeconds).toBe(300);
    expect(config.argon2MemoryKib).toBe(19456);
    expect(config.argon2TimeCost).toBe(2);
    expect(config.argon2Parallelism).toBe(1);
    expect(config.docsEnabled).toBe(false);
    expect(config.corsOrigins).toEqual(["http://localhost:1420"]);
  });

  it("rejects a missing DATABASE_URL or CORS_ORIGINS and names the field", () => {
    expect(() => loadConfig({ CORS_ORIGINS: required.CORS_ORIGINS })).toThrow(
      "DATABASE_URL",
    );
    expect(() => loadConfig({ DATABASE_URL: required.DATABASE_URL })).toThrow(
      "CORS_ORIGINS",
    );
    expect(() => loadConfig({ ...required, CORS_ORIGINS: "   " })).toThrow(
      "CORS_ORIGINS",
    );
  });

  it("requires DATABASE_AUTH_TOKEN for a libsql:// DATABASE_URL", () => {
    expect(() =>
      loadConfig({ ...required, DATABASE_URL: "libsql://db.turso.io" }),
    ).toThrow("DATABASE_AUTH_TOKEN");
    const config = loadConfig({
      ...required,
      DATABASE_URL: "libsql://db.turso.io",
      DATABASE_AUTH_TOKEN: "secret",
    });
    expect(config.databaseAuthToken).toBe("secret");
  });

  it("coerces numeric strings and rejects out-of-range values", () => {
    const config = loadConfig({ ...required, PORT: "4000", TRUST_PROXY: "2" });
    expect(config.port).toBe(4000);
    expect(config.trustProxy).toBe(2);
    expect(() => loadConfig({ ...required, PORT: "0" })).toThrow("PORT");
    expect(() => loadConfig({ ...required, PORT: "70000" })).toThrow("PORT");
  });

  it("rejects Argon2 settings that would OOM the host", () => {
    expect(() =>
      loadConfig({ ...required, ARGON2_MEMORY_KIB: "1048576" }),
    ).toThrow("ARGON2_MEMORY_KIB");
    expect(() => loadConfig({ ...required, ARGON2_TIME_COST: "99" })).toThrow(
      "ARGON2_TIME_COST",
    );
    expect(() => loadConfig({ ...required, ARGON2_PARALLELISM: "64" })).toThrow(
      "ARGON2_PARALLELISM",
    );
  });
  it("rejects an unknown LOG_LEVEL or NODE_ENV", () => {
    expect(() => loadConfig({ ...required, LOG_LEVEL: "loud" })).toThrow(
      "LOG_LEVEL",
    );
    expect(() => loadConfig({ ...required, NODE_ENV: "staging" })).toThrow(
      "NODE_ENV",
    );
  });

  it("parses boolean flags from strings", () => {
    expect(loadConfig({ ...required, DOCS_ENABLED: "false" }).docsEnabled).toBe(
      false,
    );
    expect(loadConfig({ ...required, DOCS_ENABLED: "true" }).docsEnabled).toBe(
      true,
    );
  });

  it("splits and trims the CORS origin list", () => {
    const config = loadConfig({
      ...required,
      CORS_ORIGINS:
        "tauri://localhost, http://tauri.localhost , http://localhost:1420",
    });
    expect(config.corsOrigins).toEqual([
      "tauri://localhost",
      "http://tauri.localhost",
      "http://localhost:1420",
    ]);
  });

  it("rejects an origin that is not a parseable URL", () => {
    expect(() =>
      loadConfig({ ...required, CORS_ORIGINS: "not a url" }),
    ).toThrow("CORS_ORIGINS");
  });
});

describe("loadEnvFile", () => {
  const KEY = "PRINTNINJA_TEST_LOAD_ENV_FILE";
  let saved: string | undefined;

  const setup = () => {
    saved = process.env[KEY];
    delete process.env[KEY];
  };
  const teardown = () => {
    if (saved === undefined) delete process.env[KEY];
    else process.env[KEY] = saved;
  };

  it("loads variables from the given directory's .env file", () => {
    setup();
    try {
      const dir = mkdtempSync(join(tmpdir(), "printninja-env-"));
      try {
        writeFileSync(join(dir, ".env"), `${KEY}=from-file\n`);
        loadEnvFile(dir);
        expect(process.env[KEY]).toBe("from-file");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    } finally {
      teardown();
    }
  });

  it("never overrides explicitly-set variables", () => {
    setup();
    try {
      const dir = mkdtempSync(join(tmpdir(), "printninja-env-"));
      try {
        process.env[KEY] = "explicit";
        writeFileSync(join(dir, ".env"), `${KEY}=from-file\n`);
        loadEnvFile(dir);
        expect(process.env[KEY]).toBe("explicit");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    } finally {
      teardown();
    }
  });

  it("is a no-op when no .env file exists", () => {
    setup();
    try {
      const dir = mkdtempSync(join(tmpdir(), "printninja-env-"));
      try {
        loadEnvFile(dir);
        expect(process.env[KEY]).toBeUndefined();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    } finally {
      teardown();
    }
  });
});
