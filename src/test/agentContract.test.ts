import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { commandNames } from "../../e2e/support/fakeAgent/commands.js";

// The agent contract (REFACTORING.md section 11): every IPC command the
// app calls must exist in the Rust generate_handler! list and in the
// fake agent, and every Rust command must be known to the fake agent
// (implemented or acknowledged stub). A new command on either side fails
// loudly here instead of as a silent null at runtime.
function srcFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		if (entry === "test") continue;
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) {
			out.push(...srcFiles(path));
		} else if (/\.tsx?$/.test(entry)) {
			out.push(path);
		}
	}
	return out;
}

function appCommands(): Set<string> {
	const here = dirname(fileURLToPath(import.meta.url));
	const srcDir = resolve(here, "..");
	const found = new Set<string>();
	for (const path of srcFiles(srcDir)) {
		const text = readFileSync(path, "utf8");
		for (const match of text.matchAll(/(?:invoke|agent|tauriInvoke)\(\s*"([a-z_0-9]+)"/g)) {
			found.add(match[1] as string);
		}
	}
	return found;
}

function rustCommands(): Set<string> {
	const here = dirname(fileURLToPath(import.meta.url));
	const libRs = readFileSync(
		resolve(here, "..", "..", "src-tauri", "src", "lib.rs"),
		"utf8",
	);
	const block = /generate_handler!\[(.*?)\]\)/s.exec(libRs)?.[1] ?? "";
	const found = new Set<string>();
	for (const match of block.matchAll(/commands::\w+::(\w+)/g)) {
		found.add(match[1] as string);
	}
	return found;
}

describe("agent contract", () => {
	it("every app-called command exists in Rust and in the fake agent", () => {
		const app = appCommands();
		const rust = rustCommands();
		const fake = new Set(commandNames());

		expect(app.size).toBeGreaterThan(0);
		for (const cmd of app) {
			expect(rust.has(cmd), `app calls "${cmd}" with no Rust handler`).toBe(true);
			expect(fake.has(cmd), `app calls "${cmd}" unknown to the fake agent`).toBe(true);
		}
	});

	it("every Rust command is known to the fake agent", () => {
		const rust = rustCommands();
		const fake = new Set(commandNames());

		expect(rust.size).toBeGreaterThan(0);
		for (const cmd of rust) {
			expect(fake.has(cmd), `Rust command "${cmd}" unknown to the fake agent`).toBe(true);
		}
	});
});
