---
name: workflow-controller
description: "持久化状态变更任务的 DAG、恢复线索与绑定工作区指纹的总审关闭门禁。"
---

# 工作流控制器

仅在状态变更任务需要持久 DAG、可恢复交接或可强制总审记录时使用。控制器是状态与关卡服务，不替代 Codex 原生 `spawn_agent`、`send_message`、`wait_agent` 或 `interrupt_agent`；它也不能验证真实 Codex 身份或自行停止、恢复代理。调用时机和写入任务分流以 `$orchestrate-model-workflow` 为准。

最短生命周期：在创建或恢复边界 `ensure-context`，以 manifest 初始化；读取 ready 节点，实际启动实例后记录进度和完成；遇到中断先诊断、确认旧实例停止后恢复或重派；冻结审查上下文，由独立 Sol 记录总审，通过关闭检查后才交付。工具返回、消息投递和退出码都不是任务终态。

按需读取以下直接 reference；它们是控制器协议的唯一权威：

- [任务生命周期](references/task-lifecycle.md)：manifest、初始化、就绪节点、启动、心跳、checkpoint、完成与 attestation。
- [恢复与诊断](references/recovery.md)：上下文连续性、过期、重派、救援、释放、锁和 doctor。
- [总审与关闭](references/total-review.md)：审查上下文、证据、审核、升级、完成、关闭和 Sol CLI。
- [存储与维护](references/storage-maintenance.md)：SQLite、原子写入、文件锁、清理、隔离和文件系统限制。
