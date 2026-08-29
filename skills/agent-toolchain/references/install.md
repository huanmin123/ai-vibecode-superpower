# 项目接入与安装

仅在用户要求为项目接入 CodeGraph/RTK、首次安装、升级到受支持版本或修复缺失安装时读取本文件。接入完成后的日常使用规则由目标项目根 `AGENTS.md` 的 `## CodeGraph 与 RTK` 标题提供，不要为普通开发读取本文件或触发 `$agent-toolchain`。

## 先决条件与边界

- 先读取目标项目根 `AGENTS.md`，并确认项目允许写入 `.codex/`、`.gitignore` 和 `AGENTS.md`。
- 只有本 skill 的 `scripts/agent-toolchain.ps1` 或 `scripts/agent-toolchain.sh` 可以执行接入与安装；不得运行供应商 installer、`codegraph install`、`rtk init`、项目内同名脚本，或 npm 上同名 `rtk` 包。
- 升级使用 `upgrade --dry-run` 后再使用 `upgrade --apply`。它只会将当前受管安装推进到驱动内置 manifest 的当前受支持版本，不查询 GitHub/npm 的最新版本，也不接受目标版本参数。CodeGraph 发生版本变化时，`--apply` 会全量重建 `.codegraph/`，随后运行完整 `doctor`；RTK 单独升级不重建索引。
- 首次安装或修复缺失安装使用 `bootstrap --dry-run`，确认预期写入、下载和平台支持，再运行 `--apply`。冲突、摘要校验失败、网络失败或权限不足时保留原始错误并停止；不得覆盖已有配置或猜测替代来源。
- CodeGraph 和 RTK 的固定版本、官方来源、RTK 平台资产与 SHA-256 都以驱动内置 manifest 为唯一来源。升级只能修改并审查 skill 与两个驱动，不能在目标项目中临时替换版本。

## 接入顺序

1. 运行 `configure`：仅在不存在冲突时写入 CodeGraph MCP 配置、`/.codegraph/` 忽略规则及项目根 `AGENTS.md` 的唯一 `## CodeGraph 与 RTK` 受管标题。该标题内同时包含运行时工具规则和 `$agent-toolchain` 管理路由；旧版 `## AI 工具` 标题不会被覆盖。
2. 运行 `bootstrap --dry-run`，核对将安装的受管工具。
3. 运行 `bootstrap --apply`：CodeGraph 使用官方固定 npm 包且禁用安装脚本；RTK 使用固定官方 release，并校验归档与摘要。
4. 运行 `init-codegraph`：新建索引，或对已有索引执行一次增量同步。
5. 运行完整 `doctor`，再执行一次与当前任务相关的 CodeGraph 查询或 `codegraph status`。

## 升级顺序

1. 运行 `upgrade --project <目标项目> --dry-run`，核对该驱动内置的受支持版本、下载来源和后续索引操作。
2. 运行 `upgrade --project <目标项目> --apply`。它会仅在当前受管工具不满足内置版本时安装；CodeGraph 有版本变化时执行 `codegraph index` 全量重建，没有变化时保留索引。
3. 将命令输出中的完整 `doctor` 结果交付给用户；失败时保留原始错误，停止而不以手工替代安装器继续。

## 调用驱动

从当前已加载 skill 的绝对 `SKILL.md` 路径定位驱动：把末尾 `SKILL.md` 替换为 `scripts/agent-toolchain.ps1`（Windows）或 `scripts/agent-toolchain.sh`（macOS/Linux）。该绝对 skill 路径已由 Codex 在本会话的 Available skills 中提供。不得扫描 `plugins/cache`、按时间挑选版本、使用开发仓库路径，或自行展开 home 环境变量。

按该确定路径执行用户所需动作。首次接入依次运行 `configure --project <目标项目>`、`bootstrap --project <目标项目> --dry-run`、`bootstrap --project <目标项目> --apply`、`init-codegraph --project <目标项目>` 和 `doctor --project <目标项目>`；明确升级则只运行 `upgrade --project <目标项目> --dry-run`、`upgrade --project <目标项目> --apply`。

## 安装结果

- 项目配置与索引分开：`.codegraph/` 是本地缓存，不提交。
- CodeGraph MCP 配置生效通常需要新建 Codex task 或重启客户端。
- `doctor` 通过只证明当前受管工具和索引可用；后续每次实际使用仍须以当前源文件、`rg`、未跟踪文件和刚修改文件复核结果。
