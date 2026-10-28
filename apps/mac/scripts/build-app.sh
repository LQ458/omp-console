#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
MAC_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
REPO_ROOT=$(CDPATH= cd -- "$MAC_DIR/../.." && pwd)
if [ -n "${BUN:-}" ]; then BUN_COMMAND=$BUN; else BUN_COMMAND=$(command -v bun || true); fi
if [ -z "$BUN_COMMAND" ] || ! command -v "$BUN_COMMAND" >/dev/null 2>&1; then
	printf 'Bun %s not found; install it using the official Bun instructions.\n' "$(awk -F'"' '$2 == "packageManager" { split($4, parts, "@"); print parts[2]; exit }' "$REPO_ROOT/package.json")" >&2
	exit 1
fi
BUN=$(command -v "$BUN_COMMAND")
export BUN
EXPECTED_BUN=$(awk -F'"' '$2 == "packageManager" { split($4, parts, "@"); print parts[2]; exit }' "$REPO_ROOT/package.json")
ACTUAL_BUN=$("$BUN" --version)
if [ "$ACTUAL_BUN" != "$EXPECTED_BUN" ]; then
	printf 'Expected Bun %s from packageManager, found %s\n' "$EXPECTED_BUN" "$ACTUAL_BUN" >&2
	exit 1
fi
"$MAC_DIR/scripts/generate-icon.sh"

(cd "$REPO_ROOT/packages/web" && "$BUN" run build)
cd "$MAC_DIR"
"$BUN" x @tauri-apps/cli@2 build --bundles app --config tauri.conf.json
BUNDLE="$MAC_DIR/target/release/bundle/macos/omp console.app"
LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
INSTALL_APP="/Applications/omp console.app"

# Install only the distinct omp console app, and only when explicitly requested.
if [ "${OMP_CONSOLE_INSTALL:-0}" = "1" ]; then
	# Copy first, swap second: a failed copy leaves an existing omp console install as it was.
	STAGE="/Applications/.omp console.app.new"
	rm -rf "$STAGE"
	trap 'rm -rf "$STAGE"' EXIT
	ditto "$BUNDLE" "$STAGE"
	rm -rf "$INSTALL_APP"
	mv "$STAGE" "$INSTALL_APP"
	trap - EXIT
	"$LSREGISTER" -u "$BUNDLE" 2>/dev/null || true
	rm -rf "$BUNDLE" "$MAC_DIR/dist/omp console.app"
	"$LSREGISTER" -f "$INSTALL_APP"
	printf 'Installed %s (quit and reopen omp console to use it)\n' "$INSTALL_APP"
else
	mkdir -p "$MAC_DIR/dist"
	rm -rf "$MAC_DIR/dist/omp console.app"
	ditto "$BUNDLE" "$MAC_DIR/dist/omp console.app"
	"$LSREGISTER" -u "$BUNDLE" 2>/dev/null || true
	"$LSREGISTER" -u "$MAC_DIR/dist/omp console.app" 2>/dev/null || true
	rm -rf "$BUNDLE"
	printf 'Built %s (not installed)\n' "$MAC_DIR/dist/omp console.app"
fi
