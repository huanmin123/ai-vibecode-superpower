# 多模型工作流纯 Skill 重构设计

> 状态：设计阶段产物，已根据 2026-08-30 首次独立 Sol 审核修订
>
> 本文只确定目标设计和后续迁移契约。本任务不删除 MCP、不修改安装器、不部署，也不声称当前运行行为已经改变。

## 结论

将现有 `agnets-workflow` 从“plugin + workflow-controller MCP + 持久化控制器”重构为仓库根目录下的 standalone `orchestrate-model-workflow` skill。最终不再注册或分发 `agnets-workflow` plugin，不再提供 `workflow-controller` MCP、持久化 DAG、SQLite 状态、路径锁、租约、heartbeat、cursor、固定消息 envelope、固定审核 JSON 或 Sol CLI artifact 协议。

保留现有 12 个 Luna、Terra、Sol agent role 的名称、model、reasoning effort、sandbox 和核心职责，因为这些 role 是不同模型协议的调度入口。保留不等于逐字保留 role prompt：所有 role 中引用 `workflow_*`、`audit-context`、claim、review digest、固定 JSON 或控制器升级链的内容都必须改写为不依赖 MCP 的行为指导，并同步更新 SHA-256 manifest。

保留 `Explore -> Plan -> Work -> Critique -> Promote` 主流程。Skill 只描述何时取证、如何按风险选 role、写入前需要哪些事实与授权、何时独立复审以及怎样验收；具体 agent 创建、通信、等待、并行、重试和上下文传递由 Codex 根据当时可用的原生能力自主安排，不规定固定工具调用序列。

## 1. 当前仓库事实

以下事实来自当前工作区；行号只用于本轮定位。

| 相对路径 | 已证实事实 | 迁移含义 |
| --- | --- | --- |
| `plugins/agnets-workflow/.codex-plugin/plugin.json:2-23` | 同时注册 `skills: "./skills/"` 与 `mcpServers: "./.mcp.json"`，用户可见元数据仍宣称持久化总体验。 | 目标不是只删 `mcpServers`，而是取消整个 plugin 分发面。 |
| `plugins/agnets-workflow/.mcp.json:2-12` | 以 Node 启动 `workflow_controller_mcp.mjs`，并传入 `CODEX_HOME`。 | 后续删除 MCP descriptor 与服务。 |
| `plugins/agnets-workflow/package.json:5-10` | Node `>=22.5.0`、test/check 均围绕 store、controller、MCP 和 Sol CLI。 | 纯 Skill 不保留该 package 或 Node/SQLite 前提。 |
| `plugins/agnets-workflow/scripts/workflow_controller.mjs`、`workflow_controller_mcp.mjs`、`global_workflow_store.mjs` | 分别实现控制器、MCP 适配和全局状态存储。 | 后续随 plugin 源树移除。 |
| `plugins/agnets-workflow/scripts/workflow_prune_worker.mjs`、`session_meta_aggregate.mjs`、`workflow_error.mjs`、`sol_review_cli.mjs` | 服务于状态维护、控制器错误、会话聚合或受控制品审核。 | 实施前用 import 图复核后随 controller 专用实现移除；不得残留运行入口。 |
| `plugins/agnets-workflow/skills/orchestrate-model-workflow/SKILL.md:45-51` | 已定义五阶段主流程。 | 主流程迁入 standalone skill。 |
| `plugins/agnets-workflow/skills/orchestrate-model-workflow/SKILL.md:65,78,80-101` | 同时强制 v3 schema、DAG、assurance、claim、lock、lease、固定审核 JSON 和恢复协议。 | 这些控制器约束不迁入新 skill。 |
| `plugins/agnets-workflow/skills/orchestrate-model-workflow/references/execution-plan.md:27-75` | 使用固定委派字段、`workflow_escalate_execution` 和固定审核字段。 | 不迁移该协议模板；必要的目标、授权、验收等改为自然语言信息要求。 |
| `plugins/agnets-workflow/skills/orchestrate-model-workflow/references/sol-review.md:7-27` | 依赖 audit context、claim、snapshot、artifact、固定 JSON 和 `workflow_complete`。 | 不迁入 standalone skill，后续随旧 plugin 移除。 |
| `plugins/agnets-workflow/skills/workflow-controller/` | 整个 skill 描述 manifest、SQLite、锁、恢复、review schema、prune 和 cursor。 | 明确删除，不保留过渡安装入口。 |
| `codex-global-config/agents/ai-vibecode-superpower/*.toml` | 12 个 role 的 model、effort、sandbox 与职责提示均在此定义。 | role 文件保留，但其中的控制器协议文本必须改写。 |
| `codex-global-config/agents/ai-vibecode-superpower.sha256` | 保存 12 个 role 的规范化 SHA-256。 | role prompt 改写后必须同步生成并校验 manifest。 |
| `codex-global-config/agents/.../avsp_terra_high.toml` | prompt 引用 `workflow_escalate_execution` 和 `assurance_assessment`。 | 保留 Terra 保护执行/集成职责，删除控制器调用要求。 |
| `avsp_terra_xhigh.toml`、`avsp_terra_xhigh_readonly.toml`、`avsp_sol_high.toml`、`avsp_sol_xhigh.toml`、`avsp_sol_max.toml` | prompt 引用固定审核 JSON、`coordinator_task_path`、review digest 或控制器升级链。 | 保留判断/复审职责，改为自然语言结论与证据，不绑定固定协议。 |
| `README.md`、`plugins/agnets-workflow/README.md` | 公开承诺 MCP、DAG、checkpoint、锁、Node SQLite 和 controller skill。 | 后续删除或改写为 standalone skill 的用户说明。 |
| `install-codex.ps1`、`install-codex.sh` | 既能安装根 `skills/` 下的 standalone skills，也注册 `agnets-workflow` plugin、校验 MCP/Node 并管理 plugin cache。 | 复用已有 standalone skill 安装路径，移除工作流 plugin 注册和 MCP 专用逻辑。 |
| `.agents/plugins/marketplace.json` | 当前只剩 `agnets-workflow` entry。 | 后续移除该 entry；若 marketplace 无其他 plugin，是否删除空 marketplace 文件由安装器契约决定，但不得再暴露工作流 plugin。 |
| `plugins/agnets-workflow/tests/install_contract.test.mjs` 及 controller/store/CLI tests | 断言 plugin、`.mcp.json`、旧 cache、SQLite/controller 或固定审核协议。 | 删除旧实现测试，新增 standalone skill、role 和无残留协议测试。 |

当前工作区还存在用户未提交修改，包括 `README.md`、两个安装器、marketplace 和安装契约测试。后续实施必须基于当时实际 diff 重新取证并保留这些修改，不得把它们当成本设计已完成的改动。

## 2. 目标与非目标

### 2.1 目标

1. 将 `orchestrate-model-workflow` 安装为 `$CODEX_HOME/skills/orchestrate-model-workflow` 对应的 standalone skill，不依赖 plugin 或 MCP。
2. 保留 12 个 role 的名称、model、effort、sandbox 和核心职责，清理其 controller/MCP 协议耦合。
3. 保留五阶段主流程、授权边界、唯一写入所有权、错误可见性、验证和独立复审。
4. 让 Codex 自主决定 agent 数量、调度顺序、并行范围、消息方式和等待方式。
5. 用代表性任务比较迁移前后的成功率、token、耗时、工具调用数和人工介入次数。

### 2.2 非目标

- 本文档任务不实施代码迁移、不安装、不部署，也不清理用户级缓存或状态。
- 不保证 Codex 原生能力等价替代 controller 的 DAG、锁、恢复、审计或关闭 hook。
- 不迁移旧 SQLite、namespace、DAG、artifact、claim 或 lease 到新 skill。
- 不新增另一套 schema、状态机、固定 JSON envelope 或隐式 fallback。
- 不改变 12 个 role 的模型、effort、sandbox 或核心分工；只删除旧控制器协议并精简表达。
- 不把 `execution_contract`、`execution_risk`、`execution_owner`、`integration_owner`、`quality_guard` 等有用概念本身视为必须删除；它们可以作为普通自然语言协调信息，但不再是固定字段、运行时对象或关闭凭证。

## 3. 确定的目标布局

最终工作流运行入口只保留：

```text
skills/
  orchestrate-model-workflow/
    SKILL.md
    agents/
      openai.yaml

codex-global-config/agents/
  ai-vibecode-superpower/
    <12 个 role TOML>
  ai-vibecode-superpower.sha256
```

`SKILL.md` 是工作流行为的唯一权威源；`agents/openai.yaml` 只保留界面名称、简短描述和默认提示，不引入 controller 术语。为减少上下文和维护面，旧 `execution-plan.md` 与 `sol-review.md` 不迁移；确有价值的少量授权、验收和返回信息直接写入 `SKILL.md`，不使用固定字段模板。

实施完成后，以下运行分发面不存在：

- `plugins/agnets-workflow/` 源树；
- `.agents/plugins/marketplace.json` 中的 `agnets-workflow` entry；
- 用户配置中的 `agnets-workflow@ai-vibecode-superpower-local` 与旧 `workflow-controller@ai-vibecode-superpower-local` 激活项；
- `$CODEX_HOME/skills/workflow-controller` 或任何仍可发现的同名 skill；
- `workflow-controller` MCP server 和 `workflow_*` 工具暴露。

不再创建新的 plugin/package/manifest 版本。迁移后的版本来源是仓库提交与安装器事务；standalone skill 通过源目录内容和安装后文件一致性校验，不使用 `plugins/agnets-workflow/package.json` 或 `.codex-plugin/plugin.json` 的版本关系。

## 4. 责任分层

| 层 | 责任 | 不负责 |
| --- | --- | --- |
| Skill | 触发条件、五阶段行为、role 选择依据、授权/验证/复审标准、失败可见性。 | 不创建运行时状态，不规定固定消息 schema 或工具调用顺序。 |
| Role | 通过 TOML 选择 model、effort、sandbox，并限定取证、执行、集成或复审职责。 | 不单独证明硬权限隔离，不引用已删除 controller。 |
| main/root | 理解目标和授权，选择是否委派，处理共享写入，核验 diff/测试并作最终判断。 | 不把 agent 自述当成完成证据，不把未知能力写成保证。 |
| Codex 原生运行时 | 在当前环境中提供可用的 agent 创建、通信、等待和状态观察能力。 | 本设计不假设其具备持久 DAG、路径锁、跨会话恢复或强身份认证。 |
| 项目工具链 | 提供 diff、静态检查、测试、构建和运行证据。 | 不替代授权与独立复审判断。 |

## 5. 保留的 role 路由

下表保留 role 身份和核心职责；每个 prompt 都要删除 controller 专用调用、固定 JSON 和持久状态术语。`sandbox_mode` 是配置意图，实际权限和模型可用性仍须安装后实测。

| role | model / effort / sandbox | 保留职责 |
| --- | --- | --- |
| `avsp_luna_high` | `gpt-5.6-luna` / `high` / `read-only` | 常规跨文件取证、预审和有界扫描。 |
| `avsp_luna_xhigh` | `gpt-5.6-luna` / `xhigh` / `read-only` | 需要更深局部理解的取证和复杂预审。 |
| `avsp_luna_high_executor` | `gpt-5.6-luna` / `high` / `danger-full-access` | 在目标、授权、范围、验收和停止条件已明确时执行受控写入。 |
| `avsp_luna_xhigh_executor` | `gpt-5.6-luna` / `xhigh` / `danger-full-access` | 已定方案但需要更深局部理解的受控执行。 |
| `avsp_terra_high` | `gpt-5.6-terra` / `high` / `danger-full-access` | 处理受保护写入、执行监管、结果核验和集成。 |
| `avsp_terra_xhigh` | `gpt-5.6-terra` / `xhigh` / `read-only` | 证据充分、范围有界的定案和常规复审。 |
| `avsp_terra_xhigh_readonly` | `gpt-5.6-terra` / `xhigh` / `read-only` | Sol 真正不可用时的只读复审替代，并披露独立性下降。 |
| `avsp_terra_low_readonly` | `gpt-5.6-terra` / `low` / `read-only` | Luna/high 真正不可用时的一对一只读替代。 |
| `avsp_terra_medium_readonly` | `gpt-5.6-terra` / `medium` / `read-only` | Luna/xhigh 真正不可用时的一对一只读替代。 |
| `avsp_sol_high` | `gpt-5.6-sol` / `high` / `read-only` | 多约束定案、跨域影响分析和复杂独立复审。 |
| `avsp_sol_xhigh` | `gpt-5.6-sol` / `xhigh` / `read-only` | 证据冲突、根因未证实、无可靠 oracle 或受约束重设计。 |
| `avsp_sol_max` | `gpt-5.6-sol` / `max` / `read-only` | 最高强度独立复审和升级验收。 |

简单、低风险、边界清晰的任务可由 main/root 直接完成。Skill 不强制创建 agent，也不规定每类 role 的数量。Luna executor 只在写入目标和授权已经明确时使用；不确定、共享状态或不可逆写入交给 Terra 保护执行；Sol 始终只读。

## 6. 五阶段行为

### Explore

先检查相关代码、配置、文档、测试和调用关系。需要拆分证据域时优先使用 Luna 只读 role；并行只用于互补且能证明无写入的证据域。输出事实、来源、推断、未知项和风险。

### Plan

main/root 基于证据明确目标、范围、非目标、授权、验收、验证和停止条件。写入任务还需明确唯一执行者、共享资源处理和失败后的恢复方式。这些信息可用自然语言表达，不要求固定字段名或 JSON。

### Work

按已定目标实施。影响受控且可恢复的写入可交给 Luna executor；受保护写入、共享状态或集成交给 Terra。执行者返回实际改动、验证、原始错误和未完成项。Codex 自行决定使用何种原生消息与等待工具。

### Critique

完成所有会改变被审对象的验证后，再由未参与写入的只读 role 独立核对原始目标、范围、diff/产物、测试、回归和未验证项。常规定案可使用 Terra/xhigh，复杂或高不确定性复审使用 Sol。结论可以是自然语言，不要求固定 JSON、review digest、claim 或控制器升级链；发现 blocker 后回到 Plan/Work 修复，并由协调者重新选择独立复审者。

### Promote

只有验收满足、独立复审无 blocker、当前 diff 与验证仍匹配且没有必需工作时才交付。Promote 不自动授权安装、发布、部署、推送或其他外部状态变更。

## 7. Codex 自主调度与交接边界

Skill 可以说明“需要互补取证”“需要受控执行”“需要独立复审”，但不规定必须调用 `spawn_agent`、`send_message`、`followup_task`、`wait_agent` 或 `interrupt_agent` 的哪一个，也不规定调用次数和顺序。Codex 根据当前宿主暴露的能力处理。

交接只要求结果可核对：目标和边界、授权、必要事实、验收/验证、停止条件、实际改动、原始错误、未完成项。可以保留 `execution_owner` 等术语帮助说明责任，但不得把它们包装成自定义 schema、ACL、锁或关闭凭证。

当前仓库和本轮官方检索不能证明所有 Codex 版本都具备相同的命名 role、模型切换、上下文、生命周期、完成证明或恢复语义。实施只能把当前环境实测结果写成证据，不能外推为平台保证。

## 8. 错误、恢复与并发

1. 保留原始 provider/宿主错误、已尝试操作、影响范围和缺失条件；不得静默 fallback 或报告成功。
2. role/model 真正不可用时，父协调者才显式选择替代 role，并说明原始错误和能力下降；timeout、证据不足或普通失败不等于不可用。
3. 移除 controller 后没有 checkpoint、lease、自动恢复或关闭 hook。中断后只能重新盘点原生 agent 状态、工作区 diff 和输出；无法证明旧执行者停止时不得并行接管。
4. 共享文件、数据或外部状态由 main/root 安排唯一执行者和串行顺序。若宿主没有可验证的路径锁，不得声称并行写入安全。
5. 失败导致范围、风险或授权变化时回到 Plan，不能在原任务内静默扩大。

## 9. 确定的删除、迁移与升级契约

### 9.1 源仓库迁移

1. 在根 `skills/orchestrate-model-workflow/` 建立精简 skill，只保留 `SKILL.md` 和必要的 `agents/openai.yaml`。
2. 改写所有 12 个 role prompt：保留 role 名称、model、effort、sandbox 和核心职责；删除 `workflow_*`、固定审核 JSON、`coordinator_task_path`、claim、review digest、audit context、artifact 与固定升级链，并更新 SHA-256 manifest。
3. 删除整个 `plugins/agnets-workflow/` 源树，包括两个 skill、references、MCP descriptor、plugin manifest、package、scripts 和旧测试。
4. 从 marketplace 删除 `agnets-workflow` entry；没有其他 plugin 时允许移除空 marketplace 注册，但安装器必须保留对其他现存 plugin 的通用行为，不能按字符串误删无关配置。
5. 更新根 `README.md`、`docs/README.md`、根 `AGENTS.md` 和 `codex-global-config/AGENTS.md` 的权威链接、触发规则、安装说明与工具调用契约，移除 controller/MCP 语义。

### 9.2 安装目标

安装后的唯一工作流 skill 路径是 `$CODEX_HOME/skills/orchestrate-model-workflow`；12 个 role 继续位于受管 agent role 目录。用户配置中不得存在已启用的 `agnets-workflow@ai-vibecode-superpower-local`、旧 `workflow-controller@ai-vibecode-superpower-local` 或 `workflow-controller` MCP server。

Windows 与 POSIX 安装器应：

- 把 `orchestrate-model-workflow` 加入现有 standalone skill 清单；
- 移除工作流 plugin source、marketplace、MCP descriptor、Node/SQLite 预检、MCP cache 展开/修复和 plugin 安装步骤；
- 通过 Codex plugin remove 或等价受支持入口停用两个已知旧 plugin identity；
- 在事务备份范围内移除精确受管的旧全局 `workflow-controller` skill 和 `agnets-workflow` plugin cache，先验证解析后的目标位于用户 Codex home 的受管 cache 路径，不递归处理未知路径；
- 安装失败时恢复本次事务改动，不覆盖其他用户配置或无关 plugin。

### 9.3 旧状态边界

`$CODEX_HOME/state/agnets-workflow/current` 中的 SQLite 和 artifacts 不再被新 skill 读取、迁移或接管。安装器默认保留这类历史状态，不把“停用 MCP”扩大为不可恢复的数据删除；它们只是惰性历史数据，不得再有活动服务读取。需要清理时另行取得用户授权，并对精确路径做备份或可恢复删除。

### 9.4 版本和激活契约

最终不存在新的 `agnets-workflow` plugin version、`package.json` 或 `.codex-plugin/plugin.json`。实施提交必须同时完成源树迁移、安装器变更和测试，不能发布“新 plugin 版本但旧 MCP 仍可发现”的过渡态。升级验证以以下激活状态为准：standalone skill 可发现；12 role 可加载；两个旧 plugin identity 均未启用；MCP 工具列表没有 `workflow-controller`；旧 state 即使保留也不会启动进程。

## 10. 测试与验收

### 10.1 静态契约

- 精确解析 12 个 role，核对名称、Luna/Terra/Sol model、effort、sandbox，并验证更新后的 SHA-256 manifest。
- 在 `skills/orchestrate-model-workflow`、`codex-global-config/AGENTS.md` 和 12 个 role prompt 中执行 allowlist 扫描：不得出现 `workflow_`、`routing_schema_version`、`claim_id`、`coordinator_task_path`、`review_history_digest`、`audit-context` 或固定审核 JSON 契约。
- `rg` 确认源仓库不再存在 `plugins/agnets-workflow`、`.mcp.json` 注册、`workflow-controller` skill 或 Node/SQLite controller 安装检查。
- 校验新 skill frontmatter、`agents/openai.yaml` 和安装后源/目标文件一致性。
- 安装器测试必须验证只安装 standalone skill 与 12 role，并停用旧 plugin；不得继续断言旧 `.mcp.json` 或 controller cache 有效。

### 10.2 临时 Codex home

在隔离 home 分别验证全新安装和从当前 plugin 版本升级：

1. skill 可发现并能触发；
2. 12 role 逐一加载，model/effort/sandbox 与源一致；
3. plugin list/config/MCP 工具面没有工作流 plugin 或 controller；
4. 旧受管 cache 被事务性清理，旧 state 保留但无进程读取；
5. 安装失败可回滚，不影响无关用户配置。

### 10.3 代表性行为

覆盖简单单文件任务、跨文件取证、受控实现、共享写入风险、独立复审、role 不可用和中断恢复。记录任务成功、token、耗时、agent/工具调用数、人工介入、未验证项和原始错误；单次成功不能证明普遍兼容。

### 10.4 原始需求覆盖

| 需求 | 设计证据 | 实施后通过条件 |
| --- | --- | --- |
| R1：基于事实并保留 role/model 调度 | 第 1、5 节列出实际依赖和 12 role；明确 prompt 可改、身份与路由保留。 | 12 role 静态校验、manifest 和逐一加载通过。 |
| R2：保留五阶段，删除 MCP/协议，由 Codex 调度 | 第 3、6、7、9 节确定 standalone 布局、五阶段、自主调度和删除范围。 | 无 controller 协议引用，代表性任务无需 MCP 完成。 |
| R3：设计完整且本任务不实施 | 第 2-10 节确定目标、非目标、布局、升级、风险和验证；页首声明当前仅设计。 | 后续实现按完整契约通过静态、安装和行为验证。 |
| R4：独立 Sol 二审并修复 blocker | 首次二审发现 role/reference 与升级契约缺口，本文已按 finding 修订。 | 新的独立升级审核无 blocker；失败则继续修订，不得交付关闭。 |
| V1：成本与效率 | 第 10.3 节要求同类任务对比。 | 给出 token、耗时、调用数和成功率的实际对照。 |

## 11. 风险和待验证项

1. 移除 controller 后程序化审计、并发锁、跨会话恢复和关闭检查会消失；自然语言交接、diff、测试和复审不能声称与其等价。
2. 当前环境之外的命名 role、model、agent 生命周期、消息和等待语义仍未知，必须以安装后实测为准。
3. 旧 plugin cache 清理涉及用户 Codex home，必须限定在已解析的受管路径并纳入安装器事务；旧 state 默认保留。
4. 工作区已有未提交修改与后续迁移文件重叠，实施前必须重新核对并在现有内容上增量修改。
5. 取消 plugin 后 marketplace 可能变为空；是否保留空 marketplace 基础设施只影响通用插件管理，不得影响 standalone skill 或误删其他 plugin。
6. controller 消失可能减少 token、启动和状态维护成本，也可能增加人工协调或重复取证，必须用代表性任务测量。

## 12. 本任务边界与结论

本次只新增并修订 `docs/agnets-workflow纯Skill重构设计.md`。当前仓库仍是 plugin + workflow-controller MCP；运行时、安装器、README、AGENTS、marketplace、测试和 role 均未因本文改变，也没有部署。

目标方案已经确定为“standalone skill + 12 个去控制器协议的 role”，不再把 plugin 去向、workflow-controller skill、role prompt 清理、旧 cache/state 或激活目标留到实施时决定。只有后续实现通过静态、临时 home、代表性行为和新的独立复审，才能报告迁移完成。
