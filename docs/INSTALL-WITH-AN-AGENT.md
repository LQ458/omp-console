# Install with a coding agent

A coding agent running on your computer can install omp-console by following the [install guide](INSTALL.md). It checks each step and pauses before actions that need your permission.

1. Open Terminal on macOS, a terminal on Linux, or PowerShell on Windows on the computer that will run omp-console.
2. Start a coding agent there, such as omp, Claude Code, or Codex.
3. Copy the full prompt below and send it to the agent.
4. Answer its questions. It will tell you how to open omp-console.

You must sign in to your model provider in its browser and click **Pair this browser** yourself. Do not paste passwords or API keys into the agent chat.

````text
Install omp-console (https://github.com/LQ458/omp-console) on this computer for me. Follow docs/INSTALL.md in that repository. Follow these rules and steps.

Rules
- Work only on this computer and as my user. Ask me before installing system packages, Bun, omp, or Git for Windows. For any command requiring sudo or administrator rights, show me the exact command, tell me where to run it, and wait for me to say it is done.
- Never ask me for, read, print, or store passwords, API keys, or tokens. Do not open or print ~/.omp, ~/.claude, ~/.codex, or ~/.omp-console/env.
- Do not change my existing omp settings or sessions.
- Keep the service on 127.0.0.1. Do not set up Tailscale, Funnel, port forwarding, or a reverse proxy unless I ask.
- Do one step at a time and check that it worked before continuing. If a step fails twice, stop, show me the exact error, and explain the likely cause. Do not work around the installer or edit its files.
- Explain each step in one short sentence using plain words.

Steps
1. Detect the system.
   - Windows 10/11 x64 (`$env:OS` is `Windows_NT`): use PowerShell, not WSL. Check `git --version`, `bun --version`, and `omp --version`.
   - Otherwise, run `uname -sm`. Continue only on macOS or Linux. On Linux, check whether `systemctl --user show-environment` works.
2. Check Git with `git --version`. If it is missing, ask before installing it. On macOS, tell me to accept Apple's command line tools prompt (`xcode-select --install`). On Linux, give me the package-manager command for Git, curl, and unzip. On Windows, ask before installing [Git for Windows](https://git-scm.com/download/win) or using `winget install --id Git.Git -e`. Reopen PowerShell and check again.
3. Check `bun --version`; the required version is 1.4 or newer. If Bun is missing, ask before installing it. On Windows use `powershell -c "irm bun.sh/install.ps1 | iex"`; on macOS/Linux use `curl -fsSL https://bun.sh/install | bash`. Reopen the terminal and check again. If Bun is too old, ask before running `bun upgrade`.
4. Check `omp --version`. If omp is missing, ask before installing it. On Windows use `irm https://omp.sh/install.ps1 | iex`; on macOS/Linux use `curl -fsSL https://omp.sh/install | sh`. Reopen the terminal and check again. Do not sign me in.
5. Get the source. Use `$HOME\omp-console` on Windows and `~/omp-console` on macOS/Linux. If that folder is a clone of github.com/LQ458/omp-console, run `git pull --ff-only` there. If the folder exists but is not that repository, stop and ask me. Otherwise, clone `https://github.com/LQ458/omp-console.git` there.
6. Install from the checkout.
   - Windows PowerShell: run `.\scripts\install.ps1 -DryRun`, review the output with me, then run `.\scripts\install.ps1`. If PowerShell blocks the unsigned script because of its execution policy, show me `powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1` and wait for me to approve and run it.
   - macOS: run `./scripts/install.sh --launchd`.
   - Linux with systemd user services: run `loginctl enable-linger "$USER"`. If that fails, show me `sudo loginctl enable-linger "$USER"` and wait for me to run it. Then run `./scripts/install.sh --systemd`.
   - Linux without systemd user services: run `./scripts/install.sh --plain`. Show me the exact start command it prints. I will run it in another terminal and keep that window open.
7. Verify the service. Run `omp-console status` on Windows or `~/.local/bin/omp-console status` on macOS/Linux. It must say the service is responding. If it does not, show me the recent output from `omp-console logs` or `~/.local/bin/omp-console logs`, remove anything that looks like a secret, and stop.
8. Finish with a short summary:
   - Bun and omp versions, and the omp-console commit (`git -C "$HOME\omp-console" log -1 --format=%h` on Windows; use `~/omp-console` on macOS/Linux).
   - How to open omp-console: run `omp-console open` in PowerShell or `~/.local/bin/omp-console open` on macOS/Linux; open the link and click **Pair this browser**. The page is at `http://127.0.0.1:7490`.
   - If omp has no model sign-in, I must run omp, type `/login`, choose my provider, approve the browser login, quit omp, then reload omp-console. Do not do this for me.
   - How to update and uninstall. On Windows: run `Set-Location "$HOME\omp-console"`, then `git pull`, then `.\scripts\install.ps1`; reuse `-AllowHost` and `-Owner` if I set them. Then run `.\scripts\install.ps1 -Uninstall`. On macOS/Linux, use `cd ~/omp-console` and rerun `./scripts/install.sh` with the same service option, or use `./scripts/install.sh --uninstall`.
   - Optional desktop app and phone access: point me to the relevant sections of docs/INSTALL.md. Do not set them up.
````

## What the agent will and will not do

| It will | It will not |
|---|---|
| Check Git, Bun, and omp, and install missing tools after asking | Use `sudo` without asking |
| Download omp-console into `~/omp-console` and run its installer | Read or print keys, tokens, or omp settings |
| Start the background service and check that it responds | Sign in to your model provider for you |
| Tell you what to click and how to update or uninstall | Open omp-console to your network or the internet |

If something goes wrong, the agent should stop and show the error. See the [troubleshooting table](INSTALL.md#troubleshooting). After connecting your browser, continue with [Getting started](GETTING-STARTED.md).
