#!/usr/bin/env bash
# Emulator/device smoke test (debug APK, one device attached; pass -s <serial> otherwise).
# Serves test/e2e-site on a local port, seeds the daemon URL, launches the app, sends it to the
# background, and asserts that (1) the WebView loaded the page with the OmpConsoleAndroid shim and
# (2) the page's delayed notify() produced a real notification while the app was backgrounded.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"

SERIAL=()
if [ "${1:-}" = "-s" ]; then SERIAL=(-s "$2"); shift 2; fi
PORT="${OMP_CONSOLE_E2E_PORT:-8099}"
PKG=dev.ompconsole.mobile
adb() { "$ADB" ${SERIAL[@]+"${SERIAL[@]}"} "$@"; }

python3 "$ROOT/test/e2e-site/serve.py" "$PORT" >/dev/null 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true' EXIT

# http://localhost is a secure context on the device, so getUserMedia works there too.
adb reverse "tcp:$PORT" "tcp:$PORT" >/dev/null
adb shell pm clear "$PKG" >/dev/null
adb shell pm grant "$PKG" android.permission.POST_NOTIFICATIONS
adb shell pm grant "$PKG" android.permission.RECORD_AUDIO

# Seed what the launcher would have saved (Capacitor Preferences group "CapacitorStorage").
PREFS="$(mktemp)"
cat >"$PREFS" <<XML
<?xml version='1.0' encoding='utf-8' standalone='yes' ?>
<map>
    <string name="daemonUrl">http://localhost:$PORT/auto/</string>
    <string name="notificationPermissionAsked">1</string>
</map>
XML
adb push "$PREFS" /data/local/tmp/CapacitorStorage.xml >/dev/null
rm -f "$PREFS"
adb shell "run-as $PKG sh -c 'mkdir -p shared_prefs && cp /data/local/tmp/CapacitorStorage.xml shared_prefs/'"

adb logcat -c
adb shell am start -n "$PKG/.MainActivity" >/dev/null
fail() { echo "FAIL: $*" >&2; exit 1; }
# A cold WebView (first launch after boot or pm clear) can take longer than 3 s to reach the page: wait for it.
loaded=false
for _ in $(seq 1 20); do
	if adb logcat -d | grep -q "\[omp-console-test\] origin=http://localhost:$PORT OmpConsoleAndroid=object"; then loaded=true; break; fi
	sleep 1
done
[ "$loaded" = true ] || fail "page did not load with window.OmpConsoleAndroid"
echo "ok: WebView loaded http://localhost:$PORT/auto/ with window.OmpConsoleAndroid"
adb shell input keyevent KEYCODE_HOME # page arms notify() 8 s after load; the app is now backgrounded

for _ in $(seq 1 25); do
	if adb shell dumpsys notification --noredact | grep -q "android.title=String (omp console: needs answer)"; then
		echo "ok: notification posted while the app was in the background"
		exit 0
	fi
	sleep 1
done
fail "no notification from the omp console Android bridge"
