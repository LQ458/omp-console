# omp console desktop apps

## Download

Tagged releases attach the macOS (Apple Silicon), Windows (x64), and Linux (x64 and arm64) apps to the [Releases page](https://github.com/LQ458/omp-console/releases); the [Release workflow](../../.github/workflows/release.yml) builds them and creates a draft release for a maintainer to publish. Installation steps for each system, including the unsigned-app prompts, are in the [install guide](../../docs/INSTALL.md#8-optional-the-desktop-app).

## Linux desktop app

Between releases, the [Desktop Linux workflow](../../.github/workflows/desktop-linux.yml) builds the Linux app on pushes to `main`. Open the successful Actions run, download the `omp-console-linux-x64` artifact, and extract it.

- Debian/Ubuntu: install the `.deb` with `sudo apt install ./omp-console_*.deb`.
- AppImage: make the `.AppImage` executable with `chmod +x omp-console*.AppImage`, then launch it.

The app connects to `http://127.0.0.1:7490` on first launch; start the omp-console daemon first. Pairing reads `~/.omp-console/pairing-code`. If that file is missing, run `omp-console pair` in a terminal, then reopen the app. The desktop package registers `omp-console://` links. Project moves between computers require macOS. On Wayland the system does not permit a global shortcut; the app shows a notification and can be reopened from the applications menu.


The native Tauri 2 shell loads the configured omp-console daemon. On macOS it uses the system WKWebView; on Linux it uses WebKitGTK; on Windows it uses WebView2. The default daemon URL is `http://127.0.0.1:7490`; macOS runtime settings are stored in `~/Library/Application Support/dev.ompconsole.app/config.json`. HTTP is accepted only for loopback hosts; other hosts require HTTPS. The shell opens off-origin links in the default browser.

## Windows desktop app

The Windows build uses `tauri.windows.conf.json` (NSIS and MSI installers, `icons/icon.ico`). On Windows the daemon runs inside WSL 2 and the app reaches it at `http://127.0.0.1:7490` through WSL's localhost forwarding. The app cannot read the pairing-code file inside WSL by default; run `omp-console pair` in Ubuntu and type the code. Project moves require macOS. `generate-icon.sh` regenerates `icon.ico` together with the macOS icons.

## Build

Requirements: macOS, Xcode Command Line Tools, Rust stable (the checked-in toolchain file selects stable; Tauri 2.12.5 requires Rust 1.90 or newer), and Bun.

```sh
apps/mac/scripts/build-app.sh
```

The script builds `packages/web/dist`, regenerates `icons/icon.icns` and `icons/icon.png` from `packages/web/public/icon-512.png`, creates `apps/mac/dist/omp console.app`, and signs it ad hoc (`signingIdentity: "-"`). It does not install by default. Set `OMP_CONSOLE_INSTALL=1` to install the distinct app at `/Applications/omp console.app`. No notarization or Apple account is used. Generated app bundles are ignored by Git; both generated icons are committed.

First launch: if Gatekeeper blocks the locally built app, Control-click `omp console.app`, choose **Open**, then confirm **Open** once. The default build leaves it in `apps/mac/dist/`.

## Development

Start a daemon separately, then run the shell against its URL:

```sh
cd packages/web
bun run build
bun dev/mock-daemon.ts --dist dist --port 7490

# In another terminal:
apps/mac/scripts/run-dev.sh http://127.0.0.1:7490
```

The retry page is bundled locally and appears when `/api/health` is unreachable. Retry rechecks the daemon. Use the **File → Daemon URL…** item to save a new URL; the app restarts so its remote capability is re-scoped to the saved origin. **File → Reload** checks the daemon again. **Cmd+W** hides the main window without quitting; **Cmd+Shift+Space** toggles it. Window geometry persists in the app config.

## Automation

The file-based automation hook is disabled by default. `OMP_CONSOLE_AUTOMATION_DIR` enables it only when the path already exists, is owned by the current user, and has mode `0700`. The app creates private `cmd/` and `out/` directories, polls JSON commands, and opens no socket. In automation mode only, the configured daemon origin receives the additional eval-result IPC permission; each eval has a 15-second native timeout. The app logs one line when the hook is enabled.

`apps/mac/automation/drive.py` controls the real app:

```sh
python3 apps/mac/automation/drive.py launch --daemon http://127.0.0.1:7592/
python3 apps/mac/automation/drive.py resize 1280 800
python3 apps/mac/automation/drive.py eval 'document.title'
python3 apps/mac/automation/drive.py snap /tmp/omp-console-nightly/macapp.png
python3 apps/mac/automation/drive.py crash
python3 apps/mac/automation/drive.py relaunch
python3 apps/mac/automation/drive.py restore-production
```

`crash` signals only the app PID recorded by the driver. `restore-production` quits and relaunches `omp console.app` without either automation environment variable, so it uses the daemon URL already saved in the app config. Automation-mode resize and move events do not overwrite saved window geometry, and the production minimum window size is unchanged; the automation window can reach the 520-point matrix case. Snapshots use `WKWebView.takeSnapshotWithConfiguration` after `orderFrontRegardless` and `displayIfNeeded` without activating the app; the command reports method, pixel dimensions, and blank status, with `screencapture -l` as fallback when WebKit fails or returns blank.

Run `python3 apps/mac/automation/window-matrix.py --daemon http://127.0.0.1:7592/` against an isolated sandbox daemon. Before staging exactly two session panes for the crash/relaunch scenario, it clears stored `omp-console-layout:` entries. It writes `moments.json` and `result.json` plus real-window PNGs under `/tmp/omp-console-nightly/runs/<timestamp>/macapp/`, fails moments on blank snapshots, then restores the app.


## Deep links

`omp-console://session/<id>` shows and focuses the main window, then forwards `#session=<id>` to the web view for session selection. `omp-console://new?cwd=<URL-encoded absolute path>` forwards `#new=<URL-encoded path>` to the web view.

## Remote capability boundary

At startup, the app adds a runtime Tauri capability whose `remote.urls` contains only the configured daemon origin. Normal mode grants `allow-confirm-move` and `allow-native-notify`; automation mode additionally grants `allow-automation-eval-result` for its callback channel. Bundled retry/settings pages receive only the commands needed for their tasks. Saving a URL persists it and restarts the app, which replaces the runtime capability with the new exact origin; no wildcard or stale origin is retained.

## Move confirmation threat model

The runtime capability grants the configured daemon origin only `allow-confirm-move`; the Rust command independently requires the main window and the exact configured origin. It displays the daemon-provided destination, file counts, byte count, and exclusions in a native warning dialog. **Cancel** is the first/default button; the only signing path is the explicit **Move** result. Closing the dialog or choosing Cancel returns no token and does not create a Keychain item.

After confirmation, the app creates or reads a random 32-byte key stored as unpadded base64url text in Keychain (`service=omp-console-move-signing-key`, account `omp-console-move-confirmation`); this encoding is the daemon CLI contract. It returns only an unpadded base64url HMAC-SHA256 for `${moveId}.${nonce}`. The raw key is never sent to JavaScript. The daemon reads the same item through `security find-generic-password -s omp-console-move-signing-key -a omp-console-move-confirmation -w`; its token verification and five-minute nonce/idempotency checks remain authoritative.

Trust boundary: the configured local daemon and the signed omp console app run under the user's account. A compromised daemon can read the Keychain item itself and can supply a misleading dialog summary; this flow is not a defense against that compromise. The native dialog prevents silent confirmation by an ordinary remote page, but the user must review the shown summary.

Filesystem limitation: the daemon serializes cooperating moves with an `O_EXCL` sibling lock and rechecks the destination before renaming the staging directory. `fs.rename` does not provide macOS `RENAME_EXCL`; an unrelated process can create an empty destination between the final check and rename. That residual race is not prevented by the omp-console move lock.

## Verification

Run the native unit tests from the repository root with `cd apps/mac && cargo test`. The app build command above leaves the app in `apps/mac/dist/` unless `OMP_CONSOLE_INSTALL=1` is explicitly set.

## Repository installer and remote access

From the repository root, `./scripts/install.sh --launchd` builds the web UI and installs the daemon LaunchAgent. `./scripts/install.sh --uninstall` removes only that LaunchAgent. `./scripts/install.sh --app` explicitly builds and copies `omp console.app` into `/Applications`; a normal install does not.

For phone access, configure the LaunchAgent with `--owner '<tailnet-login>' --allow-host '<machine>.<tailnet>.ts.net'`, then run `./ops/tailscale-serve.sh`. Authorize the phone in the same Tailscale account, open the HTTPS URL the command prints, and pair the phone with a code from Settings → Devices on an already paired device (or `omp-console pair` on the host). Tailscale authorization and `--owner` only narrow access; they never replace the device pairing. See the repository [security model](../../SECURITY.md).
