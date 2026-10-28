#!/usr/bin/env bash
# Install the built APK with adb: install-apk.sh [-s <serial>] [path/to/app.apk]
# With no -s and several devices attached, adb asks you to choose; pass -s.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"

SERIAL=()
if [ "${1:-}" = "-s" ]; then
	SERIAL=(-s "$2")
	shift 2
fi
APK="${1:-$ROOT/dist/omp-console-debug.apk}"
[ -f "$APK" ] || { echo "No APK at $APK; run scripts/build-apk.sh first." >&2; exit 1; }

if [ ! -x "$ADB" ]; then
	# platform-tools is missing. Install it only when the SDK licences are already accepted.
	if [ ! -f "$ANDROID_HOME/licenses/android-sdk-license" ]; then
		echo "adb is missing and the Android SDK licences are not accepted. Accept them yourself (sdkmanager --licenses), then rerun." >&2
		exit 1
	fi
	"$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" --install platform-tools
fi

# ${arr[@]+...} keeps macOS's bash 3.2 happy when no -s was given.
"$ADB" ${SERIAL[@]+"${SERIAL[@]}"} install -r "$APK"
	"$ADB" ${SERIAL[@]+"${SERIAL[@]}"} shell am start -n dev.ompconsole.mobile/.MainActivity >/dev/null
echo "Installed and started dev.ompconsole.mobile"
