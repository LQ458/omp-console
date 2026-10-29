# 使用代码智能体安装

可以让运行在你电脑上的代码智能体按照[安装指南](INSTALL.md)安装 omp-console。它会逐步检查，并在执行需要你授权的操作前停下来询问。

1. 在将运行 omp-console 的电脑上打开 Terminal（macOS）、Linux 终端或 PowerShell（Windows）。
2. 在该终端中启动代码智能体，例如 omp、Claude Code 或 Codex。
3. 复制下方完整提示词，作为消息发给智能体。
4. 回答它的问题。最后，智能体会告诉你如何打开 omp-console。

你需要自己在浏览器中登录模型提供商，并点击 **Pair this browser（连接此浏览器）**。不要把密码或 API key 发到智能体对话中。

````text
请在这台电脑上为我安装 omp-console（https://github.com/LQ458/omp-console）。请按照仓库中的 docs/zh-CN/INSTALL.md 操作，并遵守以下规则和步骤。

规则
- 仅在这台电脑上、以我的用户身份操作。安装系统软件包、Bun、omp 或 Git for Windows 前先征求我的同意。任何需要 sudo 或管理员权限的命令，都先给我准确命令并说明在哪里运行，然后等待我确认已完成。
- 绝不索要、读取、打印或保存密码、API key 或 token。不要打开或打印 ~/.omp、~/.claude、~/.codex 或 ~/.omp-console/env。
- 不要更改我现有的 omp 设置或会话。
- 服务只监听 127.0.0.1。除非我明确要求，不要设置 Tailscale、Funnel、端口转发或反向代理。
- 一次只做一个步骤，并在继续前确认步骤成功。如果某一步连续失败两次，就停下来，向我展示准确错误并说明可能原因。不要绕过安装程序，也不要编辑安装程序文件。
- 每一步用一句简短、通俗的话说明你正在做什么。

步骤
1. 检测系统。
   - Windows 10/11 x64（`$env:OS` 是 `Windows_NT`）：使用 PowerShell，不使用 WSL。检查 `git --version`、`bun --version` 和 `omp --version`。
   - 其他系统运行 `uname -sm`。只在 macOS 或 Linux 上继续。Linux 上检查 `systemctl --user show-environment` 是否可用。
2. 运行 `git --version` 检查 Git。若没有 Git，先征求我的同意再安装。macOS 上请我接受 Apple 命令行开发工具提示（`xcode-select --install`）。Linux 上给我适用于当前软件包管理器的 Git、curl 和 unzip 安装命令。Windows 上先征求同意，再安装 [Git for Windows](https://git-scm.com/download/win) 或运行 `winget install --id Git.Git -e`。重新打开终端或 PowerShell 后再检查。
3. 运行 `bun --version` 检查 Bun；最低版本是 1.4。若没有 Bun，先征求我的同意。Windows 使用 `powershell -c "irm bun.sh/install.ps1 | iex"`；macOS/Linux 使用 `curl -fsSL https://bun.sh/install | bash`。重新打开终端并再次检查。版本过旧时，先征求同意再运行 `bun upgrade`。
4. 运行 `omp --version` 检查 omp。若没有 omp，先征求我的同意再安装。Windows 使用 `irm https://omp.sh/install.ps1 | iex`；macOS/Linux 使用 `curl -fsSL https://omp.sh/install | sh`。重新打开终端并再次检查。不要替我登录。
5. 获取源码。Windows 使用 `$HOME\omp-console`，macOS/Linux 使用 `~/omp-console`。如果目录已存在且是 github.com/LQ458/omp-console 的克隆，在目录中运行 `git pull --ff-only`。若目录存在但不是该仓库，停止并询问我。否则，将 `https://github.com/LQ458/omp-console.git` 克隆到该目录。
6. 从仓库安装。
   - Windows PowerShell：运行 `.\scripts\install.ps1 -DryRun`，先和我一起检查输出，再运行 `.\scripts\install.ps1`。若 PowerShell 因执行策略阻止未签名脚本，请给我 `powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1`，等待我同意并运行。
   - macOS：运行 `./scripts/install.sh --launchd`。
   - 使用 systemd 用户服务的 Linux：运行 `loginctl enable-linger "$USER"`。若失败，请给我 `sudo loginctl enable-linger "$USER"` 并等待我自己运行。之后运行 `./scripts/install.sh --systemd`。
   - 没有 systemd 用户服务的 Linux：运行 `./scripts/install.sh --plain`。把它打印的准确启动命令告诉我；我会在另一个终端中运行，并保持该窗口打开。
7. 验证服务。Windows 运行 `omp-console status`；macOS/Linux 运行 `~/.local/bin/omp-console status`。输出必须说明服务正在响应。否则，向我展示 `omp-console logs` 或 `~/.local/bin/omp-console logs` 的近期输出；先删除任何看起来像秘密的信息，然后停止。
8. 最后给我一份简短总结：
   - Bun、omp 版本和 omp-console 的提交号（Windows 使用 `git -C "$HOME\omp-console" log -1 --format=%h`；macOS/Linux 使用 `~/omp-console`）。
   - 如何打开 omp-console：Windows PowerShell 运行 `omp-console open`；macOS/Linux 运行 `~/.local/bin/omp-console open`。打开链接并点击 **Pair this browser**。页面地址为 `http://127.0.0.1:7490`。
   - 如果 omp 尚未登录模型提供商，告诉我由我自己启动 omp、输入 `/login`、选择提供商、在浏览器中批准登录、退出 omp，然后重新加载 omp-console。不要替我操作登录。
   - 如何更新和卸载。Windows：依次运行 `Set-Location "$HOME\omp-console"`、`git pull` 和 `.\scripts\install.ps1`；若我此前设置了 `-AllowHost` 和 `-Owner`，更新时使用相同参数。然后运行 `.\scripts\install.ps1 -Uninstall`。macOS/Linux：运行 `cd ~/omp-console`，使用相同服务选项重新运行 `./scripts/install.sh`；卸载时运行 `./scripts/install.sh --uninstall`。
   - 可选桌面应用和手机访问：指给我看 docs/zh-CN/INSTALL.md 中对应部分，不要替我设置。
````

## 智能体会做什么、不会做什么

| 会做 | 不会做 |
|---|---|
| 检查 Git、Bun 和 omp；征得同意后安装缺少的工具 | 未经询问使用 `sudo` |
| 将 omp-console 下载到 `~/omp-console` 并运行安装程序 | 读取或打印密钥、token 或 omp 设置 |
| 启动后台服务并检查它是否响应 | 替你登录模型提供商 |
| 告诉你需要点击什么，以及如何更新或卸载 | 将 omp-console 暴露到你的网络或互联网 |

遇到问题时，智能体应停止并展示错误。常见问题见[故障排除](INSTALL.md#troubleshooting)。连接浏览器后，继续阅读[入门指南](GETTING-STARTED.md)。
