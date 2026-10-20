import { describe, expect, it } from "vitest";
import {
	assertSizeCaps,
	BODY_MAX_BYTES,
	CSS_MAX_BYTES,
	findRemoteRefs,
	README_MAX_BYTES,
} from "../src/domain/templates/shared.js";
import { PayloadTooLargeError } from "../src/domain/errors.js";

describe("findRemoteRefs", () => {
	const cases: [string, string, string][] = [
		// [name, body, css] — each must flag exactly the named part
		["double-quoted src", '<img src="http://x/y.png">', ""],
		["single-quoted src, any case", "<IMG SRC='http://x/y.png'>", ""],
		["protocol-relative href", '<a href="//cdn.example/x">t</a>', ""],
		["spaces around =", '<img src = "http://x/y.png">', ""],
		["unquoted src", "<img src=http://x/y.png>", ""],
		["single-quoted url()", "<div></div>", ".a{background:url('https://x/y.png')}"],
		["unquoted protocol-relative url()", "<div></div>", ".a{background:url(//cdn/x)}"],
		["spaced url()", "<div></div>", ".a{background:url( \"http://x\" )}"],
		["at-import with url()", '@import url("https://x/y.css");', ""],
		["at-import with string", '@import "https://x/y.css";', ""],
		["at-import in css", "", '@import "https://x/y.css";'],
	];
	it.each(cases)("%s is rejected", (_name, body, css) => {
		const issues = findRemoteRefs(body, css);
		expect(issues.length).toBeGreaterThan(0);
		if (css === "") {
			expect(issues.every((i) => i.part === "body")).toBe(true);
		} else if (body === "" || body === "<div></div>") {
			expect(issues.every((i) => i.part === "css")).toBe(true);
		}
	});

	it("covers every client needle", async () => {
		// The exact needles from render/handlebars.rs, lowercased both sides.
		const { readFile } = await import("node:fs/promises");
		const rust = await readFile(
			new URL("../../src-tauri/src/render/handlebars.rs", import.meta.url),
			"utf8",
		);
		const needles = [
			...rust.matchAll(/"(src=|href=|url\()((?:\\"|[^"])*)"/g),
		].map((m) => (m[1] as string) + (m[2] as string).replace(/\\"/g, '"'));
		expect(needles.length).toBeGreaterThan(0);
		for (const needle of needles) {
			const probe = `x${needle}http://example.com/y`;
			const issues = findRemoteRefs(probe, probe);
			expect(issues.length, `client needle ${needle} must flag`).toBeGreaterThan(0);
		}
	});

	const clean: [string, string, string][] = [
		["data URI src", '<img src="data:image/png;base64,xx">', ""],
		["relative src", '<img src="logo.png">', ""],
		["bare URL in text is not a load", "<div>see http://example.com</div>", ""],
		["local import", '@import "local.css";', ""],
		["relative url()", "<div></div>", ".a{background:url(fonts/x.woff)}"],
		["empty", "", ""],
	];
	it.each(clean)("%s is accepted", (_name, body, css) => {
		expect(findRemoteRefs(body, css)).toEqual([]);
	});
});

describe("assertSizeCaps", () => {
	it("measures bytes, not UTF-16 units", () => {
		// é is 2 bytes: exactly at each cap is accepted...
		expect(() =>
			assertSizeCaps("é".repeat(BODY_MAX_BYTES / 2), "é".repeat(CSS_MAX_BYTES / 2), "é".repeat(README_MAX_BYTES / 2)),
		).not.toThrow();
		// ...one character past is not.
		expect(() => assertSizeCaps("é".repeat(BODY_MAX_BYTES / 2 + 1), "", "")).toThrow(
			PayloadTooLargeError,
		);
		expect(() => assertSizeCaps("", "é".repeat(CSS_MAX_BYTES / 2 + 1), "")).toThrow(
			PayloadTooLargeError,
		);
		expect(() => assertSizeCaps("", "", "é".repeat(README_MAX_BYTES / 2 + 1))).toThrow(
			PayloadTooLargeError,
		);
	});

	it("names the offending field in path/message pairs", () => {
		try {
			assertSizeCaps("a".repeat(BODY_MAX_BYTES + 1), "", "");
			expect.unreachable();
		} catch (error) {
			const details = (error as PayloadTooLargeError).details ?? [];
			expect(details).toEqual([
				{ path: "body", message: expect.stringContaining("limit") },
			]);
		}
	});
});
