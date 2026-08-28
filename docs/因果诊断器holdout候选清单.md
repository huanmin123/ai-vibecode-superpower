# 因果诊断器 Holdout 候选清单

> 状态：候选登记，不等于已纳入最终门禁。登记日期：2026-08-28。

正式评估要求规则设计集与 holdout 分离。下表记录从本机 Git 历史发现的候选修复及其当前冻结/验证状态；冻结前仍需人工确认症状、根因文件、关键关系和修复后回归测试，并生成不可变修复前快照。

| repositoryId | 语言/形态 | 修复提交 | 修复前提交 | 候选问题类别 | 变更范围 |
| --- | --- | --- | --- | --- | --- |
| `fast-boot` | Java | `f6b1f11b40ba3ce14e3bc07211566482571932a3` | `4438056bceb317e4275a529592122af29273e3cd` | `event_lifecycle` | Bean 生命周期字段覆盖，已作为首个 Spike |
| `juhe-ai` | Python | `a2f79fbb34cdd7a938bff1bbddd8b1e5e5274c59` | `8586da5b2e5603d9d1079314ee48a091baafeda4` | `async` | 浏览器代理错误页与导航边界；修复前快照已归档到临时目录 |
| `juhe-ai` | Python | `92a22c22a99c15b01801de65147e3b0b19ccde1c` | `eaee22c2ce82369e6309b831214f5c50a4f3ed07` | `async` | 跨服务 timeout grace，已完成 tool-limited Spike，关系漏召回 |
| `juhe-ai` | Python | `d43f18b411f638751f81140e5ba6f3dc07c63ab7` | `ec10d06ea8852403e35b707e277b9211ad653bd0` | `async` | 请求 deadline 与清理顺序 |
| `sub2api-lite` | TypeScript/Go | `429170e0dab78e86e4f55881e6e3230d0fb75502` | `ca25ff3d057de6a071c75944792ed6c5ad317ccd` | `database` | 审计查询连接池 idle 上限；修复前快照已归档到临时目录 |
| `ai-automate-contro` | Python | `2c99fa2fe9130b83657e4f13e337f42b2ddbd20a` | `057a0760cddb6f9876be3d528ba82a6f08cc1421` | `single_file` | OCR 配置路径与错误诊断；已完成多仓库 Spike |
| `sub2api-lite` | TypeScript/Go | `86d958507a00d74c71d031751477c02b5a011f38` | `9057f7f23d517e7e97974dffc73ec7ac09f76e55` | `configuration` | 嵌套 PostgreSQL schema owner；已完成多仓库 Spike |
| `sub2api-lite` | Go | `7e560a20305251f1c41044756159e3dd89909004` | `32ca1b5c51ca50330cc0c21105867294a56e8dfc` | `event_lifecycle` | account-health 新 revision 状态推进；已完成多仓库 Spike |
| `sub2api-lite` | Go | `a4e178c9673c149eb4d320b52213feeae99624f6` | `e733eeaa468c04c3a4b21a1eb7c3549502a71e50` | `async` | balance runner 并发上限；已完成多仓库 Spike |
| `ai-automate-contro` | Python | `75099f824ed014a5d9d534e2dd527a2edbe6c76b` | `057a0760cddb6f9876be3d528ba82a6f08cc1421` | `single_file` | macOS 真实桌面组件自检覆盖；已冻结 CodeGraph packet，尚未纳入模型计分 |
| `sub2api-lite` | Go | `81428b534495a2c5033e896d3c9c98ed3484d5f8` | `8cfd124794fbde8ce5102fd23d1de51418ec8ee0` | `database` | table monitor PostgreSQL 参数类型修正；已冻结并完成补充 Spike，未计入正式 gate |
| `sub2api-lite` | Go | `8a433da16a35fb98bd6d2b63bb489526c8583bfe` | `3a542d13d480f351dec4011e394def896e174e58` | `configuration` | F4 schema bootstrap deadline；已冻结并完成补充 Spike，未计入正式 gate |
| `CLIProxyAPI` | Go | `0b2ce80fcb81f784e995ba07691f8d954d729197` | `58ef846ff0cc0c17ed301d9e47a84de0cdaf8c81` | `configuration` | Codex OAuth credential filename 未包含 account hash；已冻结并完成补充 Spike，未计入正式 gate |
| `CLIProxyAPI` | Go | `9f4f53ca5a4d1474e3f7eb61d6ffc984995f1f66` | `4231ad6e2a93040aa50b4aa918cc67adebc86a4c` | `cross_service` | XAI `/responses/compact` 错误复用 CLI chat-proxy base URL；已冻结并完成补充 Spike，未计入正式 gate |
| `fast-boot` | Java | `690686e4be703765c08dc48db83e9dc5b61f9e66` | `f6b1f11b40ba3ce14e3bc07211566482571932a3` | `single_file` | 验证组继承与 Default 组匹配；已冻结并完成补充 Spike，未计入正式 gate |
| `sub2api-lite` | Go | `ccd0ff196260c3cc8c8500490cded15fed56b219` | `2538141f4e1b64564300fb477522ed38ac1e84eb` | `configuration` | deployed account-health/table-monitor 并发上限 512；已冻结并完成补充 Spike，未计入正式 gate |
| `CLIProxyAPI` | Go | `73294372970c8f5d285cd17170918f465bda36ca` | `7d2883e745d3d8fe3ca6b796f3feec2ac49c94ec` | `event_lifecycle` | 上游 WebSocket `1009` 未作为 request-scoped 错误下传，导致客户端异常断开/错误凭据切换；已冻结并完成补充 Spike，未计入正式 gate |
| `CLIProxyAPI` | Go | `e73aad2e0afea07a3433a0fa0440f21cac2b339e` | `ceaeb75d5371fb01fead81e7c7bac8496a78663f` | `configuration` | 非模板 Codex 模型错误暴露 tool search；已冻结并完成补充 Spike，未计入正式 gate |

`a2f79fbb34cdd7a938bff1bbddd8b1e5e5274c59` metadata 候选已按盲序完成冻结：在 parent `8586da5b2e5603d9d1079314ee48a091baafeda4` 的归档快照中，针对 `MetadataBrowser._fetch_metadata` 的 CodeGraph 精确文件读取耗时 `460 ms`。packet SHA-256 为 `e3e78d03c059c93d5f6b87b6c7d9c1449c9cd2e41888113374e2e2f965e4c7b9`，内容引用 `metadata-service/src/metadata_service/browser.py`，冻结 claim 为“metadata 成功需要非错误 HTTP 页面”（旧代码 `absent`）。随后揭示的修复在相同函数中对 `HTTP >= 400` 追加 `http_error` 诊断并跳过 metadata 提取，同时把 proxy 和 direct 导航预算拆为 `5s` / `20s`；根因文件和关键关系与冻结 packet 一致。该候选已通过溯源校验，并完成一轮真实模型 Spike；详见 `因果诊断器真实项目可行性验证.md` 第 15 节。

`sub2api-health-outcome` 曾完成一轮真实模型 tool-limited Spike，两臂均超时。但 2026-08-28 新增的 packet 溯源校验发现其冻结 packet（SHA-256：`8442f747c31a16d2fa2794393ad7934c797dedc229fe3632d4bf0cbc562d8af9`）没有引用 claim 所指的 `scheduler.go`；该案例和 k8s 一样不能再作为合格 holdout，历史运行仅保留为早期 runner 失控记录。

`429170e0` 数据库候选也已完成盲标：修复前 `createPostgresBackend` 将 F3 查询池 `max` 上限设为 32，修复后收紧为 10。CodeGraph focused 查询耗时 `1,019 ms`，packet SHA-256 为 `fb1f810639e92a19759e40ce52b1cdbc67022bceaf47f4024d42f9967a9b9b4a`；关键关系为 `createPostgresBackend -> audit-query-pool-idle-client-limit-10`（旧代码 `absent`）。该案例已完成独立真实模型 Spike：assisted 在 `75,034 ms`、2 次工具调用、input `99,201` 内命中根因和关系；baseline 在第 9 个工具调用触发 runner 上限。详见 `因果诊断器真实项目可行性验证.md` 第 17 节。

`k8s` 内存候选曾完成盲标：修复前 test overlay 的 `node-runtime` 仅有 `1Gi` limit，修复后在相同 Pod 预算内提高到 `1536Mi`，同时压缩 Go sidecar 资源。CodeGraph 查询耗时 `532 ms`，packet SHA-256 为 `f4c583c6ce71a6b1dccc1cb75b5b5e4a5b2b528259e61dfae3c9a48789f86df9`；关键关系为 `node-runtime.resources.limits.memory -> test-runtime-memory-priority-within-pod-budget`（旧代码 `absent`）。2026-08-28 复核发现，该 packet 的 `claims` 指向 `apps/juhe-ai/overlays/test/slot-b/statefulset.yaml`，但 content 实际只有监控/Python 文件，没有该 YAML 文件引用。新的“claim 引用必须在 content 中可追溯”硬校验因此拒绝该 packet；此候选已移出 holdout 队列，不运行模型。由于修复已揭示，不能事后重建 packet 计分；后续需从新的、未揭示的配置候选重新冻结。

冻结前必须用 `git rev-parse` 写入完整 40 位提交。候选之间不能共享同一个设计规则后再计分；同仓库多个候选应随机抽样，并检查是否存在同一修复链条导致训练/验证污染。

## 冻结步骤

1. 在修复提交的 parent 上用 `git archive` 生成只读目录；不创建 worktree，不修改原仓库。
2. 在揭示修复提交前生成 CodeGraph/规则证据，记录工具版本、查询参数、墙钟时间、原始字节 SHA-256 和规范化 `claims`。
3. 单独保存修复后提交、测试和人工真值；模型 runner 只拿到 run task，不可读取 suite、后续 Git 历史或真值。
4. 先完成每个候选的 deterministic evidence audit，再把通过审计的案例加入正式 suite。

候选在归档前还必须通过隔离性筛选：修复提交不得同时承载无关功能、迁移或大规模文档重写；`git show --stat` 必须能让人工将症状、根因文件和回归行为归因到同一小范围变更。仅凭 `fix(...)` 标题不够。

当前清单仍没有 Rust 候选，也没有达到 20 个 Bug、6 个类别和 3 次重复；多仓库 Spike 已达到 3 个仓库但不能替代正式门禁，因此不能据此启动完整插件实现或宣称 Go。

### 新增候选链（尚未计分）

`ai-automate-contro` 的 `75099f824ed014a5d9d534e2dd527a2edbe6c76b` 在 parent `057a0760cddb6f9876be3d528ba82a6f08cc1421` 上归档并建立 CodeGraph，focused 查询耗时约 `842 ms`。修复提交揭示前生成的 packet SHA-256 为 `d859208664372b1c04552df1ec8b8f6f82a8980c55ebb0b1c84fb11e165c2701`，claim 引用 `src/ai_automate_contro/app/desktop_component_check.py:self_check_desktop_components`，通过内容可追溯校验。随后复核发现 `acabf6bf3ba7c92b404d117512e0a3fc84f1ae39` 是同一桌面自检链的前置提交，且 `75099f8` 继续修改相同模块；两者不能拆成两个独立 holdout。该链仍需补齐冻结症状、独立真值和回归测试后，才可决定是否进入 suite。

`sub2api-lite` 的 `81428b534495a2c5033e896d3c9c98ed3484d5f8` 是独立的单文件 PostgreSQL 参数类型修复。parent `8cfd124794fbde8ce5102fd23d1de51418ec8ee0` 已归档并建立 CodeGraph；focused 查询耗时约 `1,137 ms`，packet SHA-256 为 `97d6b6d6a857506d4ded02aad8cadace9381f4e33bb80a7d6bc61cb04e274d29`。揭示前 claim 指向 `backend-go/projects/jobs/internal/tablemonitor/store.go:Store`，揭示的修复把 PostgreSQL `VALUES` 占位符显式转换为 `int/text/timestamptz`，与“参数类型安全”关系一致。该候选已完成一轮补充 runner Spike，但因 baseline 工具上限失败且 assisted 超 token 门槛，不能贡献正式门禁指标。

`sub2api-lite` 的 `8a433da16a35fb98bd6d2b63bb489526c8583bfe` 是独立的 F4 schema bootstrap deadline 修复。parent `3a542d13d480f351dec4011e394def896e174e58` 已归档并建立 CodeGraph；packet SHA-256 为 `4b9d7e846db7600aad0752c557db9aa1d0dfef1bb058064abe491b09da9b7df4`，快照 ZIP SHA-256 为 `9e06f3077153aee3ac66616c68e3b0d402f1691fdfb452bff21bdae3ef01bb9e`。首轮模型运行因 observation 枚举错误失败；升级为 `debug-v5-enum-guard` 后 assisted 通过协议但 Top-1 高置信误判，baseline 再次工具上限失败，因此仍不计入正式 gate。

`CLIProxyAPI` 的 `0b2ce80fcb81f784e995ba07691f8d954d729197` 是独立的 Codex OAuth credential filename 修复。修复前 parent `58ef846ff0cc0c17ed301d9e47a84de0cdaf8c81` 已归档并建立 CodeGraph；focused 查询耗时约 `812 ms`，packet SHA-256 为 `91d74b7dd90f960fbb435fba23ca0921139f487cf73daacc9cc4e3a1ab484f50`，快照 ZIP SHA-256 为 `9e566197a1fbad1d08bacb5f6582f41871809cd73c83c62248541beece7f8e7c`。揭示修复后，`CredentialFileName` 对所有有 account hash 的计划类型将 hash 写入文件名，与冻结的 absent identity relation 一致。该候选已完成一轮补充 runner Spike，但不能贡献正式门禁指标。

`CLIProxyAPI` 的 `9f4f53ca5a4d1474e3f7eb61d6ffc984995f1f66` 是独立的 XAI compact upstream 路由修复。parent `4231ad6e2a93040aa50b4aa918cc67adebc86a4c` 已归档并建立 CodeGraph；focused 查询耗时约 `906 ms`，packet SHA-256 为 `a4a3fa3622e1273178e072ce33e484a342ff19f5be6e4d79ce12ae6a48d33a91`，快照 ZIP SHA-256 为 `f2c3bd74e8b612d161be7c33f7ba788a7fed4c748ff55cccccc9ad5b2f2473a7`。冻结 relation 为 `executeCompactRequest -> dedicated compact base URL`（旧代码 `absent`）；修复后新增 `xaiCompactBaseURL`，使 `/responses/compact` 不再走会返回 404 的 CLI chat proxy，且新增端点与 header 回归测试。该候选已完成一轮补充 runner Spike；正式 report SHA-256 为 `66b930bf9f2d09a7c0cc186417098b030f5a8b0e011c7a1985b4a810b11e7d42`，决定为 `insufficient_data`。

`fast-boot` 的 `690686e4be703765c08dc48db83e9dc5b61f9e66` 是与既有 Bean 生命周期案例不同模块的 validation group 修复。修复前 parent `f6b1f11b40ba3ce14e3bc07211566482571932a3` 已用 `git archive` 固定为独立快照，ZIP SHA-256 为 `89874f6116044e109c0eb7ef68aa599094a62197e47e6cb1a8353ec0cf07e30d`；CodeGraph 索引包含 510 个文件、7,691 个节点和 13,245 条边。揭示修复前，针对 `ValidationEngine.shouldVerifyByGroup` 的 packet 已冻结，SHA-256 为 `69db4c36c5bd8522b9509c490293c3659a57e7bc3b499444a03b914b4dc94251`，claim 为“验证组继承关系应被匹配”，旧代码 observation 为 `absent`。揭示的修复将精确集合匹配改为 `annotationGroup.isAssignableFrom(activeGroup)`，并明确 Default 组行为，与冻结关系一致。该候选已完成一轮补充 runner Spike：assisted `20,570 ms`、input `22,928`、关系召回 `1.00`；baseline `98,254 ms`、input `303,551`、关系召回 `0`。report SHA-256 为 `9968f6593148fd35faa8332549f037e40125c8cde7e0543e2a2820ea32d3d005`，决定为 `insufficient_data`，不能贡献正式门禁指标。

`sub2api-lite` 的 `ccd0ff196260c3cc8c8500490cded15fed56b219` 是 account-health 与 table-monitor 的已部署并发配置修复。parent `2538141f4e1b64564300fb477522ed38ac1e84eb` 已归档，快照 ZIP SHA-256 为 `5dfc8a2eff70c286142d1f723d755454212e5579e2e29baa170aa313bf5bb066`；CodeGraph 索引包含 2,742 个文件、79,820 个节点和 300,932 条边。冻结的双关系 packet SHA-256 为 `c92be419495848c987ff4fd1851a86bb97ec1a87e3dc5096ccaec118a565065e`：两个 `LoadConfig` 都把并发上限限制为 256，导致部署值 512 被拒绝。揭示修复后，两个配置入口均改为接受 512，并有上界测试。该候选已完成一轮真实补充 Spike：assisted 在 `33,583 ms`、1 次工具调用、input `43,047` 内命中两个根因和两条关系；baseline 在 `180,000 ms` 超时，未产生 provider usage。report SHA-256 为 `9a6c0ae8614958a11ed5887c6852c9fd4d9a92d692ecfa70171354ac1eae6fe`，决定为 `insufficient_data`，不能贡献正式门禁指标。

`CLIProxyAPI` 的 WebSocket `1009` 候选在 parent `7d2883e745d3d8fe3ca6b796f3feec2ac49c94ec` 上按盲序冻结。CodeGraph 在 `859` 个文件上建立 `18,919` 个节点、`70,808` 条边，耗时约 `1.0 s`；冻结 packet SHA-256 为 `29297c4f8c2eb5080e6e99c88c538a508cd44f30bb314f2016063921a60be650`，快照 ZIP SHA-256 为 `c2e17dd278160bb654967cc4bd07ab6c7830800359a7a02036f2c2988ba2f32b`。冻结后揭示修复：`mapCodexWebsocketReadError` 将 `CloseMessageTooBig` 包装为 request-scoped 错误，`forwardResponsesWebsocket` 将上游 close code 映射回下游 WebSocket；因此根因跨 executor 与 handler 两个文件。一次真实 A/B 中，baseline 为 `97,334 ms`、4 次工具调用、input `204,436`；assisted 为 `26,332 ms`、1 次工具调用、input `59,399`，两臂均 Top-1 命中，时间下降约 `72.9%`、input 下降约 `70.9%`。严格关系匹配为 `0`：冻结 truth 的两条关系与 runner 的单条 assisted claim 并非同一稳定身份。plan/results/report SHA-256 分别为 `40fe6fc340189917e61b5597fa8f4f50cb2295c3d73eff6c4419203dc0a0c032`、`a902d5b32585a67e16b5f9b74db02c33fc02ba691320acd41f714d4f6dee0814`、`514f183038a68f1bdc0304466af67addf4d817d201473cf25ebe596f960e954c`；仍是单样本 `spike`，不能计入正式 gate。

`CLIProxyAPI` 的 tool-search-template 候选 `e73aad2e0afea07a3433a0fa0440f21cac2b339e` 在 parent `ceaeb75d5371fb01fead81e7c7bac8496a78663f` 上冻结。CodeGraph 索引为 811 个文件、17,972 个节点、67,244 条边；packet SHA-256 为 `9884c25037c48f5d9f71ae3a47ee53b568defea26af9e815871bd01f728d99f`，冻结 claim 使用稳定 ID `relation.codex-search.requires-template`。揭示 diff 仅在 `applyCodexClientSearchToolSupport` 的非模板分支提前清除 `supports_search_tool`，并更新对应回归测试，与冻结关系一致。一次真实 runner A/B 中 assisted 在 `59,925 ms`、input `86,759` 内 Top-1 命中且复述该关系；baseline 在 `180,000 ms` 超时，因此该候选仅计作独立 Spike 证据，不进入正式 gate。run-plan、results、report SHA-256 分别为 `7494fc2c435a0c584ad80620019c9fd4416967479f8dfd37acc21cc67f949289`、`6f2fba74861d5c148736cbc1f890550a14b33857b1eb1b963f59da35fc43a36c`、`607811da2fd6ca9e967b506a547e875ce0ac530512b34f64cc82aba8675709d`。


多仓库 Spike 的固定 suite 为 `multirepo-holdout-spike-v1-20260828`，包含上表中 5 个已揭示案例（其中 metadata 案例沿用前一节登记）。评估报告 SHA-256 为 `d87442bca50cdcb19f97a4b4dc35003f86636323e7091120ba5fa4abb59154b4`，决定为 `insufficient_data`；详细指标见 [`因果诊断器真实项目可行性验证.md`](因果诊断器真实项目可行性验证.md) 第 16 节。

## 已冻结跨仓库快照审计状态

以下 parent 快照已用 `git archive` 归档到本机临时实验目录，并核对 ZIP SHA-256。状态以当前 packet 溯源校验为准，不能仅因快照存在而重新纳入 runner suite：

| snapshot | 文件数 | ZIP SHA-256 | 当前状态 |
| --- | ---: | --- | --- |
| `holdout-juhe-metadata` (`8586da5b2e5603d9d1079314ee48a091baafeda4`) | 777 | `4db079ac9f2bdddfb068c71cfa1c8c043aa36b2dc1e02684521b223f5867bf29` | 合格 packet；已完成 1 次 holdout Spike，修复已揭示 |
| `holdout-k8s-memory` (`4ab49e261b22c8dcbbef456ace184dcc0f0de700`) | 412 | `66d51466ec76791a62c5762e5c0f583797ee82503d5fd9d415f6afde68e7fed6` | 排除：claim 文件未在 packet content 中出现 |
| `holdout-sub2api-db` (`ca25ff3d057de6a071c75944792ed6c5ad317ccd`) | 3,766 | `82fde45c065ff79780b15868e57ffa19f1a1de97ffa35095496dc746a0c68eb9` | 合格 packet；已完成 tool-limited Spike，但两臂超时 |
| `holdout-juhe-timeout` (`eaee22c2ce82369e6309b831214f5c50a4f3ed07`) | 770 | `49691abdcfa8f8d19fa5d693febbe0bb2cf8839fd166a37a8496d330b3e029ff` | 合格 packet；已完成 tool-limited Spike，未形成完整指标 |
| `holdout-sub2api-health-outcome` (`8228dce1fe2ecfacd19e7e5be3317e0052affc28`) | 3,766 | `3000b6e0ab07fb7566c0c574db9e988cc66549be471c2058c852086c94b8f1ca` | 排除：claim 文件未在 packet content 中出现 |
| `holdout-python-desktop-ocr` (`057a0760cddb6f9876be3d528ba82a6f08cc1421`) | 143（CodeGraph 索引范围） | `ccdff22f678a58002fcd88d36e80def4226a9642e041367b9e13d390b6fb2543` | 合格 packet；已完成 1 次多仓库 Spike |
| `holdout-sub2api-schema-owner` (`9057f7f23d517e7e97974dffc73ec7ac09f76e55`) | 2,740（CodeGraph 索引范围） | `f5fcaa19802aa66e26139e6e08bf3cf2d7b455dd34506da57faeb24aff74ecc96` | 合格 packet；已完成 1 次多仓库 Spike |
| `holdout-sub2api-revision` (`32ca1b5c51ca50330cc0c21105867294a56e8dfc`) | 2,684（CodeGraph 索引范围） | `ecf5a56a7c1b31ecd0db661c6d429e303d3ecfa331a904a6b5c5c1c6700045f7` | 合格 packet；已完成 1 次多仓库 Spike |
| `holdout-sub2api-balance` (`e733eeaa468c04c3a4b21a1eb7c3549502a71e50`) | 2,742（CodeGraph 索引范围） | `78ac5a2e2050923627772094f0b3427304054c8958766cea30e79a66a08cecd1` | 合格 packet；已完成 1 次多仓库 Spike |
| `holdout-python-component-check` (`057a0760cddb6f9876be3d528ba82a6f08cc1421`) | 143（CodeGraph 索引范围） | `2a1756cb06454d5c4ac32f464968a16112d935aff5693ab62297116bf9fb76ad` | packet 合格；与同一桌面自检修复链绑定，尚未纳入模型计分 |

## 已排除候选

| 提交 | 排除原因 |
| --- | --- |
| `b09ed9eb95269f7195129bb574faad3186e3cf83` | 标题为 PostgreSQL idle connection 修复，但实际包含 55 个文件、6,080 行的 J3b 功能迁移和大量文档变更，无法把根因/关系真值隔离到单一历史 Bug。已归档的修复前快照与 packet 只保留为筛选失败证据，不进入 suite 或计分。 |
| `3bb2bc2c4821fa832b184193ce16bf46b481181d` | 冻结的 CodeGraph packet 未引用其 claim 所指的 YAML 根因文件，不能证明 claim 由 packet 支撑；修复已经揭示，不得事后重建后计分。 |
| `6f7092b6fd29f27e2eb8ff0778c1bfe8a89792e7` | 冻结 packet 未引用 claim 所指的 `scheduler.go`，不能证明 claim 由 packet 支撑；修复已经揭示，不得事后重建后计分。 |
| `36e997f83d10814bbc104e3e6d8e074b74fe0cba` | 修复前 `RecoverStaleCollectionTask` 已能把超时 `fetching` 任务标记失败；揭示后确认修复实际新增的是独立的 `DeleteCollectionTask` 能力。冻结前未能从旧图确定该新增能力的关系，不能在读取 diff 后补建 packet 计分。 |
| `8bafd854336df25e3f0bad2b0849641280091273` | Kimi 模型标识修复的完整 diff 在 parent 快照与 packet 冻结前已被读取。即使后续 CodeGraph packet 和真实 runner A/B 显示正向信号，也不满足 holdout 盲序，不得登记为独立候选、计入 runner 数量或进入正式 gate。相关临时产物仅保留为协议校准记录。 |
| `07455ecba76da31bf98544103c345b60d176db1c` | tool-call-id 候选的冻结 packet 指向了 `internal/translator/openai/claude/openai_claude_response.go`，而实际修复位于 `internal/translator/openai/openai/responses/openai_openai-responses_response.go`；揭示后 runner 也复现了该错位。由于冻结阶段未覆盖真实根因，不能在读取修复后重建 packet 计分。 |
