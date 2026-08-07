# 总审与关闭

这是审查上下文、证据、审核、升级、完成、关闭和 Sol CLI 的唯一规则来源。

- 所有写入验证完成后调用 `workflow_audit_context`，以当前工作区指纹和 `workflow_snapshot` 冻结审核对象。总审必须是此前未参与任务的新建独立 Sol，审查目标、需求、范围、契约、实际 diff/产物、验证和残余风险。
- 总审不得在已冻结的被审工作区执行可能写入的命令；需要独立复跑时使用临时副本或受控证据包，并把结果作为证据带回。
- 审核 JSON 包含 `auditor_task`、`auditor_role`、总审 `claim_id`、`verdict`、`requirement_coverage`、`workflow_snapshot`、`workspace_fingerprint`、`scope_and_regression`、`verification_gaps` 和 `residual_risk`；`workflow_record_review` 核验它仍匹配运行中的总审 claim 与未变化的任务状态。
- 默认 `avsp_sol_high`；第一次 high `fail` 修复后仍用 high，第二次连续 high `fail` 后 `workflow_retry` 升级为 `avsp_sol_xhigh`，xhigh 修复后再次 `fail` 升级为 `avsp_sol_max`，升级后不降级。`unavailable`、超时、证据不足和无效输出不触发升级；仅所选 Sol 实际不可用时可用独立 `avsp_terra_xhigh_readonly`，并披露独立性下降。
- `sol_review_cli` 的有效结果先以 `workflow_completion.state=pending` 保存。main/root 以同一 `outcome.json` 调用 `workflow_complete`，控制器持久化后才原子回写最终 completion；退出码 0 不代表通过，恢复时同时核对结果制品和控制器状态。
- `fail` 或 `unavailable` 不得关闭；修复或补证后必须新建独立审查实例。审查实例实际结束并完成后调用 `workflow_close_check`；只有 `close_allowed=true` 才能报告成功或发布，之后的工作区变更使 `pass` 失效。
- 受控外部证据和 Sol CLI 的超时、最终 JSON、pending envelope、证据清单与目录限制遵守 [存储与维护](storage-maintenance.md)；缺少完整最终 JSON、绑定不匹配或只有部分日志时按 `unavailable` 处理。
