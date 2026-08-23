import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
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
const pluginMcp = path.join(root, '.mcp.json');
const { globalStateDirectoryForWorkspace } = await import('../scripts/workflow_controller.mjs');
const stateDirFor = workspace => { mkdirSync(workspace, { recursive: true }); return globalStateDirectoryForWorkspace(workspace); };

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
    task_id: taskId, application_id: `test-app-${createHash('sha256').update(path.resolve(workspace)).digest('hex').slice(0, 12)}`, release_id: taskId, task_kind: 'workflow', coordinator_task_path: '/root', coordinator_thread_id: '01a0193d-6e8f-78a2-815a-19afa3358256', workspace, workspace_claims: [{ mode: 'read', prefix: '.' }], goal: 'Exercise the v3 MCP protocol.', requirements: [{ id: 'R1', text: 'MCP persists and reports current state.' }], scope: [], non_goals: [], routing_schema_version: 3,
    assurance_level: 'sol', assurance_assessment: solAssessment(), review_context: { environment: 'isolated MCP test workspace', scenarios: ['stdio request and wait'], boundaries: 'declared workspace only' }, review_entry_stage: 'sol_high',
    nodes: [{ id: 'total-review', kind: 'total_review', agent_type: 'avsp_sol_high', depends_on: [], execution_risk: 'read_only', routing_reason: 'independent final review', execution_owner: taskId === 'mcp-task' ? '/root/mcp-sol-review' : `/root/${taskId}-sol-review`, integration_owner: '/root', quality_guard: 'validate MCP state response' }],
  };
}

function v3McpWriteManifest(workspace, taskId = 'mcp-write-task') {
  const manifest = v3McpManifest(workspace, taskId);
  return {
    ...manifest,
    workspace_claims: [{ mode: 'write', prefix: '.' }],
    global_write_justification: 'The fixture acquires a minimal write lock to verify wait deltas.',
    nodes: [
      { id: 'work', kind: 'implementation', depends_on: [], execution_risk: 'protected', routing_reason: 'bounded lock test', execution_owner: `/root/${taskId}-work`, integration_owner: '/root', quality_guard: 'verify lock observation' },
      { ...manifest.nodes[0], depends_on: ['work'] },
    ],
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

test('plugin MCP starts from its own installed directory without scanning plugin caches', async () => {
  const descriptor = JSON.parse(await readFile(pluginMcp, 'utf8'));
  const server = descriptor.mcpServers?.['workflow-controller'];
  assert.deepEqual(server?.args, ['./scripts/workflow_controller_mcp.mjs']);
  assert.equal(server?.cwd, '.');
  assert.equal(server?.command, 'node');
  assert.deepEqual(server?.env, { CODEX_HOME: '<CODEX_HOME>' });
  assert.equal(server?.env_vars, undefined);
  assert.doesNotMatch(JSON.stringify(server), /plugins[\\/]cache|readdirSync|candidates/);
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
    const stateDir = stateDirFor(workspace);
    await mkdir(workspace, { recursive: true });
    const [initialized] = await dispatch('init', { manifest: v3McpManifest(workspace, taskId), });
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
  const stateDir = stateDirFor(workspace);
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
    const repairTool = toolList.result.tools.find(tool => tool.name === 'workflow_record_repair');
    const escalationTool = toolList.result.tools.find(tool => tool.name === 'workflow_escalate_execution');
    const waitTool = toolList.result.tools.find(tool => tool.name === 'workflow_wait');
    assert.match(initTool.inputSchema.properties.manifest.description, /清单对象/);
    assert.deepEqual(initTool.inputSchema.properties.manifest.anyOf, [{ type: 'object' }, { type: 'string' }]);
    assert.deepEqual(completeTool.inputSchema.properties.result.anyOf, [{ type: 'object' }, { type: 'string' }]);
    assert.deepEqual(checkpointTool.inputSchema.properties.checkpoint.anyOf, [{ type: 'object' }, { type: 'string' }]);
    const reviewSchema = reviewTool.inputSchema.properties.review.anyOf[0];
    const repairSchema = repairTool.inputSchema.properties.repair.anyOf[0];
    assert.equal(reviewSchema.type, 'object');
    assert.ok(reviewSchema.required.includes('requirement_coverage'));
    assert.ok(reviewSchema.required.includes('coordinator_task_path'));
    assert.ok(reviewSchema.required.includes('coordinator_thread_id'));
    assert.deepEqual(reviewSchema.properties.verdict.enum, ['pass', 'fail', 'unavailable']);
    assert.deepEqual(reviewSchema.properties.findings.items.required, ['id', 'severity', 'requirement_id', 'summary', 'evidence']);
    assert.deepEqual(reviewSchema.properties.findings.items.properties.severity.enum, ['blocking', 'advisory']);
    assert.equal(repairSchema.type, 'object');
    assert.deepEqual(repairSchema.properties.addressed_findings.items.required, ['finding_id', 'resolution', 'verification_evidence']);
    assert.ok(escalationTool.inputSchema.required.includes('previous_agent_stopped'));
    assert.ok(escalationTool.inputSchema.required.includes('assurance_assessment'));
    assert.equal(escalationTool.inputSchema.properties.previous_agent_stopped.const, true);
    assert.match(escalationTool.description, /protected Terra/);
    assert.equal(waitTool.inputSchema.properties.task_id.minLength, 1);
    assert.match(waitTool.description, /同一非空 task_id/);
    assert.match(completeTool.description, /只由 main\/root 调用/);
    assert.match(reviewTool.description, /只由 main\/root 调用/);
    assert.ok(retryTool.inputSchema.required.includes('replacement_agent_task_path'));
    assert.ok(invalidateTool.inputSchema.required.includes('replacement_agent_task_path'));
    const inline = await server.request({ method: 'tools/call', params: { name: 'workflow_init', arguments: { manifest: JSON.stringify(v3McpManifest(workspace)) } } });
    const inlineResult = resultObject(inline);
    assert.equal(inlineResult.task.task_id, 'mcp-task');
    assert.equal(inlineResult.task.execution_routing_policy_version, 2);
    assert.equal(inlineResult.database_path, inlineResult.state_path);
    assert.deepEqual(inlineResult.task_key, { namespace: await canonicalStateNamespace(stateDir), task_id: 'mcp-task' });
    assert.equal(inlineResult.database_path, path.join(isolatedCodexHome, 'state', 'agnets-workflow', 'current', 'workflow.sqlite'));
    const objectInit = await server.request({ method: 'tools/call', params: { name: 'workflow_init', arguments: { manifest: v3McpManifest(workspace, 'mcp-object-task') } } });
    assert.equal(resultObject(objectInit).task.task_id, 'mcp-object-task');
    const init = await server.request({ method: 'tools/call', params: { name: 'workflow_init', arguments: { manifest: manifestPath } } });
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
    const otherStarted = await server.request({ method: 'tools/call', params: { name: 'workflow_start', arguments: { task_id: 'mcp-object-task', node_id: 'total-review', agent_task_path: '/root/mcp-object-task-sol-review', agent_thread_id: '01a0193d-6e8f-78a2-815a-19afa3358261', agent_role: 'avsp_sol_high', native_agent_started: true, state_dir: stateDir } } });
    const otherHint = resultObject(await hintWait);
    assert.equal(otherHint.changed, false);
    assert.equal(otherHint.cursor, summary.cursor);
    await server.request({ method: 'tools/call', params: { name: 'workflow_heartbeat', arguments: { task_id: 'mcp-object-task', node_id: 'total-review', claim_id: resultObject(otherStarted).node.claim_id, state_dir: stateDir } } });
    const waiting = server.request({ method: 'tools/call', params: { name: 'workflow_wait', arguments: { task_id: 'mcp-task', state_dir: stateDir, after_cursor: summary.cursor, timeout_sec: 30, detail: 'full' } } });
    const started = await server.request({ method: 'tools/call', params: { name: 'workflow_start', arguments: { task_id: 'mcp-task', node_id: 'total-review', agent_task_path: '/root/mcp-sol-review', agent_thread_id: '01a0193d-6e8f-78a2-815a-19afa3358262', agent_role: 'avsp_sol_high', native_agent_started: true, state_dir: stateDir } } });
    const startedResult = resultObject(started);
    const startedNode = startedResult.node;
    assert.equal(startedResult.task_id, 'mcp-task');
    assert.equal(startedResult.state_dir, stateDir);
    assert.equal(startedResult.node_id, 'total-review');
    assert.equal(startedResult.claim_id, startedNode.claim_id);
    assert.match(started.result.content[0].text, /claim=/);
    const changed = resultObject(await waiting);
    assert.equal(changed.changed, true);
    assert.equal(changed.reason, 'state_changed');
    assert.equal(changed.task_id, 'mcp-task');
    assert.equal(changed.status.nodes[0].id, 'total-review');
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
    const resumed = server.request({ method: 'tools/call', params: { name: 'workflow_wait', arguments: { task_id: 'mcp-task', state_dir: stateDir, after_cursor: currentSummary.cursor, timeout_sec: 30, detail: 'full' } } });
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

test('MCP returns actionable protocol errors without a raw JSON content document', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'agnets-workflow-mcp-actionable-errors-'));
  const workspace = path.join(temp, 'workspace');
  const stateDir = stateDirFor(workspace);
  const server = startMcp();
  try {
    await mkdir(workspace, { recursive: true });
    const initialized = await server.request({ method: 'tools/call', params: { name: 'workflow_init', arguments: { manifest: v3McpManifest(workspace, 'actionable-errors') } } });
    assert.equal(initialized.result.isError, undefined);
    const missingTask = await server.request({ method: 'tools/call', params: { name: 'workflow_wait', arguments: { task_id: '', state_dir: stateDir, after_cursor: '0'.repeat(64), timeout_sec: 1 } } });
    assert.equal(missingTask.result.isError, true);
    assert.doesNotMatch(missingTask.result.content[0].text, /^\s*[\[{]/);
    assert.match(missingTask.result.content[0].text, /\[INVALID_ARGUMENT\] at task_id/);
    const error = resultObject(missingTask);
    assert.equal(error.error_code, 'INVALID_ARGUMENT');
    assert.equal(error.retryable, false);
    assert.equal(error.field_errors[0].path, 'task_id');
    assert.match(error.error, /task_id must be a non-empty string/);
    const missingStatusTask = await server.request({ method: 'tools/call', params: { name: 'workflow_status', arguments: { task_id: '', state_dir: stateDir } } });
    assert.equal(missingStatusTask.result.isError, true);
    const statusError = resultObject(missingStatusTask);
    assert.equal(statusError.error_code, 'INVALID_ARGUMENT');
    assert.equal(statusError.field_errors[0].path, 'task_id');
    assert.equal(statusError.field_errors[0].expected, 'non-empty string');
  } finally {
    await closeMcp(server.child);
    await rm(temp, { recursive: true, force: true });
  }
});

test('MCP returns field-level review errors and accepts one corrected payload from the audit context', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'agnets-workflow-mcp-review-contract-'));
  const workspace = path.join(temp, 'workspace');
  const stateDir = stateDirFor(workspace);
  const server = startMcp();
  try {
    await mkdir(workspace, { recursive: true });
    const initialized = await server.request({ method: 'tools/call', params: { name: 'workflow_init', arguments: { manifest: v3McpManifest(workspace, 'review-contract') } } });
    assert.equal(initialized.result.isError, undefined);
    const started = resultObject(await server.request({ method: 'tools/call', params: { name: 'workflow_start', arguments: { task_id: 'review-contract', node_id: 'total-review', agent_task_path: '/root/review-contract-sol-review', agent_thread_id: '01a0193d-6e8f-78a2-815a-19afa3358263', agent_role: 'avsp_sol_high', native_agent_started: true, state_dir: stateDir } } }));
    await server.request({ method: 'tools/call', params: { name: 'workflow_heartbeat', arguments: { task_id: 'review-contract', node_id: 'total-review', claim_id: started.claim_id, state_dir: stateDir } } });
    const context = resultObject(await server.request({ method: 'tools/call', params: { name: 'workflow_audit_context', arguments: { task_id: 'review-contract', state_dir: stateDir } } }));
    assert.equal(context.review_input_contract.action, 'record_review');
    assert.deepEqual(context.review_input_contract.requirement_ids, ['R1']);
    assert.equal(context.review_input_contract.active_claims[0].claim_id, started.claim_id);
    const baseReview = {
      auditor_task: '/root/review-contract-sol-review', auditor_role: 'avsp_sol_high', claim_id: started.claim_id, coordinator_task_path: context.coordinator_task_path, coordinator_thread_id: context.coordinator_thread_id,
      findings: [], requirement_coverage: { R1: 'reviewed' }, workflow_snapshot: context.workflow_snapshot, workspace_fingerprint: context.workspace_fingerprint,
      scope_and_regression: 'within declared scope', verification_gaps: 'none', residual_risk: 'accepted', independent_assessment: 'independent pass assessment', history_reconciliation: 'no prior reviews', review_history_digest: context.review_history_digest,
    };
    const invalid = await server.request({ method: 'tools/call', params: { name: 'workflow_record_review', arguments: { task_id: 'review-contract', state_dir: stateDir, review: { ...baseReview, verdict: 'unknown' } } } });
    assert.equal(invalid.result.isError, true);
    const error = resultObject(invalid);
    assert.equal(error.error_code, 'INVALID_ARGUMENT');
    assert.equal(error.retryable, false);
    assert.equal(error.field_errors[0].path, 'review.verdict');
    assert.deepEqual(error.field_errors[0].expected, ['pass', 'fail', 'unavailable']);
    const recordedResponse = await server.request({ method: 'tools/call', params: { name: 'workflow_record_review', arguments: { task_id: 'review-contract', state_dir: stateDir, review: { ...baseReview, verdict: 'pass' } } } });
    const recorded = resultObject(recordedResponse);
    assert.equal(recorded.review.verdict, 'pass');
  } finally {
    await closeMcp(server.child);
    await rm(temp, { recursive: true, force: true });
  }
});

test('MCP workflow_wait rechecks a one-second lease at its deadline', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'agnets-workflow-mcp-deadline-'));
  const workspace = path.join(temp, 'workspace');
  const stateDir = stateDirFor(workspace);
  const server = startMcp();
  try {
    await mkdir(workspace, { recursive: true });
    const initialized = await server.request({ method: 'tools/call', params: { name: 'workflow_init', arguments: { manifest: v3McpManifest(workspace, 'mcp-deadline-task') } } });
    assert.equal(initialized.result.isError, undefined);
    const started = await server.request({ method: 'tools/call', params: { name: 'workflow_start', arguments: { task_id: 'mcp-deadline-task', node_id: 'total-review', agent_task_path: '/root/mcp-deadline-task-sol-review', agent_thread_id: '01a0193d-6e8f-78a2-815a-19afa3358264', agent_role: 'avsp_sol_high', native_agent_started: true, lease_duration_sec: 1, state_dir: stateDir } } });
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
    assert.ok(result.changed_nodes.some(node => node.id === 'total-review'));
  } finally {
    await closeMcp(server.child);
    await rm(temp, { recursive: true, force: true });
  }
});

test('MCP workflow_wait reports an activated claim without a verified native thread instead of waiting for its lease', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'agnets-workflow-mcp-unbound-thread-'));
  const workspace = path.join(temp, 'workspace');
  const stateDir = stateDirFor(workspace);
  const server = startMcp();
  try {
    await mkdir(workspace, { recursive: true });
    const initialized = await server.request({ method: 'tools/call', params: { name: 'workflow_init', arguments: { manifest: v3McpManifest(workspace, 'mcp-unbound-thread') } } });
    assert.equal(initialized.result.isError, undefined);
    await server.request({ method: 'tools/call', params: { name: 'workflow_start', arguments: { task_id: 'mcp-unbound-thread', node_id: 'total-review', agent_task_path: '/root/mcp-unbound-thread-sol-review', agent_role: 'avsp_sol_high', native_agent_started: true, lease_duration_sec: 3_600, state_dir: stateDir } } });
    const status = resultObject(await server.request({ method: 'tools/call', params: { name: 'workflow_status', arguments: { task_id: 'mcp-unbound-thread', state_dir: stateDir } } }));
    assert.equal(status.wait_reason, 'native_thread_unverified');
    assert.equal(status.waiting_reason, 'native_thread_unverified');
    const startedAt = Date.now();
    const waited = resultObject(await server.request({ method: 'tools/call', params: { name: 'workflow_wait', arguments: { task_id: 'mcp-unbound-thread', state_dir: stateDir, after_cursor: status.cursor, timeout_sec: 5 } } }));
    assert.ok(Date.now() - startedAt < 2_000, 'an unbound native claim must not sleep for its lease');
    assert.equal(waited.changed, false);
    assert.equal(waited.reason, 'native_thread_unverified');
    assert.equal(waited.wait_reason, 'native_thread_unverified');
    assert.equal(waited.reconciliation_required, true);
    assert.equal(waited.changed_nodes.length, 0);
    assert.equal(waited.events.length, 0);
  } finally {
    await closeMcp(server.child);
    await rm(temp, { recursive: true, force: true });
  }
});

test('MCP keeps a live heartbeat path observable when the native thread id is unavailable', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'agnets-workflow-mcp-unverified-active-'));
  const workspace = path.join(temp, 'workspace');
  const stateDir = stateDirFor(workspace);
  const server = startMcp();
  try {
    await mkdir(workspace, { recursive: true });
    const initialized = await server.request({ method: 'tools/call', params: { name: 'workflow_init', arguments: { manifest: v3McpManifest(workspace, 'mcp-unverified-active') } } });
    assert.equal(initialized.result.isError, undefined);
    const started = resultObject(await server.request({ method: 'tools/call', params: { name: 'workflow_start', arguments: { task_id: 'mcp-unverified-active', node_id: 'total-review', agent_task_path: '/root/mcp-unverified-active-sol-review', agent_role: 'avsp_sol_high', native_agent_started: true, lease_duration_sec: 3_600, state_dir: stateDir } } }));
    await server.request({ method: 'tools/call', params: { name: 'workflow_heartbeat', arguments: { task_id: 'mcp-unverified-active', node_id: 'total-review', claim_id: started.claim_id, state_dir: stateDir } } });
    const status = resultObject(await server.request({ method: 'tools/call', params: { name: 'workflow_status', arguments: { task_id: 'mcp-unverified-active', state_dir: stateDir } } }));
    assert.equal(status.wait_reason, 'native_thread_unverified');
    assert.equal(status.nodes[0].heartbeat_count, 2);
    const waited = resultObject(await server.request({ method: 'tools/call', params: { name: 'workflow_wait', arguments: { task_id: 'mcp-unverified-active', state_dir: stateDir, after_cursor: status.cursor, timeout_sec: 5 } } }));
    assert.equal(waited.reason, 'native_thread_unverified');
    assert.equal(waited.changed_nodes.length, 0);
    assert.equal(waited.events.length, 0);
  } finally {
    await closeMcp(server.child);
    await rm(temp, { recursive: true, force: true });
  }
});

test('MCP workflow_wait surfaces activation timeout as stale instead of an opaque timeout', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'agnets-workflow-mcp-activation-timeout-'));
  const workspace = path.join(temp, 'workspace');
  const stateDir = stateDirFor(workspace);
  const server = startMcp();
  try {
    await mkdir(workspace, { recursive: true });
    const initialized = await server.request({ method: 'tools/call', params: { name: 'workflow_init', arguments: { manifest: v3McpManifest(workspace, 'mcp-activation-timeout') } } });
    assert.equal(initialized.result.isError, undefined);
    await server.request({ method: 'tools/call', params: { name: 'workflow_claim', arguments: { task_id: 'mcp-activation-timeout', node_id: 'total-review', agent_task_path: '/root/mcp-activation-timeout-sol-review', agent_role: 'avsp_sol_high', activation_timeout_sec: 1, state_dir: stateDir } } });
    const status = resultObject(await server.request({ method: 'tools/call', params: { name: 'workflow_status', arguments: { task_id: 'mcp-activation-timeout', state_dir: stateDir } } }));
    assert.equal(status.wait_reason, 'activation_pending');
    const waited = resultObject(await server.request({ method: 'tools/call', params: { name: 'workflow_wait', arguments: { task_id: 'mcp-activation-timeout', state_dir: stateDir, after_cursor: status.cursor, timeout_sec: 5 } } }));
    assert.equal(waited.changed, true);
    assert.equal(waited.reason, 'state_changed');
    assert.equal(waited.wait_reason, 'stale');
    assert.equal(waited.changed_nodes[0].id, 'total-review');
    assert.deepEqual(waited.events, []);
    assert.equal(waited.observed_changes.stale_nodes[0].id, 'total-review');
  } finally {
    await closeMcp(server.child);
    await rm(temp, { recursive: true, force: true });
  }
});

test('MCP exposes workspace overview and wait defaults to event summary with explicit full detail', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'agnets-workflow-mcp-overview-summary-'));
  const workspace = path.join(temp, 'workspace');
  const stateDir = stateDirFor(workspace);
  const server = startMcp();
  try {
    await mkdir(workspace, { recursive: true });
    const initialized = await server.request({ method: 'tools/call', params: { name: 'workflow_init', arguments: { manifest: v3McpManifest(workspace, 'summary-task') } } });
    assert.equal(initialized.result.isError, undefined);
    const status = resultObject(await server.request({ method: 'tools/call', params: { name: 'workflow_status', arguments: { task_id: 'summary-task', state_dir: stateDir } } }));
    const wait = resultObject(await server.request({ method: 'tools/call', params: { name: 'workflow_wait', arguments: { task_id: 'summary-task', state_dir: stateDir, after_cursor: status.cursor, timeout_sec: 1 } } }));
    assert.equal(wait.changed, false);
    assert.ok(Array.isArray(wait.events));
    assert.equal(wait.nodes, undefined);
    assert.equal(wait.running_nodes, undefined);
    const started = resultObject(await server.request({ method: 'tools/call', params: { name: 'workflow_start', arguments: { task_id: 'summary-task', node_id: 'total-review', agent_task_path: '/root/summary-task-sol-review', agent_thread_id: '01a0193d-6e8f-78a2-815a-19afa3358257', agent_role: 'avsp_sol_high', native_agent_started: true, state_dir: stateDir } } }));
    const changed = resultObject(await server.request({ method: 'tools/call', params: { name: 'workflow_wait', arguments: { task_id: 'summary-task', state_dir: stateDir, after_cursor: status.cursor, timeout_sec: 1 } } }));
    assert.equal(changed.changed, true);
    assert.deepEqual(changed.events.map(event => event.type), ['node_claimed', 'node_started']);
    assert.equal(changed.changed_nodes[0].id, 'total-review');
    assert.ok(started.claim_id);
    const repeated = resultObject(await server.request({ method: 'tools/call', params: { name: 'workflow_wait', arguments: { task_id: 'summary-task', state_dir: stateDir, after_cursor: changed.cursor, timeout_sec: 1 } } }));
    assert.equal(repeated.changed, false);
    assert.deepEqual(repeated.events, []);
    const full = resultObject(await server.request({ method: 'tools/call', params: { name: 'workflow_wait', arguments: { task_id: 'summary-task', state_dir: stateDir, after_cursor: status.cursor, timeout_sec: 1, detail: 'full' } } }));
    assert.ok(full.status.nodes);
    const overview = resultObject(await server.request({ method: 'tools/call', params: { name: 'workflow_workspace_overview', arguments: { workspace } } }));
    assert.ok(overview.workspace.endsWith(`${path.sep}workspace`));
    assert.equal(overview.task_count, 1);
    assert.equal(overview.current_executors[0].node_id, 'total-review');
  } finally {
    await closeMcp(server.child);
    await rm(temp, { recursive: true, force: true });
  }
});

test('MCP workflow_wait reports derived write-lock changes without fabricating stale events', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'agnets-workflow-mcp-lock-summary-'));
  const workspace = path.join(temp, 'workspace');
  const stateDir = stateDirFor(workspace);
  const server = startMcp();
  try {
    await mkdir(workspace, { recursive: true });
    const initialized = await server.request({ method: 'tools/call', params: { name: 'workflow_init', arguments: { manifest: v3McpWriteManifest(workspace) } } });
    assert.equal(initialized.result.isError, undefined);
    const started = resultObject(await server.request({ method: 'tools/call', params: { name: 'workflow_start', arguments: { task_id: 'mcp-write-task', node_id: 'work', agent_task_path: '/root/mcp-write-task-work', agent_thread_id: '01a0193d-6e8f-78a2-815a-19afa3358260', agent_role: 'avsp_terra_high', native_agent_started: true, state_dir: stateDir } } }));
    const beforeLock = resultObject(await server.request({ method: 'tools/call', params: { name: 'workflow_status', arguments: { task_id: 'mcp-write-task', state_dir: stateDir } } }));
    const acquired = resultObject(await server.request({ method: 'tools/call', params: { name: 'workflow_acquire_write_lock', arguments: { task_id: 'mcp-write-task', node_id: 'work', claim_id: started.claim_id, write_prefixes: ['src'], purpose: 'verify wait lock observation', state_dir: stateDir } } }));
    assert.equal(acquired.active_lock_count, 1);
    const changed = resultObject(await server.request({ method: 'tools/call', params: { name: 'workflow_wait', arguments: { task_id: 'mcp-write-task', state_dir: stateDir, after_cursor: beforeLock.cursor, timeout_sec: 1 } } }));
    assert.equal(changed.changed, true);
    assert.deepEqual(changed.events, []);
    assert.deepEqual(changed.changed_nodes, []);
    assert.equal(changed.observed_changes.active_write_locks.length, 1);
    const lockId = acquired.acquired[0].lock_id;
    const beforeRelease = resultObject(await server.request({ method: 'tools/call', params: { name: 'workflow_status', arguments: { task_id: 'mcp-write-task', state_dir: stateDir } } }));
    await server.request({ method: 'tools/call', params: { name: 'workflow_release_write_lock', arguments: { task_id: 'mcp-write-task', node_id: 'work', claim_id: started.claim_id, lock_ids: [lockId], state_dir: stateDir } } });
    const released = resultObject(await server.request({ method: 'tools/call', params: { name: 'workflow_wait', arguments: { task_id: 'mcp-write-task', state_dir: stateDir, after_cursor: beforeRelease.cursor, timeout_sec: 1 } } }));
    assert.equal(released.changed, true);
    assert.deepEqual(released.events, []);
    assert.deepEqual(released.observed_changes.active_write_locks, []);
  } finally {
    await closeMcp(server.child);
    await rm(temp, { recursive: true, force: true });
  }
});
