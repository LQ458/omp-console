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
URL=${1:-http://127.0.0.1:7490}

cd "$MAC_DIR"
mkdir -p "$MAC_DIR/target"
printf '%s' "$URL" > "$MAC_DIR/target/dev-daemon-url"
"$BUN" run scripts/serve-ui.ts &
SERVER_PID=$!
cleanup() {
	kill "$SERVER_PID" 2>/dev/null || true
	wait "$SERVER_PID" 2>/dev/null || true
	rm -f "$MAC_DIR/target/dev-daemon-url"
}
trap cleanup EXIT INT TERM

ready=0
for _ in $(seq 1 40); do
	if curl --silent --fail http://127.0.0.1:1420/ >/dev/null; then
		ready=1
		break
	fi
	sleep 0.25
done
if [ "$ready" -ne 1 ]; then
	printf 'Local Tauri UI server did not start on 127.0.0.1:1420\n' >&2
	exit 1
fi

OMP_CONSOLE_DAEMON_URL_FILE="$MAC_DIR/target/dev-daemon-url" "$BUN" x @tauri-apps/cli@2 dev --config tauri.dev.conf.json
