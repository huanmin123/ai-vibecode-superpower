# 因果调试器插件

这是一个只读的 Causal Debugger 可运行插件。它将 CodeGraph 静态关系、日志/堆栈观测和有界因果假设编译成一次性分析包，供 Codex 在全局视角下定位问题。

## 工具

- `causal_status`：检查项目 CodeGraph 索引状态、规模、语言和待处理引用。
- `causal_analyze`：按症状查询、自然语言 `description` 或精确节点生成有界因果分析；描述会先由确定性解析器提取文件行号、错误码、符号、端点、配置键、SQL 和 trace/request 键，再展开上游和下游关系，可传入已压缩运行时事件或日志文件。
- `causal_expand`：使用 `causal_analyze` 返回的 `analysisId`，按节点、关系或 symptom seed 定向展开被裁剪的证据。

分析结果默认返回面向 AI 的 `packet` 和聚焦后的 `analysis.graph`，默认聚焦预算为 64 个节点/128 条边，并带有 `coverage_manifest`。硬保留证据优先于可选排序；如果硬保留集合超过预算，结果标记为 `partial`/`budgetExceeded`，不会静默丢弃关键关系。当前缓存保存的是本次有界 `analysis_graph` 候选账本，不等于整个仓库；它留在当前 MCP 进程缓存中，可通过 `causal_expand` 取回，调试场景可传 `includeLedger=true` 显式返回它。该缓存随 MCP 进程生命周期存在，进程重启后必须重新运行 `causal_analyze`，不会假装从不存在的账本恢复。结果会明确区分 `potential` 静态关系、`observed` 运行时关系和 `confirmed` 干预证据；同时返回 `unknowns`、`relationGaps`、`recommendedProbes`、`uncoveredSeeds` 和截断原因。没有重放或故障注入时，反事实支持为 `unknown`，排序分不是概率。

`causal_analyze` 还会返回 `triage`：`analyze` 表示证据足够，可直接给结论；`analyze_and_clarify` 表示已有有界候选，应先展示当前发现，再最多询问一个能区分候选的问题；`clarify_first` 表示没有可验证锚点或没有命中代码节点，工具不会继续全仓库盲目扩散。用户主动提供 `query`、`seedIds`、日志或运行时事件时视为明确证据，不要求重新描述。

## 本地验证

```powershell
npm.cmd install
npm.cmd run check
npm.cmd test
```

插件不会初始化或重建 CodeGraph，不读取私有 SQLite，不自动修改源码，也不执行重启、清缓存或生产 probe。索引不健康时会停止静态分析；RTK 压缩失败时保留原始错误并仅使用受限、已脱敏的日志窗口，结果标记为 `bounded_raw`，不会伪造完整压缩结果。
