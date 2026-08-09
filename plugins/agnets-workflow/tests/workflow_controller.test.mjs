import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile as readDiskFile, rm, writeFile as writeDiskFile, mkdir, rename, utimes } from 'node:fs/promises';
import { promises as fsPromises } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { ControllerError, dispatch, workspaceFingerprint } from '../scripts/workflow_controller.mjs';
import { readTaskState, writeTaskState } from '../scripts/sqlite_task_store.mjs';
import { TOOLS, TOOL_COMMANDS } from '../scripts/workflow_controller_mcp.mjs';

const execFile = promisify(execFileCallback);
const controllerCli = fileURLToPath(new URL('../scripts/workflow_controller.mjs', import.meta.url));

const readFile = readDiskFile;
const writeFile = writeDiskFile;

async function callForFixture(fixture, command, parameters) {
  const lifecycle = command === 'complete' && parameters.completion_attestation === undefined
    ? { completion_attestation: 'native_agent_finished' }
    : {};
  if (command === 'complete') {
    await dispatch('heartbeat', { state_dir: fixture.stateDir, task_id: parameters.task_id, node_id: parameters.node_id, claim_id: parameters.claim_id });
  }
  return dispatch(command, { state_dir: fixture.stateDir, ...parameters, ...lifecycle });
}

async function readControllerState(stateDir, taskId = 'feature-1') {
  const state = await readTaskState(path.join(stateDir, `${taskId}.sqlite`));
  if (state === null) throw new Error(`Controller state does not exist: ${taskId}`);
  return state;
}

async function writeControllerState(stateDir, state, taskId = 'feature-1') {
  await writeTaskState(path.join(stateDir, `${taskId}.sqlite`), state);
}

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agnets-workflow-'));
  const workspace = path.join(root, 'workspace'); const stateDir = path.join(root, 'state');
  await mkdir(workspace); await writeFile(path.join(workspace, 'app.txt'), 'before\n');
  const manifest = path.join(root, 'manifest.json');
  await writeFile(manifest, JSON.stringify({ task_id: 'feature-1', workspace, goal: 'Change app safely', requirements: [{ id: 'R1', text: 'app changes' }], nodes: [{ id: 'implement', kind: 'implementation', agent_type: 'avsp_terra_high' }, { id: 'verify', kind: 'verification', depends_on: ['implement'] }, { id: 'total-review', kind: 'total_review', agent_type: 'avsp_sol_high', depends_on: ['implement', 'verify'] }] }));
  return { root, workspace, stateDir, manifest };
}

test('DAG, total review, and workspace fingerprint gate', async () => {
  const fixture = await setup();
  try {
    const call = (command, parameters) => callForFixture(fixture, command, parameters);
    const [initialized] = await call('init', { manifest: fixture.manifest }); assert.equal(initialized.task.ready_nodes[0].id, 'implement');
    let [claim] = await call('claim', { task_id: 'feature-1', node_id: 'implement', agent_task_path: '/root/implement', agent_role: 'avsp_terra_high' });
    const implementation = path.join(fixture.root, 'implementation.json'); await writeFile(implementation, '{}'); await call('complete', { task_id: 'feature-1', node_id: 'implement', claim_id: claim.node.claim_id, status: 'succeeded', result: implementation });
    [claim] = await call('claim', { task_id: 'feature-1', node_id: 'verify', agent_task_path: '/root/verify', agent_role: 'avsp_terra_high' });
    const verification = path.join(fixture.root, 'verification.json'); await writeFile(verification, '{}'); await call('complete', { task_id: 'feature-1', node_id: 'verify', claim_id: claim.node.claim_id, status: 'succeeded', result: verification });
    const [reviewClaim] = await call('claim', { task_id: 'feature-1', node_id: 'total-review', agent_task_path: '/root/total-review', agent_role: 'avsp_sol_high' });
    await call('heartbeat', { task_id: 'feature-1', node_id: 'total-review', claim_id: reviewClaim.node.claim_id });
    const [context] = await call('audit-context', { task_id: 'feature-1' }); const review = path.join(fixture.root, 'review.json');
    const reorderedFingerprint = Object.fromEntries(Object.entries(context.workspace_fingerprint).reverse());
    await writeFile(review, JSON.stringify({ auditor_task: '/root/total-review', auditor_role: 'avsp_sol_high', claim_id: reviewClaim.node.claim_id, verdict: 'pass', requirement_coverage: { R1: 'verified' }, workflow_snapshot: context.workflow_snapshot, workspace_fingerprint: reorderedFingerprint, scope_and_regression: 'none', verification_gaps: 'none', residual_risk: 'none' }));
    await call('record-review', { task_id: 'feature-1', review }); const reviewResult = path.join(fixture.root, 'total-review.json'); await writeFile(reviewResult, '{}'); await call('complete', { task_id: 'feature-1', node_id: 'total-review', claim_id: reviewClaim.node.claim_id, status: 'succeeded', result: reviewResult }); let [allowed, code] = await call('close-check', { task_id: 'feature-1' }); assert.equal(code, 0); assert.equal(allowed.close_allowed, true);
    const closedState = await readControllerState(fixture.stateDir); const leasePath = path.join(fixture.workspace, '.codex', 'workflow-controller', 'workspace-lease.json'); const interruptedLease = JSON.parse(await readFile(leasePath, 'utf8'));
    interruptedLease.active_task = { task_id: 'feature-1', state_path: path.join(fixture.stateDir, 'feature-1.json'), state_dir: fixture.stateDir, acquired_at: closedState.workspace_lease.acquired_at, phase: 'active' }; await writeFile(leasePath, JSON.stringify(interruptedLease));
    [allowed, code] = await call('close-check', { task_id: 'feature-1' }); assert.equal(code, 0); assert.equal(allowed.workspace_lease.self_healed, true); assert.equal(JSON.parse(await readFile(leasePath, 'utf8')).active_task, null);
    const postCloseNode = await writeNode(fixture.root, { id: 'post-close', kind: 'implementation' }); await assert.rejects(() => call('add-node', { task_id: 'feature-1', node: postCloseNode }), /DAG is immutable/);
    await writeFile(path.join(fixture.workspace, 'app.txt'), 'after\n'); [allowed, code] = await call('close-check', { task_id: 'feature-1' }); assert.equal(code, 2); assert.ok(allowed.reasons.includes('workspace changed after total review'));
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('keeps a total review retryable when final workflow outcome persistence fails', async () => {
  const fixture = await setup();
  const originalRename = fsPromises.rename;
  try {
    const call = (command, parameters) => callForFixture(fixture, command, parameters);
    await call('init', { manifest: fixture.manifest });
    for (const [nodeId, taskPath] of [['implement', '/root/implement'], ['verify', '/root/verify']]) {
      const [claim] = await call('claim', { task_id: 'feature-1', node_id: nodeId, agent_task_path: taskPath, agent_role: 'avsp_terra_high' });
      const result = path.join(fixture.root, `${nodeId}.json`); await writeFile(result, '{}');
      await call('complete', { task_id: 'feature-1', node_id: nodeId, claim_id: claim.node.claim_id, status: 'succeeded', result });
    }
    const [reviewClaim] = await call('claim', { task_id: 'feature-1', node_id: 'total-review', agent_task_path: '/root/total-review', agent_role: 'avsp_sol_high' });
    await call('heartbeat', { task_id: 'feature-1', node_id: 'total-review', claim_id: reviewClaim.node.claim_id });
    const [context] = await call('audit-context', { task_id: 'feature-1' }); const review = path.join(fixture.root, 'review.json');
    await writeFile(review, JSON.stringify({ auditor_task: '/root/total-review', auditor_role: 'avsp_sol_high', claim_id: reviewClaim.node.claim_id, verdict: 'pass', requirement_coverage: { R1: 'verified' }, workflow_snapshot: context.workflow_snapshot, workspace_fingerprint: context.workspace_fingerprint, scope_and_regression: 'none', verification_gaps: 'none', residual_risk: 'none' }));
    await call('record-review', { task_id: 'feature-1', review });
    const outcome = path.join(fixture.root, 'outcome.json');
    await writeFile(outcome, JSON.stringify({ workflow: { state_dir: fixture.stateDir, task_id: 'feature-1', node_id: 'total-review', claim_id: reviewClaim.node.claim_id }, workflow_completion: { state: 'pending' } }));
    fsPromises.rename = async (source, destination) => {
      if (path.resolve(destination) === path.resolve(outcome)) {
        const error = new Error('injected outcome write failure'); error.code = 'EIO'; throw error;
      }
      return originalRename(source, destination);
    };
    await assert.rejects(
      () => call('complete', { task_id: 'feature-1', node_id: 'total-review', claim_id: reviewClaim.node.claim_id, status: 'succeeded', result: outcome }),
      /injected outcome write failure/
    );
    fsPromises.rename = originalRename;
    const state = await readControllerState(fixture.stateDir);
    assert.equal(state.nodes['total-review'].status, 'running');
    assert.equal(state.nodes['total-review'].result, null);
    const [closeResult, closeCode] = await call('close-check', { task_id: 'feature-1' });
    assert.equal(closeCode, 2);
    assert.ok(closeResult.reasons.includes('incomplete nodes: total-review'));
    const [completion] = await call('complete', { task_id: 'feature-1', node_id: 'total-review', claim_id: reviewClaim.node.claim_id, status: 'succeeded', result: outcome });
    assert.equal(completion.workflow_outcome_completion.completed, true);
    const completedState = await readControllerState(fixture.stateDir);
    assert.equal(completedState.nodes['total-review'].status, 'succeeded');
    assert.equal(completedState.nodes['total-review'].result.workflow_completion.completed, true);
    completedState.nodes['total-review'].result.workflow_completion = null;
    await writeControllerState(fixture.stateDir, completedState);
    const [missingCompletionCloseResult, missingCompletionCloseCode] = await call('close-check', { task_id: 'feature-1' });
    assert.equal(missingCompletionCloseCode, 2);
    assert.ok(missingCompletionCloseResult.reasons.includes('total_review workflow outcome completion is pending or invalid'));
  } finally {
    fsPromises.rename = originalRename;
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('keeps a total review retryable when controller state persistence fails after artifact finalization', async () => {
  const fixture = await setup();
  const originalRename = fsPromises.rename;
  try {
    const call = (command, parameters) => callForFixture(fixture, command, parameters);
    await call('init', { manifest: fixture.manifest });
    for (const [nodeId, taskPath] of [['implement', '/root/implement'], ['verify', '/root/verify']]) {
      const [claim] = await call('claim', { task_id: 'feature-1', node_id: nodeId, agent_task_path: taskPath, agent_role: 'avsp_terra_high' });
      const result = path.join(fixture.root, `${nodeId}.json`); await writeFile(result, '{}');
      await call('complete', { task_id: 'feature-1', node_id: nodeId, claim_id: claim.node.claim_id, status: 'succeeded', result });
    }
    const [reviewClaim] = await call('claim', { task_id: 'feature-1', node_id: 'total-review', agent_task_path: '/root/review-state-failure', agent_role: 'avsp_sol_high' });
    await call('heartbeat', { task_id: 'feature-1', node_id: 'total-review', claim_id: reviewClaim.node.claim_id });
    const [context] = await call('audit-context', { task_id: 'feature-1' }); const review = path.join(fixture.root, 'state-failure.review.json');
    await writeFile(review, JSON.stringify({ auditor_task: '/root/review-state-failure', auditor_role: 'avsp_sol_high', claim_id: reviewClaim.node.claim_id, verdict: 'pass', requirement_coverage: { R1: 'verified' }, workflow_snapshot: context.workflow_snapshot, workspace_fingerprint: context.workspace_fingerprint, scope_and_regression: 'none', verification_gaps: 'none', residual_risk: 'none' }));
    await call('record-review', { task_id: 'feature-1', review });
    const outcome = path.join(fixture.root, 'state-failure.outcome.json'); await writeFile(outcome, JSON.stringify({ workflow: { state_dir: fixture.stateDir, task_id: 'feature-1', node_id: 'total-review', claim_id: reviewClaim.node.claim_id }, workflow_completion: { state: 'pending' } }));
    const pendingOutcome = JSON.parse(await readFile(outcome, 'utf8'));
    let databaseRenames = 0;
    fsPromises.rename = async (source, destination) => {
      if (path.extname(destination) === '.sqlite') {
        databaseRenames += 1;
        if (databaseRenames === 3) { const error = new Error('injected controller state write failure'); error.code = 'EIO'; throw error; }
      }
      return originalRename(source, destination);
    };
    await assert.rejects(() => call('complete', { task_id: 'feature-1', node_id: 'total-review', claim_id: reviewClaim.node.claim_id, status: 'succeeded', result: outcome }), /injected controller state write failure/);
    fsPromises.rename = originalRename;
    const pendingState = await readControllerState(fixture.stateDir);
    assert.equal(pendingState.nodes['total-review'].status, 'running');
    assert.equal(pendingState.nodes['total-review'].result, null);
    assert.equal(pendingState.nodes['total-review'].workflow_completion_intent.claim_id, reviewClaim.node.claim_id);
    const finalizedOutcome = JSON.parse(await readFile(outcome, 'utf8'));
    assert.equal(finalizedOutcome.workflow_completion.completed, true);
    await writeFile(outcome, JSON.stringify({ ...finalizedOutcome, forged_field: 'tampered' }));
    await assert.rejects(
      () => call('complete', { task_id: 'feature-1', node_id: 'total-review', claim_id: reviewClaim.node.claim_id, status: 'succeeded', result: outcome }),
      /finalized result does not match its persisted completion intent/
    );
    await writeFile(outcome, JSON.stringify({ ...pendingOutcome, workflow_completion: finalizedOutcome.workflow_completion }));
    const [completion] = await call('complete', { task_id: 'feature-1', node_id: 'total-review', claim_id: reviewClaim.node.claim_id, status: 'succeeded', result: outcome });
    assert.equal(completion.workflow_outcome_completion.completed, true);
    const completedState = await readControllerState(fixture.stateDir);
    assert.equal(completedState.nodes['total-review'].status, 'succeeded');
    assert.equal(completedState.nodes['total-review'].workflow_completion_intent, null);
  } finally {
    fsPromises.rename = originalRename;
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('normalizes a direct total-review result and rejects a falsified workflow completion', async () => {
  const fixture = await setup();
  try {
    const call = (command, parameters) => callForFixture(fixture, command, parameters);
    await call('init', { manifest: fixture.manifest });
    for (const [nodeId, taskPath] of [['implement', '/root/implement'], ['verify', '/root/verify']]) {
      const [claim] = await call('claim', { task_id: 'feature-1', node_id: nodeId, agent_task_path: taskPath, agent_role: 'avsp_terra_high' });
      const result = path.join(fixture.root, `${nodeId}.json`); await writeFile(result, '{}');
      await call('complete', { task_id: 'feature-1', node_id: nodeId, claim_id: claim.node.claim_id, status: 'succeeded', result });
    }
    const [reviewClaim] = await call('claim', { task_id: 'feature-1', node_id: 'total-review', agent_task_path: '/root/total-review', agent_role: 'avsp_sol_high' });
    await call('heartbeat', { task_id: 'feature-1', node_id: 'total-review', claim_id: reviewClaim.node.claim_id });
    const [context] = await call('audit-context', { task_id: 'feature-1' });
    const review = path.join(fixture.root, 'review.json');
    await writeFile(review, JSON.stringify({ auditor_task: '/root/total-review', auditor_role: 'avsp_sol_high', claim_id: reviewClaim.node.claim_id, verdict: 'pass', requirement_coverage: { R1: 'verified' }, workflow_snapshot: context.workflow_snapshot, workspace_fingerprint: context.workspace_fingerprint, scope_and_regression: 'none', verification_gaps: 'none', residual_risk: 'none' }));
    await call('record-review', { task_id: 'feature-1', review });
    const resultPath = path.join(fixture.root, 'malformed-workflow-outcome.json');
    const workflow = { state_dir: fixture.stateDir, task_id: 'feature-1', node_id: 'total-review', claim_id: reviewClaim.node.claim_id };
    await writeFile(resultPath, JSON.stringify({
      workflow,
      workflow_completion: {
        completed: true,
        completed_at: new Date().toISOString(),
        task_id: 'feature-1',
        node_id: 'total-review',
        claim_id: reviewClaim.node.claim_id,
        status: 'succeeded',
        completion_attestation: 'native_agent_finished',
      },
    }));
    await assert.rejects(
      () => call('complete', { task_id: 'feature-1', node_id: 'total-review', claim_id: reviewClaim.node.claim_id, status: 'succeeded', result: resultPath }),
      /requires a persisted completion intent/
    );
    assert.equal((await readControllerState(fixture.stateDir)).nodes['total-review'].status, 'running');
    for (const completion of [null, false, 0, '']) {
      const result = { workflow };
      result.workflow_completion = completion;
      await writeFile(resultPath, JSON.stringify(result));
      await assert.rejects(
        () => call('complete', { task_id: 'feature-1', node_id: 'total-review', claim_id: reviewClaim.node.claim_id, status: 'succeeded', result: resultPath }),
        /requires a matching workflow_completion\.state=pending outcome/
      );
      assert.equal((await readControllerState(fixture.stateDir)).nodes['total-review'].status, 'running');
    }
    await writeFile(resultPath, '{}');
    const [completion] = await call('complete', { task_id: 'feature-1', node_id: 'total-review', claim_id: reviewClaim.node.claim_id, status: 'succeeded', result: resultPath });
    assert.equal(completion.workflow_outcome_completion.completed, true);
    const normalized = JSON.parse(await readFile(resultPath, 'utf8'));
    assert.equal(normalized.workflow.task_id, 'feature-1');
    assert.equal(normalized.workflow.node_id, 'total-review');
    assert.equal(normalized.workflow.claim_id, reviewClaim.node.claim_id);
    assert.equal(normalized.workflow_completion.completed, true);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('freezes the DAG and invalidates a pass review when reviewed task state changes', async () => {
  const fixture = await setup();
  try {
    const call = (command, parameters) => callForFixture(fixture, command, parameters);
    await call('init', { manifest: fixture.manifest });
    const lateWork = await writeNode(fixture.root, { id: 'late-work', kind: 'implementation' });
    await assert.rejects(() => call('add-node', { task_id: 'feature-1', node: lateWork }), /DAG is immutable/);
    for (const [nodeId, taskPath] of [['implement', '/root/implement'], ['verify', '/root/verify']]) {
      const [claim] = await call('claim', { task_id: 'feature-1', node_id: nodeId, agent_task_path: taskPath, agent_role: 'avsp_terra_high' });
      const result = path.join(fixture.root, `${nodeId}.json`); await writeFile(result, '{}'); await call('complete', { task_id: 'feature-1', node_id: nodeId, claim_id: claim.node.claim_id, status: 'succeeded', result });
    }
    const [reviewClaim] = await call('claim', { task_id: 'feature-1', node_id: 'total-review', agent_task_path: '/root/total-review', agent_role: 'avsp_sol_high' });
    await call('heartbeat', { task_id: 'feature-1', node_id: 'total-review', claim_id: reviewClaim.node.claim_id });
    const [context] = await call('audit-context', { task_id: 'feature-1' }); const review = path.join(fixture.root, 'review.json');
    await writeFile(review, JSON.stringify({ auditor_task: '/root/total-review', auditor_role: 'avsp_sol_high', claim_id: reviewClaim.node.claim_id, verdict: 'pass', requirement_coverage: { R1: 'verified' }, workflow_snapshot: context.workflow_snapshot, workspace_fingerprint: context.workspace_fingerprint, scope_and_regression: 'none', verification_gaps: 'none', residual_risk: 'none' }));
    await call('record-review', { task_id: 'feature-1', review });
    const reviewResult = path.join(fixture.root, 'review-result.json'); await writeFile(reviewResult, '{}'); await call('complete', { task_id: 'feature-1', node_id: 'total-review', claim_id: reviewClaim.node.claim_id, status: 'succeeded', result: reviewResult });
    const state = await readControllerState(fixture.stateDir); state.nodes.implement.result = { changed_after_review: true }; await writeControllerState(fixture.stateDir, state);
    const [closeResult, closeCode] = await call('close-check', { task_id: 'feature-1' }); assert.equal(closeCode, 2); assert.ok(closeResult.reasons.includes('task state changed after total review'));
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('rejects incomplete total-review topology, oversized results, and ambiguous fingerprints', async () => {
  const fixture = await setup();
  try {
    const noReview = path.join(fixture.root, 'no-review.json');
    await writeFile(noReview, JSON.stringify({ task_id: 'no-review', workspace: fixture.workspace, goal: 'Invalid', requirements: [{ id: 'R1', text: 'required' }], nodes: [{ id: 'work', kind: 'implementation' }] }));
    await assert.rejects(() => dispatch('init', { state_dir: fixture.stateDir, manifest: noReview }), /exactly one total_review/);

    await dispatch('init', { state_dir: fixture.stateDir, manifest: fixture.manifest });
    const [claim] = await dispatch('claim', { state_dir: fixture.stateDir, task_id: 'feature-1', node_id: 'implement', agent_task_path: '/root/implement', agent_role: 'avsp_terra_high' });
    const oversized = path.join(fixture.root, 'oversized.json'); await writeFile(oversized, JSON.stringify({ output: 'x'.repeat(70 * 1024) }));
    await assert.rejects(() => dispatch('complete', { state_dir: fixture.stateDir, task_id: 'feature-1', node_id: 'implement', claim_id: claim.node.claim_id, status: 'succeeded', result: oversized }), /Node result exceeds/);
    const state = await readControllerState(fixture.stateDir); assert.equal(state.nodes.implement.status, 'running');

    const left = path.join(fixture.root, 'left'); const right = path.join(fixture.root, 'right'); await mkdir(left); await mkdir(right);
    await writeFile(path.join(left, 'a'), ''); await writeFile(path.join(left, 'b'), Buffer.from([0x62, 0x00, 0x58]));
    await writeFile(path.join(right, 'a'), Buffer.from([0x62, 0x00])); await writeFile(path.join(right, 'b'), 'X');
    assert.notEqual((await workspaceFingerprint(left)).value, (await workspaceFingerprint(right)).value);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('workspace fingerprints ignore Yarn download caches but retain source changes', async () => {
  const fixture = await setup();
  try {
    const before = await workspaceFingerprint(fixture.workspace);
    const cache = path.join(fixture.workspace, '.yarn-cache-serial', 'v6');
    await mkdir(cache, { recursive: true });
    await writeFile(path.join(cache, 'package.tgz'), 'derived cache data');
    assert.deepEqual(await workspaceFingerprint(fixture.workspace), before);
    await writeFile(path.join(fixture.workspace, 'app.txt'), 'source change\n');
    assert.notEqual((await workspaceFingerprint(fixture.workspace)).value, before.value);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('blocks a persisted task whose total-review topology no longer has a unique terminal gate', async () => {
  const fixture = await setup();
  try {
    await dispatch('init', { state_dir: fixture.stateDir, manifest: fixture.manifest });
    const state = await readControllerState(fixture.stateDir);
    state.nodes['second-total-review'] = { ...state.nodes['total-review'], id: 'second-total-review' };
    await writeControllerState(fixture.stateDir, state);
    await assert.rejects(() => dispatch('status', { state_dir: fixture.stateDir, task_id: 'feature-1' }), /exactly one total_review/);
    const [released] = await dispatch('release-workspace', { state_dir: fixture.stateDir, task_id: 'feature-1', previous_agents_stopped: true });
    assert.equal(released.released, true);
    const [doctor] = await dispatch('doctor', { state_dir: fixture.stateDir, task_id: 'feature-1' });
    assert.equal(doctor.health, 'blocked');
    assert.match(doctor.close_status.reasons[0], /exactly one total_review/);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('rejects a participant as total reviewer', async () => {
  const fixture = await setup();
  try {
    await dispatch('init', { state_dir: fixture.stateDir, manifest: fixture.manifest });
    await dispatch('claim', { state_dir: fixture.stateDir, task_id: 'feature-1', node_id: 'implement', agent_task_path: '/root/implement', agent_role: 'avsp_terra_high' });
    const review = path.join(fixture.root, 'review.json'); await writeFile(review, JSON.stringify({ auditor_task: '/root/implement', auditor_role: 'avsp_sol_high', verdict: 'fail', requirement_coverage: { R1: 'failed' }, workspace_fingerprint: await workspaceFingerprint(fixture.workspace) }));
    await assert.rejects(() => dispatch('record-review', { state_dir: fixture.stateDir, task_id: 'feature-1', review }), ControllerError);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('rejects a prior participant when it tries to claim total review', async () => {
  const fixture = await setup();
  try {
    const call = (command, parameters) => callForFixture(fixture, command, parameters);
    await call('init', { manifest: fixture.manifest });
    const [implementationClaim] = await call('claim', { task_id: 'feature-1', node_id: 'implement', agent_task_path: '/root/prior-participant', agent_role: 'avsp_terra_high' });
    const implementation = path.join(fixture.root, 'implementation.json'); await writeFile(implementation, '{}');
    await call('complete', { task_id: 'feature-1', node_id: 'implement', claim_id: implementationClaim.node.claim_id, status: 'succeeded', result: implementation });
    const [verificationClaim] = await call('claim', { task_id: 'feature-1', node_id: 'verify', agent_task_path: '/root/verification', agent_role: 'avsp_terra_high' });
    const verification = path.join(fixture.root, 'verification.json'); await writeFile(verification, '{}');
    await call('complete', { task_id: 'feature-1', node_id: 'verify', claim_id: verificationClaim.node.claim_id, status: 'succeeded', result: verification });
    await assert.rejects(
      () => call('claim', { task_id: 'feature-1', node_id: 'total-review', agent_task_path: '/root/prior-participant', agent_role: 'avsp_sol_high' }),
      /prior participant cannot claim the total review/
    );
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('allows a newly claimed total-review node to record its own review', async () => {
  const fixture = await setup();
  try {
    const call = (command, parameters) => callForFixture(fixture, command, parameters);
    await call('init', { manifest: fixture.manifest });
    for (const [nodeId, taskPath, role] of [['implement', '/root/implement', 'avsp_terra_high'], ['verify', '/root/verify', 'avsp_terra_high']]) {
      const [claim] = await call('claim', { task_id: 'feature-1', node_id: nodeId, agent_task_path: taskPath, agent_role: role });
      const result = path.join(fixture.root, `${nodeId}.json`); await writeFile(result, '{}'); await call('complete', { task_id: 'feature-1', node_id: nodeId, claim_id: claim.node.claim_id, status: 'succeeded', result });
    }
    const [reviewClaim] = await call('claim', { task_id: 'feature-1', node_id: 'total-review', agent_task_path: '/root/total-review', agent_role: 'avsp_sol_high' });
    const [context] = await call('audit-context', { task_id: 'feature-1' }); const review = path.join(fixture.root, 'review.json');
    await writeFile(review, JSON.stringify({ auditor_task: '/root/total-review', auditor_role: 'avsp_sol_high', verdict: 'pass', requirement_coverage: { R1: 'verified' }, workflow_snapshot: context.workflow_snapshot, workspace_fingerprint: context.workspace_fingerprint, scope_and_regression: 'none', verification_gaps: 'none', residual_risk: 'none' }));
    await assert.rejects(() => call('record-review', { task_id: 'feature-1', review }), /claim_id/);
    await writeFile(review, JSON.stringify({ auditor_task: '/root/total-review', auditor_role: 'avsp_sol_high', claim_id: 'forged-claim', verdict: 'pass', requirement_coverage: { R1: 'verified' }, workflow_snapshot: context.workflow_snapshot, workspace_fingerprint: context.workspace_fingerprint, scope_and_regression: 'none', verification_gaps: 'none', residual_risk: 'none' }));
    await assert.rejects(() => call('record-review', { task_id: 'feature-1', review }), /Claim does not own node/);
    await writeFile(review, JSON.stringify({ auditor_task: '/root/total-review', auditor_role: 'avsp_sol_xhigh', claim_id: reviewClaim.node.claim_id, verdict: 'pass', requirement_coverage: { R1: 'verified' }, workflow_snapshot: context.workflow_snapshot, workspace_fingerprint: context.workspace_fingerprint, scope_and_regression: 'none', verification_gaps: 'none', residual_risk: 'none' }));
    await assert.rejects(() => call('record-review', { task_id: 'feature-1', review }), /role must match/);
    await writeFile(review, JSON.stringify({ auditor_task: '/root/total-review', auditor_role: 'avsp_sol_high', claim_id: reviewClaim.node.claim_id, verdict: 'pass', requirement_coverage: { R1: 'verified' }, workflow_snapshot: context.workflow_snapshot, workspace_fingerprint: context.workspace_fingerprint, scope_and_regression: 'none', verification_gaps: 'none', residual_risk: 'none' }));
    await assert.rejects(() => call('record-review', { task_id: 'feature-1', review }), /activate its claim/);
    await call('heartbeat', { task_id: 'feature-1', node_id: 'total-review', claim_id: reviewClaim.node.claim_id });
    await call('record-review', { task_id: 'feature-1', review });
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('requires a recorded review before total review succeeds and reconciles legacy orphaned reviews', async () => {
  const fixture = await setup();
  try {
    const call = (command, parameters) => callForFixture(fixture, command, parameters);
    await call('init', { manifest: fixture.manifest });
    for (const [nodeId, taskPath, role] of [['implement', '/root/implement', 'avsp_terra_high'], ['verify', '/root/verify', 'avsp_terra_high']]) {
      const [claim] = await call('claim', { task_id: 'feature-1', node_id: nodeId, agent_task_path: taskPath, agent_role: role });
      const result = path.join(fixture.root, `${nodeId}.json`); await writeFile(result, '{}'); await call('complete', { task_id: 'feature-1', node_id: nodeId, claim_id: claim.node.claim_id, status: 'succeeded', result });
    }
    const [reviewClaim] = await call('claim', { task_id: 'feature-1', node_id: 'total-review', agent_task_path: '/root/total-review', agent_role: 'avsp_sol_high' });
    const result = path.join(fixture.root, 'total-review.json'); await writeFile(result, '{}');
    await assert.rejects(() => call('complete', { task_id: 'feature-1', node_id: 'total-review', claim_id: reviewClaim.node.claim_id, status: 'succeeded', result }), /requires a recorded review/);
    await assert.rejects(() => call('retry', { task_id: 'feature-1', node_id: 'implement', reason: 'ordinary success is final', previous_agent_stopped: true }), /Only failed, blocked, unavailable, abandoned, or an unrecorded successful total_review can be retried/);

    const legacy = await readControllerState(fixture.stateDir);
    legacy.nodes['total-review'].status = 'succeeded'; legacy.nodes['total-review'].result = {};
    await writeControllerState(fixture.stateDir, legacy);
    await assert.rejects(() => call('retry', { task_id: 'feature-1', node_id: 'total-review', reason: 'old process is not yet confirmed stopped', previous_agent_stopped: false }), /must be true/);
    await call('retry', { task_id: 'feature-1', node_id: 'total-review', reason: 'reconcile legacy unrecorded completion', previous_agent_stopped: true });
    const recovered = await readControllerState(fixture.stateDir);
    assert.equal(recovered.nodes['total-review'].status, 'pending');
    assert.equal(recovered.events.at(-1).orphaned_total_review, true);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('escalates repeated failed total reviews from Sol high through xhigh to sticky max', async () => {
  const fixture = await setup();
  try {
    const call = (command, parameters) => callForFixture(fixture, command, parameters);
    await call('init', { manifest: fixture.manifest });
    for (const [nodeId, taskPath] of [['implement', '/root/implement'], ['verify', '/root/verify']]) {
      const [claim] = await call('claim', { task_id: 'feature-1', node_id: nodeId, agent_task_path: taskPath, agent_role: 'avsp_terra_high' });
      const result = path.join(fixture.root, `${nodeId}.json`); await writeFile(result, '{}');
      await call('complete', { task_id: 'feature-1', node_id: nodeId, claim_id: claim.node.claim_id, status: 'succeeded', result });
    }
    const reviewOnce = async (name, role, verdict = 'fail', completionStatus = verdict === 'fail' ? 'failed' : 'unavailable') => {
      const taskPath = `/root/${name}`;
      const [claim] = await call('claim', { task_id: 'feature-1', node_id: 'total-review', agent_task_path: taskPath, agent_role: role });
      await call('heartbeat', { task_id: 'feature-1', node_id: 'total-review', claim_id: claim.node.claim_id });
      const [context] = await call('audit-context', { task_id: 'feature-1' }); const review = path.join(fixture.root, `${name}.review.json`);
      await writeFile(review, JSON.stringify({ auditor_task: taskPath, auditor_role: role, claim_id: claim.node.claim_id, verdict, requirement_coverage: { R1: `${name} coverage` }, workflow_snapshot: context.workflow_snapshot, workspace_fingerprint: context.workspace_fingerprint, scope_and_regression: `${name} scope`, verification_gaps: `${name} gaps`, residual_risk: `${name} risk` }));
      await call('record-review', { task_id: 'feature-1', review });
      const result = path.join(fixture.root, `${name}.outcome.json`); await writeFile(result, '{}');
      await call('complete', { task_id: 'feature-1', node_id: 'total-review', claim_id: claim.node.claim_id, status: completionStatus, result });
    };
    const downgradeReviewCompletionToLegacy = async name => {
      const state = await readControllerState(fixture.stateDir);
      const review = state.reviews.find(candidate => candidate.auditor_task === `/root/${name}`);
      delete review.completion_status; delete review.completion_attestation; delete review.completed_at;
      const completionEvent = state.events.find(event => event.type === 'node_completed' && event.node_id === 'total-review' && event.claim_id === review.claim_id);
      delete completionEvent.claim_id;
      await writeControllerState(fixture.stateDir, state);
    };
    const retryReview = name => call('retry', { task_id: 'feature-1', node_id: 'total-review', reason: `${name} reviewer stopped`, previous_agent_stopped: true });

    await reviewOnce('high-unavailable', 'avsp_sol_high', 'unavailable');
    let [retried] = await retryReview('high-unavailable');
    assert.equal(retried.node.agent_type, 'avsp_sol_high');

    await reviewOnce('high-first-fail', 'avsp_sol_high');
    await downgradeReviewCompletionToLegacy('high-first-fail');
    [retried] = await retryReview('high-first-fail');
    assert.equal(retried.node.agent_type, 'avsp_sol_high');

    await reviewOnce('high-recorded-fail-unavailable', 'avsp_sol_high', 'fail', 'unavailable');
    [retried] = await retryReview('high-recorded-fail-unavailable');
    assert.equal(retried.node.agent_type, 'avsp_sol_high');

    await reviewOnce('high-second-fail', 'avsp_sol_high');
    await downgradeReviewCompletionToLegacy('high-second-fail');
    [retried] = await retryReview('high-second-fail');
    assert.equal(retried.node.agent_type, 'avsp_sol_high');

    await reviewOnce('high-third-fail', 'avsp_sol_high');
    [retried] = await retryReview('high-third-fail');
    assert.equal(retried.node.agent_type, 'avsp_sol_xhigh');

    const [invalidXhighClaim] = await call('claim', { task_id: 'feature-1', node_id: 'total-review', agent_task_path: '/root/xhigh-invalid', agent_role: 'avsp_sol_xhigh' });
    const invalidXhighResult = path.join(fixture.root, 'xhigh-invalid.outcome.json'); await writeFile(invalidXhighResult, '{}');
    await call('complete', { task_id: 'feature-1', node_id: 'total-review', claim_id: invalidXhighClaim.node.claim_id, status: 'unavailable', result: invalidXhighResult });
    [retried] = await retryReview('xhigh-invalid');
    assert.equal(retried.node.agent_type, 'avsp_sol_xhigh');

    await reviewOnce('xhigh-fail', 'avsp_sol_xhigh');
    [retried] = await retryReview('xhigh-fail');
    assert.equal(retried.node.agent_type, 'avsp_sol_max');

    await reviewOnce('max-fail', 'avsp_sol_max');
    [retried] = await retryReview('max-fail');
    assert.equal(retried.node.agent_type, 'avsp_sol_max');
    const state = await readControllerState(fixture.stateDir);
    const escalations = state.events.filter(event => event.type === 'total_review_escalated');
    assert.deepEqual(escalations.map(event => [event.prior_role, event.role]), [['avsp_sol_high', 'avsp_sol_xhigh'], ['avsp_sol_xhigh', 'avsp_sol_max']]);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('claim ownership, abandon, retry, unavailable, and stale-lock recovery are explicit', async () => {
  const fixture = await setup();
  try {
    const call = (command, parameters) => callForFixture(fixture, command, parameters);
    await writeFile(fixture.manifest, JSON.stringify({ task_id: 'feature-1', workspace: fixture.workspace, goal: 'Change app safely', requirements: [{ id: 'R1', text: 'app changes' }], nodes: [{ id: 'implement', kind: 'implementation', agent_type: 'avsp_terra_high' }, { id: 'parallel', kind: 'implementation', agent_type: 'avsp_terra_high' }, { id: 'verify', kind: 'verification', depends_on: ['implement'] }, { id: 'total-review', kind: 'total_review', agent_type: 'avsp_sol_high', depends_on: ['implement', 'parallel', 'verify'] }] }));
    await call('init', { manifest: fixture.manifest });
    await assert.rejects(() => call('claim', { task_id: 'feature-1', node_id: 'implement', agent_task_path: '', agent_role: 'avsp_terra_high' }), ControllerError);
    const [firstClaim] = await call('claim', { task_id: 'feature-1', node_id: 'implement', agent_task_path: '/root/first', agent_role: 'avsp_terra_high', lease_duration_sec: 60 });
    await assert.rejects(() => call('claim', { task_id: 'feature-1', node_id: 'implement', agent_task_path: '/root/first', agent_role: 'avsp_terra_high' }), /Node is not ready/);
    await assert.rejects(() => call('claim', { task_id: 'feature-1', node_id: 'parallel', agent_task_path: '/root/first', agent_role: 'avsp_terra_high' }), /already has a running node/);
    await assert.rejects(() => call('heartbeat', { task_id: 'feature-1', node_id: 'implement', claim_id: 'wrong' }), ControllerError);
    await call('heartbeat', { task_id: 'feature-1', node_id: 'implement', claim_id: firstClaim.node.claim_id });
    await assert.rejects(() => call('abandon', { task_id: 'feature-1', node_id: 'implement', claim_id: firstClaim.node.claim_id, reason: 'missing stopped-agent confirmation' }), /previous_agent_stopped must be true/);
    await call('abandon', { task_id: 'feature-1', node_id: 'implement', claim_id: firstClaim.node.claim_id, reason: 'confirmed process stopped', previous_agent_stopped: true });
    await assert.rejects(() => call('retry', { task_id: 'feature-1', node_id: 'implement', reason: 'replace worker', previous_agent_stopped: false }), ControllerError);
    await call('retry', { task_id: 'feature-1', node_id: 'implement', reason: 'replace worker', previous_agent_stopped: true });
    const stateFile = path.join(fixture.stateDir, 'feature-1.json');
    const stateAfterRetry = await readControllerState(fixture.stateDir);
    assert.equal(stateAfterRetry.events.at(-1).previous_agent_stopped, true);
    const [secondClaim] = await call('claim', { task_id: 'feature-1', node_id: 'implement', agent_task_path: '/root/first', agent_role: 'avsp_terra_high' });
    assert.notEqual(secondClaim.node.claim_id, firstClaim.node.claim_id);
    const result = path.join(fixture.root, 'unavailable.json'); await writeFile(result, '{}');
    await assert.rejects(() => call('complete', { task_id: 'feature-1', node_id: 'implement', claim_id: secondClaim.node.claim_id, status: 'abandoned', result }), ControllerError);
    await call('complete', { task_id: 'feature-1', node_id: 'implement', claim_id: secondClaim.node.claim_id, status: 'unavailable', result });

    const staleLock = `${stateFile}.lock`;
    await writeFile(staleLock, 'pid=999999 hostname=localhost created=1970-01-01T00:00:00.000Z\n');
    await utimes(staleLock, new Date(0), new Date(0));
    await assert.rejects(() => call('recover-lock', { task_id: 'feature-1', stale_after_sec: 1 }), ControllerError);
    await rm(staleLock);
    await writeFile(staleLock, `pid=999999 hostname=${os.hostname()} created=1970-01-01T00:00:00.000Z\n`);
    await utimes(staleLock, new Date(0), new Date(0));
    const [recovered] = await call('recover-lock', { task_id: 'feature-1', stale_after_sec: 1 });
    assert.equal(recovered.recovered, true);
    await writeFile(staleLock, `pid=${process.pid} hostname=${os.hostname()} created=1970-01-01T00:00:00.000Z\n`);
    await utimes(staleLock, new Date(0), new Date(0));
    await assert.rejects(() => call('recover-lock', { task_id: 'feature-1', stale_after_sec: 1 }), ControllerError);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('serializes simultaneous claims for the same node and execution owner', async () => {
  const fixture = await setup();
  try {
    const call = (command, parameters) => callForFixture(fixture, command, parameters);
    await call('init', { manifest: fixture.manifest });
    const attempts = await Promise.allSettled([
      call('claim', { task_id: 'feature-1', node_id: 'implement', agent_task_path: '/root/concurrent-owner', agent_role: 'avsp_terra_high' }),
      call('claim', { task_id: 'feature-1', node_id: 'implement', agent_task_path: '/root/concurrent-owner', agent_role: 'avsp_terra_high' })
    ]);
    assert.equal(attempts.filter(item => item.status === 'fulfilled').length, 1);
    assert.equal(attempts.filter(item => item.status === 'rejected').length, 1);
    assert.match(attempts.find(item => item.status === 'rejected').reason.message, /Node is not ready/);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('retry requires an unambiguous stopped-agent confirmation and accepts the legacy plural alias', async () => {
  const fixture = await setup();
  try {
    const call = (command, parameters) => callForFixture(fixture, command, parameters);
    await call('init', { manifest: fixture.manifest });
    let [claim] = await call('claim', { task_id: 'feature-1', node_id: 'implement', agent_task_path: '/root/first', agent_role: 'avsp_terra_high' });
    await call('abandon', { task_id: 'feature-1', node_id: 'implement', claim_id: claim.node.claim_id, reason: 'confirmed process stopped', previous_agent_stopped: true });
    const retry = parameters => call('retry', { task_id: 'feature-1', node_id: 'implement', reason: 'replace worker', ...parameters });
    await assert.rejects(() => retry({}), /is required/);
    await assert.rejects(() => retry({ previous_agent_stopped: false }), /must be true/);
    await assert.rejects(() => retry({ previous_agents_stopped: false }), /must be true/);
    await assert.rejects(() => retry({ previous_agent_stopped: true, previous_agents_stopped: false }), /must not conflict/);
    await retry({ previous_agent_stopped: true });

    [claim] = await call('claim', { task_id: 'feature-1', node_id: 'implement', agent_task_path: '/root/second', agent_role: 'avsp_terra_high' });
    await call('abandon', { task_id: 'feature-1', node_id: 'implement', claim_id: claim.node.claim_id, reason: 'confirmed process stopped', previous_agent_stopped: true });
    await retry({ previous_agents_stopped: true });
    const state = await readControllerState(fixture.stateDir);
    assert.equal(state.events.at(-1).previous_agent_stopped, true);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('checkpoints a stale claim and returns a bounded recovery package only after stopped-agent confirmation', async () => {
  const fixture = await setup();
  try {
    const call = (command, parameters) => callForFixture(fixture, command, parameters);
    await call('init', { manifest: fixture.manifest });
    const [claim] = await call('claim', { task_id: 'feature-1', node_id: 'implement', agent_task_path: '/root/original', agent_thread_id: '019f0000-0000-7000-8000-000000000001', agent_role: 'avsp_terra_high', lease_duration_sec: 1 });
    await call('heartbeat', { task_id: 'feature-1', node_id: 'implement', claim_id: claim.node.claim_id });
    const checkpoint = path.join(fixture.root, 'checkpoint.json');
    await writeFile(checkpoint, JSON.stringify({ completed: ['inspect'], next_step: 'edit app.txt', evidence_paths: ['app.txt'] }));
    await call('checkpoint', { task_id: 'feature-1', node_id: 'implement', claim_id: claim.node.claim_id, checkpoint });
    const stateFile = path.join(fixture.stateDir, 'feature-1.json'); const state = await readControllerState(fixture.stateDir);
    state.nodes.implement.heartbeat_at = '1970-01-01T00:00:00.000Z'; await writeControllerState(fixture.stateDir, state);

    const requeue = parameters => call('requeue-stale', { task_id: 'feature-1', node_id: 'implement', claim_id: claim.node.claim_id, reason: 'Codex agent is confirmed stopped after interruption', ...parameters });
    await assert.rejects(() => requeue({}), /is required/);
    await assert.rejects(() => requeue({ previous_agent_stopped: false }), /must be true/);
    await assert.rejects(() => requeue({ previous_agent_stopped: true }), /replacement_agent_task_path/);
    const [requeued] = await requeue({ previous_agent_stopped: true, replacement_agent_task_path: '/root/replacement' });
    assert.equal(requeued.node.status, 'pending');
    assert.equal(requeued.node.agent_task_path, null);
    assert.equal(requeued.recovery_package.continuation.kind, 'new_agent_required');
    assert.equal(requeued.recovery_package.previous_attempt.agent_thread_id, '019f0000-0000-7000-8000-000000000001');
    assert.deepEqual(requeued.recovery_package.previous_attempt.checkpoint, { completed: ['inspect'], next_step: 'edit app.txt', evidence_paths: ['app.txt'] });
    assert.equal(requeued.ready_nodes[0].id, 'implement');
    const stored = await readControllerState(fixture.stateDir);
    assert.equal(stored.nodes.implement.recovery_history.length, 1);
    assert.equal(stored.events.at(-1).type, 'stale_node_requeued');
    const [replacement] = await call('claim', { task_id: 'feature-1', node_id: 'implement', agent_task_path: '/root/replacement', agent_role: 'avsp_terra_high' });
    assert.equal(replacement.node.attempt, 2);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('rebinds modern routing owners for replacement workers and independent total reviewers', async () => {
  const fixture = await setup();
  try {
    const call = (command, parameters) => callForFixture(fixture, command, parameters);
    const workRoute = { execution_risk: 'protected', routing_reason: 'controlled recovery', execution_owner: '/root/original-worker', integration_owner: '/root', quality_guard: 'test' };
    const firstReviewRoute = { execution_risk: 'protected', routing_reason: 'independent review', execution_owner: '/root/first-reviewer', integration_owner: '/root', quality_guard: 'test' };
    await writeFile(fixture.manifest, JSON.stringify({ task_id: 'feature-1', workspace: fixture.workspace, goal: 'Recover modern routing', routing_schema_version: 1, requirements: [{ id: 'R1', text: 'recover task' }], nodes: [{ id: 'work', kind: 'implementation', ...workRoute }, { id: 'total-review', kind: 'total_review', agent_type: 'avsp_sol_high', depends_on: ['work'], ...firstReviewRoute }] }));
    await call('init', { manifest: fixture.manifest });
    const [original] = await call('claim', { task_id: 'feature-1', node_id: 'work', agent_task_path: '/root/original-worker', agent_role: 'avsp_terra_high', lease_duration_sec: 1 });
    const staleState = await readControllerState(fixture.stateDir);
    staleState.nodes.work.heartbeat_at = '1970-01-01T00:00:00.000Z'; staleState.nodes.work.activation_at = '1970-01-01T00:00:00.000Z'; staleState.nodes.work.heartbeat_count = 1; await writeControllerState(fixture.stateDir, staleState);
    const [requeued] = await call('requeue-stale', { task_id: 'feature-1', node_id: 'work', claim_id: original.node.claim_id, reason: 'original worker stopped', replacement_agent_task_path: '/root/replacement-worker', previous_agent_stopped: true });
    assert.equal(requeued.node.execution_owner, '/root/replacement-worker');
    assert.equal(requeued.recovery_package.node.execution_owner, '/root/replacement-worker');
    assert.equal(requeued.recovery_package.previous_attempt.execution_owner, '/root/original-worker');
    const [replacement] = await call('claim', { task_id: 'feature-1', node_id: 'work', agent_task_path: '/root/replacement-worker', agent_role: 'avsp_terra_high' });
    const workResult = path.join(fixture.root, 'work.json'); await writeFile(workResult, '{}'); await call('complete', { task_id: 'feature-1', node_id: 'work', claim_id: replacement.node.claim_id, status: 'succeeded', result: workResult });
    const [firstReviewer] = await call('claim', { task_id: 'feature-1', node_id: 'total-review', agent_task_path: '/root/first-reviewer', agent_role: 'avsp_sol_high' });
    const unavailable = path.join(fixture.root, 'unavailable.json'); await writeFile(unavailable, '{}'); await call('complete', { task_id: 'feature-1', node_id: 'total-review', claim_id: firstReviewer.node.claim_id, status: 'unavailable', result: unavailable });
    const [retried] = await call('retry', { task_id: 'feature-1', node_id: 'total-review', reason: 'new independent total review', replacement_agent_task_path: '/root/second-reviewer', previous_agent_stopped: true });
    assert.equal(retried.node.execution_owner, '/root/second-reviewer');
    const [secondReviewer] = await call('claim', { task_id: 'feature-1', node_id: 'total-review', agent_task_path: '/root/second-reviewer', agent_role: 'avsp_sol_high' });
    assert.equal(secondReviewer.node.agent_task_path, '/root/second-reviewer');
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('doctor reports persistent state, lease health, and controlled recovery candidates without mutation', async () => {
  const fixture = await setup();
  try {
    const call = (command, parameters) => callForFixture(fixture, command, parameters);
    await call('init', { manifest: fixture.manifest });
    let [diagnosis] = await call('doctor', { task_id: 'feature-1' });
    assert.equal(diagnosis.health, 'healthy');
    assert.equal(diagnosis.checks.find(check => check.id === 'state_database').status, 'pass');
    assert.equal(diagnosis.checks.find(check => check.id === 'workspace_lease').status, 'pass');
    assert.deepEqual(diagnosis.recovery_candidates, []);
    await assert.rejects(() => readFile(path.join(fixture.stateDir, '.workflow-prune-sweep.json'), 'utf8'), /ENOENT/);

    const [claim] = await call('claim', { task_id: 'feature-1', node_id: 'implement', agent_task_path: '/root/doctor-worker', agent_role: 'avsp_terra_high', lease_duration_sec: 1 });
    const staleState = await readControllerState(fixture.stateDir);
    staleState.nodes.implement.activation_at = '1970-01-01T00:00:00.000Z';
    staleState.nodes.implement.heartbeat_at = '1970-01-01T00:00:00.000Z';
    staleState.nodes.implement.heartbeat_count = 1;
    await writeControllerState(fixture.stateDir, staleState);
    [diagnosis] = await call('doctor', { task_id: 'feature-1' });
    assert.equal(diagnosis.health, 'attention');
    assert.equal(diagnosis.checks.find(check => check.id === 'running_nodes').status, 'attention');
    assert.equal(diagnosis.recovery_candidates[0].claim_id, claim.node.claim_id);
    assert.match(diagnosis.recovery_candidates[0].required_actions[0], /确认旧原生代理已停止/);
    assert.equal((await readControllerState(fixture.stateDir)).nodes.implement.claim_id, claim.node.claim_id);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('doctor returns a blocked diagnosis for unreadable SQLite state without mutating it', async () => {
  const fixture = await setup();
  try {
    const call = (command, parameters) => callForFixture(fixture, command, parameters);
    await call('init', { manifest: fixture.manifest });
    const databasePath = path.join(fixture.stateDir, 'feature-1.sqlite');
    await writeFile(databasePath, 'not a SQLite database');
    const [diagnosis] = await call('doctor', { task_id: 'feature-1' });
    assert.equal(diagnosis.health, 'blocked');
    assert.equal(diagnosis.checks.find(check => check.id === 'state_database').status, 'fail');
    assert.match(diagnosis.checks.find(check => check.id === 'task_state').detail.error, /Cannot open SQLite task state/);
    assert.equal(diagnosis.close_status.close_allowed, false);
    assert.equal(await readFile(databasePath, 'utf8'), 'not a SQLite database');
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('doctor preserves a close-gate error when a reviewed workspace is missing', async () => {
  const fixture = await setup();
  try {
    const call = (command, parameters) => callForFixture(fixture, command, parameters);
    await call('init', { manifest: fixture.manifest });
    const state = await readControllerState(fixture.stateDir);
    for (const node of Object.values(state.nodes)) node.status = 'succeeded';
    state.reviews = [{ auditor_task: '/root/reviewer', auditor_role: 'avsp_sol_high', node_id: 'total-review', claim_id: 'review-claim', verdict: 'pass', workflow_snapshot: {}, workspace_fingerprint: { value: 'missing' } }];
    await writeControllerState(fixture.stateDir, state);
    await rm(fixture.workspace, { recursive: true, force: true });
    const [diagnosis] = await call('doctor', { task_id: 'feature-1' });
    assert.equal(diagnosis.health, 'blocked');
    assert.equal(diagnosis.close_status.close_allowed, false);
    assert.equal(diagnosis.checks.find(check => check.id === 'close_gate').status, 'fail');
    assert.match(diagnosis.close_status.reasons[0], /close check unavailable/);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('prunes only verified seven-day idle released task states and retains active, unknown, or incomplete states', async () => {
  const released = await setup(); const mismatch = await setup(); const active = await setup(); const unknown = await setup(); const incomplete = await setup();
  try {
    const modernManifest = (fixture, workOwner, reviewOwner) => writeFile(fixture.manifest, JSON.stringify({ task_id: 'feature-1', workspace: fixture.workspace, goal: 'Change app safely', routing_schema_version: 1, requirements: [{ id: 'R1', text: 'app changes' }], nodes: [{ id: 'implement', kind: 'implementation', execution_risk: 'protected', routing_reason: 'controlled test', execution_owner: workOwner, integration_owner: '/root', quality_guard: 'test' }, { id: 'verify', kind: 'verification', depends_on: ['implement'], execution_risk: 'protected', routing_reason: 'controlled test', execution_owner: '/root/verify', integration_owner: '/root', quality_guard: 'test' }, { id: 'total-review', kind: 'total_review', agent_type: 'avsp_sol_high', depends_on: ['implement', 'verify'], execution_risk: 'protected', routing_reason: 'controlled test', execution_owner: reviewOwner, integration_owner: '/root', quality_guard: 'test' }] }));
    await modernManifest(released, '/root/implement', '/root/reviewer');
    await dispatch('init', { state_dir: released.stateDir, manifest: released.manifest });
    await dispatch('release-workspace', { state_dir: released.stateDir, task_id: 'feature-1', previous_agents_stopped: true });
    const releasedState = await readControllerState(released.stateDir);
    releasedState.updated_at = '1970-01-01T00:00:00.000Z'; await writeControllerState(released.stateDir, releasedState);
    await mkdir(path.join(released.stateDir, '.workflow-review-results', 'feature-1', 'claim-1'), { recursive: true });
    await writeFile(path.join(released.stateDir, '.workflow-review-results', 'feature-1', 'claim-1', 'outcome.json'), '{}');
    const [pruned] = await dispatch('prune-expired', { state_dir: released.stateDir });
    assert.deepEqual(pruned.deleted.map(item => item.task_id), ['feature-1']);
    await assert.rejects(() => readControllerState(released.stateDir), /does not exist/);
    await assert.rejects(() => readFile(path.join(released.stateDir, '.workflow-review-results', 'feature-1', 'claim-1', 'outcome.json')), /ENOENT/);

    await modernManifest(mismatch, '/root/mismatch-implement', '/root/mismatch-reviewer');
    await dispatch('init', { state_dir: mismatch.stateDir, manifest: mismatch.manifest });
    await dispatch('release-workspace', { state_dir: mismatch.stateDir, task_id: 'feature-1', previous_agents_stopped: true });
    const mismatchState = await readControllerState(mismatch.stateDir);
    mismatchState.task_id = 'other-task'; mismatchState.updated_at = '1970-01-01T00:00:00.000Z'; await writeControllerState(mismatch.stateDir, mismatchState);
    await mkdir(path.join(mismatch.stateDir, '.workflow-review-results', 'other-task', 'claim-1'), { recursive: true });
    await writeFile(path.join(mismatch.stateDir, '.workflow-review-results', 'other-task', 'claim-1', 'outcome.json'), '{}');
    const [mismatchQuarantined] = await dispatch('prune-expired', { state_dir: mismatch.stateDir });
    assert.equal(mismatchQuarantined.deleted_count, 0);
    assert.equal(mismatchQuarantined.quarantined_count, 1);
    assert.equal(mismatchQuarantined.quarantined[0].task_id, 'other-task');
    await assert.rejects(() => readControllerState(mismatch.stateDir), /does not exist/);
    assert.equal(await readFile(path.join(mismatchQuarantined.quarantined[0].error_path, 'review-results', 'claim-1', 'outcome.json'), 'utf8'), '{}');

    await modernManifest(active, '/root/active-implement', '/root/active-reviewer');
    await dispatch('init', { state_dir: active.stateDir, manifest: active.manifest });
    const activeState = await readControllerState(active.stateDir);
    activeState.updated_at = '1970-01-01T00:00:00.000Z'; await writeControllerState(active.stateDir, activeState);
    const [retained] = await dispatch('prune-expired', { state_dir: active.stateDir });
    assert.equal(retained.deleted.length, 0);
    assert.match(retained.retained.find(item => item.task_id === 'feature-1').reason, /workspace lease is not released/);
    assert.equal((await readControllerState(active.stateDir)).task_id, 'feature-1');

    await modernManifest(unknown, '/root/unknown-implement', '/root/unknown-reviewer');
    await dispatch('init', { state_dir: unknown.stateDir, manifest: unknown.manifest });
    await dispatch('release-workspace', { state_dir: unknown.stateDir, task_id: 'feature-1', previous_agents_stopped: true });
    const unknownState = await readControllerState(unknown.stateDir);
    unknownState.updated_at = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(); unknownState.future_state_field = true; await writeControllerState(unknown.stateDir, unknownState);
    const [unknownRetained] = await dispatch('prune-expired', { state_dir: unknown.stateDir });
    assert.equal(unknownRetained.deleted_count, 0);
    assert.equal(unknownRetained.retained.find(item => item.task_id === 'feature-1').reason, 'incomplete or unknown state fields');
    assert.equal((await readControllerState(unknown.stateDir)).task_id, 'feature-1');

    await modernManifest(incomplete, '/root/incomplete-implement', '/root/incomplete-reviewer');
    await dispatch('init', { state_dir: incomplete.stateDir, manifest: incomplete.manifest });
    await dispatch('release-workspace', { state_dir: incomplete.stateDir, task_id: 'feature-1', previous_agents_stopped: true });
    const incompleteState = await readControllerState(incomplete.stateDir);
    incompleteState.updated_at = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(); delete incompleteState.closed_at; await writeControllerState(incomplete.stateDir, incompleteState);
    const [incompleteRetained] = await dispatch('prune-expired', { state_dir: incomplete.stateDir });
    assert.equal(incompleteRetained.deleted_count, 0);
    assert.equal(incompleteRetained.retained.find(item => item.task_id === 'feature-1').reason, 'incomplete or unknown state fields');
    assert.equal((await readControllerState(incomplete.stateDir)).task_id, 'feature-1');

    incompleteState.closed_at = null; delete incompleteState.nodes.implement.attempt; await writeControllerState(incomplete.stateDir, incompleteState);
    const [incompleteNodeRetained] = await dispatch('prune-expired', { state_dir: incomplete.stateDir });
    assert.equal(incompleteNodeRetained.deleted_count, 0);
    assert.equal(incompleteNodeRetained.retained.find(item => item.task_id === 'feature-1').reason, 'incomplete, unknown, or active node state');
    assert.equal((await readControllerState(incomplete.stateDir)).task_id, 'feature-1');

    incompleteState.nodes.implement.attempt = 0; incompleteState.workspace_lease.future_field = true; await writeControllerState(incomplete.stateDir, incompleteState);
    const [invalidLeaseRetained] = await dispatch('prune-expired', { state_dir: incomplete.stateDir });
    assert.equal(invalidLeaseRetained.deleted_count, 0);
    assert.equal(invalidLeaseRetained.retained.find(item => item.task_id === 'feature-1').reason, 'workspace lease is not a complete released state');
    delete incompleteState.workspace_lease.future_field; incompleteState.requirements = [{}]; await writeControllerState(incomplete.stateDir, incompleteState);
    const [invalidRequirementsRetained] = await dispatch('prune-expired', { state_dir: incomplete.stateDir });
    assert.equal(invalidRequirementsRetained.deleted_count, 0);
    assert.equal(invalidRequirementsRetained.retained.find(item => item.task_id === 'feature-1').reason, 'malformed state collection item');
    incompleteState.updated_at = '1970-01-01T00:00:00.000Z'; await writeControllerState(incomplete.stateDir, incompleteState);
    await mkdir(path.join(incomplete.stateDir, '.workflow-review-results', 'feature-1', 'claim-1'), { recursive: true });
    await writeFile(path.join(incomplete.stateDir, '.workflow-review-results', 'feature-1', 'claim-1', 'outcome.json'), '{}');
    const [quarantineResult] = await dispatch('prune-expired', { state_dir: incomplete.stateDir });
    assert.equal(quarantineResult.deleted_count, 0);
    assert.equal(quarantineResult.quarantined_count, 1);
    const quarantined = quarantineResult.quarantined[0];
    assert.equal(quarantined.task_id, 'feature-1');
    assert.ok(Date.parse(quarantined.delete_after) - Date.now() > 364 * 24 * 60 * 60 * 1000);
    await assert.rejects(() => readControllerState(incomplete.stateDir), /does not exist/);
    const [doctor] = await dispatch('doctor', { state_dir: incomplete.stateDir, task_id: 'feature-1' });
    assert.equal(doctor.health, 'blocked');
    assert.equal(doctor.checks[0].id, 'quarantined_state');
    const quarantinePath = path.join(quarantined.error_path, 'quarantine.json');
    const quarantineMetadata = JSON.parse(await readFile(quarantinePath, 'utf8'));
    assert.equal(quarantineMetadata.version, 2);
    assert.equal(quarantineMetadata.status, 'quarantined');
    assert.equal(quarantineMetadata.review_artifacts, 'review-results');
    await assert.rejects(() => readFile(path.join(incomplete.stateDir, '.workflow-review-results', 'feature-1', 'claim-1', 'outcome.json')), /ENOENT/);
    assert.equal(await readFile(path.join(quarantined.error_path, 'review-results', 'claim-1', 'outcome.json'), 'utf8'), '{}');
    await writeFile(path.join(incomplete.stateDir, 'orphan.json.legacy'), '{"orphan":true}');
    const [directoryDoctor] = await dispatch('doctor', { state_dir: incomplete.stateDir });
    assert.equal(directoryDoctor.checks.find(check => check.id === 'quarantined_states').detail.entries[0].task_id, 'feature-1');
    assert.deepEqual(directoryDoctor.checks.find(check => check.id === 'orphan_legacy').detail.paths, ['orphan.json.legacy']);
    assert.deepEqual(quarantineMetadata.files.sort(), ['feature-1.sqlite']);
    const expiredAt = '1970-01-01T00:00:00.000Z';
    quarantineMetadata.quarantined_at = expiredAt;
    quarantineMetadata.delete_after = new Date(Date.parse(expiredAt) + 365 * 24 * 60 * 60 * 1000).toISOString();
    await writeFile(quarantinePath, JSON.stringify(quarantineMetadata));
    const expiryPath = path.join(quarantined.error_path, '.quarantine-expiry.json');
    const expiryMetadata = JSON.parse(await readFile(expiryPath, 'utf8'));
    expiryMetadata.quarantined_at = expiredAt;
    expiryMetadata.delete_after = quarantineMetadata.delete_after;
    await writeFile(expiryPath, JSON.stringify(expiryMetadata));
    const unexpectedArtifact = path.join(quarantined.error_path, 'unrelated.txt');
    await writeFile(unexpectedArtifact, 'retain this unknown artifact');
    const [retainedQuarantine] = await dispatch('prune-expired', { state_dir: incomplete.stateDir });
    assert.equal(retainedQuarantine.quarantine_deleted_count, 0);
    assert.match(retainedQuarantine.quarantine_retained[0].reason, /unexpected files/);
    await rm(unexpectedArtifact);
    const [expiredQuarantine] = await dispatch('prune-expired', { state_dir: incomplete.stateDir });
    assert.equal(expiredQuarantine.quarantine_deleted_count, 1);
    await assert.rejects(() => readFile(quarantinePath, 'utf8'), /ENOENT/);
    await assert.rejects(() => readFile(path.join(quarantined.error_path, 'review-results', 'claim-1', 'outcome.json'), 'utf8'), /ENOENT/);
  } finally { await rm(released.root, { recursive: true, force: true }); await rm(mismatch.root, { recursive: true, force: true }); await rm(active.root, { recursive: true, force: true }); await rm(unknown.root, { recursive: true, force: true }); await rm(incomplete.root, { recursive: true, force: true }); }
});

test('reconciles incomplete quarantine transfers and expires malformed metadata through its sidecar', async () => {
  const fixture = await setup();
  try {
    await dispatch('init', { state_dir: fixture.stateDir, manifest: fixture.manifest });
    await dispatch('release-workspace', { state_dir: fixture.stateDir, task_id: 'feature-1', previous_agents_stopped: true });
    const state = await readControllerState(fixture.stateDir);
    state.updated_at = '1970-01-01T00:00:00.000Z'; state.future_state_field = true;
    await writeControllerState(fixture.stateDir, state);
    const [quarantined] = await dispatch('prune-expired', { state_dir: fixture.stateDir });
    const errorPath = quarantined.quarantined[0].error_path;
    const metadataPath = path.join(errorPath, 'quarantine.json');
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
    const archivedState = path.join(errorPath, 'feature-1.sqlite');
    await rename(archivedState, path.join(fixture.stateDir, 'feature-1.sqlite'));
    metadata.status = 'quarantining'; metadata.move_error = 'simulated interrupted transfer';
    await writeFile(metadataPath, JSON.stringify(metadata));
    const [reconciled] = await dispatch('reconcile-quarantine', { state_dir: fixture.stateDir });
    assert.equal(reconciled.reconciled_count, 1);
    assert.equal(JSON.parse(await readFile(metadataPath, 'utf8')).status, 'quarantined');
    await readFile(archivedState);

    const expiryPath = path.join(errorPath, '.quarantine-expiry.json');
    const expiry = JSON.parse(await readFile(expiryPath, 'utf8'));
    expiry.quarantined_at = '1970-01-01T00:00:00.000Z';
    expiry.delete_after = new Date(Date.parse(expiry.quarantined_at) + 365 * 24 * 60 * 60 * 1000).toISOString();
    await writeFile(expiryPath, JSON.stringify(expiry));
    await writeFile(metadataPath, '{broken');
    const [expired] = await dispatch('prune-expired', { state_dir: fixture.stateDir });
    assert.equal(expired.quarantine_deleted_count, 1);
    assert.equal(expired.quarantine_deleted[0].recovered_from_invalid_metadata, true);
    await assert.rejects(() => readFile(expiryPath, 'utf8'), /ENOENT/);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('persists the six-hour automatic cleanup throttle across CLI processes while explicit pruning remains immediate', async () => {
  const fixture = await setup();
  try {
    await writeFile(fixture.manifest, JSON.stringify({ task_id: 'feature-1', workspace: fixture.workspace, goal: 'Throttle cleanup', routing_schema_version: 1, requirements: [{ id: 'R1', text: 'retain recent sweep state' }], nodes: [{ id: 'work', kind: 'implementation', execution_risk: 'protected', routing_reason: 'test', execution_owner: '/root/work', integration_owner: '/root', quality_guard: 'test' }, { id: 'total-review', kind: 'total_review', agent_type: 'avsp_sol_high', depends_on: ['work'], execution_risk: 'protected', routing_reason: 'test', execution_owner: '/root/reviewer', integration_owner: '/root', quality_guard: 'test' }] }));
    await dispatch('init', { state_dir: fixture.stateDir, manifest: fixture.manifest });
    await dispatch('release-workspace', { state_dir: fixture.stateDir, task_id: 'feature-1', previous_agents_stopped: true });
    await execFile(process.execPath, [controllerCli, 'status', '--task-id', 'feature-1', '--state-dir', fixture.stateDir], { cwd: fixture.root, windowsHide: true });
    const sweepPath = path.join(fixture.stateDir, '.workflow-prune-sweep.json');
    const firstSweep = JSON.parse(await readFile(sweepPath, 'utf8'));
    assert.ok(firstSweep.last_sweep_at);
    assert.equal(firstSweep.last_result.deleted_count, 0);
    const state = await readControllerState(fixture.stateDir);
    state.updated_at = '1970-01-01T00:00:00.000Z'; await writeControllerState(fixture.stateDir, state);
    await execFile(process.execPath, [controllerCli, 'status', '--task-id', 'feature-1', '--state-dir', fixture.stateDir], { cwd: fixture.root, windowsHide: true });
    assert.equal((await readControllerState(fixture.stateDir)).task_id, 'feature-1');
    const [pruned] = await dispatch('prune-expired', { state_dir: fixture.stateDir });
    assert.equal(pruned.deleted_count, 1);
    await assert.rejects(() => readControllerState(fixture.stateDir), /does not exist/);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('migrates a legacy JSON task to SQLite on its first state write and retains one recovery copy', async () => {
  const fixture = await setup();
  try {
    await dispatch('init', { state_dir: fixture.stateDir, manifest: fixture.manifest });
    const legacyPath = path.join(fixture.stateDir, 'feature-1.json');
    const databasePath = path.join(fixture.stateDir, 'feature-1.sqlite');
    const legacyState = await readControllerState(fixture.stateDir);
    await rm(databasePath);
    await writeFile(legacyPath, JSON.stringify(legacyState));
    const [claim] = await dispatch('claim', { state_dir: fixture.stateDir, task_id: 'feature-1', node_id: 'implement', agent_task_path: '/root/migrated-worker', agent_role: 'avsp_terra_high' });
    assert.equal(claim.node.status, 'running');
    assert.equal((await readControllerState(fixture.stateDir)).nodes.implement.agent_task_path, '/root/migrated-worker');
    assert.equal((await readFile(databasePath)).subarray(0, 16).toString(), 'SQLite format 3\u0000');
    assert.deepEqual(JSON.parse(await readFile(`${legacyPath}.legacy`, 'utf8')).nodes.implement.status, 'pending');
    await assert.rejects(() => readFile(legacyPath, 'utf8'), /ENOENT/);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('quarantines a corrupted SQLite task after the retention gate even when its lease cannot be verified', async () => {
  const fixture = await setup();
  try {
    await dispatch('init', { state_dir: fixture.stateDir, manifest: fixture.manifest });
    await dispatch('release-workspace', { state_dir: fixture.stateDir, task_id: 'feature-1', previous_agents_stopped: true });
    const databasePath = path.join(fixture.stateDir, 'feature-1.sqlite');
    await writeFile(databasePath, 'not a SQLite database');
    await utimes(databasePath, new Date(0), new Date(0));
    const [pruned] = await dispatch('prune-expired', { state_dir: fixture.stateDir });
    assert.equal(pruned.deleted_count, 0);
    assert.equal(pruned.quarantined_count, 1);
    assert.equal(pruned.quarantined[0].task_id, null);
    await assert.rejects(() => readFile(databasePath, 'utf8'), /ENOENT/);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('quarantines a force-expired incomplete task when its workspace lease registry is malformed', async () => {
  const fixture = await setup();
  try {
    await dispatch('init', { state_dir: fixture.stateDir, manifest: fixture.manifest });
    await dispatch('release-workspace', { state_dir: fixture.stateDir, task_id: 'feature-1', previous_agents_stopped: true });
    const state = await readControllerState(fixture.stateDir);
    state.updated_at = '1970-01-01T00:00:00.000Z'; state.future_state_field = true;
    await writeControllerState(fixture.stateDir, state);
    const leasePath = path.join(fixture.workspace, '.codex', 'workflow-controller', 'workspace-lease.json');
    const lease = JSON.parse(await readFile(leasePath, 'utf8'));
    lease.future_registry_field = true;
    await writeFile(leasePath, JSON.stringify(lease));
    const [pruned] = await dispatch('prune-expired', { state_dir: fixture.stateDir });
    assert.equal(pruned.deleted_count, 0);
    assert.equal(pruned.quarantined_count, 1);
    await assert.rejects(() => readControllerState(fixture.stateDir), /does not exist/);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('quarantines a force-expired incomplete task when it names a noncanonical lease registry', async () => {
  const fixture = await setup();
  try {
    await dispatch('init', { state_dir: fixture.stateDir, manifest: fixture.manifest });
    await dispatch('release-workspace', { state_dir: fixture.stateDir, task_id: 'feature-1', previous_agents_stopped: true });
    const state = await readControllerState(fixture.stateDir);
    state.updated_at = '1970-01-01T00:00:00.000Z'; state.future_state_field = true;
    const forgedLeasePath = path.join(fixture.root, 'forged-lease.json');
    state.workspace_lease.registry_path = forgedLeasePath;
    await writeControllerState(fixture.stateDir, state);
    await writeFile(forgedLeasePath, JSON.stringify({ version: 1, workspace: fixture.workspace, active_task: null, updated_at: new Date().toISOString() }));
    const [pruned] = await dispatch('prune-expired', { state_dir: fixture.stateDir });
    assert.equal(pruned.deleted_count, 0);
    assert.equal(pruned.quarantined_count, 1);
    await assert.rejects(() => readControllerState(fixture.stateDir), /does not exist/);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('rejects an ambiguous legacy migration before committing a new SQLite state', async () => {
  const fixture = await setup();
  try {
    await dispatch('init', { state_dir: fixture.stateDir, manifest: fixture.manifest });
    const legacyPath = path.join(fixture.stateDir, 'feature-1.json');
    const databasePath = path.join(fixture.stateDir, 'feature-1.sqlite');
    const state = await readControllerState(fixture.stateDir);
    await rm(databasePath);
    await writeFile(legacyPath, JSON.stringify(state));
    await mkdir(`${legacyPath}.legacy`);
    await assert.rejects(() => dispatch('claim', { state_dir: fixture.stateDir, task_id: 'feature-1', node_id: 'implement', agent_task_path: '/root/ambiguous-migration', agent_role: 'avsp_terra_high' }), /archive is not a regular file/);
    await assert.rejects(() => readFile(databasePath), /ENOENT/);
    assert.equal((JSON.parse(await readFile(legacyPath, 'utf8'))).nodes.implement.status, 'pending');
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('bounds the combined prune report to 128 entries', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agnets-prune-report-'));
  try {
    const stateDir = path.join(root, 'state'); await mkdir(stateDir);
    for (let index = 0; index < 129; index++) await writeFile(path.join(stateDir, `invalid-${index}.json`), '{}');
    const [pruned] = await dispatch('prune-expired', { state_dir: stateDir });
    assert.equal(pruned.deleted_count, 0); assert.equal(pruned.retained_count, 129); assert.equal(pruned.deleted.length + pruned.retained.length, 128); assert.equal(pruned.report_truncated, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('serializes stale-lock recovery and validates manifest and review fields', async () => {
  const fixture = await setup();
  try {
    const call = (command, parameters) => callForFixture(fixture, command, parameters);
    const invalidManifest = path.join(fixture.root, 'invalid-manifest.json');
    await writeFile(invalidManifest, JSON.stringify({ task_id: ' ', workspace: fixture.workspace, goal: ' ', requirements: [{ id: '', text: ' ' }], nodes: [{ id: '', kind: '' }] }));
    await assert.rejects(() => call('init', { manifest: invalidManifest }), ControllerError);

    await call('init', { manifest: fixture.manifest });
    const stateFile = path.join(fixture.stateDir, 'feature-1.json'); const staleLock = `${stateFile}.lock`;
    await writeFile(`${staleLock}.recover`, `pid=${process.pid} hostname=${os.hostname()} created=1970-01-01T00:00:00.000Z\n`);
    await assert.rejects(() => call('claim', { task_id: 'feature-1', node_id: 'implement', agent_task_path: '/root/blocked-by-recovery', agent_role: 'avsp_terra_high' }), /Task recovery is in progress/);
    await rm(`${staleLock}.recover`);
    await writeFile(staleLock, `pid=999999 hostname=${os.hostname()} created=1970-01-01T00:00:00.000Z\n`);
    await utimes(staleLock, new Date(0), new Date(0));
    const recoveries = await Promise.allSettled([call('recover-lock', { task_id: 'feature-1', stale_after_sec: 1 }), call('recover-lock', { task_id: 'feature-1', stale_after_sec: 1 })]);
    const recoveredCount = recoveries.filter(item => item.status === 'fulfilled' && item.value[0].recovered).length;
    assert.equal(recoveredCount, 1);

    for (const intentSuffix of ['.writer', '.release']) {
      await writeFile(staleLock, `pid=999999 hostname=${os.hostname()} created=1970-01-01T00:00:00.000Z\n`);
      await utimes(staleLock, new Date(0), new Date(0));
      await writeFile(`${staleLock}${intentSuffix}`, `pid=${process.pid} hostname=${os.hostname()} created=${new Date().toISOString()}\n`);
      let settled = false;
      const recovery = call('recover-lock', { task_id: 'feature-1', stale_after_sec: 1 }).then(value => { settled = true; return value; });
      await new Promise(resolve => setTimeout(resolve, 50));
      assert.equal(settled, false, `recovery must wait for ${intentSuffix} turnover intent`);
      await rm(`${staleLock}${intentSuffix}`);
      const [intentRecovered] = await recovery;
      assert.equal(intentRecovered.recovered, true);
    }

    const [context] = await call('audit-context', { task_id: 'feature-1' }); const review = path.join(fixture.root, 'review.json');
    await writeFile(review, JSON.stringify({ auditor_task: '/root/total-review', auditor_role: 'avsp_sol_high', verdict: 'pass', requirement_coverage: { R1: 'verified' }, workflow_snapshot: context.workflow_snapshot, workspace_fingerprint: context.workspace_fingerprint, scope_and_regression: 'none', verification_gaps: '', residual_risk: 'none' }));
    await assert.rejects(() => call('record-review', { task_id: 'feature-1', review }), ControllerError);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('marks a claimed but never-heartbeating node as never_activated and requires activation for total review', async () => {
  const fixture = await setup();
  try {
    const call = (command, parameters) => callForFixture(fixture, command, parameters);
    await call('init', { manifest: fixture.manifest });
    const [claim] = await call('claim', { task_id: 'feature-1', node_id: 'implement', agent_task_path: '/root/unstarted', agent_role: 'avsp_terra_high', lease_duration_sec: 1, activation_timeout_sec: 1 });
    const state = await readControllerState(fixture.stateDir);
    state.nodes.implement.activation_deadline_at = '1970-01-01T00:00:00.000Z'; await writeControllerState(fixture.stateDir, state);
    const [stale] = await call('stale', { task_id: 'feature-1' });
    assert.equal(stale.stale_nodes[0].reason, 'never_activated');
    await call('heartbeat', { task_id: 'feature-1', node_id: 'implement', claim_id: claim.node.claim_id });
    const afterHeartbeat = await readControllerState(fixture.stateDir);
    assert.equal(afterHeartbeat.nodes.implement.activation_at !== null, true);
    assert.equal((await call('stale', { task_id: 'feature-1' }))[0].stale_nodes.length, 0);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('workflow_start activates atomically and checkpoint refreshes the lease', async () => {
  const fixture = await setup();
  try {
    const call = (command, parameters) => callForFixture(fixture, command, parameters);
    await call('init', { manifest: fixture.manifest });
    const [started] = await call('start', { task_id: 'feature-1', node_id: 'implement', agent_task_path: '/root/implement', agent_role: 'avsp_terra_high', native_agent_started: true, lease_duration_sec: 1, activation_timeout_sec: 1 });
    assert.equal(started.node.activation_at !== null, true);
    assert.equal(started.node.activation_deadline_at, null);
    assert.equal(started.node.heartbeat_count, 1);
    const checkpoint = path.join(fixture.root, 'start-checkpoint.json'); await writeFile(checkpoint, JSON.stringify({ completed: [], next_step: 'run tests' }));
    await call('checkpoint', { task_id: 'feature-1', node_id: 'implement', claim_id: started.node.claim_id, checkpoint });
    const state = await readControllerState(fixture.stateDir);
    assert.equal(state.nodes.implement.heartbeat_count, 2);
    assert.equal(state.nodes.implement.heartbeat_at, state.nodes.implement.checkpoint_at);
    assert.equal((await call('stale', { task_id: 'feature-1' }))[0].stale_nodes.length, 0);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('does not complete a claimed node before its first activation handshake', async () => {
  const fixture = await setup();
  try {
    await dispatch('init', { state_dir: fixture.stateDir, manifest: fixture.manifest });
    const [claim] = await dispatch('claim', { state_dir: fixture.stateDir, task_id: 'feature-1', node_id: 'implement', agent_task_path: '/root/unactivated', agent_role: 'avsp_terra_high' });
    const result = path.join(fixture.root, 'unactivated-result.json'); await writeFile(result, JSON.stringify({}));
    await assert.rejects(
      () => dispatch('complete', { state_dir: fixture.stateDir, task_id: 'feature-1', node_id: 'implement', claim_id: claim.node.claim_id, status: 'succeeded', result, completion_attestation: 'native_agent_finished' }),
      /unactivated node cannot be completed/
    );
    assert.equal((await readControllerState(fixture.stateDir)).nodes.implement.status, 'running');
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('reserves failed-process attestations for unavailable total reviews', async () => {
  const fixture = await setup();
  try {
    const call = (command, parameters) => callForFixture(fixture, command, parameters);
    await call('init', { manifest: fixture.manifest });
    const implementation = await call('start', { task_id: 'feature-1', node_id: 'implement', agent_task_path: '/root/implement', agent_role: 'avsp_terra_high', native_agent_started: true });
    const implementationResult = path.join(fixture.root, 'implementation-result.json'); await writeFile(implementationResult, JSON.stringify({ completed: true }));
    await call('complete', { task_id: 'feature-1', node_id: 'implement', claim_id: implementation[0].node.claim_id, status: 'succeeded', result: implementationResult });
    const verification = await call('start', { task_id: 'feature-1', node_id: 'verify', agent_task_path: '/root/verify', agent_role: 'avsp_terra_high', native_agent_started: true });
    const verificationResult = path.join(fixture.root, 'verification-result.json'); await writeFile(verificationResult, JSON.stringify({ completed: true }));
    await call('complete', { task_id: 'feature-1', node_id: 'verify', claim_id: verification[0].node.claim_id, status: 'succeeded', result: verificationResult });
    const review = await call('start', { task_id: 'feature-1', node_id: 'total-review', agent_task_path: '/root/reviewer', agent_role: 'avsp_sol_high', native_agent_started: true });
    const reviewResult = path.join(fixture.root, 'review-result.json'); await writeFile(reviewResult, JSON.stringify({ unavailable: true }));
    await assert.rejects(
      () => call('complete', { task_id: 'feature-1', node_id: 'total-review', claim_id: review[0].node.claim_id, status: 'succeeded', result: reviewResult, completion_attestation: 'native_agent_exit_confirmed' }),
      /completion_attestation=native_agent_finished/
    );
    await call('complete', { task_id: 'feature-1', node_id: 'total-review', claim_id: review[0].node.claim_id, status: 'unavailable', result: reviewResult, completion_attestation: 'native_agent_exit_confirmed' });
    const state = await readControllerState(fixture.stateDir);
    assert.equal(state.nodes['total-review'].status, 'unavailable');
    assert.ok(state.events.some(event => event.type === 'node_completed' && event.completion_attestation === 'native_agent_exit_confirmed'));
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('CLI accepts lifecycle attestations for workflow start and completion', async () => {
  const fixture = await setup();
  try {
    await dispatch('init', { state_dir: fixture.stateDir, manifest: fixture.manifest });
    const started = await execFile(process.execPath, [controllerCli, 'start', '--task-id', 'feature-1', '--node-id', 'implement', '--agent-task-path', '/root/cli-worker', '--agent-role', 'avsp_terra_high', '--native-agent-started', 'true', '--state-dir', fixture.stateDir], { cwd: fixture.root, windowsHide: true });
    const startedNode = JSON.parse(started.stdout).node;
    assert.equal(startedNode.status, 'running');
    const result = path.join(fixture.root, 'cli-result.json'); await writeFile(result, JSON.stringify({ source: 'cli' }));
    const completed = await execFile(process.execPath, [controllerCli, 'complete', '--task-id', 'feature-1', '--node-id', 'implement', '--claim-id', startedNode.claim_id, '--status', 'succeeded', '--result', result, '--completion-attestation', 'native_agent_finished', '--state-dir', fixture.stateDir], { cwd: fixture.root, windowsHide: true });
    assert.equal(JSON.parse(completed.stdout).node.status, 'succeeded');
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('records an explicit Root rescue and requires the rescued role for the replacement claim', async () => {
  const fixture = await setup();
  try {
    const routing = { execution_risk: 'delegable', routing_reason: 'isolated reversible edit', execution_owner: '/root/luna', integration_owner: '/root', quality_guard: 'targeted test' };
    const reviewRouting = { execution_risk: 'protected', routing_reason: 'independent total review', execution_owner: '/root/reviewer', integration_owner: '/root', quality_guard: 'close gate' };
    await writeFile(fixture.manifest, JSON.stringify({ task_id: 'feature-1', workspace: fixture.workspace, goal: 'Record rescue handoff', routing_schema_version: 1, requirements: [{ id: 'R1', text: 'rescue is auditable' }], nodes: [{ id: 'implement', kind: 'implementation', agent_type: 'avsp_luna_high_executor', ...routing }, { id: 'total-review', kind: 'total_review', agent_type: 'avsp_sol_high', depends_on: ['implement'], ...reviewRouting }] }));
    const call = (command, parameters) => callForFixture(fixture, command, parameters);
    await call('init', { manifest: fixture.manifest });
    const [luna] = await call('start', { task_id: 'feature-1', node_id: 'implement', agent_task_path: '/root/luna', agent_role: 'avsp_luna_high_executor', native_agent_started: true });
    const [rescue] = await call('rescue', { task_id: 'feature-1', node_id: 'implement', claim_id: luna.node.claim_id, reason: 'Luna executor stopped before producing a verifiable result', replacement_agent_task_path: '/root/rescue', previous_agent_stopped: true });
    assert.equal(rescue.node.status, 'pending');
    assert.equal(rescue.node.rescue_role, 'main/root');
    assert.equal(rescue.node.execution_owner, '/root/rescue');
    assert.equal(rescue.recovery_package.previous_attempt.agent_task_path, '/root/luna');
    assert.equal(rescue.recovery_package.previous_attempt.execution_owner, '/root/luna');
    assert.equal(rescue.node.recovery_history.length, 1);
    const [root] = await call('start', { task_id: 'feature-1', node_id: 'implement', agent_task_path: '/root/rescue', agent_role: 'main/root', native_agent_started: true });
    const result = path.join(fixture.root, 'rescue-result.json'); await writeFile(result, JSON.stringify({ rescued: true }));
    await assert.rejects(() => call('complete', { task_id: 'feature-1', node_id: 'implement', claim_id: root.node.claim_id, status: 'succeeded', result }), /completion_attestation=root_rescue_self_completion/);
    await call('complete', { task_id: 'feature-1', node_id: 'implement', claim_id: root.node.claim_id, status: 'succeeded', result, completion_attestation: 'root_rescue_self_completion' });
    const state = await readControllerState(fixture.stateDir);
    assert.equal(state.nodes.implement.status, 'succeeded');
    assert.equal(state.nodes.implement.rescue_role, 'main/root');
    assert.ok(state.events.some(event => event.type === 'root_rescue'));
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('refuses to turn a non-Luna delegable attempt into a Root rescue', async () => {
  const fixture = await setup();
  try {
    const routing = { execution_risk: 'delegable', routing_reason: 'isolated reversible edit', execution_owner: '/root/terra', integration_owner: '/root', quality_guard: 'targeted test' };
    const reviewRouting = { execution_risk: 'protected', routing_reason: 'independent total review', execution_owner: '/root/reviewer', integration_owner: '/root', quality_guard: 'close gate' };
    await writeFile(fixture.manifest, JSON.stringify({ task_id: 'feature-1', workspace: fixture.workspace, goal: 'Reject invalid rescue source', routing_schema_version: 1, requirements: [{ id: 'R1', text: 'rescue source is Luna' }], nodes: [{ id: 'implement', kind: 'implementation', agent_type: 'avsp_terra_high', ...routing }, { id: 'total-review', kind: 'total_review', agent_type: 'avsp_sol_high', depends_on: ['implement'], ...reviewRouting }] }));
    await dispatch('init', { state_dir: fixture.stateDir, manifest: fixture.manifest });
    const [claim] = await dispatch('claim', { state_dir: fixture.stateDir, task_id: 'feature-1', node_id: 'implement', agent_task_path: '/root/terra', agent_role: 'avsp_terra_high' });
    await assert.rejects(
      () => dispatch('rescue', { state_dir: fixture.stateDir, task_id: 'feature-1', node_id: 'implement', claim_id: claim.node.claim_id, reason: 'Terra is still the valid integration owner', replacement_agent_task_path: '/root/rescue', previous_agent_stopped: true }),
      /Only a Luna executor or explicitly matched legacy writer attempt/
    );
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('uses a workspace lease across state directories and releases it only after explicit reconciliation', async () => {
  const fixture = await setup();
  try {
    const secondStateDir = path.join(fixture.root, 'second-state');
    const secondManifest = path.join(fixture.root, 'second-manifest.json');
    await writeFile(secondManifest, JSON.stringify({ task_id: 'feature-2', workspace: fixture.workspace, goal: 'Independent change', requirements: [{ id: 'R2', text: 'another change' }], nodes: [{ id: 'total-review', kind: 'total_review', agent_type: 'avsp_sol_high', depends_on: [] }] }));
    await dispatch('init', { state_dir: fixture.stateDir, manifest: fixture.manifest });
    await assert.rejects(() => dispatch('init', { state_dir: secondStateDir, manifest: secondManifest }), /active workflow task: feature-1/);
    await assert.rejects(() => dispatch('release-workspace', { state_dir: fixture.stateDir, task_id: 'feature-1', previous_agents_stopped: false }), /previous_agents_stopped must be true/);
    const [released] = await dispatch('release-workspace', { state_dir: fixture.stateDir, task_id: 'feature-1', previous_agents_stopped: true });
    assert.equal(released.released, true);
    await assert.rejects(() => dispatch('init', { state_dir: fixture.stateDir, manifest: fixture.manifest }), /Task already exists/);
    assert.equal(JSON.parse(await readFile(path.join(fixture.workspace, '.codex', 'workflow-controller', 'workspace-lease.json'), 'utf8')).active_task, null);
    await assert.rejects(() => dispatch('claim', { state_dir: fixture.stateDir, task_id: 'feature-1', node_id: 'implement', agent_task_path: '/root/old-task', agent_role: 'avsp_terra_high' }), /Workspace lease is not active/);
    const oldTaskNode = await writeNode(fixture.root, { id: 'old-task-node', kind: 'implementation' });
    await assert.rejects(() => dispatch('add-node', { state_dir: fixture.stateDir, task_id: 'feature-1', node: oldTaskNode }), /DAG is immutable/);
    const [initialized] = await dispatch('init', { state_dir: secondStateDir, manifest: secondManifest });
    assert.equal(initialized.task.task_id, 'feature-2');
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('reclaims only provably stale coordination intents and keeps heartbeats compact', async () => {
  const fixture = await setup();
  try {
    const call = (command, parameters) => callForFixture(fixture, command, parameters);
    await call('init', { manifest: fixture.manifest });
    const stateFile = path.join(fixture.stateDir, 'feature-1.json'); const staleWriter = `${stateFile}.lock.writer`;
    await writeFile(staleWriter, `pid=999999 hostname=${os.hostname()} created=1970-01-01T00:00:00.000Z\n`);
    await utimes(staleWriter, new Date(0), new Date(0));
    const [claim] = await call('claim', { task_id: 'feature-1', node_id: 'implement', agent_task_path: '/root/implement', agent_role: 'avsp_terra_high', lease_duration_sec: 1 });
    const beforeHeartbeat = await readControllerState(fixture.stateDir);
    await call('heartbeat', { task_id: 'feature-1', node_id: 'implement', claim_id: claim.node.claim_id });
    const afterHeartbeat = await readControllerState(fixture.stateDir);
    assert.equal(afterHeartbeat.events.length, beforeHeartbeat.events.length);
    assert.equal(afterHeartbeat.nodes.implement.heartbeat_count, 1);
    afterHeartbeat.nodes.implement.heartbeat_at = '1970-01-01T00:00:00.000Z';
    await writeControllerState(fixture.stateDir, afterHeartbeat);
    const [stale] = await call('stale', { task_id: 'feature-1' });
    assert.deepEqual(stale.stale_nodes.map(node => node.id), ['implement']);

    const staleRecovery = `${stateFile}.lock.recover`;
    await writeFile(staleRecovery, `pid=999999 hostname=${os.hostname()} created=1970-01-01T00:00:00.000Z\n`);
    await utimes(staleRecovery, new Date(0), new Date(0));
    await call('heartbeat', { task_id: 'feature-1', node_id: 'implement', claim_id: claim.node.claim_id });
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('requires an absolute state directory', async () => {
  const fixture = await setup();
  try {
    await assert.rejects(() => dispatch('init', { state_dir: '.codex/workflow-controller', manifest: fixture.manifest }), /state_dir must be an absolute path/);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('records complete routing fields and rejects unsafe Luna executor claims', async () => {
  const fixture = await setup();
  try {
    const fullRouting = { execution_risk: 'delegable', routing_reason: 'isolated and reversible', execution_owner: '/root/executor', integration_owner: '/root', quality_guard: 'targeted test' };
    const reviewRouting = { execution_risk: 'protected', routing_reason: 'independent total review', execution_owner: '/root/reviewer', integration_owner: '/root', quality_guard: 'close gate' };
    await writeFile(fixture.manifest, JSON.stringify({ task_id: 'feature-1', workspace: fixture.workspace, goal: 'Change app safely', routing_schema_version: 1, requirements: [{ id: 'R1', text: 'app changes' }], nodes: [{ id: 'implement', kind: 'implementation', agent_type: 'avsp_luna_high_executor', ...fullRouting }, { id: 'total-review', kind: 'total_review', agent_type: 'avsp_sol_high', depends_on: ['implement'], ...reviewRouting }] }));
    const [initialized] = await dispatch('init', { state_dir: fixture.stateDir, manifest: fixture.manifest });
    assert.deepEqual(Object.fromEntries(['execution_risk', 'routing_reason', 'execution_owner', 'integration_owner', 'quality_guard'].map(key => [key, initialized.task.nodes[0][key]])), fullRouting);
    await assert.rejects(() => dispatch('claim', { state_dir: fixture.stateDir, task_id: 'feature-1', node_id: 'implement', agent_task_path: '/root/not-owner', agent_role: 'avsp_luna_high_executor' }), /execution_owner/);
    const [claim] = await dispatch('claim', { state_dir: fixture.stateDir, task_id: 'feature-1', node_id: 'implement', agent_task_path: '/root/executor', agent_role: 'avsp_luna_high_executor' });
    assert.equal(claim.node.agent_role, 'avsp_luna_high_executor');
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('only Terra can claim protected work, even when a Luna role matches execution_owner', async () => {
  const fixture = await setup();
  try {
    const protectedRouting = { execution_risk: 'protected', routing_reason: 'workflow authorization boundary', execution_owner: '/root/protected-owner', integration_owner: '/root', quality_guard: 'targeted test' };
    const reviewRouting = { execution_risk: 'protected', routing_reason: 'independent total review', execution_owner: '/root/reviewer', integration_owner: '/root', quality_guard: 'close gate' };
    await writeFile(fixture.manifest, JSON.stringify({ task_id: 'feature-1', workspace: fixture.workspace, goal: 'Change app safely', routing_schema_version: 1, requirements: [{ id: 'R1', text: 'app changes' }], nodes: [{ id: 'implement', kind: 'implementation', ...protectedRouting }, { id: 'total-review', kind: 'total_review', agent_type: 'avsp_sol_high', depends_on: ['implement'], ...reviewRouting }] }));
    await dispatch('init', { state_dir: fixture.stateDir, manifest: fixture.manifest });
    for (const role of ['avsp_luna_high', 'avsp_luna_xhigh', 'avsp_luna_high_writer', 'avsp_luna_xhigh_writer', 'avsp_luna_high_executor', 'avsp_luna_xhigh_executor']) {
      await assert.rejects(() => dispatch('claim', { state_dir: fixture.stateDir, task_id: 'feature-1', node_id: 'implement', agent_task_path: '/root/protected-owner', agent_role: role }), /Only avsp_terra_high can claim protected work/);
    }
    const [claim] = await dispatch('claim', { state_dir: fixture.stateDir, task_id: 'feature-1', node_id: 'implement', agent_task_path: '/root/protected-owner', agent_role: 'avsp_terra_high' });
    assert.equal(claim.node.agent_role, 'avsp_terra_high');
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('routes read-only evidence to Luna without misclassifying it as delegable and records lifecycle attestations', async () => {
  const fixture = await setup();
  try {
    const evidenceRouting = { execution_risk: 'read_only', routing_reason: 'independent evidence collection without state changes', execution_owner: '/root/evidence', integration_owner: '/root', quality_guard: 'evidence is cited and bounded' };
    const writeRouting = { execution_risk: 'delegable', routing_reason: 'isolated reversible edit', execution_owner: '/root/reader', integration_owner: '/root', quality_guard: 'targeted test' };
    const reviewRouting = { execution_risk: 'protected', routing_reason: 'independent total review', execution_owner: '/root/reviewer', integration_owner: '/root', quality_guard: 'close gate' };
    await writeFile(fixture.manifest, JSON.stringify({ task_id: 'feature-1', workspace: fixture.workspace, goal: 'Separate evidence from execution', routing_schema_version: 1, requirements: [{ id: 'R1', text: 'Luna evidence is auditable' }], nodes: [{ id: 'evidence', kind: 'verification', ...evidenceRouting }, { id: 'write', kind: 'implementation', agent_type: 'avsp_luna_high_writer', ...writeRouting }, { id: 'untyped-write', kind: 'implementation', execution_risk: 'delegable', routing_reason: 'isolated reversible edit', execution_owner: '/root/untyped-reader', integration_owner: '/root', quality_guard: 'targeted test' }, { id: 'total-review', kind: 'total_review', agent_type: 'avsp_sol_high', depends_on: ['evidence', 'write', 'untyped-write'], ...reviewRouting }] }));
    const [initialized] = await dispatch('init', { state_dir: fixture.stateDir, manifest: fixture.manifest });
    assert.equal(initialized.task.nodes.find(node => node.id === 'evidence').agent_type, 'avsp_luna_high');
    assert.equal(initialized.task.nodes.find(node => node.id === 'untyped-write').agent_type, 'avsp_luna_high_executor');
    await assert.rejects(
      () => dispatch('start', { state_dir: fixture.stateDir, task_id: 'feature-1', node_id: 'evidence', agent_task_path: '/root/evidence', agent_role: 'avsp_luna_high' }),
      /native_agent_started must be true/
    );
    const [started] = await dispatch('start', { state_dir: fixture.stateDir, task_id: 'feature-1', node_id: 'evidence', agent_task_path: '/root/evidence', agent_role: 'avsp_luna_high', native_agent_started: true });
    const stateAfterStart = await readControllerState(fixture.stateDir);
    assert.ok(stateAfterStart.events.some(event => event.type === 'node_started' && event.node_id === 'evidence' && event.native_agent_started === true));
    const evidenceResult = path.join(fixture.root, 'evidence.json'); await writeFile(evidenceResult, JSON.stringify({ findings: [] }));
    await assert.rejects(
      () => dispatch('complete', { state_dir: fixture.stateDir, task_id: 'feature-1', node_id: 'evidence', claim_id: started.node.claim_id, status: 'succeeded', result: evidenceResult }),
      /completion_attestation=native_agent_finished/
    );
    await dispatch('complete', { state_dir: fixture.stateDir, task_id: 'feature-1', node_id: 'evidence', claim_id: started.node.claim_id, status: 'succeeded', result: evidenceResult, completion_attestation: 'native_agent_finished' });
    const stateAfterComplete = await readControllerState(fixture.stateDir);
    assert.ok(stateAfterComplete.events.some(event => event.type === 'node_completed' && event.node_id === 'evidence' && event.completion_attestation === 'native_agent_finished'));
    await assert.rejects(
      () => dispatch('claim', { state_dir: fixture.stateDir, task_id: 'feature-1', node_id: 'untyped-write', agent_task_path: '/root/untyped-reader', agent_role: 'avsp_luna_high' }),
      /Node agent_type must match claimed role/
    );
    const [writer] = await dispatch('claim', { state_dir: fixture.stateDir, task_id: 'feature-1', node_id: 'write', agent_task_path: '/root/reader', agent_role: 'avsp_luna_high_writer' });
    assert.equal(writer.node.agent_role, 'avsp_luna_high_writer');
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('requires and records an explicit Terra fallback for default read-only routing', async () => {
  const fixture = await setup();
  try {
    const evidenceRouting = { execution_risk: 'read_only', routing_reason: 'independent evidence collection without state changes', execution_owner: '/root/evidence', integration_owner: '/root', quality_guard: 'evidence is cited and bounded' };
    const reviewRouting = { execution_risk: 'protected', routing_reason: 'independent total review', execution_owner: '/root/reviewer', integration_owner: '/root', quality_guard: 'close gate' };
    await writeFile(fixture.manifest, JSON.stringify({ task_id: 'feature-1', workspace: fixture.workspace, goal: 'Record explicit fallback', routing_schema_version: 1, requirements: [{ id: 'R1', text: 'fallback is auditable' }], nodes: [{ id: 'evidence', kind: 'verification', ...evidenceRouting }, { id: 'total-review', kind: 'total_review', agent_type: 'avsp_sol_high', depends_on: ['evidence'], ...reviewRouting }] }));
    const [initialized] = await dispatch('init', { state_dir: fixture.stateDir, manifest: fixture.manifest });
    assert.equal(initialized.task.nodes[0].agent_type, 'avsp_luna_high');
    await assert.rejects(
      () => dispatch('claim', { state_dir: fixture.stateDir, task_id: 'feature-1', node_id: 'evidence', agent_task_path: '/root/evidence', agent_role: 'avsp_terra_low_readonly' }),
      /fallback_reason/
    );
    const fallbackReason = 'avsp_luna_high unavailable';
    const [claimed] = await dispatch('claim', { state_dir: fixture.stateDir, task_id: 'feature-1', node_id: 'evidence', agent_task_path: '/root/evidence', agent_role: 'avsp_terra_low_readonly', fallback_reason: fallbackReason });
    assert.equal(claimed.node.agent_role, 'avsp_terra_low_readonly');
    const state = await readControllerState(fixture.stateDir);
    const event = state.events.find(item => item.type === 'node_claimed' && item.node_id === 'evidence');
    assert.equal(event.fallback_reason, fallbackReason);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('requires and records an explicit Terra fallback for a non-total Sol read-only node', async () => {
  const fixture = await setup();
  try {
    const evidenceRouting = { execution_risk: 'read_only', routing_reason: 'complex independent evidence judgment', execution_owner: '/root/evidence', integration_owner: '/root', quality_guard: 'evidence is cited and bounded' };
    const reviewRouting = { execution_risk: 'protected', routing_reason: 'independent total review', execution_owner: '/root/reviewer', integration_owner: '/root', quality_guard: 'close gate' };
    await writeFile(fixture.manifest, JSON.stringify({ task_id: 'feature-1', workspace: fixture.workspace, goal: 'Record Sol-stage fallback', routing_schema_version: 1, requirements: [{ id: 'R1', text: 'fallback is auditable' }], nodes: [{ id: 'evidence', kind: 'verification', agent_type: 'avsp_sol_high', ...evidenceRouting }, { id: 'total-review', kind: 'total_review', depends_on: ['evidence'], ...reviewRouting }] }));
    await dispatch('init', { state_dir: fixture.stateDir, manifest: fixture.manifest });
    await assert.rejects(
      () => dispatch('claim', { state_dir: fixture.stateDir, task_id: 'feature-1', node_id: 'evidence', agent_task_path: '/root/evidence', agent_role: 'avsp_terra_xhigh_readonly' }),
      /fallback_reason/
    );
    const fallbackReason = 'avsp_sol_high unavailable';
    const [claimed] = await dispatch('claim', { state_dir: fixture.stateDir, task_id: 'feature-1', node_id: 'evidence', agent_task_path: '/root/evidence', agent_role: 'avsp_terra_xhigh_readonly', fallback_reason: fallbackReason });
    assert.equal(claimed.node.agent_role, 'avsp_terra_xhigh_readonly');
    const state = await readControllerState(fixture.stateDir);
    assert.equal(state.events.find(item => item.type === 'node_claimed').fallback_reason, fallbackReason);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('defaults modern total review to Sol high and records an explicit Terra fallback', async () => {
  const fixture = await setup();
  try {
    const reviewRouting = { execution_risk: 'protected', routing_reason: 'independent total review', execution_owner: '/root/reviewer', integration_owner: '/root', quality_guard: 'close gate' };
    await writeFile(fixture.manifest, JSON.stringify({ task_id: 'feature-1', workspace: fixture.workspace, goal: 'Record total-review fallback', routing_schema_version: 1, requirements: [{ id: 'R1', text: 'fallback is auditable' }], nodes: [{ id: 'total-review', kind: 'total_review', ...reviewRouting }] }));
    const [initialized] = await dispatch('init', { state_dir: fixture.stateDir, manifest: fixture.manifest });
    assert.equal(initialized.task.nodes[0].agent_type, 'avsp_sol_high');
    await assert.rejects(
      () => dispatch('claim', { state_dir: fixture.stateDir, task_id: 'feature-1', node_id: 'total-review', agent_task_path: '/root/reviewer', agent_role: 'avsp_terra_xhigh' }),
      /total_review node requires a Sol role/
    );
    await assert.rejects(
      () => dispatch('claim', { state_dir: fixture.stateDir, task_id: 'feature-1', node_id: 'total-review', agent_task_path: '/root/reviewer', agent_role: 'avsp_terra_xhigh_readonly' }),
      /fallback_reason/
    );
    const fallbackReason = 'avsp_sol_high unavailable';
    const [claimed] = await dispatch('start', { state_dir: fixture.stateDir, task_id: 'feature-1', node_id: 'total-review', agent_task_path: '/root/reviewer', agent_role: 'avsp_terra_xhigh_readonly', native_agent_started: true, fallback_reason: fallbackReason });
    const [context] = await dispatch('audit-context', { state_dir: fixture.stateDir, task_id: 'feature-1' });
    const review = path.join(fixture.root, 'fallback-review.json');
    await writeFile(review, JSON.stringify({ auditor_task: '/root/reviewer', auditor_role: 'avsp_terra_xhigh_readonly', claim_id: claimed.node.claim_id, verdict: 'unavailable', fallback_reason: fallbackReason, requirement_coverage: { R1: 'Sol high unavailable; Terra fallback recorded' }, workflow_snapshot: context.workflow_snapshot, workspace_fingerprint: context.workspace_fingerprint, scope_and_regression: 'not executed because the Sol reviewer was unavailable', verification_gaps: 'independent Sol review unavailable', residual_risk: 'independence is reduced by Terra fallback' }));
    const [recorded] = await dispatch('record-review', { state_dir: fixture.stateDir, task_id: 'feature-1', review });
    assert.equal(recorded.review.auditor_role, 'avsp_terra_xhigh_readonly');
    assert.equal(recorded.review.fallback_reason, fallbackReason);
    const state = await readControllerState(fixture.stateDir);
    assert.equal(state.events.find(item => item.type === 'node_claimed').fallback_reason, fallbackReason);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('does not apply v1 default agent types to complete legacy routing manifests', async () => {
  const fixture = await setup();
  try {
    const workRouting = { execution_risk: 'delegable', routing_reason: 'isolated reversible edit', execution_owner: '/root/terra', integration_owner: '/root', quality_guard: 'targeted test' };
    const reviewRouting = { execution_risk: 'protected', routing_reason: 'independent total review', execution_owner: '/root/reviewer', integration_owner: '/root', quality_guard: 'close gate' };
    await writeFile(fixture.manifest, JSON.stringify({ task_id: 'feature-1', workspace: fixture.workspace, goal: 'Preserve legacy routing', requirements: [{ id: 'R1', text: 'legacy routing remains claimable' }], nodes: [{ id: 'work', kind: 'implementation', ...workRouting }, { id: 'total-review', kind: 'total_review', agent_type: 'avsp_sol_high', depends_on: ['work'], ...reviewRouting }] }));
    const [initialized] = await dispatch('init', { state_dir: fixture.stateDir, manifest: fixture.manifest });
    assert.equal(initialized.task.nodes.find(node => node.id === 'work').agent_type, null);
    const [claimed] = await dispatch('claim', { state_dir: fixture.stateDir, task_id: 'feature-1', node_id: 'work', agent_task_path: '/root/terra', agent_role: 'avsp_terra_high' });
    assert.equal(claimed.node.agent_role, 'avsp_terra_high');
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('routing schema rejects incomplete fields and duplicate delegable execution owners', async () => {
  const fixture = await setup();
  try {
    const base = { task_id: 'feature-1', workspace: fixture.workspace, goal: 'Change app safely', routing_schema_version: 1, requirements: [{ id: 'R1', text: 'app changes' }] };
    await writeFile(fixture.manifest, JSON.stringify({ ...base, nodes: [{ id: 'partial', kind: 'implementation', execution_risk: 'delegable' }] }));
    await assert.rejects(() => dispatch('init', { state_dir: fixture.stateDir, manifest: fixture.manifest }), /routing fields/);
    const reviewRoute = { execution_risk: 'protected', routing_reason: 'independent close gate', execution_owner: '/root/reviewer', integration_owner: '/root', quality_guard: 'review all requirements' };
    for (const agentType of ['avsp_terra_xhigh', 'avsp_terra_xhigh_readonly']) {
      await writeFile(fixture.manifest, JSON.stringify({ ...base, nodes: [{ id: 'total-review', kind: 'total_review', agent_type: agentType, ...reviewRoute }] }));
      await assert.rejects(() => dispatch('init', { state_dir: fixture.stateDir, manifest: fixture.manifest }), /requires a Sol agent_type/);
    }
    await writeFile(fixture.manifest, JSON.stringify({ ...base, nodes: [{ id: 'total-review', kind: 'total_review', ...reviewRoute, execution_risk: 'delegable' }] }));
    await assert.rejects(() => dispatch('init', { state_dir: fixture.stateDir, manifest: fixture.manifest }), /total_review node cannot be delegable/);
    const evidenceRoute = { execution_risk: 'read_only', routing_reason: 'independent evidence', execution_owner: '/root/evidence', integration_owner: '/root', quality_guard: 'cite evidence' };
    for (const agentType of ['avsp_terra_low_readonly', 'avsp_terra_medium_readonly', 'avsp_terra_xhigh_readonly']) {
      await writeFile(fixture.manifest, JSON.stringify({ ...base, nodes: [{ id: 'evidence', kind: 'verification', agent_type: agentType, ...evidenceRoute }, { id: 'total-review', kind: 'total_review', depends_on: ['evidence'], ...reviewRoute }] }));
      await assert.rejects(() => dispatch('init', { state_dir: fixture.stateDir, manifest: fixture.manifest }), /cannot configure a Terra fallback role/);
    }
    const incompatibleRoutes = [
      { risk: 'protected', agent_type: 'avsp_luna_high', error: /protected node agent_type/ },
      { risk: 'protected', agent_type: 'avsp_luna_high_executor', error: /protected node agent_type/ },
      { risk: 'delegable', agent_type: 'avsp_luna_high', error: /delegable node agent_type/ },
      { risk: 'delegable', agent_type: 'avsp_sol_high', error: /delegable node agent_type/ },
      { risk: 'read_only', agent_type: 'avsp_luna_high_executor', error: /read_only node agent_type/ },
      { risk: 'read_only', agent_type: 'avsp_terra_high', error: /read_only node agent_type/ },
      { risk: 'read_only', agent_type: 'avsp_unknown', error: /read_only node agent_type/ },
    ];
    for (const route of incompatibleRoutes) {
      const node = { id: 'work', kind: 'implementation', agent_type: route.agent_type, ...evidenceRoute, execution_risk: route.risk };
      await writeFile(fixture.manifest, JSON.stringify({ ...base, nodes: [node, { id: 'total-review', kind: 'total_review', depends_on: ['work'], ...reviewRoute }] }));
      await assert.rejects(() => dispatch('init', { state_dir: fixture.stateDir, manifest: fixture.manifest }), route.error);
    }
    const route = { execution_risk: 'delegable', routing_reason: 'reversible', execution_owner: '/root/executor', integration_owner: '/root', quality_guard: 'test' };
    await writeFile(fixture.manifest, JSON.stringify({ ...base, nodes: [{ id: 'one', kind: 'implementation', ...route }, { id: 'two', kind: 'implementation', ...route }] }));
    await assert.rejects(() => dispatch('init', { state_dir: fixture.stateDir, manifest: fixture.manifest }), /distinct execution_owner/);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('legacy routing cannot treat a Terra fallback role as the primary reviewer', async () => {
  const fixture = await setup();
  try {
    const evidenceRoute = { execution_risk: 'read_only', routing_reason: 'independent evidence', execution_owner: '/root/evidence', integration_owner: '/root', quality_guard: 'cite evidence' };
    const reviewRoute = { execution_risk: 'protected', routing_reason: 'independent close gate', execution_owner: '/root/reviewer', integration_owner: '/root', quality_guard: 'review all requirements' };
    await writeFile(fixture.manifest, JSON.stringify({ task_id: 'feature-1', workspace: fixture.workspace, goal: 'Reject direct fallback routing', requirements: [{ id: 'R1', text: 'fallback is explicit' }], nodes: [{ id: 'evidence', kind: 'verification', agent_type: 'avsp_terra_low_readonly', ...evidenceRoute }, { id: 'total-review', kind: 'total_review', agent_type: 'avsp_sol_high', depends_on: ['evidence'], ...reviewRoute }] }));
    await dispatch('init', { state_dir: fixture.stateDir, manifest: fixture.manifest });
    await assert.rejects(
      () => dispatch('claim', { state_dir: fixture.stateDir, task_id: 'feature-1', node_id: 'evidence', agent_task_path: '/root/evidence', agent_role: 'avsp_terra_low_readonly', fallback_reason: 'configured directly' }),
      /fallback-only for its configured Luna or Sol reviewer/
    );
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('MCP schema forwards the workspace-release confirmation parameter used by the controller', () => {
  const claim = TOOLS.find(tool => tool.name === 'workflow_claim');
  assert.equal(claim.inputSchema.properties.activation_timeout_sec.minimum, 1);
  assert.equal(claim.inputSchema.properties.fallback_reason.type, 'string');
  const start = TOOLS.find(tool => tool.name === 'workflow_start');
  assert.deepEqual(start.inputSchema.required, ['task_id', 'node_id', 'agent_task_path', 'agent_role', 'native_agent_started', 'state_dir']);
  assert.equal(start.inputSchema.properties.native_agent_started.const, true);
  assert.equal(start.inputSchema.properties.fallback_reason.type, 'string');
  assert.equal(TOOL_COMMANDS.workflow_start, 'start');
  const wait = TOOLS.find(tool => tool.name === 'workflow_wait');
  assert.deepEqual(wait.inputSchema.required, ['task_id', 'state_dir', 'after_cursor']);
  assert.equal(wait.inputSchema.properties.timeout_sec.maximum, 600);
  assert.equal(TOOL_COMMANDS.workflow_wait, 'wait');
  const complete = TOOLS.find(tool => tool.name === 'workflow_complete');
  assert.deepEqual(complete.inputSchema.required, ['task_id', 'node_id', 'claim_id', 'status', 'result', 'completion_attestation', 'state_dir']);
  assert.deepEqual(complete.inputSchema.properties.completion_attestation.enum, ['native_agent_finished', 'root_rescue_self_completion', 'native_agent_exit_confirmed', 'native_agent_start_failed']);
  const release = TOOLS.find(tool => tool.name === 'workflow_release_workspace');
  assert.deepEqual(release.inputSchema.required, ['task_id', 'previous_agents_stopped', 'state_dir']);
  assert.equal(release.inputSchema.properties.previous_agents_stopped.const, true);
  assert.equal(TOOL_COMMANDS.workflow_release_workspace, 'release-workspace');
  assert.ok(TOOLS.some(tool => tool.name === 'workflow_reconcile_workspace'));
  const doctor = TOOLS.find(tool => tool.name === 'workflow_doctor');
  assert.deepEqual(doctor.inputSchema.required, ['state_dir']);
  const quarantine = TOOLS.find(tool => tool.name === 'workflow_reconcile_quarantine');
  assert.deepEqual(quarantine.inputSchema.required, ['state_dir']);
  assert.equal(TOOL_COMMANDS.workflow_reconcile_quarantine, 'reconcile-quarantine');
});

test('MCP retry schema retains only the canonical stopped-agent confirmation parameter', () => {
  const abandon = TOOLS.find(tool => tool.name === 'workflow_abandon');
  assert.deepEqual(abandon.inputSchema.required, ['task_id', 'node_id', 'claim_id', 'reason', 'previous_agent_stopped', 'state_dir']);
  assert.equal(abandon.inputSchema.properties.previous_agent_stopped.const, true);
  const retry = TOOLS.find(tool => tool.name === 'workflow_retry');
  assert.deepEqual(retry.inputSchema.required, ['task_id', 'node_id', 'reason', 'previous_agent_stopped', 'state_dir']);
  assert.equal(retry.inputSchema.properties.previous_agent_stopped.const, true);
  assert.equal(Object.hasOwn(retry.inputSchema.properties, 'previous_agents_stopped'), false);
  const checkpoint = TOOLS.find(tool => tool.name === 'workflow_checkpoint');
  assert.deepEqual(checkpoint.inputSchema.required, ['task_id', 'node_id', 'claim_id', 'checkpoint', 'state_dir']);
  const requeue = TOOLS.find(tool => tool.name === 'workflow_requeue_stale');
  assert.deepEqual(requeue.inputSchema.required, ['task_id', 'node_id', 'claim_id', 'reason', 'replacement_agent_task_path', 'previous_agent_stopped', 'state_dir']);
  assert.equal(requeue.inputSchema.properties.previous_agent_stopped.const, true);
  assert.equal(TOOL_COMMANDS.workflow_requeue_stale, 'requeue-stale');
  const rescue = TOOLS.find(tool => tool.name === 'workflow_rescue');
  assert.deepEqual(rescue.inputSchema.required, ['task_id', 'node_id', 'claim_id', 'reason', 'replacement_agent_task_path', 'previous_agent_stopped', 'state_dir']);
  assert.equal(rescue.inputSchema.properties.previous_agent_stopped.const, true);
  assert.equal(TOOL_COMMANDS.workflow_rescue, 'rescue');
  assert.equal(TOOL_COMMANDS.workflow_prune_expired, 'prune-expired');
});

test('reconciles an interrupted initialization without allowing an unregistered task to run', async () => {
  const fixture = await setup();
  try {
    await dispatch('init', { state_dir: fixture.stateDir, manifest: fixture.manifest });
    const leasePath = path.join(fixture.workspace, '.codex', 'workflow-controller', 'workspace-lease.json');
    const lease = JSON.parse(await readFile(leasePath, 'utf8'));
    lease.active_task.phase = 'initializing';
    await writeFile(leasePath, JSON.stringify(lease));
    await assert.rejects(() => dispatch('claim', { state_dir: fixture.stateDir, task_id: 'feature-1', node_id: 'implement', agent_task_path: '/root/blocked', agent_role: 'avsp_terra_high' }), /does not belong to this active task/);
    const [reconciled] = await dispatch('reconcile-workspace', { workspace: fixture.workspace });
    assert.equal(reconciled.action, 'activated_existing_initialization');
    const [claim] = await dispatch('claim', { state_dir: fixture.stateDir, task_id: 'feature-1', node_id: 'implement', agent_task_path: '/root/resumed', agent_role: 'avsp_terra_high' });
    assert.equal(claim.node.status, 'running');
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('reconcile never reactivates a released task state', async () => {
  const fixture = await setup();
  try {
    await dispatch('init', { state_dir: fixture.stateDir, manifest: fixture.manifest });
    await dispatch('release-workspace', { state_dir: fixture.stateDir, task_id: 'feature-1', previous_agents_stopped: true });
    const leasePath = path.join(fixture.workspace, '.codex', 'workflow-controller', 'workspace-lease.json'); const statePath = path.join(fixture.stateDir, 'feature-1.json'); const state = await readControllerState(fixture.stateDir);
    await writeFile(leasePath, JSON.stringify({ version: 1, workspace: state.workspace, active_task: { task_id: 'feature-1', state_path: statePath, state_dir: fixture.stateDir, acquired_at: state.workspace_lease.acquired_at, phase: 'initializing' }, updated_at: new Date().toISOString() }));
    const [reconciled] = await dispatch('reconcile-workspace', { workspace: fixture.workspace });
    assert.equal(reconciled.action, 'cleared_released_initialization');
    assert.equal(JSON.parse(await readFile(leasePath, 'utf8')).active_task, null);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('rejects a stale lock whose created timestamp is not valid metadata', async () => {
  const fixture = await setup();
  try {
    await dispatch('init', { state_dir: fixture.stateDir, manifest: fixture.manifest });
    const staleLock = `${path.join(fixture.stateDir, 'feature-1.json')}.lock`;
    await writeFile(staleLock, `pid=999999 hostname=${os.hostname()} created=not-a-timestamp\n`);
    await utimes(staleLock, new Date(0), new Date(0));
    await assert.rejects(() => dispatch('recover-lock', { state_dir: fixture.stateDir, task_id: 'feature-1', stale_after_sec: 1 }), /Cannot safely recover lock: .*untrusted metadata/);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('CLI processes serialize competing workspace initialization', async () => {
  const fixture = await setup();
  try {
    const secondStateDir = path.join(fixture.root, 'second-state');
    const secondManifest = path.join(fixture.root, 'second-manifest.json');
    await writeFile(secondManifest, JSON.stringify({ task_id: 'feature-2', workspace: fixture.workspace, goal: 'Independent change', requirements: [{ id: 'R2', text: 'another change' }], nodes: [{ id: 'total-review', kind: 'total_review', agent_type: 'avsp_sol_high', depends_on: [] }] }));
    const invoke = (stateDir, manifest) => execFile(process.execPath, [controllerCli, 'init', '--state-dir', stateDir, '--manifest', manifest], { cwd: fixture.root, windowsHide: true });
    const results = await Promise.allSettled([invoke(fixture.stateDir, fixture.manifest), invoke(secondStateDir, secondManifest)]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter(result => result.status === 'rejected').length, 1);
    const rejected = results.find(result => result.status === 'rejected');
    assert.match(rejected.reason.stderr, /active workflow task/);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

async function writeNode(root, node) {
  const file = path.join(root, `${node.id}.json`); await writeFile(file, JSON.stringify(node)); return file;
}
