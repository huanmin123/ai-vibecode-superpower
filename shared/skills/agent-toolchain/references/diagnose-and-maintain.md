# 诊断、修复与维护

仅在工具不可用、索引异常、用户要求健康检查或明确要求维护时读取本文件。日常跨模块查询和只读命令压缩遵守目标项目 `AGENTS.md` 的 `## CodeGraph 与 RTK` 标题，AOCI 认知读取与维护遵守其 `<!-- aoci:begin/end -->` 托管区块；不需要读取本文件或触发 `$agent-toolchain`。

## 诊断顺序

1. 对工具可用性不确定的大任务，最多运行一次 `doctor --quick`。
2. `doctor --quick` 失败、CodeGraph MCP 查询异常，或索引状态可疑时，运行完整 `doctor`。
3. 完整检查显示工具缺失时，只有接入或修复安装已获授权，才读取 `references/install.md` 并执行该流程。
4. 完整检查显示 `aoci: missing` 时同上走安装流程；显示 `aoci-cognition: needs_init` 或 `aoci-baseline: needs_scan` 时运行 `init-aoci`（幂等，只补建缺失部分）。
5. 完整检查显示 CodeGraph 索引未初始化或异常时，运行 `init-codegraph`；已有索引会执行一次增量同步。
6. AOCI 认知漂移或治理异常（MCP 工具报错、`aoci status` 显示异常）时，用受管公共入口运行 `aoci --repo <项目> doctor` 与 `aoci --repo <项目> verify`，按其输出处理；认知条目的语义维护由宿主 Agent 在会话内按 AGENTS.md 托管区块完成，本 skill 不代为撰写。
7. `verify`/`check` 报 `scope_change_required`（scope 策略待激活）时，这是治理审批边界，不是故障：Agent 不得自我批准，也不要穷尽 CLI 变体尝试绕过。正确动作是把审批命令整理好交给用户本人执行。典型流程：先运行 `aoci --repo <项目> scope activate`；若被 `observed_evidence_review_required` 拦截，说明 observe 对象（测试文件等不建认知条目的文件）的指纹变更卡在复核，与用户确认后可运行 `aoci --repo <项目> scope observe-policy informational`（把 observe 证据降为信息记录，可用同命令改回 `review_required`）再重试 activate；activate 停在真人审批（exit 2）时，把其输出中的 `scope approve --preview-file ... --actor <身份>`（执行时会要求在真实终端逐字输入确认短语，这是防自动化设计）与 `scope apply` 两条命令原样交给用户，完成后 `governance_aligned` 归零、该 finding 消失。
8. 保留命令输出、退出码和受影响范围。检查失败不表示工具能力不存在，更不允许无证据改用不兼容工具。

使用当前加载的 skill 目录中的平台驱动：Windows 用 `agent-toolchain.ps1`，macOS/Linux 用 `agent-toolchain.sh`。所有需要项目上下文的命令都带 `--project <目标绝对目录>`。

## 命令语义

| 命令 | 用途 | 使用边界 |
| --- | --- | --- |
| `doctor --quick` | 检查受管 CodeGraph、RTK、AOCI 与公共命令入口 | 每个大任务最多一次；不检查索引 |
| `doctor` | 检查工具、入口、CodeGraph 索引和 AOCI 认知初始化状态 | 用于接入完成验证与故障诊断 |
| `init-codegraph` | 建立索引，或同步现有索引 | 仅在未初始化或完整诊断明确需要时使用 |
| `init-aoci` | 补建缺失的认知骨架、AGENTS.md 托管区块或基线 | 幂等；基线损坏需要重建时，先删除 `.aoci/baseline.json` 再运行本命令 |
| `maintain` | 检查 CodeGraph 状态 | 不做周期性维护 |
| `maintain --sync` | 显式同步索引 | 仅当 `doctor`、MCP 结果或 `codegraph status` 明确异常时使用一次 |
| `rollback rtk <版本>` | 切换到已校验的 RTK 版本 | 仅在明确的 RTK 回滚任务中使用；版本目录必须与当前内置 manifest 校验一致 |
| `rollback aoci <版本>` | 切换到已校验的 AOCI 版本 | 仅在明确的 AOCI 回滚任务中使用；不触碰项目认知卷，且版本目录必须与当前内置 manifest 校验一致 |

## 日常维护原则

- CodeGraph MCP 会监听文件变化并在重连后补齐离线修改；不要按固定周期运行 `maintain --sync`。
- AOCI 的认知维护由受管理对象变化后的会话收尾流程驱动（AGENTS.md 托管区块约定），不要按固定周期运行 `aoci` 维护命令。
- AOCI 的 scope 治理审批（`scope approve`/`scope apply`）必须由用户本人在真实终端执行；Agent 的职责是把命令整理清楚并说明变更影响（如哪些文件移出认知覆盖），不是代为审批。
- AOCI 认知卷接近预算时（`verify` 报 `near_budget`），用 `aoci --repo <项目> scope budget` 查看用量；预算策略调整属于用户决策。
- 不自动升级。版本变化必须走安装资料中的受控审查路径。
- 不把 RTK 当安全边界，也不使用它执行写操作、安装、升级、提交、发布、部署、迁移、权限或密钥操作。
- 工具返回与当前源文件冲突时，以当前源文件和 `rg` 为准，并报告差异；不要把陈旧索引当作事实。
