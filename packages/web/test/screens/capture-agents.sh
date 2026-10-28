#!/usr/bin/env bash
# Screenshots of the agent graph, tree, model picker and profiles panel (B4) with omp-sweep against the mock daemon.
#   cd packages/web && bun run build && BUN=<pinned bun> bash test/screens/capture-agents.sh [out-dir]
# PNGs land in <out-dir>/<device>-<state>-<theme>.png; devices: iphone 393x852, desktop 1280x800.
set -euo pipefail
cd "$(dirname "$0")/../.."
BUN="${BUN:-bun}"
OUT="${1:-test/screens}"
PORT="${PORT:-7482}"
PROBES=test/screens/probes-agents
mkdir -p "$OUT"

"$BUN" dev/mock-daemon.ts --port "$PORT" --dist dist --agent-tree >/tmp/deck-agent-shots-daemon.log 2>&1 &
DAEMON=$!
trap 'kill $DAEMON 2>/dev/null || true' EXIT
for _ in $(seq 1 50); do curl -fs "http://127.0.0.1:$PORT/api/health" >/dev/null && break; sleep 0.2; done

TMP=$(mktemp -d)
for device in "iphone 393 852" "desktop 1280 800"; do
	set -- $device
	name=$1; width=$2; height=$3
	for state in agent-graph agent-tree model-picker model-changed profiles profiles-confirm; do
		omp-sweep --url "http://127.0.0.1:$PORT/" --widths "$width" --height "$height" --themes light,dark \
			--storage omp-console-theme --probe-file "$PROBES/$state.js" --wait-ms 1200 --out "$TMP/$name-$state" >"$TMP/$name-$state.log" 2>&1 || true
		for theme in light dark; do
			png=$(ls "$TMP/$name-$state"/*_"${width}"_"$theme".png 2>/dev/null | head -1)
			[ -z "$png" ] && continue
			cp "$png" "$OUT/$name-$state-$theme.png"
			if [ "$name" != iphone ] && command -v sips >/dev/null; then sips -Z 900 "$OUT/$name-$state-$theme.png" >/dev/null; fi
			if command -v magick >/dev/null; then magick "$OUT/$name-$state-$theme.png" -strip -dither None -colors 128 "PNG8:$OUT/$name-$state-$theme.png"; fi
		done
	done
done
echo "screens written to $OUT; sweep logs in $TMP"
