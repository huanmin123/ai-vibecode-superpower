import { createHash } from 'node:crypto';
import { watch } from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ControllerError, dispatch } from './workflow_controller.mjs';

export const TOOLS = [
  ['workflow_init', '从 JSON 清单创建持久化 DAG；v1 节点必须包含完整路由字段，state_dir 必须为绝对路径。', ['manifest', 'state_dir'], { manifest: { type: 'string' }, state_dir: { type: 'string' } }],
  ['workflow_reconcile_workspace', '恢复初始化中断留下的工作区租约；只会激活可验证状态或清理确认不存在的状态。', ['workspace'], { workspace: { type: 'string' } }],
  ['workflow_ready', '返回所有依赖均已成功的 DAG 节点。', ['task_id', 'state_dir'], { task_id: { type: 'string' }, state_dir: { type: 'string' } }],
  ['workflow_claim', '认领就绪节点并返回 claim_id；随后立即 heartbeat。Terra fallback 必须提供 fallback_reason。', ['task_id', 'node_id', 'agent_task_path', 'agent_role', 'state_dir'], { task_id: { type: 'string' }, node_id: { type: 'string' }, agent_task_path: { type: 'string' }, agent_thread_id: { type: 'string' }, agent_role: { type: 'string' }, fallback_reason: { type: 'string' }, lease_duration_sec: { type: 'integer', minimum: 1 }, activation_timeout_sec: { type: 'integer', minimum: 1 }, state_dir: { type: 'string' } }],
  ['workflow_start', '由已开始回合的原生代理原子认领并激活节点；Terra fallback 必须提供 fallback_reason。', ['task_id', 'node_id', 'agent_task_path', 'agent_role', 'native_agent_started', 'state_dir'], { task_id: { type: 'string' }, node_id: { type: 'string' }, agent_task_path: { type: 'string' }, agent_thread_id: { type: 'string' }, agent_role: { type: 'string' }, fallback_reason: { type: 'string' }, native_agent_started: { type: 'boolean', const: true, description: '仅在原生 agent 已开始当前回合后传入。' }, lease_duration_sec: { type: 'integer', minimum: 1 }, activation_timeout_sec: { type: 'integer', minimum: 1 }, state_dir: { type: 'string' } }],
  ['workflow_complete', '以匹配的 claim_id、结果文件和 completion_attestation 完成节点；放弃使用 workflow_abandon。', ['task_id', 'node_id', 'claim_id', 'status', 'result', 'completion_attestation', 'state_dir'], { task_id: { type: 'string' }, node_id: { type: 'string' }, claim_id: { type: 'string' }, status: { enum: ['succeeded', 'failed', 'blocked', 'skipped', 'unavailable'] }, result: { type: 'string' }, completion_attestation: { enum: ['native_agent_finished', 'root_rescue_self_completion', 'native_agent_exit_confirmed', 'native_agent_start_failed'], description: '普通节点用 native_agent_finished；Root 救援用 root_rescue_self_completion；总审 unavailable 可用其余两项。' }, state_dir: { type: 'string' } }],
  ['workflow_heartbeat', '更新仍在运行节点的紧凑心跳；仅有效 claim_id 可以更新。', ['task_id', 'node_id', 'claim_id', 'state_dir'], { task_id: { type: 'string' }, node_id: { type: 'string' }, claim_id: { type: 'string' }, state_dir: { type: 'string' } }],
  ['workflow_checkpoint', '持久化运行中代理的紧凑进度 checkpoint；中断后新的代理将收到它和依赖证据组成的恢复包。', ['task_id', 'node_id', 'claim_id', 'checkpoint', 'state_dir'], { task_id: { type: 'string' }, node_id: { type: 'string' }, claim_id: { type: 'string' }, checkpoint: { type: 'string', description: '不超过 32 KiB 的 JSON checkpoint 文件路径。' }, state_dir: { type: 'string' } }],
  ['workflow_abandon', '在确认原执行者已停止后，以有效 claim_id 显式放弃运行节点。', ['task_id', 'node_id', 'claim_id', 'reason', 'previous_agent_stopped', 'state_dir'], { task_id: { type: 'string' }, node_id: { type: 'string' }, claim_id: { type: 'string' }, reason: { type: 'string' }, previous_agent_stopped: { type: 'boolean', const: true }, state_dir: { type: 'string' } }],
  ['workflow_retry', '确认旧执行者停止后重试终态节点；v1 路由需 replacement_agent_task_path，总审角色按失败历史升级。', ['task_id', 'node_id', 'reason', 'previous_agent_stopped', 'state_dir'], { task_id: { type: 'string' }, node_id: { type: 'string' }, reason: { type: 'string' }, replacement_agent_task_path: { type: 'string' }, previous_agent_stopped: { type: 'boolean', const: true }, state_dir: { type: 'string' } }],
  ['workflow_requeue_stale', '协调者已用原生状态确认旧代理停止后，原子地重排队已过期 claim，并把 execution_owner 显式绑定到预定替代实例后返回恢复包；控制器不能自行停止或恢复 Codex 代理。', ['task_id', 'node_id', 'claim_id', 'reason', 'replacement_agent_task_path', 'previous_agent_stopped', 'state_dir'], { task_id: { type: 'string' }, node_id: { type: 'string' }, claim_id: { type: 'string' }, reason: { type: 'string' }, replacement_agent_task_path: { type: 'string' }, previous_agent_stopped: { type: 'boolean', const: true }, state_dir: { type: 'string' } }],
  ['workflow_rescue', '确认 Luna executor 已停止后，把一个正在运行的 delegable 节点显式转交 main/root 救援；记录原 claim、原因、替代路径和恢复包，不伪装为 Luna 已完成。', ['task_id', 'node_id', 'claim_id', 'reason', 'replacement_agent_task_path', 'previous_agent_stopped', 'state_dir'], { task_id: { type: 'string' }, node_id: { type: 'string' }, claim_id: { type: 'string' }, reason: { type: 'string' }, replacement_agent_task_path: { type: 'string' }, previous_agent_stopped: { type: 'boolean', const: true }, state_dir: { type: 'string' } }],
  ['workflow_recover_lock', '仅在同一主机的锁超过阈值且其进程已不存在时归档陈旧锁。', ['task_id', 'state_dir'], { task_id: { type: 'string' }, stale_after_sec: { type: 'integer', minimum: 1 }, state_dir: { type: 'string' } }],
  ['workflow_audit_context', '为独立 Sol 总审构建紧凑且最新的证据包。', ['task_id', 'state_dir'], { task_id: { type: 'string' }, state_dir: { type: 'string' } }],
  ['workflow_record_review', '记录并验证绑定当前工作区指纹及总审节点 claim_id 的独立总审。', ['task_id', 'review', 'state_dir'], { task_id: { type: 'string' }, review: { type: 'string', description: '审核 JSON 必须含 claim_id，且匹配运行中的 total_review 节点。' }, state_dir: { type: 'string' } }],
  ['workflow_close_check', '返回所有节点是否已完成、总审是否仍一致，并在通过时释放工作区租约。', ['task_id', 'state_dir'], { task_id: { type: 'string' }, state_dir: { type: 'string' } }],
  ['workflow_release_workspace', '中断后确认全部旧代理停止，且没有运行节点时显式释放工作区租约。', ['task_id', 'previous_agents_stopped', 'state_dir'], { task_id: { type: 'string' }, previous_agents_stopped: { type: 'boolean', const: true }, state_dir: { type: 'string' } }],
  ['workflow_stale', '列出未在启动期限内产生首个心跳或之后失去心跳的运行节点；不会自动接管。', ['task_id', 'state_dir'], { task_id: { type: 'string' }, state_dir: { type: 'string' } }],
  ['workflow_status', '默认返回适合轮询的任务摘要；仅在排障或审计需要完整参与者、结果和审核记录时设 detail=full。', ['task_id', 'state_dir'], { task_id: { type: 'string' }, state_dir: { type: 'string' }, detail: { enum: ['summary', 'full'], description: '默认 summary；full 返回控制器完整状态视图。' } }],
  ['workflow_wait', '按 cursor 被动等待可操作变化；忽略普通 heartbeat，默认 300 秒、最大 600 秒。', ['task_id', 'state_dir', 'after_cursor'], { task_id: { type: 'string' }, state_dir: { type: 'string' }, after_cursor: { type: 'string', description: '最近状态或等待结果的 cursor。' }, timeout_sec: { type: 'integer', minimum: 1, maximum: 600, description: '等待上限，默认 300 秒。' } }],
  ['workflow_doctor', '只读诊断当前任务的 SQLite 状态、工作区租约、协调文件、过期节点与受控重派前提；省略 task_id 时列出错误隔离项和孤立 legacy 副本；不会修改或删除状态。', ['state_dir'], { task_id: { type: 'string' }, state_dir: { type: 'string' } }],
  ['workflow_reconcile_quarantine', '重试已知隔离目录中未完成的文件与 review 证据传输；不会删除隔离内容或未知文件。', ['state_dir'], { state_dir: { type: 'string' } }],
  ['workflow_prune_expired', '按 7/30/365 天策略清理或隔离过期状态；活动或不可验证状态保留。', ['state_dir'], { state_dir: { type: 'string' } }],
].map(([name, description, required, properties]) => ({ name, description, inputSchema: { type: 'object', required, properties } }));

export const TOOL_COMMANDS = Object.fromEntries([['workflow_init', 'init'], ['workflow_reconcile_workspace', 'reconcile-workspace'], ['workflow_ready', 'ready'], ['workflow_claim', 'claim'], ['workflow_start', 'start'], ['workflow_complete', 'complete'], ['workflow_heartbeat', 'heartbeat'], ['workflow_checkpoint', 'checkpoint'], ['workflow_abandon', 'abandon'], ['workflow_retry', 'retry'], ['workflow_requeue_stale', 'requeue-stale'], ['workflow_rescue', 'rescue'], ['workflow_recover_lock', 'recover-lock'], ['workflow_audit_context', 'audit-context'], ['workflow_record_review', 'record-review'], ['workflow_close_check', 'close-check'], ['workflow_release_workspace', 'release-workspace'], ['workflow_stale', 'stale'], ['workflow_status', 'status'], ['workflow_wait', 'wait'], ['workflow_doctor', 'doctor'], ['workflow_reconcile_quarantine', 'reconcile-quarantine'], ['workflow_prune_expired', 'prune-expired']]);
const write = payload => process.stdout.write(`${JSON.stringify(payload)}\n`);
const MAX_REQUEST_BYTES = 1 * 1024 * 1024;
const MAX_IN_FLIGHT_REQUESTS = 16;
const MAX_ACTIVE_WORKFLOW_WAITS = 8;
const DEFAULT_WORKFLOW_WAIT_SEC = 300;
const MAX_WORKFLOW_WAIT_SEC = 600;
const MAX_INTERNAL_WAIT_INTERVAL_MS = 15_000;
const activeWorkflowWaits = new Map();
const cancellableRequests = new Map();

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
    ['claimed_at', node.claimed_at],
    ['activation_at', node.activation_at],
    ['activation_deadline_at', node.activation_deadline_at],
    ['heartbeat_at', node.heartbeat_at],
    ['heartbeat_count', node.heartbeat_count],
    ['lease_duration_sec', node.lease_duration_sec],
    ['checkpoint_at', node.checkpoint_at],
    ['rescue_role', node.rescue_role],
    ['result_present', node.result !== null && node.result !== undefined ? true : undefined],
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

function workflowObservation(result) {
  return {
    task_id: result.task_id,
    workspace_lease_status: result.workspace_lease?.status ?? null,
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
    })).sort((left, right) => left.id.localeCompare(right.id)),
    ready_nodes: (result.ready_nodes ?? []).map(node => ({ id: node.id, agent_type: node.agent_type, execution_owner: node.execution_owner, attempt: node.attempt })).sort((left, right) => left.id.localeCompare(right.id)),
    stale_nodes: (result.stale_nodes ?? []).map(node => ({ id: node.id, claim_id: node.claim_id, reason: node.reason })).sort((left, right) => left.id.localeCompare(right.id)),
    review_count: result.reviews?.length ?? 0,
    latest_review: compactReview(result.reviews?.at(-1)),
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
    ['workspace', result.workspace],
    ['workspace_lease', result.workspace_lease ? definedObject([
      ['status', result.workspace_lease.status],
      ['acquired_at', result.workspace_lease.acquired_at],
      ['released_at', result.workspace_lease.released_at],
    ]) : null],
    ['status_counts', status_counts],
    ['nodes', nodes],
    ['ready_nodes', (result.ready_nodes ?? []).map(compactReadyNode)],
    ['stale_nodes', result.stale_nodes ?? []],
    ['participant_count', result.participants?.length ?? 0],
    ['review_count', result.reviews?.length ?? 0],
    ['latest_review', compactReview(result.reviews?.at(-1))],
    ['updated_at', result.updated_at],
  ]);
}

function compactNodeEnvelope(result, fallbackReason = null) {
  return definedObject([
    ['task_id', result.task_id],
    ['node', result.node ? compactNode(result.node, fallbackReason) : null],
    ['ready_nodes', result.ready_nodes?.map(compactReadyNode)],
    ['recovery_package', result.recovery_package],
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
  if (toolName === 'workflow_init') return { state_path: result.state_path, task: compactStatus(result.task) };
  if (toolName === 'workflow_ready') return { ready_nodes: (result.ready_nodes ?? []).map(compactReadyNode) };
  if (['workflow_claim', 'workflow_start', 'workflow_heartbeat', 'workflow_abandon', 'workflow_retry', 'workflow_requeue_stale', 'workflow_rescue', 'workflow_complete'].includes(toolName)) {
    return compactNodeEnvelope(result, argumentsValue.fallback_reason);
  }
  if (toolName === 'workflow_record_review') return { task_id: result.task_id, review: compactReview(result.review) };
  return result;
}

function workflowWaitTimeout(value) {
  const timeout = value ?? DEFAULT_WORKFLOW_WAIT_SEC;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > MAX_WORKFLOW_WAIT_SEC) throw new ControllerError(`timeout_sec must be an integer between 1 and ${MAX_WORKFLOW_WAIT_SEC}`);
  return timeout;
}

function waitForTaskStateSignal(stateDir, taskId, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    let watcher = null;
    let settled = false;
    let timer = null;
    const abort = () => {
      finish(new WorkflowWaitCancelled());
    };
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { watcher?.close(); } catch {}
      signal?.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve();
    };
    if (signal?.aborted) return abort();
    signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => finish(), timeoutMs);
    try {
      watcher = watch(stateDir, { persistent: false }, (_event, filename) => {
        const name = filename?.toString();
        if (!name || name === `${taskId}.json` || name === `${taskId}.json.legacy` || name === `${taskId}.sqlite` || name.startsWith(`${taskId}.sqlite-`)) finish();
      });
      watcher.on('error', () => {});
    } catch {
      // The adaptive timeout remains the fallback when the platform watcher is unavailable.
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
  return Math.max(30, Math.min(DEFAULT_WORKFLOW_WAIT_SEC, Math.ceil((Math.min(...deadlines) - now) / 1000)));
}

function workflowWaitResult(summary, changed, reason) {
  const terminal = new Set(['succeeded', 'failed', 'blocked', 'skipped', 'unavailable', 'abandoned']);
  return definedObject([
    ['changed', changed],
    ['reason', reason],
    ['task_id', summary.task_id],
    ['cursor', summary.cursor],
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
  const stateDir = rawStateDir && path.isAbsolute(rawStateDir) ? path.resolve(rawStateDir) : '';
  const afterCursor = typeof parameters.after_cursor === 'string' ? parameters.after_cursor.trim() : '';
  if (!taskId) throw new ControllerError('task_id must be a non-empty string');
  if (!stateDir) throw new ControllerError('state_dir must be an absolute path');
  if (!/^[a-f0-9]{64}$/.test(afterCursor)) throw new ControllerError('after_cursor must be a workflow_status or workflow_wait cursor');
  const timeoutSec = workflowWaitTimeout(parameters.timeout_sec);
  const waitKey = `${stateDir}\u0000${taskId}`;
  if (activeWorkflowWaits.has(waitKey)) throw new ControllerError('A workflow_wait is already active for this task in the MCP server');
  if (activeWorkflowWaits.size >= MAX_ACTIVE_WORKFLOW_WAITS) throw new ControllerError(`MCP server already has ${MAX_ACTIVE_WORKFLOW_WAITS} active workflow waits`);
  activeWorkflowWaits.set(waitKey, signal);
  try {
    const deadline = Date.now() + timeoutSec * 1000;
    let intervalMs = 1_000;
    for (;;) {
      if (signal?.aborted) throw new WorkflowWaitCancelled();
      const [state] = await dispatch('status', { task_id: taskId, state_dir: stateDir });
      const summary = compactStatus(state);
      if (summary.cursor !== afterCursor) return workflowWaitResult(summary, true, 'state_changed');
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) return workflowWaitResult(summary, false, 'timeout');
      await waitForTaskStateSignal(stateDir, taskId, Math.min(intervalMs, remainingMs), signal);
      intervalMs = Math.min(MAX_INTERNAL_WAIT_INTERVAL_MS, Math.ceil(intervalMs * 1.8));
    }
  } finally {
    activeWorkflowWaits.delete(waitKey);
  }
}

function requestKey(id) {
  return `${typeof id}:${String(id)}`;
}

async function handle(request) {
  const id = request.id; const method = request.method;
  if (method === 'notifications/initialized') return;
  if (method === 'notifications/cancelled') {
    const requestId = request.params?.requestId;
    cancellableRequests.get(requestKey(requestId))?.abort();
    return;
  }
  if (method === 'initialize') return write({ jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'agnets-workflow', version: '0.2.0' } } });
  if (method === 'tools/list') return write({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
  if (method !== 'tools/call') return write({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown method: ${method}` } });
  const command = TOOL_COMMANDS[request.params?.name];
  if (!command) return write({ jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool: ${request.params?.name}` } });
  const cancellation = request.params.name === 'workflow_wait' ? new AbortController() : null;
  if (cancellation) cancellableRequests.set(requestKey(id), cancellation);
  try {
    const argumentsValue = request.params?.arguments ?? {};
    const result = request.params.name === 'workflow_wait'
      ? await waitForWorkflowChange(argumentsValue, cancellation.signal)
      : (await dispatch(command, argumentsValue))[0];
    const compactResult = compactMcpResult(request.params.name, result, argumentsValue);
    write({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(compactResult) }] } });
  }
  catch (error) {
    if (error instanceof WorkflowWaitCancelled) return;
    const message = error instanceof ControllerError ? error.message : String(error);
    write({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true } });
  }
  finally {
    if (cancellation) cancellableRequests.delete(requestKey(id));
  }
}

export async function main() {
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  const pending = new Set();
  for await (const line of input) {
    while (pending.size >= MAX_IN_FLIGHT_REQUESTS) await Promise.race(pending);
    const request = (async () => {
      try {
        if (Buffer.byteLength(line, 'utf8') > MAX_REQUEST_BYTES) throw new Error(`Request exceeds the ${MAX_REQUEST_BYTES}-byte limit`);
        const parsed = JSON.parse(line); if (!parsed || typeof parsed !== 'object') throw new Error('Request must be an object'); await handle(parsed);
      } catch (error) { write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: error.message } }); }
    })();
    pending.add(request);
    request.finally(() => pending.delete(request));
  }
  for (const cancellation of cancellableRequests.values()) cancellation.abort();
  await Promise.all(pending);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
