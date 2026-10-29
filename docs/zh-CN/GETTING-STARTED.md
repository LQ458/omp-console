# omp-console 入门

安装完毕后，按本指南连接浏览器、在项目文件夹中启动会话，并找到以前的工作。安装步骤见[安装指南](INSTALL.md)。

## 1. 打开页面并连接浏览器

在运行 omp-console 的电脑上打开 `http://127.0.0.1:7490`。如果安装程序没有自动打开连接页面，请使用[日常使用](INSTALL.md#everyday-use)中的 `open` 命令。

在连接页面点击 **Pair this browser（连接此浏览器）**，授权当前浏览器使用本机服务。除非按[连接手机](INSTALL.md#connect-your-phone)设置私有 Tailscale 网络，否则请只在这台电脑上使用该页面。

## 2. 查看引导

首次访问时，按五步引导了解主要界面。以后可从 **Settings（设置） → Show tour（显示导览）**重新播放。

主页上的清单会检查 omp、模型登录、以前的 omp 会话和 Claude Code 历史记录。如果某项提示缺少内容，按页面给出的操作处理。开始工作会话前，必须先在 omp 中登录模型提供商。

## 3. 启动第一个会话

1. 点击会话列表顶部的 **+**（New session，新建会话）。
2. 点击 **Recent projects（最近的项目）**里以前用过的文件夹，或点击 **Browse folders（浏览文件夹）**查找其他文件夹。请选择包含项目文件的文件夹，也就是你在 VS Code 里会打开的那个文件夹。进入该文件夹后，点击 **Start in "<文件夹名>"**（在此文件夹开始）。需要新建时点击 **New folder（新建文件夹）**；知道完整路径时点击 **Type a path（输入路径）**。
3. 在消息框中写下一项明确任务并发送，例如请 omp 解释某个文件，或完成一项具体修改。

会话会在选定的项目文件夹中运行。omp-console 不会复制你的项目。

## 4. 查看、调整或停止任务

在会话中查看对话和运行状态。需要改变方向或补充信息时，在消息框中再发一条消息。要中断正在进行的工作，请在会话控件中点击 **Stop（停止）**。先阅读 omp 的回复，再提出下一项修改。

## 5. 找到以前在终端中的会话

在终端里开始的会话会出现在会话列表中，并标有 **From terminal（来自终端）**；主页清单里 **Existing omp sessions（已有的 omp 会话）**这一行的 **Open sessions（打开会话）**按钮也会列出它们。选中后会打开一个副本。提示文字是：“Opens a copy; the terminal session is unchanged.”（打开副本；终端中的会话保持不变。）原终端会话文件不会被修改。

## 6. 导入 Claude Code 历史记录

在主页清单中找到 **Claude Code history（Claude Code 历史记录）**，点击 **Open Claude Code import（打开 Claude Code 导入）**。也可以在 **Settings** 中打开 **Import from Claude Code（从 Claude Code 导入）**。选择要导入的对话，点击 **Import selected（导入所选）**并等待结果。导入后，点击对话旁的 **Open（打开）**，即可在 omp 中继续。

导入器会读取运行服务的电脑上的 Claude Code 文件。如果没有找到历史记录，请先在这台电脑上启动 Claude Code，再刷新导入面板。导入会在 omp 中创建副本，不会修改或删除 Claude Code 原始记录。连接到此服务的浏览器可以查看导入内容；如果服务由多人共用，请勿导入不应与他们共享的对话。更多信息见[从 Claude Code 或 Codex 迁移](../migrating-from-claude-code.md)。

## 7. 连接手机

在电脑和手机上安装 Tailscale，并在两台设备上登录同一账户。按[连接手机](INSTALL.md#connect-your-phone)中的步骤允许电脑的 Tailscale 名称并运行 Tailscale Serve。在电脑上打开 **Settings（设置） → Devices（设备） → Pair another device（配对另一台设备）**并申请连接码。然后在手机上打开打印出的 HTTPS 地址，使用该连接码点击 **Pair this browser（连接此浏览器）**。

不要使用 Tailscale Funnel 或公开反向代理。此服务可以在安装它的电脑上运行命令。
