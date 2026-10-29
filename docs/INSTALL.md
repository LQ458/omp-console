# Install omp-console

## What you will have at the end

- A local omp-console page at `http://127.0.0.1:7490`.
- A background service (called a daemon in technical messages) that runs omp sessions on your computer.
- This browser connected to your computer; by default, the page is reachable only from that computer.
- Your previous terminal omp sessions available as copies, plus an importer for Claude Code conversations.
- The option to use the desktop app or connect a phone through your private Tailscale network.

This guide covers macOS, Linux, and native Windows 10/11 x64. Most installs take 10–15 minutes. If you would rather have an agent do the work, use [Install with a coding agent](INSTALL-WITH-AN-AGENT.md).

## Fast path

Use the section for your computer. Skip a tool's install command if it is already installed. Run each command in a terminal on the computer that will run omp-console.

### macOS

1. Check Git. You should see a version number. If macOS offers to install Apple's command line developer tools, click **Install**, wait, and run the check again.

   **Terminal**
   ```sh
   git --version
   ```

2. Install Bun if needed. Then close and reopen Terminal, and check that Bun is version 1.4 or newer. If it is older, use the upgrade instructions in [Step by step](#step-by-step).

   **Terminal**
   ```sh
   curl -fsSL https://bun.sh/install | bash
   ```

   **Terminal**
   ```sh
   bun --version
   ```

3. Install omp if needed. Open a new Terminal window, then check for a version number.

   **Terminal**
   ```sh
   curl -fsSL https://omp.sh/install | sh
   ```

   **Terminal**
   ```sh
   omp --version
   ```

4. Start omp and sign in. Run the command below, then type the next command at the omp prompt. Choose your provider (choose Anthropic for a Claude subscription), approve the browser login, then quit omp. After approval, the account is signed in. You can do this later, but omp-console cannot start working sessions until you sign in.

   **Terminal**
   ```sh
   omp
   ```

   **Terminal (omp prompt)**
   ```text
   /login
   ```

5. Download the repository. You should see the `omp-console` folder in your home folder.

   **Terminal**
   ```sh
   git clone https://github.com/LQ458/omp-console.git ~/omp-console
   ```

6. Enter that folder. The prompt should now show `omp-console` as the current directory.

   **Terminal**
   ```sh
   cd ~/omp-console
   ```

7. Install and start the service. The installer builds the web app, installs the command, starts the service, and opens a page for you to connect this browser.

   **Terminal**
   ```sh
   ./scripts/install.sh --launchd
   ```

### Linux

1. On Debian or Ubuntu, update the package index. Fedora and Arch users skip this step. You should see the package manager finish without an error.

   **Terminal**
   ```sh
   sudo apt-get update
   ```

2. Install Git, curl, and unzip. You should see the package manager finish without an error.

   **Terminal (Debian/Ubuntu)**
   ```sh
   sudo apt-get install -y git curl unzip
   ```

   **Terminal (Fedora)**
   ```sh
   sudo dnf install -y git curl unzip
   ```

   **Terminal (Arch)**
   ```sh
   sudo pacman -S --needed git curl unzip
   ```

3. Install Bun if needed. Close and reopen the terminal, then check that Bun is version 1.4 or newer. If it is older, use the upgrade instructions in [Step by step](#step-by-step).

   **Terminal**
   ```sh
   curl -fsSL https://bun.sh/install | bash
   ```

   **Terminal**
   ```sh
   bun --version
   ```

4. Install omp if needed, open a new terminal, and check for a version number.

   **Terminal**
   ```sh
   curl -fsSL https://omp.sh/install | sh
   ```

   **Terminal**
   ```sh
   omp --version
   ```

5. Start omp and sign in. Run the command below, then type the next command at the omp prompt. Choose your provider (choose Anthropic for a Claude subscription), approve the browser login, then quit omp. After approval, the account is signed in. You can do this later, but omp-console cannot start working sessions until you sign in.

   **Terminal**
   ```sh
   omp
   ```

   **Terminal (omp prompt)**
   ```text
   /login
   ```

6. Download the repository. You should see the `omp-console` folder in your home folder.

   **Terminal**
   ```sh
   git clone https://github.com/LQ458/omp-console.git ~/omp-console
   ```

7. Enter that folder. The terminal prompt should now show `omp-console` as the current directory.

   **Terminal**
   ```sh
   cd ~/omp-console
   ```

8. Allow the user service to keep running after you log out. You should see the command finish without an error. If it fails or asks for a password, ask an administrator to run the version with `sudo` shown under [Step by step](#step-by-step).

   **Terminal**
   ```sh
   loginctl enable-linger "$USER"
   ```

9. Install and start the service. The installer builds the web app and opens a page for you to connect this browser.

   **Terminal**
   ```sh
   ./scripts/install.sh --systemd
   ```

### Windows 10/11 (PowerShell)

Use a regular PowerShell window. Native Windows support runs without WSL and does not need administrator rights. The installer creates a Scheduled Task for your user. WSL 2 is an optional alternative; see [Step by step](#step-by-step).

1. Install [Git for Windows](https://git-scm.com/download/win), open a new PowerShell window, and check Git. You should see a version number.

   **PowerShell**
   ```powershell
   git --version
   ```

2. Install Bun if needed. Close and reopen PowerShell, then check that Bun is version 1.4 or newer. If it is older, use the upgrade instructions in [Step by step](#step-by-step).

   **PowerShell**
   ```powershell
   powershell -c "irm bun.sh/install.ps1 | iex"
   ```

   **PowerShell**
   ```powershell
   bun --version
   ```

3. Install omp if needed, reopen PowerShell, then check for a version number.

   **PowerShell**
   ```powershell
   irm https://omp.sh/install.ps1 | iex
   ```

   **PowerShell**
   ```powershell
   omp --version
   ```

4. Start omp and sign in. Run the command below, then type the next command at the omp prompt. Choose your provider (choose Anthropic for a Claude subscription), approve the browser login, then quit omp. After approval, the account is signed in. You can do this later, but omp-console cannot start working sessions until you sign in.

   **PowerShell**
   ```powershell
   omp
   ```

   **PowerShell (omp prompt)**
   ```text
   /login
   ```

5. Download the repository. You should see the `omp-console` folder under your home folder.

   **PowerShell**
   ```powershell
   git clone https://github.com/LQ458/omp-console.git "$HOME\omp-console"
   ```

6. Enter that folder. The PowerShell prompt should now show `omp-console` as the current directory.

   **PowerShell**
   ```powershell
   Set-Location "$HOME\omp-console"
   ```

7. Install and start the service. The installer builds the web app, registers the Scheduled Task, and opens a page for you to connect this browser.

   **PowerShell**
   ```powershell
   .\scripts\install.ps1
   ```

## Step by step

### Before you install

You need macOS on Apple Silicon (Intel Macs should work but are untested), Linux such as Ubuntu, Debian, Fedora, or Arch (x64 or arm64), or Windows 10/11 x64. Have a terminal, about 1 GB of free disk space, Git, Bun 1.4 or newer, and omp installed. A model-provider account is needed to run sessions; this can be a Claude or ChatGPT subscription, or an API key.

On macOS, Git comes with Apple's command line developer tools. If macOS offers to install them, accept the prompt. On Windows, install Git for Windows and reopen PowerShell. On Linux, the Fast path has package commands for Debian/Ubuntu, Fedora, and Arch. Run one command at a time. If you see a line beginning with `#` in an example, it is a comment and you do not need to type it.

The official Bun installer is shown in the Fast path for each operating system. After it finishes, reopen the terminal before checking the version. The omp installer is also shown there. If a tool is already present, check its version instead of installing it again. To update an old Bun, run this command in Terminal or PowerShell, then check the version again:

**Terminal or PowerShell**
```text
bun upgrade
```

### Sign in to omp

Start omp with the command in the Fast path, then type the command below at its prompt. Choose your model provider, approve the browser login, and quit omp. For a Claude subscription, choose Anthropic. You may skip sign-in during installation; the first-run checklist reminds you, but working sessions will not start until omp is signed in.

**Terminal or PowerShell (omp prompt)**
```text
/login
```

### Download and install omp-console

The Fast path commands clone the source into `~/omp-console` on macOS/Linux or `$HOME\omp-console` on Windows. The desktop app on the [Releases page](https://github.com/LQ458/omp-console/releases) is only a window onto the service. Install the service from the source checkout first.

- **macOS:** the install command uses the LaunchAgent service.
- **Linux:** enable user lingering, then install the systemd user service. Lingering keeps it running after logout. If the command fails or asks for a password, run this alternative yourself or ask an administrator:

  **Terminal**
  ```sh
  sudo loginctl enable-linger "$USER"
  ```

- **Windows:** the installer uses a per-user Scheduled Task. Administrator rights are not needed. If PowerShell blocks the unsigned script because of its execution policy, run it this way from the repository folder:

  **PowerShell**
  ```powershell
  powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1
  ```

The macOS/Linux installer checks Bun and omp, downloads dependencies, builds the web app, installs the `omp-console` command, and starts the service unless you use plain mode. It usually takes one to three minutes. On Windows, the installer builds the app, installs `omp-console.cmd` under `$HOME\.local\bin`, secures `$HOME\.omp-console` with an ACL for your account and SYSTEM, registers and starts the per-user Scheduled Task, then opens the connection page when PowerShell is interactive. It does not read or write API keys.

To allow Tailscale Serve to reach the service, add your computer's Tailscale DNS name to the install command. On Windows, you can also require a tailnet login. These options are for phone access; do not expose the service through a public proxy.

**Windows PowerShell**
```powershell
.\scripts\install.ps1 -Service -AllowHost 'machine.tailnet.ts.net' -Owner 'tailnet-login'
```

**Terminal**
```sh
./scripts/install.sh --launchd --allow-host 'machine.tailnet.ts.net'
```

**Terminal**
```sh
./scripts/install.sh --systemd --allow-host 'machine.tailnet.ts.net'
```

If you do not want a service—for example, inside a container—use plain mode. It builds and installs the command but does not start a service. On Windows, the installer prints the exact PowerShell command to start the service. Run that printed command in one PowerShell window and leave the window open; in another window, run the open command from [Everyday use](#everyday-use). Closing the start-command window stops the service.

**Terminal**
```sh
./scripts/install.sh --plain
```

**PowerShell**
```powershell
.\scripts\install.ps1 -Plain
```

### Connect this browser

When installation finishes in a desktop terminal, it opens a connection page. Click **Pair this browser**. The browser is now connected.

If no browser opened—for example, during an SSH install or in plain mode—run the open command in [Everyday use](#everyday-use). It prints a one-click link. Open the link in a browser on the same computer and click **Pair this browser**. The one-time code expires after 10 minutes; run the open command again to get another code.

Later, open `http://127.0.0.1:7490` in the browser you connected. Bookmark the page, or install it as an app from the browser menu. In Chrome or Edge, choose **Install app**. In Safari, choose **File → Add to Dock**.

### Start your first session

The home screen has a short checklist:

- **omp** shows the version and path of the omp the service found.
- **Model sign-in** shows whether omp has a model it can use. If it does not, sign in to omp and reload this page.
- **Existing omp sessions** counts your terminal omp sessions; **Open sessions** shows them. Opening one makes a copy and does not change the original session file.
- **Claude Code history** shows whether Claude Code conversations are available. See [Migrate from Claude Code or Codex](migrating-from-claude-code.md) to import conversations or setup.

Click **+** (New session) at the top of the session list, then choose the project folder: the folder that contains your project's files, such as the folder you would open in VS Code. Type your first request and send it. For the next steps, see [Getting started](GETTING-STARTED.md).

## Connect your phone

Phone access uses [Tailscale](https://tailscale.com), a private network between your devices. Nothing is opened to the public internet. Phone access from a Windows host is untested.

1. Install Tailscale on the computer and phone. Sign in to the same account on both. Both devices should appear in the Tailscale app.
2. Rerun the install command for your operating system with the computer's Tailscale name. Find the name in the Tailscale app; it looks like `my-mac.tail1234.ts.net`. The installer should finish and restart the service.

   **Terminal (macOS)**
   ```sh
   ./scripts/install.sh --launchd --allow-host 'my-mac.tail1234.ts.net'
   ```

   **Terminal (Linux)**
   ```sh
   ./scripts/install.sh --systemd --allow-host 'my-mac.tail1234.ts.net'
   ```

   On Windows, use the `-Service` and `-AllowHost` options shown above. You may add `-Owner` with your tailnet login to require that login too.

3. Start Tailscale Serve. The script prints an `https://…ts.net` address.

   **Terminal**
   ```sh
   ./ops/tailscale-serve.sh
   ```

4. In the connected browser on your computer, open **Settings → Devices → Pair another device** and request a code. The browser shows a one-time code.
5. Open the printed address on your phone and click **Pair this browser**. Enter the code from the previous step. The omp-console page should open on the phone.

Do not use Tailscale Funnel or a public reverse proxy. The service can run commands on your computer.

## Optional desktop app

The desktop app is a window onto the service at `http://127.0.0.1:7490`. Install the service first. Download the app from the [Releases page](https://github.com/LQ458/omp-console/releases), under **Assets** in the newest release.

| Computer | Download |
|---|---|
| Mac with Apple Silicon | `omp-console_<version>_macos-arm64.zip` |
| Windows 10/11 x64 | `omp-console_<version>_x64-setup.exe` or the `.msi` |
| Debian/Ubuntu, x64 or arm64 | the `.deb` for `amd64` or `arm64` |
| Other Linux | the `.AppImage` for `amd64` or `aarch64` |

**macOS:** Unzip the file and drag **omp console** into Applications. Apple has not notarized the app, so the first launch is blocked. Open **System Settings → Privacy & Security**, scroll down, and click **Open Anyway** beside the omp console message. If macOS says the app is “damaged”, remove the quarantine attribute once, then open it again:

**Terminal**
```sh
xattr -dr com.apple.quarantine "/Applications/omp console.app"
```

Intel Macs can build the app locally. This needs Rust and the Xcode command line tools; see [the Mac app build notes](../apps/mac/README.md).

**Terminal**
```sh
./scripts/install.sh --launchd --app
```

**Windows:** Run the setup `.exe`. If SmartScreen says “Windows protected your PC”, click **More info**, then **Run anyway**. The app installs Microsoft Edge WebView2 if needed (internet required), connects to the local service, and reads the one-time code from `%USERPROFILE%\.omp-console\pairing-code`. Project moves still require the Mac app.

**Debian/Ubuntu:** Install the matching `.deb` file:

**Terminal**
```sh
sudo apt install ./omp-console_*_amd64.deb
```

Use the `_arm64.deb` file instead on arm64.

**AppImage:** Make the downloaded file executable, then run it:

**Terminal**
```sh
chmod +x omp-console_*.AppImage
```

**Terminal**
```sh
./omp-console_*.AppImage
```

Each release includes `SHA256SUMS.txt`. Calculate the downloaded file's checksum and compare it with that file. Replace `replace-with-the-downloaded-file-name` in the command with the exact file name.

**Terminal (macOS)**
```sh
shasum -a 256 "replace-with-the-downloaded-file-name"
```

**Terminal (Linux)**
```sh
sha256sum "replace-with-the-downloaded-file-name"
```

## Everyday use

On macOS/Linux, the command is installed under `$HOME/.local/bin`. On Windows, reopen PowerShell if it cannot find `omp-console`.

- Open the page and make a fresh one-time code:

  **Terminal (macOS/Linux)**
  ```sh
  ~/.local/bin/omp-console open
  ```

  **PowerShell**
  ```powershell
  omp-console open
  ```

- Print a new code and link without opening a browser:

  **Terminal (macOS/Linux)**
  ```sh
  ~/.local/bin/omp-console pair
  ```

  **PowerShell**
  ```powershell
  omp-console pair
  ```

- Check whether the service is running:

  **Terminal (macOS/Linux)**
  ```sh
  ~/.local/bin/omp-console status
  ```

  **PowerShell**
  ```powershell
  omp-console status
  ```

- Show recent service logs:

  **Terminal (macOS/Linux)**
  ```sh
  ~/.local/bin/omp-console logs
  ```

  **PowerShell**
  ```powershell
  omp-console logs
  ```

## Update

**Windows PowerShell:** The installer stops the old task and service processes before rebuilding and restarting. If you used `-AllowHost`, pass the same `-AllowHost` and `-Owner` options again.

**PowerShell**

```powershell
Set-Location "$HOME\omp-console"
```

**PowerShell**

```powershell
git pull
```

**PowerShell**

```powershell
.\scripts\install.ps1
```

**macOS/Linux:** Run the installer again with the service option you used when you installed. Reload the browser tab afterward.

**Terminal**
```sh
cd ~/omp-console
```

**Terminal**
```sh
git pull
```

**Terminal (macOS)**
```sh
./scripts/install.sh --launchd
```

**Terminal (Linux)**
```sh
./scripts/install.sh --systemd
```

With plain mode, stop the old service with Ctrl+C in its window and run the printed start command again.

## Uninstall

Uninstalling removes the background service only; it does not remove omp or its settings and sessions.

**Windows PowerShell:** This stops and removes the Scheduled Task and this checkout's command shim. The repository and `$HOME\.omp-console` state stay in place.

**PowerShell**

```powershell
Set-Location "$HOME\omp-console"
```

**PowerShell**

```powershell
.\scripts\install.ps1 -Uninstall
```

**macOS/Linux:** This removes only the LaunchAgent or systemd user service. To remove all omp-console files too, delete `~/omp-console`, `~/.omp-console`, and `~/.local/bin/omp-console` yourself. Your omp installation, settings, and sessions under `~/.omp` are not touched.

**Terminal**
```sh
cd ~/omp-console
```

**Terminal**
```sh
./scripts/install.sh --uninstall
```

## Troubleshooting

- **Bun or omp is not found.** Open a new terminal window. On macOS/Linux, reload your shell profile if needed.
- **The installer says Bun 1.4 or newer is required.** Upgrade Bun, reopen the terminal, and rerun the installer.

  **Terminal or PowerShell**
  ```text
  bun upgrade
  ```

- **The page is blank.** Bun may have been too old when the web app was built. Upgrade Bun, then rerun the installer.
- **The one-time link expired.** It is valid for 10 minutes. Run the open command in [Everyday use](#everyday-use) again.
- **The page does not load.** Check the service status and logs using the commands in [Everyday use](#everyday-use). On Windows, also check the Scheduled Task and its log file.

  **PowerShell**
  ```powershell
  Get-ScheduledTask -TaskName omp-console
  ```

  Windows log file: `%LOCALAPPDATA%\omp-console\logs\daemon.log`.

  **Terminal (Linux)**
  ```sh
  systemctl --user restart omp-console
  ```

- **Port 7490 is already in use.** Another program may use it. Quit that program or stop an older omp-console you started by hand, then rerun the installer.
- **The checklist shows no model.** Sign in to omp. If the service cannot see your API key, add a literal `KEY=value` line to the environment file at `$HOME\.omp-console\env` on Windows or `~/.omp-console/env` on macOS/Linux. Restart the Windows task or Linux service:

  **PowerShell**
  ```powershell
  Stop-ScheduledTask -TaskName omp-console
  ```

  **PowerShell**
  ```powershell
  Start-ScheduledTask -TaskName omp-console
  ```

  **Terminal (Linux)**
  ```sh
  systemctl --user restart omp-console
  ```

- **Linux stops the service after logout.** Enable user lingering as described in the Linux Fast path. If needed, an administrator can run its `sudo` alternative.
- **The desktop app says it cannot reach the service.** Start the service, then click **Retry**.
- **You prefer Linux on Windows.** Follow the Linux instructions inside an Ubuntu WSL 2 terminal. Native PowerShell is recommended and does not need WSL.

Still stuck? [Open an issue](https://github.com/LQ458/omp-console/issues) with the service status and recent logs. On Windows, include the log file above. Remove anything private, such as tokens or file paths you do not want to share, before posting.
