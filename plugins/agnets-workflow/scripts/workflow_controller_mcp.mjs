import readline from 'node:readline';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ControllerError, dispatch } from './workflow_controller.mjs';

export const TOOLS = [
  ['workflow_init', '从 JSON 清单创建持久化工作流 DAG；state_dir 必须为绝对路径。新清单设 routing_schema_version=1 时，每个节点必须记录 execution_risk、routing_reason、execution_owner、integration_owner 与 quality_guard。', ['manifest', 'state_dir'], { manifest: { type: 'string' }, state_dir: { type: 'string' } }],
  ['workflow_reconcile_workspace', '恢复初始化中断留下的工作区租约；只会激活可验证状态或清理确认不存在的状态。', ['workspace'], { workspace: { type: 'string' } }],
  ['workflow_ready', '返回所有依赖均已成功的 DAG 节点。', ['task_id', 'state_dir'], { task_id: { type: 'string' }, state_dir: { type: 'string' } }],
  ['workflow_claim', '记录原生 Codex 代理已认领一个就绪的 DAG 节点，并返回 claim_id；认领后代理必须立即调用 workflow_heartbeat，total_review 没有启动心跳不能记录审核。agent_thread_id 仅在宿主实际提供时记录，用于未来原生恢复候选。', ['task_id', 'node_id', 'agent_task_path', 'agent_role', 'state_dir'], { task_id: { type: 'string' }, node_id: { type: 'string' }, agent_task_path: { type: 'string' }, agent_thread_id: { type: 'string' }, agent_role: { type: 'string' }, lease_duration_sec: { type: 'integer', minimum: 1 }, activation_timeout_sec: { type: 'integer', minimum: 1 }, state_dir: { type: 'string' } }],
  ['workflow_complete', '持久化由 claim_id 持有者完成的节点结果，并解锁其依赖节点；放弃必须使用 workflow_abandon。', ['task_id', 'node_id', 'claim_id', 'status', 'result', 'state_dir'], { task_id: { type: 'string' }, node_id: { type: 'string' }, claim_id: { type: 'string' }, status: { enum: ['succeeded', 'failed', 'blocked', 'skipped', 'unavailable'] }, result: { type: 'string' }, state_dir: { type: 'string' } }],
  ['workflow_heartbeat', '更新仍在运行节点的紧凑心跳；仅有效 claim_id 可以更新。', ['task_id', 'node_id', 'claim_id', 'state_dir'], { task_id: { type: 'string' }, node_id: { type: 'string' }, claim_id: { type: 'string' }, state_dir: { type: 'string' } }],
  ['workflow_checkpoint', '持久化运行中代理的紧凑进度 checkpoint；中断后新的代理将收到它和依赖证据组成的恢复包。', ['task_id', 'node_id', 'claim_id', 'checkpoint', 'state_dir'], { task_id: { type: 'string' }, node_id: { type: 'string' }, claim_id: { type: 'string' }, checkpoint: { type: 'string', description: '不超过 32 KiB 的 JSON checkpoint 文件路径。' }, state_dir: { type: 'string' } }],
  ['workflow_abandon', '在确认原执行者已停止后，以有效 claim_id 显式放弃运行节点。', ['task_id', 'node_id', 'claim_id', 'reason', 'state_dir'], { task_id: { type: 'string' }, node_id: { type: 'string' }, claim_id: { type: 'string' }, reason: { type: 'string' }, state_dir: { type: 'string' } }],
  ['workflow_retry', '确认旧执行者停止后，将 failed、blocked、unavailable 或 abandoned 节点重新置为待认领。现代路由必须提供新实例预定的 replacement_agent_task_path，以显式重绑定 execution_owner。', ['task_id', 'node_id', 'reason', 'previous_agent_stopped', 'state_dir'], { task_id: { type: 'string' }, node_id: { type: 'string' }, reason: { type: 'string' }, replacement_agent_task_path: { type: 'string' }, previous_agent_stopped: { type: 'boolean', const: true }, state_dir: { type: 'string' } }],
  ['workflow_requeue_stale', '协调者已用原生状态确认旧代理停止后，原子地重排队已过期 claim，并把 execution_owner 显式绑定到预定替代实例后返回恢复包；控制器不能自行停止或恢复 Codex 代理。', ['task_id', 'node_id', 'claim_id', 'reason', 'replacement_agent_task_path', 'previous_agent_stopped', 'state_dir'], { task_id: { type: 'string' }, node_id: { type: 'string' }, claim_id: { type: 'string' }, reason: { type: 'string' }, replacement_agent_task_path: { type: 'string' }, previous_agent_stopped: { type: 'boolean', const: true }, state_dir: { type: 'string' } }],
  ['workflow_recover_lock', '仅在同一主机的锁超过阈值且其进程已不存在时归档陈旧锁。', ['task_id', 'state_dir'], { task_id: { type: 'string' }, stale_after_sec: { type: 'integer', minimum: 1 }, state_dir: { type: 'string' } }],
  ['workflow_audit_context', '为独立 Sol 总审构建紧凑且最新的证据包。', ['task_id', 'state_dir'], { task_id: { type: 'string' }, state_dir: { type: 'string' } }],
  ['workflow_record_review', '记录并验证绑定当前工作区指纹及总审节点 claim_id 的独立总审。', ['task_id', 'review', 'state_dir'], { task_id: { type: 'string' }, review: { type: 'string', description: '审核 JSON 必须含 claim_id，且匹配运行中的 total_review 节点。' }, state_dir: { type: 'string' } }],
  ['workflow_close_check', '返回所有节点是否已完成、总审是否仍一致，并在通过时释放工作区租约。', ['task_id', 'state_dir'], { task_id: { type: 'string' }, state_dir: { type: 'string' } }],
  ['workflow_release_workspace', '中断后确认全部旧代理停止，且没有运行节点时显式释放工作区租约。', ['task_id', 'previous_agents_stopped', 'state_dir'], { task_id: { type: 'string' }, previous_agents_stopped: { type: 'boolean', const: true }, state_dir: { type: 'string' } }],
  ['workflow_stale', '列出未在启动期限内产生首个心跳或之后失去心跳的运行节点；不会自动接管。', ['task_id', 'state_dir'], { task_id: { type: 'string' }, state_dir: { type: 'string' } }],
  ['workflow_status', '返回当前任务状态、参与者、就绪节点、过期节点和审核记录。', ['task_id', 'state_dir'], { task_id: { type: 'string' }, state_dir: { type: 'string' } }],
  ['workflow_prune_expired', '立即扫描并删除 state_dir 内连续 7 天未更新、租约已释放、没有运行节点且可完整验证的任务状态；不会删除活动、未知、legacy 或无法解析的任务。普通操作通过 state_dir 中的持久化标记，对同一目录最多每 6 小时执行一轮惰性清理。', ['state_dir'], { state_dir: { type: 'string' } }],
].map(([name, description, required, properties]) => ({ name, description, inputSchema: { type: 'object', required, properties } }));

export const TOOL_COMMANDS = Object.fromEntries([['workflow_init', 'init'], ['workflow_reconcile_workspace', 'reconcile-workspace'], ['workflow_ready', 'ready'], ['workflow_claim', 'claim'], ['workflow_complete', 'complete'], ['workflow_heartbeat', 'heartbeat'], ['workflow_checkpoint', 'checkpoint'], ['workflow_abandon', 'abandon'], ['workflow_retry', 'retry'], ['workflow_requeue_stale', 'requeue-stale'], ['workflow_recover_lock', 'recover-lock'], ['workflow_audit_context', 'audit-context'], ['workflow_record_review', 'record-review'], ['workflow_close_check', 'close-check'], ['workflow_release_workspace', 'release-workspace'], ['workflow_stale', 'stale'], ['workflow_status', 'status'], ['workflow_prune_expired', 'prune-expired']]);
const write = payload => process.stdout.write(`${JSON.stringify(payload)}\n`);
const MAX_REQUEST_BYTES = 1 * 1024 * 1024;
const MAX_IN_FLIGHT_REQUESTS = 16;

async function handle(request) {
  const id = request.id; const method = request.method;
  if (method === 'notifications/initialized') return;
  if (method === 'initialize') return write({ jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'agnets-workflow', version: '0.2.0' } } });
  if (method === 'tools/list') return write({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
  if (method !== 'tools/call') return write({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown method: ${method}` } });
  const command = TOOL_COMMANDS[request.params?.name];
  if (!command) return write({ jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool: ${request.params?.name}` } });
  try { const [result] = await dispatch(command, request.params?.arguments ?? {}); write({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result) }] } }); }
  catch (error) { const message = error instanceof ControllerError ? error.message : String(error); write({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true } }); }
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
  await Promise.all(pending);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
