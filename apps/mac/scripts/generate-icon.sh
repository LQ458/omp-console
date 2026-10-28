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
SOURCE="$REPO_ROOT/packages/web/public/icon-512.png"
ICONSET="$MAC_DIR/icons/omp-console.iconset"

if [ ! -f "$SOURCE" ]; then
	printf 'PWA source icon not found: %s\n' "$SOURCE" >&2
	exit 1
fi
mkdir -p "$ICONSET"
cp "$SOURCE" "$MAC_DIR/icons/icon.png"
sips -s format png -z 16 16 "$SOURCE" --out "$ICONSET/icon_16x16.png" >/dev/null
sips -s format png -z 32 32 "$SOURCE" --out "$ICONSET/icon_16x16@2x.png" >/dev/null
sips -s format png -z 32 32 "$SOURCE" --out "$ICONSET/icon_32x32.png" >/dev/null
sips -s format png -z 64 64 "$SOURCE" --out "$ICONSET/icon_32x32@2x.png" >/dev/null
sips -s format png -z 128 128 "$SOURCE" --out "$ICONSET/icon_128x128.png" >/dev/null
sips -s format png -z 256 256 "$SOURCE" --out "$ICONSET/icon_128x128@2x.png" >/dev/null
sips -s format png -z 256 256 "$SOURCE" --out "$ICONSET/icon_256x256.png" >/dev/null
sips -s format png -z 512 512 "$SOURCE" --out "$ICONSET/icon_256x256@2x.png" >/dev/null
sips -s format png -z 512 512 "$SOURCE" --out "$ICONSET/icon_512x512.png" >/dev/null
sips -s format png -z 1024 1024 "$SOURCE" --out "$ICONSET/icon_512x512@2x.png" >/dev/null
iconutil -c icns "$ICONSET" -o "$MAC_DIR/icons/icon.icns"
# The Windows installers need a multi-size .ico; Tauri's icon command writes it from the same source.
ICO_TMP=$(mktemp -d)
"$BUN" x @tauri-apps/cli@2 icon "$SOURCE" -o "$ICO_TMP" >/dev/null 2>&1
cp "$ICO_TMP/icon.ico" "$MAC_DIR/icons/icon.ico"
rm -rf "$ICO_TMP"
printf 'Generated %s and icon.ico from packages/web/public/icon-512.png\n' "$MAC_DIR/icons/icon.icns"
