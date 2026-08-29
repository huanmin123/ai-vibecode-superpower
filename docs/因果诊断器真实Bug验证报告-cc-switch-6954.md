# 因果诊断器真实 Bug 验证报告：CC Switch Issue #6954

## 结论

本案例证明当前因果诊断器具备实用价值：在一个 678 个文件、13,879 个节点、47,846 条边的 Rust + TypeScript 项目中，插件可以从用户提供的错误现象一次性编译出有界的全局关系包，并把真正的故障域 `src-tauri/src/proxy/forwarder.rs` 排到首要候选附近。沿着该候选继续检查调用关系后，根因定位到 Copilot 模型能力元数据没有传递 `supported_endpoints`，导致路由只能按 vendor 猜测 API 格式。

这证明了“程序先收集结构和证据，AI 再做全局判断”的方向可行；但本案例还没有完成传统 grep 排查与因果诊断器之间的模型调用数、token、总耗时对照，因此不能据此宣称已经达到固定的 2 次调用或普遍提速比例。

## 被测项目与缺陷

- 项目：`farion1231/cc-switch`
- 本地原始目录：`F:\temp-project\cc-switch-main`
- 独立验证副本：`F:\temp-project\causal-debugger-validation\cc-switch-issue-6954`
- GitHub Issue：[#6954 bug(proxy): Claude Copilot routing ignores supported endpoints](https://github.com/farion1231/cc-switch/issues/6954)
- 复现症状：Copilot 模型 `grok-4.6` 的 vendor 是 `xAI`，模型元数据声明支持 `/responses`，但 Claude 路由发送到 `/chat/completions`，上游返回 `unsupported_api_for_model`。

原始项目没有直接修改。副本由 1,143 个非依赖、非构建文件复制得到，文件数量一致。

## 因果诊断输入

没有把 Issue 正文中的 Root cause 段落交给引擎，避免答案泄漏。实际输入只保留用户可观察信息：

```text
Claude Copilot model grok-4.6 vendor xAI supports /responses but routing sends /chat/completions and upstream returns model grok-4.6 is not accessible via the /chat/completions endpoint; source src-tauri/src/proxy/forwarder.rs:2565
```

## CodeGraph 与因果输出

副本首次建立 CodeGraph 索引：

- 678 个文件
- 13,879 个节点
- 47,846 条边
- 语言：Rust、TypeScript、TSX、JavaScript、YAML、XML
- 建索引耗时约 0.83 秒（不含进程启动）

因果诊断器单次分析输出：

- 状态：`ready`
- 动作：`analyze`
- 候选假设：5 个
- 有界证据节点：250 个
- 有界证据边：1,342 条
- seed 匹配：48 个
- 关系缺口：1 个
- 图被 `neighborhood_bound` 截断，未声称覆盖整个项目

首轮没有直接把某个函数宣布为确定根因，而是先把 `src/lib/api/copilot.ts` 识别为模型数据入口。加入明确源位置后，结果把 `src-tauri/src/proxy/forwarder.rs` 的 `forward` 方法排到第一候选，说明结构关系和源位置能把自然语言症状收敛到正确的请求转发域。

## 代码证据与根因确认

独立检查候选路径后确认：

1. `resolve_claude_api_format` 原先调用 `is_copilot_openai_vendor_model`，只根据 vendor 是否为 `OpenAI` 决定是否使用 `openai_responses`。
2. `CopilotModelsResponseItem` 和 `CopilotModel` 原先只保存 `id`、`name`、`vendor`、`model_picker_enabled`，丢弃了上游返回的 `supported_endpoints`。
3. 因此，非 OpenAI vendor 的 Responses 模型只能错误回退到 `openai_chat`，最终生成 `/chat/completions` 请求。

这与 Issue #6954 给出的 Root cause 一致，但该结论是通过独立代码检查复核得到的，不是把 Issue 的结论当作插件输入。

## 副本中的修复

修改范围仅在验证副本：

- `src-tauri/src/proxy/providers/copilot_auth.rs`
  - 为 `CopilotModel` 和 Models API 响应保留 `supported_endpoints`。
  - 增加按账号和默认账号读取完整模型元数据的方法。
- `src-tauri/src/proxy/forwarder.rs`
  - 优先按 `supported_endpoints` 判断是否支持 Responses。
  - 只有旧缓存没有能力字段时才回退到 vendor 规则，保持旧数据兼容。
  - 增加 `/responses`、`/v1/responses/` 和 `/chat/completions` 的回归测试。
- `src/lib/api/copilot.ts`
  - 同步前端模型类型定义。

修复后的判断规则是：

```text
有 supported_endpoints -> 以 endpoint 能力为准
没有 supported_endpoints -> 回退到旧 vendor 规则
```

## 验证结果

- `codegraph sync`：成功，同步 4 个修改文件，索引恢复为 up-to-date。
- `codegraph status`：索引健康，13,885 个节点、47,869 条边。
- 因果诊断器修复后重跑：`ready` / `analyze`，5 个候选假设，关系图仍保持有界。
- `pnpm install --frozen-lockfile`：成功。
- `pnpm exec tsc --noEmit`：通过。
- `pnpm test:unit`：100 个测试文件、695 个测试通过。
- `cargo +stable fmt --check`：通过。

Rust 编译未完成：项目声明的 Rust `1.95` toolchain 在当前配置镜像上无法下载；改用本机 `stable` 离线检查时，又缺少缓存包 `wit-bindgen-rust-macro`。这是验证环境依赖问题，不能作为本次补丁编译失败的证据。

## 对产品目标的判断

本案例支持以下判断：

- CodeGraph 负责秒级结构化召回，适合把跨文件、跨模块的关系一次性整理给 AI。
- 因果引擎适合维护多个候选，而不是把第一个 grep 命中直接当答案。
- 明确文件和行号时可以直接分析；只有自然语言现象时，系统会保留有限候选并要求一次补充，而不是盲目扩大搜索。
- 日志接入 RTK 后可保留压缩内容、事件、来源哈希和未映射证据，适合继续做运行时因果校验。

本案例尚未证明的内容：

- 尚未与传统 grep/Read 工作流做同题、同模型、同环境的调用数和 token 对照。
- 尚未证明模糊描述可以召回全部关系；当前策略会在没有确定锚点时要求用户补充。
- 尚未证明静态图本身能产生真实因果；因果强度仍需要日志时序、干预结果或测试证据支持。

下一步正式验收应使用多份事先冻结答案的真实 Issue，记录传统流程与因果流程的模型调用次数、输入输出 token、耗时、根因召回、误判和遗漏，并把本案例作为已修复的正例保留在 holdout 集之外。
