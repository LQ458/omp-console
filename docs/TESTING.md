# Testing omp-console

This guide is for a first hands-on test on macOS or Linux. Use a scratch Git repository, not a project with important files: omp-console runs agents with the privileges of the account running its daemon. Before optional remote access, read **Security** and **Pair a phone over Tailscale Serve** in the [README](../README.md). The [Requirements](../README.md#requirements), [Install on macOS](../README.md#install-on-macos), [Install on Linux](../README.md#install-on-linux), and [Optional features](../README.md#optional-features) sections give the product overview.

## Before you start

Have these available:

- `git`, `curl`, and `unzip`.
- Bun 1.4 or newer (`bun upgrade` updates an older one). The installer checks the version and uses that Bun for the build and the service.
- `omp` installed and signed in to a model provider. In a terminal, run `omp`, then `/login` and complete the provider's login flow.
- Optional: Tailscale installed and signed in on the computer and phone, for the phone/PWA check below.

Allow about 15 minutes for the interactive setup, plus up to 15 minutes to let the Overnight task reach its deadline. Building dependencies may take longer on a first install. You will make a real model request; keep it small and use only the scratch repository.

## 15-minute first-run checklist

For every step, record the OS/version, the step number, and the exact error. Do not include secrets in evidence; see [Privacy and issue reporting](#privacy-and-issue-reporting).

1. **Check the prerequisites (about 1 minute).** Run `bun --version` and `omp --version`; start `omp` and sign in with `/login` if needed.
   - **Expected:** Bun reports `1.4.0` or newer; `omp --version` succeeds and the provider login completes.
   - **If it fails, capture:** the two version outputs and the exact error text. Never attach auth files or credentials.

2. **Clone the invited repository (about 2 minutes).** Use the clone URL from the private GitHub invitation and enter the checkout.
   - **Expected:** the checkout contains `scripts/install.sh`, `packages/`, and `docs/`.
   - **If it fails, capture:** the Git command and its output, with private repository URLs or account names redacted.

3. **Preview the install (about 1 minute).** From the repository root, run the matching dry run:

   ```sh
   # macOS
   ./scripts/install.sh --dry-run --launchd

   # Linux
   ./scripts/install.sh --dry-run --systemd
   ```

   - **Expected:** the installer prints what it would build/install and the local URL, without installing or starting the service.
   - **If it fails, capture:** the complete terminal output and `bun --version`.

4. **Install and start the daemon (about 3 minutes).** Run one command from the repository root:

   ```sh
   # macOS
   ./scripts/install.sh --launchd

   # Linux
   ./scripts/install.sh --systemd
   ```

   - **Expected:** the installer builds the web UI and starts the per-user service on port `7490`; it prints the local pairing instructions.
   - **If it fails, capture:** the installer output and the daemon log. Linux: `journalctl --user -u omp-console -n 200`. macOS: `~/Library/Logs/omp-console/daemon.log` (the LaunchAgent sends both stdout and stderr there).

5. **Open and pair the browser (about 1 minute).** Open `http://127.0.0.1:7490`. Enter the one-time code printed by the daemon or read it from `<state-dir>/pairing-code` (default state directory: `~/.omp-console`). If you need a fresh code while the daemon is running, from the repository root run `bun packages/daemon/src/main.ts pair --state-dir ~/.omp-console`; use the actual state directory if the installer printed a different one.
   - **Expected:** the Pair screen accepts the code and opens the session interface.
   - **If it fails, capture:** a screenshot with the code removed, the browser console, and the platform daemon log from step 4. Pairing codes expire after 10 minutes. Do not paste one into an issue.

6. **Create a session and exercise streaming (about 3 minutes).** Initialize an empty scratch Git repository, for example:

   ```sh
   SCRATCH="$(mktemp -d)" && git -C "$SCRATCH" init
   ```

   Create a session using that directory as its working directory. Ask the agent to create one small text file, watch the tool/status stream, and use **Stop** while it is working. If the first prompt finishes before you can stop it, send another small prompt and stop that run.
   - **Expected:** the session is created in the scratch repository, tool/status events arrive, and Stop ends the active run without affecting another session.
   - **If it fails, capture:** the prompt with personal details removed, a screenshot, browser console, and the platform daemon log. Do not attach project contents or secrets.

7. **Toggle one optional feature and restart (about 2 minutes).** In **Settings → Advanced → Optional features**, choose a feature whose listed prerequisites you have (Ask your notes with a Notes folder and the `repo` source is the easiest), turn it on, save, then press **Restart** in the banner (installed services restart themselves; a daemon started by hand must be restarted by hand). Check Settings → Advanced → Optional features and the relevant UI again. See **Optional features** in the [README](../README.md#optional-features) for feature prerequisites.
   - **Expected:** after restart the setting remains enabled and the feature's UI or status reflects that it is available; missing prerequisites are shown rather than silently hidden.
   - **If it fails, capture:** the feature name, its displayed prerequisites/status, a screenshot, browser console, and the platform daemon log.

8. **Start a small Overnight run (about 2 minutes of setup).** Overnight run is off by default. First enable it under **Settings → Advanced → Optional features**, save, and restart the daemon. In the scratch repository, start an Overnight run that makes one harmless change and set its deadline to 15 minutes from now. Keep the machine and daemon running; check the task again after the deadline before uninstalling.
   - **Expected:** the run starts and displays its deadline/progress; after it finishes or stops, its final state is visible in the session.
   - **If it fails, capture:** the task's Overnight run status/timeline, deadline, screenshot, and platform daemon log. Remove prompt text or file contents that should remain private.

9. **Uninstall after the run is finished or stopped (about 1 minute).** From the repository root, run `./scripts/install.sh --uninstall`.
   - **Expected:** the omp-console service is unloaded and the installer reports its removal; your `omp` installation and `~/.omp` data remain untouched.
   - **If it fails, capture:** the uninstall output and, if the service remains active, the platform's service status and daemon log. Do not manually delete unrelated service or state files.

## Optional longer checks

- **Phone/PWA over Tailscale:** keep the daemon installed, then run `./ops/tailscale-serve.sh` from the repository root on a host with the Tailscale CLI signed in. Open the printed HTTPS URL on the phone and pair it with a fresh one-time code. Expected: the same session UI loads on the phone. Capture the phone screenshot and browser console if it fails; redact the URL, pairing code, and account details. Use Tailscale Serve only; never use Funnel.
- **Overnight run completion:** wait for the 15-minute deadline from step 8, then confirm the final status/report is visible. Check that a harmless change landed only in the scratch repository.
- **Feature prerequisites:** try another optional feature only after meeting its listed requirements. For example, Project search needs a Notes folder and at least one Project folder; Computer use is macOS-only and needs the host's Accessibility and Screen Recording permissions (on Linux it shows as unavailable). Capture the displayed missing-requirements state if setup is incomplete.
- **Session lifecycle:** create a second scratch session, send a short prompt, stop it, and confirm the first session remains available.

## Privacy and issue reporting

Never paste device tokens, pairing codes, cookies, `~/.omp` authentication files, API keys, or unredacted screenshots/logs into an issue. Logs can include pairing codes at daemon startup. Remove those, private repository URLs, personal paths, and any prompt or file content you do not want shared before attaching evidence.

To report a reproducible bug, open a GitHub issue and choose **Bug report**. Include the smallest reproduction, expected and actual behavior, sanitized logs, and a screenshot when useful. For usability feedback or confusing steps, choose **Feedback**. The issue forms request the environment and evidence needed to reproduce the report.
