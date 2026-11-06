# 项目接入与安装

仅在用户要求为项目接入 CodeGraph/RTK、首次安装、升级到受支持版本或修复缺失安装时读取本文件。接入完成后的日常使用规则由目标项目根 `AGENTS.md` 的 `## CodeGraph 与 RTK` 标题提供，不要为普通开发读取本文件或触发 `agent-toolchain` skill。

## 先决条件与边界

- 先读取目标项目根 `AGENTS.md`，并确认项目允许写入要接入客户端的配置目录（Codex 为 `.codex/`，ZCode 为 `.zcode/`）、`.gitignore` 和 `AGENTS.md`。
- 只有本 skill 的 `scripts/agent-toolchain.ps1` 或 `scripts/agent-toolchain.sh` 可以执行接入与安装；不得运行供应商 installer、`codegraph install`、`rtk init`、项目内同名脚本或 npm 上同名 `rtk` 包。
- 升级使用 `upgrade --dry-run` 后再使用 `upgrade --apply`。它只会将当前受管安装推进到驱动内置 manifest 的当前受支持版本，不查询 GitHub/npm 的最新版本，也不接受目标版本参数。CodeGraph 发生版本变化时，`--apply` 会全量重建 `.codegraph/`，随后运行完整 `doctor`；RTK 单独升级不重建索引。
- 首次安装或修复缺失安装使用 `bootstrap --dry-run`，确认预期写入、下载和平台支持，再运行 `--apply`。冲突、摘要校验失败、网络失败或权限不足时保留原始错误并停止；不得覆盖已有配置或猜测替代来源。
- CodeGraph 和 RTK 的固定版本、官方来源、平台资产与 SHA-256 都以驱动内置 manifest 为唯一来源。升级只能修改并审查 skill 与两个驱动，不能在目标项目中临时替换版本。
- 网络代理异常时，可用 `AGENT_TOOLCHAIN_PROXY=direct` 强制直连；显式代理用 `AGENT_TOOLCHAIN_PROXY=<scheme://host:port>`。该设置只影响本次下载，不写入项目配置。

## 接入顺序

1. 运行 `configure`：仅在不存在冲突时写入 CodeGraph 的 MCP 配置（Codex 写入 `.codex/config.toml` 的 `[mcp_servers.codegraph]`，ZCode 写入 `.zcode/config.json` 的 `mcp.servers`）、`/.codegraph/` 与所接入客户端目录（Codex 为 `/.codex/`，ZCode 为 `/.zcode/`）的忽略规则及项目根 `AGENTS.md` 的唯一 `## CodeGraph 与 RTK` 受管标题。客户端按项目现有 `.codex/`、`.zcode/` 目录自动探测，两者都有则都接入；都未探测到时，交互终端由驱动询问用户，非交互调用必须传 `--client codex|zcode|both`（按当前会话宿主选择，不确定时先询问用户）。该标题内同时包含运行时工具规则和 `agent-toolchain` 管理路由；旧版 `## AI 工具` 标题不会被覆盖。已有 `## CodeGraph 与 RTK` 段落不会被逐字覆盖；缺 v4 标记时 `configure` 会提示 AI 按 `references/managed-agents-block.md` 重写该段。
2. 运行 `bootstrap --dry-run`，核对将安装的受管工具。
3. 运行 `bootstrap --apply`：CodeGraph 使用官方固定 npm 包且禁用安装脚本；RTK 使用固定官方 release 归档，并校验摘要与二进制架构。
4. 运行 `init-codegraph`：新建 CodeGraph 索引，或对已有索引执行一次增量同步。
5. 运行完整 `doctor`，再执行一次与当前任务相关的 CodeGraph 查询或 `codegraph status`。

## 旧受管段落更新（AI 直接改写）

`configure` 不逐字替换已有 `## CodeGraph 与 RTK` 段落；它只校验/合并 MCP 配置。段落不是当前模板时，由 AI 直接改写：

1. 读取 `references/managed-agents-block.md`。
2. 读取目标 `AGENTS.md` 的当前段落和项目特定补充。
3. 先把 `AGENTS.md` 备份到 `<项目>/.zcode/backups/`；仅接入 Codex 时备份到 `.codex/backups/`。
4. 用编辑工具重写该段，保留项目特定内容和 `<!-- agent-toolchain-managed:v4 -->` 标记。
5. 重新运行 `configure`；缺标记时它只提示，不会替换内容。

旧版 `## AI 工具` 标题仍由 AI 人工迁移；不要用脚本硬替换受管段落。

## 升级顺序

1. 运行 `upgrade --project <目标项目> --dry-run`，核对该驱动内置的受支持版本、下载来源和后续索引操作。
2. 运行 `upgrade --project <目标项目> --apply`。它会仅在当前受管工具不满足内置版本时安装；CodeGraph 有版本变化时执行 `codegraph index` 全量重建，没有变化时保留索引。
3. 将命令输出中的完整 `doctor` 结果交付给用户；失败时保留原始错误，停止而不以手工替代安装器继续。

## 调用驱动

从当前已加载 skill 的绝对 `SKILL.md` 路径定位驱动：把末尾 `SKILL.md` 替换为 `scripts/agent-toolchain.ps1`（Windows）或 `scripts/agent-toolchain.sh`（macOS/Linux）。该绝对 skill 路径由当前会话的 skill 清单提供。不得扫描 `plugins/cache`、按时间挑选版本、使用开发仓库路径，或自行展开 home 环境变量。

按该确定路径执行用户所需动作。首次接入依次运行 `configure --project <目标项目>`（客户端无法自动探测时追加 `--client codex|zcode|both`，按当前会话宿主选择）、`bootstrap --project <目标项目> --dry-run`、`bootstrap --project <目标项目> --apply`、`init-codegraph --project <目标项目>` 和 `doctor --project <目标项目>`；明确升级则只运行 `upgrade --project <目标项目> --dry-run`、`upgrade --project <目标项目> --apply`。

## 安装结果

- 新接入项目的受管段落按问题类型分流：纯文本、日志、配置和已知文件先用 `rg`/原生读取，CodeGraph 只用于需要代码结构探索或全链路关系（符号、调用链、依赖、影响面）且 `rg` 容易漏的情况；RTK 是防止大日志/大输出撑爆上下文的安全阀，不作为省 token 的默认方案，采用白名单：只为 `test`、`build`、`git log` 等长输出命令开启过滤，`git diff` 和简单命令走原生，过滤丢信息时用原生重跑；单文件局部修复、文档和低风险整理不强制走两者。具体边界以驱动生成的受管段落为准。已有受管段落由 AI 按 `references/managed-agents-block.md` 直接改写，`configure` 不逐字覆盖；缺 v4 标记时只提示。
- CodeGraph 项目配置与索引均不入库：`.codegraph/` 是本地索引缓存，`.codex/`、`.zcode/` 是本机客户端目录；`configure` 会把对应忽略规则写入项目 `.gitignore`。
- CodeGraph 的 MCP 配置生效通常需要新建会话或重启对应客户端。ZCode 若在 Settings → MCP 显示 codegraph 为 untrusted，先在客户端信任/连接；这是客户端状态，安装器写配置文件不能替代。
- `doctor` 通过只证明当前受管工具和索引可用；后续每次实际使用仍须以当前源文件、`rg`、未跟踪文件和刚修改文件复核结果。
