# omp-console Android app

Sideloadable Android shell for the omp console web UI. A Capacitor 8 app (`dev.ompconsole.mobile`, minSdk 24, targetSdk 36) whose WebView loads the daemon's web UI from the URL you enter, normally the Tailscale HTTPS URL (`https://<machine>.<tailnet>.ts.net`). No Google Play, no Firebase or Google services, nothing is uploaded or published.

This package is not a Bun workspace member. It uses npm, Gradle and a JDK 21.

## Build and install

```sh
apps/android/scripts/build-apk.sh        # -> apps/android/dist/omp-console-debug.apk (debug-signed)
apps/android/scripts/install-apk.sh      # adb install -r + launch; -s <serial> to pick a device
```

Requirements: node and npm, Android SDK at `~/Library/Android/sdk` (override `ANDROID_HOME`; platform 36 and build-tools), and JDK 21. The scripts pick Android Studio's bundled JBR 21 (override `OMP_CONSOLE_JAVA_HOME`) and pass `-Dorg.gradle.java.home` so a different `org.gradle.java.home` in `~/.gradle/gradle.properties` cannot break the build. Gradle caches stay in `~/.gradle`. The APK is signed with your machine's debug keystore, so an APK built on another machine cannot update this install in place.

`install-apk.sh` needs `adb`. If `platform-tools` is missing it installs it with `sdkmanager` only when the SDK licences are already accepted; otherwise it stops and tells you to accept them yourself.

Tests: `scripts/test.sh` (URL validation under `node --test`, plus the JUnit mirror of it in `DaemonUrlTest`).

Emulator or device smoke test: `apps/android/scripts/e2e-emulator.sh [-s serial]` (debug APK installed, a device attached). It serves `apps/android/test/e2e-site`, seeds the URL, launches the app, backgrounds it, and asserts the page loaded with `window.OmpConsoleAndroid` and that `notify()` produced a notification while the app was in the background.

## Behaviour

- **First run:** a local screen asks for the daemon URL (validated; stored with Capacitor Preferences under `daemonUrl`) and asks for the Android 13+ notification permission once. Later runs go straight to the daemon.
- **URL rules:** `https://` for any host; plain `http://` only for `localhost` and private, loopback or link-local IPv4 (`10/8`, `172.16/12`, `192.168/16`, `127/8`, `169.254/16`, and `10.0.2.2` for the emulator host). A bare host gets `https://`. Query and fragment are dropped, credentials are rejected. `www/url.js` validates for the UI; `DaemonUrl.java` re-validates before the native bridge trusts an origin. Plain http needs `usesCleartextTraffic`, which Android only offers app-wide; the WebView still blocks mixed content.
- **Changing the URL later:** (1) press and hold the top-left corner of the screen (64 dp square) for one second, (2) long-press the app icon and choose "Change daemon URL", or (3) "Change daemon URL" on the retry screen. All open the same screen, prefilled.
- **Unreachable daemon:** a failed main-frame load (any WebView network error, or HTTP 5xx, 401, 403) shows a retry screen with the failed URL and reason, never a blank WebView. Exercised on the emulator: connection refused and a blocked port, then Retry after the server came up. For an https daemon the screen also re-probes every 10 s and reconnects on its own (written, not exercised: the emulator test used plain http). Plain-http daemons are retried by hand (mixed content blocks the probe).
- **WebView:** a real WebView, not a Custom Tab. Back goes through WebView history, then moves the app to the background; the launcher and retry screens are not history. Pinch zoom is off. System-bar and keyboard insets are handled by Capacitor's `SystemBars` plugin: the page is inset below the status bar and above the navigation bar (seen on the emulator); with `viewport-fit=cover` on WebView 140+ it passes insets through as `env(safe-area-inset-*)` instead (from the plugin source, not exercised). Links to other origins open in the system browser (seen: Chrome opened). The file chooser opens the system picker (seen; no file was attached).
- **Microphone:** `getUserMedia({audio})` makes Android ask for `RECORD_AUDIO` at that moment. It requires a secure context: `https://`, or `http://localhost`. `http://10.0.2.2` and LAN IPs are not secure contexts, so voice does not work there; that is browser policy, not the app.
- **Camera** is not declared. A file input with `capture` falls back to the file picker.

## Notification bridge: `window.OmpConsoleAndroid`

The web UI runs on the daemon origin, where Capacitor's own JS bridge is not injected (its origin allow-list is fixed at build time). The app therefore gives the page a small, origin-scoped bridge: a document-start script (`android/app/src/main/assets/deck-android-shim.js`) and a WebMessageListener, both bound to exactly the stored daemon origin and nothing else (no Preferences, no other Capacitor plugin).

```js
window.OmpConsoleAndroid?.available   // true inside the app
window.OmpConsoleAndroid.notify(title, body, tag, actions?) // -> boolean
// actions: up to 3 { title, value, token, url } entries
```

Messages are clamped (title 120, body 400, tag 64 chars) and become notifications through the Capacitor LocalNotifications plugin: posted immediately, default channel, no exact alarms. Notifications with answer actions register up to three native buttons; an action posts `{token, value}` to `/api/push/answer` with same-origin credentials. Success shows a short confirmation; a rejected or unavailable answer opens the same-origin session URL. Tapping the notification body also opens that session. If `POST_NOTIFICATIONS` is not granted the call is dropped (logged as `OmpConsoleBridge`). The shell also gives the page a stub `window.Capacitor.triggerEvent`, so the `pause` and `resume` events it fires become DOM events on `document` instead of an uncaught TypeError.

For hidden `needs-answer` and `needs-approval` signals, the web UI sends `POST /api/push/answer-options` and passes the choices, token, and same-origin session URL as `actions`.

### What this does not do

It does not wake a suspended app. A local notification can only be posted by code that is running. Push to a suspended Android app needs a separate UnifiedPush/ntfy receiver spike; nothing here claims to do that.

Measured on the Android 16 arm64 emulator (one run each, not a real device):

- Backgrounded with no foreground service, a page's WebSocket kept exchanging 1 s pings for the 45 s observed, and `notify()` fired from a background page timer.
- Under forced deep idle (`dumpsys deviceidle force-idle`, 40 s) the page's timer kept running but its network traffic was held: 48 s of pings reached the server in one burst when the app returned to the foreground, and the connection was not closed. Real devices differ (battery state, OEM task killers); expect the daemon to see silence while the tablet dozes.

### Foreground service: omitted

A `dataSync` foreground service would be the platform way to keep the socket usable in the background. It is not implemented, because it could not be shown to keep a WebSocket alive: the emulator test above shows what happens without one, and nothing measured shows a service changing it. Android 15+ also limits `dataSync` services to 6 hours per 24 hours (afterwards `Service.onTimeout()` must call `stopSelf()` within seconds, and a new one cannot start until the user opens the app) [developer.android.com/develop/background-work/services/fgs/timeout, read 2026-10-22], so it would not give an always-on connection anyway.

## Permissions (from `aapt2 dump badging`)

`INTERNET`, `POST_NOTIFICATIONS`, `RECORD_AUDIO`, `MODIFY_AUDIO_SETTINGS`, `WAKE_LOCK` (declared by the LocalNotifications plugin). `SCHEDULE_EXACT_ALARM` and `RECEIVE_BOOT_COMPLETED`, which that plugin also declares, are removed in the manifest because nothing is scheduled.

## Layout

- `www/`: local launcher and retry screens (plain ES modules, served by Capacitor at `https://localhost`).
- `android/`: the generated Capacitor project, committed because it carries the app code. `app/src/main/java/dev/ompconsole/mobile/`: `MainActivity`, `DeckWebViewClient` (navigation policy, error screen), `DeckBridge` (notification bridge), `DaemonUrl`.
- `scripts/`: `build-apk.sh`, `install-apk.sh`, `test.sh`, `e2e-emulator.sh`, `env.sh` (SDK and JDK lookup).
- `test/`: URL validation tests and the emulator test site.
- Generated and ignored: `node_modules/`, `dist/`, `android/app/build`, `android/app/src/main/assets/public`, `android/capacitor-cordova-android-plugins`.

## Pair with the macOS host

On the host, start the daemon with an owner login and the exact Serve hostname, then run `./ops/tailscale-serve.sh` from the repository root. Authorize this phone in that same Tailscale account, enter the printed HTTPS URL in the app, and pair it with a code from Settings → Devices on an already paired device (or `omp-console-daemon pair` on the host). Tailscale authorization and the owner check only narrow access; they never replace the device pairing. The host setup and threat model are in the repository [README](../../README.md) and [SECURITY.md](../../SECURITY.md).
