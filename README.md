# ai-vibecode-superpower

> 把 Codex 从“单次对话工具”升级为一套面向复杂开发的工程协作系统：**更快推进、更强判断、更少浪费**。

`ai-vibecode-superpower` 是可安装的 Codex 配置包。它为复杂开发建立可追溯的取证、执行、验证与独立复查闭环；小任务仍然保持直接、轻量，不为工作流而工作流。

## 你真正得到的提升

| 你关心的事 | 系统如何做到 | 结果是什么 |
| --- | --- | --- |
| **速度** | 可拆分的取证与准备工作并行推进；依赖满足后立刻进入下一节点。 | 减少等待串行链路，让复杂任务更快收敛。 |
| **智力** | 先用证据缩小问题，再把高强度判断留给真正复杂、冲突或高风险的决策。 | 不是“多想一点”，而是让推理聚焦在最值得推理的地方。 |
| **成本** | 范围明确的扫描、整理和可验证执行使用更经济的路径；高成本复审按风险升级。 | 降低重复探索与不必要的高强度推理消耗。 |
| **可靠性** | 协作闭环中的复杂任务留下状态、checkpoint、验证和审核证据；直接任务保留实际结果和验证证据，有改动时附 diff。 | 中断可恢复，结论可核对，未验证的风险不会被包装成完成。 |

以上收益取决于任务规模、可拆分程度、代码库质量和验证条件。一次性小改动通常直接完成，不会强行引入额外协作成本。

## 工作流概览

```mermaid
flowchart LR
    USER(["目标 · 范围 · 验收标准"]) --> INTAKE["任务准入<br/>先判断：直接完成，还是进入协作闭环？"]

    INTAKE -->|"简单问答、只读查询或单文件且边界清晰低风险"| DIRECT["最小充分实现<br/>直接完成"]
    DIRECT --> LOCAL_VERIFY["贴近改动验证<br/>并按影响扩大"]
    LOCAL_VERIFY --> DIRECT_DELIVERY(["直接交付"])
    INTAKE -->|"复杂、跨域或高风险"| EXPLORE

    subgraph INTEL["复杂任务主线 · 把推理花在刀刃上"]
        direction TB
        EXPLORE["Explore · 并行取证<br/>拆开独立证据域，减少重复探索"]
        PLAN["Plan · 证据驱动定案<br/>明确契约、边界、风险与验证"]
        WORK["Work · 受控执行<br/>范围明确的工作按依赖并行推进"]
        VERIFY["Work 内集成验证<br/>检查结果、影响范围与残余风险"]
        EXPLORE --> PLAN --> WORK --> VERIFY
    end

    subgraph CONTROL["持久化控制平面 · 可恢复、可审计、不丢上下文"]
        direction TB
        DAG["任务 DAG<br/>依赖就绪即推进"]
        STATE["checkpoint 与状态<br/>中断后可定位、可恢复"]
        LOCK["最小写入锁<br/>并行而不互相踩踏"]
        EVIDENCE["冻结证据<br/>审核面对同一份事实"]
        DAG --> STATE --> LOCK --> EVIDENCE
    end

    EXPLORE -.->|"拆分与就绪"| DAG
    WORK -.->|"实际写入时"| LOCK
    VERIFY -.->|"验证完成后"| EVIDENCE

    VERIFY --> CRITIQUE{"Critique · 独立末端质量门<br/>验收、范围、验证与风险是否闭环？"}
    CRITIQUE -->|"质量门与关闭检查通过"| PROMOTE["Promote · 可信交付<br/>速度 × 智力 × 成本效率"]
    PROMOTE --> DELIVERY(["可信交付完成"])
    CRITIQUE -->|"发现问题"| REPAIR["精确修复<br/>重新验证，并按需要提高审查强度"]
    REPAIR --> WORK

    classDef start fill:#0b1220,stroke:#38bdf8,color:#f8fafc,stroke-width:2px;
    classDef smart fill:#102a43,stroke:#22d3ee,color:#ecfeff,stroke-width:2px;
    classDef control fill:#1e1b4b,stroke:#a78bfa,color:#f5f3ff,stroke-width:2px;
    classDef gate fill:#3f1d2e,stroke:#fb7185,color:#fff1f2,stroke-width:2px;
    classDef result fill:#14532d,stroke:#4ade80,color:#f0fdf4,stroke-width:3px;
    class USER,INTAKE,DIRECT,LOCAL_VERIFY start;
    class EXPLORE,PLAN,WORK,VERIFY smart;
    class DAG,STATE,LOCK,EVIDENCE control;
    class CRITIQUE,REPAIR gate;
    class PROMOTE,DELIVERY,DIRECT_DELIVERY result;
```

复杂任务用 `Explore → Plan → Work → Critique → Promote` 表达主线：`Explore` 是取证，`Plan` 是定案与契约，`Work` 包含实施和集成验证，`Critique` 是独立末端质量门，`Promote` 仅表示在质量门与关闭检查通过后允许可信交付，不授权额外发布或部署。简单问答、只读查询或单文件且边界清晰低风险的直接任务不进入该闭环；有改动时运行贴近改动、再按影响扩大的验证后交付。

这不是“多开几个 agent”。它是一套明确分工的工程闭环：低成本工作尽量并行和复用，高强度判断只在证据不足、风险上升或需要独立复查时介入；每次交付都要经过与任务风险相称的验证。

`workflow-controller` MCP 负责保存 DAG、checkpoint、声明范围内的写入锁与审核证据。它不替代 Codex agent，也不假装自动解决工程判断；它让协作过程可查、可恢复、可收口。

## 适合什么场景

| 场景 | 推荐方式 |
| --- | --- |
| 单文件、改法明确、低风险调整 | 直接完成并运行贴近改动的验证。 |
| 跨文件实现、未知根因、需要扫描大型代码库 | 用并行取证和证据驱动定案，减少盲目修改。 |
| 多模块改造、共享状态、外部副作用或高回归风险 | 用持久化工作流、受控写入与任务级质量门。 |
| 需要反复交接、可恢复推进或独立验收 | 使用 `workflow-controller` 保留状态、证据与关闭检查。 |

## 快速安装

### 前置条件

- 已安装并可运行的 Codex CLI。
- Node.js `>=22.5.0`（工作流控制器使用原生 `node:sqlite`）。
- 可运行的 `npm`（安装 `causal-debugger` 的 CodeGraph 运行时依赖）。
- macOS/Linux 还需要 `rg`（ripgrep）。
- 安装前完全退出 Codex Desktop；否则运行中的应用可能把配置覆盖回去。

安装器会解析当前用户的 Codex home，再把全局文档中的路径占位符替换为绝对路径；已安装的 `AGENTS.md` 和 `docs/` 不依赖模型展开环境变量。安装器只在成功安装后清理自己生成的旧备份，并保留最近 5 份；名称不匹配、符号链接或 junction 内容不会删除。

### Windows（PowerShell 7）

在仓库根目录运行：

```powershell
& .\install-codex.ps1
```

安装前先完整退出所有 Codex Desktop 窗口，并确认其 `app-server` 进程已经结束。安装器会拒绝在 Desktop 仍运行时更新，避免活动进程把插件 marketplace 配置回写成旧快照或继续占用旧 MCP 缓存。安装成功后重新启动 Codex，并在新会话中使用插件。

### macOS 或 Linux

在仓库根目录运行：

```sh
sh ./install-codex.sh
```

安装前先完整退出 Codex Desktop；安装成功后重新启动并新建会话。

安装成功后，完全重启 Codex Desktop 或 Codex CLI 进程，使配置和能力生效。若使用 CC-Switch，请确认它没有覆盖安装脚本写入的 Codex 配置。

如果安装时未退出应用，或配置看起来没有生效，可核对以下配置是否仍存在：

```toml
model = "gpt-5.6-terra"
model_reasoning_effort = "high"
sandbox_mode = "danger-full-access"

[plugins."agnets-workflow@ai-vibecode-superpower-local"]
enabled = true

[plugins."causal-debugger@ai-vibecode-superpower-local"]
enabled = true

[agents]
max_threads = 1000
max_depth = 5

[features]
goals = true
```

## 使用方式与可选能力

安装并重启后，直接在目标项目描述目标、范围和限制即可。复杂任务会根据实际需要进入协作闭环；不需要时保持轻量。

| 能力 | 何时使用 | 你会得到 |
| --- | --- | --- |
| [`agent-toolchain`](skills/agent-toolchain/SKILL.md) | 首次接入、升级、修复、维护或审查 CodeGraph/RTK | 对目标项目进行受控接入与维护。 |
| [`causal-debugger`](plugins/causal-debugger/skills/causal-debugger/SKILL.md) | Bug、异常、超时、崩溃或行为回归的只读分析 | 汇总 CodeGraph 与日志证据，输出有界根因候选。 |
| [`workflow-controller`](plugins/agnets-workflow/skills/workflow-controller/SKILL.md) | 需要持久化状态、恢复交接或严格收口 | 任务状态、checkpoint、写入协调与关闭检查。 |
| [`project-doc-planner`](skills/project-doc-planner/SKILL.md) | 新项目或大型改造的文档规划 | 可维护的项目级文档结构。 |
| [`gpt-image-2-cli`](skills/gpt-image-2-cli/SKILL.md) | 需要生成或编辑图片素材 | 通过命令行调用图像生成能力。 |

例如：“使用 `$agent-toolchain` 给这个项目接入工具链”，或“使用 `$workflow-controller` 管理这个任务”。工具链接入完成后，普通开发不需要再次触发 `$agent-toolchain`。

## 进一步阅读

- [`agnets-workflow` 使用说明](plugins/agnets-workflow/README.md)：工作流能力与控制器边界。
- [`orchestrate-model-workflow`](plugins/agnets-workflow/skills/orchestrate-model-workflow/SKILL.md)：工作流路由、交接与验收规范。
- [agent role profiles](codex-global-config/agents/ai-vibecode-superpower/)：role 的本地权限与输出边界。
- [Windows 安装脚本](install-codex.ps1) / [macOS/Linux 安装脚本](install-codex.sh)。

问题或建议：QQ群 `1105515344`
