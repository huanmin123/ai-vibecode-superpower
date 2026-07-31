---
name: agent-toolchain
description: 受控安装、初始化、诊断和维护项目级 CodeGraph 与 RTK。用户要求接入、安装、维护或验证这些工具时使用。
---

# Agent Toolchain

这是 CodeGraph/RTK 的全局可信生命周期控制器。项目只保存 MCP 配置、索引忽略规则和极短的根 `AGENTS.md` 路由，不保存锁文件、可执行脚本或工具说明文档。

## 执行边界

- 先读取 `references/project-contract.md`，再读取目标项目根 `AGENTS.md`；不执行项目内同名脚本。
- 只调用本 skill 的 `scripts/agent-toolchain.sh` 或 `agent-toolchain.ps1`。CodeGraph 固定为官方 npm 包 `@colbymchenry/codegraph@1.5.0`，RTK 固定为 `0.44.1` 官方 release；升级只能通过审查后的 skill 变更完成。
- 不运行供应商 installer，不执行 `codegraph install` 或 `rtk init`；由 AI 写入最小项目配置。CodeGraph 的 npm 包不运行安装脚本，且安装后须验证固定版本和命令入口。
- CodeGraph 需要可执行的 `node` 与 `npm`，但不人为限制 Node 版本。RTK 没有官方 npm 包；不得安装 npm 上的同名 `rtk` 或其他非官方包，继续使用固定 SHA-256 的官方 release。
- 受支持平台为 macOS/Linux arm64/x64 与 Windows x64；Windows arm64 因 RTK 无官方资产而拒绝整套安装。
- CodeGraph 使用用户现有 npm registry/代理配置，默认限制单次拉取为 90 秒并有限重试（保留用户显式 npm 配置）；RTK 下载按 `AGENT_TOOLCHAIN_PROXY`、`HTTPS_PROXY`/`ALL_PROXY` 和平台代理顺序自动选择，记录来源但不输出地址。无代理时明确提示直连与超时，失败后停止，不会无限等待。

## 首次接入

1. 运行 `configure`。它只会保留或写入 `.codex/config.toml` 的 CodeGraph MCP、根 `.gitignore` 的 `/.codegraph/`，以及根 `AGENTS.md` 的两条 AI 路由；已有冲突时停止，不覆盖用户配置。
2. 运行受信执行器的 `bootstrap --dry-run`、`bootstrap --apply`。CodeGraph 通过受管用户 npm 全局前缀安装，并由稳定入口暴露；RTK 通过固定 release 安装和校验。用户不需要设置维护命令或手动编辑 PATH。
3. 运行 `init-codegraph`。没有索引时建立索引；已有索引时自动执行一次增量同步。最后运行完整 `doctor`、`codegraph status` 和一个可核对查询。

macOS/Linux：

```sh
driver="${CODEX_HOME:-$HOME/.codex}/skills/agent-toolchain/scripts/agent-toolchain.sh"
"$driver" configure --project "$PWD"
"$driver" bootstrap --project "$PWD" --dry-run
"$driver" bootstrap --project "$PWD" --apply
"$driver" init-codegraph --project "$PWD"
"$driver" doctor --project "$PWD"
```

Windows PowerShell 7：

```powershell
$codexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME '.codex' }
$driver = Join-Path $codexHome 'skills/agent-toolchain/scripts/agent-toolchain.ps1'
& $driver configure --project $PWD
& $driver bootstrap --project $PWD --dry-run
& $driver bootstrap --project $PWD --apply
& $driver init-codegraph --project $PWD
& $driver doctor --project $PWD
```

## 日常行为

- 复杂重构、跨模块理解、架构分析和大范围排障前，AI 每个任务最多运行一次 `doctor --quick`；失败时自动按结果修复或初始化，不要求用户输入维护命令。
- CodeGraph MCP 启动后会监听文件变更并自动同步，重新连接也会补齐离线修改。不要按固定周期运行 `maintain --sync`；仅当 `doctor`、MCP 结果或 `codegraph status` 明确显示异常时，自动运行一次恢复同步并复用结果。
- CodeGraph 结果必须和当前源文件、`rg` 及未跟踪/刚修改文件交叉核实。RTK 只压缩已验证的只读高输出命令，不执行安装、升级、提交、发布、部署、迁移、权限、密钥或破坏性操作。
- 不自动升级工具。MCP 配置变更后通常需要新建 Codex task 或重启客户端才能加载。
