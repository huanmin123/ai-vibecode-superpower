import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { compactMcpResult } from '../scripts/workflow_controller_mcp.mjs';

const mcpScript = fileURLToPath(new URL('../scripts/workflow_controller_mcp.mjs', import.meta.url));

function startMcp() {
  const child = spawn(process.execPath, [mcpScript], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let buffered = '';
  const pending = new Map();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffered += chunk;
    for (;;) {
      const newline = buffered.indexOf('\n');
      if (newline === -1) return;
      const line = buffered.slice(0, newline); buffered = buffered.slice(newline + 1);
      const message = JSON.parse(line); const resolve = pending.get(message.id);
      if (resolve) { pending.delete(message.id); resolve(message); }
    }
  });
  let nextId = 1;
  return {
    child,
    request(value) {
      const id = nextId++;
      const promise = new Promise((resolve, reject) => {
        pending.set(id, resolve);
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, ...value })}\n`, error => {
          if (error) { pending.delete(id); reject(error); }
        });
      });
      promise.requestId = id;
      return promise;
    },
    notify(value) {
      child.stdin.write(`${JSON.stringify(value)}\n`);
    },
  };
}

async function waitForChildExit(child, timeoutMs = 2_000) {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise(resolve => {
    const onExit = () => { clearTimeout(timer); resolve(true); };
    const timer = setTimeout(() => { child.off('exit', onExit); resolve(false); }, timeoutMs);
    child.once('exit', onExit);
  });
}

test('MCP server creates and reads a SQLite-backed workflow task over stdio', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agnets-workflow-mcp-'));
  const workspace = path.join(root, 'workspace'); const stateDir = path.join(root, 'state'); const manifest = path.join(root, 'manifest.json');
  const server = startMcp();
  try {
    await mkdir(workspace); await writeFile(path.join(workspace, 'app.txt'), 'test\n');
    await writeFile(manifest, JSON.stringify({ task_id: 'mcp-task', workspace, goal: 'verify MCP persistence', requirements: [{ id: 'R1', text: 'store state' }], nodes: [{ id: 'total-review', kind: 'total_review', agent_type: 'avsp_sol_high' }] }));
    const initialized = await server.request({ method: 'initialize', params: {} });
    assert.equal(initialized.result.serverInfo.name, 'agnets-workflow');
    const init = await server.request({ method: 'tools/call', params: { name: 'workflow_init', arguments: { manifest, state_dir: stateDir } } });
    assert.equal(JSON.parse(init.result.content[0].text).task.task_id, 'mcp-task');
    const status = await server.request({ method: 'tools/call', params: { name: 'workflow_status', arguments: { task_id: 'mcp-task', state_dir: stateDir } } });
    const statusSummary = JSON.parse(status.result.content[0].text);
    assert.equal(statusSummary.task_id, 'mcp-task');
    assert.deepEqual(statusSummary.status_counts, { pending: 1 });
    assert.equal(statusSummary.participant_count, 0);
    assert.equal(statusSummary.review_count, 0);
    assert.equal(statusSummary.nodes[0].id, 'total-review');
    assert.equal('result' in statusSummary.nodes[0], false);
    const fullStatus = await server.request({ method: 'tools/call', params: { name: 'workflow_status', arguments: { task_id: 'mcp-task', state_dir: stateDir, detail: 'full' } } });
    const fullStatusValue = JSON.parse(fullStatus.result.content[0].text);
    assert.equal(fullStatusValue.task_id, 'mcp-task');
    assert.ok(Array.isArray(fullStatusValue.participants));
    assert.ok(Array.isArray(fullStatusValue.reviews));
    const relativeWait = await server.request({ method: 'tools/call', params: { name: 'workflow_wait', arguments: { task_id: 'mcp-task', state_dir: '.', after_cursor: statusSummary.cursor, timeout_sec: 1 } } });
    assert.equal(relativeWait.result.isError, true);
    assert.match(JSON.parse(relativeWait.result.content[0].text).error, /state_dir must be an absolute path/);
    const doctor = await server.request({ method: 'tools/call', params: { name: 'workflow_doctor', arguments: { task_id: 'mcp-task', state_dir: stateDir } } });
    const diagnosis = JSON.parse(doctor.result.content[0].text);
    assert.equal(diagnosis.health, 'healthy');
    assert.equal(diagnosis.checks.find(check => check.id === 'state_database').status, 'pass');
    const directoryDoctor = await server.request({ method: 'tools/call', params: { name: 'workflow_doctor', arguments: { state_dir: stateDir } } });
    const directoryDiagnosis = JSON.parse(directoryDoctor.result.content[0].text);
    assert.equal(directoryDiagnosis.health, 'healthy');
    assert.deepEqual(directoryDiagnosis.checks.find(check => check.id === 'orphan_legacy').detail.paths, []);
    const ready = await server.request({ method: 'tools/call', params: { name: 'workflow_ready', arguments: { task_id: 'mcp-task', state_dir: stateDir } } });
    const readyNode = JSON.parse(ready.result.content[0].text).ready_nodes[0];
    assert.equal(readyNode.id, 'total-review');
    assert.equal(readyNode.agent_type, 'avsp_sol_high');
    assert.equal('result' in readyNode, false);
    const waitForStart = server.request({ method: 'tools/call', params: { name: 'workflow_wait', arguments: { task_id: 'mcp-task', state_dir: stateDir, after_cursor: statusSummary.cursor, timeout_sec: 5 } } });
    const started = await server.request({ method: 'tools/call', params: { name: 'workflow_start', arguments: { task_id: 'mcp-task', node_id: 'total-review', agent_task_path: '/root/mcp-review', agent_role: 'avsp_sol_high', native_agent_started: true, state_dir: stateDir } } });
    const startedNode = JSON.parse(started.result.content[0].text).node;
    assert.equal(startedNode.status, 'running');
    assert.equal(startedNode.heartbeat_count, 1);
    assert.equal(typeof startedNode.claim_id, 'string');
    assert.equal('checkpoint' in startedNode, false);
    const startChange = JSON.parse((await waitForStart).result.content[0].text);
    assert.equal(startChange.changed, true);
    assert.equal(startChange.reason, 'state_changed');
    assert.equal(startChange.running_nodes[0].claim_id, startedNode.claim_id);
    const runningStatus = await server.request({ method: 'tools/call', params: { name: 'workflow_status', arguments: { task_id: 'mcp-task', state_dir: stateDir } } });
    const runningCursor = JSON.parse(runningStatus.result.content[0].text).cursor;
    const ignoreHeartbeat = server.request({ method: 'tools/call', params: { name: 'workflow_wait', arguments: { task_id: 'mcp-task', state_dir: stateDir, after_cursor: runningCursor, timeout_sec: 1 } } });
    const heartbeat = await server.request({ method: 'tools/call', params: { name: 'workflow_heartbeat', arguments: { task_id: 'mcp-task', node_id: 'total-review', claim_id: startedNode.claim_id, state_dir: stateDir } } });
    const heartbeatNode = JSON.parse(heartbeat.result.content[0].text).node;
    assert.equal(heartbeatNode.claim_id, startedNode.claim_id);
    assert.equal(heartbeatNode.heartbeat_count, 2);
    assert.equal(heartbeatNode.lease_duration_sec, 1800);
    const heartbeatWait = JSON.parse((await ignoreHeartbeat).result.content[0].text);
    assert.equal(heartbeatWait.changed, false);
    assert.equal(heartbeatWait.reason, 'timeout');
    assert.equal(heartbeatWait.cursor, runningCursor);
    assert.equal((await readFile(path.join(stateDir, 'mcp-task.sqlite'))).subarray(0, 16).toString(), 'SQLite format 3\u0000');
  } finally {
    server.child.stdin.end();
    await new Promise(resolve => server.child.once('exit', resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test('MCP workflow_wait can be cancelled without blocking later requests', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agnets-workflow-mcp-cancel-'));
  const workspace = path.join(root, 'workspace'); const stateDir = path.join(root, 'state'); const manifest = path.join(root, 'manifest.json');
  const server = startMcp();
  try {
    await mkdir(workspace);
    await writeFile(manifest, JSON.stringify({ task_id: 'cancel-task', workspace, goal: 'verify cancellation', requirements: [{ id: 'R1', text: 'wait' }], nodes: [{ id: 'total-review', kind: 'total_review', agent_type: 'avsp_sol_high' }] }));
    await server.request({ method: 'initialize', params: {} });
    await server.request({ method: 'tools/call', params: { name: 'workflow_init', arguments: { manifest, state_dir: stateDir } } });
    const status = await server.request({ method: 'tools/call', params: { name: 'workflow_status', arguments: { task_id: 'cancel-task', state_dir: stateDir } } });
    const cursor = JSON.parse(status.result.content[0].text).cursor;
    const waiting = server.request({ method: 'tools/call', params: { name: 'workflow_wait', arguments: { task_id: 'cancel-task', state_dir: stateDir, after_cursor: cursor, timeout_sec: 30 } } });
    await new Promise(resolve => setTimeout(resolve, 100));
    server.notify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: waiting.requestId } });
    const next = await server.request({ method: 'tools/call', params: { name: 'workflow_status', arguments: { task_id: 'cancel-task', state_dir: stateDir } } });
    assert.equal(JSON.parse(next.result.content[0].text).task_id, 'cancel-task');
    const responded = await Promise.race([waiting.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 100))]);
    assert.equal(responded, false);
    const secondWait = await server.request({ method: 'tools/call', params: { name: 'workflow_wait', arguments: { task_id: 'cancel-task', state_dir: stateDir, after_cursor: cursor, timeout_sec: 1 } } });
    const secondWaitResult = JSON.parse(secondWait.result.content[0].text);
    assert.equal(secondWaitResult.changed, false);
    assert.equal(secondWaitResult.reason, 'timeout');
  } finally {
    server.child.stdin.end();
    await new Promise(resolve => server.child.once('exit', resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test('MCP server cancels active workflow waits when stdin closes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agnets-workflow-mcp-eof-'));
  const workspace = path.join(root, 'workspace'); const stateDir = path.join(root, 'state'); const manifest = path.join(root, 'manifest.json');
  const server = startMcp();
  try {
    await mkdir(workspace);
    await writeFile(manifest, JSON.stringify({ task_id: 'eof-task', workspace, goal: 'exit after stdin closes', requirements: [{ id: 'R1', text: 'wait' }], nodes: [{ id: 'total-review', kind: 'total_review', agent_type: 'avsp_sol_high' }] }));
    await server.request({ method: 'initialize', params: {} });
    await server.request({ method: 'tools/call', params: { name: 'workflow_init', arguments: { manifest, state_dir: stateDir } } });
    const status = await server.request({ method: 'tools/call', params: { name: 'workflow_status', arguments: { task_id: 'eof-task', state_dir: stateDir } } });
    const cursor = JSON.parse(status.result.content[0].text).cursor;
    const waiting = server.request({ method: 'tools/call', params: { name: 'workflow_wait', arguments: { task_id: 'eof-task', state_dir: stateDir, after_cursor: cursor, timeout_sec: 30 } } });
    await new Promise(resolve => setTimeout(resolve, 100));
    server.child.stdin.end();
    assert.equal(await waitForChildExit(server.child), true);
    const responded = await Promise.race([waiting.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 100))]);
    assert.equal(responded, false);
  } finally {
    if (server.child.exitCode === null && server.child.signalCode === null) {
      server.child.kill();
      await waitForChildExit(server.child);
    }
    await rm(root, { recursive: true, force: true });
  }
});

test('MCP result compaction keeps scheduling facts and drops repeated heavy state', () => {
  const largeResult = { summary: 'done', log: 'x'.repeat(16_384) };
  const node = {
    id: 'work', kind: 'implementation', status: 'running', agent_type: 'avsp_terra_low_readonly', depends_on: [],
    execution_risk: 'read_only', routing_reason: 'bounded evidence', execution_owner: '/root/evidence', integration_owner: '/root', quality_guard: 'cite evidence',
    agent_task_path: '/root/evidence', agent_thread_id: 'thread-1', agent_role: 'avsp_terra_low_readonly', claim_id: 'claim-1', attempt: 1,
    claimed_at: '2026-08-09T00:00:00.000Z', activation_at: '2026-08-09T00:00:01.000Z', activation_deadline_at: null,
    heartbeat_at: '2026-08-09T00:00:02.000Z', heartbeat_count: 2, lease_duration_sec: 1800, checkpoint: { detail: 'x'.repeat(4096) }, checkpoint_at: '2026-08-09T00:00:02.000Z',
    result: largeResult, recovery_history: [{ result: largeResult }], rescue_role: null, workflow_completion_intent: null,
  };
  const full = {
    task_id: 'task-1', workspace: 'F:\\work', workspace_lease: { status: 'active', acquired_at: '2026-08-09T00:00:00.000Z', registry_path: 'F:\\work\\.codex\\workflow-controller\\workspace-lease.json' },
    goal: 'large goal', nodes: [node], ready_nodes: [], stale_nodes: [],
    participants: [{ claim_id: 'claim-1', fallback_reason: 'avsp_luna_high unavailable', detail: 'x'.repeat(4096) }],
    reviews: [{ auditor_task: '/root/reviewer', auditor_role: 'avsp_sol_high', node_id: 'review', claim_id: 'review-1', verdict: 'pass', requirement_coverage: { R1: 'x'.repeat(4096) }, recorded_at: '2026-08-09T00:00:03.000Z' }],
    updated_at: '2026-08-09T00:00:03.000Z',
  };

  const summary = compactMcpResult('workflow_status', full);
  assert.equal(summary.nodes[0].claim_id, 'claim-1');
  assert.equal(summary.nodes[0].lease_duration_sec, 1800);
  assert.equal(summary.nodes[0].fallback_reason, 'avsp_luna_high unavailable');
  assert.equal(summary.nodes[0].result_present, true);
  assert.equal('result' in summary.nodes[0], false);
  assert.equal('checkpoint' in summary.nodes[0], false);
  assert.equal('participants' in summary, false);
  assert.equal(summary.latest_review.verdict, 'pass');
  assert.ok(JSON.stringify(summary).length < JSON.stringify(full).length / 4);
  assert.equal(compactMcpResult('workflow_status', full, { detail: 'full' }), full);
});
