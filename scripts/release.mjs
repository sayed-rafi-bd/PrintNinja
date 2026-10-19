#!/usr/bin/env node
// Release helper. Bumps the version everywhere CI's version-check looks,
// commits, and creates an annotated tag. Cross-platform: needs only Node + git.
//
//   pnpm release patch|minor|major|X.Y.Z [--push] [--dry-run]
//
// Without --push nothing leaves your machine. Pushing the tag is what starts
// the CI release workflow (Windows MSI + Android + draft GitHub Release).
//
// To rename the app, use scripts/release.sh --name instead.
import { execFileSync } from "node:child_process";
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
const RELEASE_BRANCH = "main";

// ---- helpers ---------------------------------------------------------------

const read = (f) => readFileSync(join(ROOT, f), "utf8");
const write = (f, s) => writeFileSync(join(ROOT, f), s);
const git = (...args) =>
	execFileSync("git", args, {
		cwd: ROOT,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();

function die(msg) {
	console.error(`\nError: ${msg}`);
	process.exit(1);
}

function usage() {
	console.log(`Usage: pnpm release <patch|minor|major|X.Y.Z> [--push] [--dry-run]

  patch|minor|major   bump from the current version
  X.Y.Z               set an exact version (must be higher than the current one)
  --push              also push ${RELEASE_BRANCH} and the tag (starts the CI release)
  --dry-run           show what would happen, change nothing
  --help              show this help`);
}

const parse = (v) => v.split(".").map(Number);
function cmp(a, b) {
	const [x, y] = [parse(a), parse(b)];
	for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
	return 0;
}

function nextVersion(current, arg) {
	const [maj, min, pat] = parse(current);
	if (arg === "patch") return `${maj}.${min}.${pat + 1}`;
	if (arg === "minor") return `${maj}.${min + 1}.0`;
	if (arg === "major") return `${maj + 1}.0.0`;
	if (!/^\d+\.\d+\.\d+$/.test(arg)) {
		die(`"${arg}" is not patch, minor, major or a version like 1.2.3`);
	}
	return arg;
}

// ---- reading versions (same sources CI's version-check reads) --------------

// Version / name of the [package] table only (not [lib], [dependencies], ...).
function cargoPackageField(text, field) {
	let inPackage = false;
	for (const line of text.split("\n")) {
		const t = line.trim();
		if (/^\[.*]$/.test(t)) {
			inPackage = t === "[package]";
			continue;
		}
		const m = inPackage && t.match(new RegExp(`^${field}\\s*=\\s*"([^"]+)"`));
		if (m) return m[1];
	}
	return "";
}

function readVersions(crate) {
	const lock = read(FILES.lock).match(
		new RegExp(`\[\[package\]]\r?\nname = "${crate}"\r?\nversion = "([^"]+)"`),
	);
	const settings = read(FILES.settings).match(/"v(\d+\.\d+\.\d+)"/);
	return {
		"package.json": JSON.parse(read(FILES.pkg)).version,
		"tauri.conf.json": JSON.parse(read(FILES.tauri)).version,
		"Cargo.toml": cargoPackageField(read(FILES.cargo), "version"),
		"Cargo.lock": lock ? lock[1] : "",
		"Settings.tsx": settings ? settings[1] : "",
	};
}

// ---- writing versions ------------------------------------------------------

// Replace group 1 + <version> + group 2, and insist on exactly one match so a
// changed file layout fails loudly instead of silently skipping a manifest.
function replaceOnce(text, re, version, file) {
	const count = (text.match(new RegExp(re.source, `${re.flags}g`)) || []).length;
	if (count !== 1) {
		die(`${file}: expected exactly one version to update, found ${count}`);
	}
	return text.replace(re, (_, a, b) => `${a}${version}${b}`);
}

function bumpCargoToml(text, version) {
	const lines = text.split("\n"); // keep any \r so line endings are preserved
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

function applyVersion(version, crate) {
	write(FILES.pkg, replaceOnce(read(FILES.pkg), /^(\s*"version"\s*:\s*")[^"]+(")/m, version, FILES.pkg));
	write(FILES.tauri, replaceOnce(read(FILES.tauri), /("version"\s*:\s*")[^"]+(")/, version, FILES.tauri));
	write(FILES.cargo, bumpCargoToml(read(FILES.cargo), version));
	write(
		FILES.lock,
		replaceOnce(
			read(FILES.lock),
			new RegExp(`(\[\[package\]]\r?\nname = "${crate}"\r?\nversion = ")[^"]+(")`),
			version,
			FILES.lock,
		),
	);
	write(FILES.settings, replaceOnce(read(FILES.settings), /("v)\d+\.\d+\.\d+(")/, version, FILES.settings));
}

// ---- main ------------------------------------------------------------------

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
	usage();
	process.exit(0);
}
const push = args.includes("--push");
const dryRun = args.includes("--dry-run");
const positional = args.filter((a) => !a.startsWith("--"));
const unknown = args.filter((a) => a.startsWith("--") && !["--push", "--dry-run"].includes(a));
if (unknown.length) {
	usage();
	die(`unknown option: ${unknown.join(", ")}`);
}
if (positional.length !== 1) {
	usage();
	die("give exactly one of: patch, minor, major, or X.Y.Z");
}

const crate = cargoPackageField(read(FILES.cargo), "name");
if (!crate) die(`could not read the crate name from ${FILES.cargo}`);

const before = readVersions(crate);
const current = before["package.json"];
const mismatched = Object.entries(before).filter(([, v]) => v !== current);
if (mismatched.length) {
	die(
		`versions are out of sync before bumping:\n${Object.entries(before)
			.map(([f, v]) => `  ${f.padEnd(16)} ${v || "(not found)"}`)
			.join("\n")}\nFix them first.`,
	);
}

const version = nextVersion(current, positional[0]);
const tag = `v${version}`;

// Checks. In a dry run they are reported; otherwise they stop the release.
const problems = [];
if (cmp(version, current) <= 0) problems.push(`${version} is not higher than the current version ${current}`);

const branch = git("rev-parse", "--abbrev-ref", "HEAD");
if (branch !== RELEASE_BRANCH) {
	problems.push(`on branch "${branch}"; releases must be tagged from ${RELEASE_BRANCH} (CI rejects other tags)`);
}

const dirty = git("status", "--porcelain");
if (dirty) problems.push(`working tree is not clean:\n${dirty.replace(/^/gm, "    ")}`);

if (git("tag", "-l", tag)) problems.push(`tag ${tag} already exists locally`);

try {
	git("fetch", "origin", RELEASE_BRANCH, "--quiet");
	const behind = Number(git("rev-list", "--count", `HEAD..origin/${RELEASE_BRANCH}`));
	if (behind > 0) problems.push(`local ${RELEASE_BRANCH} is ${behind} commit(s) behind origin; pull first`);
	if (git("ls-remote", "--tags", "origin", `refs/tags/${tag}`)) problems.push(`tag ${tag} already exists on origin`);
} catch {
	console.warn("Warning: could not reach origin, skipped the up-to-date and remote tag checks.");
}

console.log(`=== Release ${crate} ${current} -> ${version} (${tag}) ===`);
console.log(Object.values(FILES).map((f) => `  ${f}`).join("\n"));

if (dryRun) {
	if (problems.length) console.log(`\nA real run would be refused:\n- ${problems.join("\n- ")}`);
	else console.log("\nDry run: all checks pass, nothing changed.");
	process.exit(problems.length ? 1 : 0);
}
if (problems.length) die(`cannot release:\n- ${problems.join("\n- ")}`);

try {
	applyVersion(version, crate);

	// Same comparison CI's version-check makes, so a bad bump is caught here.
	const after = readVersions(crate);
	const bad = Object.entries(after).filter(([, v]) => v !== version);
	if (bad.length) {
		throw new Error(`version mismatch after bump: ${bad.map(([f, v]) => `${f}=${v || "?"}`).join(", ")}`);
	}

	git("add", "--", ...Object.values(FILES));
	git("commit", "-m", `release: ${tag}`, "-m", `Release ${crate} ${version}`);
	git("tag", "-a", tag, "-m", `release: ${tag}`);
} catch (err) {
	console.error(`\nError: ${err.stderr || err.message}`);
	console.error(`Undo with:  git reset --hard HEAD  (and  git tag -d ${tag}  if the tag was created)`);
	process.exit(1);
}

console.log(`\n[ok] committed "release: ${tag}" and tagged ${tag}`);

if (push) {
	git("push", "--atomic", "origin", RELEASE_BRANCH, tag);
	console.log(`[ok] pushed ${RELEASE_BRANCH} and ${tag}; the CI release workflow is running.`);
} else {
	console.log(`\nNext (this starts the CI release):\n  git push --atomic origin ${RELEASE_BRANCH} ${tag}`);
}
