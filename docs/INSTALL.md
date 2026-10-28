# Install omp-console: step-by-step guide

This guide takes about 10–15 minutes on a Mac or a Linux computer, and about 30 minutes on Windows (which first needs WSL, Microsoft's built-in Linux). You only type commands into a terminal; nothing needs to be edited by hand.

Prefer not to do it yourself? Paste the prompt in [Install with a coding agent](INSTALL-WITH-AN-AGENT.md) into omp, Claude Code, or Codex, and it does these steps for you, asking before anything that needs your permission.

## How it fits together

omp-console has three parts:

- **omp**, the coding agent. omp-console drives the sessions; it does not replace omp.
- **The daemon**, a small background service on your computer. It runs the sessions and serves the web app at `http://127.0.0.1:7490`. Only your own computer can reach it unless you set up Tailscale (see [Use it from your phone](#7-optional-use-it-from-your-phone)).
- **A window to look at it**: any browser, the optional desktop app, or your phone.

You install the daemon from the source code (step 4). The desktop app on the [Releases page](https://github.com/LQ458/omp-console/releases) is only a window; it does not replace step 4.

## Before you start

- macOS on Apple Silicon (Intel Macs should work but are untested), or Linux (Ubuntu, Debian, Fedora, Arch and similar; x64 or arm64), or Windows 10 version 2004 or later / Windows 11 through WSL 2 (see [Windows: set up WSL first](#windows-set-up-wsl-first)).
- A terminal. On macOS: open **Terminal** from Applications → Utilities.
- About 1 GB of free disk space.
- An account with a model provider you will use in omp (for example a Claude or ChatGPT subscription, or an API key).

In the commands below, type or paste one line at a time and press Enter. Lines starting with `#` are comments; you don't need to type them.

## Windows: set up WSL first

omp-console's background service runs on Linux. On Windows it runs inside WSL 2, a Linux system built into Windows; you open omp-console in your normal Windows browser or the Windows desktop app. A native Windows version without WSL is planned.

1. Right-click **Start**, choose **Terminal (Admin)** or **Windows PowerShell (Admin)**, and run:

   ```powershell
   wsl --install
   ```

   This installs WSL 2 with Ubuntu. Restart Windows when it asks.
2. After the restart, open **Ubuntu** from the Start menu. The first time, it asks you to create a Linux user name and password. This password is only for Linux (`sudo`); write it down.
3. In the Ubuntu window, check that background services work:

   ```sh
   systemctl --user status >/dev/null && echo ready
   ```

   If it does not print `ready`, turn systemd on (this adds two lines to `/etc/wsl.conf` and keeps the rest), then in PowerShell run `wsl --shutdown`, and open Ubuntu again:

   ```sh
   printf '\n[boot]\nsystemd=true\n' | sudo tee -a /etc/wsl.conf
   ```
4. Do every step below **inside the Ubuntu window**, using the **Linux** commands. Keep your projects inside Linux (for example `~/projects`); your Windows files are under `/mnt/c`, but they are much slower to work on from Linux.

**Keep one Ubuntu window open (it can be minimized) while you use omp-console.** Windows stops WSL, and with it the omp-console service, shortly after the last Ubuntu window closes. Opening Ubuntu again starts the service automatically.

## 1. Install the basic tools

**macOS.** Git comes with Apple's command line tools. Check it:

```sh
git --version
```

If macOS offers to install the command line developer tools, click **Install** and wait for it to finish, then run the command again.

**Linux and Windows/WSL (Debian/Ubuntu).**

```sh
sudo apt-get update
sudo apt-get install -y git curl unzip
```

On Fedora use `sudo dnf install -y git curl unzip`; on Arch use `sudo pacman -S --needed git curl unzip`.

## 2. Install Bun

Bun is the JavaScript runtime the daemon runs on. omp-console needs Bun 1.4 or newer.

```sh
curl -fsSL https://bun.sh/install | bash
```

**Close the terminal window and open a new one**, so the new `bun` command is found. Then check:

```sh
bun --version
```

You should see `1.4.x` or higher. If you already had Bun and it shows an older version, run `bun upgrade`.

## 3. Install omp and sign in

If `omp --version` already prints a version, skip to "Sign in".

```sh
curl -fsSL https://omp.sh/install | sh
```

Open a new terminal window again, then check:

```sh
omp --version
```

**Sign in.** Start omp, type `/login`, press Enter, and pick your provider (for a Claude subscription, choose Anthropic). Your browser opens; approve the login there. Then quit omp.

```sh
omp
```

You can skip signing in for now; omp-console's first-run checklist will remind you. You cannot start working sessions until you sign in.

## 4. Download and install omp-console

Download the source into a folder called `omp-console` in your home folder:

```sh
git clone https://github.com/LQ458/omp-console.git ~/omp-console
cd ~/omp-console
```

Now run the installer. Pick the line for your computer.

**macOS:**

```sh
./scripts/install.sh --launchd
```

**Linux with systemd** (most distributions, and Ubuntu on Windows/WSL):

```sh
loginctl enable-linger "$USER"
./scripts/install.sh --systemd
```

`enable-linger` keeps the service running after you log out. If it asks for a password or fails, run `sudo loginctl enable-linger "$USER"` instead.

**Any computer, without a background service** (for example inside a container):

```sh
./scripts/install.sh --plain
```

The installer checks Bun and omp, downloads dependencies, builds the web app, installs the `omp-console` command into `~/.local/bin`, and starts the daemon (except with `--plain`). It takes one to three minutes. It never asks for or reads your API keys.

With `--plain`, the installer prints a start command instead of starting the daemon. Run that command in a terminal and leave the window open; the daemon stops when you close it.

## 5. Pair your browser

When the installer finishes in a desktop terminal, it opens your browser on a pairing page. Click **Pair this browser**. That's it: you're in.

If no browser opened (for example over SSH or with `--plain`), run:

```sh
~/.local/bin/omp-console open
```

It prints a one-click link; open it in a browser on the same computer and click **Pair this browser**. On Windows, copy the link from the Ubuntu window (select it, then right-click or press Ctrl+C) into Edge or Chrome on Windows. Pairing codes expire after 10 minutes; run the command again for a new one.

To open omp-console later, go to `http://127.0.0.1:7490` in the browser you paired. Bookmark it, or install it as an app from the browser's menu (Chrome/Edge: **Install app**; Safari: **File → Add to Dock**).

## 6. First run

The home screen shows a short checklist:

- **omp installed**: the version the daemon found.
- **Model sign-in**: whether omp has a model it can use. If not, go back to step 3 and sign in, then reload the page.
- **Previous sessions**: your terminal omp sessions. Opening one makes a copy; your original session file is not changed.
- **Claude Code history**: if you used Claude Code, you can import those conversations. See [Migrate from Claude Code or Codex](migrating-from-claude-code.md).

Click **New session**, choose a project folder, and type your first request.

## 7. Optional: use it from your phone

Phone access goes through [Tailscale](https://tailscale.com), a private network between your own devices. Nothing is opened to the public internet.

1. Install Tailscale on the computer and on the phone, and sign in to the same account on both.
2. Rerun the installer with your computer's Tailscale name (shown in the Tailscale app, for example `my-mac.tail1234.ts.net`):

   ```sh
   cd ~/omp-console
   ./scripts/install.sh --launchd --allow-host 'my-mac.tail1234.ts.net'   # macOS
   ./scripts/install.sh --systemd --allow-host 'my-mac.tail1234.ts.net'   # Linux
   ```

3. Run `./ops/tailscale-serve.sh`. It prints an `https://…ts.net` address.
4. In the paired browser on the computer, open **Settings → Devices → Pair another device**.
5. Open the printed address on the phone and click **Pair this browser** with the code from step 4.

Never use Tailscale Funnel or a public reverse proxy: the daemon can run commands on your computer. Phone access from a Windows/WSL computer is untested.

## 8. Optional: the desktop app

The desktop app is a window onto the daemon at `http://127.0.0.1:7490`; install the daemon first (step 4).

Download it from the [Releases page](https://github.com/LQ458/omp-console/releases) (open **Assets** under the newest release):

| Computer | File |
|---|---|
| Mac with Apple Silicon | `omp-console_<version>_macos-arm64.zip` |
| Windows 10/11 (x64) | `omp-console_<version>_x64-setup.exe` (or the `.msi`) |
| Debian/Ubuntu, x64 or arm64 | the `.deb` for your architecture (`amd64` or `arm64`) |
| Other Linux | the `.AppImage` for your architecture (`amd64` or `aarch64`) |

**macOS.** Unzip it and drag **omp console** into Applications. The app is not notarized by Apple, so the first launch is blocked: open **System Settings → Privacy & Security**, scroll down, and click **Open Anyway** next to the omp console message. If macOS says the app "is damaged", run this once and open it again:

```sh
xattr -dr com.apple.quarantine "/Applications/omp console.app"
```

Intel Macs: build the app on the Mac instead with `./scripts/install.sh --launchd --app` (needs Rust and the Xcode command line tools; see [apps/mac/README.md](../apps/mac/README.md)).

**Windows.** Run `omp-console_<version>_x64-setup.exe`. The installer is not code-signed, so Windows SmartScreen may show "Windows protected your PC": click **More info**, then **Run anyway**. It installs Microsoft Edge WebView2 if your PC does not have it yet (internet required). The app connects to `http://127.0.0.1:7490`, which reaches the service running in WSL while an Ubuntu window is open. To pair it, run `~/.local/bin/omp-console pair` in Ubuntu and type the `XXXX-XXXX` code into the app.

**Debian/Ubuntu.**

```sh
sudo apt install ./omp-console_*_amd64.deb    # or ..._arm64.deb
```

**AppImage.**

```sh
chmod +x omp-console_*.AppImage
./omp-console_*.AppImage
```

Each release also has `SHA256SUMS.txt`. To check a download: `shasum -a 256 <file>` (macOS) or `sha256sum <file>` (Linux), and compare the result with the line in that file.

## Everyday commands

| Command | What it does |
|---|---|
| `~/.local/bin/omp-console open` | New pairing link and open the browser |
| `~/.local/bin/omp-console pair` | Print a new pairing code and link |
| `~/.local/bin/omp-console status` | Check whether the daemon is running |
| `~/.local/bin/omp-console logs` | Show recent daemon logs |

Add `~/.local/bin` to your `PATH` to type just `omp-console`.

## Update

```sh
cd ~/omp-console
git pull
./scripts/install.sh --launchd     # macOS; use the same option you installed with
./scripts/install.sh --systemd     # Linux and Windows/WSL (in the Ubuntu window)
```

The installer rebuilds and restarts the daemon. Reload the browser tab afterwards. If you installed with `--allow-host`, pass it again. With `--plain`, stop the old daemon (Ctrl+C in its window) and start it again with the printed command.

## Uninstall

```sh
cd ~/omp-console
./scripts/install.sh --uninstall
```

This removes the background service only. To remove everything omp-console created, also delete `~/omp-console`, `~/.omp-console`, and `~/.local/bin/omp-console`. Your omp installation, settings and sessions (`~/.omp`) are never touched.

## Troubleshooting

| Problem | What to do |
|---|---|
| `bun: command not found` or `omp: command not found` right after installing | Open a new terminal window. If it persists, run `source ~/.bashrc` (Linux) or `source ~/.zshrc` (macOS). |
| Installer says `Bun >= 1.4 is required` | Run `bun upgrade`, open a new terminal, and rerun the installer. |
| The page is blank after installing | Your Bun was too old when the web app was built. Run `bun upgrade`, then rerun the installer. |
| The pairing link says the code expired | Codes last 10 minutes. Run `~/.local/bin/omp-console open` again. |
| `http://127.0.0.1:7490` does not load | Run `~/.local/bin/omp-console status`. If it is not running, look at `~/.local/bin/omp-console logs`. On Linux also try `systemctl --user restart omp-console`. |
| Port 7490 is already in use | Another program uses that port. Quit it, or stop an older omp-console you started by hand, then rerun the installer. |
| The checklist shows no model | Sign in to omp (step 3). If you use an API key and the Linux service doesn't see it, add a `KEY=value` line to `~/.omp-console/env` (keep it private: `chmod 600 ~/.omp-console/env`), then `systemctl --user restart omp-console`. |
| Linux: the daemon stops after you log out | Run `loginctl enable-linger "$USER"` (or with `sudo`). |
| The desktop app shows a "can't reach the daemon" page | Start the daemon (step 4), then click **Retry**. |
| Windows: `http://127.0.0.1:7490` stopped working | WSL stopped because no Ubuntu window was open. Open Ubuntu, wait a few seconds, and reload. `wsl -l -v` in PowerShell shows whether Ubuntu is `Running`. |
| Windows: `systemctl --user` says the system was not booted with systemd | Turn systemd on as described in [Windows: set up WSL first](#windows-set-up-wsl-first), step 3. |

Still stuck? Open an issue at <https://github.com/LQ458/omp-console/issues> with the output of `~/.local/bin/omp-console status` and the last lines of `~/.local/bin/omp-console logs`. Remove anything private (tokens, file paths you don't want to share) before posting.
