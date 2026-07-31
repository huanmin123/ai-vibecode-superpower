# Codex 全局配置安装包

本仓库用于把一套通用的 Codex 行为规范、系统命令文档和技能安装到用户级 Codex 配置目录。它不安装 Codex CLI 或桌面应用本身。

## 安装

Windows（PowerShell 7）：

```powershell
& .\install-codex.ps1
```

macOS 或 Linux：

```sh
sh ./install-codex.sh
```

安装目录优先使用非空的 `CODEX_HOME`；未设置时使用当前用户的 `~/.codex`。两个脚本都会：

1. 校验本仓库中的来源文件。
2. 将 `AGENTS.md`、合并后的 `config.toml`、完整 `docs/` 目录、九个受管理 agent role 和每个受管理 skill 全部生成到安装暂存目录。
3. 在写入任一受管理目标前，校验全部目标与备份目录的类型和符号链接安全性、用户 role 是否占用保留的 `avsp_` 名称，以及现有 `config.toml` 是否处于可安全合并的 TOML 子集。
4. 将每个已有受管理目标整体移动到 `<CODEX_HOME>/backups/` 下的同一个唯一目录，再安装全部候选；只替换 `<CODEX_HOME>/agents/ai-vibecode-superpower/`，不会替换或删除 `<CODEX_HOME>/agents/` 中的用户 role；`<CODEX_HOME>/skills/` 中的未管理 skill 也不移动、不删除也不备份。
5. 任一步失败时，删除已安装的新目标并继续尝试恢复所有已备份的旧目标；恢复失败时保留备份目录并报告失败目标。

脚本不会安装或升级 Codex，也不会读取、输出或复制认证信息。macOS/Linux 安装需要已在 `PATH` 中的 `rg`，用于安全扫描已有 user role；缺失时会在写入前停止。Windows 脚本拒绝穿过符号链接或目录联接的 `CODEX_HOME` 路径；两种脚本都会阻止同一目标目录的并发安装。macOS/Linux 使用内核 advisory lock；`.install.lock` 是可长期保留的普通锁文件，文件存在不表示有正在运行的安装。

安装器只会自动合并没有多行字符串、跨行 value、歧义 table header 或受管理键 quoted/dotted 写法的 `config.toml`；普通 table、带引号的项目表头和不触及受管命名空间的 array table 会原样保留。遇到无法证明无损改写边界的高级 TOML 形式时会在任何备份或目标替换前停止，并报告 `unsupported TOML syntax for safe merge`；它不会猜测受管语义或损坏现有配置。

如果需要更加节省token那么需要在目标项目中使用 工具安装skill: `agent-toolchain`  直接在对话中说： 使用 `$agent-toolchain` 给我安装工具  安装完毕后啥也不需要管会全自动使用。

## 目录树

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

## 文件与模块说明

| 路径 | 作用 | 安装位置 |
| --- | --- | --- |
| `install-codex.ps1` | Windows PowerShell 安装入口 | 不安装，直接运行 |
| `install-codex.sh` | macOS/Linux POSIX shell 安装入口 | 不安装，直接运行 |
| `codex-global-config/AGENTS.md` | 全局 Codex 工作规范和命令路由规则 | `<CODEX_HOME>/AGENTS.md` |
| `codex-global-config/agents/ai-vibecode-superpower/` | 九个固定模型与推理强度的命名 agent role | `<CODEX_HOME>/agents/ai-vibecode-superpower/` |
| `codex-global-config/agents/ai-vibecode-superpower.sha256` | 受管理 role 的内容完整性清单，安装时校验 | 不安装 |
| `codex-global-config/config.toml` | 主模型、推理强度和 agent 功能配置模板 | 合并到 `<CODEX_HOME>/config.toml` |
| `codex-global-config/docs/` | 系统、Shell、SSH、ripgrep 等通用操作规范 | `<CODEX_HOME>/docs/` |
| `skills/` | 可复用 Codex skills 的根目录 | `<CODEX_HOME>/skills/` |
| `skills/gpt-image-2-cli/` | 使用当前 Codex 配置调用 `gpt-image-2` 的图片生成辅助工具 | `<CODEX_HOME>/skills/gpt-image-2-cli/` |
| `skills/orchestrate-model-workflow/` | 按风险把设计、实现、审查和修复路由到合适模型的工作流 | `<CODEX_HOME>/skills/orchestrate-model-workflow/` |
| `skills/project-doc-planner/` | 规划项目文档架构、开发规范和环境资源边界 | `<CODEX_HOME>/skills/project-doc-planner/` |
| `skills/agent-toolchain/` | 受控安装、初始化、诊断和维护 CodeGraph/RTK 工具链 | `<CODEX_HOME>/skills/agent-toolchain/` |

### 主控模型

运行安装脚本会将用户级 Codex 默认主控设置为 `gpt-5.6-terra` / `xhigh`。该设置用于后续任务的默认主控模型；安装完成后请重启 Codex 相关程序让新进程加载最新配置。

`codex-global-config/` 是来源目录；安装时它不会原样复制，其中的 `AGENTS.md`、`config.toml`、`docs/` 和 `agents/ai-vibecode-superpower/` 会分别写入 Codex 全局目录。`config.toml` 仅更新本仓库管理的六个键：`model`、`model_reasoning_effort`、`agents.max_threads`、`agents.max_depth`、`features.js_repl` 和 `features.goals` 并保留其他设置。安装成功证明文件已安全落盘，不证明当前 provider 支持所有固定模型；协调者以实际 `spawn_agent(agent_type=...)` 调用和已安装 profile 记录 role、声明的模型/推理强度与读写边界，不要求子 agent 自报它可能无法观察到的运行时模型元数据。高风险、不可逆、生产、权限或外部写入前，任一后续必需 role 无法启动即停止；唯一例外是已通过本地检查的 Sol 调用收到对应 `gpt-5.6-sol` 的结构化 `unsupported_model` 或 `model_not_found`，此时可由只读 `avsp_terra_xhigh_readonly` 完成同一阶段，并记录模型独立性降低。本地可回滚任务在实际需要时启动独立复审，不以子 agent 的身份自报作为预写入门槛。

## AI 读取与维护顺序

日常任务由已安装的 `AGENTS.md` 作为行为入口；只有在需要执行系统命令时，再按任务读取对应的 `docs/system/` 文档。使用某项能力时，先读该 skill 的 `SKILL.md`，再仅在任务命中时加载其 `references/`。这样避免把完整参考树和重复规则塞入每个任务上下文。

维护本仓库时，`codex-global-config/AGENTS.md` 只保留跨项目的稳定行为边界，`codex-global-config/docs/` 只保留系统操作规范，`skills/*/SKILL.md` 只保留触发、路由和执行约束；临时任务状态由任务清单和目标工具维护。只有仓库已提供可提交的计划位置时，才保存设计、计划或复审记录；不要重新创建被忽略的 `.codex/` 目录。

## 覆盖与恢复

每次安装会替换目标中的 `AGENTS.md`、合并后的 `config.toml`、完整 `docs/` 目录、`agents/ai-vibecode-superpower/` 和本仓库管理的 skill。只要其中任一目标已存在，安装器就会创建 `<CODEX_HOME>/backups/<时间戳-唯一标识>/`，并在其中按原始相对路径保存全部旧目标，例如 `config.toml`、`docs/`、`agents/ai-vibecode-superpower/` 和 `skills/<skill-name>/`。安装成功后该备份保留，便于人工恢复；安装失败时，安装器会删除本次已安装的候选并恢复旧目标。安装器只会在它本次创建且仍为空时删除父 `agents/` 目录，因此 `agents/user-role.toml` 等未受管 role 不受影响。若某个恢复操作失败，脚本仍会继续恢复其余目标、返回失败，并保留备份目录。未管理 skill 不受影响。
