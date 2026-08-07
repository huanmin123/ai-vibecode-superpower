# Agnets 工作流

`agnets-workflow` 为 Codex 提供受控的复杂任务工作流与持久化任务状态。

## 能力

- 复杂纯读任务的互补取证与有界定案。
- 状态变更任务的契约、执行分流、持久 DAG、恢复与独立总审。
- [`project-doc-planner`](skills/project-doc-planner/SKILL.md) 项目文档规划与任务级最小持久记录。

路由只有三种：单步单域的纯读由 main/root 直接完成；复杂且可证明纯读使用 [`orchestrate-read-workflow`](skills/orchestrate-read-workflow/SKILL.md)；状态变更、纯读性不明、持久产物、持久控制、恢复或总审使用 [`orchestrate-model-workflow`](skills/orchestrate-model-workflow/SKILL.md)。控制器协议以 [`workflow-controller`](skills/workflow-controller/SKILL.md) 及其直接 reference 为准。

控制器同时提供 MCP 与本地 CLI；具体工具、输入和状态约束仅在 [`workflow-controller`](skills/workflow-controller/SKILL.md) 维护。
