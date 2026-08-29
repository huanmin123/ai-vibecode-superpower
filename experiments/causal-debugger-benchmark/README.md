# Causal Debugger Benchmark

> 状态：M-1 验证性 Spike，不是可安装插件。  
> 运行时：Node.js `>=22.5.0`，无第三方依赖。

## 目标

这个工具只负责建立可信的 baseline / assisted 盲测闭环：

- 严格校验 suite、隐藏真值和结果格式；
- 生成随机但可复现的运行顺序；
- 确保交给模型 runner 的计划不包含 `truth`、修复提交或真值文件；
- 比较 Top-3 根因命中、关键关系召回、首次正确根因时间、实际 input token 和高置信错误；
- 样本不足、实际 token 缺失、运行不完整或修复后误报时拒绝输出 `go`；修复后误报同时检查冻结 packet 与 assisted 模型最终关系，不能只靠 packet audit 放行。

核心 harness 不初始化 CodeGraph、不修改被测仓库，也不使用字符数估算实际 token。随附的 Codex runner 是一个可选适配器：它执行用户明确指定的单个 task，保留原始 JSONL，并从 `turn.completed.usage` 读取实际用量。

## 命令

在本目录执行：

```powershell
npm.cmd run check
npm.cmd test
node src\cli.mjs validate --suite C:\benchmark\suite.json
node src\cli.mjs plan --suite C:\benchmark\suite.json --out C:\benchmark\run-plan.json
node src\cli.mjs task --suite C:\benchmark\suite.json --plan C:\benchmark\run-plan.json --run-id case-001:assisted:1 --out C:\benchmark\runner-task.json
node src\evidence-packet-cli.mjs --source C:\benchmark\codegraph-context.txt --query "error boundary" --elapsed-ms 180 --claim '{"source":"symbol:src/service.ts:stream","target":"capability:response-error-boundary","kind":"guard","observation":"absent","confidence":0.9}' --out C:\benchmark\packets\case-001.json
node src\cli.mjs collect --suite C:\benchmark\suite.json --plan C:\benchmark\run-plan.json --run-result C:\benchmark\baseline-result.json --run-result C:\benchmark\assisted-result.json --out C:\benchmark\results.json
node src\cli.mjs evaluate --suite C:\benchmark\suite.json --plan C:\benchmark\run-plan.json --results C:\benchmark\results.json --out C:\benchmark\report.json
```

`plan` 和 `evaluate` 默认拒绝覆盖输出文件；确需替换时显式传 `--force`。`evaluate` 在结果不是 `go` 时返回退出码 `2`；探索性运行需要保存 `insufficient_data` / `no_go` 报告时显式传 `--allow-non-go`。

真实 Codex runner：

```powershell
node src\codex-runner-cli.mjs --task C:\benchmark\runner-task.json --out C:\benchmark\run-result.json --transcript C:\benchmark\events.jsonl --diagnostics C:\benchmark\stderr.log
```

多个已生成 task 可以用受限并发批量运行；batch runner 不读取 suite 或真值，只写每个 run 的结果、JSONL、诊断和 manifest：

```powershell
node src\batch-runner-cli.mjs --task-dir C:\benchmark\tasks --result-dir C:\benchmark\results --transcript-dir C:\benchmark\transcripts --diagnostics-dir C:\benchmark\diagnostics --concurrency 2
```

runner 使用 `codex exec --ephemeral --ignore-rules --sandbox read-only --json`，从 `turn.completed.usage` 读取实际用量并保留原始 JSONL。证据包必须在 suite 中声明 SHA-256；runner 会拒绝摘要不匹配的文件。每个 claim 所引用的仓库文件必须在 packet `content` 中出现，否则 packet 被拒绝，防止把人工标注伪装成图证据。对包含 `claims` 的 packet，提示只允许验证其中引用的符号或文件，claim 足以解释症状时应立即返回；否则最多两次窄验证后明确输出 `unknown`，不得扩展为全仓搜索。提示中的 `tokenBudget` 不是供应商硬限制，实际超预算由 `evaluate` 标记为 `insufficient_data`。`maxToolCalls` 由 runner 逐行观察 JSONL 强制执行，超过上限的 run 会被终止并标为失败。不能默认加 `--ignore-user-config`：该选项会移除当前机器的认证/供应商配置；要获得完全隔离的配置，必须显式提供经过验证的 runner 专用配置。

## Suite 契约

```json
{
  "schemaVersion": 1,
  "suiteId": "three-repos-holdout-v1",
  "mode": "gate",
  "seed": "fixed-randomization-seed",
  "repetitions": 3,
  "executionProfile": {
    "model": "model-id",
    "reasoningEffort": "high",
    "promptVersion": "debug-v1",
    "tokenBudget": 20000,
    "timeoutMs": 3600000,
    "maxToolCalls": 12
  },
  "arms": [
    { "id": "baseline", "evidenceMode": "none" },
    { "id": "assisted", "evidenceMode": "packet" }
  ],
  "cases": [
    {
      "id": "case-001",
      "repositoryId": "repo-a",
      "split": "holdout",
      "category": "event_lifecycle",
      "caseKind": "bug",
      "workspace": {
        "path": "workspaces/case-001",
        "snapshot": "git:pre-fix-commit"
      },
      "problem": { "text": "用户实际能提供的模糊故障描述" },
      "evidencePackets": {
        "assisted": {
          "path": "packets/case-001.json",
          "sha256": "证据包原始字节的 SHA-256"
        }
      },
      "truth": {
        "rootCauseFiles": ["src/service.ts"],
        "criticalRelations": [
          {
            "source": "symbol:src/service.ts:stream",
            "target": "capability:response-error-boundary",
            "kind": "guard",
            "observation": "absent"
          }
        ]
      }
    }
  ]
}
```

约束：

- `mode=spike` 永远不能通过产品门；正式验收必须使用 `mode=gate`。
- `split=design` 用于写规则和调试，不计入最终指标；只有 `split=holdout` 参与门禁。
- `caseKind=bug` 必须提供至少一个根因文件。
- `caseKind=fixed_regression` 的根因文件必须为空，并至少提供一条 `observation=present` 的关键关系，用于阻止“修复后仍报缺失”的误报。
- 支持的类别固定为 `single_file`、`event_lifecycle`、`configuration`、`database`、`async` 和 `cross_service`。
- `truth.rootCauseFiles` 必须是仓库相对路径；禁止绝对路径和 `..` 越界。
- suite 必须保存在模型 runner 无法读取的位置。仅把 `run-plan.json` 中的单个 run 交给 runner。
- assisted packet 必须由 `evidence-packet-cli.mjs` 在真值揭示前冻结；顶层 `claims` 使用和 `truth.criticalRelations` 一致的关系格式。
- `mode=gate` 的每条 `truth.criticalRelations` 必须在冻结前提供稳定的 `relationId`；packet 与 assisted 输出复用该 ID。评分优先按 ID 匹配，保留旧 Spike 的 source/target/kind 精确匹配作为兼容指标；不得在运行后用别名或语义近似补命中。

## Run Plan

## Global Causal Engine Prototype

`src/causal-engine.mjs` 提供一个不依赖 CodeGraph 私有数据库的实验原型：接收已物化的节点、边、症状 seed 和运行时证据，使用固定深度/beam 宽度的多源反向搜索生成问题子图，保留多个根因假设，并输出可解释排序特征与反事实支持。它只消费 CodeGraph 适配器输出，不负责解析语言或修改索引；当前仍是 benchmark 原型，不是完整 MCP 插件。

`src/runtime-evidence.mjs` 提供日志/console 的有界流式读取、源文件 SHA-256、脱敏、RTK `0.46.0` 压缩和基础字段抽取。RTK 仅负责去重/折叠输出，压缩失败会返回 `status=failed`，不会伪装成完整运行时证据；跨服务和无 Trace ID 的日志仍必须由因果引擎标记为 `unknown`。

运行时事件中的 `file:line[:column]` 会由 `codegraph-adapter.mjs` 通过 `getNodesInFile` 映射到 CodeGraph 覆盖该行的最窄节点；映射失败保留 `unknown`，不绑定相邻代码。可直接运行：

```powershell
npm.cmd run analyze -- --project <project-dir> --query <symptom> --runtime-evidence <events.json> --out <analysis.json>
```

`plan` 输出由 suite 内容、seed 和 execution profile 确定，同一输入会得到相同 `planId` 和顺序。每个 run 只包含：

- `runId`、`caseId`、`repositoryId`、arm 和 trial；
- 修复前 workspace 与 snapshot 标签；
- 用户问题；
- assisted arm 的证据包路径，baseline 为 `null`。

计划不包含 split、category、case kind、truth 或修复后提交。case ID 使用不携带根因含义的编号，不能把答案编码在 ID 中。模型 runner 不应获得 suite 文件、Git 后续提交或其他 trial 的结果。

使用 `task` 从已验证的 suite 和 plan 导出单个 runner 输入。该文件进一步移除 `caseId` 和 `repositoryId`，只保留 `runId`、execution profile、修复前 workspace、问题和当前 arm 的 evidence。

## Runner 结果契约

runner 汇总全部 run 后写入：

```json
{
  "schemaVersion": 1,
  "planId": "run-plan planId",
  "runs": [
    {
      "runId": "case-001:assisted:1",
      "status": "completed",
      "rootCauseCandidates": [
        { "path": "src/service.ts", "confidence": 0.91 }
      ],
      "relations": [
        {
          "relationId": "relation.http.error-boundary",
          "source": "symbol:src/service.ts:stream",
          "target": "capability:response-error-boundary",
          "kind": "guard",
          "observation": "absent",
          "confidence": 0.88
        }
      ],
      "candidateEvents": [
        { "elapsedMs": 42000, "rootCauseFiles": ["src/service.ts"], "source": "final_response" }
      ],
      "usage": {
        "source": "provider",
        "inputTokens": 7200,
        "outputTokens": 900,
        "cacheReadTokens": 0,
        "cacheWriteTokens": 0
      },
      "metrics": {
        "wallTimeMs": 51000,
        "evidencePreparationMs": 430,
        "toolCalls": 7,
        "filesRead": 5,
        "charactersRead": 18000
      }
    }
  ]
}
```

`usage.source` 必须说明 token 的真实来源，例如 provider usage 或经过验证的 Codex session metadata。缺少 `usage`、`candidateEvents` 或 `metrics` 的 holdout run 会使报告成为 `insufficient_data`，不会用字符代理值补齐。

根因候选允许模型输出常见的 `path/to/file.ts:line` 或 `path/to/file.ts:line:column`；validator 会在计分前去掉行列后缀并保留仓库相对文件路径。原始 JSONL 和模型响应不会被改写。

失败 run 使用：

```json
{
  "runId": "case-001:baseline:1",
  "status": "failed",
  "error": "保留的原始 runner 错误"
}
```

Codex CLI 当前只在最终结构化消息中公开根因候选。因此 `candidateEvents` 表示**首次可观察到的候选**，当前 runner 每个完成 run 只有一条 `final_response` 事件；它不能推断模型内部最早想到某个文件的时刻。失败和未命中的 Bug 在时间指标中按 `executionProfile.timeoutMs` 截尾，防止只统计成功案例后制造虚假的提速。

## 放行条件

只有以下前置条件全部满足才会评估 `go` / `no_go`：

- `mode=gate`；
- 至少 3 个仓库、20 个 holdout Bug、全部 6 类问题；
- 至少 3 次重复；
- 至少一个修复后回归案例和关键关系真值；
- 所有 holdout run 完成；
- baseline / assisted 使用同一种真实 usage 来源；
- candidate timeline、usage 和 metrics 完整。

随后执行设计文档定义的阈值：assisted Top-3 不低于 80%、相对提升至少 15 个百分点、冻结证据包关系召回和 assisted 模型最终关系召回均不低于 85%、时间下降至少 30%、P75 input token 下降至少 40%、高置信错误不恶化、证据准备 P95 不超过 2 秒、修复后误报为零。

## 安全边界

- 工具只读取 suite、plan 和 results，并只写用户明确给出的输出文件。
- 默认不覆盖已有输出。
- 不执行 suite 内的命令，不启动模型，不进入被测 workspace 写文件。
- 运行计划通过白名单字段构建，不复制 suite 的未知字段。
- `planId` 和 suite digest 防止结果被套用到另一份真值或运行计划。
