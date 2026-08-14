import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mcp = path.join(root, 'scripts', 'workflow_controller_mcp.mjs');

function solAssessment() {
  const dimension = status => ({ status, evidence: ['independent review is required'], rationale: `risk is ${status}` });
  return { impact: dimension('controlled'), recoverability: dimension('controlled'), uncertainty: dimension('unknown'), verifiability: dimension('controlled'), coupling: dimension('controlled'), selection_reason: 'The task requires a Sol quality gate.' };
}

function v3McpManifest(workspace) {
  return {
    task_id: 'mcp-task', workspace, workspace_claims: [{ mode: 'read', prefix: '.' }], goal: 'Exercise the v3 MCP protocol.', requirements: [{ id: 'R1', text: 'MCP persists and reports current state.' }], scope: [], non_goals: [], routing_schema_version: 3,
    assurance_level: 'sol', assurance_assessment: solAssessment(), review_context: { environment: 'isolated MCP test workspace', scenarios: ['stdio request and wait'], boundaries: 'declared workspace only' }, review_entry_stage: 'sol_high',
    nodes: [{ id: 'total-review', kind: 'total_review', agent_type: 'avsp_sol_high', depends_on: [], execution_risk: 'read_only', routing_reason: 'independent final review', execution_owner: '/root/mcp-sol-review', integration_owner: '/root', quality_guard: 'validate MCP state response' }],
  };
}

function startMcp() {
  const child = spawn(process.execPath, [mcp], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const pending = new Map();
  let buffered = '';
  let nextId = 1;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffered += chunk;
    for (;;) {
      const newline = buffered.indexOf('\n');
      if (newline === -1) return;
      const message = JSON.parse(buffered.slice(0, newline));
      buffered = buffered.slice(newline + 1);
      const resolve = pending.get(message.id);
      if (resolve) { pending.delete(message.id); resolve(message); }
    }
  });
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
    notify(value) { child.stdin.write(`${JSON.stringify(value)}\n`); },
  };
}

async function closeMcp(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.stdin.end();
  await new Promise(resolve => {
    const timer = setTimeout(() => { child.kill(); resolve(); }, 2_000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
}

test('MCP exposes the v3 workflow contract without retired verification tooling', async () => {
  const source = await readFile(mcp, 'utf8');
  assert.match(source, /workflow_raise_assurance/);
  assert.doesNotMatch(source, /workflow_record_verification/);
  assert.doesNotMatch(source, /\.json\.legacy/);
});

test('MCP serves v3 workflow state over stdio and releases a cancelled wait', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'agnets-workflow-mcp-v3-'));
  const workspace = path.join(temp, 'workspace');
  const stateDir = path.join(temp, 'state');
  const manifestPath = path.join(temp, 'manifest.json');
  const server = startMcp();
  try {
    await mkdir(workspace, { recursive: true });
    await writeFile(path.join(workspace, 'source.txt'), 'review target\n');
    await writeFile(manifestPath, JSON.stringify(v3McpManifest(workspace)));

    const initialized = await server.request({ method: 'initialize', params: {} });
    assert.equal(initialized.result.serverInfo.name, 'agnets-workflow');
    const init = await server.request({ method: 'tools/call', params: { name: 'workflow_init', arguments: { manifest: manifestPath, state_dir: stateDir } } });
    assert.equal(JSON.parse(init.result.content[0].text).task.task_id, 'mcp-task');

    const status = await server.request({ method: 'tools/call', params: { name: 'workflow_status', arguments: { task_id: 'mcp-task', state_dir: stateDir } } });
    const summary = JSON.parse(status.result.content[0].text);
    assert.deepEqual(summary.status_counts, { pending: 1 });
    const waiting = server.request({ method: 'tools/call', params: { name: 'workflow_wait', arguments: { task_id: 'mcp-task', state_dir: stateDir, after_cursor: summary.cursor, timeout_sec: 30 } } });
    const started = await server.request({ method: 'tools/call', params: { name: 'workflow_start', arguments: { task_id: 'mcp-task', node_id: 'total-review', agent_task_path: '/root/mcp-sol-review', agent_role: 'avsp_sol_high', native_agent_started: true, state_dir: stateDir } } });
    const startedNode = JSON.parse(started.result.content[0].text).node;
    const changed = JSON.parse((await waiting).result.content[0].text);
    assert.equal(changed.changed, true);
    assert.equal(changed.reason, 'state_changed');
    assert.equal(changed.running_nodes[0].id, 'total-review');
    const heartbeat = await server.request({ method: 'tools/call', params: { name: 'workflow_heartbeat', arguments: { task_id: 'mcp-task', node_id: 'total-review', claim_id: startedNode.claim_id, state_dir: stateDir } } });
    assert.equal(heartbeat.result.isError, undefined);

    const current = await server.request({ method: 'tools/call', params: { name: 'workflow_status', arguments: { task_id: 'mcp-task', state_dir: stateDir } } });
    const currentSummary = JSON.parse(current.result.content[0].text);
    const cancelled = server.request({ method: 'tools/call', params: { name: 'workflow_wait', arguments: { task_id: 'mcp-task', state_dir: stateDir, after_cursor: currentSummary.cursor, timeout_sec: 30 } } });
    const duplicate = await server.request({ method: 'tools/call', params: { name: 'workflow_wait', arguments: { task_id: 'mcp-task', state_dir: stateDir, after_cursor: currentSummary.cursor, timeout_sec: 30 } } });
    assert.equal(duplicate.result.isError, true);
    assert.match(JSON.parse(duplicate.result.content[0].text).error, /already active/);
    server.notify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: cancelled.requestId } });
    const afterCancellation = await server.request({ method: 'tools/call', params: { name: 'workflow_status', arguments: { task_id: 'mcp-task', state_dir: stateDir } } });
    assert.equal(JSON.parse(afterCancellation.result.content[0].text).task_id, 'mcp-task');
    const resumed = server.request({ method: 'tools/call', params: { name: 'workflow_wait', arguments: { task_id: 'mcp-task', state_dir: stateDir, after_cursor: currentSummary.cursor, timeout_sec: 30 } } });
    const resumedDuplicate = await server.request({ method: 'tools/call', params: { name: 'workflow_wait', arguments: { task_id: 'mcp-task', state_dir: stateDir, after_cursor: currentSummary.cursor, timeout_sec: 30 } } });
    assert.equal(resumedDuplicate.result.isError, true);
    assert.match(JSON.parse(resumedDuplicate.result.content[0].text).error, /already active/);
    const abandoned = await server.request({ method: 'tools/call', params: { name: 'workflow_abandon', arguments: { task_id: 'mcp-task', node_id: 'total-review', claim_id: startedNode.claim_id, reason: 'MCP cancellation test completed.', previous_agent_stopped: true, state_dir: stateDir } } });
    assert.equal(abandoned.result.isError, undefined);
    const resumedState = JSON.parse((await resumed).result.content[0].text);
    assert.equal(resumedState.changed, true);
    assert.equal(resumedState.reason, 'state_changed');
  } finally {
    await closeMcp(server.child);
    await rm(temp, { recursive: true, force: true });
  }
});
