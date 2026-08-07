---
name: orchestrate-read-workflow
description: "为复杂、可证明纯只读的任务组织互补取证与有界定案。"
---

# 纯只读取证工作流

先阅读 [workflow-common.md](../workflow-common.md)。本 skill 仅用于复杂、可证明纯只读的任务；单步、单域且无需判断或委派的读取由 main/root 直接完成，不启用工作流。

不调用 MCP，不建立控制器状态、任务图、检查点、恢复或任务级关闭。任何计划操作需要写入，可能产生 WAL、锁、快照或测试产物，无法证明纯只读，或需要持久控制、恢复或总审时，停止并改用 `$orchestrate-model-workflow`。

按共用规则以互补证据域分派和汇总；`avsp_terra_high` 不得进入本 skill。Luna 任务包额外写明只读范围、待回答的问题、互补证据域和允许读取操作；main/root 保留证据归属并聚合已有结果。
