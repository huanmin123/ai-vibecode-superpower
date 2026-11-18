# 按变更选择测试

## 定位消费者与测试

从测试、调用点、脚本、配置及 CI 中查找改动产物的消费者，覆盖 import、文件读取、命令执行、生成与加载等路径。按实际受影响行为选择测试文件、目录、模块或 project，并从已有脚本、CI 或 runner 文档核实命令。必要时使用 runner 的列表或收集选项确认范围。

判断文档变更时，先区分面向读者的说明文字与会被读取、执行或依赖的行为契约，定位实际消费者后再选测试。选择规则以 [SKILL.md](../SKILL.md) 为准。

缺少 runner 或现有测试无法验证风险时，报告缺口并根据任务授权补充必要验证。没有 runner 时，先征得用户同意再修改测试依赖或目录。契约测试的定义见 [baseline-tests.md](baseline-tests.md)，已有场景测试的加载前隔离见 [scenario-tests.md](scenario-tests.md)。

## 常见生态命令示例

按项目实际脚本、runner 版本和测试布局替换，不要假设包管理器或目录名。Node 第三方 runner 使用项目已安装的本地可执行文件；不可用时报告缺失，不用可能自动下载的 `npx` 补装。以下文件路径、模块和测试名均为占位符。

- Python / pytest：
  - `pytest tests/baseline/<module> -q`
  - `pytest tests/baseline/<module> -m "not scenario"`（该目录不包含场景测试模块）
  - `pytest tests/baseline/<module> --lf --last-failed-no-failures none`（仅重跑该范围内缓存的上次失败；无缓存失败时不运行）
  - `pytest tests/baseline/<module> --durations=20`（找该范围内慢用例）
- Node / Vitest：
  - `./node_modules/.bin/vitest run tests/baseline/<module>`
- Node / Jest：
  - `./node_modules/.bin/jest tests/baseline/<module>`
- Node 内置 test runner：
  - `node --test tests/baseline/<module>/<test-file>.test.js`（多文件时传入实际文件列表，不将目录当作测试文件）
- Go：
  - `go test -short ./<baseline-package>`
  - `go test -short ./<baseline-package> -run TestName -count=1`
  - 包范围须排除独立场景包；同包场景文件须使用默认不启用的 build tag。`-short` 只是额外标志，不能防止场景包初始化。
- Rust / Cargo：
  - `cargo test -p <crate> --test <baseline-target>`
  - `cargo test -p <crate> --test <baseline-target> <test_name>`
- Java / Maven：
  - `mvn -Dtest='<Class>#<method>' test`
- Java / Gradle：
  - `./gradlew test --tests '<Class>.<method>'`
- .NET：
  - `dotnet test <baseline-project>.csproj --filter "FullyQualifiedName~<Class>"`

Vitest `--changed` 和 Jest `--onlyChanged` 依赖 Git 变更关系：先核实项目约定的被审基线、共同祖先及 runner 版本的比较行为，再确认选择结果包含受影响模块和新增测试；不能仅凭这些选项证明覆盖。选择到空集时按未验证报告。

场景测试命令可显式选择标记、目录或 target，例如 `pytest -m scenario tests/scenario/<flow>`、项目配置好的 `npm run test:scenario -- <flow>`。具体隔离方式见 `scenario-tests.md`。

## 控制测试规模

- 先看改动的分支和公开契约，再决定测什么；不从“所有可能情况”出发。
- 同一行为只在最低有效层验证一次；高层测试只补低层看不到的集成风险。
- 测试数量增长快于功能增长时，检查重复用例、实现细节断言和低风险覆盖。
- 覆盖率用于找缺口，不作为目标；重点覆盖改动行和风险分支。
