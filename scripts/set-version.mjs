#!/usr/bin/env node
// Sets the app version in every file the release check compares:
//   package.json, src-tauri/tauri.conf.json, src-tauri/Cargo.toml,
//   src-tauri/Cargo.lock, src/pages/Settings.tsx
//
//   pnpm version:set 1.0.0 [--dry-run]
//
// It only edits files. It does not commit, tag or push; run `pnpm release`
// afterwards (it will then see all files in sync). Because `pnpm release X.Y.Z`
// requires X.Y.Z to be higher than the current version, set the files to the
// version BEFORE the one you want to release, or release with patch/minor/major.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FILES = {
	pkg: "package.json",
	tauri: "src-tauri/tauri.conf.json",
	cargo: "src-tauri/Cargo.toml",
	lock: "src-tauri/Cargo.lock",
	settings: "src/pages/Settings.tsx",
};

const read = (f) => readFileSync(join(ROOT, f), "utf8");
const write = (f, s) => writeFileSync(join(ROOT, f), s);

function die(msg) {
	console.error(`\nError: ${msg}`);
	process.exit(1);
}

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const positional = args.filter((a) => !a.startsWith("--"));
if (args.includes("--help") || args.includes("-h") || positional.length !== 1) {
	console.log("Usage: pnpm version:set <X.Y.Z> [--dry-run]");
	process.exit(positional.length === 1 ? 0 : 1);
}
const version = positional[0].replace(/^v/, "");
if (!/^\d+\.\d+\.\d+$/.test(version)) die(`"${positional[0]}" is not a version like 1.2.3`);

// Replace group 1 + <version> + group 2 and insist on exactly one match, so a
// changed file layout fails loudly instead of silently skipping a file.
function replaceOnce(text, re, file) {
	const count = (text.match(new RegExp(re.source, `${re.flags}g`)) || []).length;
	if (count !== 1) die(`${file}: expected exactly one version to update, found ${count}`);
	return text.replace(re, (_, a, b) => `${a}${version}${b}`);
}

// Only the [package] table, so dependency versions are left alone.
function cargoTomlInfo(text) {
	let inPackage = false;
	let name = "";
	for (const line of text.split("\n")) {
		const t = line.trim();
		if (/^\[.*]$/.test(t)) {
			inPackage = t === "[package]";
			continue;
		}
		const m = inPackage && t.match(/^name\s*=\s*"([^"]+)"/);
		if (m) name = m[1];
	}
	return name;
}

function bumpCargoToml(text) {
	const lines = text.split("\n"); // keeps any \r, so line endings are preserved
	let inPackage = false;
	let done = 0;
	lines.forEach((line, i) => {
		const t = line.trim();
		if (/^\[.*]$/.test(t)) {
			inPackage = t === "[package]";
		} else if (inPackage && /^version\s*=/.test(t)) {
			lines[i] = line.replace(/^(\s*version\s*=\s*")[^"]+(")/, (_, a, b) => `${a}${version}${b}`);
			done++;
		}
	});
	if (done !== 1) die(`${FILES.cargo}: expected one [package] version, found ${done}`);
	return lines.join("\n");
}

// Cargo.lock entry of this crate, found line by line (no regex escapes to get
// mangled when the file is copied around). Returns the indexes of its version lines.
function lockVersionLines(lines, crate) {
	const hits = [];
	lines.forEach((line, i) => {
		if (
			line.trim() === "[[package]]" &&
			(lines[i + 1] || "").trim() === `name = "${crate}"` &&
			/^version\s*=/.test((lines[i + 2] || "").trim())
		) {
			hits.push(i + 2);
		}
	});
	return hits;
}

function bumpCargoLock(text) {
	const lines = text.split("\n"); // keeps any \r, so line endings are preserved
	const hits = lockVersionLines(lines, crate);
	if (hits.length !== 1) die(`${FILES.lock}: expected one "${crate}" entry, found ${hits.length}`);
	lines[hits[0]] = lines[hits[0]].replace(/^(\s*version\s*=\s*")[^"]+(")/, (_, a, b) => `${a}${version}${b}`);
	return lines.join("\n");
}

const crate = cargoTomlInfo(read(FILES.cargo));
if (!crate) die(`could not read the crate name from ${FILES.cargo}`);

const updated = {
	[FILES.pkg]: replaceOnce(read(FILES.pkg), /^(\s*"version"\s*:\s*")[^"]+(")/m, FILES.pkg),
	[FILES.tauri]: replaceOnce(read(FILES.tauri), /("version"\s*:\s*")[^"]+(")/, FILES.tauri),
	[FILES.cargo]: bumpCargoToml(read(FILES.cargo)),
	[FILES.lock]: bumpCargoLock(read(FILES.lock)),
	[FILES.settings]: replaceOnce(read(FILES.settings), /("v)\d+\.\d+\.\d+(")/, FILES.settings),
};

console.log(`Setting ${crate} to ${version}${dryRun ? " (dry run)" : ""}:`);
for (const [file, text] of Object.entries(updated)) {
	if (!dryRun) write(file, text);
	console.log(`  ${dryRun ? "would update" : "updated"}  ${file}`);
}
