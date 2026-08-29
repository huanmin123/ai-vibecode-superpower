---
name: causal-debugger
description: "使用只读因果调试器一次性编译全局代码关系、日志和堆栈证据，再进行根因分析。"
---

# 因果调试器

当用户描述 Bug、异常、超时、崩溃或行为回归时，优先调用 `causal_status` 确认 CodeGraph 索引健康，再调用 `causal_analyze` 生成有界证据包。用户只给自然语言时，将原始描述放入 `description`；工具会在本地提取文件行号、错误码、符号、端点、配置键、SQL 和 trace/request 键，避免先让模型反复 grep。

工作边界：

- CodeGraph 负责静态结构召回；它不是因果真值。
- RTK 负责日志去重、压缩和脱敏；压缩失败必须显式报告。
- 因果引擎保留多个候选根因、证据引用和反事实支持。
- 不自动修改源码、不重建 CodeGraph、不执行重启或生产 probe。
- `unknown`、索引过期、缺失堆栈映射和跨服务关系必须原样呈现。

拿到分析结果后，模型默认只使用 `packet` 和聚焦后的 `analysis.graph`，先给出：最高候选、候选分数、支持证据、冲突证据、未覆盖范围。`coverage_manifest` 是完整性边界，不能把 `budgetExceeded` 或 `truncated` 的结果当作完整结论；需要更多内容时，使用同一 `analysisId` 调用 `causal_expand`，按 `nodeIds`、`relationIds` 或 `seedIds` 定向补查。只有证据不足时才进行一次定向补查。

按 `triage.action` 处理用户交互：

- `analyze`：直接分析，不为了“更完整”而打断用户。
- `analyze_and_clarify`：先给出已有候选和缺口；只有该缺口会改变下一步判断时，才询问 `triage.question`，最多一个问题。
- `clarify_first`：不做全仓库扩散，不自行猜测；原样向用户询问 `triage.question`，收到补充后再调用 `causal_analyze`。
