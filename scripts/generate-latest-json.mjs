#!/usr/bin/env node
// Generates the Tauri updater feed (latest.json) from the signed bundles
// produced by the windows-build and linux-build jobs. Runs in the
// github-release job after the artifacts are downloaded.
//
// Usage:
//   node scripts/generate-latest-json.mjs <version> <artifacts-dir> <out-file>
//   node scripts/generate-latest-json.mjs 2.2.1 dist-artifacts latest.json
//
// <version> is bare semver (no `v` prefix). Only the updater archives go
// in: the `.msi.zip` (+ `.msi.zip.sig`) for windows-x86_64 and the
// `.AppImage.tar.gz` (+ `.tar.gz.sig`) for linux-x86_64. The raw
// `.msi`/`.deb`/`.AppImage`/APK stay manual-download only.
//
// latest.json shape (https://v2.tauri.app/plugin/updater/):
// {
//   "version": "2.2.1",
//   "notes": "...",
//   "pub_date": "2026-…Z",
//   "platforms": {
//     "windows-x86_64": { "signature": "<sig file contents>", "url": "https://…/releases/download/v2.2.1/….msi.zip" },
//     "linux-x86_64":   { "signature": "<sig file contents>", "url": "https://…/releases/download/v2.2.1/….AppImage.tar.gz" }
//   }
// }
// `signature` is the *contents* of the .sig file, not a path.
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const REPO = "sayed-rafi-bd/PrintNinja";

function findRecursive(dir, pred, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) findRecursive(full, pred, out);
    else if (pred(full)) out.push(full);
  }
  return out;
}

const [version, artifactsDir, outFile] = process.argv.slice(2);
if (!version || !artifactsDir || !outFile) {
  console.error("usage: generate-latest-json.mjs <version> <artifacts-dir> <out-file>");
  process.exit(2);
}
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`version must be bare semver (no v prefix), got: ${version}`);
  process.exit(2);
}
const tag = `v${version}`;

const winZips = findRecursive(artifactsDir, (f) => f.endsWith(".msi.zip") && !f.endsWith(".sig"));
const linTars = findRecursive(artifactsDir, (f) => f.endsWith(".AppImage.tar.gz") && !f.endsWith(".sig"));
if (winZips.length === 0) {
  console.error("no .msi.zip updater archive found");
  process.exit(1);
}
if (linTars.length === 0) {
  console.error("no .AppImage.tar.gz updater archive found");
  process.exit(1);
}

function entry(bundlePath) {
  const sig = readFileSync(`${bundlePath}.sig`, "utf8").trim();
  const name = bundlePath.split("/").pop();
  return {
    signature: sig,
    url: `https://github.com/${REPO}/releases/download/${tag}/${name}`,
  };
}

// First match wins; jobs emit exactly one archive per platform.
const platforms = {
  "windows-x86_64": entry(winZips.sort()[0]),
  "linux-x86_64": entry(linTars.sort()[0]),
};

const feed = {
  version,
  notes: `PrintNinja ${tag}`,
  pub_date: new Date().toISOString(),
  platforms,
};
writeFileSync(outFile, `${JSON.stringify(feed, null, 2)}\n`);
console.log(`wrote ${outFile} for ${tag}`);
