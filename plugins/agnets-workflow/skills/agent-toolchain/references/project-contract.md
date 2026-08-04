# Agent Toolchain 项目契约

## 项目侧

项目只保留以下必要内容：

- `.codex/config.toml` 中精确的 CodeGraph MCP：`codegraph serve --mcp`，并关闭 CodeGraph telemetry、更新检查和通用追踪。
- 根 `.gitignore` 中的 `/.codegraph/`；索引是缓存，不提交。
- 根 `AGENTS.md` 中四条短规则：工具链生命周期使用全局 `$agent-toolchain`；CodeGraph MCP 用于查询跨模块依赖、调用链和影响范围，处理跨模块任务时使用它；只读高输出命令使用匹配的 `rtk` 子命令（`git`、`rg`、`log`、`diff`、`test`、`mvn`、`npm`、`pnpm`、`read`、`find`、`ls`、`tree`），未知命令先用 `rtk rewrite` 或 `rtk --help` 判断，写操作和精确排障使用原生命令；工具调用报错时，只有工具注册表或 `--help` 未列出目标命令，才可判定其不存在；否则不得归因于能力缺失。

项目不得新增锁文件、工具链脚本、供应商 installer 或 README 工具说明。已有配置冲突时报告并停止，不覆盖用户内容。项目可以没有 Git；执行器只要求 `--project` 指向真实目录。

`configure --project PATH` 是唯一的项目写入入口：它幂等地写入缺少的三类内容，遇到同名但不兼容的配置立即停止。首次接入后，用户只需正常与 AI 沟通；AI 根据根 `AGENTS.md` 选择工具和自动恢复索引。

## 全局侧

CodeGraph 固定为官方 npm 包 `@colbymchenry/codegraph@1.5.0`，只要求可执行的 `node` 与 `npm`，并使用用户现有 npm registry 与代理配置安装到受管用户 npm 全局前缀。稳定入口位于受管命令目录：Windows 写入用户 `Path`；macOS 写入 shell 配置并合并当前图形会话 PATH；Linux 写入 shell 配置与用户环境文件。新开的终端或 Codex task 会读取这些路径。

RTK 固定为 `0.44.1` 官方 release，安装到 macOS/Linux 的 `~/.local/share/agent-toolchain/`（入口 `~/.local/bin/rtk`）或 Windows 的 `%LOCALAPPDATA%\agent-toolchain\bin`。RTK 没有官方 npm 包；npm 上的 `rtk` 是不同项目，禁止安装。执行器内置 RTK 各平台资产与 SHA-256，不接受 `latest` 或任意 URL；升级只能通过更新全局 skill 和两个驱动完成。

支持 macOS/Linux arm64/x64 与 Windows x64。Windows arm64 因 RTK 没有官方资产而拒绝整套安装。RTK 归档必须拒绝绝对路径、`..`、符号链接、硬链接和 Windows 重解析点，并验证目标二进制架构、版本、bundle 与下载摘要。

CodeGraph 由 npm 按固定版本安装，npm 使用其配置的 registry、代理和包完整性校验；当用户没有显式 npm 拉取配置时，执行器限制单次拉取为 90 秒、仅重试一次。执行器验证当前平台 optional package 后再运行，并通过稳定入口禁用 shim 自愈下载、遥测和更新检查。RTK 下载只访问固定 GitHub release URL 及受校验的 HTTPS release-asset 重定向。RTK 代理顺序为 `AGENT_TOOLCHAIN_PROXY`、`HTTPS_PROXY`/`ALL_PROXY`，再按平台读取系统代理；日志只显示来源，不显示地址或凭据。没有代理时提示直连 GitHub；默认连接超时 10 秒、请求超时 90 秒，可用环境变量在 1 至 300 秒内调整。

`doctor --quick` 检查全局命令与受管 RTK 的快速可用性；完整 `doctor` 额外检查 CodeGraph 索引状态。两者在工具缺失、命令不可发现或索引未初始化时必须失败，供 AI 自动继续安装、初始化或恢复。两者都不等同于自动升级。

CodeGraph 用于跨模块依赖、调用链和影响范围。MCP 启动后会监听文件变更自动同步，并在重新连接时追赶离线修改，因此不需要周期性执行 `maintain --sync`。RTK 只是只读高输出命令的压缩代理，不是安全边界，也不替代原生命令。索引与刚修改、未跟踪文件冲突时以当前源文件和 `rg` 为准。
