# Codex 全局配置安装包

这个仓库为已经使用 Codex 的开发者提供一套可安装到用户级配置目录的工作环境：统一的行为规范、系统命令文档、可分工的 agent role，以及常用 skills。它帮助团队把重复的执行约定和复杂任务的工作方式沉淀下来，而不是每个项目、每次对话都从头约定。

它不安装或升级 Codex CLI，也不安装 Codex 桌面应用。

## 你会得到什么

| 内容 | 解决什么问题 | 为什么需要它 |
| --- | --- | --- |
| 全局行为规范与系统文档 | 约束文件操作、跨平台命令、SSH 与 `rg` 的使用方式 | 让涉及 Windows、macOS、Linux 或远程主机的任务有可核对的操作边界，降低误执行风险。 |
| 九个命名 agent role | 将探索、设计、实施、独立复审和已确认问题的修复分开 | 复杂任务由不同角色承担不同责任，避免实现结论直接充当复审结论。 |
| `orchestrate-model-workflow` | 按任务风险和阶段路由合适的 agent role | 让复杂开发有清楚的探索、实施、复审和验证顺序，而不是只依赖一次生成。 |
| `project-doc-planner` | 规划项目文档、开发规范、环境与资源边界 | 需要建立或整理项目文档体系时，先明确哪些内容应公开、应落盘或只保留在本地。 |
| `gpt-image-2-cli` | 使用当前 Codex 的认证和 provider 配置调用 `gpt-image-2` | 需要生成图像时，无须为同一套配置再手动复制 API key。 |
| `agent-toolchain` | 为另一个目标项目接入 CodeGraph 与 RTK | 当任务需要理解跨模块关系或反复读取大量只读命令输出时，减少无关信息进入 AI 上下文。详见后文。 |

## 何时值得安装

适合希望把 Codex 用于日常开发、维护多个项目，或需要稳定执行规范的个人和团队。安装后，新的 Codex task 会获得统一的工作约定、skills 和命名角色。

如果只想临时运行一个小脚本，或尚未安装和使用 Codex，本仓库不会替代 Codex 本体，也未必值得额外配置。`agent-toolchain` 更适合复杂重构、跨模块理解、架构分析、大范围排障或频繁查看大输出的项目；单文件、小型或一次性任务通常不需要先接入它。

## 安装

Windows（PowerShell 7）：

```powershell
& .\install-codex.ps1
```

macOS 或 Linux：

```sh
sh ./install-codex.sh
```

安装目录优先使用非空的 `CODEX_HOME`；未设置时使用当前用户的 `~/.codex`。安装完成后请重启 Codex 相关程序，使新进程加载更新后的配置。

### 安装过程与安全边界

安装器会先校验来源内容，再在暂存目录准备候选配置；只有全部检查通过后才写入目标目录。已有受管理内容会统一备份到 `<CODEX_HOME>/backups/` 下的唯一目录；若安装中任一步失败，安装器会尝试恢复备份。

它会安装或更新本仓库受管理的 `AGENTS.md`、合并后的 `config.toml`、`docs/`、九个 agent role 和四个 skills。它不会替换用户自有 role，也不会移动、删除或备份未受管理的 skill；不会读取、输出或复制认证信息。

为了避免不确定地改写配置，安装器只合并可安全解析的 `config.toml`。遇到多行字符串、跨行 value、歧义 table header 或受管理键的 quoted/dotted 写法等无法证明无损改写边界的输入时，会在备份和写入前停止，并报告 `unsupported TOML syntax for safe merge`。Windows 安装器拒绝穿过符号链接或目录联接的 `CODEX_HOME` 路径；macOS/Linux 安装需要 `rg` 用于安全扫描，且两种安装器都会阻止同一目标目录的并发安装。

安装会将默认主控设置为 `gpt-5.6-terra` / `xhigh`，并保留现有 `config.toml` 中未由本仓库管理的设置。安装成功只证明配置已安全写入，不能保证当前 provider 支持全部固定 role；实际任务会以可启动的 role 为准。

## 可选：为目标项目接入 CodeGraph 与 RTK

`agent-toolchain` 是给**另一个需要增强的目标项目**使用的 skill，不是本仓库已经初始化的示例。它受控地安装、初始化、诊断和维护两项工具：CodeGraph 与 RTK。

| 工具 | 它能做什么 | 它不负责什么 |
| --- | --- | --- |
| CodeGraph | 通过 MCP 提供跨模块依赖、调用链和影响范围的索引查询，帮助 AI 在大型代码库中定位相关代码。 | 它的索引不是源码事实；刚修改或未跟踪的文件仍要以当前源码和 `rg` 交叉核实。 |
| RTK | 压缩已验证的只读高输出命令结果，例如 `git`、`rg`、`log`、`diff`、`test`、`npm` 或 `pnpm`。 | 它不是安全边界，不执行写操作、部署、迁移、权限或密钥操作，也不替代需要原始输出的精确排障。 |

### 为什么它可能节省 token

大型仓库的依赖关系和只读命令输出常常很长。CodeGraph 让 AI 针对关系和影响范围查询，而 RTK 会压缩适用的只读高输出结果；因此进入模型上下文的重复路径、日志和列表可能更少。

这是一种减少输入内容的机制，不是固定的 token 节省承诺。实际收益取决于命令、输出量和任务；仓库没有提供节省比例或性能基准。复杂推理、写操作和需要完整原始输出的诊断不会因为 RTK 而自动变少或被替代。

### 如何接入

在需要接入的目标项目中，直接对 Codex 说：

> 使用 `$agent-toolchain` 给我安装工具。

skill 会按受控流程完成配置预检、安装前 dry-run、受管工具安装、索引初始化和健康检查。接入过程会：

1. 写入目标项目 `.codex/config.toml` 中的 CodeGraph MCP、根 `.gitignore` 的 `/.codegraph/`，以及根 `AGENTS.md` 的两条 AI 路由。
2. 安装并验证受管的 CodeGraph 与 RTK，然后建立或增量同步 CodeGraph 索引；`.codegraph/` 是本地缓存，不提交到版本库。
3. 运行 `doctor`、`codegraph status` 和一次可核对查询，确认工具入口和索引状态。

如果已有配置与受控内容冲突，skill 会停止，不覆盖用户内容。它需要可执行的 `node` 与 `npm`，并需要网络访问相应的软件源；会保留已有 npm registry 或代理配置。支持 macOS/Linux 的 arm64 和 x64，以及 Windows x64；Windows arm64 不支持整套工具链。

### 接入后会怎样

日常使用中，你不需要手动定期同步索引。面对复杂重构、跨模块理解、架构分析或大范围排障时，AI 会按需检查工具状态；CodeGraph MCP 会监听文件变更，并在重新连接时补齐离线修改。工具不会自动升级。

这不意味着每个任务都会调用工具，也不代表任何状态都能自动恢复。`doctor`、CodeGraph MCP 或 `codegraph status` 明确报告异常时，AI 才会执行一次相应的恢复操作。MCP 配置变更通常需要新建 Codex task 或重启客户端后才能加载。

## 目录结构

```text
.
├── install-codex.ps1
├── install-codex.sh
├── codex-global-config/
│   ├── AGENTS.md
│   ├── agents/
│   │   ├── ai-vibecode-superpower.sha256
│   │   └── ai-vibecode-superpower/
│   │       └── ai-vibecode-superpower-avsp_*.toml
│   ├── config.toml
│   └── docs/
│       ├── README.md
│       └── system/
│           ├── README.md
│           ├── windows.md
│           ├── macos.md
│           ├── linux.md
│           ├── ssh.md
│           ├── rg.md
│           └── 跨系统操作示例.md
└── skills/
    ├── gpt-image-2-cli/
    ├── orchestrate-model-workflow/
    ├── project-doc-planner/
    └── agent-toolchain/
```

## 维护者说明

`codex-global-config/` 是安装来源目录，不会原样复制：其中的 `AGENTS.md`、`config.toml`、`docs/` 与 agent role 会分别写入 Codex 全局目录。`config.toml` 只更新本仓库管理的 `model`、`model_reasoning_effort`、`agents.max_threads`、`agents.max_depth`、`features.js_repl` 和 `features.goals`，其余设置会保留。

维护本仓库时，稳定的行为边界保留在 `codex-global-config/AGENTS.md`，平台与命令规范保留在 `codex-global-config/docs/`，各 skill 的触发条件和执行约束保留在 `skills/*/SKILL.md`。不要在这个安装包仓库中重新创建被忽略的 `.codex/` 目录；需要接入 CodeGraph/RTK 的应是另一个目标项目。

安装器备份的内容包括已有的 `AGENTS.md`、`config.toml`、`docs/`、受管理 role 和受管理 skill。安装成功后备份会保留，便于人工恢复；若恢复中有单个目标失败，安装器仍会继续恢复其余目标并报告失败项。未管理 skill 始终不受影响。
