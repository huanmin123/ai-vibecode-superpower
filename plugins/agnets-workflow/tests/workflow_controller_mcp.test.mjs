import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const isolatedCodexHome = await mkdtemp(path.join(os.tmpdir(), 'agnets-workflow-mcp-codex-home-'));
const previousCodexHome = process.env.CODEX_HOME;
process.env.CODEX_HOME = isolatedCodexHome;
test.after(async () => {
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  await rm(isolatedCodexHome, { recursive: true, force: true });
});

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mcp = path.join(root, 'scripts', 'workflow_controller_mcp.mjs');

async function canonicalStateNamespace(stateDir) {
  const { canonicalStateDirectory } = await import('../scripts/workflow_controller.mjs');
  return canonicalStateDirectory(stateDir);
}

function solAssessment() {
  const dimension = status => ({ status, evidence: ['independent review is required'], rationale: `risk is ${status}` });
  return { impact: dimension('controlled'), recoverability: dimension('controlled'), uncertainty: dimension('unknown'), verifiability: dimension('controlled'), coupling: dimension('controlled'), selection_reason: 'The task requires a Sol quality gate.' };
}

function v3McpManifest(workspace, taskId = 'mcp-task') {
  return {
    task_id: taskId, workspace, workspace_claims: [{ mode: 'read', prefix: '.' }], goal: 'Exercise the v3 MCP protocol.', requirements: [{ id: 'R1', text: 'MCP persists and reports current state.' }], scope: [], non_goals: [], routing_schema_version: 3,
    assurance_level: 'sol', assurance_assessment: solAssessment(), review_context: { environment: 'isolated MCP test workspace', scenarios: ['stdio request and wait'], boundaries: 'declared workspace only' }, review_entry_stage: 'sol_high',
    nodes: [{ id: 'total-review', kind: 'total_review', agent_type: 'avsp_sol_high', depends_on: [], execution_risk: 'read_only', routing_reason: 'independent final review', execution_owner: taskId === 'mcp-task' ? '/root/mcp-sol-review' : `/root/${taskId}-sol-review`, integration_owner: '/root', quality_guard: 'validate MCP state response' }],
  };
}

function startMcp() {
  const child = spawn(process.execPath, [mcp], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, CODEX_HOME: isolatedCodexHome } });
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

function resultObject(response) {
  assert.ok(response?.result?.structuredContent, 'MCP result must expose structuredContent');
  assert.equal(response.result.content?.[0]?.type, 'text');
  assert.doesNotMatch(response.result.content[0].text, /^\s*[\[{]/, 'MCP human text must not be a raw JSON document');
  return response.result.structuredContent;
}

async function waitUntil(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() >= deadline) throw new Error('Timed out waiting for the background MCP retention worker');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

test('MCP exposes the current v3 workflow contract', async () => {
  const source = await readFile(mcp, 'utf8');
  assert.match(source, /workflow_raise_assurance/);
  assert.match(source, /workflow_acquire_write_lock/);
  assert.match(source, /workflow_release_write_lock/);
  assert.doesNotMatch(source, /workflow_recover_lock/);
  assert.doesNotMatch(source, /workflow_record_verification/);
});

test('MCP wait scheduling uses the earliest Terra cohort lane deadline', async () => {
  const { nextWorkflowDeadlineMs } = await import('../scripts/workflow_controller_mcp.mjs');
  const heartbeat = Date.parse('2026-08-18T00:00:00.000Z');
  const activation = Date.parse('2026-08-18T00:00:03.000Z');
  const deadline = nextWorkflowDeadlineMs({
    nodes: [{
      status: 'running',
      cohort_lanes: [
        { status: 'running', activation_at: '2026-08-18T00:00:00.000Z', heartbeat_at: '2026-08-18T00:00:00.000Z', lease_duration_sec: 5 },
        { status: 'running', activation_at: null, activation_deadline_at: '2026-08-18T00:00:03.000Z', lease_duration_sec: 30 },
      ],
    }],
  });
  assert.equal(deadline, Math.min(heartbeat + 5_000, activation));
});

test('MCP rejects an oversized unterminated JSON line before readline-style buffering', async () => {
  const server = startMcp();
  try {
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for oversized request rejection')), 3_000);
      server.child.stdout.once('data', chunk => {
        clearTimeout(timer);
        try { resolve(JSON.parse(String(chunk).trim())); }
        catch (error) { reject(error); }
      });
    });
    const oversized = Buffer.alloc(1_048_577, 97);
    server.child.stdin.end(Buffer.concat([oversized, Buffer.from('\n')]));
    const message = await response;
    assert.equal(message.id, null);
    assert.equal(message.error.code, -32700);
    assert.match(message.error.message, /1048576-byte limit/);
  } finally {
    await closeMcp(server.child);
  }
});

test('MCP startup silently prunes only expired fully closed tasks across namespaces', async () => {
  const { dispatch } = await import('../scripts/workflow_controller.mjs');
  const { globalTaskStateExists, globalWorkflowArtifactPath, readGlobalTaskState, writeGlobalTaskState } = await import('../scripts/global_workflow_store.mjs');
  const temp = await mkdtemp(path.join(os.tmpdir(), 'agnets-workflow-mcp-startup-prune-'));
  const old = '1970-01-01T00:00:00.000Z';
  const createReleasedTask = async (taskId, closed) => {
    const workspace = path.join(temp, taskId, 'workspace');
    const stateDir = path.join(workspace, '.codex', 'workflow-controller');
    await mkdir(workspace, { recursive: true });
    const [initialized] = await dispatch('init', { manifest: v3McpManifest(workspace, taskId), state_dir: stateDir });
    await dispatch('release-workspace', { task_id: taskId, previous_agent_stopped: true, state_dir: stateDir });
    const logicalPath = path.join(initialized.task_key.namespace, `${taskId}.sqlite`);
    const state = await readGlobalTaskState(logicalPath);
    state.updated_at = old;
    if (closed) {
      for (const node of Object.values(state.nodes)) node.status = 'succeeded';
      state.closed_at = old;
      state.closed_revision = state.workflow_revision;
    }
    await writeGlobalTaskState(logicalPath, state);
    return { logicalPath, stateDir };
  };
  let server;
  try {
    const eligible = await createReleasedTask('startup-eligible', true);
    const retained = await createReleasedTask('startup-retained', false);
    const artifactPath = path.dirname(globalWorkflowArtifactPath(await canonicalStateNamespace(eligible.stateDir), 'startup-eligible', 'startup-claim', 'outcome.json'));
    await mkdir(artifactPath, { recursive: true });
    await writeFile(path.join(artifactPath, 'outcome.json'), '{"outcome":"pass"}\n');

    server = startMcp();
    const initialized = await server.request({ method: 'initialize', params: {} });
    assert.equal(initialized.result.serverInfo.name, 'agnets-workflow');
    const toolList = await server.request({ method: 'tools/list', params: {} });
    assert.equal(toolList.result.tools.some(tool => tool.name === 'workflow_prune_expired'), false);
    await waitUntil(async () => !(await globalTaskStateExists(eligible.logicalPath)));
    assert.equal(await globalTaskStateExists(eligible.logicalPath), false);
    assert.equal(await globalTaskStateExists(retained.logicalPath), true);
    await assert.rejects(lstat(artifactPath), error => error?.code === 'ENOENT');
  } finally {
    if (server) await closeMcp(server.child);
    await rm(temp, { recursive: true, force: true });
  }
});

test('MCP serves v3 workflow state over stdio and releases a cancelled wait', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'agnets-workflow-mcp-v3-'));
  const workspace = path.join(temp, 'workspace');
  const stateDir = path.join(workspace, '.codex', 'workflow-controller');
  const manifestPath = path.join(temp, 'manifest.json');
  const server = startMcp();
  try {
    await mkdir(workspace, { recursive: true });
    await writeFile(path.join(workspace, 'source.txt'), 'review target\n');
    await writeFile(manifestPath, JSON.stringify(v3McpManifest(workspace, 'mcp-path-task')));

    const initialized = await server.request({ method: 'initialize', params: {} });
    assert.equal(initialized.result.serverInfo.name, 'agnets-workflow');
    const toolList = await server.request({ method: 'tools/list', params: {} });
    const initTool = toolList.result.tools.find(tool => tool.name === 'workflow_init');
    const retryTool = toolList.result.tools.find(tool => tool.name === 'workflow_retry');
    const invalidateTool = toolList.result.tools.find(tool => tool.name === 'workflow_invalidate_gate');
    const completeTool = toolList.result.tools.find(tool => tool.name === 'workflow_complete');
    const checkpointTool = toolList.result.tools.find(tool => tool.name === 'workflow_checkpoint');
    const reviewTool = toolList.result.tools.find(tool => tool.name === 'workflow_record_review');
    assert.match(initTool.inputSchema.properties.manifest.description, /清单对象/);
    assert.deepEqual(initTool.inputSchema.properties.manifest.anyOf, [{ type: 'object' }, { type: 'string' }]);
    assert.deepEqual(completeTool.inputSchema.properties.result.anyOf, [{ type: 'object' }, { type: 'string' }]);
    assert.deepEqual(checkpointTool.inputSchema.properties.checkpoint.anyOf, [{ type: 'object' }, { type: 'string' }]);
    assert.deepEqual(reviewTool.inputSchema.properties.review.anyOf, [{ type: 'object' }, { type: 'string' }]);
    assert.ok(retryTool.inputSchema.required.includes('replacement_agent_task_path'));
    assert.ok(invalidateTool.inputSchema.required.includes('replacement_agent_task_path'));
    const inline = await server.request({ method: 'tools/call', params: { name: 'workflow_init', arguments: { manifest: JSON.stringify(v3McpManifest(workspace)), state_dir: stateDir } } });
    const inlineResult = resultObject(inline);
    assert.equal(inlineResult.task.task_id, 'mcp-task');
    assert.equal(inlineResult.database_path, inlineResult.state_path);
    assert.deepEqual(inlineResult.task_key, { namespace: await canonicalStateNamespace(stateDir), task_id: 'mcp-task' });
    assert.equal(inlineResult.database_path, path.join(isolatedCodexHome, 'state', 'agnets-workflow', 'workflow.sqlite'));
    const objectInit = await server.request({ method: 'tools/call', params: { name: 'workflow_init', arguments: { manifest: v3McpManifest(workspace, 'mcp-object-task'), state_dir: stateDir } } });
    assert.equal(resultObject(objectInit).task.task_id, 'mcp-object-task');
    const init = await server.request({ method: 'tools/call', params: { name: 'workflow_init', arguments: { manifest: manifestPath, state_dir: stateDir } } });
    assert.equal(resultObject(init).task.task_id, 'mcp-path-task');

    const status = await server.request({ method: 'tools/call', params: { name: 'workflow_status', arguments: { task_id: 'mcp-task', state_dir: stateDir } } });
    const summary = resultObject(status);
    assert.equal(summary.state_path, inlineResult.state_path);
    assert.equal(summary.database_path, inlineResult.database_path);
    assert.deepEqual(summary.task_key, inlineResult.task_key);
    assert.equal(summary.workspace_lease.database_path, inlineResult.database_path);
    assert.equal(summary.workspace_lease.state_path, inlineResult.state_path);
    assert.deepEqual(summary.workspace_lease.task_key, inlineResult.task_key);
    assert.deepEqual(summary.status_counts, { pending: 1 });
    const hintWait = server.request({ method: 'tools/call', params: { name: 'workflow_wait', arguments: { task_id: 'mcp-task', state_dir: stateDir, after_cursor: summary.cursor, timeout_sec: 1 } } });
    const otherStarted = await server.request({ method: 'tools/call', params: { name: 'workflow_start', arguments: { task_id: 'mcp-object-task', node_id: 'total-review', agent_task_path: '/root/mcp-object-task-sol-review', agent_role: 'avsp_sol_high', native_agent_started: true, state_dir: stateDir } } });
    const otherHint = resultObject(await hintWait);
    assert.equal(otherHint.changed, false);
    assert.equal(otherHint.cursor, summary.cursor);
    await server.request({ method: 'tools/call', params: { name: 'workflow_heartbeat', arguments: { task_id: 'mcp-object-task', node_id: 'total-review', claim_id: resultObject(otherStarted).node.claim_id, state_dir: stateDir } } });
    const waiting = server.request({ method: 'tools/call', params: { name: 'workflow_wait', arguments: { task_id: 'mcp-task', state_dir: stateDir, after_cursor: summary.cursor, timeout_sec: 30 } } });
    const started = await server.request({ method: 'tools/call', params: { name: 'workflow_start', arguments: { task_id: 'mcp-task', node_id: 'total-review', agent_task_path: '/root/mcp-sol-review', agent_role: 'avsp_sol_high', native_agent_started: true, state_dir: stateDir } } });
    const startedNode = resultObject(started).node;
    const changed = resultObject(await waiting);
    assert.equal(changed.changed, true);
    assert.equal(changed.reason, 'state_changed');
    assert.equal(changed.running_nodes[0].id, 'total-review');
    const heartbeat = await server.request({ method: 'tools/call', params: { name: 'workflow_heartbeat', arguments: { task_id: 'mcp-task', node_id: 'total-review', claim_id: startedNode.claim_id, state_dir: stateDir } } });
    assert.equal(heartbeat.result.isError, undefined);

    const current = await server.request({ method: 'tools/call', params: { name: 'workflow_status', arguments: { task_id: 'mcp-task', state_dir: stateDir } } });
    const currentSummary = resultObject(current);
    const cancelled = server.request({ method: 'tools/call', params: { name: 'workflow_wait', arguments: { task_id: 'mcp-task', state_dir: stateDir, after_cursor: currentSummary.cursor, timeout_sec: 30 } } });
    const duplicate = await server.request({ method: 'tools/call', params: { name: 'workflow_wait', arguments: { task_id: 'mcp-task', state_dir: stateDir, after_cursor: currentSummary.cursor, timeout_sec: 30 } } });
    assert.equal(duplicate.result.isError, true);
    assert.match(resultObject(duplicate).error, /already active/);
    server.notify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: cancelled.requestId } });
    const afterCancellation = await server.request({ method: 'tools/call', params: { name: 'workflow_status', arguments: { task_id: 'mcp-task', state_dir: stateDir } } });
    assert.equal(resultObject(afterCancellation).task_id, 'mcp-task');
    const resumed = server.request({ method: 'tools/call', params: { name: 'workflow_wait', arguments: { task_id: 'mcp-task', state_dir: stateDir, after_cursor: currentSummary.cursor, timeout_sec: 30 } } });
    const resumedDuplicate = await server.request({ method: 'tools/call', params: { name: 'workflow_wait', arguments: { task_id: 'mcp-task', state_dir: stateDir, after_cursor: currentSummary.cursor, timeout_sec: 30 } } });
    assert.equal(resumedDuplicate.result.isError, true);
    assert.match(resultObject(resumedDuplicate).error, /already active/);
    const abandoned = await server.request({ method: 'tools/call', params: { name: 'workflow_abandon', arguments: { task_id: 'mcp-task', node_id: 'total-review', claim_id: startedNode.claim_id, reason: 'MCP cancellation test completed.', previous_agent_stopped: true, state_dir: stateDir } } });
    assert.equal(abandoned.result.isError, undefined);
    const resumedState = resultObject(await resumed);
    assert.equal(resumedState.changed, true);
    assert.equal(resumedState.reason, 'state_changed');
  } finally {
    await closeMcp(server.child);
    await rm(temp, { recursive: true, force: true });
  }
});

test('MCP workflow_wait rechecks a one-second lease at its deadline', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'agnets-workflow-mcp-deadline-'));
  const workspace = path.join(temp, 'workspace');
  const stateDir = path.join(workspace, '.codex', 'workflow-controller');
  const server = startMcp();
  try {
    await mkdir(workspace, { recursive: true });
    const initialized = await server.request({ method: 'tools/call', params: { name: 'workflow_init', arguments: { manifest: v3McpManifest(workspace, 'mcp-deadline-task'), state_dir: stateDir } } });
    assert.equal(initialized.result.isError, undefined);
    const started = await server.request({ method: 'tools/call', params: { name: 'workflow_start', arguments: { task_id: 'mcp-deadline-task', node_id: 'total-review', agent_task_path: '/root/mcp-deadline-task-sol-review', agent_role: 'avsp_sol_high', native_agent_started: true, lease_duration_sec: 1, state_dir: stateDir } } });
    assert.equal(started.result.isError, undefined, JSON.stringify(started));
    const status = await server.request({ method: 'tools/call', params: { name: 'workflow_status', arguments: { task_id: 'mcp-deadline-task', state_dir: stateDir } } });
    const cursor = resultObject(status).cursor;
    const startedAt = Date.now();
    const waited = await server.request({ method: 'tools/call', params: { name: 'workflow_wait', arguments: { task_id: 'mcp-deadline-task', state_dir: stateDir, after_cursor: cursor, timeout_sec: 5 } } });
    const elapsed = Date.now() - startedAt;
    const result = resultObject(waited);
    assert.equal(result.changed, true);
    assert.equal(result.reason, 'state_changed');
    assert.ok(elapsed < 3_500, `stale lease was observed after ${elapsed}ms`);
    assert.ok(result.stale_nodes.some(node => node.id === 'total-review'));
  } finally {
    await closeMcp(server.child);
    await rm(temp, { recursive: true, force: true });
  }
});
