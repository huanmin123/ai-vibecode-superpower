import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { watch } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ControllerError, canonicalStateDirectory, dispatch, statePathKey } from './workflow_controller.mjs';
import { globalWorkflowStorePath, readGlobalTaskChangeToken } from './global_workflow_store.mjs';

export const TOOLS = [
  ['workflow_init', '从 JSON 清单创建持久化 DAG；v3 可用 review_entry_stage 直接从 terra_single、terra_cohort、sol_high 或 sol_xhigh 开始，并必须给出 review_context.environment/scenarios/boundaries。控制器从 manifest.workspace 自动派生全局 state_dir 并在结果中返回；项目内不使用任何工作流路径或状态。', ['manifest'], { manifest: { description: 'v3 工作流清单对象、内联 JSON 对象字符串或普通 JSON 文件路径。requirements 必须为 [{id,text}]；每个 assurance 维度为 {status,evidence:string[],rationale}，字段名为 impact/recoverability/uncertainty/verifiability/coupling，另含 selection_reason；节点使用 id（不是 node_id）及完整路由字段。', anyOf: [{ type: 'object' }, { type: 'string' }] } }],
  ['workflow_raise_assurance', '在末端质量门开始前，按结构化新证据将 v3 Terra assurance 提高到 Sol，并把同一个未认领门重绑定为 sol_high；不得降级或新增第二个审核门。', ['task_id', 'target_assurance_level', 'reason', 'assurance_assessment', 'replacement_agent_task_path', 'integration_owner', 'state_dir'], { task_id: { type: 'string' }, target_assurance_level: { enum: ['sol'] }, reason: { type: 'string' }, assurance_assessment: { anyOf: [{ type: 'object' }, { type: 'string' }], description: '五个风险维度分别含 status、evidence、rationale，并含 selection_reason；优先传内联 JSON 对象，外部文件不得位于目标 workspace 内。' }, replacement_agent_task_path: { type: 'string', description: '预留给新末端审核者的独立 agent task path。' }, integration_owner: { type: 'string', description: '负责该末端门集成与关闭的真实协调者 task path。' }, state_dir: { type: 'string' } }],
  ['workflow_rebind_pending', '确认预定实例已停止或未启动后，为未认领的 pending 节点换绑 execution_owner；保留原因和旧 owner。', ['task_id', 'node_id', 'reason', 'replacement_agent_task_path', 'previous_agent_stopped', 'state_dir'], { task_id: { type: 'string' }, node_id: { type: 'string' }, reason: { type: 'string' }, replacement_agent_task_path: { type: 'string' }, previous_agent_stopped: { type: 'boolean', const: true }, state_dir: { type: 'string' } }],
  ['workflow_invalidate_gate', '末端 pass 在关闭前因任务快照或工作区变化失效时，保留旧记录并受控重开质量门；审核门必须绑定新的独立 reviewer，terra_cohort 可指定首个重开 lane。', ['task_id', 'reason', 'replacement_agent_task_path', 'state_dir'], { task_id: { type: 'string' }, reason: { type: 'string' }, replacement_agent_task_path: { type: 'string', description: '审核门失效时必填。' }, reviewer_slot: { enum: ['coverage', 'adversarial'], description: '仅重开 v3 terra_cohort 时可选，指定预留给替代审核者的首个 lane，默认 coverage。' }, state_dir: { type: 'string' } }],
  ['workflow_reconcile_workspace', '恢复指定初始化任务留下的工作区租约；必须提供 workspace、task_id 和 state_dir。', ['workspace', 'task_id', 'state_dir'], { workspace: { type: 'string' }, task_id: { type: 'string' }, state_dir: { type: 'string' } }],
  ['workflow_ready', '返回所有依赖均已成功的 DAG 节点。', ['task_id', 'state_dir'], { task_id: { type: 'string' }, state_dir: { type: 'string' } }],
  ['workflow_claim', '认领就绪节点并返回 claim_id；v3 terra_cohort 必须提供 coverage 或 adversarial reviewer_slot，两个 lane 可并行。', ['task_id', 'node_id', 'agent_task_path', 'agent_role', 'state_dir'], { task_id: { type: 'string' }, node_id: { type: 'string' }, agent_task_path: { type: 'string' }, agent_thread_id: { type: 'string' }, agent_role: { type: 'string' }, reviewer_slot: { enum: ['coverage', 'adversarial'], description: '仅 v3 terra_cohort 必填。' }, fallback_reason: { type: 'string' }, lease_duration_sec: { type: 'integer', minimum: 1 }, activation_timeout_sec: { type: 'integer', minimum: 1 }, state_dir: { type: 'string' } }],
  ['workflow_start', '由已开始回合的原生代理原子认领并激活节点；返回的 claim_id 必须原样保存并用于 heartbeat、record_review 与 complete，禁止猜测。v3 terra_cohort 必须提供 coverage 或 adversarial reviewer_slot。', ['task_id', 'node_id', 'agent_task_path', 'agent_role', 'native_agent_started', 'state_dir'], { task_id: { type: 'string' }, node_id: { type: 'string' }, agent_task_path: { type: 'string' }, agent_thread_id: { type: 'string' }, agent_role: { type: 'string' }, reviewer_slot: { enum: ['coverage', 'adversarial'], description: '仅 v3 terra_cohort 必填。' }, fallback_reason: { type: 'string' }, native_agent_started: { type: 'boolean', const: true, description: '仅在原生 agent 已开始当前回合后传入。' }, lease_duration_sec: { type: 'integer', minimum: 1 }, activation_timeout_sec: { type: 'integer', minimum: 1 }, state_dir: { type: 'string' } }],
  ['workflow_acquire_write_lock', '仅在即将修改文件时，为实际最小 workspace 相对路径申请短写锁；声明 workspace_claims 只是可申请上界，不会在 init 时预锁。完成该组写入后必须立即释放。', ['task_id', 'node_id', 'claim_id', 'write_prefixes', 'purpose', 'state_dir'], { task_id: { type: 'string' }, node_id: { type: 'string' }, claim_id: { type: 'string' }, write_prefixes: { type: 'array', minItems: 1, maxItems: 64, items: { type: 'string' }, description: '实际将要修改的最小 workspace 相对 POSIX 路径；不得使用彼此重叠的前缀。' }, purpose: { type: 'string', description: '这一次实际写入组的具体目的；根目录锁只限确有全工作区副作用时。' }, state_dir: { type: 'string' } }],
  ['workflow_release_write_lock', '完成一组实际写入后立即释放当前或刚终止 claim 持有的指定短写锁；后者用于自动清理失败后的安全重试。节点完成、放弃、救援或重排队也会自动清理其锁。', ['task_id', 'node_id', 'claim_id', 'lock_ids', 'state_dir'], { task_id: { type: 'string' }, node_id: { type: 'string' }, claim_id: { type: 'string' }, lock_ids: { type: 'array', minItems: 1, maxItems: 64, items: { type: 'string' } }, state_dir: { type: 'string' } }],
  ['workflow_complete', '只由 main/root 调用：使用 workflow_start 返回的同一 claim_id、内联结果和 completion_attestation。审核节点必须先由 main/root 成功 workflow_record_review，再在确认审核代理原生 Completed 后以 native_agent_finished 完成；审核代理自身只返回审核 JSON。工作区内的结果 JSON 文件路径会被拒绝；放弃使用 workflow_abandon。', ['task_id', 'node_id', 'claim_id', 'status', 'result', 'completion_attestation', 'state_dir'], { task_id: { type: 'string' }, node_id: { type: 'string' }, claim_id: { type: 'string' }, status: { enum: ['succeeded', 'failed', 'blocked', 'skipped', 'unavailable'] }, result: { anyOf: [{ type: 'object' }, { type: 'string' }], description: '优先传内联 JSON 对象或 JSON 对象字符串；外部文件路径仅允许位于目标 workspace 之外。total_review 的正式制品由控制器写入全局 artifact store。' }, completion_attestation: { enum: ['native_agent_finished', 'root_rescue_self_completion', 'native_agent_exit_confirmed', 'native_agent_start_failed'], description: '普通节点：仅 root 在确认原生代理 Completed 后用 native_agent_finished。root 救援：root_rescue_self_completion。native_agent_start_failed/native_agent_exit_confirmed 仅用于已有活动 claim 的 workflow-bound total_review，且控制器已记录 unavailable review。' }, state_dir: { type: 'string' } }],
  ['workflow_heartbeat', '更新仍在运行节点的紧凑心跳；仅有效 claim_id 可以更新。', ['task_id', 'node_id', 'claim_id', 'state_dir'], { task_id: { type: 'string' }, node_id: { type: 'string' }, claim_id: { type: 'string' }, state_dir: { type: 'string' } }],
  ['workflow_checkpoint', '持久化运行中代理的紧凑进度 checkpoint；中断后新的代理将收到它和依赖证据组成的恢复包。工作区内 JSON 文件路径会被拒绝。', ['task_id', 'node_id', 'claim_id', 'checkpoint', 'state_dir'], { task_id: { type: 'string' }, node_id: { type: 'string' }, claim_id: { type: 'string' }, checkpoint: { anyOf: [{ type: 'object' }, { type: 'string' }], description: '不超过 32 KiB 的内联 JSON 对象或 JSON 对象字符串；外部文件路径仅允许位于目标 workspace 之外。' }, state_dir: { type: 'string' } }],
  ['workflow_abandon', '在确认原执行者已停止后，以有效 claim_id 显式放弃运行节点；v3 terra_cohort 还必须给出 lane reviewer_slot。', ['task_id', 'node_id', 'claim_id', 'reason', 'previous_agent_stopped', 'state_dir'], { task_id: { type: 'string' }, node_id: { type: 'string' }, claim_id: { type: 'string' }, reason: { type: 'string' }, reviewer_slot: { enum: ['coverage', 'adversarial'], description: '仅 v3 terra_cohort 必填。' }, previous_agent_stopped: { type: 'boolean', const: true }, state_dir: { type: 'string' } }],
  ['workflow_retry', '确认旧执行者停止后重试终态节点；v3 每次有效失败必须先记录对应修复再升级，terra_cohort 的 unavailable 或 abandoned lane 用 reviewer_slot 重试，max closure 失败后禁止自动重试。', ['task_id', 'node_id', 'reason', 'replacement_agent_task_path', 'previous_agent_stopped', 'state_dir'], { task_id: { type: 'string' }, node_id: { type: 'string' }, reason: { type: 'string' }, replacement_agent_task_path: { type: 'string' }, reviewer_slot: { enum: ['coverage', 'adversarial'], description: '仅重试 unavailable 或 abandoned 的 v3 terra_cohort lane 时必填。' }, previous_agent_stopped: { type: 'boolean', const: true }, state_dir: { type: 'string' } }],
  ['workflow_requeue_stale', '协调者已用原生状态确认旧代理停止后，原子地重排队已过期 claim，并把替代实例保留到对应执行者或 cohort lane 后返回恢复包；控制器不能自行停止或恢复 Codex 代理。', ['task_id', 'node_id', 'claim_id', 'reason', 'replacement_agent_task_path', 'previous_agent_stopped', 'state_dir'], { task_id: { type: 'string' }, node_id: { type: 'string' }, claim_id: { type: 'string' }, reason: { type: 'string' }, replacement_agent_task_path: { type: 'string' }, reviewer_slot: { enum: ['coverage', 'adversarial'], description: '仅重排 v3 terra_cohort lane 时必填。' }, previous_agent_stopped: { type: 'boolean', const: true }, state_dir: { type: 'string' } }],
  ['workflow_rescue', '确认 Luna executor 已停止后，把一个正在运行的 delegable 节点显式转交 main/root 救援；记录原 claim、原因、替代路径和恢复包，不伪装为 Luna 已完成。', ['task_id', 'node_id', 'claim_id', 'reason', 'replacement_agent_task_path', 'previous_agent_stopped', 'state_dir'], { task_id: { type: 'string' }, node_id: { type: 'string' }, claim_id: { type: 'string' }, reason: { type: 'string' }, replacement_agent_task_path: { type: 'string' }, previous_agent_stopped: { type: 'boolean', const: true }, state_dir: { type: 'string' } }],
  ['workflow_audit_context', '为独立审核构建完整证据包，包含目标、环境/场景/边界、当前状态、全部审核与修复历史。', ['task_id', 'state_dir'], { task_id: { type: 'string' }, state_dir: { type: 'string' } }],
  ['workflow_record_review', '只由 main/root 调用：先等待审核代理返回审核 JSON，再用 workflow_start 返回的同一 claim_id 记录；成功后才能 workflow_complete。v3 高级审核先独立判断再核对历史，且必须回填 audit-context 的 review_history_digest；terra_cohort 的质询轮必须精确挑战另一 lane 的盲审。审核内容应以内联 JSON 传入，工作区内 JSON 文件路径会被拒绝。', ['task_id', 'review', 'state_dir'], { task_id: { type: 'string' }, review: { anyOf: [{ type: 'object' }, { type: 'string' }], description: '审核 JSON 必须含 claim_id；v3 还必须含 independent_assessment、history_reconciliation、review_history_digest；cohort 质询轮还需 challenge_targets:[另一 lane 的 blind claim_id]。优先传内联对象，外部文件路径仅允许位于目标 workspace 之外。' }, state_dir: { type: 'string' } }],
  ['workflow_record_repair', '记录失败审核或 v3 cohort 的精确修复与验证证据；v3 在每次有效失败后必须先记录该次修复，才可升级。修复内容应以内联 JSON 传入，工作区内 JSON 文件路径会被拒绝。', ['task_id', 'repair', 'state_dir'], { task_id: { type: 'string' }, repair: { anyOf: [{ type: 'object' }, { type: 'string' }], description: '修复 JSON 必须含 source_review_claim_id、repaired_by、addressed_findings、verification_evidence 和当前 workspace_fingerprint。优先传内联对象，外部文件路径仅允许位于目标 workspace 之外。' }, state_dir: { type: 'string' } }],
  ['workflow_close_check', '返回所有节点是否已完成、总审是否仍一致，并在通过时释放工作区租约。', ['task_id', 'state_dir'], { task_id: { type: 'string' }, state_dir: { type: 'string' } }],
  ['workflow_release_workspace', '中断后确认原执行者已停止，且没有运行节点时显式释放工作区租约。', ['task_id', 'previous_agent_stopped', 'state_dir'], { task_id: { type: 'string' }, previous_agent_stopped: { type: 'boolean', const: true }, state_dir: { type: 'string' } }],
  ['workflow_stale', '列出未在启动期限内产生首个心跳或之后失去心跳的运行节点，并返回当前工作区的实际写锁；不会自动接管或过期释放。', ['task_id', 'state_dir'], { task_id: { type: 'string' }, state_dir: { type: 'string' } }],
  ['workflow_status', '默认返回适合轮询的任务摘要及当前工作区实际写锁；仅在排障或审计需要完整参与者、结果和审核记录时设 detail=full。', ['task_id', 'state_dir'], { task_id: { type: 'string' }, state_dir: { type: 'string' }, detail: { enum: ['summary', 'full'], description: '默认 summary；full 返回控制器完整状态视图。' } }],
  ['workflow_wait', '按 workflow_status 或上次 workflow_wait 返回的 cursor 被动等待可操作变化；每次必须传 workflow_init/status 返回的同一非空 task_id 与 state_dir。忽略普通 heartbeat，默认 300 秒、最大 600 秒。', ['task_id', 'state_dir', 'after_cursor'], { task_id: { type: 'string', minLength: 1, description: '复用 workflow_init/status 返回的 task_id，不能为空。' }, state_dir: { type: 'string' }, after_cursor: { type: 'string', description: '最近 workflow_status 或 workflow_wait 返回的 cursor。' }, timeout_sec: { type: 'integer', minimum: 1, maximum: 600, description: '等待上限，默认 300 秒。' } }],
  ['workflow_doctor', '只读诊断指定任务的用户级全局 SQLite 状态、工作区租约、过期节点与受控重派前提；诊断结果以 database_path 和 task_key 定位任务，不会修改或删除状态。', ['task_id', 'state_dir'], { task_id: { type: 'string' }, state_dir: { type: 'string' } }],
].map(([name, description, required, properties]) => ({ name, description, inputSchema: { type: 'object', required, properties } }));

export const TOOL_COMMANDS = Object.fromEntries([['workflow_init', 'init'], ['workflow_raise_assurance', 'raise-assurance'], ['workflow_rebind_pending', 'rebind-pending'], ['workflow_invalidate_gate', 'invalidate-gate'], ['workflow_reconcile_workspace', 'reconcile-workspace'], ['workflow_ready', 'ready'], ['workflow_claim', 'claim'], ['workflow_start', 'start'], ['workflow_acquire_write_lock', 'acquire-write-lock'], ['workflow_release_write_lock', 'release-write-lock'], ['workflow_complete', 'complete'], ['workflow_heartbeat', 'heartbeat'], ['workflow_checkpoint', 'checkpoint'], ['workflow_abandon', 'abandon'], ['workflow_retry', 'retry'], ['workflow_requeue_stale', 'requeue-stale'], ['workflow_rescue', 'rescue'], ['workflow_audit_context', 'audit-context'], ['workflow_record_review', 'record-review'], ['workflow_record_repair', 'record-repair'], ['workflow_close_check', 'close-check'], ['workflow_release_workspace', 'release-workspace'], ['workflow_stale', 'stale'], ['workflow_status', 'status'], ['workflow_wait', 'wait'], ['workflow_doctor', 'doctor']]);
let writeTail = Promise.resolve();
const write = payload => {
  const line = `${JSON.stringify(payload)}\n`;
  const operation = writeTail.then(() => new Promise((resolve, reject) => {
    process.stdout.write(line, error => error ? reject(error) : resolve());
  }));
  writeTail = operation.catch(() => {});
  return operation;
};
const MAX_REQUEST_BYTES = 1 * 1024 * 1024;
const MAX_IN_FLIGHT_REQUESTS = 16;
const MAX_ACTIVE_WORKFLOW_WAITS = 8;
const DEFAULT_WORKFLOW_WAIT_SEC = 300;
const MAX_WORKFLOW_WAIT_SEC = 600;
const MAX_INTERNAL_WAIT_INTERVAL_MS = 15_000;
const activeWorkflowWaits = new Map();
const cancellableRequests = new Map();

async function* boundedJsonLines(input) {
  let segments = [];
  let segmentBytes = 0;
  const pushSegment = segment => {
    if (!segment.length) return;
    segmentBytes += segment.length;
    if (segmentBytes > MAX_REQUEST_BYTES) throw new Error(`Request exceeds the ${MAX_REQUEST_BYTES}-byte limit`);
    segments.push(segment);
  };
  const finishLine = () => {
    const line = Buffer.concat(segments, segmentBytes);
    segments = [];
    segmentBytes = 0;
    const content = line.length && line.at(-1) === 13 ? line.subarray(0, -1) : line;
    return content.toString('utf8');
  };
  for await (const value of input) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    let offset = 0;
    for (;;) {
      const newline = chunk.indexOf(10, offset);
      if (newline === -1) {
        pushSegment(chunk.subarray(offset));
        break;
      }
      pushSegment(chunk.subarray(offset, newline));
      yield finishLine();
      offset = newline + 1;
    }
  }
  if (segmentBytes) yield finishLine();
}

function startRetentionWorker() {
  const worker = path.join(path.dirname(fileURLToPath(import.meta.url)), 'workflow_prune_worker.mjs');
  const child = spawn(process.execPath, [worker], {
    detached: false,
    env: process.env,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.on('error', () => {});
  return child;
}

async function stopRetentionWorker(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill();
  await new Promise(resolve => {
    const timer = setTimeout(resolve, 500);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
}

class WorkflowWaitCancelled extends Error {
  constructor() {
    super('workflow_wait cancelled');
    this.name = 'WorkflowWaitCancelled';
  }
}

function definedObject(entries) {
  return Object.fromEntries(entries.filter(([, value]) => value !== null && value !== undefined));
}

function compactReadyNode(node) {
  return definedObject([
    ['id', node.id],
    ['kind', node.kind],
    ['agent_type', node.agent_type],
    ['depends_on', node.depends_on],
    ['execution_risk', node.execution_risk],
    ['routing_reason', node.routing_reason],
    ['execution_owner', node.execution_owner],
    ['integration_owner', node.integration_owner],
    ['quality_guard', node.quality_guard],
    ['rescue_role', node.rescue_role],
    ['attempt', node.attempt],
  ]);
}

function compactNode(node, fallbackReason = null) {
  return definedObject([
    ['id', node.id],
    ['kind', node.kind],
    ['status', node.status],
    ['agent_type', node.agent_type],
    ['execution_risk', node.execution_risk],
    ['execution_owner', node.execution_owner],
    ['agent_task_path', node.agent_task_path],
    ['agent_thread_id', node.agent_thread_id],
    ['agent_role', node.agent_role],
    ['fallback_reason', fallbackReason],
    ['claim_id', node.claim_id],
    ['attempt', node.attempt],
    ['attempt_budget_used', node.attempt_budget_used],
    ['unavailable_attempts', node.unavailable_attempts],
    ['claimed_at', node.claimed_at],
    ['activation_at', node.activation_at],
    ['activation_deadline_at', node.activation_deadline_at],
    ['heartbeat_at', node.heartbeat_at],
    ['heartbeat_count', node.heartbeat_count],
    ['lease_duration_sec', node.lease_duration_sec],
    ['checkpoint_at', node.checkpoint_at],
    ['rescue_role', node.rescue_role],
    ['result_present', node.result !== null && node.result !== undefined ? true : undefined],
    ['review_stage', node.review_gate?.stage ?? node.review_stage],
    ['review_gate_phase', node.review_gate?.phase ?? null],
    ['cohort_phase', node.review_gate?.cohort?.phase ?? null],
    ['cohort_lanes', node.review_gate?.cohort ? Object.values(node.review_gate.cohort.lanes).map(lane => ({
      slot: lane.slot,
      status: lane.status,
      claim_id: lane.claim_id,
      agent_task_path: lane.agent_task_path,
      claimed_at: lane.claimed_at,
      activation_at: lane.activation_at,
      activation_deadline_at: lane.activation_deadline_at,
      heartbeat_at: lane.heartbeat_at,
      heartbeat_count: lane.heartbeat_count,
      lease_duration_sec: lane.lease_duration_sec,
    })) : null],
  ]);
}

function compactReview(review) {
  if (!review) return null;
  return definedObject([
    ['auditor_task', review.auditor_task],
    ['auditor_role', review.auditor_role],
    ['node_id', review.node_id],
    ['claim_id', review.claim_id],
    ['verdict', review.verdict],
    ['recorded_at', review.recorded_at],
    ['completion_status', review.completion_status],
    ['completion_attestation', review.completion_attestation],
  ]);
}

function compactMaxReviewCharter(charter) {
  if (!charter) return null;
  return definedObject([
    ['status', charter.status],
    ['source_review_claim_id', charter.source_review_claim_id],
    ['blocking_finding_ids', charter.blocking_finding_ids],
    ['repair_count', charter.repair_count],
    ['closure_attempt_count', charter.closure_attempt_count],
    ['closure_attempt_limit', charter.closure_attempt_limit],
    ['scope_decision_required', charter.scope_decision_required],
    ['out_of_charter_finding_count', charter.out_of_charter_findings?.length],
  ]);
}

function workflowObservation(result) {
  return {
    task_id: result.task_id,
    workspace_claims: result.workspace_claims ?? null,
    workspace_lease_status: result.workspace_lease?.status ?? null,
    assurance_level: result.assurance_level ?? null,
    review_protocol_version: result.review_protocol_version ?? null,
    review_entry_stage: result.review_entry_stage ?? null,
    effective_assurance_level: result.effective_assurance_level ?? null,
    workflow_revision: result.workflow_revision ?? null,
    nodes: (result.nodes ?? []).map(node => ({
      id: node.id,
      kind: node.kind,
      status: node.status,
      agent_type: node.agent_type,
      execution_owner: node.execution_owner,
      agent_task_path: node.agent_task_path,
      agent_role: node.agent_role,
      claim_id: node.claim_id,
      attempt: node.attempt,
      rescue_role: node.rescue_role,
      result_present: node.result !== null && node.result !== undefined,
      cohort_lanes: node.review_gate?.cohort ? Object.values(node.review_gate.cohort.lanes).map(lane => ({ slot: lane.slot, status: lane.status, claim_id: lane.claim_id })).sort((left, right) => left.slot.localeCompare(right.slot)) : null,
    })).sort((left, right) => left.id.localeCompare(right.id)),
    ready_nodes: (result.ready_nodes ?? []).map(node => ({ id: node.id, agent_type: node.agent_type, execution_owner: node.execution_owner, attempt: node.attempt })).sort((left, right) => left.id.localeCompare(right.id)),
    stale_nodes: (result.stale_nodes ?? []).map(node => ({ id: node.id, claim_id: node.claim_id, reason: node.reason })).sort((left, right) => left.id.localeCompare(right.id)),
    active_write_locks: (result.active_write_locks ?? []).map(lock => ({ lock_id: lock.lock_id, task_id: lock.task_id, node_id: lock.node_id, prefix: lock.prefix, acquired_at: lock.acquired_at })).sort((left, right) => left.lock_id.localeCompare(right.lock_id)),
    review_count: result.reviews?.length ?? 0,
    repair_record_count: result.repair_records?.length ?? 0,
    latest_review: compactReview(result.reviews?.at(-1)),
    max_review_charter: compactMaxReviewCharter(result.max_review_charter),
  };
}

function workflowCursor(result) {
  return createHash('sha256').update(JSON.stringify(workflowObservation(result))).digest('hex');
}

function compactStatus(result) {
  const participantsByClaim = new Map((result.participants ?? []).map(participant => [participant.claim_id, participant]));
  const nodes = (result.nodes ?? []).map(node => compactNode(node, participantsByClaim.get(node.claim_id)?.fallback_reason));
  const status_counts = Object.create(null);
  for (const node of nodes) status_counts[node.status] = (status_counts[node.status] ?? 0) + 1;
  return definedObject([
    ['task_id', result.task_id],
    ['cursor', workflowCursor(result)],
    ['state_path', result.state_path],
    ['database_path', result.database_path],
    ['task_key', result.task_key],
    ['workspace', result.workspace],
    ['workspace_claims', result.workspace_claims],
    ['workspace_lease', result.workspace_lease ? definedObject([
      ['status', result.workspace_lease.status],
      ['acquired_at', result.workspace_lease.acquired_at],
      ['released_at', result.workspace_lease.released_at],
      ['state_path', result.workspace_lease.state_path],
      ['database_path', result.workspace_lease.database_path],
      ['task_key', result.workspace_lease.task_key],
    ]) : null],
    ['assurance_level', result.assurance_level],
    ['effective_assurance_level', result.effective_assurance_level],
    ['workflow_revision', result.workflow_revision],
    ['status_counts', status_counts],
    ['nodes', nodes],
    ['ready_nodes', (result.ready_nodes ?? []).map(compactReadyNode)],
    ['stale_nodes', result.stale_nodes ?? []],
    ['active_write_locks', result.active_write_locks ?? []],
    ['participant_count', result.participants?.length ?? 0],
    ['review_count', result.reviews?.length ?? 0],
    ['repair_record_count', result.repair_records?.length ?? 0],
    ['latest_review', compactReview(result.reviews?.at(-1))],
    ['max_review_charter', compactMaxReviewCharter(result.max_review_charter)],
    ['updated_at', result.updated_at],
  ]);
}

function compactNodeEnvelope(result, fallbackReason = null, stateDir = null) {
  return definedObject([
    ['task_id', result.task_id],
    ['state_dir', stateDir],
    ['node_id', result.node?.id ?? null],
    ['claim_id', result.claim_id ?? result.node?.claim_id ?? null],
    ['reviewer_slot', result.reviewer_slot ?? null],
    ['review_protocol_version', result.review_protocol_version],
    ['review_entry_stage', result.review_entry_stage],
    ['assurance_level', result.assurance_level],
    ['effective_assurance_level', result.effective_assurance_level],
    ['node', result.node ? compactNode(result.node, fallbackReason) : null],
    ['ready_nodes', result.ready_nodes?.map(compactReadyNode)],
    ['recovery_package', result.recovery_package],
    ['input_artifact', result.input_artifact],
    ['rescue_role', result.rescue_role],
    ['workflow_outcome_completion', result.workflow_outcome_completion],
  ]);
}

export function compactMcpResult(toolName, result, argumentsValue = {}) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
  if (toolName === 'workflow_status') {
    if (argumentsValue.detail !== undefined && !['summary', 'full'].includes(argumentsValue.detail)) throw new ControllerError('workflow_status.detail must be summary or full');
    return argumentsValue.detail === 'full' ? result : compactStatus(result);
  }
  if (toolName === 'workflow_init') return { state_dir: result.state_dir, state_path: result.state_path, database_path: result.database_path, task_key: result.task_key, task: compactStatus(result.task) };
  if (toolName === 'workflow_raise_assurance') return {
    task_id: result.task_id,
    prior_assurance_level: result.prior_assurance_level,
    assurance_level: result.assurance_level,
    effective_assurance_level: result.effective_assurance_level,
    node: compactNode(result.node),
    ready_nodes: result.ready_nodes?.map(compactReadyNode),
  };
  if (toolName === 'workflow_invalidate_gate') return {
    task_id: result.task_id,
    assurance_level: result.assurance_level,
    effective_assurance_level: result.effective_assurance_level,
    gate_kind: result.gate_kind,
    invalidation_reasons: result.invalidation_reasons,
    node: result.node ? compactNode(result.node) : null,
    ready_nodes: result.ready_nodes?.map(compactReadyNode),
  };
  if (toolName === 'workflow_ready') return { ready_nodes: (result.ready_nodes ?? []).map(compactReadyNode) };
  if (['workflow_claim', 'workflow_start', 'workflow_heartbeat', 'workflow_abandon', 'workflow_retry', 'workflow_rebind_pending', 'workflow_requeue_stale', 'workflow_rescue', 'workflow_complete'].includes(toolName)) {
    return compactNodeEnvelope(result, argumentsValue.fallback_reason, argumentsValue.state_dir);
  }
  if (toolName === 'workflow_record_review') return { task_id: result.task_id, assurance_level: result.assurance_level, effective_assurance_level: result.effective_assurance_level, review: compactReview(result.review), max_review_charter: compactMaxReviewCharter(result.max_review_charter) };
  if (toolName === 'workflow_record_repair') return { task_id: result.task_id, assurance_level: result.assurance_level, effective_assurance_level: result.effective_assurance_level, repair_record: result.repair_record, max_review_charter: compactMaxReviewCharter(result.max_review_charter) };
  return result;
}

function summaryText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 240);
}

function mcpTextSummary(toolName, value, { error = false } = {}) {
  if (error) return `${toolName} failed: ${summaryText(value?.error ?? value)}`;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return `${toolName} completed.`;
  const taskId = value.task_id ?? value.task?.task_id ?? null;
  const state = value.reason ?? value.status ?? value.workspace_lease_status ?? value.node?.status ?? null;
  const nodeId = value.node_id ?? value.node?.id ?? null;
  const claimId = value.claim_id ?? value.node?.claim_id ?? null;
  const details = [taskId ? `task=${summaryText(taskId)}` : null, nodeId ? `node=${summaryText(nodeId)}` : null, claimId ? `claim=${summaryText(claimId)}` : null, state !== null ? `state=${summaryText(state)}` : null].filter(Boolean);
  return `${toolName} completed${details.length ? ` (${details.join(', ')})` : ''}.`;
}

function structuredMcpContent(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : { value };
}

function workflowWaitTimeout(value) {
  const timeout = value ?? DEFAULT_WORKFLOW_WAIT_SEC;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > MAX_WORKFLOW_WAIT_SEC) throw new ControllerError(`timeout_sec must be an integer between 1 and ${MAX_WORKFLOW_WAIT_SEC}`);
  return timeout;
}

function waitForTaskStateSignal(_stateDir, _taskId, _controlPath, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    const watchers = [];
    let settled = false;
    let timer = null;
    const abort = () => {
      finish(new WorkflowWaitCancelled());
    };
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const watcher of watchers) {
        try { watcher.close(); } catch {}
      }
      signal?.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve();
    };
    if (signal?.aborted) return abort();
    signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => finish(), timeoutMs);
    const globalPath = globalWorkflowStorePath();
    const globalDirectory = path.dirname(globalPath);
    const directories = [globalDirectory];
    for (const directory of directories) {
      try {
        const watcher = watch(directory, { persistent: false }, (_event, filename) => {
          const name = filename?.toString();
          if (!name) return;
          const normalized = process.platform === 'win32' ? name.toLocaleLowerCase('en-US') : name;
          const globalDatabaseName = process.platform === 'win32' ? path.basename(globalPath).toLocaleLowerCase('en-US') : path.basename(globalPath);
          // A global DB notification is a hint only. The cursor check above
          // filters writes for other task namespaces and heartbeat-only updates.
          if (normalized === globalDatabaseName || normalized.startsWith(`${globalDatabaseName}.`) || normalized.startsWith(`${globalDatabaseName}-`)) finish();
        });
        watcher.on('error', () => {});
        watchers.push(watcher);
      } catch {
        // The adaptive timeout remains the fallback when the platform watcher is unavailable.
      }
    }
  });
}

function recommendedWaitSeconds(summary) {
  if (summary.ready_nodes?.length || summary.stale_nodes?.length) return 0;
  const running = summary.nodes?.filter(node => node.status === 'running') ?? [];
  if (!running.length) return DEFAULT_WORKFLOW_WAIT_SEC;
  const now = Date.now();
  const deadlines = running.flatMap(node => {
    const heartbeat = Date.parse(node.heartbeat_at ?? node.claimed_at);
    if (!Number.isFinite(heartbeat) || !node.lease_duration_sec) return [];
    return [heartbeat + node.lease_duration_sec * 1000];
  });
  if (!deadlines.length) return DEFAULT_WORKFLOW_WAIT_SEC;
  return Math.max(0, Math.min(DEFAULT_WORKFLOW_WAIT_SEC, Math.ceil((Math.min(...deadlines) - now) / 1000)));
}

export function nextWorkflowDeadlineMs(summary) {
  const nodeDeadline = node => {
    if (!node.activation_at && node.activation_deadline_at) {
      const activation = Date.parse(node.activation_deadline_at);
      return Number.isFinite(activation) ? [activation] : [];
    }
    const heartbeat = Date.parse(node.heartbeat_at ?? node.claimed_at);
    const duration = Number(node.lease_duration_sec);
    return Number.isFinite(heartbeat) && Number.isFinite(duration) && duration > 0 ? [heartbeat + duration * 1000] : [];
  };
  const deadlines = (summary.nodes ?? []).filter(node => node.status === 'running').flatMap(node => {
    const lanes = (node.cohort_lanes ?? []).filter(lane => lane.status === 'running');
    return lanes.length ? lanes.flatMap(nodeDeadline) : nodeDeadline(node);
  });
  return deadlines.length ? Math.min(...deadlines) : null;
}

function sameTaskSignal(left, right) {
  return Boolean(left && right)
    && left.instance_id === right.instance_id
    && left.task_change_counter === right.task_change_counter
    && left.workspace_change_counter === right.workspace_change_counter;
}

function workflowWaitResult(summary, changed, reason) {
  const terminal = new Set(['succeeded', 'failed', 'blocked', 'skipped', 'unavailable', 'abandoned']);
  return definedObject([
    ['changed', changed],
    ['reason', reason],
    ['task_id', summary.task_id],
    ['cursor', summary.cursor],
    ['assurance_level', summary.assurance_level],
    ['effective_assurance_level', summary.effective_assurance_level],
    ['status_counts', summary.status_counts],
    ['ready_nodes', summary.ready_nodes],
    ['stale_nodes', summary.stale_nodes],
    ['running_nodes', summary.nodes.filter(node => node.status === 'running').map(node => definedObject([['id', node.id], ['agent_role', node.agent_role], ['claim_id', node.claim_id], ['attempt', node.attempt]]))],
    ['terminal_nodes', summary.nodes.filter(node => terminal.has(node.status)).map(node => definedObject([['id', node.id], ['status', node.status], ['attempt', node.attempt], ['result_present', node.result_present]]))],
    ['latest_review', summary.latest_review],
    ['recommended_wait_sec', recommendedWaitSeconds(summary)],
  ]);
}

async function waitForWorkflowChange(parameters, signal) {
  const taskId = typeof parameters.task_id === 'string' ? parameters.task_id.trim() : '';
  const rawStateDir = typeof parameters.state_dir === 'string' ? parameters.state_dir.trim() : '';
  if (!rawStateDir || !path.isAbsolute(rawStateDir)) throw new ControllerError('state_dir must be an absolute path');
  const afterCursor = typeof parameters.after_cursor === 'string' ? parameters.after_cursor.trim() : '';
  if (!taskId) throw new ControllerError('task_id must be a non-empty string; call workflow_status or reuse the task_id returned by workflow_init before calling workflow_wait');
  if (!/^[a-f0-9]{64}$/.test(afterCursor)) throw new ControllerError('after_cursor must be a workflow_status or workflow_wait cursor');
  const timeoutSec = workflowWaitTimeout(parameters.timeout_sec);
  // Reserve a lexical key before the first filesystem await. This closes the
  // small event-loop window where two concurrent requests could both pass the
  // active-wait check before canonicalizing an alias or existing directory.
  const provisionalKey = statePathKey(path.join(path.resolve(rawStateDir), `${taskId}.sqlite`));
  if (activeWorkflowWaits.has(provisionalKey)) throw new ControllerError('A workflow_wait is already active for this task in the MCP server');
  if (activeWorkflowWaits.size >= MAX_ACTIVE_WORKFLOW_WAITS) throw new ControllerError(`MCP server already has ${MAX_ACTIVE_WORKFLOW_WAITS} active workflow waits`);
  activeWorkflowWaits.set(provisionalKey, signal);
  let waitKey = provisionalKey;
  try {
    const stateDir = await canonicalStateDirectory(rawStateDir);
    const canonicalTaskStatePath = path.join(stateDir, `${taskId}.sqlite`);
    const canonicalKey = statePathKey(canonicalTaskStatePath);
    if (canonicalKey !== provisionalKey) {
      if (activeWorkflowWaits.has(canonicalKey)) throw new ControllerError('A workflow_wait is already active for this task in the MCP server');
      activeWorkflowWaits.delete(provisionalKey);
      activeWorkflowWaits.set(canonicalKey, signal);
      waitKey = canonicalKey;
    }
    const taskStatePath = canonicalTaskStatePath;
    const deadline = Date.now() + timeoutSec * 1000;
    let intervalMs = 1_000;
    let taskSignal = null;
    for (;;) {
      if (signal?.aborted) throw new WorkflowWaitCancelled();
      const [state] = await dispatch('status', { task_id: taskId, state_dir: stateDir });
      const summary = compactStatus(state);
      if (summary.cursor !== afterCursor) return workflowWaitResult(summary, true, 'state_changed');
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) return workflowWaitResult(summary, false, 'timeout');
      const workspace = state.workspace;
      const taskStatePath = path.join(stateDir, `${taskId}.sqlite`);
      taskSignal ??= await readGlobalTaskChangeToken(taskStatePath, workspace);
      const nextDeadline = nextWorkflowDeadlineMs(summary);
      const deadlineWait = nextDeadline === null ? remainingMs : Math.max(0, nextDeadline - Date.now());
      const waitMs = Math.min(intervalMs, remainingMs, deadlineWait);
      if (waitMs <= 0) continue;
      await waitForTaskStateSignal(stateDir, taskId, workspace, waitMs, signal);
      const nextSignal = await readGlobalTaskChangeToken(taskStatePath, workspace);
      if (sameTaskSignal(taskSignal, nextSignal)) {
        intervalMs = Math.min(MAX_INTERNAL_WAIT_INTERVAL_MS, Math.ceil(intervalMs * 1.8));
      } else {
        taskSignal = nextSignal;
        intervalMs = 1_000;
      }
    }
  } finally {
    if (activeWorkflowWaits.get(waitKey) === signal) activeWorkflowWaits.delete(waitKey);
  }
}

function requestKey(id) {
  return `${typeof id}:${String(id)}`;
}

function validateWorkflowInitManifest(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return;
  if (typeof value === 'string' && value.trim()) return;
  throw new ControllerError('workflow_init.manifest must be a non-empty v3 manifest object, inline JSON object string, or JSON file path');
}

async function handle(request) {
  const id = request.id; const method = request.method;
  if (method === 'notifications/initialized') return;
  if (method === 'notifications/cancelled') {
    const requestId = request.params?.requestId;
    const cancellation = cancellableRequests.get(requestKey(requestId));
    if (cancellation) cancellation.abort();
    return;
  }
  if (method === 'initialize') return write({ jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'agnets-workflow', version: '0.2.1' } } });
  if (method === 'tools/list') return write({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
  if (method !== 'tools/call') return write({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown method: ${method}` } });
  const command = TOOL_COMMANDS[request.params?.name];
  if (!command) return write({ jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool: ${request.params?.name}` } });
  const cancellation = request.params.name === 'workflow_wait' ? new AbortController() : null;
  if (cancellation) cancellableRequests.set(requestKey(id), cancellation);
  try {
    const argumentsValue = request.params?.arguments ?? {};
    if (request.params.name === 'workflow_init') validateWorkflowInitManifest(argumentsValue.manifest);
    const result = request.params.name === 'workflow_wait'
      ? await waitForWorkflowChange(argumentsValue, cancellation.signal)
      : (await dispatch(command, argumentsValue))[0];
    const compactResult = compactMcpResult(request.params.name, result, argumentsValue);
    await write({
      jsonrpc: '2.0',
      id,
      result: {
        content: [{ type: 'text', text: mcpTextSummary(request.params.name, compactResult) }],
        structuredContent: structuredMcpContent(compactResult),
      },
    });
  }
  catch (error) {
    if (error instanceof WorkflowWaitCancelled) return;
    const message = error instanceof ControllerError ? error.message : String(error);
    const errorContent = { error: message };
    await write({
      jsonrpc: '2.0',
      id,
      result: {
        content: [{ type: 'text', text: mcpTextSummary(request.params.name, errorContent, { error: true }) }],
        structuredContent: errorContent,
        isError: true,
      },
    });
  }
  finally {
    if (cancellation) cancellableRequests.delete(requestKey(id));
  }
}

export async function main() {
  const pending = new Set();
  const retentionWorker = startRetentionWorker();
  try {
    for await (const line of boundedJsonLines(process.stdin)) {
      while (pending.size >= MAX_IN_FLIGHT_REQUESTS) await Promise.race(pending);
      const request = (async () => {
        try {
          const parsed = JSON.parse(line); if (!parsed || typeof parsed !== 'object') throw new Error('Request must be an object'); await handle(parsed);
        } catch (error) { await write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: error.message } }); }
      })();
      pending.add(request);
      request.finally(() => pending.delete(request));
    }
  } catch (error) {
    await write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: error.message } });
  }
  for (const cancellation of cancellableRequests.values()) cancellation.abort();
  await Promise.all(pending);
  await writeTail;
  await stopRetentionWorker(retentionWorker);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
