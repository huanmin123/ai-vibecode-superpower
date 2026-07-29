# 系统执行规范

只读取当前任务需要的文档：

- Windows 本机：[Windows 与 PowerShell 7](windows.md)
- macOS 本机或远端：[macOS](macos.md)
- Linux 本机或远端：[Linux](linux.md)
- SSH 与文件传输：[SSH](ssh.md)
- Windows 连接 macOS/Linux 的组合模板：[跨系统操作示例](跨系统操作示例.md)
- 仅当 `rg` 缺失时：[ripgrep 安装](rg.md)

## 通用规则

- 每条命令设置明确工作目录；本地与远端 Shell 语法分开构造。
- 优先项目脚本、包装器、锁文件和现有工具链，不轮流试多套命令。
- 文本搜索使用 `rg`/`rg --files`；`rg` 退出码 `0` 表示有匹配，`1` 表示无匹配，大于 `1` 才是错误。
- 原生命令检查退出码；写操作还要检查目标状态。
