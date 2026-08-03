import readline from 'node:readline';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ControllerError, dispatch } from './workflow_controller.mjs';

const TOOLS = [
  ['workflow_init', '从 JSON 清单创建持久化工作流 DAG。', ['manifest'], { manifest: { type: 'string' }, state_dir: { type: 'string' } }],
  ['workflow_ready', '返回所有依赖均已成功的 DAG 节点。', ['task_id'], { task_id: { type: 'string' }, state_dir: { type: 'string' } }],
  ['workflow_claim', '记录原生 Codex 代理已认领一个就绪的 DAG 节点，并返回后续操作所需的 claim_id。', ['task_id', 'node_id', 'agent_task_path', 'agent_role'], { task_id: { type: 'string' }, node_id: { type: 'string' }, agent_task_path: { type: 'string' }, agent_role: { type: 'string' }, lease_duration_sec: { type: 'integer', minimum: 1 }, state_dir: { type: 'string' } }],
  ['workflow_complete', '持久化由 claim_id 持有者完成的节点结果，并解锁其依赖节点；放弃必须使用 workflow_abandon。', ['task_id', 'node_id', 'claim_id', 'status', 'result'], { task_id: { type: 'string' }, node_id: { type: 'string' }, claim_id: { type: 'string' }, status: { enum: ['succeeded', 'failed', 'blocked', 'skipped', 'unavailable'] }, result: { type: 'string' }, state_dir: { type: 'string' } }],
  ['workflow_heartbeat', '更新仍在运行节点的心跳；仅有效 claim_id 可以更新。', ['task_id', 'node_id', 'claim_id'], { task_id: { type: 'string' }, node_id: { type: 'string' }, claim_id: { type: 'string' }, state_dir: { type: 'string' } }],
  ['workflow_abandon', '在确认原执行者已停止后，以有效 claim_id 显式放弃运行节点。', ['task_id', 'node_id', 'claim_id', 'reason'], { task_id: { type: 'string' }, node_id: { type: 'string' }, claim_id: { type: 'string' }, reason: { type: 'string' }, state_dir: { type: 'string' } }],
  ['workflow_retry', '确认旧执行者停止后，将 failed、blocked、unavailable 或 abandoned 节点重新置为待认领。', ['task_id', 'node_id', 'reason', 'previous_agent_stopped'], { task_id: { type: 'string' }, node_id: { type: 'string' }, reason: { type: 'string' }, previous_agent_stopped: { type: 'boolean', const: true }, state_dir: { type: 'string' } }],
  ['workflow_recover_lock', '仅在同一主机的锁超过阈值且其进程已不存在时归档陈旧锁。', ['task_id'], { task_id: { type: 'string' }, stale_after_sec: { type: 'integer', minimum: 1 }, state_dir: { type: 'string' } }],
  ['workflow_audit_context', '为独立 Sol 总审构建紧凑且最新的证据包。', ['task_id'], { task_id: { type: 'string' }, state_dir: { type: 'string' } }],
  ['workflow_record_review', '记录并验证绑定当前工作区指纹及总审节点 claim_id 的独立总审。', ['task_id', 'review'], { task_id: { type: 'string' }, review: { type: 'string', description: '审核 JSON 必须含 claim_id，且匹配运行中的 total_review 节点。' }, state_dir: { type: 'string' } }],
  ['workflow_close_check', '返回所有节点是否已完成，以及最近独立总审是否仍与工作区一致。', ['task_id'], { task_id: { type: 'string' }, state_dir: { type: 'string' } }],
  ['workflow_status', '返回当前任务状态、参与者、就绪节点和审核记录。', ['task_id'], { task_id: { type: 'string' }, state_dir: { type: 'string' } }],
].map(([name, description, required, properties]) => ({ name, description, inputSchema: { type: 'object', required, properties } }));

const TOOL_COMMANDS = Object.fromEntries([['workflow_init', 'init'], ['workflow_ready', 'ready'], ['workflow_claim', 'claim'], ['workflow_complete', 'complete'], ['workflow_heartbeat', 'heartbeat'], ['workflow_abandon', 'abandon'], ['workflow_retry', 'retry'], ['workflow_recover_lock', 'recover-lock'], ['workflow_audit_context', 'audit-context'], ['workflow_record_review', 'record-review'], ['workflow_close_check', 'close-check'], ['workflow_status', 'status']]);
const write = payload => process.stdout.write(`${JSON.stringify(payload)}\n`);

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
  for await (const line of input) { try { const request = JSON.parse(line); if (!request || typeof request !== 'object') throw new Error('Request must be an object'); await handle(request); } catch (error) { write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: error.message } }); } }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
