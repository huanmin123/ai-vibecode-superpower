# 按变更选择测试

## 优先级

1. 项目 `AGENTS.md`、`TESTING.md` 或 CI 中明确的测试命令、范围与门禁优先；本 skill 只在项目未规定时给默认。
2. 用户显式指定的命令或范围（包括全量）覆盖项目默认，按用户范围执行。
3. 改动映射到受影响模块，运行这些模块的功能基线。
4. 公开契约变更，追加直接消费者的契约测试；共享模块再取一跳传递消费者。
5. 验收需要真实调用时，按 flow id 匹配场景测试，只跑匹配项。
6. 热点或性能目标且有 SLO/profile 证据时，运行性能测试。
7. 全量功能基线只允许：用户明确要求、发布门禁、定时 CI、项目显式策略。
8. 影响面不明时，运行最近模块并报告未覆盖风险；仍无法判断时询问用户，不默认全量。

## 决策表

| 变更类型 | 默认运行 | 追加条件 |
| --- | --- | --- |
| 单文件内部逻辑 | 该模块功能基线 | 为改动的分支补用例 |
| 公开契约/接口/schema | 该模块功能基线 | 直接消费者契约测试 |
| 跨模块重构 | 受影响模块功能基线 | 影响面跨模块时按项目显式策略跑全量 |
| 依赖/工具链/构建配置 | 受影响模块 + 冒烟 | 项目显式策略要求时跑全量 |
| 业务/UI 流程 | 受影响模块功能基线 | 匹配 flow 跑对应场景 |
| 热点路径/性能目标 | 受影响模块功能基线 | 先 profile，再按需跑微基准或负载测试 |
| 修 bug | 先写复现失败用例，再跑该模块 | 修复后重跑该用例和模块功能基线 |
| 仅文档/注释 | 不跑功能测试 | 文档链接/格式检查（如项目有） |
| 测试基础设施 | 受影响模块功能基线 | 项目策略要求时跑全量；验证场景测试仍可显式启动 |

冒烟：项目已定义的 baseline/smoke 子集，或一个覆盖启动/关键路径的最小功能基线用例；没有定义时不要临时新增场景全量。

## 首次接入 / 缺失基础设施

1. 盘点现有 runner、命令和测试目录；没有 runner 时，提出最小标准 runner + 一个 smoke 测试，先征得用户同意再改依赖。
2. 没有 `TESTING.md` 时先征得用户同意再写，或只把映射放进交付证据。
3. 测试没有 marker 时，按 import/IO 分类并补 marker；未分类前只跑 import 了改动文件的测试，并报告场景风险未验证。
4. 没有全量命令时，不发明全量；运行最近模块并记录缺口。
5. 项目完全禁止改测试结构时，只报告建议和未覆盖风险，不擅自重构。

## 模块映射

首次在目标项目触发本 skill 时建立，不要假设全局 skill 安装器会写目标项目文件：

1. 读 workspace manifests、构建脚本和 CI 配置，列出模块与边界。
2. 从项目 scripts/CI 取命令，用 `--list` / `--collect-only` / `--dry-run` 验证。
3. 写入 `TESTING.md`；项目已有文档体系时放进其指定测试文档，不另建架构。
4. 记录来源、日期和负责人。

```
| 模块 | 路径 | 功能基线命令 | 场景 flow | 性能命令 | 预算 |
| --- | --- | --- | --- | --- | --- |
| auth | src/auth | pytest tests/baseline/auth -q | login | k6 run perf/auth.js | <30s |
| billing | src/billing | npm test -- tests/baseline/billing | checkout | npm run bench -- billing | <60s |
```

场景按 flow 目录维护，不按模块跑全部场景；目录模板见 `scenario-tests.md`。

## 契约测试

定义、消费者定位和放置位置见 `baseline-tests.md` 的“契约测试”一节。

## 变更影响选择（TIA 思路）

- 优先运行：直接受影响的测试、上次失败的测试、本次新增的测试。
- 配置、依赖锁文件、构建脚本：按项目显式策略处理；无法映射时运行最近模块并报告未覆盖风险，不直接回退全量。
- 选择结果要可验证：首次引入或大规模重构后，在定时 CI 或用户批准的一次性验证中，抽样对比“只跑受影响测试”和“全量功能基线”的结果，确认选择没有漏掉失败。
- 周期性全量：本地默认不全量；CI 或发布门禁按项目节奏跑全量功能基线。

## co-located 测试

如果功能基线与源码同目录，必须用 marker/project 选择，不能只按目录：

- pytest：`pytest -m baseline`，并在配置中注册 `baseline` marker。
- Vitest：独立 `baseline` project。
- Jest：`--testPathPattern` 选择测试文件，同时排除 `tests/scenario`。
- Node 内置 runner：默认只支持 `tests/baseline`；co-located 需要生成文件列表，不能假设 glob。
- 全量命令同步使用 marker/project，不只写目录。

## 常见生态命令示例

按项目实际脚本替换，不要假设包管理器或目录名。

- Python / pytest：
  - `pytest tests/baseline/<module> -q`
  - `pytest tests/baseline/<module> -m "not scenario"`
  - `pytest --lf`（只跑上次失败）
  - `pytest --durations=20`（找慢用例）
- Node / Vitest：
  - `npx vitest run tests/baseline/<module>`
  - `npx vitest run --changed`
  - `npx vitest run --project baseline`
- Node / Jest：
  - `npx jest tests/baseline/<module>`
  - `npx jest --onlyChanged`
- Node 内置 test runner：
  - `node --test tests/baseline/<module>`
- Go：
  - `go test -short ./<module>/...`
  - `go test -short ./<module>/... -run TestName -count=1`
  - `-short` 只是标志，测试内部必须用 `testing.Short()` 跳过慢用例和场景测试。
- Rust / Cargo：
  - `cargo test -p <crate>`
  - `cargo test -p <crate> <test_name>`
- Java / Maven：
  - `mvn -Dtest='<Class>#<method>' test`
- Java / Gradle：
  - `./gradlew test --tests '<Class>.<method>'`
- .NET：
  - `dotnet test --filter "FullyQualifiedName~<Class>"`

场景测试命令必须显式带标记或目录，例如 `pytest -m scenario tests/scenario/<flow>`、`npm run test:scenario -- <flow>`；默认命令不得包含它们，并验证默认命令收集到 0 个场景。

全量功能基线命令由项目提供，常见形式：`pytest tests/baseline`、`vitest run tests/baseline`、`go test ./... -short`、`cargo test --all`。只在“全量功能基线”允许的场景使用，并记录耗时。

## 控制测试规模

- 先看改动的分支和公开契约，再决定测什么；不从“所有可能情况”出发。
- 同一行为只在最低有效层验证一次；高层测试只补低层看不到的集成风险。
- 测试数量增长快于功能增长时，检查重复用例、实现细节断言和低风险覆盖。
- 覆盖率用于找缺口，不作为目标；重点覆盖改动行和风险分支。
