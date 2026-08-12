---
name: agent-toolchain
description: 为目标项目受控接入、修复或维护 CodeGraph 与 RTK；在写入项目配置、安装受管版本、重建索引、审查升级或回滚时使用。
---

# 项目工具链接入与维护

`$agent-toolchain` 是 CodeGraph/RTK 的项目接入和维护入口，不是日常开发分析 skill。`configure` 会在目标项目根 `AGENTS.md` 写入唯一的 `## CodeGraph 与 RTK` 受管标题；该标题同时说明日常可用的工具规则和需要本 skill 的管理操作。接入后，日常开发直接遵守目标项目 `AGENTS.md`，不要为普通查询或命令压缩触发本 skill。

仅在用户明确要求以下状态变更或维护时使用：项目接入、安装、配置修复、索引初始化或修复、健康检查、升级审查或回滚。不要因发现 CodeGraph/RTK 可用于当前开发任务而自行接入、升级或维护。

## 接入与维护边界

1. 先读取目标项目根 `AGENTS.md`，确认用户授权当前写入或维护操作。只用本 skill 的平台驱动；不要运行项目内同名脚本、供应商 installer、`codegraph install`、`rtk init` 或 npm 上同名 `rtk` 包。
2. 首次接入或修复配置时先执行 `configure`。它仅在没有冲突时写入 CodeGraph MCP 配置、`/.codegraph/` 忽略规则和一个完整的 `## CodeGraph 与 RTK` 标题；已有标题被改写、缺项或来自旧版 `## AI 工具` 注入时停止并报告，不覆盖项目规则。
3. 安装或升级前先运行 `bootstrap --dry-run`，确认预期下载和写入后才执行 `--apply`。固定版本、来源和 SHA-256 只能来自驱动内置 manifest；不自动升级。
4. 接入完成后初始化或同步索引并运行完整 `doctor`。CodeGraph MCP 配置通常需要新建 Codex task 或重启客户端才能加载。
5. 只有明确的故障、健康检查、索引异常或回滚任务才运行诊断与维护命令；不要为普通开发定期检查或同步。

## 按需资料

- 首次接入、安装、修复缺失工具或审查升级：读取 [`references/install.md`](references/install.md)。
- 工具报错、索引异常、健康检查、同步或 RTK 回滚：读取 [`references/diagnose-and-maintain.md`](references/diagnose-and-maintain.md)。
