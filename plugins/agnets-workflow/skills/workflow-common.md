# 工作流共用规则

`$orchestrate-read-workflow` 与 `$orchestrate-model-workflow` 都必须先遵守本文件。role profile 是本地权限、model 与 effort 的权威来源：仓库为 `codex-global-config/agents/ai-vibecode-superpower/`，安装后为 `<CODEX_HOME>/agents/ai-vibecode-superpower/`。本文件只维护状态边界、共用只读 role、问题处理与交接。

## 状态边界

状态变更包括持久工作区文件、配置、依赖或锁文件、生成产物、版本控制、数据库或其他数据，以及外部服务、API、部署或消息状态。只有能证明所有计划操作均不改变这些状态的任务才是 `read_only`；不能证明时按状态变更处理。`read-only` sandbox 是行为边界和配置意图，不是硬 ACL；父 agent 须核验实际有效权限。

## 共用只读 Role

| 用途 | `agent_type` | 选择条件 |
| --- | --- | --- |
| 协调与聚合 | `main/root` | 单步、单域且无需判断或委派的事实 |
| 常规 / 深入取证 | `avsp_luna_high` / `avsp_luna_xhigh` | 明确证据域；仅深层局部理解时选 xhigh |
| Luna 替代 | `avsp_terra_low_readonly` / `avsp_terra_medium_readonly` | 对应 Luna 实际不可用时一对一替代 |
| 有界 / 高难定案 | `avsp_terra_xhigh` / `avsp_sol_high` | 前者证据充分且推理常规；后者有跨域或多约束权衡 |
| 升级调查 | `avsp_sol_xhigh` | 证据冲突、根因未证实或无可靠 oracle |

除 main/root 外，这些只读 role 不得派生子 agent。只有互补证据域或不同决策问题才并行；高影响或风险域名称本身不触发 Sol。

## 问题处理与交接

路由判定早于执行授权。任务连续性不完整、前序性质无法证明时，先进入 `$orchestrate-model-workflow` 的只读恢复诊断；这不授权写入，仍无法重建任务身份、目标或授权时，必须在任何状态变更前停止并报告缺失条件。

父 agent 发送自包含任务包：目标、范围与非目标、授权、必要事实、验收、验证、返回格式和停止条件。证据不足时只补充相关证据，冲突时先定位冲突点，仍不能消除的不确定性明确标为未知。

普通失败、超时、证据不足或无效输出不等同 `unavailable`；超时不证明旧实例已经停止。仅 role、model 或必要依赖实际不可用时才记录 `unavailable`，fallback 是父 agent 保留原始错误的显式动作。子 agent 返回结论或实际改动、证据、验证、未完成工作、风险和原始错误，并区分事实、推断与未知。父 agent 在聚合、集成或关闭前实际核验实例状态、当前 diff、产物和验证输出；投递、等待或部分日志不构成终态。
