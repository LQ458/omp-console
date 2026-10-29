# 安装 omp-console

本指南适用于 macOS、Linux 和原生 Windows 10/11 x64。通常需要 10–15 分钟。如果希望让代码智能体代为安装，请看[使用代码智能体安装](INSTALL-WITH-AN-AGENT.md)。

## 安装完成后，你会得到

- 本机运行的 omp-console 页面：`http://127.0.0.1:7490`。
- 在电脑上运行 omp 会话的后台服务（技术信息中也称 daemon）。
- 已连接到本机的浏览器；默认情况下，只有这台电脑能访问页面。
- 可作为副本打开的终端 omp 会话，以及导入 Claude Code 对话的功能。
- 可选的桌面应用，或通过私有 Tailscale 网络连接手机。

## 快速安装

选择与你的电脑对应的部分。已安装的工具可跳过安装命令。所有命令都在将运行 omp-console 的电脑上执行。

### macOS

1. 检查 Git。应显示版本号。如果 macOS 提示安装 Apple 命令行开发工具，点击 **Install（安装）**，等待完成后再检查。

   **Terminal**
   ```sh
   git --version
   ```

2. 如果尚未安装 Bun，执行安装命令。关闭并重新打开 Terminal，再检查版本是否为 1.4 或更高。版本过旧时，按[逐步安装](#step-by-step)中的说明升级。

   **Terminal**
   ```sh
   curl -fsSL https://bun.sh/install | bash
   ```

   **Terminal**
   ```sh
   bun --version
   ```

3. 如果尚未安装 omp，执行安装命令。重新打开 Terminal，并检查是否显示版本号。

   **Terminal**
   ```sh
   curl -fsSL https://omp.sh/install | sh
   ```

   **Terminal**
   ```sh
   omp --version
   ```

4. 启动 omp 并登录。先运行下方命令，再在 omp 提示符中输入下一条命令。选择模型提供商（Claude 订阅请选择 Anthropic），在浏览器中批准登录，然后退出 omp。批准后，账户即已登录。也可稍后登录，但登录前无法启动工作会话。

   **Terminal**
   ```sh
   omp
   ```

   **Terminal（omp 提示符）**
   ```text
   /login
   ```

5. 下载仓库。完成后，主目录中应出现 `omp-console` 文件夹。

   **Terminal**
   ```sh
   git clone https://github.com/LQ458/omp-console.git ~/omp-console
   ```

6. 进入该文件夹。终端提示符应显示当前目录为 `omp-console`。

   **Terminal**
   ```sh
   cd ~/omp-console
   ```

7. 安装并启动服务。安装程序会构建网页、安装命令、启动服务，并打开连接页面。

   **Terminal**
   ```sh
   ./scripts/install.sh --launchd
   ```

### Linux

1. Debian/Ubuntu 用户更新软件包索引；Fedora 和 Arch 用户跳过此步。包管理器应正常结束，不显示错误。

   **Terminal**
   ```sh
   sudo apt-get update
   ```

2. 安装 Git、curl 和 unzip。包管理器应正常结束，不显示错误。

   **Terminal（Debian/Ubuntu）**
   ```sh
   sudo apt-get install -y git curl unzip
   ```

   **Terminal（Fedora）**
   ```sh
   sudo dnf install -y git curl unzip
   ```

   **Terminal（Arch）**
   ```sh
   sudo pacman -S --needed git curl unzip
   ```

3. 如果尚未安装 Bun，执行安装命令。关闭并重新打开终端，检查版本是否为 1.4 或更高。版本过旧时，按[逐步安装](#step-by-step)中的说明升级。

   **Terminal**
   ```sh
   curl -fsSL https://bun.sh/install | bash
   ```

   **Terminal**
   ```sh
   bun --version
   ```

4. 如果尚未安装 omp，执行安装命令，重新打开终端并检查版本号。

   **Terminal**
   ```sh
   curl -fsSL https://omp.sh/install | sh
   ```

   **Terminal**
   ```sh
   omp --version
   ```

5. 启动 omp 并登录。先运行下方命令，再在 omp 提示符中输入下一条命令。选择模型提供商（Claude 订阅请选择 Anthropic），在浏览器中批准登录，然后退出 omp。批准后，账户即已登录。也可稍后登录，但登录前无法启动工作会话。

   **Terminal**
   ```sh
   omp
   ```

   **Terminal（omp 提示符）**
   ```text
   /login
   ```

6. 下载仓库。完成后，主目录中应出现 `omp-console` 文件夹。

   **Terminal**
   ```sh
   git clone https://github.com/LQ458/omp-console.git ~/omp-console
   ```

7. 进入仓库文件夹。终端提示符应显示当前目录为 `omp-console`。

   **Terminal**
   ```sh
   cd ~/omp-console
   ```

8. 允许用户服务在你退出登录后继续运行。命令应正常结束。如果失败或要求输入密码，请阅读下面的逐步说明，了解 `sudo` 替代命令。

   **Terminal**
   ```sh
   loginctl enable-linger "$USER"
   ```

9. 安装并启动服务。安装程序会构建网页并打开连接页面。

   **Terminal**
   ```sh
   ./scripts/install.sh --systemd
   ```

### Windows 10/11（PowerShell）

请使用普通 PowerShell 窗口。原生 Windows 版本无需 WSL，也不需要管理员权限。安装程序会为当前用户创建 Scheduled Task（计划任务）。WSL 2 是可选方案，见下方逐步说明。

1. 安装 [Git for Windows](https://git-scm.com/download/win)，重新打开 PowerShell 并检查 Git。应显示版本号。

   **PowerShell**
   ```powershell
   git --version
   ```

2. 如果尚未安装 Bun，执行安装命令。关闭并重新打开 PowerShell，再检查版本是否为 1.4 或更高。版本过旧时，按[逐步安装](#step-by-step)中的说明升级。

   **PowerShell**
   ```powershell
   powershell -c "irm bun.sh/install.ps1 | iex"
   ```

   **PowerShell**
   ```powershell
   bun --version
   ```

3. 如果尚未安装 omp，执行安装命令，重新打开 PowerShell 并检查版本号。

   **PowerShell**
   ```powershell
   irm https://omp.sh/install.ps1 | iex
   ```

   **PowerShell**
   ```powershell
   omp --version
   ```

4. 启动 omp 并登录。先运行下方命令，再在 omp 提示符中输入下一条命令。选择模型提供商（Claude 订阅请选择 Anthropic），在浏览器中批准登录，然后退出 omp。批准后，账户即已登录。也可稍后登录，但登录前无法启动工作会话。

   **PowerShell**
   ```powershell
   omp
   ```

   **PowerShell（omp 提示符）**
   ```text
   /login
   ```

5. 下载仓库。完成后，主目录下应出现 `omp-console` 文件夹。

   **PowerShell**
   ```powershell
   git clone https://github.com/LQ458/omp-console.git "$HOME\omp-console"
   ```

6. 进入仓库文件夹。PowerShell 提示符应显示当前目录为 `omp-console`。

   **PowerShell**
   ```powershell
   Set-Location "$HOME\omp-console"
   ```

7. 安装并启动服务。安装程序会构建网页、注册 Scheduled Task，并在交互式 PowerShell 中打开连接页面。

   **PowerShell**
   ```powershell
   .\scripts\install.ps1
   ```

<a id="step-by-step"></a>

## 逐步安装

### 开始前

支持 Apple Silicon Mac（Intel Mac 应可运行，但尚未测试）、Linux（例如 Ubuntu、Debian、Fedora、Arch，x64 或 arm64）以及 Windows 10/11 x64。你需要终端、约 1 GB 可用磁盘空间、Git、Bun 1.4 或更高版本，以及 omp。要运行模型会话，还需要模型提供商账户，例如 Claude 或 ChatGPT 订阅，或 API key。

macOS 的 Git 随 Apple 命令行开发工具提供；如果系统提示安装，请接受。Windows 需要 Git for Windows，并在安装后重新打开 PowerShell。Linux 的快速安装部分列出了 Debian/Ubuntu、Fedora 和 Arch 的软件包命令。一次运行一条命令。示例中的 `#` 开头行是注释，不必输入。

Bun 与 omp 的官方下载命令已列在上方。安装后重新打开终端再检查版本。若工具已安装，只需检查版本，不必重复安装。若 Bun 过旧，在 Terminal 或 PowerShell 中运行以下命令，然后重新检查：

**Terminal 或 PowerShell**
```text
bun upgrade
```

### 登录 omp

使用快速安装部分中的命令启动 omp，然后在它的提示符中输入下面的命令。选择模型提供商，在浏览器中批准登录，然后退出 omp。Claude 订阅请选择 Anthropic。可暂时跳过登录；首次打开时的清单会提醒你，但登录前无法启动工作会话。

**Terminal 或 PowerShell（omp 提示符内）**
```text
/login
```

### 下载并安装 omp-console

快速安装部分会将源代码克隆到 macOS/Linux 的 `~/omp-console` 或 Windows 的 `$HOME\omp-console`。从 [Releases 页面](https://github.com/LQ458/omp-console/releases)下载的桌面应用只是服务的窗口，不能替代从源代码安装服务。

- **macOS：**安装命令使用 LaunchAgent 服务。
- **Linux：**先启用用户 lingering（保持用户服务运行），再安装 systemd 用户服务。这样即使退出登录，服务也会继续运行。如果命令失败或要求密码，可自行运行或请管理员运行：

  **Terminal**
  ```sh
  sudo loginctl enable-linger "$USER"
  ```

- **Windows：**安装程序创建当前用户的 Scheduled Task，不需要管理员权限。如果 PowerShell 因执行策略阻止未签名脚本，请在仓库目录中运行：

  **PowerShell**
  ```powershell
  powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1
  ```

macOS/Linux 安装程序会检查 Bun 和 omp、下载依赖、构建网页、安装 `omp-console` 命令，并在正常模式下启动服务。通常需要一到三分钟。Windows 安装程序会构建网页，在 `$HOME\.local\bin` 安装 `omp-console.cmd`，为当前账户和 SYSTEM 设置 `$HOME\.omp-console` 的访问权限，注册并启动当前用户的 Scheduled Task；PowerShell 可交互时还会打开连接页面。安装程序不会读取或写入 API key。

若要通过 Tailscale Serve 访问服务，请在安装命令中加入电脑的 Tailscale DNS 名称。Windows 上还可指定 tailnet 登录名。手机连接需要这些选项；不要通过公开代理暴露服务。

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

如果不想安装后台服务（例如在容器中），可选手动启动模式（`--plain`）。它会构建网页并安装命令，但不会启动服务。Windows 安装程序会打印准确的 PowerShell 启动命令；在一个 PowerShell 窗口运行并保持窗口打开，再在另一个窗口运行[日常使用](#everyday-use)中的打开命令。关闭启动命令所在窗口后，服务会停止。

**Terminal**
```sh
./scripts/install.sh --plain
```

**PowerShell**
```powershell
.\scripts\install.ps1 -Plain
```

### 连接浏览器

安装程序在桌面终端中运行时，会自动打开连接页面。点击 **Pair this browser（连接此浏览器）**即可连接。

如果没有自动打开页面（例如通过 SSH 安装或使用手动启动模式），请运行[日常使用](#everyday-use)中的打开命令。它会打印一个一次性链接。在同一台电脑上的浏览器中打开链接，再点击 **Pair this browser**。连接码 10 分钟后过期；重新运行打开命令即可获得新码。

以后可在已连接的浏览器中打开 `http://127.0.0.1:7490`。可以收藏页面，或从浏览器菜单将它安装为应用。Chrome/Edge 中选择 **Install app（安装应用）**；Safari 中选择 **File → Add to Dock（文件 → 添加到程序坞）**。

### 启动第一个会话

主页上有一份简短清单：

- **omp**：显示服务找到的 omp 版本和路径。
- **Model sign-in（模型登录）**：显示 omp 是否有可用模型。若没有，请登录 omp 并重新加载页面。
- **Existing omp sessions（已有的 omp 会话）**：统计终端中的 omp 会话，点击 **Open sessions（打开会话）**可查看。打开时会创建副本，不会更改原始会话文件。
- **Claude Code history（Claude Code 历史记录）**：显示是否找到 Claude Code 对话。导入对话或设置请看[从 Claude Code 或 Codex 迁移](../migrating-from-claude-code.md)。

点击会话列表顶部的 **+**（New session，新建会话），选择项目文件夹，也就是包含项目文件、你在 VS Code 里会打开的那个文件夹，然后输入并发送第一项请求。后续操作见[入门指南](GETTING-STARTED.md)。

<a id="connect-your-phone"></a>
## 连接手机

手机通过 [Tailscale](https://tailscale.com) 访问。这是设备之间的私有网络，不会将服务公开到互联网。Windows 主机的手机访问尚未测试。

1. 在电脑和手机上安装 Tailscale，并在两台设备上登录同一账户。Tailscale 应用中应显示两台设备。
2. 使用电脑的 Tailscale 名称重新运行对应系统的安装命令。名称显示在 Tailscale 应用中，类似 `my-mac.tail1234.ts.net`。安装程序应正常结束并重启服务。

   **Terminal（macOS）**
   ```sh
   ./scripts/install.sh --launchd --allow-host 'my-mac.tail1234.ts.net'
   ```

   **Terminal（Linux）**
   ```sh
   ./scripts/install.sh --systemd --allow-host 'my-mac.tail1234.ts.net'
   ```

   Windows 使用上方的 `-Service` 和 `-AllowHost` 参数；还可加 `-Owner` 要求匹配 tailnet 登录名。

3. 启动 Tailscale Serve。脚本会打印 `https://…ts.net` 地址。

   **Terminal**
   ```sh
   ./ops/tailscale-serve.sh
   ```

4. 在电脑上已连接的浏览器中打开 **Settings（设置） → Devices（设备） → Pair another device（配对另一台设备）**，申请连接码。浏览器应显示一次性连接码。
5. 在手机上打开打印出的地址，输入上一步的连接码，并点击 **Pair this browser**。手机上应打开 omp-console 页面。

不要使用 Tailscale Funnel 或公开反向代理。该服务可以在电脑上运行命令。

## 可选：桌面应用

桌面应用是连接到 `http://127.0.0.1:7490` 的窗口，请先安装服务。前往 [Releases 页面](https://github.com/LQ458/omp-console/releases)，在最新版本的 **Assets（资源）**下下载：

| 电脑 | 下载文件 |
|---|---|
| Apple Silicon Mac | `omp-console_<version>_macos-arm64.zip` |
| Windows 10/11 x64 | `omp-console_<version>_x64-setup.exe` 或 `.msi` |
| Debian/Ubuntu，x64 或 arm64 | 对应架构的 `.deb`（`amd64` 或 `arm64`） |
| 其他 Linux | 对应架构的 `.AppImage`（`amd64` 或 `aarch64`） |

**macOS：**解压文件，将 **omp console** 拖入 Applications（应用程序）。Apple 尚未对应用进行公证，因此首次启动会被阻止。打开 **System Settings → Privacy & Security（系统设置 → 隐私与安全性）**，向下滚动，在 omp console 提示旁点击 **Open Anyway（仍要打开）**。如果 macOS 显示应用 “damaged”（“已损坏”），先运行下面命令移除隔离属性，再重新打开：

**Terminal**
```sh
xattr -dr com.apple.quarantine "/Applications/omp console.app"
```

Intel Mac 可在本机编译应用，需要 Rust 和 Xcode 命令行开发工具；见 [Mac 应用构建说明](../../apps/mac/README.md)。

**Terminal**
```sh
./scripts/install.sh --launchd --app
```

**Windows：**运行安装 `.exe`。若 SmartScreen 显示 “Windows protected your PC”（Windows 已保护你的电脑），点击 **More info（更多信息）**，再点击 **Run anyway（仍要运行）**。应用会在需要时安装 Microsoft Edge WebView2（需要互联网），连接本机服务，并从 `%USERPROFILE%\.omp-console\pairing-code` 读取一次性连接码。移动项目仍需要 Mac 应用。

**Debian/Ubuntu：**安装对应的 `.deb` 文件。arm64 请使用 `_arm64.deb` 文件。

**Terminal**
```sh
sudo apt install ./omp-console_*_amd64.deb
```

**AppImage：**先给下载文件添加可执行权限，再启动它。

**Terminal**
```sh
chmod +x omp-console_*.AppImage
```

**Terminal**
```sh
./omp-console_*.AppImage
```

每个版本都附有 `SHA256SUMS.txt`。计算下载文件的校验和，并与该文件中的对应值比较。请将命令中的 `replace-with-the-downloaded-file-name` 替换为下载文件的实际名称。

**Terminal（macOS）**
```sh
shasum -a 256 "replace-with-the-downloaded-file-name"
```

**Terminal（Linux）**
```sh
sha256sum "replace-with-the-downloaded-file-name"
```

<a id="everyday-use"></a>

## 日常使用

macOS/Linux 的命令安装在 `$HOME/.local/bin`。Windows PowerShell 找不到 `omp-console` 时，请重新打开 PowerShell。

- 打开页面并生成新的一次性连接码：

  **Terminal（macOS/Linux）**
  ```sh
  ~/.local/bin/omp-console open
  ```

  **PowerShell**
  ```powershell
  omp-console open
  ```

- 仅打印新连接码和链接，不打开浏览器：

  **Terminal（macOS/Linux）**
  ```sh
  ~/.local/bin/omp-console pair
  ```

  **PowerShell**
  ```powershell
  omp-console pair
  ```

- 检查服务是否运行：

  **Terminal（macOS/Linux）**
  ```sh
  ~/.local/bin/omp-console status
  ```

  **PowerShell**
  ```powershell
  omp-console status
  ```

- 查看近期服务日志：

  **Terminal（macOS/Linux）**
  ```sh
  ~/.local/bin/omp-console logs
  ```

  **PowerShell**
  ```powershell
  omp-console logs
  ```

## 更新

**Windows PowerShell：**安装程序会先停止旧的计划任务及服务进程，再重新构建和启动。如果使用过 `-AllowHost`，需再次传入相同的 `-AllowHost` 和 `-Owner` 参数。

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

**macOS/Linux：**再次运行初次安装时使用的服务选项，完成后重新加载浏览器页面。

**Terminal**
```sh
cd ~/omp-console
```

**Terminal**
```sh
git pull
```

**Terminal（macOS）**
```sh
./scripts/install.sh --launchd
```

**Terminal（Linux）**
```sh
./scripts/install.sh --systemd
```

手动启动模式下，请在旧服务的窗口按 Ctrl+C 停止，然后重新运行安装程序打印出的启动命令。

## 卸载

卸载只移除后台服务，不会移除 omp、omp 设置或会话。

**Windows PowerShell：**停止并移除 Scheduled Task 和当前仓库安装的命令启动脚本；保留仓库及 `$HOME\.omp-console` 状态目录。

**PowerShell**

```powershell
Set-Location "$HOME\omp-console"
```

**PowerShell**

```powershell
.\scripts\install.ps1 -Uninstall
```

**macOS/Linux：**只移除 LaunchAgent 或 systemd 用户服务。如需删除 omp-console 创建的所有文件，还要自行删除 `~/omp-console`、`~/.omp-console` 和 `~/.local/bin/omp-console`。不会改动 `~/.omp` 下的 omp 安装、设置或会话。

**Terminal**
```sh
cd ~/omp-console
```

**Terminal**
```sh
./scripts/install.sh --uninstall
```

<a id="troubleshooting"></a>

## 故障排除

- **找不到 Bun 或 omp：**打开新的终端窗口。macOS/Linux 上必要时重新加载 shell 配置文件。
- **安装程序要求 Bun 1.4 或更高版本：**升级 Bun，重新打开终端，再次运行安装程序。

  **Terminal 或 PowerShell**
  ```text
  bun upgrade
  ```

- **页面空白：**构建网页时使用的 Bun 版本可能过旧。升级 Bun 后重新运行安装程序。
- **一次性链接过期：**连接码有效期为 10 分钟。再次运行上面的 `open` 命令即可。
- **页面无法打开：**使用“日常使用”中的命令检查服务状态并查看日志。Windows 上还可检查 Scheduled Task 和日志文件。

  **PowerShell**
  ```powershell
  Get-ScheduledTask -TaskName omp-console
  ```

  Windows 日志文件位于 `%LOCALAPPDATA%\omp-console\logs\daemon.log`。

  **Terminal（Linux）**
  ```sh
  systemctl --user restart omp-console
  ```

- **端口 7490 已被占用：**可能有其他程序正在使用该端口。退出该程序，或停止你手动启动的旧 omp-console，再重新运行安装程序。
- **清单显示没有模型：**登录 omp。如果服务无法读取 API key，可在 Windows 的 `$HOME\.omp-console\env` 或 macOS/Linux 的 `~/.omp-console/env` 中添加一行字面格式的 `KEY=value`。然后重启 Windows 任务或 Linux 服务：

  **PowerShell**
  ```powershell
  Stop-ScheduledTask -TaskName omp-console
  ```

  **PowerShell**
  ```powershell
  Start-ScheduledTask -TaskName omp-console
  ```

  **Terminal（Linux）**
  ```sh
  systemctl --user restart omp-console
  ```

- **退出 Linux 登录后服务停止：**按 Linux 快速安装中的说明启用“退出登录后继续运行服务”；必要时请管理员运行带 `sudo` 的替代命令。
- **桌面应用提示无法连接服务：**启动服务，再点击 **Retry（重试）**。
- **想在 Windows 上使用 Linux：**在 Ubuntu WSL 2 终端内按 Linux 安装说明操作。推荐原生 PowerShell 安装，无需 WSL。

仍无法解决？请在 [GitHub 上提交问题](https://github.com/LQ458/omp-console/issues)，附上服务状态和近期日志。Windows 日志路径见上方。发布前请删除令牌或不想公开的文件路径等隐私信息。
