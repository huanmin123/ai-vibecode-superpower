# Codex 终端契约

本文件补充 Codex 终端工具的调用约定。通用命令约定和平台文档见[系统命令索引](system/README.md)。

- Codex 配置中的 `desktop.integratedTerminalShell = "powershell"` 是产品枚举值，不改成 `pwsh`。
- 终端工具的 `workdir` 只接收已存在的绝对目录。命令需要指定工作目录时，先核实路径，再通过这个工具参数传入。
- 在 PowerShell 中读取全局文档时，使用已验证的工作目录和 `Get-Content -LiteralPath <文档绝对路径> -Raw`。涉及写入或外部操作时，将前置读取与操作分开，除非命令本身需要前置输出。
- Windows 上遇到目录错误 `267` 或命令因目录问题未能启动时，按 [Windows 环境约定](system/windows.md#默认环境)核对工作目录。
- Codex 终端出现 `Io` 或退出码 `-1` 且命令未开始执行时，先重新核对工具调用的 `workdir`；只有后续证据支持时，才能断言是文档路径、工具解析或远端系统的原因。
