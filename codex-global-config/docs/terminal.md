# Codex 终端契约

本文件是 Codex 专属的终端调用补充，随全局文档安装到 `<CODEX_HOME>/docs/`；平台无关的 Windows、PowerShell 与跨平台命令规范由 [系统执行规范](system/README.md) 路由的共享文档提供。

- Codex 配置中的 `desktop.integratedTerminalShell = "powershell"` 是产品枚举值，不改成 `pwsh`。
- 终端调用的 `workdir` 必须是已存在的绝对目录；仅在命令需要指定目录或工具返回目录无效时，用 `Test-Path -LiteralPath <目录> -PathType Container` 或 `Resolve-Path -LiteralPath <目录>` 核实。文件路径、文档路径和命令文本都不能作为 `workdir`。
- `workdir` 是终端工具的调用参数，不属于 PowerShell 命令。读取全局文档时使用已验证的工作目录和 `Get-Content -LiteralPath <文档绝对路径> -Raw`；涉及写入或外部操作时，将前置读取与操作分开，除非命令本身需要前置输出。
- 出现 `Io`、退出码 `-1` 或 Windows 错误 `267`（目录名称无效）而命令未开始执行时，先重新核对工具调用的 `workdir`；只有后续证据支持时，才能断言是文档路径、工具解析或远端系统的原因。
