#!/usr/bin/env bash
# Release script for PrintNinja
# Renames app, updates version, creates git tag.
# Usage:
#   ./scripts/release.sh [--name <AppName>] [--version <X.Y.Z>] [--tag]
#   ./scripts/release.sh 1.0.0
# Examples:
#   ./scripts/release.sh --version 1.0.0 --tag
#   ./scripts/release.sh --name "MyPrint" --version 1.2.0 --tag
set -euo pipefail

APP_NAME="PrintNinja"
VERSION=""
CREATE_TAG=false
BUMP_ONLY=false

usage() {
    cat <<EOF
Usage: $0 [VERSION] [--name NAME] [--version X.Y.Z] [--tag] [--bump]

Rename the app, update version across config files, commit, and tag a release.

Options:
  VERSION            Positional version (e.g. 1.0.0)
  --name NAME       New app name (default: PrintNinja)
  --version X.Y.Z   New version string
  --tag             Create a git tag after committing
  --bump            Only bump patch version (x.y.z -> x.y.z+1)
  --help            Show this help
EOF
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --name) APP_NAME="$2"; shift 2;;
        --version) VERSION="$2"; shift 2;;
        --tag) CREATE_TAG=true; shift;;
        --bump) BUMP_ONLY=true; shift;;
        --help) usage; exit 0;;
        -*)
            echo "Unknown option: $1" >&2; usage; exit 1;;
        *)
            VERSION="$1"; shift;;
    esac
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Determine version
if $BUMP_ONLY; then
    CURRENT=$(grep -m1 '^version = ' src-tauri/Cargo.toml | sed -E 's/version = "([^"]+)"/\1/')
    IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT"
    PATCH=$((PATCH + 1))
    VERSION="$MAJOR.$MINOR.$PATCH"
    echo "Bumped to $VERSION"
fi

if [[ -z "$VERSION" ]]; then
    echo "Error: version required" >&2
    usage; exit 1
fi

# Validate version format
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "Error: version must be X.Y.Z" >&2
    exit 1
fi

echo "=== Release: $APP_NAME v$VERSION ==="

# 1. Update Cargo.toml
# Only touch the [package] table: [lib] also has a `name =` line that must
# stay in sync with src/main.rs (`printninja::run()`), so a blanket sed on
# `^name =` would rename the library too.
CRATE_NAME="$(echo "$APP_NAME" | tr '[:upper:]' '[:lower:]')"
sed -i -E "/^\[package\]/,/^\[(lib|build-dependencies|dependencies)\]/{s/^name = \"[^\"]+\"/name = \"$CRATE_NAME\"/;s/^version = \"[^\"]+\"/version = \"$VERSION\"/}" src-tauri/Cargo.toml
echo "[ok] Cargo.toml -> $VERSION"

# Keep Cargo.lock in step so `cargo build --locked` does not fail on a tag build.
python3 - "$VERSION" "$CRATE_NAME" <<'PY'
import re, sys
version, name = sys.argv[1], sys.argv[2]
path = "src-tauri/Cargo.lock"
with open(path) as f:
    lock = f.read()
pattern = r'(\[\[package\]\]\nname = "' + re.escape(name) + r'"\nversion = ")[^"]+(")'
lock, n = re.subn(pattern, lambda m: m.group(1) + version + m.group(2), lock)
if n != 1:
    print(f"[warn] Cargo.lock: package {name} not found; run `cargo update -w`", file=sys.stderr)
else:
    with open(path, "w") as f:
        f.write(lock)
    print(f"[ok] Cargo.lock -> {version}")
PY

# 2. Update tauri.conf.json
python3 - "$VERSION" "$APP_NAME" <<'PY'
import json, sys
path = "src-tauri/tauri.conf.json"
with open(path) as f:
    cfg = json.load(f)
cfg["productName"] = sys.argv[2]
cfg["version"] = sys.argv[1]
# Not ".app": a bundle id ending in .app clashes with the macOS bundle extension.
cfg["identifier"] = "com." + sys.argv[2].lower() + ".desktop"
with open(path, "w") as f:
    json.dump(cfg, f, indent=2)
    f.write("\n")
print(f"[ok] tauri.conf.json -> {sys.argv[2]} v{sys.argv[1]}")
PY

# 3. Update package.json
python3 - "$VERSION" "$APP_NAME" <<'PY'
import json, sys
path = "package.json"
with open(path) as f:
    cfg = json.load(f)
cfg["name"] = sys.argv[2].lower()
cfg["version"] = sys.argv[1]
with open(path, "w") as f:
    json.dump(cfg, f, indent=2)
    f.write("\n")
print(f"[ok] package.json -> v{sys.argv[1]}")
PY

# 3b. Update Settings.tsx fallback version
if grep -q 'PrintNinja {appVersion' src/pages/Settings.tsx 2>/dev/null; then
  sed -i -E "s/\"v[0-9]+\.[0-9]+\.[0-9]+\"/\"v$VERSION\"/" src/pages/Settings.tsx
  echo "[ok] Settings.tsx -> v$VERSION"
fi

# 4. Commit with version in message, tag with version
git add package.json src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/tauri.conf.json src/pages/Settings.tsx
git commit -m "release: v$VERSION" -m "Release $APP_NAME $VERSION" || echo "[info] no changes to commit"

if $CREATE_TAG; then
    TAG="v$VERSION"
    git tag -a "$TAG" -m "release: v$VERSION" -m "Release $APP_NAME $TAG" 2>/dev/null || echo "[info] tag $TAG exists"
    echo "[ok] tagged $TAG with 'release: v$VERSION'"
fi

echo "=== Done: $APP_NAME v$VERSION ==="
echo "Next:"
echo "  git push origin main && git push origin v$VERSION"
echo "Pushing the tag triggers the CI release workflow, which builds the"
echo "Windows MSI and Android artifacts and attaches them to a GitHub Release."
