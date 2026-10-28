# Sourced by the other scripts. Resolves the SDK and a JDK 21 (Capacitor 8 / Android Gradle Plugin need 21).
# Override with ANDROID_HOME and OMP_CONSOLE_JAVA_HOME.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
export ANDROID_SDK_ROOT="$ANDROID_HOME"

if [ ! -d "$ANDROID_HOME/platforms" ]; then
	echo "Android SDK not found at $ANDROID_HOME (set ANDROID_HOME)." >&2
	exit 1
fi

java_major() { "$1/bin/java" -version 2>&1 | sed -n '1s/.*version "\([0-9]*\).*/\1/p'; }

JAVA_CANDIDATES=(
	"${OMP_CONSOLE_JAVA_HOME:-}"
	"/Applications/Android Studio.app/Contents/jbr/Contents/Home"
	"$(/usr/libexec/java_home -v 21 2>/dev/null || true)"
)
OMP_CONSOLE_JDK=""
for candidate in "${JAVA_CANDIDATES[@]}"; do
	if [ -n "$candidate" ] && [ -x "$candidate/bin/java" ] && [ "$(java_major "$candidate")" = "21" ]; then
		OMP_CONSOLE_JDK="$candidate"
		break
	fi
done
if [ -z "$OMP_CONSOLE_JDK" ]; then
	echo "No JDK 21 found. Install Android Studio (bundled JBR 21) or set OMP_CONSOLE_JAVA_HOME to a JDK 21." >&2
	exit 1
fi
export JAVA_HOME="$OMP_CONSOLE_JDK"
# -D on the command line beats org.gradle.java.home in ~/.gradle/gradle.properties.
GRADLE_ARGS=("-Dorg.gradle.java.home=$OMP_CONSOLE_JDK")

ADB="$ANDROID_HOME/platform-tools/adb"
