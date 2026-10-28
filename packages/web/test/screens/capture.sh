#!/usr/bin/env bash
# Captures the omp console UI states with omp-sweep (headless Chromium, own process) against the mock daemon.
#   cd packages/web && bun run build && bash test/screens/capture.sh [out-dir]
# Needs: omp-sweep on PATH, a pinned bun in $BUN. PNGs land in <out-dir>/<device>-<state>-<theme>.png.
set -euo pipefail
cd "$(dirname "$0")/../.."
BUN="${BUN:-bun}"
OUT="${1:-test/screens}"
PORT="${PORT:-7481}"
PROBES=test/screens/probes
mkdir -p "$OUT"

"$BUN" dev/mock-daemon.ts --port "$PORT" --dist dist --fixtures >/tmp/deck-shots-daemon.log 2>&1 &
DAEMON=$!
trap 'kill $DAEMON 2>/dev/null || true' EXIT
for _ in $(seq 1 50); do curl -fs "http://127.0.0.1:$PORT/api/health" >/dev/null && break; sleep 0.2; done

TMP=$(mktemp -d)
# device name, width, height
for device in "iphone 393 852" "ipad 820 1180" "desktop 1280 800"; do
	set -- $device
	name=$1; width=$2; height=$3
	for state in transcript-stream sessions needs-bar ask-form status settings; do
		omp-sweep --url "http://127.0.0.1:$PORT/" --widths "$width" --height "$height" --themes light,dark \
			--storage omp-console-theme --probe-file "$PROBES/$state.js" --wait-ms 1200 --out "$TMP/$name-$state" >"$TMP/$name-$state.log" 2>&1 || true
		for theme in light dark; do
			png=$(ls "$TMP/$name-$state"/*_"${width}"_"$theme".png 2>/dev/null | head -1)
			[ -z "$png" ] && continue
			cp "$png" "$OUT/$name-$state-$theme.png"
			# Keep the committed files small: the tablet and desktop shots are scaled to 900 px on the long side.
			if [ "$name" != iphone ] && command -v sips >/dev/null; then sips -Z 900 "$OUT/$name-$state-$theme.png" >/dev/null; fi
			# 128-colour palette: UI screenshots lose nothing visible and shrink about 5x.
			if command -v magick >/dev/null; then magick "$OUT/$name-$state-$theme.png" -strip -dither None -colors 128 "PNG8:$OUT/$name-$state-$theme.png"; fi
		done
	done
done
echo "screens written to $OUT; sweep logs in $TMP"
