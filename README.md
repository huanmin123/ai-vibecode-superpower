# ai-vibecode-superpower

## 定位与注意事项

本项目是面向 Codex 使用者的可安装配置包，提供全局规则与文档、agent role profiles，以及 `agnets-workflow` 插件和若干独立 skill。它帮助复杂开发任务建立更清晰的调查、实施和复查工作方式。

本项目不安装或升级 Codex CLI，也不安装 Codex Desktop。若已启用同类 `superpowers` 插件，请先禁用它，以避免潜在的规则冲突和额外使用成本。

## 你会得到

- 可供 Codex 使用的全局规则与跨平台文档。
- 可按任务需要使用的 agent role profiles。
- `agnets-workflow` 插件及其工作流工具与 `project-doc-planner` 项目文档规划能力。
- 独立全局 skill：`gpt-image-2-cli`。

## 适合什么时候

适合日常开发与维护，尤其是需要跨文件理解、分阶段实施、并行处理或独立复查的复杂任务。单文件、一次性的小改动通常不需要额外配置；安装完成后，直接告诉 Codex 目标、范围和限制即可。

## 成本预期

对于可拆分的复杂任务，按工作流分工相较于全程使用 `avsp_sol_high`，经验上可实现约 5 倍模型调用成本节省。这是预期而非保证或价格承诺；实际效果取决于任务规模、上下文、重试次数和人工介入程度。对于跨模块理解、大型代码库或重复探索明显的场景，叠加 `agent-toolchain` 可进一步减少重复读取、无效调用与探索成本；一次性小改动通常不适合为了这一收益专门接入。

成本优化的原则是：把重复性、范围明确且可验证的工作交给成本更低的模型，把复杂判断、跨域权衡和独立复查交给高级模型。因此，优化调用成本不以省略验证为代价；高级模型的复查与最终验收提供质量兜底，最终质量以独立复查和验收结果为准。这不构成对任何任务的绝对质量保证。

## 工作流概览

工作流只有三路：单步、单域且无需判断或委派的纯读由 main/root 直接完成；复杂且可证明纯读使用 [`orchestrate-read-workflow`](plugins/agnets-workflow/skills/orchestrate-read-workflow/SKILL.md)；任何状态变更、无法证明纯读、可能产生持久产物，或需要持久控制、恢复或任务级总审时使用 [`orchestrate-model-workflow`](plugins/agnets-workflow/skills/orchestrate-model-workflow/SKILL.md)。控制器的协议权威是 [`workflow-controller`](plugins/agnets-workflow/skills/workflow-controller/SKILL.md)。

## 快速安装

### 前置条件

- 已安装并可运行的 Codex CLI。
- Node.js `>=20`。
- macOS/Linux 还需要 `rg`（ripgrep）。

安装目标优先使用非空的 `CODEX_HOME`；未设置时使用 `~/.codex`。

### Windows（PowerShell 7）

在仓库根目录运行：

```powershell
& .\install-codex.ps1
```

### macOS 或 Linux

在仓库根目录运行：

```sh
sh ./install-codex.sh
```

安装成功后，必须完全重启 Codex Desktop 或 Codex CLI 进程，使新增配置与能力生效。

## 使用方式与可选能力

安装并重启后，在目标项目中直接描述任务即可。需要特定能力时，可以明确提及对应 skill：

| 能力 | 适用场景 | 说明 |
| --- | --- | --- |
| [`agent-toolchain`](plugins/agnets-workflow/skills/agent-toolchain/SKILL.md) | 复杂重构、跨模块理解和大范围排障 | 为目标项目接入 CodeGraph 与 RTK；在跨模块理解、大型代码库或重复探索明显的场景下，可进一步减少重复探索与调用成本；一次性小改动通常不适合为了这一收益专门接入。 |
| [`orchestrate-read-workflow`](plugins/agnets-workflow/skills/orchestrate-read-workflow/SKILL.md) | 复杂且可证明纯只读的任务 | 组织互补取证与有界定案。 |
| [`orchestrate-model-workflow`](plugins/agnets-workflow/skills/orchestrate-model-workflow/SKILL.md) | 状态变更或需要持久控制的任务 | 建立契约、执行分流和独立总验收。 |
| [`workflow-controller`](plugins/agnets-workflow/skills/workflow-controller/SKILL.md) | model 工作流需要持久 DAG、恢复或总审记录时 | 协议以该 skill 及其 reference 为准。 |
| [`project-doc-planner`](plugins/agnets-workflow/skills/project-doc-planner/SKILL.md) | 项目文档体系与任务记录判定 | 随 `agnets-workflow` 插件提供，规划文档结构，并为大型、长周期或跨模块开发保留最小持久记录。 |
| [`gpt-image-2-cli`](skills/gpt-image-2-cli/SKILL.md) | 需要生成或编辑图片素材 | 通过命令行调用图像生成能力。 |

例如，可以说：“使用 `$agent-toolchain` 给这个项目接入工具链”，或“使用 `$workflow-controller` 管理这个任务”。是否需要这些能力，应以任务范围为准。

## 进一步阅读

- [`agnets-workflow` 使用说明](plugins/agnets-workflow/README.md)
- [`orchestrate-read-workflow` 纯只读取证工作流](plugins/agnets-workflow/skills/orchestrate-read-workflow/SKILL.md)
- [`orchestrate-model-workflow` 工作流规范](plugins/agnets-workflow/skills/orchestrate-model-workflow/SKILL.md)
- [agent role profiles](codex-global-config/agents/ai-vibecode-superpower/)
- [macOS/Linux 安装脚本](install-codex.sh)
- [Windows 安装脚本](install-codex.ps1)

问题或建议：QQ群 `1105515344`
