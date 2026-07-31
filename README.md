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
2. 将 `AGENTS.md`、合并后的 `config.toml`、完整 `docs/` 目录和每个受管理 skill 全部生成到安装暂存目录。
3. 在写入任一受管理目标前，校验全部目标与备份目录的类型和符号链接安全性。
4. 将每个已有受管理目标整体移动到 `<CODEX_HOME>/backups/` 下的同一个唯一目录，再安装全部候选；`<CODEX_HOME>/skills/` 中的未管理 skill 不移动、不删除也不备份。
5. 任一步失败时，删除已安装的新目标并继续尝试恢复所有已备份的旧目标；恢复失败时保留备份目录并报告失败目标。

脚本不会安装或升级 Codex，也不会读取、输出或复制认证信息。Windows 脚本拒绝穿过符号链接或目录联接的 `CODEX_HOME` 路径；两种脚本都会阻止同一目标目录的并发安装。

## 目录树

```text
.
├── install-codex.ps1
├── install-codex.sh
├── codex-global-config/
│   ├── AGENTS.md
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
| `codex-global-config/config.toml` | 主模型、推理强度和 agent 功能配置模板 | 合并到 `<CODEX_HOME>/config.toml` |
| `codex-global-config/docs/` | 系统、Shell、SSH、ripgrep 等通用操作规范 | `<CODEX_HOME>/docs/` |
| `skills/` | 可复用 Codex skills 的根目录 | `<CODEX_HOME>/skills/` |
| `skills/gpt-image-2-cli/` | 使用当前 Codex 配置调用 `gpt-image-2` 的图片生成辅助工具 | `<CODEX_HOME>/skills/gpt-image-2-cli/` |
| `skills/orchestrate-model-workflow/` | 按风险把设计、实现、审查和修复路由到合适模型的工作流 | `<CODEX_HOME>/skills/orchestrate-model-workflow/` |
| `skills/project-doc-planner/` | 规划项目文档架构、开发规范和环境资源边界 | `<CODEX_HOME>/skills/project-doc-planner/` |
| `skills/agent-toolchain/` | 受控安装、初始化、诊断和维护 CodeGraph/RTK 工具链 | `<CODEX_HOME>/skills/agent-toolchain/` |

### 模型协调建议

复杂任务的默认主协调模型建议使用 `Terra/high`。协调者需要完成任务分类、派发契约、风险与升级决策、结果集成和完成判断；不应为了节省成本将低能力模型用作复杂任务的协调者。仅当工作流已判定步骤完整、低风险且确定性时，才可由更简单的模型执行，且仍须按工作流接受 `Terra/high` 复核。

`codex-global-config/` 是来源目录；安装时它不会原样复制，其中的 `AGENTS.md`、`config.toml` 和 `docs/` 会分别写入 Codex 全局目录。`config.toml` 仅更新本仓库管理的六个键：`model`、`model_reasoning_effort`、`agents.max_threads`、`agents.max_depth`、`features.js_repl` 和 `features.goals`。它不会写入或覆盖 `model_provider`，并保留其他设置及 provider 定义。

## AI 读取与维护顺序

日常任务由已安装的 `AGENTS.md` 作为行为入口；只有在需要执行系统命令时，再按任务读取对应的 `docs/system/` 文档。使用某项能力时，先读该 skill 的 `SKILL.md`，再仅在任务命中时加载其 `references/`。这样避免把完整参考树和重复规则塞入每个任务上下文。

维护本仓库时，`codex-global-config/AGENTS.md` 只保留跨项目的稳定行为边界，`codex-global-config/docs/` 只保留系统操作规范，`skills/*/SKILL.md` 只保留触发、路由和执行约束；临时任务状态由任务清单和目标工具维护。只有仓库已提供可提交的计划位置时，才保存设计、计划或复审记录；不要重新创建被忽略的 `.codex/` 目录。

## 覆盖与恢复

每次安装会替换目标中的 `AGENTS.md`、合并后的 `config.toml`、完整 `docs/` 目录和本仓库管理的 skill。只要其中任一目标已存在，安装器就会创建 `<CODEX_HOME>/backups/<时间戳-唯一标识>/`，并在其中按原始相对路径保存全部旧目标，例如 `config.toml`、`docs/` 和 `skills/<skill-name>/`。安装成功后该备份保留，便于人工恢复；安装失败时，安装器会删除本次已安装的候选并恢复旧目标。若某个恢复操作失败，脚本仍会继续恢复其余目标、返回失败，并保留备份目录。未管理 skill 不受影响。
