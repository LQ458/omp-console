#!/usr/bin/env bash
# Build a debug-signed omp console APK into apps/android/dist/omp-console-debug.apk.
# Needs: node + npm, Android SDK (platform 36, build-tools), JDK 21 (Android Studio's JBR works).
# Gradle caches live in ~/.gradle (outside the repo).
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
cd "$ROOT"

if [ ! -d node_modules/@capacitor/android ]; then
	npm ci --no-audit --no-fund
fi

# Copies www/ into the Android project and regenerates the plugin wiring.
npx cap sync android

./android/gradlew -p android "${GRADLE_ARGS[@]}" assembleDebug

mkdir -p dist
cp android/app/build/outputs/apk/debug/app-debug.apk dist/omp-console-debug.apk
echo "APK: $ROOT/dist/omp-console-debug.apk"

AAPT2="$(ls -d "$ANDROID_HOME"/build-tools/*/aapt2 2>/dev/null | sort -V | tail -1 || true)"
if [ -n "$AAPT2" ]; then
	"$AAPT2" dump badging dist/omp-console-debug.apk | grep -E "^(package|minSdkVersion|targetSdkVersion|uses-permission|launchable-activity|application-label:)" || true
fi
