# Install with a coding agent

Let a coding agent on your computer (omp, Claude Code, Codex, or similar) install omp-console for you. It follows the [step-by-step guide](INSTALL.md), checks each step, and stops to ask before anything that needs your password or permission.

1. Open a terminal on the computer that should run omp-console: Terminal on a Mac, any terminal on Linux, or PowerShell or the Ubuntu app on Windows.
2. Start your agent there, for example `omp`, `claude`, or `codex`.
3. Copy everything inside the box below and paste it as your message.
4. Answer its questions. At the end, it tells you how to open omp-console.

Two steps stay with you: signing in to your model provider (it opens a browser login), and clicking **Pair this browser**. The agent never asks for passwords or API keys in the chat; don't paste them there.

````text
Install omp-console (https://github.com/LQ458/omp-console) on this computer for me. The full guide is docs/INSTALL.md in that repository; follow it, and follow these rules.

Rules
- Work only on this computer, as my user. Ask me before installing system packages and before installing Bun or omp. For any command that needs sudo or administrator rights, do not run it yourself: give me the exact command, tell me where to run it, and wait until I say it is done.
- Never ask me for, read, print, or store passwords, API keys, or tokens. Do not open or print ~/.omp, ~/.claude, ~/.codex, or ~/.omp-console/env.
- Do not change my existing omp settings or sessions.
- Keep the daemon on 127.0.0.1. Do not set up Tailscale, Funnel, port forwarding, or a reverse proxy unless I ask.
- Run one step at a time and check that it worked before the next. If a step fails twice, stop, show me the exact error output, and say what you think is wrong. Do not work around the installer or edit its files.
- Explain what you are doing in one short sentence per step, in plain words.

Steps
1. Detect the system.
   - Windows itself (PowerShell or cmd; `uname` is missing or `$env:OS` is `Windows_NT`): omp-console runs inside WSL 2 there. Run `wsl -l -v`. If WSL or an Ubuntu distribution is missing, tell me to run `wsl --install` in an administrator PowerShell, restart Windows, open Ubuntu once to create my Linux user, and then ask you to continue; stop until I do. Once Ubuntu exists, run every later command inside it as `wsl -d Ubuntu -- bash -lc '<command>'` (so `~` means my Linux home), and treat the system as Linux below. If a command fails only when run through `wsl -- ...` (for example `systemctl --user` cannot connect to the bus), give me that command to run in the Ubuntu window instead.
   - Otherwise run `uname -sm`. Supported: macOS, or Linux (including WSL, where `uname -r` contains `microsoft`).
   - On Linux, check whether `systemctl --user show-environment` works (systemd user services). On WSL, if it does not, tell me to turn systemd on as in docs/INSTALL.md, section "Windows: set up WSL first", step 3, and stop until I have done it.
2. Check `git --version`. If missing: on macOS, tell me to accept Apple's command line tools prompt (run `xcode-select --install`); on Linux, give me the package-manager command that installs git, curl, and unzip (for Ubuntu: `sudo apt-get update && sudo apt-get install -y git curl unzip`) to run myself. Also check `unzip -v`, which the Bun installer needs.
3. Check `bun --version` (need 1.4 or newer; also look in ~/.bun/bin). If missing, ask me, then install with `curl -fsSL https://bun.sh/install | bash`. If older than 1.4, ask me, then run `bun upgrade`. Make sure ~/.bun/bin is on PATH for the rest of the session.
4. Check `omp --version` (also look in ~/.local/bin and ~/.bun/bin). If missing, ask me, then install with `curl -fsSL https://omp.sh/install | sh`. Do not sign me in yourself.
5. Get the source: if ~/omp-console exists and is a clone of github.com/LQ458/omp-console, run `git -C ~/omp-console pull --ff-only`; if it exists but is something else, stop and ask me; otherwise `git clone https://github.com/LQ458/omp-console.git ~/omp-console`.
6. Install from ~/omp-console:
   - macOS: `./scripts/install.sh --launchd`
   - Linux with systemd user services: run `loginctl enable-linger "$USER"` (if it fails, give me `sudo loginctl enable-linger "$USER"` to run myself), then `./scripts/install.sh --systemd`
   - Linux without systemd user services: `./scripts/install.sh --plain`, then tell me the exact start command it printed; I will run it in a separate terminal and keep that window open.
   You can run `./scripts/install.sh --dry-run` with the same option first to show me what it will do.
7. Verify: `~/.local/bin/omp-console status` must say the daemon is responding (with --plain, after I start it). If not, show me the output of `~/.local/bin/omp-console logs` with anything that looks like a secret removed, then stop.
8. Finish with a short summary for me:
   - versions of Bun, omp, and the omp-console commit (`git -C ~/omp-console log -1 --format=%h`);
   - how to open it: run `~/.local/bin/omp-console open` in my own terminal (on Windows: in the Ubuntu window), open the link (on Windows: copy it into Edge or Chrome), and click "Pair this browser"; afterwards it lives at http://127.0.0.1:7490;
   - on Windows: keep one Ubuntu window open, even minimized, while I use omp-console, because WSL stops the service shortly after the last Ubuntu window closes;
   - if `omp` has no model sign-in yet: run `omp`, type `/login`, pick my provider, approve in the browser, quit omp, then reload omp-console;
   - how to update (`cd ~/omp-console && git pull && ./scripts/install.sh` with the same option) and uninstall (`./scripts/install.sh --uninstall`);
   - optional desktop app and phone access: point me to sections 7 and 8 of docs/INSTALL.md, do not set them up.
````

## What the agent will and won't do

| It will | It won't |
|---|---|
| Check git, Bun, and omp, and install the missing ones after asking | Use `sudo` without asking |
| Download omp-console into `~/omp-console` and run its installer | Read or print your keys, tokens, or omp settings |
| Start the background service and check that it responds | Sign in to your model provider for you |
| Tell you exactly what to click and how to update or uninstall | Open omp-console to your network or the internet |

If something goes wrong, the agent stops and shows the error. The [troubleshooting table](INSTALL.md#troubleshooting) covers the common cases.
