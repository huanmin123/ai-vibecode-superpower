## CodeGraph 与 RTK

<!-- agent-toolchain-managed:v4 -->
- 先判断问题类型：纯文本、字符串、日志、配置检索，或已知文件的小范围阅读，直接用 `rg`/原生读取；当需要代码结构探索或全链路关系（符号位置、调用链、依赖方向、影响范围、跨模块契约），且 `rg` 容易漏时，才用 CodeGraph。不要为“先查一下”而无目标调用。
- CodeGraph 的价值是避免漫无目的地 `grep` 探索和漏掉跨文件关系，不是默认省 token；查询必须收窄到具体符号、文件或模块，优先 `codegraph node/callers/callees/impact` 或对应 MCP 工具，`codegraph_explore`/`context` 只在确实需要批量上下文时使用并限制返回量。
- CodeGraph 结果为空、明显不符或返回过大时停止，回退 `rg`/当前源码，不重复试探；索引结果必须以当前源码、`rg`、未跟踪文件和刚修改文件复核。
- CodeGraph MCP 不可用时报告连接问题并在宿主 MCP 设置中检查；不要静默改用 CLI 或 `rg` 替代，降级使用必须说明。
- RTK 不是省 token 方案，而是防止大日志/大输出撑爆上下文的安全阀，采用白名单：只为 `test`、`build`、`git log` 以及确认会产生大量输出的 `log`/`rg`/`find` 开启过滤（如 `rtk test`、`rtk mvn test/package`、`rtk npm run build`、`rtk pnpm build`、`rtk git log`、`rtk log`）；`git diff`、`git status`、`ls`、`cat`、`cp` 等简单、高信息密度或写入命令直接用原生。过滤后关键信息缺失时立即用原生命令重跑并说明；不要为“统一走 RTK”而包装所有命令。
- 单文件且不改公共契约的局部修复、文档/注释、格式化和低风险机械整理，不强制走 CodeGraph 或 RTK。
- 只有工具注册表或 `--help` 未列出目标命令时，才能判定该命令不存在；其他工具错误保留原始输出，不得归因于能力缺失。
- 安装、配置修复、初始化或修复索引、健康检查、升级审查和回滚使用全局 `agent-toolchain` skill；不得在日常开发中自行安装、升级、重配或维护工具链。
