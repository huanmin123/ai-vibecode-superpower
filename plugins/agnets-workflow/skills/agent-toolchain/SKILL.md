---
name: agent-toolchain
description: 在开发任务中使用、接入、诊断或维护项目级 CodeGraph 与 RTK。适用于跨模块依赖、调用链和影响范围分析，需要压缩只读高输出命令，或用户明确要求配置、安装、检查或修复这些工具时。
---

# Agent Toolchain

使用已配置的 CodeGraph 与 RTK 完成开发任务。CodeGraph 用于理解代码关系；RTK 用于压缩适合的只读高输出命令。不要把本 skill 当作安装器设计文档或项目契约。

## 日常使用

1. 先遵守目标项目根 `AGENTS.md`。工具没有在当前 task 中可用或可用性不确定时，对大任务最多运行一次 `doctor --quick`；不要为普通任务定期健康检查。
2. 用 CodeGraph MCP 查询跨模块依赖、调用链和改动影响范围。将其结果与当前源文件、`rg`、未跟踪文件和刚修改文件交叉核实；索引结果不能替代源码证据。
3. 对只读且输出量大的命令，使用匹配的 RTK 子命令。常见的包括 `git`、`rg`、`log`、`diff`、`test`、`mvn`、`npm`、`pnpm`、`read`、`find`、`ls`、`tree`。未列出的只读命令先用 `rtk rewrite` 或 `rtk --help` 核实；精确排障和所有写操作继续使用原生命令。
4. 只有工具注册表或 `--help` 未列出目标命令时，才能判定该命令不存在。其他工具错误必须保留原始输出并按诊断流程处理。

## 常态边界

- 只用本 skill 的平台驱动管理工具链；不要运行项目内同名脚本或供应商 installer。
- 不自动升级工具，不执行 `codegraph install` 或 `rtk init`，也不安装 npm 上同名 `rtk` 包。
- CodeGraph MCP 会自动同步文件变化；仅在诊断已证明异常时同步索引一次。
- 接入后的 MCP 配置通常需要新建 Codex task 或重启客户端才能加载。

## 按需资料

- 首次接入、安装、修复缺失工具或审查升级：读取 [`references/install.md`](references/install.md)。
- 工具报错、索引异常、健康检查、同步或 RTK 回滚：读取 [`references/diagnose-and-maintain.md`](references/diagnose-and-maintain.md)。
