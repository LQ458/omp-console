#!/usr/bin/env bash
# Screenshots and checks of the tiled panes, queue chips and prompt history (U2) with omp-sweep against the mock daemon.
#   cd packages/web && bun run build && BUN=<pinned bun> bash test/screens/capture-panes.sh [out-dir]
# PNGs land in <out-dir>/panes-<device>-<state>-<theme>.png; devices: desktop 1280x800, iphone 393x852.
# A probe's problem strings are printed; no output means every check passed.
set -euo pipefail
cd "$(dirname "$0")/../.."
BUN="${BUN:-bun}"
OUT="${1:-test/screens}"
PORT="${PORT:-7485}"
PROBES=test/screens/probes-panes
STATES_DESKTOP="${STATES_DESKTOP:-one split2 grid4 six zoom keys queue history layouts restore closezoom header-overflow}"
STATES_PHONE="${STATES_PHONE:-phone}"
mkdir -p "$OUT"

"$BUN" dev/mock-daemon.ts --port "$PORT" --dist dist --panes >/tmp/deck-panes-shots-daemon.log 2>&1 &
DAEMON=$!
trap 'kill $DAEMON 2>/dev/null || true' EXIT
for _ in $(seq 1 50); do curl -fs "http://127.0.0.1:$PORT/api/health" >/dev/null && break; sleep 0.2; done

TMP=$(mktemp -d)
shoot() {
	name=$1; width=$2; height=$3; state=$4
	# Each probe is the shared prelude plus its own steps, wrapped as one async expression.
	{ echo "(async () => {"; cat "$PROBES/prelude.js"; cat "$PROBES/$state.js"; echo "return problems; })()"; } >"$TMP/$state.js"
	omp-sweep --url "http://127.0.0.1:$PORT/" --widths "$width" --height "$height" --themes light,dark \
		--storage omp-console-theme --probe-file "$TMP/$state.js" --probe-only --wait-ms 1200 --out "$TMP/$name-$state" >"$TMP/$name-$state.log" 2>&1 || true
	# Probe problem strings (report.json carries them only when there are some).
	"$BUN" -e 'const r = await Bun.file(process.argv[1] + "/report.json").json(); const seen = new Set(); for (const x of r.results ?? []) for (const p of x.probe ?? []) seen.add(p); for (const p of seen) console.log("[" + process.argv[2] + "] " + p);' "$TMP/$name-$state" "$name $state" || true
	for theme in light dark; do
		png=$(ls "$TMP/$name-$state"/*_"${width}"_"$theme".png 2>/dev/null | head -1)
		[ -z "$png" ] && continue
		cp "$png" "$OUT/panes-$name-$state-$theme.png"
		if [ "$name" != iphone ] && command -v sips >/dev/null; then sips -Z 1100 "$OUT/panes-$name-$state-$theme.png" >/dev/null; fi
		if command -v magick >/dev/null; then magick "$OUT/panes-$name-$state-$theme.png" -strip -dither None -colors 128 "PNG8:$OUT/panes-$name-$state-$theme.png"; fi
	done
}
for state in $STATES_DESKTOP; do shoot desktop 1280 800 "$state"; done
for state in $STATES_PHONE; do shoot iphone 393 852 "$state"; done
echo "screens written to $OUT; sweep logs in $TMP"
