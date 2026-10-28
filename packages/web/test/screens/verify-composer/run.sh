#!/usr/bin/env bash
# Runs the composer behaviour probes against a fresh mock daemon each (they change daemon state).
#   cd packages/web && bun run build && BUN=<pinned bun> bash test/screens/verify-composer/run.sh
# Prints one line per probe: "ok" or the problem strings the probe returned.
set -uo pipefail
cd "$(dirname "$0")/../../.."
BUN="${BUN:-bun}"
PORT="${PORT:-7485}"
status=0
read -r -a probes <<< "${PROBES:-accept-file drop-mapping palette-run slash-run journal-feedback triple-send}"
for probe in "${probes[@]}"; do
	"$BUN" dev/mock-daemon.ts --port "$PORT" --dist dist >/tmp/deck-verify-daemon.log 2>&1 &
	DAEMON=$!
	for _ in $(seq 1 50); do curl -fs -o /dev/null "http://127.0.0.1:$PORT/api/sessions" && break; sleep 0.2; done
	out=$(mktemp -d)
	omp-sweep --url "http://127.0.0.1:$PORT/" --widths 1280 --height 800 --themes dark --probe-only \
		--probe-file "test/screens/verify-composer/$probe.js" --wait-ms 300 --out "$out" >/dev/null 2>&1
	kill "$DAEMON" 2>/dev/null || true
	wait "$DAEMON" 2>/dev/null || true
	problems=$(python3 -c "
import json,sys
r=json.load(open('$out/report.json'))['results'][0]
probe=[p for p in r.get('probe',[])]
err=[i for i in r['issues'] if i.startswith('error')]
print('; '.join(probe+err))
")
	if [ -z "$problems" ]; then echo "$probe: ok"; else echo "$probe: $problems"; status=1; fi
done
exit $status
