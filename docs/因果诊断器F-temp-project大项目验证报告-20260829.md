# 因果诊断器 `F:\temp-project` 大项目验证报告

## 结论

说明：本报告中的四项目耗时、排名和 `state=complete` 数字来自 2026-08-28 的原始验证快照；2026-08-29 修复后的插件增加了双向邻域、索引健康门、运行时时间顺序关系、未决关系和受限日志降级字段，历史数字不应与修复后运行结果混用。修复后对前三个快照的 SDK smoke test 仍可运行；LiteLLM 快照因检测到两个未纳入索引的变更文件而被健康门明确阻止，未伪造分析结果。

这项工作有价值，但价值点已经被验证为“先用程序编译高密度证据，再让 AI 做全局解释和取舍”，不是“只靠静态图自动找到所有根因”。

本轮从 `F:\temp-project` 选择了四个大型开源项目的真实修复提交，使用修复前 parent 快照做只读验证：

- CodeGraph 可以在大型仓库上建立可查询的静态关系图；本轮最大快照为 `6,503` 个文件、`124,605` 个节点和 `349,068` 条边。
- `causal_status` 在四个快照上均为 `state=complete`、`stale=false`、`pendingReferences=0`。
- 给出错误堆栈/日志中的源码位置后，四例都能把观测映射到对应文件或函数；Gemini、Envoy、LiteLLM 的目标节点进入 Top-1，Codex 的目标文件进入 Top-2。
- 只给模糊自然语言而没有运行时位置时，Gemini 和 LiteLLM 会被泛化词带到无关 UI/测试节点，Envoy 也可能把同名调用方排在目标前面。因此不能把自然语言召回或静态调用关系当成完整因果事实。

结论是：继续做是值得的，正确的产品边界应是“证据编排和候选收敛器”，而不是另一个声称可以自动证明根因的 LLM。第一阶段不应承诺所有 Bug 两次调用解决，也不应承诺没有日志时仍能稳定找全。

## 测试范围与真值

所有源码均从本地 `F:\temp-project` 仓库或 GitHub 固定提交下载到临时隔离目录：

`C:\Users\Administrator\AppData\Local\Temp\causal-debugger-temp-project-20260828`

原始 `F:\temp-project` 工作区未切换分支、未写入索引、未修改源码。每个样本的真值来自上游修复提交及其 parent 的实际 diff：

| 项目 | 修复提交 | 修复前 parent | 上游修复含义 |
| --- | --- | --- | --- |
| [`openai/codex`](https://github.com/openai/codex) | [`c0d59bf`](https://github.com/openai/codex/commit/c0d59bf6147c83d067e257e858b928f81820ab50) | `a3cb1c14fbef105029b99f28951ee240ea4cadff` | 在 `codex-rs/tui/src/resume_picker.rs` 补上 `ThreadHistoryMode` import，修复恢复选择器编译/运行路径缺失依赖。 |
| [`google-gemini/gemini-cli`](https://github.com/google-gemini/gemini-cli) | [`d55e366`](https://github.com/google-gemini/gemini-cli/commit/d55e366f6ab393e024c613d940fead3696d56eac) | `dc859e8e48868ef5d1cc3b6708dbbdf3817cb9c9` | 在 `googleQuotaErrors.ts` 将 `MODEL_CAPACITY_EXHAUSTED/EXCEEDED` 无退避时分类为终止错误，避免同一模型重试挂起。 |
| [`envoyproxy/ai-gateway`](https://github.com/envoyproxy/ai-gateway) | [`a3cf457`](https://github.com/envoyproxy/ai-gateway/commit/a3cf457f8eae479c9d161cbe5ccdb40f94a31aa7) | `eb97936d0eecdb6701a31fde693644e4653adde4` | 在 `openai_awsbedrock.go` 将流式 marshal 失败从 `panic` 改为返回 error，并补充空输出防护。 |
| [`BerriAI/litellm`](https://github.com/BerriAI/litellm) | [`249a999`](https://github.com/BerriAI/litellm/commit/249a99950675fd85c8837df650394bf6e9bf5905) | `5e23a5ab053f56a88cb41a3bc468ae9f61841891` | 在 Responses 流式迭代器中对 `RESPONSE_FAILED` 等 in-stream error 生成 `APIError` 或 `MidStreamFallbackError`，避免错误事件被静默透传。 |

## CodeGraph 建图结果

| 项目 | 文件 | 节点 | 边 | 语言覆盖（主要） | 建图状态 |
| --- | ---: | ---: | ---: | --- | --- |
| Codex | 3,980 | 129,672 | 461,471 | Rust 3,086、TypeScript 679、Python 146 | `complete` |
| Gemini CLI | 2,301 | 30,026 | 124,119 | TypeScript 1,726、TSX 418、JavaScript 71 | `complete` |
| Envoy AI Gateway | 766 | 11,528 | 42,186 | Go 525、YAML 215 | `complete` |
| LiteLLM | 6,503 | 124,605 | 349,068 | Python 4,752、TSX 986、TypeScript 333 | `complete` |

CodeGraph 支持列表由 `causal_status` 直接返回，包含 TypeScript、TSX、JavaScript、Python、Go、Rust、Java、C/C++、C#、PHP、Ruby、Swift、Kotlin、Dart、Scala、Lua、Terraform、Nix、Svelte、Vue、Astro、Liquid 等。CSS/SCSS 仍不在该列表中，本轮没有另行添加解析器。

## 因果分析结果

每例先调用 `causal_status`，再调用 `causal_analyze`，参数为 `maxDepth=3`、`limit=160`、`beamWidth=24`。运行时事件使用与真实故障一致的错误码、消息和源码位置。下表的耗时是本机单次 MCP 调用观测值，包含一次独立 Node MCP 进程的启动开销，不代表生产 SLA。

| 项目 | `causal_analyze` 耗时 | 运行时位置映射 | 目标候选排名 | Top-1 候选 | 结果判断 |
| --- | ---: | --- | ---: | --- | --- |
| Codex | `403 ms` | `resume_picker.rs:107` -> `SessionTarget`，support `0.8` | 文件第 2；结构体第 1 | `SessionTarget`，score `0.392` | 文件级命中；需要再由 AI 判断 import 缺失而不是把结构体当最终根因。 |
| Gemini CLI | `193 ms` | `googleQuotaErrors.ts:333` -> `classifyGoogleError`，support `0.8` | 第 1 | `classifyGoogleError`，score `0.392` | 函数级命中；与修复 diff 直接一致。 |
| Envoy AI Gateway | `160 ms` | `openai_awsbedrock.go:740` -> `ResponseBody`，support `0.8` | 第 1 | `openAIToAWSBedrockTranslatorV1ChatCompletion::ResponseBody`，score `0.46325` | 函数级命中；避免被同名 `ResponseBody` 调用方误导。 |
| LiteLLM | `382 ms` | `responses/streaming_iterator.py:249` -> `_process_chunk`，support `0.8` | 第 1 | `BaseResponsesAPIStreamingIterator::_process_chunk`，score `0.392` | 入口函数命中；修复实际新增的是该函数后续的错误升级/回退处理。 |

四例的 `coverage.unknownFindings` 均为 `0`，但这只表示本次输入的运行时位置能够映射到 CodeGraph 节点，不表示因果关系已经被证明。原始验证没有干预或重放证据，因此按修复后的引擎语义，反事实字段应为 `support=unknown`，而不是把静态拓扑删除结果当成已验证因果。

## 模糊描述对照

同一批修复前快照只传一条自然语言描述，不传 `runtimeEvidence`：

| 项目 | 模糊描述下目标情况 | 加入源码位置后的变化 |
| --- | --- | --- |
| Codex | `resume_picker.rs` 文件第 2 | `SessionTarget` 第 1，文件第 2 |
| Gemini CLI | 目标文件/函数未进入前 10 | `classifyGoogleError` 第 1 |
| Envoy AI Gateway | `openAIToAWSBedrockTranslatorV1ChatCompletion` 结构体第 4，前面有无关测试和响应节点 | `ResponseBody` 第 1 |
| LiteLLM | 目标流式迭代器未进入前 10 | `_process_chunk` 第 1 |

这正好验证了预期工作流的关键取舍：程序可以一次性展开相关静态关系，但必须先把日志、堆栈、trace/span、失败测试位置或配置键转换成结构化观测。没有这些锚点时，程序只能做词法/符号召回，无法可靠区分同名函数、测试代码、调用方和真正故障源头。

## 对“减少调用、减少 token、减少遗漏”的回答

已验证的收益：

1. AI 不必先反复 `grep` 才知道一个符号有哪些调用方、被哪些测试覆盖、位于哪条静态关系路径；一次 `causal_analyze` 就能得到有界子图、多个候选、观测映射、关系类型和未知项。
2. 运行时位置可以把候选从整个仓库收敛到目标函数/文件，四例的本地分析调用均在亚秒级完成。
3. 返回结果保留候选列表而非单一答案，AI 可以直接比较主假设、备选假设和缺失证据；这比模型自行逐层搜索更适合处理“先全局看，再决定补查什么”。

尚未验证、不能宣称的收益：

- 没有做“普通 AI 逐次 grep”与“证据包一次输入”的受控 token/延迟 A/B，因此不能给出固定倍数节省。
- 不能保证模糊自然语言独立召回全部关系；本轮 Gemini、LiteLLM 的模糊样本已经反例证明这一点。
- CodeGraph 的 `calls`、`references`、`imports` 是静态结构证据，不等于运行时因果；动态分派、反射、配置注入、跨服务网络调用仍需 trace、日志或定向 probe。
- `truncated=true` 的样本必须在结果中显式显示截断，不能把有界子图包装成“全仓库完整图”。

## 建议的实现边界

继续实现时建议保持以下流水线：

1. CodeGraph 负责静态结构召回和可审计的节点/边身份。
2. 确定性证据层负责解析 stack、日志、trace/span、失败测试、配置键和变更文件；无法映射时输出 `unknown`，不静默猜测。
3. RTK 先压缩日志和控制台输出，再把压缩后的事件注入分析；保留原始文件位置和摘要哈希以便回溯。
4. 因果引擎只做有界扩散、路径合并、候选评分、冲突/缺口标记和反事实字段生成；静态边统一标为 `potential`，运行时证据才可标为 `observed`。
5. AI 接收紧凑证据包，负责全局解释、假设排序和提出最小补查，不再自行从仓库根目录开始无界搜索。
6. 当没有运行时锚点或图被截断时，AI 必须收到明确的“证据不足”与下一步定向查找建议。

## 验收建议

这批样本适合作为跨语言回归样本，但不足以放行生产级能力。正式 Gate 仍应补充至少 20 个历史 Bug、3 个以上仓库、6 类故障类别，每例重复 3 次，并记录：

- Top-1/Top-3 根因命中率和关键关系召回率；
- 普通搜索工作流与证据包工作流的模型调用次数、输入 token、总延迟；
- 高置信误判率、未知项是否被正确暴露、截断是否被正确传播；
- 跨服务 trace、动态分派、配置驱动和多故障叠加案例。

在这些门槛通过前，建议把插件定位为只读“全局证据准备器”，不要让它自动修改源码或把候选分数当成确定根因。
