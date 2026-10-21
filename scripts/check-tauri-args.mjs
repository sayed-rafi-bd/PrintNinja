#!/usr/bin/env node
// Guard against the Tauri 2 IPC naming trap.
//
// Tauri converts a command's Rust argument names to camelCase on the JS side
// (`template_id` becomes `templateId`) unless the command opts out with
// `#[tauri::command(rename_all = "snake_case")]`. This app sends snake_case
// keys everywhere (see src/lib/agent/commands.ts and the e2e fake agent), so
// every command that takes a multi-word argument DIRECTLY must carry that
// attribute. Arguments that live inside a `#[derive(Deserialize)]` request
// struct are read through serde and are not affected.
//
// The unit tests and the e2e harness use a fake agent that accepts snake_case
// regardless, so they cannot catch a missing attribute. This script can.
//
// Usage: node scripts/check-tauri-args.mjs [dir]   (default: src-tauri/src)

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const srcDir = process.argv[2] ?? join(root, "src-tauri", "src");

// Parameters Tauri injects itself; they are not part of the JS payload.
const INJECTED = /\b(State|AppHandle|Window|WebviewWindow|Webview|Request|Runtime|ipc::Request)\b/;

function rustFiles(dir) {
	const out = [];
	for (const name of readdirSync(dir)) {
		const p = join(dir, name);
		if (statSync(p).isDirectory()) out.push(...rustFiles(p));
		else if (name.endsWith(".rs")) out.push(p);
	}
	return out;
}

/** Index of the bracket matching the opener at `open`, or -1. */
function matchClose(text, open) {
	const pairs = { "(": ")", "[": "]", "{": "}", "<": ">" };
	const o = text[open];
	const c = pairs[o];
	let depth = 0;
	for (let i = open; i < text.length; i++) {
		// `->` must not count as a closing angle bracket.
		if (o === "<" && text[i] === ">" && text[i - 1] === "-") continue;
		if (text[i] === o) depth++;
		else if (text[i] === c && --depth === 0) return i;
	}
	return -1;
}

/** Split on commas that are not nested inside (), [], {} or <>. */
function splitTopLevel(text) {
	const parts = [];
	let depth = 0;
	let cur = "";
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if ("([{<".includes(ch)) depth++;
		else if (")]}>".includes(ch) && !(ch === ">" && text[i - 1] === "-")) depth--;
		if (ch === "," && depth === 0) {
			parts.push(cur);
			cur = "";
		} else cur += ch;
	}
	if (cur.trim()) parts.push(cur);
	return parts.map((p) => p.trim()).filter(Boolean);
}

const stripComments = (s) =>
	s.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));

const problems = [];
let commandCount = 0;

for (const file of rustFiles(srcDir)) {
	const raw = readFileSync(file, "utf8");
	// Blank out comments but keep offsets so line numbers stay right.
	const text = stripComments(raw);
	const attrRe = /#\[\s*(?:tauri::)?command\b/g;
	let m;
	while ((m = attrRe.exec(text))) {
		const attrOpen = text.indexOf("[", m.index);
		const attrClose = matchClose(text, attrOpen);
		const attr = text.slice(attrOpen, attrClose + 1);
		const line = raw.slice(0, m.index).split("\n").length;

		const rest = text.slice(attrClose + 1);
		const fnMatch = /^(?:\s*#\[[^\]]*\])*\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+(\w+)\s*(<[^(]*>)?\s*\(/.exec(rest);
		if (!fnMatch) continue; // e.g. a mention inside a string or macro
		commandCount++;
		const name = fnMatch[1];
		const argsOpen = attrClose + 1 + fnMatch[0].length - 1;
		const argsClose = matchClose(text, argsOpen);
		const args = splitTopLevel(text.slice(argsOpen + 1, argsClose));

		const multiWord = [];
		for (const arg of args) {
			const colon = arg.indexOf(":");
			if (colon < 0) continue; // `self` and the like
			const type = arg.slice(colon + 1);
			if (INJECTED.test(type)) continue;
			const argName = arg.slice(0, colon).replace(/^\s*(mut\s+)?/, "").trim().replace(/^_+/, "");
			if (argName.includes("_")) multiWord.push(argName);
		}
		if (multiWord.length === 0) continue;

		const renameOk = /rename_all\s*=\s*"snake_case"/.test(attr);
		if (!renameOk) {
			problems.push(
				`${relative(root, file)}:${line}  \`${name}\` takes ${multiWord.map((a) => `\`${a}\``).join(", ")} ` +
					`but its attribute is \`${attr.replace(/\s+/g, " ")}\``,
			);
		}
	}
}

if (problems.length > 0) {
	console.error("Tauri commands with multi-word arguments must use rename_all = \"snake_case\":\n");
	for (const p of problems) console.error(`  ${p}`);
	console.error(
		'\nFix: change the attribute to `#[tauri::command(rename_all = "snake_case")]`, or move the arguments into a Deserialize request struct.',
	);
	process.exit(1);
}

console.log(`check-tauri-args: ${commandCount} commands checked, all multi-word arguments are snake_case.`);
