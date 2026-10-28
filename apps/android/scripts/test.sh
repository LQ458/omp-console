#!/usr/bin/env bash
# URL validation tests (node) and the native mirror (JUnit via Gradle).
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
cd "$ROOT"
node --test test/url.test.mjs test/notification-bridge.test.mjs
./android/gradlew -p android "${GRADLE_ARGS[@]}" testDebugUnitTest
