# 因果调试器插件

这是一个只读的 Causal Debugger 可运行插件。它将 CodeGraph 静态关系、日志/堆栈观测和有界因果假设编译成一次性分析包，供 Codex 在全局视角下定位问题。

## 工具

- `causal_status`：检查项目 CodeGraph 索引状态、规模、语言和待处理引用。
- `causal_analyze`：按症状查询或精确节点生成有界因果分析；静态邻域同时展开上游和下游关系，可传入已压缩运行时事件或日志文件。

分析结果会明确区分 `potential` 静态关系、`observed` 运行时关系和 `confirmed` 干预证据；同时返回 `unknowns`、`relationGaps`、`recommendedProbes`、`uncoveredSeeds` 和截断原因。没有重放或故障注入时，反事实支持为 `unknown`，排序分不是概率。

## 本地验证

```powershell
npm.cmd install
npm.cmd run check
npm.cmd test
```

插件不会初始化或重建 CodeGraph，不读取私有 SQLite，不自动修改源码，也不执行重启、清缓存或生产 probe。索引不健康时会停止静态分析；RTK 压缩失败时保留原始错误并仅使用受限、已脱敏的日志窗口，结果标记为 `bounded_raw`，不会伪造完整压缩结果。
