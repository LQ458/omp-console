#!/usr/bin/env bash
# Screenshots of workspaces, look/mode badges, rules editor, quick-ask, actions panel, drift card and move preview (U1)
# with omp-sweep against the mock daemon (--workspaces).
#   cd packages/web && bun run build && BUN=<pinned bun> bash test/screens/capture-workspaces.sh [out-dir]
# PNGs land in <out-dir>/workspaces-<device>-<state>-<theme>.png; devices: iphone 393x852, desktop 1280x800.
# Each probe is a body of statements run after probes-workspaces/prelude.js; a non-empty returned array is listed as an issue.
set -euo pipefail
cd "$(dirname "$0")/../.."
BUN="${BUN:-bun}"
OUT="${1:-test/screens}"
PORT="${PORT:-7483}"
PROBES=test/screens/probes-workspaces
mkdir -p "$OUT"

TMP=$(mktemp -d)
STATES="${STATES:-session-relay session-docs session-job session-scratch panel panel-handoff rules-private rules-shared quick-ask-open quick-ask-answer actions move-needs-mac move-preview moves}"
for state in $STATES; do
	{ echo "(async () => {"; cat "$PROBES/prelude.js"; cat "$PROBES/$state.js"; echo "})()"; } >"$TMP/$state.js"
done

for device in "iphone 393 852" "desktop 1280 800"; do
	set -- $device
	name=$1; width=$2; height=$3
	for state in $STATES; do
		# One fresh daemon per run: probes that save, ask or prepare moves start from the same state.
		"$BUN" dev/mock-daemon.ts --port "$PORT" --dist dist --workspaces >"$TMP/daemon.log" 2>&1 &
		DAEMON=$!
		for _ in $(seq 1 50); do curl -fs "http://127.0.0.1:$PORT/api/sessions" >/dev/null && break; sleep 0.2; done
		omp-sweep --url "http://127.0.0.1:$PORT/" --widths "$width" --height "$height" --themes light,dark \
			--storage omp-console-theme --probe-file "$TMP/$state.js" --wait-ms 1200 --out "$TMP/$name-$state" >"$TMP/$name-$state.log" 2>&1 || true
		kill "$DAEMON" 2>/dev/null || true
		wait "$DAEMON" 2>/dev/null || true
		for theme in light dark; do
			png=$(ls "$TMP/$name-$state"/*_"${width}"_"$theme".png 2>/dev/null | head -1)
			[ -z "$png" ] && continue
			cp "$png" "$OUT/workspaces-$name-$state-$theme.png"
			if [ "$name" != iphone ] && command -v sips >/dev/null; then sips -Z 900 "$OUT/workspaces-$name-$state-$theme.png" >/dev/null; fi
			if command -v magick >/dev/null; then magick "$OUT/workspaces-$name-$state-$theme.png" -strip -dither None -colors 128 "PNG8:$OUT/workspaces-$name-$state-$theme.png"; fi
		done
	done
done
echo "screens written to $OUT; sweep logs in $TMP"
grep -l "issues\|problem" "$TMP"/*.log 2>/dev/null || true
