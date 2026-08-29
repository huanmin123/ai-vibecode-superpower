# CodeGraph 验收测试报告

> 版本说明：第 2、3 节的 fixture 数值是 `1.5.0` 的历史黑盒基线，保留用于回归对比。本次统一升级到 `1.6.0` 后，已通过公开 SDK 的只读 smoke：当前仓库索引 `getIndexState() = complete`、`isIndexStale() = false`、`getIndexBuildInfo().version = 1.6.0`、`extractionVersion = 25`；完整 fixture 回归仍需单独补跑后才能更新下方历史数值。

## 1. 结论

当前受管的 `@colbymchenry/codegraph@1.5.0` **可以作为 Causal Debugger 的静态结构图 Provider，但不能单独满足因果诊断引擎的全部要求**。

它已经足够支撑当前阶段的代码结构层：节点定位、跨文件导入、部分调用关系、反向调用者、影响半径、路径查询、索引健康状态和增量变更检测。因果诊断器仍必须自己实现因果中间表示、运行时证据绑定、跨服务/数据库/消息关系、关系评分、假设追踪和反事实验证。

当前不能对外承诺“所有目标语言都能得到完整调用链”或“仅靠 CodeGraph 秒级定位真实根因”。目标语言范围采用 CodeGraph 运行时支持的全部语言，但每种语言仍需独立能力矩阵；Java 实例方法调用和动态语言运行时关系需要明确的未知状态或运行时证据。

## 2. 测试环境与范围

- 平台：Windows，PowerShell 7
- Node.js：`22.19.0`
- CodeGraph CLI：`1.5.0`
- SDK：`@colbymchenry/codegraph@1.5.0`
- SQLite backend：`node-sqlite`
- Journal mode：`wal`
- 测试方式：临时 fixture，未修改仓库和用户项目
- fixture 内容：JavaScript、TypeScript、Go、Rust、Java 的跨文件 `entry -> helper -> sink` 链

测试使用 CLI 和公开 SDK；没有读取 `.codegraph/codegraph.db` 私有表，也没有依赖内部 schema。

## 3. 黑盒结果

| 能力 | 结果 | 证据与限制 |
| --- | --- | --- |
| 初次索引 | 通过 | 22 个代码文件在约 205 ms 完成小型 fixture 索引；不代表中大型仓库冷启动时间 |
| 索引状态 | 通过 | `getIndexState() = complete`、构建版本 `1.5.0`、extraction version `24`、`isIndexStale() = false` |
| 节点定位 | 通过 | `getNode(id)`、`getNodesInFile()` 能返回语言、限定名、文件、行列和签名 |
| JS/TS 导入调用 | 通过 | 跨文件 `calls` 边可用，metadata `resolvedBy=import`、静态解析置信 `0.9` |
| Go 调用 | 有条件通过 | 同包调用可连出，但本样本为 `resolvedBy=exact-match`、置信 `0.4`，不能直接当作高可信事实 |
| Rust 调用 | 通过 | 模块调用可连出，样本为 `resolvedBy=import`、置信 `0.9` |
| Java 静态调用 | 通过 | `Helper.helper()` 形式可连出，样本为 `resolvedBy=qualified-name`、置信 `0.85` |
| Java 实例调用 | 不完整 | `new Helper().helper()` 只产生 `instantiates -> Helper`，没有 `calls -> Helper.helper`；同样适用于 `new Sink().sink()` |
| 同名 Java 类型消歧 | 需回归 | 同一索引放置不同包的同名 Java 类型时，观察到 qualified-name 调用边可能指向另一同名方法；当前阶段必须加入回归样本并在不确定时降级为未知 |
| 反向调用者/调用图 | 通过 | SDK `getCallers()`、`getCallees()`、`getCallGraph()` 可按节点 ID 查询 |
| 影响分析 | 通过 | `getImpactRadius()` 返回受影响节点和边；结果是潜在影响，不是运行时因果 |
| 路径查询 | 通过 | `findPath()` 能返回 JS `entry -> helper -> sink` 的节点和行号 |
| 支持语言枚举 | 通过但需运行时核对 | SDK 暴露 CodeGraph 当前全部支持语言；清单不等于每种语言在当前项目中的关系完整度 |
| 增量变更检测 | 通过 | 修改文件后 `getChangedFiles()` 正确报告 `modified` |
| pending 状态 | 不能单独作为健康门 | 未启动 watcher 时 `getPendingFiles()` 为空，即使 `getChangedFiles()` 已有修改；适配器必须联合检查 |
| 缺少索引 | 通过失败路径 | `CodeGraph.open(..., readOnly:true, sync:false)` 返回明确的“未初始化”错误 |
| SDK 查询延迟 | 小样本通过 | 22 文件 fixture 中，10 次 warm open 平均约 5.6 ms，图查询平均约 0.32 ms；不外推到大型仓库 |

## 4. 对 Causal Debugger 的直接影响

### 4.1 可以复用的部分

CodeGraph 负责以下静态事实，并由适配器保留原始 ID 和来源：

- 文件、类、函数、方法和导入节点；
- `contains`、`calls`、`imports`、`extends`、`implements` 等结构边；
- 节点行号、签名、语言和限定名；
- 调用者、被调用者、影响半径、最短路径和遍历；
- 索引状态、构建版本、extraction version、文件变更和待解析引用数量。

CodeGraph edge metadata 中的 `confidence` 是静态引用解析提示，不是故障因果概率。适配器必须将它映射为 `static_resolution_score`，不能直接填入因果 `strength` 或假设概率。

### 4.2 必须由 Causal Debugger 自己补齐的部分

- `http`、`db`、`message`、`data_flow`、`temporal` 等关系；
- 日志、Trace、Metrics、Stack Trace 到节点 ID 的解析和时间窗口绑定；
- `potential`、`observed`、`confirmed` 三种关系状态；
- 多假设 Beam Search、冲突/缺失证据、先验和可解释排序分；
- 反事实 probe、重放结果和历史反馈校准；
- Java 实例调用的补充推断或明确的未知节点；
- CodeGraph 支持语言之外的文件类型不进入静态图，并返回 `unsupported_file_type`。

## 5. 设计调整与硬门禁

1. 静态图访问统一走 `StaticGraphProvider` 接口，首个实现为 `CodeGraphProvider`；不把 CodeGraph 类型直接扩散到因果分析器。
2. 所有查询使用完整节点 ID 或 `filePath + qualifiedName + kind`，禁止用裸的 `entry`、`helper` 等名称作为唯一定位键。
3. `causal_status` 必须联合检查 `getIndexState()`、`getIndexBuildInfo()`、`isIndexStale()`、`getChangedFiles()`、`getPendingReferenceCount()` 和 watcher 降级状态；`getPendingFiles()` 为空不能证明索引新鲜。
4. Java 只有在静态/实例调用回归测试通过后，才能宣称“调用链支持”；否则输出 `partial` 和证据缺口。
5. 同名类型、重载、反射、代码生成和动态注册必须进入负例测试；解析器无法唯一消歧时，保留候选集合并降低静态分。
6. 首次索引、warm 分析和增量同步分开统计；“秒级”只作为已建立健康索引后的有界分析目标，不能覆盖冷启动。

## 6. 当前阶段判定

| 目标 | 判定 |
| --- | --- |
| 用现成工具快速得到多语言静态结构图 | 达到，CodeGraph 可复用 |
| 用静态调用/影响关系缩小 AI 搜索范围 | 达到，但必须使用节点 ID、预算和截断状态 |
| 直接得到跨服务真实因果链 | 未达到，需要运行时证据和领域关系适配器 |
| 直接对全部关系进行可靠因果打分 | 未达到，需要 Causal IR 和评分校准 |
| Java 所有常见调用形式 | 未达到，实例调用存在缺口 |
| 作为独立产品的价值 | 有价值，核心差异在因果层而不是重新写一套通用解析器 |

因此，CodeGraph 适配器和全语言能力矩阵仍是必要底座，但不再直接进入完整 M0。真实项目验证显示，模糊自然语言 `buildContext` 在两个历史 Bug 中均未召回生产真值文件，而事件生命周期补全与 CodeGraph 调用传播可以找回 EPIPE 关键链。项目应先完成 M-1 盲测和关系补全器 Spike，把 Java 实例调用、同名消歧、索引新鲜度、关键关系召回和修复后误报列为阻塞性质量门。详细结果见 [`因果诊断器真实项目可行性验证.md`](因果诊断器真实项目可行性验证.md)。
