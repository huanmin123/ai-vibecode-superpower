import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdtemp, readFile as readDiskFile, rm, writeFile as writeDiskFile, mkdir, rename, utimes } from 'node:fs/promises';
import { promises as fsPromises } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { ControllerError, dispatch, stableJson, workspaceFingerprint } from '../scripts/workflow_controller.mjs';
import { readTaskState, writeTaskState } from '../scripts/sqlite_task_store.mjs';
import { TOOLS, TOOL_COMMANDS } from '../scripts/workflow_controller_mcp.mjs';

const execFile = promisify(execFileCallback);
const controllerCli = fileURLToPath(new URL('../scripts/workflow_controller.mjs', import.meta.url));

const readFile = readDiskFile;
const writeFile = writeDiskFile;
function assuranceAssessmentFor(level) {
  const dimension = (name, status = 'controlled') => ({ status, evidence: [`${name} evidence`], rationale: `${name} is ${status}.` });
  const uncertainty = level === 'sol' ? 'unknown' : level === 'terra' ? 'partial' : 'controlled';
  return {
    impact: dimension('impact'),
    recoverability: dimension('recoverability'),
    uncertainty: dimension('uncertainty', uncertainty),
    verifiability: dimension('verifiability'),
    coupling: dimension('coupling'),
    selection_reason: `${level} is selected from the structured assurance evidence.`,
  };
}

function findingsFor(name, verdict) {
  return verdict === 'fail'
    ? [{ id: `${name}-blocking`, severity: 'blocking', requirement_id: 'R1', summary: `${name} found a blocking issue`, evidence: `${name} evidence` }]
    : [];
}

const v3ReviewContext = {
  environment: 'Local Windows workspace and the configured project runtime.',
  scenarios: ['Primary expected workflow', 'Failure repair and escalation boundary'],
  boundaries: 'Only the declared workspace claims and original requirements are in scope.',
};

function v3ReviewPayload({ taskPath, role, claimId, verdict, context, name, extra = {} }) {
  return {
    auditor_task: taskPath,
    auditor_role: role,
    claim_id: claimId,
    verdict,
    findings: findingsFor(name, verdict),
    requirement_coverage: { R1: `${name} coverage` },
    workflow_snapshot: context.workflow_snapshot,
    workspace_fingerprint: context.workspace_fingerprint,
    scope_and_regression: `${name} scope and regressions`,
    verification_gaps: `${name} verification gaps`,
    residual_risk: `${name} residual risk`,
    independent_assessment: `${name} independent assessment from the original requirements and current workspace.`,
    history_reconciliation: `${name} reconciled all previous review and repair evidence without treating it as conclusive.`,
    review_history_digest: context.review_history_digest,
    ...extra,
  };
}

const verificationAssuranceAssessment = assuranceAssessmentFor('verification');
const terraAssuranceAssessment = assuranceAssessmentFor('terra');
const solAssuranceAssessment = assuranceAssessmentFor('sol');

function legacyWorkflowSnapshot(state) {
  const nodes = Object.values(state.nodes)
    .filter(node => node.kind !== 'total_review')
    .sort((left, right) => left.id.localeCompare(right.id))
    .map(node => ({
      id: node.id,
      kind: node.kind,
      agent_type: node.agent_type,
      depends_on: [...node.depends_on].sort(),
      execution_risk: node.execution_risk,
      routing_reason: node.routing_reason,
      execution_owner: node.execution_owner,
      integration_owner: node.integration_owner,
      quality_guard: node.quality_guard,
      status: node.status,
      result: node.result,
    }));
  const material = { task_id: state.task_id, goal: state.goal, requirements: [...state.requirements].sort((left, right) => left.id.localeCompare(right.id)), scope: state.scope, non_goals: state.non_goals, nodes };
  return { workflow_revision: state.workflow_revision, digest_algorithm: 'sha256-stable-json-v1', digest: createHash('sha256').update(stableJson(material)).digest('hex') };
}

function quarantineBindingForTest(record, errorPath) {
  const anchored = Object.prototype.hasOwnProperty.call(record, 'authority_anchor');
  return createHash('sha256').update(stableJson({
    schema: anchored ? 'workflow-quarantine-binding-v2' : 'workflow-quarantine-binding-v1',
    error_path: path.resolve(errorPath),
    task_id: record.task_id,
    original_state_path: record.original_state_path,
    files: record.files,
    review_artifacts: record.review_artifacts ?? null,
    workspace: record.workspace ?? null,
    registry_path: record.registry_path ?? null,
    ...(anchored ? { authority_anchor: record.authority_anchor } : {}),
  })).digest('hex');
}

function quarantineAuthorityAnchorForTest(record) {
  return createHash('sha256').update(stableJson({
    schema: 'workflow-quarantine-authority-v1',
    workspace: record.workspace,
    registry_path: record.registry_path,
    task_id: record.task_id,
    original_state_path: record.original_state_path,
    files: record.files,
    review_artifacts: record.review_artifacts ?? null,
  })).digest('hex');
}

async function waitForPath(filePath, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { await fsPromises.access(filePath); return; }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${filePath}`);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
}

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
  const database = path.join(stateDir, `${taskId}.sqlite`); const metadata = await fsPromises.lstat(stateDir, { bigint: true });
  await writeTaskState(database, state, { parentAuthority: { path: stateDir, realPath: await fsPromises.realpath(stateDir), identity: { dev: metadata.dev.toString(), ino: metadata.ino.toString() } } });
}

async function writeLeaseForTest(workspace, mutate) {
  const leasePath = path.join(workspace, '.codex', 'workflow-controller', 'workspace-lease.json');
  const authorityPath = path.join(workspace, '.codex-workflow-controller-authority.json');
  const lease = JSON.parse(await readFile(leasePath, 'utf8'));
  mutate(lease);
  await writeFile(leasePath, JSON.stringify(lease));
  const metadata = await fsPromises.lstat(leasePath, { bigint: true });
  const authority = JSON.parse(await readFile(authorityPath, 'utf8'));
  authority.registry_identity = { dev: metadata.dev.toString(), ino: metadata.ino.toString() };
  authority.registry_bound_at = new Date().toISOString();
  await writeFile(authorityPath, JSON.stringify(authority));
  return leasePath;
}

async function canonicalStateFile(stateDir, taskId) {
  return path.join(await fsPromises.realpath(stateDir), `${taskId}.json`);
}

async function writePendingWorkflowOutcome(stateDir, taskId, nodeId, claimId, extra = {}) {
  const physicalStateDir = await fsPromises.realpath(stateDir);
  const directories = [physicalStateDir, path.join(physicalStateDir, '.workflow-review-results'), path.join(physicalStateDir, '.workflow-review-results', taskId), path.join(physicalStateDir, '.workflow-review-results', taskId, claimId)];
  for (const directory of directories.slice(1)) await mkdir(directory, { recursive: true });
  const records = [];
  for (const directory of directories) {
    const metadata = await fsPromises.lstat(directory, { bigint: true });
    records.push({ path: directory, real_path: await fsPromises.realpath(directory), identity: { dev: metadata.dev.toString(), ino: metadata.ino.toString() } });
  }
  const resultPath = path.join(directories.at(-1), 'outcome.json');
  const authority = { version: 1, platform: process.platform, root_real_path: records[0].real_path, target_directory: directories.at(-1), target_real_path: records.at(-1).real_path, directories: records };
  await writeFile(resultPath, JSON.stringify({ ...extra, workflow: { state_dir: physicalStateDir, task_id: taskId, node_id: nodeId, claim_id: claimId }, workflow_artifact_authority: authority, workflow_completion: { state: 'pending' } }));
  return resultPath;
}

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agnets-workflow-'));
  const workspace = path.join(root, 'workspace'); const stateDir = path.join(root, 'state');
  await mkdir(workspace); await writeFile(path.join(workspace, 'app.txt'), 'before\n');
  const manifest = path.join(root, 'manifest.json');
  await writeFile(manifest, JSON.stringify({ task_id: 'feature-1', workspace, goal: 'Change app safely', requirements: [{ id: 'R1', text: 'app changes' }], nodes: [{ id: 'implement', kind: 'implementation', agent_type: 'avsp_terra_high' }, { id: 'verify', kind: 'verification', depends_on: ['implement'] }, { id: 'total-review', kind: 'total_review', agent_type: 'avsp_sol_high', depends_on: ['implement', 'verify'] }] }));
  return { root, workspace, stateDir, manifest };
}

async function establishMaxCharter(fixture) {
  const call = (command, parameters) => callForFixture(fixture, command, parameters);
  await call('init', { manifest: fixture.manifest });
  for (const [nodeId, taskPath] of [['implement', '/root/max-implement'], ['verify', '/root/max-verify']]) {
    const [claim] = await call('claim', { task_id: 'feature-1', node_id: nodeId, agent_task_path: taskPath, agent_role: 'avsp_terra_high' });
    const result = path.join(fixture.root, `${nodeId}.json`); await writeFile(result, '{}');
    await call('complete', { task_id: 'feature-1', node_id: nodeId, claim_id: claim.node.claim_id, status: 'succeeded', result });
  }
  const review = async (name, role, verdict, extra = {}) => {
    const taskPath = `/root/${name}`;
    const [claim] = await call('claim', { task_id: 'feature-1', node_id: 'total-review', agent_task_path: taskPath, agent_role: role });
    await call('heartbeat', { task_id: 'feature-1', node_id: 'total-review', claim_id: claim.node.claim_id });
    const [context] = await call('audit-context', { task_id: 'feature-1' });
    const reviewPath = path.join(fixture.root, `${name}.json`);
    await writeFile(reviewPath, JSON.stringify({ auditor_task: taskPath, auditor_role: role, claim_id: claim.node.claim_id, verdict, findings: findingsFor(name, verdict), requirement_coverage: { R1: `${name} coverage` }, workflow_snapshot: context.workflow_snapshot, workspace_fingerprint: context.workspace_fingerprint, scope_and_regression: `${name} scope`, verification_gaps: `${name} gaps`, residual_risk: `${name} risk`, ...extra }));
    await call('record-review', { task_id: 'feature-1', review: reviewPath });
    const result = path.join(fixture.root, `${name}.outcome.json`); await writeFile(result, '{}');
    await call('complete', { task_id: 'feature-1', node_id: 'total-review', claim_id: claim.node.claim_id, status: verdict === 'pass' ? 'succeeded' : 'failed', result });
    return claim.node.claim_id;
  };
  const retry = name => call('retry', { task_id: 'feature-1', node_id: 'total-review', reason: `${name} stopped`, previous_agent_stopped: true });
  await review('max-high-one', 'avsp_sol_high', 'fail'); await retry('max-high-one');
  await review('max-high-two', 'avsp_sol_high', 'fail'); await retry('max-high-two');
  await review('max-xhigh', 'avsp_sol_xhigh', 'fail');
  const [max] = await retry('max-xhigh');
  return { call, review, retry, charter: max.max_review_charter };
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
    await call('record-review', { task_id: 'feature-1', review }); const reviewResult = path.join(fixture.root, 'total-review.json'); await writeFile(reviewResult, '{}'); await call('complete', { task_id: 'feature-1', node_id: 'total-review', claim_id: reviewClaim.node.claim_id, status: 'succeeded', result: reviewResult });
    const legacyState = await readControllerState(fixture.stateDir); legacyState.reviews.at(-1).workflow_snapshot = legacyWorkflowSnapshot(legacyState); await writeControllerState(fixture.stateDir, legacyState);
    let [allowed, code] = await call('close-check', { task_id: 'feature-1' }); assert.equal(code, 0); assert.equal(allowed.close_allowed, true);
    const closedState = await readControllerState(fixture.stateDir); const leasePath = path.join(fixture.workspace, '.codex', 'workflow-controller', 'workspace-lease.json'); const interruptedLease = JSON.parse(await readFile(leasePath, 'utf8'));
    interruptedLease.active_tasks = [{ task_id: 'feature-1', state_path: path.join(fixture.stateDir, 'feature-1.json'), state_dir: fixture.stateDir, state_parent_authority: closedState.workspace_lease.state_parent_authority, acquired_at: closedState.workspace_lease.acquired_at, phase: 'active', workspace_claims: closedState.workspace_claims }]; await writeFile(leasePath, JSON.stringify(interruptedLease));
    [allowed, code] = await call('close-check', { task_id: 'feature-1' }); assert.equal(code, 0); assert.equal(allowed.workspace_lease.self_healed, true); assert.deepEqual(JSON.parse(await readFile(leasePath, 'utf8')).active_tasks, []);
    const postCloseNode = await writeNode(fixture.root, { id: 'post-close', kind: 'implementation' }); await assert.rejects(() => call('add-node', { task_id: 'feature-1', node: postCloseNode }), /DAG is immutable/);
    await writeFile(path.join(fixture.workspace, 'app.txt'), 'after\n'); [allowed, code] = await call('close-check', { task_id: 'feature-1' }); assert.equal(code, 2); assert.ok(allowed.reasons.includes('workspace changed after total review'));
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('requires a recorded pass before a review can succeed and preserves failed or unavailable recovery', async () => {
  for (const [verdict, completionStatus] of [['fail', 'failed'], ['unavailable', 'unavailable']]) {
    const fixture = await setup();
    try {
      const call = (command, parameters) => callForFixture(fixture, command, parameters);
      await call('init', { manifest: fixture.manifest });
      for (const [nodeId, taskPath] of [['implement', '/root/implement'], ['verify', '/root/verify']]) {
        const [claim] = await call('claim', { task_id: 'feature-1', node_id: nodeId, agent_task_path: taskPath, agent_role: 'avsp_terra_high' });
        const result = path.join(fixture.root, `${verdict}-${nodeId}.json`); await writeFile(result, '{}');
        await call('complete', { task_id: 'feature-1', node_id: nodeId, claim_id: claim.node.claim_id, status: 'succeeded', result });
      }
      const [reviewClaim] = await call('claim', { task_id: 'feature-1', node_id: 'total-review', agent_task_path: `/root/${verdict}-review`, agent_role: 'avsp_sol_high' });
      await call('heartbeat', { task_id: 'feature-1', node_id: 'total-review', claim_id: reviewClaim.node.claim_id });
      const [context] = await call('audit-context', { task_id: 'feature-1' });
      const review = path.join(fixture.root, `${verdict}-review.json`);
      await writeFile(review, JSON.stringify({ auditor_task: `/root/${verdict}-review`, auditor_role: 'avsp_sol_high', claim_id: reviewClaim.node.claim_id, verdict, findings: findingsFor(verdict, verdict), requirement_coverage: { R1: `${verdict} evidence` }, workflow_snapshot: context.workflow_snapshot, workspace_fingerprint: context.workspace_fingerprint, scope_and_regression: 'reviewed', verification_gaps: verdict === 'fail' ? 'blocking gap' : 'evidence unavailable', residual_risk: 'not accepted' }));
      await call('record-review', { task_id: 'feature-1', review });
      const result = path.join(fixture.root, `${verdict}-outcome.json`); await writeFile(result, '{}');
      await assert.rejects(() => call('complete', { task_id: 'feature-1', node_id: 'total-review', claim_id: reviewClaim.node.claim_id, status: 'succeeded', result }), /recorded review with verdict pass/);
      assert.equal((await readControllerState(fixture.stateDir)).nodes['total-review'].status, 'running');
      await call('complete', { task_id: 'feature-1', node_id: 'total-review', claim_id: reviewClaim.node.claim_id, status: completionStatus, result });
      assert.equal((await readControllerState(fixture.stateDir)).nodes['total-review'].status, completionStatus);
      const [retried] = await call('retry', { task_id: 'feature-1', node_id: 'total-review', reason: `${verdict} review requires a new attempt`, previous_agent_stopped: true });
      assert.equal(retried.node.status, 'pending');
    } finally { await rm(fixture.root, { recursive: true, force: true }); }
  }
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
    const outcome = await writePendingWorkflowOutcome(fixture.stateDir, 'feature-1', 'total-review', reviewClaim.node.claim_id);
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
    const outcome = await writePendingWorkflowOutcome(fixture.stateDir, 'feature-1', 'total-review', reviewClaim.node.claim_id);
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
    const resultPath = await writePendingWorkflowOutcome(fixture.stateDir, 'feature-1', 'total-review', reviewClaim.node.claim_id);
    const workflow = { state_dir: fixture.stateDir, task_id: 'feature-1', node_id: 'total-review', claim_id: reviewClaim.node.claim_id };
    const authority = JSON.parse(await readFile(resultPath, 'utf8')).workflow_artifact_authority;
    await writeFile(resultPath, JSON.stringify({
      workflow, workflow_artifact_authority: authority,
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
      const result = { workflow, workflow_artifact_authority: authority };
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

test('freezes the DAG and reopens an invalidated pass review when reviewed task state changes', async () => {
  const fixture = await setup();
  try {
    const call = (command, parameters) => callForFixture(fixture, command, parameters);
    const route = (executionOwner, executionRisk = 'protected') => ({ execution_risk: executionRisk, routing_reason: 'bounded task route', execution_owner: executionOwner, integration_owner: '/root', quality_guard: 'targeted verification' });
    await writeFile(fixture.manifest, JSON.stringify({ task_id: 'feature-1', workspace: fixture.workspace, goal: 'Reopen an invalidated terminal review', routing_schema_version: 1, requirements: [{ id: 'R1', text: 'app changes' }], nodes: [{ id: 'implement', kind: 'implementation', ...route('/root/implement') }, { id: 'verify', kind: 'verification', depends_on: ['implement'], ...route('/root/verify') }, { id: 'total-review', kind: 'total_review', agent_type: 'avsp_sol_high', depends_on: ['implement', 'verify'], ...route('/root/total-review', 'read_only') }] }));
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
    let [closeResult, closeCode] = await call('close-check', { task_id: 'feature-1' }); assert.equal(closeCode, 2); assert.ok(closeResult.reasons.includes('task state changed after total review'));
    const [invalidated] = await call('invalidate-gate', { task_id: 'feature-1', reason: 'Task evidence changed before delivery.', replacement_agent_task_path: '/root/review-after-invalidation' });
    assert.equal(invalidated.node.status, 'pending');
    assert.equal(invalidated.node.execution_owner, '/root/review-after-invalidation');
    const [replacement] = await call('claim', { task_id: 'feature-1', node_id: 'total-review', agent_task_path: '/root/review-after-invalidation', agent_role: 'avsp_sol_high' });
    await call('heartbeat', { task_id: 'feature-1', node_id: 'total-review', claim_id: replacement.node.claim_id });
    const [replacementContext] = await call('audit-context', { task_id: 'feature-1' });
    const replacementReview = path.join(fixture.root, 'replacement-review.json');
    await writeFile(replacementReview, JSON.stringify({ auditor_task: '/root/review-after-invalidation', auditor_role: 'avsp_sol_high', claim_id: replacement.node.claim_id, verdict: 'pass', requirement_coverage: { R1: 'verified after invalidation' }, workflow_snapshot: replacementContext.workflow_snapshot, workspace_fingerprint: replacementContext.workspace_fingerprint, scope_and_regression: 'reviewed changed task state', verification_gaps: 'none', residual_risk: 'none' }));
    await call('record-review', { task_id: 'feature-1', review: replacementReview });
    const replacementResult = path.join(fixture.root, 'replacement-result.json'); await writeFile(replacementResult, '{}');
    await call('complete', { task_id: 'feature-1', node_id: 'total-review', claim_id: replacement.node.claim_id, status: 'succeeded', result: replacementResult });
    [closeResult, closeCode] = await call('close-check', { task_id: 'feature-1' }); assert.equal(closeCode, 0); assert.equal(closeResult.close_allowed, true);
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

test('freezes a max review charter, closes it after one protected repair, and fails closed for legacy max state', async () => {
  const fixture = await setup();
  try {
    const call = (command, parameters) => callForFixture(fixture, command, parameters);
    await call('init', { manifest: fixture.manifest });
    for (const [nodeId, taskPath] of [['implement', '/root/implement'], ['verify', '/root/verify']]) {
      const [claim] = await call('claim', { task_id: 'feature-1', node_id: nodeId, agent_task_path: taskPath, agent_role: 'avsp_terra_high' });
      const result = path.join(fixture.root, `${nodeId}.json`); await writeFile(result, '{}');
      await call('complete', { task_id: 'feature-1', node_id: nodeId, claim_id: claim.node.claim_id, status: 'succeeded', result });
    }
    const reviewOnce = async (name, role, verdict = 'fail', completionStatus = verdict === 'fail' ? 'failed' : 'unavailable', extra = {}) => {
      const taskPath = `/root/${name}`;
      const [claim] = await call('claim', { task_id: 'feature-1', node_id: 'total-review', agent_task_path: taskPath, agent_role: role });
      await call('heartbeat', { task_id: 'feature-1', node_id: 'total-review', claim_id: claim.node.claim_id });
      const [context] = await call('audit-context', { task_id: 'feature-1' }); const review = path.join(fixture.root, `${name}.review.json`);
      await writeFile(review, JSON.stringify({ auditor_task: taskPath, auditor_role: role, claim_id: claim.node.claim_id, verdict, findings: findingsFor(name, verdict), requirement_coverage: { R1: `${name} coverage` }, workflow_snapshot: context.workflow_snapshot, workspace_fingerprint: context.workspace_fingerprint, scope_and_regression: `${name} scope`, verification_gaps: `${name} gaps`, residual_risk: `${name} risk`, ...extra }));
      await call('record-review', { task_id: 'feature-1', review });
      const result = path.join(fixture.root, `${name}.outcome.json`); await writeFile(result, '{}');
      await call('complete', { task_id: 'feature-1', node_id: 'total-review', claim_id: claim.node.claim_id, status: completionStatus, result });
    };
    const retryReview = name => call('retry', { task_id: 'feature-1', node_id: 'total-review', reason: `${name} reviewer stopped`, previous_agent_stopped: true });

    await reviewOnce('high-first-fail', 'avsp_sol_high');
    let [retried] = await retryReview('high-first-fail'); assert.equal(retried.node.agent_type, 'avsp_sol_high');
    await reviewOnce('high-second-fail', 'avsp_sol_high');
    [retried] = await retryReview('high-second-fail'); assert.equal(retried.node.agent_type, 'avsp_sol_xhigh');
    await reviewOnce('xhigh-fail', 'avsp_sol_xhigh');
    [retried] = await retryReview('xhigh-fail');
    assert.equal(retried.node.status, 'blocked'); assert.equal(retried.node.agent_type, 'avsp_sol_max');
    assert.deepEqual(retried.max_review_charter.blocking_finding_ids, ['xhigh-fail-blocking']);
    const preMigration = await readControllerState(fixture.stateDir); const frozenCharter = preMigration.max_review_charter;
    delete preMigration.max_review_charter; await writeControllerState(fixture.stateDir, preMigration);
    await assert.rejects(() => retryReview('legacy-max'), /frozen max_review_charter/);
    const migrated = await readControllerState(fixture.stateDir); migrated.max_review_charter = frozenCharter; await writeControllerState(fixture.stateDir, migrated);
    const [repairContext] = await call('audit-context', { task_id: 'feature-1' });
    const repair = path.join(fixture.root, 'max-repair.json');
    await writeFile(repair, JSON.stringify({ source_review_claim_id: retried.max_review_charter.source_review_claim_id, repaired_by: '/root/terra-protected-repair', addressed_findings: [{ finding_id: 'xhigh-fail-blocking', resolution: 'Fixed every frozen blocker.', verification_evidence: 'Targeted regression passes.' }], verification_evidence: 'Protected repair completed and verified.', workspace_fingerprint: repairContext.workspace_fingerprint }));
    await call('record-repair', { task_id: 'feature-1', repair });
    [retried] = await retryReview('max-closure'); assert.equal(retried.node.status, 'pending');
    await reviewOnce('max-closure-pass', 'avsp_sol_max', 'pass', 'succeeded');
    const [closed, closeCode] = await call('close-check', { task_id: 'feature-1' }); assert.equal(closeCode, 0); assert.equal(closed.close_allowed, true);

  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('blocks max closure out-of-charter findings and accepts only evidenced repair regressions', async () => {
  const fixture = await setup();
  try {
    const { call, review, retry, charter } = await establishMaxCharter(fixture);
    const repair = async (sourceClaimId, findingId) => {
      const [context] = await call('audit-context', { task_id: 'feature-1' }); const repairPath = path.join(fixture.root, `${sourceClaimId}.repair.json`);
      const findingIds = context.max_review_charter.blocking_finding_ids;
      await writeFile(repairPath, JSON.stringify({ source_review_claim_id: sourceClaimId, repaired_by: '/root/terra-protected-repair', addressed_findings: findingIds.map(id => ({ finding_id: id, resolution: 'Protected repair.', verification_evidence: 'Targeted regression.' })), verification_evidence: 'Protected repair evidence.', workspace_fingerprint: context.workspace_fingerprint }));
      return call('record-repair', { task_id: 'feature-1', repair: repairPath });
    };
    await repair(charter.source_review_claim_id, 'max-xhigh-blocking');
    await retry('out-of-charter-closure');
    const outOfCharterFinding = { id: 'closure-new-scope', severity: 'blocking', requirement_id: 'R1', summary: 'A new unrelated issue appeared.', evidence: 'Current diff evidence.' };
    await review('max-out-of-charter', 'avsp_sol_max', 'fail', { findings: [outOfCharterFinding] });
    const [closed, closeCode] = await call('close-check', { task_id: 'feature-1' });
    assert.equal(closeCode, 2); assert.ok(closed.reasons.includes('max review charter is scope_decision_required'));
    await assert.rejects(() => retry('out-of-charter-retry'), /scope decision/);

    const second = await setup();
    try {
      const flow = await establishMaxCharter(second); const repairAgain = async (sourceClaimId, findingId) => {
        const [context] = await flow.call('audit-context', { task_id: 'feature-1' }); const repairPath = path.join(second.root, `${sourceClaimId}.repair.json`);
        await writeFile(repairPath, JSON.stringify({ source_review_claim_id: sourceClaimId, repaired_by: '/root/terra-protected-repair', addressed_findings: context.max_review_charter.blocking_finding_ids.map(id => ({ finding_id: id, resolution: 'Protected repair.', verification_evidence: 'Targeted regression.' })), verification_evidence: 'Protected repair evidence.', workspace_fingerprint: context.workspace_fingerprint }));
        return flow.call('record-repair', { task_id: 'feature-1', repair: repairPath });
      };
      await repairAgain(flow.charter.source_review_claim_id, 'max-xhigh-blocking'); await flow.retry('regression-closure');
      const regression = { id: 'repair-regression', severity: 'blocking', requirement_id: 'R1', summary: 'The protected repair regressed R1.', evidence: 'Repair diff and regression output.' };
      await flow.review('max-regression', 'avsp_sol_max', 'fail', { findings: [regression], repair_regressions: [{ finding_id: 'repair-regression', evidence: 'Regression first appears in the protected repair diff and fails R1.' }] });
      const state = await readControllerState(second.stateDir); assert.equal(state.max_review_charter.status, 'repair_required'); assert.ok(state.max_review_charter.blocking_finding_ids.includes('repair-regression'));
      await repairAgain(state.max_review_charter.pending_repair_source_claim_id, 'repair-regression');
      const [pending] = await flow.retry('regression-repaired'); assert.equal(pending.node.status, 'pending');
    } finally { await rm(second.root, { recursive: true, force: true }); }
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('returns an unavailable max closure to ready without consuming its closure attempt', async () => {
  const fixture = await setup();
  try {
    const { call, review, retry, charter } = await establishMaxCharter(fixture);
    const [repairContext] = await call('audit-context', { task_id: 'feature-1' });
    const repairPath = path.join(fixture.root, 'max-unavailable-repair.json');
    await writeFile(repairPath, JSON.stringify({ source_review_claim_id: charter.source_review_claim_id, repaired_by: '/root/terra-protected-repair', addressed_findings: charter.blocking_finding_ids.map(finding_id => ({ finding_id, resolution: 'Protected repair.', verification_evidence: 'Targeted regression.' })), verification_evidence: 'Protected repair evidence.', workspace_fingerprint: repairContext.workspace_fingerprint }));
    await call('record-repair', { task_id: 'feature-1', repair: repairPath });
    await retry('max-unavailable-closure');
    const [claim] = await call('claim', { task_id: 'feature-1', node_id: 'total-review', agent_task_path: '/root/max-unavailable', agent_role: 'avsp_sol_max' });
    await call('heartbeat', { task_id: 'feature-1', node_id: 'total-review', claim_id: claim.node.claim_id });
    const [context] = await call('audit-context', { task_id: 'feature-1' });
    const unavailableReview = path.join(fixture.root, 'max-unavailable.review.json');
    await writeFile(unavailableReview, JSON.stringify({ auditor_task: '/root/max-unavailable', auditor_role: 'avsp_sol_max', claim_id: claim.node.claim_id, verdict: 'unavailable', requirement_coverage: { R1: 'Reviewer became unavailable before closure.' }, workflow_snapshot: context.workflow_snapshot, workspace_fingerprint: context.workspace_fingerprint, scope_and_regression: 'Not completed.', verification_gaps: 'Reviewer unavailable.', residual_risk: 'Closure remains pending.' }));
    await call('record-review', { task_id: 'feature-1', review: unavailableReview });
    const unavailableOutcome = path.join(fixture.root, 'max-unavailable.outcome.json'); await writeFile(unavailableOutcome, '{}');
    await call('complete', { task_id: 'feature-1', node_id: 'total-review', claim_id: claim.node.claim_id, status: 'unavailable', result: unavailableOutcome });
    const afterUnavailable = await readControllerState(fixture.stateDir);
    assert.equal(afterUnavailable.max_review_charter.status, 'closure_ready');
    assert.equal(afterUnavailable.max_review_charter.closure_attempt_count, 0);
    const [retryReady] = await retry('max-unavailable-retry'); assert.equal(retryReady.node.status, 'pending');
    await review('max-unavailable-pass', 'avsp_sol_max', 'pass');
    const [closed, closeCode] = await call('close-check', { task_id: 'feature-1' }); assert.equal(closeCode, 0); assert.equal(closed.close_allowed, true);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('uses v2 assurance gates with frozen verification and Terra-to-Sol escalation', async () => {
  const fixture = await setup();
  try {
    const call = (command, parameters) => callForFixture(fixture, command, parameters);
    const workRoute = { execution_risk: 'protected', routing_reason: 'bounded change', execution_owner: '/root/work', integration_owner: '/root', quality_guard: 'targeted verification' };
    const terraReviewRoute = { execution_risk: 'read_only', routing_reason: 'bounded review gate', execution_owner: '/root/terra-unavailable', integration_owner: '/root', quality_guard: 'review requirements and evidence' };
    await writeFile(fixture.manifest, JSON.stringify({ task_id: 'feature-1', workspace: fixture.workspace, goal: 'Use the assurance state machine', routing_schema_version: 2, assurance_level: 'terra', assurance_assessment: terraAssuranceAssessment, requirements: [{ id: 'R1', text: 'close only with the selected quality gate' }], nodes: [{ id: 'work', kind: 'implementation', ...workRoute }, { id: 'review-gate', kind: 'quality_review', depends_on: ['work'], ...terraReviewRoute }] }));
    await call('init', { manifest: fixture.manifest });
    const [work] = await call('claim', { task_id: 'feature-1', node_id: 'work', agent_task_path: '/root/work', agent_role: 'avsp_terra_high' });
    const workResult = path.join(fixture.root, 'v2-work.json'); await writeFile(workResult, JSON.stringify({ completed: true }));
    await call('complete', { task_id: 'feature-1', node_id: 'work', claim_id: work.node.claim_id, status: 'succeeded', result: workResult });

    const reviewOnce = async (name, role, verdict, status) => {
      const taskPath = `/root/${name}`;
      const [claim] = await call('claim', { task_id: 'feature-1', node_id: 'review-gate', agent_task_path: taskPath, agent_role: role });
      await call('heartbeat', { task_id: 'feature-1', node_id: 'review-gate', claim_id: claim.node.claim_id });
      const [context] = await call('audit-context', { task_id: 'feature-1' });
      const reviewPath = path.join(fixture.root, `${name}.json`);
      await writeFile(reviewPath, JSON.stringify({ auditor_task: taskPath, auditor_role: role, claim_id: claim.node.claim_id, verdict, findings: findingsFor(name, verdict), requirement_coverage: { R1: `${name} coverage` }, workflow_snapshot: context.workflow_snapshot, workspace_fingerprint: context.workspace_fingerprint, scope_and_regression: `${name} scope`, verification_gaps: `${name} gaps`, residual_risk: `${name} risk` }));
      await call('record-review', { task_id: 'feature-1', review: reviewPath });
      const resultPath = path.join(fixture.root, `${name}.outcome.json`); await writeFile(resultPath, JSON.stringify({}));
      await call('complete', { task_id: 'feature-1', node_id: 'review-gate', claim_id: claim.node.claim_id, status, result: resultPath });
      return { ...context, claim_id: claim.node.claim_id };
    };
    const retryReview = (name, replacement) => call('retry', { task_id: 'feature-1', node_id: 'review-gate', reason: `${name} stopped`, replacement_agent_task_path: replacement, previous_agent_stopped: true });

    await reviewOnce('terra-unavailable', 'avsp_terra_xhigh', 'unavailable', 'unavailable');
    let [retried] = await retryReview('terra-unavailable', '/root/terra-first-fail');
    assert.equal(retried.node.kind, 'quality_review');
    assert.equal(retried.node.agent_type, 'avsp_terra_xhigh');

    const firstTerraFailure = await reviewOnce('terra-first-fail', 'avsp_terra_xhigh', 'fail', 'failed');
    await assert.rejects(() => retryReview('terra-first-fail', '/root/terra-second-fail'), /requires a recorded repair/);
    const [repairContext] = await call('audit-context', { task_id: 'feature-1' });
    const repairPath = path.join(fixture.root, 'terra-first-repair.json');
    await writeFile(repairPath, JSON.stringify({ source_review_claim_id: firstTerraFailure.claim_id, repaired_by: '/root/repair', addressed_findings: [], verification_evidence: 'The blocking issue is not yet mapped.', workspace_fingerprint: repairContext.workspace_fingerprint }));
    await assert.rejects(() => call('record-repair', { task_id: 'feature-1', repair: repairPath }), /resolve every blocking finding/);
    await writeFile(repairPath, JSON.stringify({ source_review_claim_id: firstTerraFailure.claim_id, repaired_by: '/root/repair', addressed_findings: [{ finding_id: 'terra-first-fail-blocking', resolution: 'Supplemented the missing evidence.', verification_evidence: 'Checked the added evidence against R1.' }], verification_evidence: 'Added and checked the missing evidence without changing workspace files.', workspace_fingerprint: repairContext.workspace_fingerprint }));
    const [repairRecord] = await call('record-repair', { task_id: 'feature-1', repair: repairPath });
    assert.equal(repairRecord.repair_record.workspace_changed, false);
    [retried] = await retryReview('terra-first-fail', '/root/terra-second-fail');
    assert.equal(retried.node.kind, 'quality_review');

    const secondTerraContext = await reviewOnce('terra-second-fail', 'avsp_terra_xhigh', 'fail', 'failed');
    [retried] = await retryReview('terra-second-fail', '/root/sol-after-terra');
    assert.equal(retried.node.kind, 'total_review');
    assert.equal(retried.node.agent_type, 'avsp_sol_high');
    assert.equal(retried.assurance_level, 'terra');
    assert.equal(retried.effective_assurance_level, 'sol');
    const stateAfterEscalation = await readControllerState(fixture.stateDir);
    assert.equal(stateAfterEscalation.assurance_level, 'terra');
    assert.ok(stateAfterEscalation.events.some(event => event.type === 'terra_review_escalated'));

    const [sol] = await call('claim', { task_id: 'feature-1', node_id: 'review-gate', agent_task_path: '/root/sol-after-terra', agent_role: 'avsp_sol_high' });
    await call('heartbeat', { task_id: 'feature-1', node_id: 'review-gate', claim_id: sol.node.claim_id });
    const [solContext] = await call('audit-context', { task_id: 'feature-1' });
    assert.equal(solContext.assurance_level, 'terra');
    assert.equal(solContext.effective_assurance_level, 'sol');
    assert.deepEqual(solContext.workspace_fingerprint, secondTerraContext.workspace_fingerprint);
    const solReview = path.join(fixture.root, 'sol-after-terra.json');
    await writeFile(solReview, JSON.stringify({ auditor_task: '/root/sol-after-terra', auditor_role: 'avsp_sol_high', claim_id: sol.node.claim_id, verdict: 'pass', requirement_coverage: { R1: 'Sol accepted the complete frozen scope' }, workflow_snapshot: solContext.workflow_snapshot, workspace_fingerprint: solContext.workspace_fingerprint, scope_and_regression: 'Sol reviewed the entire scope after Terra escalation', verification_gaps: 'none', residual_risk: 'accepted' }));
    await call('record-review', { task_id: 'feature-1', review: solReview });
    const solResult = path.join(fixture.root, 'sol-after-terra.outcome.json'); await writeFile(solResult, JSON.stringify({}));
    await call('complete', { task_id: 'feature-1', node_id: 'review-gate', claim_id: sol.node.claim_id, status: 'succeeded', result: solResult });
    const [closed, code] = await call('close-check', { task_id: 'feature-1' });
    assert.equal(code, 0); assert.equal(closed.close_allowed, true);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('v3 review protocol starts from a selected stage, requires repairs before escalation, and terminates a failed max closure', async () => {
  const fixture = await setup();
  try {
    const call = (command, parameters) => callForFixture(fixture, command, parameters);
    const workRoute = { execution_risk: 'protected', routing_reason: 'bounded change', execution_owner: '/root/v3-work', integration_owner: '/root', quality_guard: 'targeted verification' };
    const reviewRoute = { execution_risk: 'read_only', routing_reason: 'global review gate', execution_owner: '/root/v3-high', integration_owner: '/root', quality_guard: 'review requirements and evidence' };
    await writeFile(fixture.manifest, JSON.stringify({ task_id: 'feature-1', workspace: fixture.workspace, goal: 'Run the bounded review protocol', routing_schema_version: 3, assurance_level: 'sol', assurance_assessment: solAssuranceAssessment, review_entry_stage: 'sol_high', review_context: v3ReviewContext, requirements: [{ id: 'R1', text: 'close only when the protocol gate passes' }], nodes: [{ id: 'work', kind: 'implementation', ...workRoute }, { id: 'review-gate', kind: 'total_review', depends_on: ['work'], ...reviewRoute }] }));
    await call('init', { manifest: fixture.manifest });
    const [work] = await call('claim', { task_id: 'feature-1', node_id: 'work', agent_task_path: '/root/v3-work', agent_role: 'avsp_terra_high' });
    const workResult = path.join(fixture.root, 'v3-work.json'); await writeFile(workResult, JSON.stringify({}));
    await call('complete', { task_id: 'feature-1', node_id: 'work', claim_id: work.node.claim_id, status: 'succeeded', result: workResult });

    const reviewOnce = async (name, role, verdict = 'fail') => {
      const taskPath = `/root/${name}`;
      const [claim] = await call('claim', { task_id: 'feature-1', node_id: 'review-gate', agent_task_path: taskPath, agent_role: role });
      const claimId = claim.claim_id ?? claim.node.claim_id;
      await call('heartbeat', { task_id: 'feature-1', node_id: 'review-gate', claim_id: claimId });
      const [context] = await call('audit-context', { task_id: 'feature-1' }); const reviewPath = path.join(fixture.root, `${name}.review.json`);
      await writeFile(reviewPath, JSON.stringify(v3ReviewPayload({ taskPath, role, claimId, verdict, context, name })));
      await call('record-review', { task_id: 'feature-1', review: reviewPath });
      const outcome = path.join(fixture.root, `${name}.outcome.json`); await writeFile(outcome, JSON.stringify({}));
      await call('complete', { task_id: 'feature-1', node_id: 'review-gate', claim_id: claimId, status: verdict === 'pass' ? 'succeeded' : 'failed', result: outcome });
      return { claimId, context };
    };
    const recordRepair = async (sourceClaimId, findingId) => {
      const [context] = await call('audit-context', { task_id: 'feature-1' }); const repair = path.join(fixture.root, `${sourceClaimId}.repair.json`);
      await writeFile(repair, JSON.stringify({ source_review_claim_id: sourceClaimId, repaired_by: '/root/v3-repair', addressed_findings: [{ finding_id: findingId, resolution: 'Fixed the recorded blocker.', verification_evidence: 'Targeted verification passes.' }], verification_evidence: 'Repair verified.', workspace_fingerprint: context.workspace_fingerprint }));
      await call('record-repair', { task_id: 'feature-1', repair });
    };
    const retry = replacement => call('retry', { task_id: 'feature-1', node_id: 'review-gate', reason: 'previous reviewer stopped', replacement_agent_task_path: replacement, previous_agent_stopped: true });

    const high = await reviewOnce('v3-high', 'avsp_sol_high');
    await assert.rejects(() => retry('/root/v3-xhigh'), /requires a recorded repair/);
    await recordRepair(high.claimId, 'v3-high-blocking');
    let [escalated] = await retry('/root/v3-xhigh'); assert.equal(escalated.node.agent_type, 'avsp_sol_xhigh');
    const xhigh = await reviewOnce('v3-xhigh', 'avsp_sol_xhigh');
    await assert.rejects(() => retry('/root/v3-max-initial'), /requires a recorded repair/);
    await recordRepair(xhigh.claimId, 'v3-xhigh-blocking');
    [escalated] = await retry('/root/v3-max-initial'); assert.equal(escalated.node.agent_type, 'avsp_sol_max'); assert.equal(escalated.node.review_gate.stage, 'sol_max_initial');
    const maxInitial = await reviewOnce('v3-max-initial', 'avsp_sol_max');
    [escalated] = await retry('/root/v3-max-closure'); assert.equal(escalated.node.status, 'blocked'); assert.equal(escalated.node.review_gate.stage, 'sol_max_closure');
    await recordRepair(maxInitial.claimId, 'v3-max-initial-blocking');
    [escalated] = await retry('/root/v3-max-closure'); assert.equal(escalated.node.status, 'pending');
    await reviewOnce('v3-max-closure', 'avsp_sol_max');
    const state = await readControllerState(fixture.stateDir); assert.equal(state.nodes['review-gate'].status, 'blocked'); assert.equal(state.max_review_charter.status, 'scope_decision_required');
    await assert.rejects(() => retry('/root/v3-forbidden-retry'), /scope decision/);
    const [closed, closeCode] = await call('close-check', { task_id: 'feature-1' }); assert.equal(closeCode, 2); assert.ok(closed.reasons.includes('max review charter is scope_decision_required'));
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('v3 passed Sol/max closure can be invalidated and reopened for one new independent closure', async () => {
  const fixture = await setup();
  try {
    const call = (command, parameters) => callForFixture(fixture, command, parameters);
    const workRoute = { execution_risk: 'protected', routing_reason: 'bounded change', execution_owner: '/root/v3-max-reopen-work', integration_owner: '/root', quality_guard: 'targeted verification' };
    const reviewRoute = { execution_risk: 'read_only', routing_reason: 'global review gate', execution_owner: '/root/v3-max-reopen-xhigh', integration_owner: '/root', quality_guard: 'review requirements and evidence' };
    await writeFile(fixture.manifest, JSON.stringify({ task_id: 'feature-1', workspace: fixture.workspace, goal: 'Reopen an invalidated max closure', routing_schema_version: 3, assurance_level: 'sol', assurance_assessment: solAssuranceAssessment, review_entry_stage: 'sol_xhigh', review_context: v3ReviewContext, requirements: [{ id: 'R1', text: 'max closure is reopened after a material change' }], nodes: [{ id: 'work', kind: 'implementation', ...workRoute }, { id: 'review-gate', kind: 'total_review', depends_on: ['work'], ...reviewRoute }] }));
    await call('init', { manifest: fixture.manifest });
    const [work] = await call('claim', { task_id: 'feature-1', node_id: 'work', agent_task_path: '/root/v3-max-reopen-work', agent_role: 'avsp_terra_high' }); const workResult = path.join(fixture.root, 'v3-max-reopen-work.json'); await writeFile(workResult, JSON.stringify({})); await call('complete', { task_id: 'feature-1', node_id: 'work', claim_id: work.node.claim_id, status: 'succeeded', result: workResult });
    const reviewOnce = async (name, role, verdict) => {
      const taskPath = `/root/${name}`; const [claim] = await call('claim', { task_id: 'feature-1', node_id: 'review-gate', agent_task_path: taskPath, agent_role: role }); const claimId = claim.claim_id ?? claim.node.claim_id;
      await call('heartbeat', { task_id: 'feature-1', node_id: 'review-gate', claim_id: claimId }); const [context] = await call('audit-context', { task_id: 'feature-1' }); const review = path.join(fixture.root, `${name}.json`); await writeFile(review, JSON.stringify(v3ReviewPayload({ taskPath, role, claimId, verdict, context, name }))); await call('record-review', { task_id: 'feature-1', review }); const outcome = path.join(fixture.root, `${name}.outcome.json`); await writeFile(outcome, JSON.stringify({})); await call('complete', { task_id: 'feature-1', node_id: 'review-gate', claim_id: claimId, status: verdict === 'pass' ? 'succeeded' : 'failed', result: outcome }); return claimId;
    };
    const recordRepair = async (sourceReviewClaimId, findingId) => { const [context] = await call('audit-context', { task_id: 'feature-1' }); const repair = path.join(fixture.root, `${sourceReviewClaimId}.repair.json`); await writeFile(repair, JSON.stringify({ source_review_claim_id: sourceReviewClaimId, repaired_by: '/root/v3-max-reopen-repair', addressed_findings: [{ finding_id: findingId, resolution: 'Fixed the blocking finding.', verification_evidence: 'Targeted verification passes.' }], verification_evidence: 'Repair verified.', workspace_fingerprint: context.workspace_fingerprint })); await call('record-repair', { task_id: 'feature-1', repair }); };
    const retry = replacement => call('retry', { task_id: 'feature-1', node_id: 'review-gate', reason: 'Advance the bounded protocol after the prior reviewer stopped.', replacement_agent_task_path: replacement, previous_agent_stopped: true });
    const xhighClaimId = await reviewOnce('v3-max-reopen-xhigh', 'avsp_sol_xhigh', 'fail'); await recordRepair(xhighClaimId, 'v3-max-reopen-xhigh-blocking'); await retry('/root/v3-max-reopen-initial');
    const maxInitialClaimId = await reviewOnce('v3-max-reopen-initial', 'avsp_sol_max', 'fail'); await retry('/root/v3-max-reopen-closure'); await recordRepair(maxInitialClaimId, 'v3-max-reopen-initial-blocking'); await retry('/root/v3-max-reopen-closure');
    await reviewOnce('v3-max-reopen-closure', 'avsp_sol_max', 'pass');
    let state = await readControllerState(fixture.stateDir); assert.equal(state.nodes['review-gate'].status, 'succeeded'); assert.equal(state.max_review_charter.status, 'closure_passed'); assert.equal(state.max_review_charter.closure_attempt_count, 1);
    state.nodes.work.result = { changed_after_max_closure: true }; await writeControllerState(fixture.stateDir, state);
    const [closeResult, closeCode] = await call('close-check', { task_id: 'feature-1' }); assert.equal(closeCode, 2); assert.ok(closeResult.reasons.includes('task state changed after total review'));
    const [invalidated] = await call('invalidate-gate', { task_id: 'feature-1', reason: 'The work result changed after the max closure pass.', replacement_agent_task_path: '/root/v3-max-reopen-replacement' });
    assert.equal(invalidated.node.status, 'pending'); state = await readControllerState(fixture.stateDir); assert.equal(state.max_review_charter.status, 'closure_ready'); assert.equal(state.max_review_charter.closure_attempt_count, 0);
    const [replacement] = await call('claim', { task_id: 'feature-1', node_id: 'review-gate', agent_task_path: '/root/v3-max-reopen-replacement', agent_role: 'avsp_sol_max' }); assert.equal(replacement.node.status, 'running');
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('v3 Terra cohort requires two blind lanes and one bounded cross-questioning round', async () => {
  const fixture = await setup();
  try {
    const call = (command, parameters) => callForFixture(fixture, command, parameters);
    const workRoute = { execution_risk: 'protected', routing_reason: 'bounded change', execution_owner: '/root/cohort-work', integration_owner: '/root', quality_guard: 'targeted verification' };
    const reviewRoute = { execution_risk: 'read_only', routing_reason: 'parallel cross-review gate', execution_owner: '/root/cohort-coverage-blind', integration_owner: '/root', quality_guard: 'review requirements and evidence' };
    await writeFile(fixture.manifest, JSON.stringify({ task_id: 'feature-1', workspace: fixture.workspace, goal: 'Run a Terra cross-review cohort', routing_schema_version: 3, assurance_level: 'terra', assurance_assessment: terraAssuranceAssessment, review_entry_stage: 'terra_cohort', review_context: v3ReviewContext, requirements: [{ id: 'R1', text: 'cross-review must be independently evidenced' }], nodes: [{ id: 'work', kind: 'implementation', ...workRoute }, { id: 'review-gate', kind: 'quality_review', depends_on: ['work'], ...reviewRoute }] }));
    await call('init', { manifest: fixture.manifest });
    const [work] = await call('claim', { task_id: 'feature-1', node_id: 'work', agent_task_path: '/root/cohort-work', agent_role: 'avsp_terra_high' }); const workResult = path.join(fixture.root, 'cohort-work.json'); await writeFile(workResult, JSON.stringify({})); await call('complete', { task_id: 'feature-1', node_id: 'work', claim_id: work.node.claim_id, status: 'succeeded', result: workResult });
    const runLane = async (slot, name, phase, target = null) => {
      const taskPath = `/root/${name}`; const [claim] = await call('claim', { task_id: 'feature-1', node_id: 'review-gate', reviewer_slot: slot, agent_task_path: taskPath, agent_role: 'avsp_terra_xhigh' }); const claimId = claim.claim_id ?? claim.node.claim_id;
      await call('heartbeat', { task_id: 'feature-1', node_id: 'review-gate', claim_id: claimId }); const [context] = await call('audit-context', { task_id: 'feature-1' }); const reviewPath = path.join(fixture.root, `${name}.json`);
      assert.equal(context.reviews.filter(review => review.review_phase === phase).length, 0);
      if (phase === 'cross') assert.equal(context.reviews.filter(review => review.review_phase === 'blind').length, 2);
      await writeFile(reviewPath, JSON.stringify(v3ReviewPayload({ taskPath, role: 'avsp_terra_xhigh', claimId, verdict: 'pass', context, name, extra: phase === 'cross' ? { challenge_targets: [target] } : {} })));
      await call('record-review', { task_id: 'feature-1', review: reviewPath });
      const [hiddenContext] = await call('audit-context', { task_id: 'feature-1' }); const [hiddenStatus] = await call('status', { task_id: 'feature-1' });
      assert.equal(hiddenContext.reviews.filter(review => review.review_phase === phase).length, 0);
      assert.equal(hiddenStatus.reviews.filter(review => review.review_phase === phase).length, 0);
      if (phase === 'cross') assert.equal(hiddenContext.reviews.filter(review => review.review_phase === 'blind').length, 2);
      const outcome = path.join(fixture.root, `${name}.outcome.json`); await writeFile(outcome, JSON.stringify({})); await call('complete', { task_id: 'feature-1', node_id: 'review-gate', claim_id: claimId, status: 'succeeded', result: outcome }); return claimId;
    };
    const coverageBlind = await runLane('coverage', 'cohort-coverage-blind', 'blind'); const adversarialBlind = await runLane('adversarial', 'cohort-adversarial-blind', 'blind');
    const coverageCross = await runLane('coverage', 'cohort-coverage-cross', 'cross', adversarialBlind); await runLane('adversarial', 'cohort-adversarial-cross', 'cross', coverageBlind);
    const state = await readControllerState(fixture.stateDir); assert.equal(state.nodes['review-gate'].status, 'succeeded'); assert.equal(state.nodes['review-gate'].review_gate.cohort.phase, 'passed'); assert.equal(state.nodes['review-gate'].review_gate.cohort.aggregate.verdict, 'pass'); assert.equal(coverageCross.length > 0, true);
    const priorRound = state.nodes['review-gate'].review_gate.cohort.round_id;
    state.nodes.work.result = { changed_after_cohort_pass: true }; await writeControllerState(fixture.stateDir, state);
    const [closeResult, closeCode] = await call('close-check', { task_id: 'feature-1' }); assert.equal(closeCode, 2); assert.ok(closeResult.reasons.includes('task state changed after Terra cohort cross-review'));
    const [invalidated] = await call('invalidate-gate', { task_id: 'feature-1', reason: 'Material task evidence changed after the cohort pass.', reviewer_slot: 'adversarial', replacement_agent_task_path: '/root/cohort-reopened-adversarial' });
    assert.equal(invalidated.node.status, 'pending'); assert.equal(invalidated.node.review_gate.cohort.phase, 'blind'); assert.notEqual(invalidated.node.review_gate.cohort.round_id, priorRound);
    await assert.rejects(() => call('claim', { task_id: 'feature-1', node_id: 'review-gate', reviewer_slot: 'adversarial', agent_task_path: '/root/not-reserved', agent_role: 'avsp_terra_xhigh' }), /reserved for a replacement reviewer/);
    const [reopened] = await call('claim', { task_id: 'feature-1', node_id: 'review-gate', reviewer_slot: 'adversarial', agent_task_path: '/root/cohort-reopened-adversarial', agent_role: 'avsp_terra_xhigh' });
    assert.equal(reopened.reviewer_slot, 'adversarial');
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('v3 Terra cohort accepts parallel history snapshots and preserves an unavailable lane budget on retry', async () => {
  const fixture = await setup();
  try {
    const call = (command, parameters) => callForFixture(fixture, command, parameters);
    const workRoute = { execution_risk: 'protected', routing_reason: 'bounded change', execution_owner: '/root/cohort-retry-work', integration_owner: '/root', quality_guard: 'targeted verification' };
    const reviewRoute = { execution_risk: 'read_only', routing_reason: 'parallel cross-review gate', execution_owner: '/root/cohort-retry-coverage', integration_owner: '/root', quality_guard: 'review requirements and evidence' };
    await writeFile(fixture.manifest, JSON.stringify({ task_id: 'feature-1', workspace: fixture.workspace, goal: 'Preserve bounded cohort retries', routing_schema_version: 3, assurance_level: 'terra', assurance_assessment: terraAssuranceAssessment, review_entry_stage: 'terra_cohort', review_context: v3ReviewContext, requirements: [{ id: 'R1', text: 'parallel review history remains coherent' }], nodes: [{ id: 'work', kind: 'implementation', ...workRoute }, { id: 'review-gate', kind: 'quality_review', depends_on: ['work'], ...reviewRoute }] }));
    await call('init', { manifest: fixture.manifest });
    const [work] = await call('claim', { task_id: 'feature-1', node_id: 'work', agent_task_path: '/root/cohort-retry-work', agent_role: 'avsp_terra_high' }); const workResult = path.join(fixture.root, 'cohort-retry-work.json'); await writeFile(workResult, JSON.stringify({})); await call('complete', { task_id: 'feature-1', node_id: 'work', claim_id: work.node.claim_id, status: 'succeeded', result: workResult });
    const [coverage] = await call('claim', { task_id: 'feature-1', node_id: 'review-gate', reviewer_slot: 'coverage', agent_task_path: '/root/cohort-retry-coverage', agent_role: 'avsp_terra_xhigh' });
    const [adversarial] = await call('claim', { task_id: 'feature-1', node_id: 'review-gate', reviewer_slot: 'adversarial', agent_task_path: '/root/cohort-retry-adversarial', agent_role: 'avsp_terra_xhigh' });
    await call('heartbeat', { task_id: 'feature-1', node_id: 'review-gate', claim_id: coverage.claim_id }); await call('heartbeat', { task_id: 'feature-1', node_id: 'review-gate', claim_id: adversarial.claim_id });
    const [sharedContext] = await call('audit-context', { task_id: 'feature-1' });
    for (const [name, taskPath, claimId, verdict] of [['cohort-retry-coverage', '/root/cohort-retry-coverage', coverage.claim_id, 'unavailable'], ['cohort-retry-adversarial', '/root/cohort-retry-adversarial', adversarial.claim_id, 'pass']]) {
      const reviewPath = path.join(fixture.root, `${name}.json`); await writeFile(reviewPath, JSON.stringify(v3ReviewPayload({ taskPath, role: 'avsp_terra_xhigh', claimId, verdict, context: sharedContext, name })));
      await call('record-review', { task_id: 'feature-1', review: reviewPath }); const outcome = path.join(fixture.root, `${name}.outcome.json`); await writeFile(outcome, JSON.stringify({})); await call('complete', { task_id: 'feature-1', node_id: 'review-gate', claim_id: claimId, status: verdict === 'pass' ? 'succeeded' : 'unavailable', result: outcome });
    }
    let state = await readControllerState(fixture.stateDir); assert.equal(state.nodes['review-gate'].status, 'unavailable'); assert.equal(state.nodes['review-gate'].review_gate.cohort.lanes.coverage.unavailable_attempts, 1); assert.equal(state.nodes['review-gate'].review_gate.cohort.lanes.coverage.attempt, 1);
    await call('retry', { task_id: 'feature-1', node_id: 'review-gate', reviewer_slot: 'coverage', reason: 'The first coverage reviewer was unavailable.', replacement_agent_task_path: '/root/cohort-retry-coverage-replacement', previous_agent_stopped: true });
    await assert.rejects(() => call('claim', { task_id: 'feature-1', node_id: 'review-gate', reviewer_slot: 'coverage', agent_task_path: '/root/cohort-retry-other', agent_role: 'avsp_terra_xhigh' }), /reserved for a replacement reviewer/);
    const [replacement] = await call('claim', { task_id: 'feature-1', node_id: 'review-gate', reviewer_slot: 'coverage', agent_task_path: '/root/cohort-retry-coverage-replacement', agent_role: 'avsp_terra_xhigh' });
    state = await readControllerState(fixture.stateDir); assert.equal(state.nodes['review-gate'].review_gate.cohort.lanes.coverage.unavailable_attempts, 1); assert.equal(replacement.node.review_gate.cohort.lanes.coverage.attempt, 2);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('v3 Terra cohort stale lane requeue reserves its replacement and returns recovery evidence', async () => {
  const fixture = await setup();
  try {
    const call = (command, parameters) => callForFixture(fixture, command, parameters);
    const workRoute = { execution_risk: 'protected', routing_reason: 'bounded change', execution_owner: '/root/cohort-stale-work', integration_owner: '/root', quality_guard: 'targeted verification' };
    const reviewRoute = { execution_risk: 'read_only', routing_reason: 'parallel cross-review gate', execution_owner: '/root/cohort-stale-coverage', integration_owner: '/root', quality_guard: 'review requirements and evidence' };
    await writeFile(fixture.manifest, JSON.stringify({ task_id: 'feature-1', workspace: fixture.workspace, goal: 'Recover a stale cohort lane', routing_schema_version: 3, assurance_level: 'terra', assurance_assessment: terraAssuranceAssessment, review_entry_stage: 'terra_cohort', review_context: v3ReviewContext, requirements: [{ id: 'R1', text: 'stale parallel reviews remain recoverable' }], nodes: [{ id: 'work', kind: 'implementation', ...workRoute }, { id: 'review-gate', kind: 'quality_review', depends_on: ['work'], ...reviewRoute }] }));
    await call('init', { manifest: fixture.manifest });
    const [work] = await call('claim', { task_id: 'feature-1', node_id: 'work', agent_task_path: '/root/cohort-stale-work', agent_role: 'avsp_terra_high' }); const workResult = path.join(fixture.root, 'cohort-stale-work.json'); await writeFile(workResult, JSON.stringify({})); await call('complete', { task_id: 'feature-1', node_id: 'work', claim_id: work.node.claim_id, status: 'succeeded', result: workResult });
    const [coverage] = await call('claim', { task_id: 'feature-1', node_id: 'review-gate', reviewer_slot: 'coverage', agent_task_path: '/root/cohort-stale-coverage', agent_role: 'avsp_terra_xhigh', lease_duration_sec: 1 }); await call('heartbeat', { task_id: 'feature-1', node_id: 'review-gate', claim_id: coverage.claim_id });
    const state = await readControllerState(fixture.stateDir); state.nodes['review-gate'].review_gate.cohort.lanes.coverage.heartbeat_at = '1970-01-01T00:00:00.000Z'; await writeControllerState(fixture.stateDir, state);
    const [requeued] = await call('requeue-stale', { task_id: 'feature-1', node_id: 'review-gate', reviewer_slot: 'coverage', claim_id: coverage.claim_id, reason: 'Coverage reviewer is confirmed stopped.', replacement_agent_task_path: '/root/cohort-stale-replacement', previous_agent_stopped: true });
    assert.equal(requeued.recovery_package.previous_attempt.claim_id, coverage.claim_id); assert.equal(requeued.node.review_gate.cohort.lanes.coverage.reserved_agent_task_path, '/root/cohort-stale-replacement');
    const [replacement] = await call('claim', { task_id: 'feature-1', node_id: 'review-gate', reviewer_slot: 'coverage', agent_task_path: '/root/cohort-stale-replacement', agent_role: 'avsp_terra_xhigh' }); assert.equal(replacement.node.review_gate.cohort.lanes.coverage.attempt, 2);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('rejects workflow completion after the persisted review directory identity is replaced', async () => {
  const fixture = await setup();
  try {
    const call = (command, parameters) => callForFixture(fixture, command, parameters);
    await call('init', { manifest: fixture.manifest });
    for (const [nodeId, taskPath] of [['implement', '/root/implement'], ['verify', '/root/verify']]) {
      const [claim] = await call('claim', { task_id: 'feature-1', node_id: nodeId, agent_task_path: taskPath, agent_role: 'avsp_terra_high' });
      const result = path.join(fixture.root, `${nodeId}-authority.json`); await writeFile(result, '{}'); await call('complete', { task_id: 'feature-1', node_id: nodeId, claim_id: claim.node.claim_id, status: 'succeeded', result });
    }
    const [reviewClaim] = await call('claim', { task_id: 'feature-1', node_id: 'total-review', agent_task_path: '/root/authority-review', agent_role: 'avsp_sol_high' });
    await call('heartbeat', { task_id: 'feature-1', node_id: 'total-review', claim_id: reviewClaim.node.claim_id });
    const [context] = await call('audit-context', { task_id: 'feature-1' }); const review = path.join(fixture.root, 'authority-review.json');
    await writeFile(review, JSON.stringify({ auditor_task: '/root/authority-review', auditor_role: 'avsp_sol_high', claim_id: reviewClaim.node.claim_id, verdict: 'pass', requirement_coverage: { R1: 'verified' }, workflow_snapshot: context.workflow_snapshot, workspace_fingerprint: context.workspace_fingerprint, scope_and_regression: 'none', verification_gaps: 'none', residual_risk: 'none' }));
    await call('record-review', { task_id: 'feature-1', review });
    const outcome = await writePendingWorkflowOutcome(fixture.stateDir, 'feature-1', 'total-review', reviewClaim.node.claim_id); const pending = await readFile(outcome, 'utf8');
    const claimDirectory = path.dirname(outcome); const displaced = `${claimDirectory}-displaced`; await rename(claimDirectory, displaced); await mkdir(claimDirectory); await writeFile(outcome, pending);
    await assert.rejects(() => call('complete', { task_id: 'feature-1', node_id: 'total-review', claim_id: reviewClaim.node.claim_id, status: 'succeeded', result: outcome }), /artifact directory identity changed|authority/);
    assert.equal((await readControllerState(fixture.stateDir)).nodes['total-review'].status, 'running');
    assert.equal(JSON.parse(await readFile(outcome, 'utf8')).workflow_completion.state, 'pending');
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('rejects a workflow outcome path that is replaced by a file link', async t => {
  const fixture = await setup();
  try {
    await writeFile(fixture.manifest, JSON.stringify({ task_id: 'feature-1', workspace: fixture.workspace, goal: 'bind the exact outcome file', requirements: [{ id: 'R1', text: 'outcome reads are identity-stable' }], nodes: [{ id: 'total-review', kind: 'total_review', agent_type: 'avsp_sol_high', depends_on: [] }] }));
    const call = (command, parameters) => callForFixture(fixture, command, parameters);
    await call('init', { manifest: fixture.manifest });
    const [reviewClaim] = await call('claim', { task_id: 'feature-1', node_id: 'total-review', agent_task_path: '/root/file-link-review', agent_role: 'avsp_sol_high' });
    await call('heartbeat', { task_id: 'feature-1', node_id: 'total-review', claim_id: reviewClaim.node.claim_id });
    const [context] = await call('audit-context', { task_id: 'feature-1' });
    const review = path.join(fixture.root, 'file-link-review.json');
    await writeFile(review, JSON.stringify({ auditor_task: '/root/file-link-review', auditor_role: 'avsp_sol_high', claim_id: reviewClaim.node.claim_id, verdict: 'pass', requirement_coverage: { R1: 'verified' }, workflow_snapshot: context.workflow_snapshot, workspace_fingerprint: context.workspace_fingerprint, scope_and_regression: 'none', verification_gaps: 'none', residual_risk: 'none' }));
    await call('record-review', { task_id: 'feature-1', review });
    const outcome = await writePendingWorkflowOutcome(fixture.stateDir, 'feature-1', 'total-review', reviewClaim.node.claim_id);
    const target = `${outcome}.target`; await rename(outcome, target);
    try { await fsPromises.symlink(target, outcome, 'file'); }
    catch (error) {
      if (['EPERM', 'EACCES', 'UNKNOWN'].includes(error.code)) return t.skip(`file symlink unavailable: ${error.code}`);
      throw error;
    }
    await assert.rejects(() => call('complete', { task_id: 'feature-1', node_id: 'total-review', claim_id: reviewClaim.node.claim_id, status: 'succeeded', result: outcome }), /not a regular file|changed after it was read/);
    assert.equal((await readControllerState(fixture.stateDir)).nodes['total-review'].status, 'running');
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('raises only the unique terminal assurance gate before review starts', async () => {
  const fixture = await setup();
  try {
    const call = (command, parameters) => callForFixture(fixture, command, parameters);
    const workRoute = { execution_risk: 'protected', routing_reason: 'bounded change', execution_owner: '/root/work', integration_owner: '/root', quality_guard: 'targeted verification' };
    await writeFile(fixture.manifest, JSON.stringify({ task_id: 'feature-1', workspace: fixture.workspace, goal: 'Raise assurance when execution reveals material risk', routing_schema_version: 2, assurance_level: 'verification', assurance_assessment: verificationAssuranceAssessment, requirements: [{ id: 'R1', text: 'the terminal gate follows current risk evidence' }], nodes: [{ id: 'work', kind: 'implementation', ...workRoute }] }));
    await call('init', { manifest: fixture.manifest });
    const assessmentPath = path.join(fixture.root, 'raised-assessment.json');
    await writeFile(assessmentPath, JSON.stringify(terraAssuranceAssessment));

    let [raised] = await call('raise-assurance', { task_id: 'feature-1', target_assurance_level: 'terra', reason: 'Execution evidence increased uncertainty.', assurance_assessment: assessmentPath, replacement_agent_task_path: '/root/terra-terminal', integration_owner: '/root', review_node_id: 'terminal-review' });
    assert.equal(raised.prior_assurance_level, 'verification');
    assert.equal(raised.assurance_level, 'terra');
    assert.equal(raised.node.kind, 'quality_review');
    assert.deepEqual(raised.node.depends_on, ['work']);
    assert.deepEqual(raised.ready_nodes.map(node => node.id), ['work']);

    await writeFile(assessmentPath, JSON.stringify(solAssuranceAssessment));
    [raised] = await call('raise-assurance', { task_id: 'feature-1', target_assurance_level: 'sol', reason: 'The uncertainty crosses the Sol review threshold.', assurance_assessment: assessmentPath, replacement_agent_task_path: '/root/sol-terminal', integration_owner: '/root' });
    assert.equal(raised.prior_assurance_level, 'terra');
    assert.equal(raised.assurance_level, 'sol');
    assert.equal(raised.node.kind, 'total_review');
    assert.equal(raised.node.agent_type, 'avsp_sol_high');
    assert.equal(raised.node.execution_owner, '/root/sol-terminal');
    await assert.rejects(() => call('raise-assurance', { task_id: 'feature-1', target_assurance_level: 'terra', reason: 'Downgrade is forbidden.', assurance_assessment: assessmentPath, replacement_agent_task_path: '/root/other-review', integration_owner: '/root' }), /must be higher/);

    const state = await readControllerState(fixture.stateDir);
    assert.equal(Object.values(state.nodes).filter(node => ['quality_review', 'total_review'].includes(node.kind)).length, 1);
    assert.deepEqual(state.events.filter(event => event.type === 'assurance_level_raised').map(event => [event.from, event.to]), [['verification', 'terra'], ['terra', 'sol']]);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('raises an unclaimed v3 Terra gate to an executable Sol/high gate', async () => {
  const fixture = await setup();
  try {
    const call = (command, parameters) => callForFixture(fixture, command, parameters);
    const workRoute = { execution_risk: 'protected', routing_reason: 'bounded change', execution_owner: '/root/v3-raise-work', integration_owner: '/root', quality_guard: 'targeted verification' };
    const terraRoute = { execution_risk: 'read_only', routing_reason: 'initial Terra gate', execution_owner: '/root/v3-raise-terra', integration_owner: '/root', quality_guard: 'review the complete task' };
    await writeFile(fixture.manifest, JSON.stringify({ task_id: 'feature-1', workspace: fixture.workspace, goal: 'Raise a v3 Terra gate when execution reveals global uncertainty', routing_schema_version: 3, assurance_level: 'terra', assurance_assessment: terraAssuranceAssessment, review_entry_stage: 'terra_single', review_context: v3ReviewContext, requirements: [{ id: 'R1', text: 'the raised gate must execute as Sol/high' }], nodes: [{ id: 'work', kind: 'implementation', ...workRoute }, { id: 'review-gate', kind: 'quality_review', depends_on: ['work'], ...terraRoute }] }));
    await call('init', { manifest: fixture.manifest });
    const assessmentPath = path.join(fixture.root, 'v3-raised-assessment.json'); await writeFile(assessmentPath, JSON.stringify(solAssuranceAssessment));
    const [raised] = await call('raise-assurance', { task_id: 'feature-1', target_assurance_level: 'sol', reason: 'Execution evidence now has an unknown global boundary.', assurance_assessment: assessmentPath, replacement_agent_task_path: '/root/v3-raised-sol', integration_owner: '/root' });
    assert.equal(raised.assurance_level, 'sol'); assert.equal(raised.effective_assurance_level, 'sol'); assert.equal(raised.node.kind, 'total_review'); assert.equal(raised.node.agent_type, 'avsp_sol_high'); assert.equal(raised.node.review_gate.stage, 'sol_high');
    let state = await readControllerState(fixture.stateDir); assert.equal(state.review_entry_stage, 'sol_high'); assert.equal(Object.values(state.nodes).filter(node => ['quality_review', 'total_review'].includes(node.kind)).length, 1);

    const [work] = await call('claim', { task_id: 'feature-1', node_id: 'work', agent_task_path: '/root/v3-raise-work', agent_role: 'avsp_terra_high' }); const workResult = path.join(fixture.root, 'v3-raise-work.json'); await writeFile(workResult, JSON.stringify({})); await call('complete', { task_id: 'feature-1', node_id: 'work', claim_id: work.node.claim_id, status: 'succeeded', result: workResult });
    const [reviewClaim] = await call('claim', { task_id: 'feature-1', node_id: 'review-gate', agent_task_path: '/root/v3-raised-sol', agent_role: 'avsp_sol_high' }); const claimId = reviewClaim.claim_id ?? reviewClaim.node.claim_id;
    await call('heartbeat', { task_id: 'feature-1', node_id: 'review-gate', claim_id: claimId }); const [context] = await call('audit-context', { task_id: 'feature-1' }); const review = path.join(fixture.root, 'v3-raised-sol.review.json');
    await writeFile(review, JSON.stringify(v3ReviewPayload({ taskPath: '/root/v3-raised-sol', role: 'avsp_sol_high', claimId, verdict: 'pass', context, name: 'v3-raised-sol' }))); await call('record-review', { task_id: 'feature-1', review });
    const result = path.join(fixture.root, 'v3-raised-sol.outcome.json'); await writeFile(result, JSON.stringify({})); await call('complete', { task_id: 'feature-1', node_id: 'review-gate', claim_id: claimId, status: 'succeeded', result });
    const [closed, code] = await call('close-check', { task_id: 'feature-1' }); assert.equal(code, 0); assert.equal(closed.close_allowed, true);
    state = await readControllerState(fixture.stateDir); assert.equal(state.events.filter(event => event.type === 'assurance_level_raised').length, 1);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('rejects assurance escalation after the terminal gate is claimed', async () => {
  const fixture = await setup();
  try {
    const call = (command, parameters) => callForFixture(fixture, command, parameters);
    const workRoute = { execution_risk: 'protected', routing_reason: 'bounded change', execution_owner: '/root/work', integration_owner: '/root', quality_guard: 'targeted verification' };
    const terraRoute = { execution_risk: 'read_only', routing_reason: 'terminal quality gate', execution_owner: '/root/terra-review', integration_owner: '/root', quality_guard: 'review the complete task' };
    await writeFile(fixture.manifest, JSON.stringify({ task_id: 'feature-1', workspace: fixture.workspace, goal: 'Do not reroute an active gate', routing_schema_version: 2, assurance_level: 'terra', assurance_assessment: terraAssuranceAssessment, requirements: [{ id: 'R1', text: 'active gate routing is stable' }], nodes: [{ id: 'work', kind: 'implementation', ...workRoute }, { id: 'review', kind: 'quality_review', depends_on: ['work'], ...terraRoute }] }));
    await call('init', { manifest: fixture.manifest });
    const [work] = await call('claim', { task_id: 'feature-1', node_id: 'work', agent_task_path: '/root/work', agent_role: 'avsp_terra_high' });
    const result = path.join(fixture.root, 'work.json'); await writeFile(result, '{}');
    await call('complete', { task_id: 'feature-1', node_id: 'work', claim_id: work.node.claim_id, status: 'succeeded', result });
    await call('claim', { task_id: 'feature-1', node_id: 'review', agent_task_path: '/root/terra-review', agent_role: 'avsp_terra_xhigh' });
    const assessmentPath = path.join(fixture.root, 'active-gate-assessment.json'); await writeFile(assessmentPath, JSON.stringify(solAssuranceAssessment));
    await assert.rejects(() => call('raise-assurance', { task_id: 'feature-1', target_assurance_level: 'sol', reason: 'The gate is already active.', assurance_assessment: assessmentPath, replacement_agent_task_path: '/root/sol-review', integration_owner: '/root' }), /before its terminal review gate is claimed/);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('closes a v2 verification assurance task only after recording matching evidence', async () => {
  const fixture = await setup();
  try {
    const call = (command, parameters) => callForFixture(fixture, command, parameters);
    const workRoute = { execution_risk: 'protected', routing_reason: 'bounded change', execution_owner: '/root/work', integration_owner: '/root', quality_guard: 'targeted verification' };
    await writeFile(fixture.manifest, JSON.stringify({ task_id: 'feature-1', workspace: fixture.workspace, goal: 'Close through structured verification', routing_schema_version: 2, assurance_level: 'verification', assurance_assessment: verificationAssuranceAssessment, requirements: [{ id: 'R1', text: 'frozen evidence is mandatory' }], nodes: [{ id: 'work', kind: 'implementation', ...workRoute }] }));
    await call('init', { manifest: fixture.manifest });
    const [work] = await call('claim', { task_id: 'feature-1', node_id: 'work', agent_task_path: '/root/work', agent_role: 'avsp_terra_high' });
    const result = path.join(fixture.root, 'verification-work.json'); await writeFile(result, JSON.stringify({ completed: true }));
    await call('complete', { task_id: 'feature-1', node_id: 'work', claim_id: work.node.claim_id, status: 'succeeded', result });
    let [closed, code] = await call('close-check', { task_id: 'feature-1' });
    assert.equal(code, 2); assert.ok(closed.reasons.includes('no verification record'));
    const [context] = await call('audit-context', { task_id: 'feature-1' });
    const verification = path.join(fixture.root, 'verification-record.json');
    await writeFile(verification, JSON.stringify({ verified_by: 'main/root', requirement_coverage: { R1: 'targeted evidence verified' }, workflow_snapshot: context.workflow_snapshot, workspace_fingerprint: context.workspace_fingerprint, scope_and_regression: 'within declared scope', verification_gaps: 'none', residual_risk: 'accepted' }));
    let [recordedVerification] = await call('record-verification', { task_id: 'feature-1', verification });
    assert.equal(recordedVerification.idempotent, false);
    const eventsAfterFirstRecord = (await readControllerState(fixture.stateDir)).events.length;
    [recordedVerification] = await call('record-verification', { task_id: 'feature-1', verification });
    assert.equal(recordedVerification.idempotent, true);
    assert.equal((await readControllerState(fixture.stateDir)).events.length, eventsAfterFirstRecord);
    await writeFile(verification, JSON.stringify({ verified_by: 'main/root', requirement_coverage: { R1: 'targeted evidence verified' }, workflow_snapshot: context.workflow_snapshot, workspace_fingerprint: context.workspace_fingerprint, scope_and_regression: 'different verification content', verification_gaps: 'none', residual_risk: 'accepted' }));
    await assert.rejects(() => call('record-verification', { task_id: 'feature-1', verification }), /call workflow_invalidate_gate/);
    await writeFile(path.join(fixture.workspace, 'app.txt'), 'changed after verification\n');
    [closed, code] = await call('close-check', { task_id: 'feature-1' });
    assert.equal(code, 2); assert.ok(closed.reasons.includes('workspace changed after verification'));
    const [invalidated] = await call('invalidate-gate', { task_id: 'feature-1', reason: 'Workspace changed before task closure.' });
    assert.equal(invalidated.gate_kind, 'verification'); assert.equal(invalidated.node, null);
    const invalidatedState = await readControllerState(fixture.stateDir);
    assert.equal(invalidatedState.verification_record, null);
    assert.equal(invalidatedState.verification_history.length, 1);
    assert.equal(invalidatedState.verification_history[0].verification_record.recorded_at, recordedVerification.verification_record.recorded_at);
    assert.equal(invalidatedState.verification_history[0].invalidation_reason, 'Workspace changed before task closure.');
    assert.ok(Date.parse(invalidatedState.verification_history[0].invalidated_at));
    const [replacementContext] = await call('audit-context', { task_id: 'feature-1' });
    await writeFile(verification, JSON.stringify({ verified_by: 'main/root', requirement_coverage: { R1: 'reverified after invalidation' }, workflow_snapshot: replacementContext.workflow_snapshot, workspace_fingerprint: replacementContext.workspace_fingerprint, scope_and_regression: 'within declared scope', verification_gaps: 'none', residual_risk: 'accepted' }));
    await call('record-verification', { task_id: 'feature-1', verification });
    [closed, code] = await call('close-check', { task_id: 'feature-1' });
    assert.equal(code, 0); assert.equal(closed.close_allowed, true);
    const retainedState = await readControllerState(fixture.stateDir);
    retainedState.updated_at = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    await writeControllerState(fixture.stateDir, retainedState);
    const [pruned] = await dispatch('prune-expired', { state_dir: fixture.stateDir });
    if (pruned.deleted.length !== 1) assert.fail(JSON.stringify(pruned));
    assert.equal(pruned.deleted_count, 1, JSON.stringify(pruned));
    assert.deepEqual(pruned.deleted.map(item => item.task_id), ['feature-1']);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('requires a v2 assurance assessment and keeps unavailable attempts out of the execution retry budget', async () => {
  const fixture = await setup();
  try {
    const call = (command, parameters) => callForFixture(fixture, command, parameters);
    await writeFile(fixture.manifest, JSON.stringify({ task_id: 'feature-1', workspace: fixture.workspace, goal: 'Reject an ungrounded assurance level', routing_schema_version: 2, assurance_level: 'terra', requirements: [{ id: 'R1', text: 'assessment is mandatory' }], nodes: [{ id: 'work', kind: 'implementation', execution_risk: 'protected', routing_reason: 'bounded work', execution_owner: '/root/work', integration_owner: '/root', quality_guard: 'targeted verification' }, { id: 'review', kind: 'quality_review', depends_on: ['work'], execution_risk: 'read_only', routing_reason: 'terminal review', execution_owner: '/root/review', integration_owner: '/root', quality_guard: 'review evidence' }] }));
    await assert.rejects(() => call('init', { manifest: fixture.manifest }), /assurance_assessment/);
    await writeFile(fixture.manifest, JSON.stringify({ task_id: 'feature-1', workspace: fixture.workspace, goal: 'Reject a mismatched assurance level', routing_schema_version: 2, assurance_level: 'terra', assurance_assessment: verificationAssuranceAssessment, requirements: [{ id: 'R1', text: 'assessment determines the gate' }], nodes: [{ id: 'work', kind: 'implementation', execution_risk: 'protected', routing_reason: 'bounded work', execution_owner: '/root/work', integration_owner: '/root', quality_guard: 'targeted verification' }, { id: 'review', kind: 'quality_review', depends_on: ['work'], execution_risk: 'read_only', routing_reason: 'terminal review', execution_owner: '/root/review', integration_owner: '/root', quality_guard: 'review evidence' }] }));
    await assert.rejects(() => call('init', { manifest: fixture.manifest }), /assurance_level must be verification/);

    await writeFile(fixture.manifest, JSON.stringify({ task_id: 'feature-1', workspace: fixture.workspace, goal: 'Separate unavailable retries from execution failures', requirements: [{ id: 'R1', text: 'retry accounting remains visible' }], nodes: [{ id: 'work', kind: 'implementation', agent_type: 'avsp_terra_high' }, { id: 'total-review', kind: 'total_review', agent_type: 'avsp_sol_high', depends_on: ['work'] }] }));
    await call('init', { manifest: fixture.manifest });
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      const [claim] = await call('claim', { task_id: 'feature-1', node_id: 'work', agent_task_path: `/root/unavailable-${attempt}`, agent_role: 'avsp_terra_high' });
      const result = path.join(fixture.root, `unavailable-${attempt}.json`); await writeFile(result, JSON.stringify({ attempt }));
      await call('complete', { task_id: 'feature-1', node_id: 'work', claim_id: claim.node.claim_id, status: 'unavailable', result });
      if (attempt < 8) await call('retry', { task_id: 'feature-1', node_id: 'work', reason: `unavailable ${attempt}`, previous_agent_stopped: true });
    }
    const state = await readControllerState(fixture.stateDir);
    assert.equal(state.nodes.work.attempt, 8);
    assert.equal(state.nodes.work.attempt_budget_used, 0);
    assert.equal(state.nodes.work.unavailable_attempts, 8);
    await assert.rejects(() => call('retry', { task_id: 'feature-1', node_id: 'work', reason: 'unavailable 8', previous_agent_stopped: true }), /unavailable budget/);
    const retained = await readControllerState(fixture.stateDir);
    assert.equal(retained.nodes.work.status, 'unavailable');
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('keeps persisted v2 tasks with the legacy string assurance assessment readable', async () => {
  const fixture = await setup();
  try {
    const call = (command, parameters) => callForFixture(fixture, command, parameters);
    const workRoute = { execution_risk: 'protected', routing_reason: 'bounded work', execution_owner: '/root/work', integration_owner: '/root', quality_guard: 'targeted verification' };
    const reviewRoute = { execution_risk: 'read_only', routing_reason: 'terminal review', execution_owner: '/root/review', integration_owner: '/root', quality_guard: 'review evidence' };
    await writeFile(fixture.manifest, JSON.stringify({ task_id: 'feature-1', workspace: fixture.workspace, goal: 'Read an early v2 assurance state', routing_schema_version: 2, assurance_level: 'terra', assurance_assessment: terraAssuranceAssessment, requirements: [{ id: 'R1', text: 'old state remains readable' }], nodes: [{ id: 'work', kind: 'implementation', ...workRoute }, { id: 'review', kind: 'quality_review', depends_on: ['work'], ...reviewRoute }] }));
    await call('init', { manifest: fixture.manifest });
    const state = await readControllerState(fixture.stateDir);
    state.assurance_assessment = {
      impact: 'legacy impact', recoverability: 'legacy recoverability', uncertainty: 'legacy uncertainty', verifiability: 'legacy verifiability', coupling: 'legacy coupling', selection_reason: 'legacy selection',
    };
    await writeControllerState(fixture.stateDir, state);
    const [status] = await call('status', { task_id: 'feature-1' });
    assert.equal(status.assurance_assessment.impact, 'legacy impact');
    assert.equal(status.assurance_level, 'terra');
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

test('rebinds an unclaimed pending modern node when its planned agent never starts', async () => {
  const fixture = await setup();
  try {
    const call = (command, parameters) => callForFixture(fixture, command, parameters);
    const workRoute = { execution_risk: 'protected', routing_reason: 'controlled dispatch', execution_owner: '/root/planned-worker', integration_owner: '/root', quality_guard: 'test' };
    const reviewRoute = { execution_risk: 'read_only', routing_reason: 'independent review', execution_owner: '/root/reviewer', integration_owner: '/root', quality_guard: 'test' };
    await writeFile(fixture.manifest, JSON.stringify({ task_id: 'feature-1', workspace: fixture.workspace, goal: 'Recover a failed pre-start dispatch', routing_schema_version: 1, requirements: [{ id: 'R1', text: 'replacement can claim pending work' }], nodes: [{ id: 'work', kind: 'implementation', ...workRoute }, { id: 'total-review', kind: 'total_review', agent_type: 'avsp_sol_high', depends_on: ['work'], ...reviewRoute }] }));
    await call('init', { manifest: fixture.manifest });
    await assert.rejects(() => call('rebind-pending', { task_id: 'feature-1', node_id: 'work', reason: 'planned worker did not start', replacement_agent_task_path: '/root/replacement-worker', previous_agent_stopped: false }), /must be true/);
    const [rebound] = await call('rebind-pending', { task_id: 'feature-1', node_id: 'work', reason: 'planned worker did not start', replacement_agent_task_path: '/root/replacement-worker', previous_agent_stopped: true });
    assert.equal(rebound.node.execution_owner, '/root/replacement-worker');
    assert.equal(rebound.node.attempt, 0);
    const [replacement] = await call('claim', { task_id: 'feature-1', node_id: 'work', agent_task_path: '/root/replacement-worker', agent_role: 'avsp_terra_high' });
    assert.equal(replacement.node.agent_task_path, '/root/replacement-worker');
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
    assert.equal(mismatchQuarantined.quarantined[0].task_id, 'feature-1');
    await assert.rejects(() => readControllerState(mismatch.stateDir), /does not exist/);
    const mismatchMetadata = JSON.parse(await readFile(path.join(mismatchQuarantined.quarantined[0].error_path, 'quarantine.json'), 'utf8'));
    assert.equal(mismatchMetadata.task_id, 'feature-1');
    assert.equal(mismatchMetadata.review_artifacts, null);
    await assert.rejects(() => readFile(path.join(mismatchQuarantined.quarantined[0].error_path, 'review-results', 'claim-1', 'outcome.json')), /ENOENT/);
    assert.equal(await readFile(path.join(mismatch.stateDir, '.workflow-review-results', 'other-task', 'claim-1', 'outcome.json'), 'utf8'), '{}');

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
    assert.equal(quarantineMetadata.version, 4);
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

test('expired quarantine retains an active peer whose state is nested in its review tree', async () => {
  const fixture = await setup();
  try {
    await dispatch('init', { state_dir: fixture.stateDir, manifest: fixture.manifest });
    await dispatch('release-workspace', { state_dir: fixture.stateDir, task_id: 'feature-1', previous_agents_stopped: true });
    await mkdir(path.join(fixture.stateDir, '.workflow-review-results', 'feature-1', 'claim-1'), { recursive: true });
    await writeFile(path.join(fixture.stateDir, '.workflow-review-results', 'feature-1', 'claim-1', 'outcome.json'), '{}');
    const state = await readControllerState(fixture.stateDir); state.future_state_field = true; state.updated_at = '1970-01-01T00:00:00.000Z'; await writeControllerState(fixture.stateDir, state);
    const [quarantined] = await dispatch('prune-expired', { state_dir: fixture.stateDir });
    assert.equal(quarantined.quarantined_count, 1);
    const errorPath = quarantined.quarantined[0].error_path;
    const metadataPath = path.join(errorPath, 'quarantine.json'); const expiryPath = path.join(errorPath, '.quarantine-expiry.json');
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8')); const expiry = JSON.parse(await readFile(expiryPath, 'utf8'));
    metadata.quarantined_at = '1970-01-01T00:00:00.000Z'; metadata.delete_after = '1971-01-01T00:00:00.000Z';
    expiry.quarantined_at = metadata.quarantined_at; expiry.delete_after = metadata.delete_after;
    await writeFile(metadataPath, JSON.stringify(metadata)); await writeFile(expiryPath, JSON.stringify(expiry));

    const peerStateDir = path.join(errorPath, 'review-results', 'peer-state'); const peerManifest = path.join(fixture.root, 'quarantine-peer.json');
    await writeFile(peerManifest, JSON.stringify({ task_id: 'peer-task', workspace: fixture.workspace, workspace_claims: [{ mode: 'write', prefix: 'peer' }], goal: 'retain active peer', requirements: [{ id: 'R1', text: 'quarantine cleanup must retain the peer' }], nodes: [{ id: 'total-review', kind: 'total_review', agent_type: 'avsp_sol_high', depends_on: [] }] }));
    await dispatch('init', { state_dir: peerStateDir, manifest: peerManifest });
    const [pruned] = await dispatch('prune-expired', { state_dir: fixture.stateDir });
    assert.equal(pruned.quarantine_deleted_count, 0);
    assert.match(pruned.quarantine_retained.find(item => item.error_path === errorPath).reason, /overlaps an active workspace lease entry/);
    assert.equal((await readControllerState(peerStateDir, 'peer-task')).task_id, 'peer-task');
    const registry = JSON.parse(await readFile(path.join(fixture.workspace, '.codex', 'workflow-controller', 'workspace-lease.json'), 'utf8'));
    assert.ok(registry.active_tasks.some(entry => entry.task_id === 'peer-task'));
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
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

test('retains a corrupted SQLite task when its workspace lease cannot be verified', async () => {
  const fixture = await setup();
  try {
    await dispatch('init', { state_dir: fixture.stateDir, manifest: fixture.manifest });
    await dispatch('release-workspace', { state_dir: fixture.stateDir, task_id: 'feature-1', previous_agents_stopped: true });
    const databasePath = path.join(fixture.stateDir, 'feature-1.sqlite');
    await writeFile(databasePath, 'not a SQLite database');
    await utimes(databasePath, new Date(0), new Date(0));
    const [pruned] = await dispatch('prune-expired', { state_dir: fixture.stateDir });
    assert.equal(pruned.deleted_count, 0);
    assert.equal(pruned.quarantined_count, 0);
    assert.equal(pruned.retained_count, 1); assert.match(pruned.retained[0].reason, /cannot be verified|manual recovery/);
    assert.equal(await readFile(databasePath, 'utf8'), 'not a SQLite database');
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('retains a force-expired incomplete task when its workspace lease registry is malformed', async () => {
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
    assert.equal(pruned.quarantined_count, 0);
    assert.match(pruned.retained.find(item => item.task_id === 'feature-1').reason, /cannot be verified|manual recovery/);
    assert.equal((await readControllerState(fixture.stateDir)).task_id, 'feature-1');
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('retains a force-expired incomplete task when it names a noncanonical lease registry', async () => {
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
    assert.equal(pruned.quarantined_count, 0);
    assert.match(pruned.retained.find(item => item.task_id === 'feature-1').reason, /no verifiable workspace lease|manual recovery/);
    assert.equal((await readControllerState(fixture.stateDir)).task_id, 'feature-1');
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('retains force-expired states with missing or empty node collections', async () => {
  const fixture = await setup();
  try {
    await dispatch('init', { state_dir: fixture.stateDir, manifest: fixture.manifest });
    await dispatch('release-workspace', { state_dir: fixture.stateDir, task_id: 'feature-1', previous_agents_stopped: true });
    const state = await readControllerState(fixture.stateDir);
    state.updated_at = '1970-01-01T00:00:00.000Z'; state.future_state_field = true; delete state.nodes; await writeControllerState(fixture.stateDir, state);
    const [missingNodes] = await dispatch('prune-expired', { state_dir: fixture.stateDir });
    assert.equal(missingNodes.quarantined_count, 0); assert.match(missingNodes.retained[0].reason, /node collection is missing, empty, or not verifiable/);
    state.nodes = {}; await writeControllerState(fixture.stateDir, state);
    const [emptyNodes] = await dispatch('prune-expired', { state_dir: fixture.stateDir });
    assert.equal(emptyNodes.quarantined_count, 0); assert.match(emptyNodes.retained[0].reason, /node collection is missing, empty, or not verifiable/);
    assert.equal((await readControllerState(fixture.stateDir)).task_id, 'feature-1');
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('release keeps the active registry entry when the node collection is empty', async () => {
  const fixture = await setup();
  try {
    await dispatch('init', { state_dir: fixture.stateDir, manifest: fixture.manifest });
    const state = await readControllerState(fixture.stateDir); state.nodes = {}; await writeControllerState(fixture.stateDir, state);
    await assert.rejects(() => dispatch('release-workspace', { state_dir: fixture.stateDir, task_id: 'feature-1', previous_agents_stopped: true }), /nodes are unreadable or empty/);
    const lease = JSON.parse(await readFile(path.join(fixture.workspace, '.codex', 'workflow-controller', 'workspace-lease.json'), 'utf8'));
    assert.ok(lease.active_tasks.some(entry => entry.task_id === 'feature-1'));
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('normal prune retains a released task when its workspace registry is missing', async () => {
  const fixture = await setup();
  try {
    await writeFile(fixture.manifest, JSON.stringify({ task_id: 'feature-1', workspace: fixture.workspace, goal: 'missing registry prune', routing_schema_version: 1, requirements: [{ id: 'R1', text: 'retain without registry' }], nodes: [{ id: 'work', kind: 'implementation', execution_risk: 'protected', routing_reason: 'controlled test', execution_owner: '/root/missing-registry-work', integration_owner: '/root', quality_guard: 'test' }, { id: 'total-review', kind: 'total_review', agent_type: 'avsp_sol_high', depends_on: ['work'], execution_risk: 'protected', routing_reason: 'controlled test', execution_owner: '/root/missing-registry-review', integration_owner: '/root', quality_guard: 'test' }] }));
    await dispatch('init', { state_dir: fixture.stateDir, manifest: fixture.manifest });
    await dispatch('release-workspace', { state_dir: fixture.stateDir, task_id: 'feature-1', previous_agents_stopped: true });
    const state = await readControllerState(fixture.stateDir); state.updated_at = '1970-01-01T00:00:00.000Z'; await writeControllerState(fixture.stateDir, state);
    const leasePath = path.join(fixture.workspace, '.codex', 'workflow-controller', 'workspace-lease.json'); await rm(leasePath);
    const [pruned] = await dispatch('prune-expired', { state_dir: fixture.stateDir });
    assert.equal(pruned.deleted_count, 0); assert.match(pruned.retained[0].reason, /workspace lease is unreadable|registry is missing|does not exist/);
    assert.equal((await readControllerState(fixture.stateDir)).task_id, 'feature-1');
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('an initialized workspace cannot recreate a missing registry during a later init', async () => {
  const fixture = await setup();
  try {
    await writeFile(fixture.manifest, JSON.stringify({ task_id: 'feature-1', workspace: fixture.workspace, workspace_claims: [{ mode: 'write', prefix: 'feature-a' }], goal: 'retain active coordination', requirements: [{ id: 'R1', text: 'registry deletion must fail closed' }], nodes: [{ id: 'total-review', kind: 'total_review', agent_type: 'avsp_sol_high', depends_on: [] }] }));
    await dispatch('init', { state_dir: fixture.stateDir, manifest: fixture.manifest });
    const leasePath = path.join(fixture.workspace, '.codex', 'workflow-controller', 'workspace-lease.json');
    await rm(leasePath);
    const secondManifest = path.join(fixture.root, 'second-manifest.json');
    await writeFile(secondManifest, JSON.stringify({ task_id: 'feature-2', workspace: fixture.workspace, workspace_claims: [{ mode: 'write', prefix: 'feature-b' }], goal: 'must not recreate registry', requirements: [{ id: 'R2', text: 'retain prior active ownership' }], nodes: [{ id: 'total-review', kind: 'total_review', agent_type: 'avsp_sol_high', depends_on: [] }] }));
    await assert.rejects(() => dispatch('init', { state_dir: path.join(fixture.root, 'second-state'), manifest: secondManifest }), /registry is missing after initialization/);
    assert.equal((await readControllerState(fixture.stateDir)).workspace_lease.status, 'active');
    await assert.rejects(() => readFile(leasePath, 'utf8'), /ENOENT/);
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
    await assert.rejects(() => dispatch('init', { state_dir: secondStateDir, manifest: secondManifest }), /claim conflicts with active workflow task: feature-1/);
    await assert.rejects(() => dispatch('release-workspace', { state_dir: fixture.stateDir, task_id: 'feature-1', previous_agents_stopped: false }), /previous_agents_stopped must be true/);
    const [released] = await dispatch('release-workspace', { state_dir: fixture.stateDir, task_id: 'feature-1', previous_agents_stopped: true });
    assert.equal(released.released, true);
    await assert.rejects(() => dispatch('init', { state_dir: fixture.stateDir, manifest: fixture.manifest }), /Task already exists/);
    assert.deepEqual(JSON.parse(await readFile(path.join(fixture.workspace, '.codex', 'workflow-controller', 'workspace-lease.json'), 'utf8')).active_tasks, []);
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
  const reconcile = TOOLS.find(tool => tool.name === 'workflow_reconcile_workspace');
  assert.deepEqual(reconcile.inputSchema.required, ['workspace', 'task_id', 'state_dir']);
  const doctor = TOOLS.find(tool => tool.name === 'workflow_doctor');
  assert.deepEqual(doctor.inputSchema.required, ['state_dir']);
  const quarantine = TOOLS.find(tool => tool.name === 'workflow_reconcile_quarantine');
  assert.deepEqual(quarantine.inputSchema.required, ['state_dir']);
  assert.equal(TOOL_COMMANDS.workflow_reconcile_quarantine, 'reconcile-quarantine');
  const pruneExpired = TOOLS.find(tool => tool.name === 'workflow_prune_expired');
  assert.match(pruneExpired.description, /仅可验证为失活/); assert.match(pruneExpired.description, /registry 无法验证的状态保留/);
  const verification = TOOLS.find(tool => tool.name === 'workflow_record_verification');
  assert.deepEqual(verification.inputSchema.required, ['task_id', 'verification', 'state_dir']);
  assert.equal(TOOL_COMMANDS.workflow_record_verification, 'record-verification');
  const raiseAssurance = TOOLS.find(tool => tool.name === 'workflow_raise_assurance');
  assert.deepEqual(raiseAssurance.inputSchema.required, ['task_id', 'target_assurance_level', 'reason', 'assurance_assessment', 'replacement_agent_task_path', 'integration_owner', 'state_dir']);
  assert.deepEqual(raiseAssurance.inputSchema.properties.target_assurance_level.enum, ['terra', 'sol']);
  assert.match(raiseAssurance.description, /v2\/v3/); assert.match(raiseAssurance.description, /sol_high/);
  assert.equal(TOOL_COMMANDS.workflow_raise_assurance, 'raise-assurance');
  const rebindPending = TOOLS.find(tool => tool.name === 'workflow_rebind_pending');
  assert.deepEqual(rebindPending.inputSchema.required, ['task_id', 'node_id', 'reason', 'replacement_agent_task_path', 'previous_agent_stopped', 'state_dir']);
  assert.equal(TOOL_COMMANDS.workflow_rebind_pending, 'rebind-pending');
  const invalidateGate = TOOLS.find(tool => tool.name === 'workflow_invalidate_gate');
  assert.deepEqual(invalidateGate.inputSchema.required, ['task_id', 'reason', 'state_dir']);
  assert.equal(TOOL_COMMANDS.workflow_invalidate_gate, 'invalidate-gate');
  const repair = TOOLS.find(tool => tool.name === 'workflow_record_repair');
  assert.deepEqual(repair.inputSchema.required, ['task_id', 'repair', 'state_dir']);
  assert.equal(TOOL_COMMANDS.workflow_record_repair, 'record-repair');
});

test('quarantine derives artifact ownership from state paths and never trusts an impersonated task_id', async () => {
  const fixture = await setup();
  try {
    const oldStateDir = path.join(fixture.root, 'old-state'); const peerStateDir = path.join(fixture.root, 'peer-state');
    const manifest = async (taskId, claims) => {
      const manifestPath = path.join(fixture.root, `${taskId}.json`);
      await writeFile(manifestPath, JSON.stringify({ task_id: taskId, workspace: fixture.workspace, workspace_claims: claims, goal: taskId, requirements: [{ id: 'R1', text: taskId }], nodes: [{ id: 'work', kind: 'implementation', agent_type: 'avsp_terra_high' }, { id: 'total-review', kind: 'total_review', agent_type: 'avsp_sol_high', depends_on: ['work'] }] }));
      return manifestPath;
    };
    await dispatch('init', { state_dir: oldStateDir, manifest: await manifest('old-task', [{ mode: 'write', prefix: 'old' }]) });
    await dispatch('release-workspace', { state_dir: oldStateDir, task_id: 'old-task', previous_agents_stopped: true });
    await dispatch('init', { state_dir: peerStateDir, manifest: await manifest('peer-task', [{ mode: 'write', prefix: 'peer' }]) });
    const oldArtifact = path.join(oldStateDir, '.workflow-review-results', 'old-task', 'claim', 'outcome.json'); const peerArtifact = path.join(peerStateDir, '.workflow-review-results', 'peer-task', 'claim', 'outcome.json');
    await mkdir(path.dirname(oldArtifact), { recursive: true }); await mkdir(path.dirname(peerArtifact), { recursive: true }); await writeFile(oldArtifact, 'old'); await writeFile(peerArtifact, 'peer');
    const oldState = await readControllerState(oldStateDir, 'old-task'); oldState.task_id = 'peer-task'; oldState.future_state_field = true; oldState.updated_at = '1970-01-01T00:00:00.000Z'; await writeControllerState(oldStateDir, oldState, 'old-task');
    const [quarantined] = await dispatch('prune-expired', { state_dir: oldStateDir });
    assert.equal(quarantined.quarantined_count, 1); assert.equal(quarantined.quarantined[0].task_id, 'old-task');
    const metadata = JSON.parse(await readFile(path.join(quarantined.quarantined[0].error_path, 'quarantine.json'), 'utf8'));
    assert.equal(metadata.task_id, 'old-task'); assert.equal(metadata.review_artifacts, 'review-results');
    assert.match(path.basename(quarantined.quarantined[0].error_path), new RegExp(`^old-task-${metadata.authority_anchor}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`, 'u'));
    assert.equal(await readFile(path.join(quarantined.quarantined[0].error_path, 'review-results', 'claim', 'outcome.json'), 'utf8'), 'old');
    assert.equal(await readFile(peerArtifact, 'utf8'), 'peer');
    const peerRegistry = JSON.parse(await readFile(path.join(fixture.workspace, '.codex', 'workflow-controller', 'workspace-lease.json'), 'utf8'));
    const canonicalPeerStatePath = await canonicalStateFile(peerStateDir, 'peer-task');
    assert.ok(peerRegistry.active_tasks.some(entry => entry.state_path === canonicalPeerStatePath && entry.task_id === 'peer-task'));

    const peerState = await readControllerState(peerStateDir, 'peer-task'); peerState.task_id = 'old-task'; peerState.workspace_lease.status = 'released'; peerState.future_state_field = true; peerState.updated_at = '1970-01-01T00:00:00.000Z'; await writeControllerState(peerStateDir, peerState, 'peer-task');
    const [protectedPeer] = await dispatch('prune-expired', { state_dir: peerStateDir });
    if (protectedPeer.quarantined_count !== 0) throw new Error(JSON.stringify(protectedPeer));
    assert.match(protectedPeer.retained[0].reason, /active state path/); await readFile(peerArtifact);

    const legacyErrorPath = path.join(oldStateDir, '.workflow-errors', 'legacy-mismatch'); await mkdir(legacyErrorPath, { recursive: true });
    const originalStatePath = path.join(oldStateDir, 'old-task.json'); const timestamp = new Date().toISOString(); const deleteAfter = new Date(Date.parse(timestamp) + 365 * 24 * 60 * 60 * 1000).toISOString();
    await writeFile(path.join(legacyErrorPath, 'quarantine.json'), JSON.stringify({ version: 1, status: 'quarantined', task_id: 'peer-task', original_state_path: originalStatePath, error_path: legacyErrorPath, reason: 'legacy fixture', quarantined_at: timestamp, delete_after: deleteAfter, files: ['old-task.sqlite'], move_error: null }));
    const [reconciled] = await dispatch('reconcile-quarantine', { state_dir: oldStateDir });
    assert.ok(reconciled.retained.some(entry => path.basename(entry.error_path) === path.basename(legacyErrorPath))); assert.equal(await readFile(peerArtifact, 'utf8'), 'peer');
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('quarantine sidecars cannot rebind an interrupted transfer to an active peer', async () => {
  const fixture = await setup();
  try {
    const oldStateDir = path.join(fixture.root, 'old-state'); const peerStateDir = oldStateDir;
    const manifestFor = async (taskId, stateDir, prefix) => {
      const manifest = path.join(fixture.root, `${taskId}.json`);
      await writeFile(manifest, JSON.stringify({ task_id: taskId, workspace: fixture.workspace, workspace_claims: [{ mode: 'write', prefix }], goal: taskId, requirements: [{ id: 'R1', text: taskId }], nodes: [{ id: 'work', kind: 'implementation', agent_type: 'avsp_terra_high' }, { id: 'total-review', kind: 'total_review', agent_type: 'avsp_sol_high', depends_on: ['work'] }] }));
      await dispatch('init', { state_dir: stateDir, manifest });
    };
    await manifestFor('old-task', oldStateDir, 'old');
    await dispatch('release-workspace', { state_dir: oldStateDir, task_id: 'old-task', previous_agents_stopped: true });
    await manifestFor('peer-task', peerStateDir, 'peer');
    const oldState = await readControllerState(oldStateDir, 'old-task'); oldState.future_state_field = true; oldState.updated_at = '1970-01-01T00:00:00.000Z'; await writeControllerState(oldStateDir, oldState, 'old-task');
    const peerJson = path.join(peerStateDir, 'peer-task.json'); const peerArtifact = path.join(peerStateDir, '.workflow-review-results', 'peer-task', 'claim', 'outcome.json');
    await writeFile(peerJson, '{"peer":true}'); await mkdir(path.dirname(peerArtifact), { recursive: true }); await writeFile(peerArtifact, 'peer');
    const [quarantined] = await dispatch('prune-expired', { state_dir: oldStateDir });
    assert.equal(quarantined.quarantined_count, 1);
    const errorPath = quarantined.quarantined[0].error_path;
    const metadataPath = path.join(errorPath, 'quarantine.json'); const expiryPath = path.join(errorPath, '.quarantine-expiry.json');
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8')); const expiry = JSON.parse(await readFile(expiryPath, 'utf8'));
    const leasePath = path.join(fixture.workspace, '.codex', 'workflow-controller', 'workspace-lease.json');
    Object.assign(metadata, {
      status: 'quarantining', task_id: 'peer-task', original_state_path: peerJson, files: ['peer-task.sqlite'], move_error: 'forged interrupted transfer', review_artifacts: 'review-results',
    });
    metadata.binding = quarantineBindingForTest(metadata, errorPath);
    Object.assign(expiry, {
      task_id: metadata.task_id, original_state_path: metadata.original_state_path, files: metadata.files, review_artifacts: metadata.review_artifacts, workspace: metadata.workspace, registry_path: metadata.registry_path, binding: metadata.binding,
    });
    await writeFile(metadataPath, JSON.stringify(metadata)); await writeFile(expiryPath, JSON.stringify(expiry));
    const [reconciled] = await dispatch('reconcile-quarantine', { state_dir: oldStateDir });
    assert.equal(reconciled.reconciled_count, 0);
    assert.match(reconciled.retained.find(entry => entry.error_path === errorPath).reason, /metadata is invalid/);
    assert.equal((await readControllerState(peerStateDir, 'peer-task')).task_id, 'peer-task');
    assert.equal(await readFile(peerJson, 'utf8'), '{"peer":true}'); assert.equal(await readFile(peerArtifact, 'utf8'), 'peer');
    const registry = JSON.parse(await readFile(leasePath, 'utf8'));
    const canonicalPeerStatePath = await canonicalStateFile(peerStateDir, 'peer-task');
    assert.ok(registry.active_tasks.some(entry => entry.task_id === 'peer-task' && entry.state_path === canonicalPeerStatePath));
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('quarantine reconciliation does not move a source newly claimed by an active registry entry', async () => {
  const fixture = await setup();
  try {
    await dispatch('init', { state_dir: fixture.stateDir, manifest: fixture.manifest });
    await dispatch('release-workspace', { state_dir: fixture.stateDir, task_id: 'feature-1', previous_agents_stopped: true });
    const state = await readControllerState(fixture.stateDir); state.future_state_field = true; state.updated_at = '1970-01-01T00:00:00.000Z'; await writeControllerState(fixture.stateDir, state);
    const [quarantined] = await dispatch('prune-expired', { state_dir: fixture.stateDir });
    const errorPath = quarantined.quarantined[0].error_path; const metadataPath = path.join(errorPath, 'quarantine.json');
    const sourceSqlite = path.join(fixture.stateDir, 'feature-1.sqlite'); await rename(path.join(errorPath, 'feature-1.sqlite'), sourceSqlite);
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8')); metadata.status = 'quarantining'; metadata.move_error = 'simulated interrupted transfer'; await writeFile(metadataPath, JSON.stringify(metadata));
    const leasePath = path.join(fixture.workspace, '.codex', 'workflow-controller', 'workspace-lease.json'); const lease = JSON.parse(await readFile(leasePath, 'utf8'));
    lease.active_tasks = [{ task_id: 'peer-task', state_path: path.join(fixture.stateDir, 'feature-1.json'), state_dir: fixture.stateDir, acquired_at: new Date().toISOString(), phase: 'active', workspace_claims: [{ mode: 'write', prefix: 'peer' }] }]; lease.updated_at = new Date().toISOString(); await writeFile(leasePath, JSON.stringify(lease));
    const [reconciled] = await dispatch('reconcile-quarantine', { state_dir: fixture.stateDir });
    assert.equal(reconciled.reconciled_count, 0); assert.match(reconciled.retained.find(entry => entry.error_path === errorPath).reason, /active workspace lease entry/);
    await readFile(sourceSqlite); const protectedRegistry = JSON.parse(await readFile(leasePath, 'utf8'));
    assert.ok(protectedRegistry.active_tasks.some(entry => entry.task_id === 'peer-task' && entry.state_path === path.join(fixture.stateDir, 'feature-1.json')));
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('quarantine reconciliation rejects a sidecar rebind while waiting for its state lock', async () => {
  const fixture = await setup();
  try {
    await dispatch('init', { state_dir: fixture.stateDir, manifest: fixture.manifest });
    await dispatch('release-workspace', { state_dir: fixture.stateDir, task_id: 'feature-1', previous_agents_stopped: true });
    const sourceJson = path.join(fixture.stateDir, 'feature-1.json'); const sourceSqlite = path.join(fixture.stateDir, 'feature-1.sqlite'); const sourceReview = path.join(fixture.stateDir, '.workflow-review-results', 'feature-1', 'claim', 'outcome.json');
    await writeFile(sourceJson, '{"source":true}'); await mkdir(path.dirname(sourceReview), { recursive: true }); await writeFile(sourceReview, 'source review');
    const state = await readControllerState(fixture.stateDir); state.future_state_field = true; state.updated_at = '1970-01-01T00:00:00.000Z'; await writeControllerState(fixture.stateDir, state);
    const [quarantined] = await dispatch('prune-expired', { state_dir: fixture.stateDir }); const errorPath = quarantined.quarantined[0].error_path;
    const metadataPath = path.join(errorPath, 'quarantine.json'); const expiryPath = path.join(errorPath, '.quarantine-expiry.json');
    await rename(path.join(errorPath, 'feature-1.json'), sourceJson); await rename(path.join(errorPath, 'feature-1.sqlite'), sourceSqlite); await rename(path.join(errorPath, 'review-results'), path.dirname(path.dirname(sourceReview)));
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8')); metadata.status = 'quarantining'; metadata.move_error = 'interrupted before source transfer'; await writeFile(metadataPath, JSON.stringify(metadata));
    const registryA = path.join(fixture.workspace, '.codex', 'workflow-controller', 'workspace-lease.json');
    const sourceLock = `${sourceJson}.lock`; await writeFile(sourceLock, `pid=${process.pid} hostname=${os.hostname()} created=${new Date().toISOString()}\n`, { flag: 'wx' });
    const pending = dispatch('reconcile-quarantine', { state_dir: fixture.stateDir });
    await waitForPath(`${registryA}.lock`);
    const workspaceB = path.join(fixture.root, 'workspace-b'); const registryB = path.join(workspaceB, '.codex', 'workflow-controller', 'workspace-lease.json'); await mkdir(path.dirname(registryB), { recursive: true });
    await writeFile(registryB, JSON.stringify({ version: 2, workspace: workspaceB, active_tasks: [{ task_id: 'feature-1', state_path: sourceJson, state_dir: fixture.stateDir, acquired_at: new Date().toISOString(), phase: 'active', workspace_claims: [{ mode: 'write', prefix: 'peer' }] }], updated_at: new Date().toISOString() }));
    metadata.workspace = workspaceB; metadata.registry_path = registryB; metadata.binding = quarantineBindingForTest(metadata, errorPath);
    const expiry = JSON.parse(await readFile(expiryPath, 'utf8')); expiry.workspace = workspaceB; expiry.registry_path = registryB; expiry.binding = metadata.binding;
    await writeFile(metadataPath, JSON.stringify(metadata)); await writeFile(expiryPath, JSON.stringify(expiry)); await rm(sourceLock);
    const [reconciled] = await pending;
    assert.equal(reconciled.reconciled_count, 0); assert.match(reconciled.retained.find(entry => entry.error_path === errorPath).reason, /metadata is invalid/);
    assert.equal(await readFile(sourceJson, 'utf8'), '{"source":true}'); await readFile(sourceSqlite); assert.equal(await readFile(sourceReview, 'utf8'), 'source review');
    const protectedRegistry = JSON.parse(await readFile(registryB, 'utf8'));
    assert.ok(protectedRegistry.active_tasks.some(entry => entry.state_path === sourceJson));
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('quarantine authority anchor rejects a call-time rebind from an active registry to an empty registry', async () => {
  const fixture = await setup();
  try {
    await dispatch('init', { state_dir: fixture.stateDir, manifest: fixture.manifest });
    await dispatch('release-workspace', { state_dir: fixture.stateDir, task_id: 'feature-1', previous_agents_stopped: true });
    const sourceJson = path.join(fixture.stateDir, 'feature-1.json'); const sourceSqlite = path.join(fixture.stateDir, 'feature-1.sqlite'); const sourceReview = path.join(fixture.stateDir, '.workflow-review-results', 'feature-1', 'claim', 'outcome.json');
    await writeFile(sourceJson, '{"source":true}'); await mkdir(path.dirname(sourceReview), { recursive: true }); await writeFile(sourceReview, 'source review');
    const state = await readControllerState(fixture.stateDir); state.future_state_field = true; state.updated_at = '1970-01-01T00:00:00.000Z'; await writeControllerState(fixture.stateDir, state);
    const [quarantined] = await dispatch('prune-expired', { state_dir: fixture.stateDir }); const errorPath = quarantined.quarantined[0].error_path;
    const metadataPath = path.join(errorPath, 'quarantine.json'); const expiryPath = path.join(errorPath, '.quarantine-expiry.json');
    await rename(path.join(errorPath, 'feature-1.json'), sourceJson); await rename(path.join(errorPath, 'feature-1.sqlite'), sourceSqlite); await rename(path.join(errorPath, 'review-results'), path.dirname(path.dirname(sourceReview)));
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8')); metadata.status = 'quarantining'; metadata.move_error = 'interrupted before source transfer';
    const registryA = path.join(fixture.workspace, '.codex', 'workflow-controller', 'workspace-lease.json'); const leaseA = JSON.parse(await readFile(registryA, 'utf8'));
    leaseA.active_tasks = [{ task_id: 'active-a', state_path: sourceJson, state_dir: fixture.stateDir, acquired_at: new Date().toISOString(), phase: 'active', workspace_claims: [{ mode: 'write', prefix: 'peer' }] }]; leaseA.updated_at = new Date().toISOString(); await writeFile(registryA, JSON.stringify(leaseA));
    const workspaceB = path.join(fixture.root, 'workspace-b'); const registryB = path.join(workspaceB, '.codex', 'workflow-controller', 'workspace-lease.json'); await mkdir(path.dirname(registryB), { recursive: true }); await writeFile(registryB, JSON.stringify({ version: 2, workspace: workspaceB, active_tasks: [], updated_at: new Date().toISOString() }));
    metadata.workspace = workspaceB; metadata.registry_path = registryB; metadata.authority_anchor = quarantineAuthorityAnchorForTest(metadata); metadata.binding = quarantineBindingForTest(metadata, errorPath);
    const expiry = JSON.parse(await readFile(expiryPath, 'utf8')); Object.assign(expiry, { workspace: workspaceB, registry_path: registryB, authority_anchor: metadata.authority_anchor, binding: metadata.binding });
    await writeFile(metadataPath, JSON.stringify(metadata)); await writeFile(expiryPath, JSON.stringify(expiry));
    const [reconciled] = await dispatch('reconcile-quarantine', { state_dir: fixture.stateDir });
    assert.equal(reconciled.reconciled_count, 0); assert.match(reconciled.retained.find(entry => entry.error_path === errorPath).reason, /metadata is invalid/);
    assert.equal(await readFile(sourceJson, 'utf8'), '{"source":true}'); await readFile(sourceSqlite); assert.equal(await readFile(sourceReview, 'utf8'), 'source review');
    const protectedA = JSON.parse(await readFile(registryA, 'utf8')); assert.ok(protectedA.active_tasks.some(entry => entry.state_path === sourceJson));
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('coordinates disjoint workspace claims and fingerprints only their declared union', async () => {
  const fixture = await setup();
  try {
    await mkdir(path.join(fixture.workspace, 'left')); await mkdir(path.join(fixture.workspace, 'right'));
    await writeFile(path.join(fixture.workspace, 'left', 'a.txt'), 'left'); await writeFile(path.join(fixture.workspace, 'right', 'b.txt'), 'right');
    const manifest = async (name, claims) => {
      const manifestPath = path.join(fixture.root, `${name}.json`);
      await writeFile(manifestPath, JSON.stringify({ task_id: name, workspace: fixture.workspace, workspace_claims: claims, goal: name, requirements: [{ id: 'R1', text: name }], nodes: [{ id: 'total-review', kind: 'total_review', agent_type: 'avsp_sol_high', depends_on: [] }] }));
      return manifestPath;
    };
    const leftManifest = await manifest('left-task', [{ mode: 'write', prefix: 'left' }]);
    const rightManifest = await manifest('right-task', [{ mode: 'write', prefix: 'right' }]);
    await dispatch('init', { state_dir: path.join(fixture.root, 'left-state'), manifest: leftManifest });
    await dispatch('init', { state_dir: path.join(fixture.root, 'right-state'), manifest: rightManifest });
    const claims = [{ mode: 'read', prefix: 'left' }];
    const before = await workspaceFingerprint(fixture.workspace, claims);
    await writeFile(path.join(fixture.workspace, 'right', 'b.txt'), 'peer change');
    assert.deepEqual(await workspaceFingerprint(fixture.workspace, claims), before);
    await writeFile(path.join(fixture.workspace, 'left', 'a.txt'), 'claimed change');
    assert.notDeepEqual(await workspaceFingerprint(fixture.workspace, claims), before);
    const rootManifest = await manifest('root-task', [{ mode: 'write', prefix: '.' }]);
    await assert.rejects(() => dispatch('init', { state_dir: path.join(fixture.root, 'root-state'), manifest: rootManifest }), /claim conflicts/);
    await assert.rejects(() => manifest('bad-task', [{ mode: 'write', prefix: '../escape' }]).then(value => dispatch('init', { state_dir: path.join(fixture.root, 'bad-state'), manifest: value })), /Invalid workspace_claim prefix/);
    await dispatch('release-workspace', { state_dir: path.join(fixture.root, 'left-state'), task_id: 'left-task', previous_agents_stopped: true });
    const [doctor] = await dispatch('doctor', { state_dir: path.join(fixture.root, 'left-state'), task_id: 'left-task' });
    assert.equal(doctor.checks.find(check => check.id === 'workspace_lease').status, 'pass');
    const leftState = await readControllerState(path.join(fixture.root, 'left-state'), 'left-task');
    leftState.routing_schema_version = 1; leftState.updated_at = '1970-01-01T00:00:00.000Z';
    for (const node of Object.values(leftState.nodes)) Object.assign(node, { execution_risk: 'protected', routing_reason: 'prune fixture', execution_owner: '/root/prune', integration_owner: '/root', quality_guard: 'test', routing_legacy: false });
    await writeControllerState(path.join(fixture.root, 'left-state'), leftState, 'left-task');
    const [pruned] = await dispatch('prune-expired', { state_dir: path.join(fixture.root, 'left-state') });
    assert.deepEqual(pruned.deleted.map(item => item.task_id), ['left-task']);
    const lease = JSON.parse(await readFile(path.join(fixture.workspace, '.codex', 'workflow-controller', 'workspace-lease.json'), 'utf8'));
    assert.equal(lease.active_tasks.length, 1); assert.equal(lease.active_tasks[0].task_id, 'right-task');
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('validates workspace claim boundaries, write authority, limits, and late links', async t => {
  const fixture = await setup();
  try {
    const writeManifest = async (taskId, claims, nodes = [{ id: 'work', kind: 'implementation', agent_type: 'avsp_terra_high' }]) => {
      const manifestPath = path.join(fixture.root, `${taskId}.json`);
      const completeNodes = nodes.some(node => node.kind === 'total_review') ? nodes : [...nodes, { id: 'total-review', kind: 'total_review', agent_type: 'avsp_sol_high', depends_on: nodes.map(node => node.id) }];
      await writeFile(manifestPath, JSON.stringify({ task_id: taskId, workspace: fixture.workspace, workspace_claims: claims, goal: taskId, requirements: [{ id: 'R1', text: taskId }], nodes: completeNodes }));
      return manifestPath;
    };
    const invalidClaims = [
      ['empty', []], ['absolute', [{ mode: 'write', prefix: '/escape' }]], ['backslash', [{ mode: 'write', prefix: 'src\\a' }]], ['parent', [{ mode: 'write', prefix: '../a' }]], ['ignored', [{ mode: 'write', prefix: '.codex/x' }]], ['long', [{ mode: 'write', prefix: 'x'.repeat(1025) }]],
    ];
    if (process.platform !== 'linux') invalidClaims.push(
      ['codex-alias', [{ mode: 'write', prefix: '.CODEX/x' }]],
      ['git-alias', [{ mode: 'write', prefix: '.Git/x' }]],
      ['modules-alias', [{ mode: 'write', prefix: 'NODE_MODULES/x' }]],
    );
    if (process.platform === 'win32') invalidClaims.push(
      ['ads-alias', [{ mode: 'write', prefix: 'src:stream' }]],
      ['trailing-dot-alias', [{ mode: 'write', prefix: 'src./child' }]],
      ['reserved-device-alias', [{ mode: 'write', prefix: 'CON/child' }]],
      ['control-character-alias', [{ mode: 'write', prefix: 'bad\u0001name' }]],
      ['console-input-alias', [{ mode: 'write', prefix: 'CONIN$/child' }]],
      ['console-output-alias', [{ mode: 'write', prefix: 'CONOUT$/child' }]],
      ['superscript-com-alias', [{ mode: 'write', prefix: 'COM¹/child' }]],
      ['superscript-lpt-alias', [{ mode: 'write', prefix: 'LPT²/x' }]],
    );
    for (const [taskId, claims] of invalidClaims) {
      const manifest = await writeManifest(taskId, claims);
      await assert.rejects(() => dispatch('init', { state_dir: path.join(fixture.root, `${taskId}-state`), manifest }), /workspace_claim|Invalid workspace_claim/);
    }
    if (process.platform !== 'linux') {
      const rootBefore = await workspaceFingerprint(fixture.workspace, [{ mode: 'write', prefix: '.' }]);
      await mkdir(path.join(fixture.workspace, '.Git'), { recursive: true }); await writeFile(path.join(fixture.workspace, '.Git', 'ignored.txt'), 'ignored alias');
      assert.deepEqual(await workspaceFingerprint(fixture.workspace, [{ mode: 'write', prefix: '.' }]), rootBefore);
    }
    const readWork = await writeManifest('read-work', [{ mode: 'read', prefix: 'src' }]);
    await assert.rejects(() => dispatch('init', { state_dir: path.join(fixture.root, 'read-work-state'), manifest: readWork }), /at least one write claim/);
    const readOnly = await writeManifest('read-only', [{ mode: 'read', prefix: 'src' }], [{ id: 'evidence', kind: 'evidence', agent_type: 'avsp_luna_high', execution_risk: 'read_only', routing_reason: 'read', execution_owner: '/root/evidence', integration_owner: '/root', quality_guard: 'evidence' }]);
    await dispatch('init', { state_dir: path.join(fixture.root, 'read-only-state'), manifest: readOnly });
    const tooMany = await writeManifest('too-many', Array.from({ length: 129 }, (_, index) => ({ mode: 'read', prefix: `p${index}` })), [{ id: 'evidence', kind: 'evidence', agent_type: 'avsp_luna_high', execution_risk: 'read_only', routing_reason: 'read', execution_owner: '/root/evidence', integration_owner: '/root', quality_guard: 'evidence' }]);
    await assert.rejects(() => dispatch('init', { state_dir: path.join(fixture.root, 'too-many-state'), manifest: tooMany }), /128-claim limit/);
    const lateClaims = [{ mode: 'write', prefix: 'late/child' }];
    const before = await workspaceFingerprint(fixture.workspace, lateClaims);
    await mkdir(path.join(fixture.root, 'outside'));
    try { await fsPromises.symlink(path.join(fixture.root, 'outside'), path.join(fixture.workspace, 'late'), process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) {
      if (['EPERM', 'EACCES', 'UNKNOWN'].includes(error.code)) { t.skip(`cannot create test link: ${error.code}`); return; }
      throw error;
    }
    await assert.rejects(() => workspaceFingerprint(fixture.workspace, lateClaims), /symbolic link or reparse point/);
    await rm(path.join(fixture.workspace, 'late'), { recursive: true, force: true });
    await mkdir(path.join(fixture.workspace, 'late'), { recursive: true }); await mkdir(path.join(fixture.workspace, 'late', 'child'));
    await writeFile(path.join(fixture.workspace, 'late', 'child', 'created.txt'), 'created');
    assert.notDeepEqual(await workspaceFingerprint(fixture.workspace, lateClaims), before);
    const readOnlyState = await readControllerState(path.join(fixture.root, 'read-only-state'), 'read-only');
    const leasePath = path.join(fixture.workspace, '.codex', 'workflow-controller', 'workspace-lease.json');
    const timestamp = new Date().toISOString();
    const activeTasks = Array.from({ length: 65 }, (_, index) => ({ task_id: `task${index}`, state_path: path.join(fixture.root, 'registry', `task${index}.json`), state_dir: path.join(fixture.root, 'registry'), acquired_at: timestamp, phase: 'active', workspace_claims: [{ mode: 'read', prefix: `registry${index}` }] }));
    await writeFile(leasePath, JSON.stringify({ version: 2, workspace: readOnlyState.workspace, active_tasks: activeTasks, updated_at: timestamp }));
    const overfull = await writeManifest('overfull', [{ mode: 'write', prefix: 'overfull' }]);
    await assert.rejects(() => dispatch('init', { state_dir: path.join(fixture.root, 'overfull-state'), manifest: overfull }), /Unsupported workspace lease/);
    if (process.platform !== 'linux') {
      const storedAlias = {
        version: 2,
        workspace: readOnlyState.workspace,
        active_tasks: [{ task_id: 'stored-alias', state_path: path.join(fixture.root, 'registry', 'stored-alias.json'), state_dir: path.join(fixture.root, 'registry'), acquired_at: timestamp, phase: 'active', workspace_claims: [{ mode: 'write', prefix: '.CODEX' }] }],
        updated_at: timestamp,
      };
      await writeFile(leasePath, JSON.stringify(storedAlias));
      const storedAliasManifest = await writeManifest('stored-alias-check', [{ mode: 'write', prefix: 'stored-alias-check' }]);
      await assert.rejects(() => dispatch('init', { state_dir: path.join(fixture.root, 'stored-alias-check-state'), manifest: storedAliasManifest }), /Stored workspace_claim targets ignored or controller directory/);
      if (process.platform === 'win32') {
        for (const [taskId, prefix] of [['stored-control-character', 'bad\u0001name'], ['stored-console-input', 'CONIN$/child'], ['stored-console-output', 'CONOUT$/child'], ['stored-superscript-com', 'COM¹/child'], ['stored-superscript-lpt', 'LPT²/x']]) {
          storedAlias.active_tasks[0].workspace_claims = [{ mode: 'write', prefix }];
          await writeFile(leasePath, JSON.stringify(storedAlias));
          await assert.rejects(() => dispatch('init', { state_dir: path.join(fixture.root, `${taskId}-state`), manifest: storedAliasManifest }), /Stored workspace_claim prefix has an unsafe Windows path alias/);
        }
      }
    }
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('migrates claimless v1 active state to a root-write release', async () => {
  const fixture = await setup();
  try {
    await dispatch('init', { state_dir: fixture.stateDir, manifest: fixture.manifest });
    const state = await readControllerState(fixture.stateDir);
    delete state.workspace_claims; delete state.workspace_lease.workspace_claims;
    await writeControllerState(fixture.stateDir, state);
    const leasePath = path.join(fixture.workspace, '.codex', 'workflow-controller', 'workspace-lease.json');
    await writeFile(leasePath, JSON.stringify({ version: 1, workspace: state.workspace, active_task: { task_id: state.task_id, state_path: state.workspace_lease.state_path, state_dir: fixture.stateDir, acquired_at: state.workspace_lease.acquired_at, phase: 'active' }, updated_at: new Date().toISOString() }));
    await dispatch('release-workspace', { state_dir: fixture.stateDir, task_id: 'feature-1', previous_agents_stopped: true });
    const released = await readControllerState(fixture.stateDir);
    assert.deepEqual(released.workspace_claims, [{ mode: 'write', prefix: '.' }]);
    assert.deepEqual(released.workspace_lease.workspace_claims, [{ mode: 'write', prefix: '.' }]);
    const registry = JSON.parse(await readFile(leasePath, 'utf8'));
    assert.equal(registry.version, 2); assert.deepEqual(registry.active_tasks, []);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('allows only non-overlapping claim matrix entries and identifies tasks by state path', async () => {
  const fixture = await setup();
  try {
    const manifest = async (taskId, claims, readOnly = false) => {
      const manifestPath = path.join(fixture.root, `${taskId}-${claims[0].prefix.replaceAll('/', '-')}.json`);
      const node = readOnly
        ? { id: 'evidence', kind: 'evidence', agent_type: 'avsp_luna_high', execution_risk: 'read_only', routing_reason: 'read', execution_owner: `/root/${taskId}`, integration_owner: '/root', quality_guard: 'evidence' }
        : { id: 'work', kind: 'implementation', agent_type: 'avsp_terra_high' };
      await writeFile(manifestPath, JSON.stringify({ task_id: taskId, workspace: fixture.workspace, workspace_claims: claims, goal: taskId, requirements: [{ id: 'R1', text: taskId }], nodes: [node, { id: 'total-review', kind: 'total_review', agent_type: 'avsp_sol_high', depends_on: [node.id] }] }));
      return manifestPath;
    };
    const readSrc = await manifest('read-src', [{ mode: 'read', prefix: 'src' }], true);
    await dispatch('init', { state_dir: path.join(fixture.root, 'read-one'), manifest: readSrc });
    await dispatch('init', { state_dir: path.join(fixture.root, 'read-two'), manifest: readSrc });
    const writeSrc = await manifest('write-src', [{ mode: 'write', prefix: 'src' }]);
    await assert.rejects(() => dispatch('init', { state_dir: path.join(fixture.root, 'write-src'), manifest: writeSrc }), /claim conflicts/);
    await dispatch('release-workspace', { state_dir: path.join(fixture.root, 'read-one'), task_id: 'read-src', previous_agents_stopped: true });
    await dispatch('release-workspace', { state_dir: path.join(fixture.root, 'read-two'), task_id: 'read-src', previous_agents_stopped: true });
    const writeA = await manifest('write-a', [{ mode: 'write', prefix: 'src/a' }]); const writeAncestor = await manifest('write-ancestor', [{ mode: 'write', prefix: 'src' }]); const writeAb = await manifest('write-ab', [{ mode: 'write', prefix: 'src/ab' }]);
    await dispatch('init', { state_dir: path.join(fixture.root, 'write-a'), manifest: writeA });
    await assert.rejects(() => dispatch('init', { state_dir: path.join(fixture.root, 'write-ancestor'), manifest: writeAncestor }), /claim conflicts/);
    await dispatch('init', { state_dir: path.join(fixture.root, 'write-ab'), manifest: writeAb });
    const sameLeft = await manifest('same-id', [{ mode: 'write', prefix: 'same-left' }]); const sameRight = await manifest('same-id', [{ mode: 'write', prefix: 'same-right' }]);
    await dispatch('init', { state_dir: path.join(fixture.root, 'same-left'), manifest: sameLeft });
    await dispatch('init', { state_dir: path.join(fixture.root, 'same-right'), manifest: sameRight });
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('prunes released pre-v2 v1 states that predate verification history', async () => {
  const fixture = await setup();
  try {
    await writeFile(fixture.manifest, JSON.stringify({ task_id: 'feature-1', workspace: fixture.workspace, goal: 'Retain legacy pruning compatibility', routing_schema_version: 1, requirements: [{ id: 'R1', text: 'legacy released state can expire' }], nodes: [{ id: 'work', kind: 'implementation', execution_risk: 'protected', routing_reason: 'legacy compatibility fixture', execution_owner: '/root/work', integration_owner: '/root', quality_guard: 'test' }, { id: 'total-review', kind: 'total_review', agent_type: 'avsp_sol_high', depends_on: ['work'], execution_risk: 'protected', routing_reason: 'legacy compatibility fixture', execution_owner: '/root/reviewer', integration_owner: '/root', quality_guard: 'test' }] }));
    await dispatch('init', { state_dir: fixture.stateDir, manifest: fixture.manifest });
    await dispatch('release-workspace', { state_dir: fixture.stateDir, task_id: 'feature-1', previous_agents_stopped: true });
    const state = await readControllerState(fixture.stateDir);
    state.nodes.work.kind = 'quality_review';
    for (const field of ['assurance_level', 'assurance_assessment', 'repair_records', 'verification_record', 'verification_history']) delete state[field];
    for (const node of Object.values(state.nodes)) {
      for (const field of ['review_stage', 'attempt_budget_used', 'unavailable_attempts']) delete node[field];
    }
    delete state.workspace_claims;
    delete state.workspace_lease.workspace_claims;
    state.updated_at = '1970-01-01T00:00:00.000Z';
    await writeControllerState(fixture.stateDir, state);
    const leasePath = path.join(fixture.workspace, '.codex', 'workflow-controller', 'workspace-lease.json');
    await writeFile(leasePath, JSON.stringify({ version: 1, workspace: state.workspace, active_task: null, updated_at: new Date().toISOString() }));
    await rm(path.join(fixture.workspace, '.codex-workflow-controller-authority.json'));
    const [readable] = await dispatch('status', { state_dir: fixture.stateDir, task_id: 'feature-1' });
    assert.equal(readable.nodes.find(node => node.id === 'work').kind, 'quality_review');
    const [pruned] = await dispatch('prune-expired', { state_dir: fixture.stateDir });
    assert.deepEqual(pruned.deleted.map(item => item.task_id), ['feature-1']);
    await assert.rejects(() => readControllerState(fixture.stateDir), /does not exist/);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('keeps quality_review as an ordinary node kind in v1 workflows', async () => {
  const fixture = await setup();
  try {
    const call = (command, parameters) => callForFixture(fixture, command, parameters);
    const ordinaryRoute = { execution_risk: 'read_only', routing_reason: 'legacy arbitrary node kind', execution_owner: '/root/ordinary-quality-node', integration_owner: '/root', quality_guard: 'evidence' };
    const reviewRoute = { execution_risk: 'read_only', routing_reason: 'terminal review', execution_owner: '/root/terminal-review', integration_owner: '/root', quality_guard: 'review' };
    await writeFile(fixture.manifest, JSON.stringify({ task_id: 'feature-1', workspace: fixture.workspace, goal: 'Preserve v1 node kind semantics', routing_schema_version: 1, requirements: [{ id: 'R1', text: 'quality_review remains an ordinary v1 kind' }], nodes: [{ id: 'ordinary', kind: 'quality_review', ...ordinaryRoute }, { id: 'total-review', kind: 'total_review', depends_on: ['ordinary'], ...reviewRoute }] }));
    const [initialized] = await call('init', { manifest: fixture.manifest });
    const ordinary = initialized.task.nodes.find(node => node.id === 'ordinary');
    assert.equal(ordinary.agent_type, 'avsp_luna_high');
    assert.equal(ordinary.review_stage, null);
    const [started] = await call('start', { task_id: 'feature-1', node_id: 'ordinary', agent_task_path: '/root/ordinary-quality-node', agent_role: 'avsp_luna_high', native_agent_started: true });
    const result = path.join(fixture.root, 'ordinary-quality-node.json');
    await writeFile(result, JSON.stringify({ evidence: 'complete' }));
    await call('complete', { task_id: 'feature-1', node_id: 'ordinary', claim_id: started.node.claim_id, status: 'succeeded', result, completion_attestation: 'native_agent_finished' });
    const [ready] = await call('ready', { task_id: 'feature-1' });
    assert.deepEqual(ready.ready_nodes.map(node => node.id), ['total-review']);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
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

test('fails closed when a v2 registry exists without a workspace authority', async () => {
  const fixture = await setup();
  try {
    const workspace = await fsPromises.realpath(fixture.workspace); const statePath = path.join(fixture.stateDir, 'feature-1.json'); const registryPath = path.join(workspace, '.codex', 'workflow-controller', 'workspace-lease.json'); const timestamp = new Date().toISOString();
    await mkdir(path.dirname(registryPath), { recursive: true });
    await writeFile(registryPath, JSON.stringify({ version: 2, workspace, active_tasks: [{ task_id: 'feature-1', state_path: statePath, state_dir: fixture.stateDir, acquired_at: timestamp, phase: 'initializing', workspace_claims: [{ mode: 'write', prefix: 'reserved' }] }], updated_at: timestamp }));
    const disjointManifest = path.join(fixture.root, 'disjoint.json'); await writeFile(disjointManifest, JSON.stringify({ task_id: 'feature-1', workspace: fixture.workspace, workspace_claims: [{ mode: 'write', prefix: 'new-scope' }], goal: 'retry after reconciliation', requirements: [{ id: 'R1', text: 'recover init' }], nodes: [{ id: 'total-review', kind: 'total_review', agent_type: 'avsp_sol_high', depends_on: [] }] }));
    await assert.rejects(() => dispatch('init', { state_dir: fixture.stateDir, manifest: disjointManifest }), /Cannot create workspace lease authority for an existing non-legacy registry/);
    await assert.rejects(() => readControllerState(fixture.stateDir), /does not exist/);
    const before = JSON.parse(await readFile(registryPath, 'utf8')); assert.equal(before.active_tasks.length, 1); assert.equal(before.active_tasks[0].phase, 'initializing');
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('does not create an authority from a malformed v1 registry', async () => {
  const fixture = await setup();
  try {
    const workspace = await fsPromises.realpath(fixture.workspace); const statePath = path.join(fixture.stateDir, 'feature-1.json'); const registryPath = path.join(workspace, '.codex', 'workflow-controller', 'workspace-lease.json'); const authorityPath = path.join(workspace, '.codex-workflow-controller-authority.json'); const timestamp = new Date().toISOString();
    await mkdir(path.dirname(registryPath), { recursive: true });
    await writeFile(registryPath, JSON.stringify({ version: 1, workspace, active_task: { task_id: 'feature-1', state_path: statePath, acquired_at: timestamp, unexpected: true }, updated_at: timestamp }));
    await assert.rejects(() => dispatch('init', { state_dir: fixture.stateDir, manifest: fixture.manifest }), /Cannot create workspace lease authority for an invalid legacy registry/);
    await assert.rejects(() => readFile(authorityPath, 'utf8'), /ENOENT/);
    assert.equal(JSON.parse(await readFile(registryPath, 'utf8')).active_task.unexpected, true);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('reconciles an interrupted initialization without allowing an unregistered task to run', async () => {
  const fixture = await setup();
  try {
    await dispatch('init', { state_dir: fixture.stateDir, manifest: fixture.manifest });
    const leasePath = path.join(fixture.workspace, '.codex', 'workflow-controller', 'workspace-lease.json');
    const lease = JSON.parse(await readFile(leasePath, 'utf8'));
    lease.active_tasks[0].phase = 'initializing';
    await writeFile(leasePath, JSON.stringify(lease));
    await assert.rejects(() => dispatch('claim', { state_dir: fixture.stateDir, task_id: 'feature-1', node_id: 'implement', agent_task_path: '/root/blocked', agent_role: 'avsp_terra_high' }), /does not belong to this active task/);
    const [reconciled] = await dispatch('reconcile-workspace', { workspace: fixture.workspace, task_id: 'feature-1', state_dir: fixture.stateDir });
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
    const [reconciled] = await dispatch('reconcile-workspace', { workspace: fixture.workspace, task_id: 'feature-1', state_dir: fixture.stateDir });
    assert.equal(reconciled.action, 'cleared_released_initialization');
    assert.deepEqual(JSON.parse(await readFile(leasePath, 'utf8')).active_tasks, []);
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

test('retains a released state whenever another lease identity owns its physical state path', async () => {
  const fixture = await setup();
  try {
    await dispatch('init', { state_dir: fixture.stateDir, manifest: fixture.manifest });
    await dispatch('release-workspace', { state_dir: fixture.stateDir, task_id: 'feature-1', previous_agents_stopped: true });
    const statePath = await canonicalStateFile(fixture.stateDir, 'feature-1'); const stateDir = await fsPromises.realpath(fixture.stateDir);
    const leasePath = path.join(fixture.workspace, '.codex', 'workflow-controller', 'workspace-lease.json');
    const artifact = path.join(fixture.stateDir, '.workflow-review-results', 'feature-1', 'claim', 'outcome.json'); await mkdir(path.dirname(artifact), { recursive: true }); await writeFile(artifact, 'review artifact');
    const released = await readControllerState(fixture.stateDir); released.updated_at = '1970-01-01T00:00:00.000Z'; await writeControllerState(fixture.stateDir, released);
    for (const [taskId, phase, acquiredAt] of [['peer-initializing', 'initializing', '2001-01-01T00:00:00.000Z'], ['peer-active', 'active', '2002-01-01T00:00:00.000Z']]) {
      await writeFile(leasePath, JSON.stringify({ version: 2, workspace: released.workspace, active_tasks: [{ task_id: taskId, state_path: statePath, state_dir: stateDir, state_parent_authority: released.workspace_lease.state_parent_authority, acquired_at: acquiredAt, phase, workspace_claims: [{ mode: 'write', prefix: `peer-${phase}` }] }], updated_at: new Date().toISOString() }));
      await assert.rejects(() => dispatch('release-workspace', { state_dir: fixture.stateDir, task_id: 'feature-1', previous_agents_stopped: true }), /another active task identity/);
      const [closed, closeCode] = await dispatch('close-check', { state_dir: fixture.stateDir, task_id: 'feature-1' }); assert.equal(closeCode, 2); assert.match(closed.workspace_lease.reason, /another active task identity/);
      const [doctor] = await dispatch('doctor', { state_dir: fixture.stateDir, task_id: 'feature-1' }); assert.equal(doctor.checks.find(check => check.id === 'workspace_lease').status, 'fail');
      const [pruned] = await dispatch('prune-expired', { state_dir: fixture.stateDir }); assert.equal(pruned.deleted_count, 0); assert.match(pruned.retained[0].reason, /(state-path owner|active state path)/);
      assert.equal((await readControllerState(fixture.stateDir)).task_id, 'feature-1'); assert.equal(await readFile(artifact, 'utf8'), 'review artifact');
      const registry = JSON.parse(await readFile(leasePath, 'utf8')); assert.deepEqual(registry.active_tasks.map(entry => [entry.task_id, entry.acquired_at, entry.phase]), [[taskId, acquiredAt, phase]]);
    }
    await writeFile(leasePath, JSON.stringify({ version: 2, workspace: released.workspace, active_tasks: [{ task_id: 'feature-1', state_path: statePath, state_dir: stateDir, state_parent_authority: released.workspace_lease.state_parent_authority, acquired_at: released.workspace_lease.acquired_at, phase: 'active', workspace_claims: released.workspace_claims }], updated_at: new Date().toISOString() }));
    const [selfHealed, selfHealCode] = await dispatch('close-check', { state_dir: fixture.stateDir, task_id: 'feature-1' }); assert.equal(selfHealCode, 2); assert.equal(selfHealed.workspace_lease.self_healed, true); assert.deepEqual(JSON.parse(await readFile(leasePath, 'utf8')).active_tasks, []);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('Windows quarantine preflight retains every source when a full authority path is too long', { skip: process.platform !== 'win32' }, async () => {
  const fixture = await setup();
  try {
    const stateDir = path.join(fixture.root, 'q'.repeat(128)); await mkdir(stateDir);
    await dispatch('init', { state_dir: stateDir, manifest: fixture.manifest });
    await dispatch('release-workspace', { state_dir: stateDir, task_id: 'feature-1', previous_agents_stopped: true });
    const artifact = path.join(stateDir, '.workflow-review-results', 'feature-1', 'claim', 'outcome.json'); await mkdir(path.dirname(artifact), { recursive: true }); await writeFile(artifact, 'review artifact');
    const state = await readControllerState(stateDir); state.future_state_field = true; state.updated_at = '1970-01-01T00:00:00.000Z'; await writeControllerState(stateDir, state);
    await assert.rejects(() => dispatch('prune-expired', { state_dir: stateDir }), /Quarantine path exceeds the Windows path limit/);
    await readControllerState(stateDir); assert.equal(await readFile(artifact, 'utf8'), 'review artifact');
    await assert.rejects(() => fsPromises.access(path.join(stateDir, '.workflow-errors')), error => error?.code === 'ENOENT');
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('Windows state path aliases share one physical lease identity', { skip: process.platform !== 'win32' }, async t => {
  const fixture = await setup();
  try {
    const stateDir = path.join(fixture.root, 'identity-state'); await mkdir(stateDir);
    const alias = stateDir.toUpperCase();
    const physical = await fsPromises.realpath(stateDir);
    if ((await fsPromises.realpath(alias)).toLocaleLowerCase('und') !== physical.toLocaleLowerCase('und')) return t.skip('the test volume is case-sensitive');
    const manifest = path.join(fixture.root, 'identity.json');
    await writeFile(manifest, JSON.stringify({ task_id: 'identity-task', workspace: fixture.workspace, workspace_claims: [{ mode: 'write', prefix: 'identity' }], goal: 'physical identity', requirements: [{ id: 'R1', text: 'identity' }], nodes: [{ id: 'total-review', kind: 'total_review', agent_type: 'avsp_sol_high', depends_on: [] }] }));
    await dispatch('init', { state_dir: stateDir, manifest });
    await assert.rejects(() => dispatch('init', { state_dir: alias, manifest }), /state path already has an active lease entry/);
    const lease = JSON.parse(await readFile(path.join(fixture.workspace, '.codex', 'workflow-controller', 'workspace-lease.json'), 'utf8'));
    assert.equal(lease.active_tasks[0].state_dir, physical);
    const state = await readControllerState(stateDir, 'identity-task'); state.future_state_field = true; state.updated_at = '1970-01-01T00:00:00.000Z'; await writeControllerState(stateDir, state, 'identity-task');
    const [pruned] = await dispatch('prune-expired', { state_dir: alias });
    assert.equal(pruned.quarantined_count, 0); assert.match(pruned.retained[0].reason, /active/);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('Windows task id case aliases cannot transfer active review artifacts', { skip: process.platform !== 'win32' }, async () => {
  const fixture = await setup();
  try {
    await writeFile(fixture.manifest, JSON.stringify({ task_id: 'feature-1', workspace: fixture.workspace, goal: 'case alias prune', routing_schema_version: 1, requirements: [{ id: 'R1', text: 'protect review owner' }], nodes: [{ id: 'work', kind: 'implementation', execution_risk: 'protected', routing_reason: 'controlled test', execution_owner: '/root/case-work', integration_owner: '/root', quality_guard: 'test' }, { id: 'total-review', kind: 'total_review', agent_type: 'avsp_sol_high', depends_on: ['work'], execution_risk: 'protected', routing_reason: 'controlled test', execution_owner: '/root/case-review', integration_owner: '/root', quality_guard: 'test' }] }));
    await dispatch('init', { state_dir: fixture.stateDir, manifest: fixture.manifest });
    await dispatch('release-workspace', { state_dir: fixture.stateDir, task_id: 'feature-1', previous_agents_stopped: true });
    const state = await readControllerState(fixture.stateDir);
    state.updated_at = '1970-01-01T00:00:00.000Z'; await writeControllerState(fixture.stateDir, state);
    const artifact = path.join(fixture.stateDir, '.workflow-review-results', 'feature-1', 'claim', 'outcome.json');
    await mkdir(path.dirname(artifact), { recursive: true }); await writeFile(artifact, 'review');
    const leasePath = path.join(fixture.workspace, '.codex', 'workflow-controller', 'workspace-lease.json');
    const lease = JSON.parse(await readFile(leasePath, 'utf8')); const physicalStateDir = await fsPromises.realpath(fixture.stateDir);
    lease.active_tasks = [{ task_id: 'FEATURE-1', state_path: path.join(physicalStateDir, 'alias-owner.json'), state_dir: physicalStateDir, acquired_at: new Date().toISOString(), phase: 'active', workspace_claims: [{ mode: 'read', prefix: 'peer' }] }];
    lease.updated_at = new Date().toISOString(); await writeFile(leasePath, JSON.stringify(lease));
    const [pruned] = await dispatch('prune-expired', { state_dir: fixture.stateDir });
    assert.equal(pruned.deleted_count, 0); assert.match(pruned.retained[0].reason, /cleanup source overlaps an active workspace lease entry/);
    state.future_state_field = true; await writeControllerState(fixture.stateDir, state);
    const [quarantine] = await dispatch('prune-expired', { state_dir: fixture.stateDir });
    assert.equal(quarantine.quarantined_count, 0); assert.match(quarantine.retained[0].reason, /active workspace lease entry/);
    assert.equal((await readControllerState(fixture.stateDir)).task_id, 'feature-1'); assert.equal(await readFile(artifact, 'utf8'), 'review');
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('normal prune retains an active peer state nested below the candidate review tree', async () => {
  const fixture = await setup();
  try {
    await writeFile(fixture.manifest, JSON.stringify({ task_id: 'feature-1', workspace: fixture.workspace, goal: 'nested peer prune', routing_schema_version: 1, requirements: [{ id: 'R1', text: 'protect nested peer' }], nodes: [{ id: 'work', kind: 'implementation', execution_risk: 'protected', routing_reason: 'controlled test', execution_owner: '/root/nested-work', integration_owner: '/root', quality_guard: 'test' }, { id: 'total-review', kind: 'total_review', agent_type: 'avsp_sol_high', depends_on: ['work'], execution_risk: 'protected', routing_reason: 'controlled test', execution_owner: '/root/nested-review', integration_owner: '/root', quality_guard: 'test' }] }));
    await dispatch('init', { state_dir: fixture.stateDir, manifest: fixture.manifest });
    await dispatch('release-workspace', { state_dir: fixture.stateDir, task_id: 'feature-1', previous_agents_stopped: true });
    const state = await readControllerState(fixture.stateDir); state.updated_at = '1970-01-01T00:00:00.000Z'; await writeControllerState(fixture.stateDir, state);
    const peerStateDir = path.join(fixture.stateDir, '.workflow-review-results', 'feature-1', 'peer-state'); const peerManifest = path.join(fixture.root, 'nested-peer.json');
    await writeFile(peerManifest, JSON.stringify({ task_id: 'peer-task', workspace: fixture.workspace, workspace_claims: [{ mode: 'write', prefix: 'peer' }], goal: 'nested peer', requirements: [{ id: 'R1', text: 'retain peer' }], nodes: [{ id: 'total-review', kind: 'total_review', agent_type: 'avsp_sol_high', depends_on: [] }] }));
    await dispatch('init', { state_dir: peerStateDir, manifest: peerManifest });
    const [pruned] = await dispatch('prune-expired', { state_dir: fixture.stateDir });
    assert.equal(pruned.deleted_count, 0); assert.match(pruned.retained[0].reason, /cleanup source overlaps an active workspace lease entry/);
    assert.equal((await readControllerState(fixture.stateDir)).task_id, 'feature-1'); assert.equal((await readControllerState(peerStateDir, 'peer-task')).task_id, 'peer-task');
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('Windows nested review artifact junction blocks quarantine without moving sources', { skip: process.platform !== 'win32' }, async t => {
  const fixture = await setup();
  try {
    await dispatch('init', { state_dir: fixture.stateDir, manifest: fixture.manifest });
    await dispatch('release-workspace', { state_dir: fixture.stateDir, task_id: 'feature-1', previous_agents_stopped: true });
    const state = await readControllerState(fixture.stateDir);
    state.future_state_field = true; state.updated_at = '1970-01-01T00:00:00.000Z'; await writeControllerState(fixture.stateDir, state);
    const artifactRoot = path.join(fixture.stateDir, '.workflow-review-results', 'feature-1'); const outside = path.join(fixture.root, 'outside-review');
    await mkdir(path.join(artifactRoot, 'claim'), { recursive: true }); await mkdir(outside); await writeFile(path.join(artifactRoot, 'claim', 'outcome.json'), 'review'); await writeFile(path.join(outside, 'outside.txt'), 'outside');
    try { await fsPromises.symlink(outside, path.join(artifactRoot, 'claim', 'nested'), 'junction'); }
    catch (error) {
      if (['EPERM', 'EACCES', 'UNKNOWN'].includes(error.code)) return t.skip(`junction unavailable: ${error.code}`);
      throw error;
    }
    await assert.rejects(() => dispatch('prune-expired', { state_dir: fixture.stateDir }), /review artifact source is unsafe/);
    assert.equal((await readControllerState(fixture.stateDir)).task_id, 'feature-1');
    assert.equal(await readFile(path.join(artifactRoot, 'claim', 'outcome.json'), 'utf8'), 'review'); assert.equal(await readFile(path.join(outside, 'outside.txt'), 'utf8'), 'outside');
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('Windows junction state aliases cannot bypass active ownership', { skip: process.platform !== 'win32' }, async t => {
  const fixture = await setup();
  try {
    const target = path.join(fixture.root, 'junction-target'); const alias = path.join(fixture.root, 'junction-alias'); await mkdir(target);
    try { await fsPromises.symlink(target, alias, 'junction'); }
    catch (error) {
      if (['EPERM', 'EACCES', 'UNKNOWN'].includes(error.code)) return t.skip(`junction unavailable: ${error.code}`);
      throw error;
    }
    const manifest = path.join(fixture.root, 'junction.json');
    await writeFile(manifest, JSON.stringify({ task_id: 'junction-task', workspace: fixture.workspace, workspace_claims: [{ mode: 'write', prefix: 'junction' }], goal: 'junction identity', requirements: [{ id: 'R1', text: 'junction' }], nodes: [{ id: 'total-review', kind: 'total_review', agent_type: 'avsp_sol_high', depends_on: [] }] }));
    await dispatch('init', { state_dir: target, manifest });
    await assert.rejects(() => dispatch('init', { state_dir: alias, manifest }), /state path already has an active lease entry/);
    const state = await readControllerState(target, 'junction-task'); state.future_state_field = true; state.updated_at = '1970-01-01T00:00:00.000Z'; await writeControllerState(target, state, 'junction-task');
    const [pruned] = await dispatch('prune-expired', { state_dir: alias });
    assert.equal(pruned.quarantined_count, 0); assert.match(pruned.retained[0].reason, /active/);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('workspace lease authority rejects a replaced physical registry directory', async () => {
  const fixture = await setup();
  try {
    await dispatch('init', { state_dir: fixture.stateDir, manifest: fixture.manifest });
    const controlDirectory = path.join(fixture.workspace, '.codex', 'workflow-controller'); const displaced = path.join(fixture.workspace, '.codex', 'workflow-controller-displaced');
    await rename(controlDirectory, displaced); await mkdir(controlDirectory);
    await assert.rejects(() => dispatch('claim', { state_dir: fixture.stateDir, task_id: 'feature-1', node_id: 'implement', agent_task_path: '/root/replaced-control', agent_role: 'avsp_terra_high' }), /control directory identity changed/);
    assert.equal((await readControllerState(fixture.stateDir)).nodes.implement.status, 'pending');
    const secondManifest = path.join(fixture.root, 'replacement-task.json'); const secondStateDir = path.join(fixture.root, 'replacement-state');
    await writeFile(secondManifest, JSON.stringify({ task_id: 'replacement-task', workspace: fixture.workspace, workspace_claims: [{ mode: 'write', prefix: '.' }], goal: 'must not split registry', requirements: [{ id: 'R1', text: 'retain original registry authority' }], nodes: [{ id: 'total-review', kind: 'total_review', agent_type: 'avsp_sol_high', depends_on: [] }] }));
    await assert.rejects(() => dispatch('init', { state_dir: secondStateDir, manifest: secondManifest }), /control directory identity changed/);
    const originalLease = JSON.parse(await readFile(path.join(displaced, 'workspace-lease.json'), 'utf8'));
    assert.ok(originalLease.active_tasks.some(entry => entry.task_id === 'feature-1'));
    await assert.rejects(() => readFile(path.join(controlDirectory, 'workspace-lease.json'), 'utf8'), /ENOENT/);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('rejects a cross-call state directory replacement before mutating the copied peer state', async () => {
  const fixture = await setup();
  try {
    await dispatch('init', { state_dir: fixture.stateDir, manifest: fixture.manifest });
    const displaced = path.join(fixture.root, 'state-displaced');
    const database = path.join(fixture.stateDir, 'feature-1.sqlite');
    await rename(fixture.stateDir, displaced);
    await mkdir(fixture.stateDir);
    await fsPromises.copyFile(path.join(displaced, 'feature-1.sqlite'), database);
    const peerBefore = await readFile(database);
    await assert.rejects(
      () => dispatch('claim', { state_dir: fixture.stateDir, task_id: 'feature-1', node_id: 'implement', agent_task_path: '/root/rebound-state', agent_role: 'avsp_terra_high' }),
      /Controller state parent changed/,
    );
    assert.deepEqual(await readFile(database), peerBefore);
    await assert.rejects(() => readFile(path.join(fixture.stateDir, '.workflow-prune-sweep.json')), /ENOENT/);
    assert.equal((await readControllerState(fixture.stateDir)).nodes.implement.status, 'pending');
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('rejects a cross-call state directory replacement during close and prune without deleting the peer', async () => {
  const fixture = await setup();
  try {
    await writeFile(fixture.manifest, JSON.stringify({ task_id: 'feature-1', workspace: fixture.workspace, workspace_claims: [{ mode: 'write', prefix: '.' }], goal: 'retain peer state', routing_schema_version: 1, requirements: [{ id: 'R1', text: 'state directory authority remains bound' }], nodes: [{ id: 'total-review', kind: 'total_review', agent_type: 'avsp_sol_high', execution_risk: 'protected', routing_reason: 'controlled regression', execution_owner: '/root/reviewer', integration_owner: '/root', quality_guard: 'test' }] }));
    await dispatch('init', { state_dir: fixture.stateDir, manifest: fixture.manifest });
    await dispatch('release-workspace', { state_dir: fixture.stateDir, task_id: 'feature-1', previous_agents_stopped: true });
    const displaced = path.join(fixture.root, 'released-state-displaced');
    const database = path.join(fixture.stateDir, 'feature-1.sqlite');
    await rename(fixture.stateDir, displaced);
    await mkdir(fixture.stateDir);
    await fsPromises.copyFile(path.join(displaced, 'feature-1.sqlite'), database);
    const peerBefore = await readFile(database);
    assert.equal((await readControllerState(fixture.stateDir)).workspace_lease.status, 'released');
    await assert.rejects(() => dispatch('close-check', { state_dir: fixture.stateDir, task_id: 'feature-1' }), /Controller state parent changed/);
    assert.deepEqual(await readFile(database), peerBefore);
    const expiredPeer = await readControllerState(fixture.stateDir);
    expiredPeer.updated_at = '1970-01-01T00:00:00.000Z';
    await writeControllerState(fixture.stateDir, expiredPeer);
    const peerBeforePrune = await readFile(database);
    const [pruned] = await dispatch('prune-expired', { state_dir: fixture.stateDir });
    assert.equal(pruned.deleted_count, 0);
    assert.ok(pruned.retained.length);
    assert.match(pruned.retained[0].reason, /Controller state parent changed/);
    assert.deepEqual(await readFile(database), peerBeforePrune);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('does not adopt a replacement peer when active state and registry entry lack a state parent authority', async () => {
  const fixture = await setup();
  try {
    await dispatch('init', { state_dir: fixture.stateDir, manifest: fixture.manifest });
    const legacyState = await readControllerState(fixture.stateDir);
    delete legacyState.workspace_lease.state_parent_authority;
    await writeControllerState(fixture.stateDir, legacyState);
    await writeLeaseForTest(fixture.workspace, lease => { delete lease.active_tasks[0].state_parent_authority; });
    const displaced = path.join(fixture.root, 'anchorless-active-displaced');
    const database = path.join(fixture.stateDir, 'feature-1.sqlite');
    await rename(fixture.stateDir, displaced); await mkdir(fixture.stateDir);
    await fsPromises.copyFile(path.join(displaced, 'feature-1.sqlite'), database);
    const peerBefore = await readFile(database);
    const leasePath = path.join(fixture.workspace, '.codex', 'workflow-controller', 'workspace-lease.json');
    const leaseBefore = await readFile(leasePath);
    await assert.rejects(() => dispatch('claim', { state_dir: fixture.stateDir, task_id: 'feature-1', node_id: 'implement', agent_task_path: '/root/anchorless-peer', agent_role: 'avsp_terra_high' }), /parent authority is missing; controlled recovery is required/);
    await assert.rejects(() => dispatch('release-workspace', { state_dir: fixture.stateDir, task_id: 'feature-1', previous_agents_stopped: true }), /parent authority is missing; controlled recovery is required/);
    await assert.rejects(() => dispatch('reconcile-workspace', { workspace: fixture.workspace, task_id: 'feature-1', state_dir: fixture.stateDir }), /parent authority is missing; controlled recovery is required/);
    const [diagnosis] = await dispatch('doctor', { state_dir: fixture.stateDir, task_id: 'feature-1' });
    assert.equal(diagnosis.health, 'blocked');
    assert.equal(diagnosis.checks.find(check => check.id === 'state_parent_authority').status, 'fail');
    assert.deepEqual(await readFile(database), peerBefore);
    assert.deepEqual(await readFile(leasePath), leaseBefore);
    assert.equal((await readControllerState(fixture.stateDir)).workspace_lease.state_parent_authority, undefined);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('does not close or prune a replacement peer when a released state lacks a state parent authority', async () => {
  const fixture = await setup();
  try {
    await writeFile(fixture.manifest, JSON.stringify({ task_id: 'feature-1', workspace: fixture.workspace, workspace_claims: [{ mode: 'write', prefix: '.' }], goal: 'retain missing-anchor peer', routing_schema_version: 1, requirements: [{ id: 'R1', text: 'released state is not adopted' }], nodes: [{ id: 'total-review', kind: 'total_review', agent_type: 'avsp_sol_high', execution_risk: 'protected', routing_reason: 'controlled regression', execution_owner: '/root/reviewer', integration_owner: '/root', quality_guard: 'test' }] }));
    await dispatch('init', { state_dir: fixture.stateDir, manifest: fixture.manifest });
    await dispatch('release-workspace', { state_dir: fixture.stateDir, task_id: 'feature-1', previous_agents_stopped: true });
    const legacyState = await readControllerState(fixture.stateDir);
    delete legacyState.workspace_lease.state_parent_authority;
    legacyState.updated_at = '1970-01-01T00:00:00.000Z';
    await writeControllerState(fixture.stateDir, legacyState);
    const displaced = path.join(fixture.root, 'anchorless-released-displaced');
    const database = path.join(fixture.stateDir, 'feature-1.sqlite');
    await rename(fixture.stateDir, displaced); await mkdir(fixture.stateDir);
    await fsPromises.copyFile(path.join(displaced, 'feature-1.sqlite'), database);
    const peerBefore = await readFile(database);
    await assert.rejects(() => dispatch('close-check', { state_dir: fixture.stateDir, task_id: 'feature-1' }), /parent authority is missing; controlled recovery is required/);
    const [pruned] = await dispatch('prune-expired', { state_dir: fixture.stateDir });
    assert.equal(pruned.deleted_count, 0);
    assert.equal(pruned.quarantined_count, 0);
    assert.match(pruned.retained[0].reason, /workspace lease is not a complete released state/);
    const [diagnosis] = await dispatch('doctor', { state_dir: fixture.stateDir, task_id: 'feature-1' });
    assert.equal(diagnosis.health, 'blocked');
    assert.equal(diagnosis.checks.find(check => check.id === 'state_parent_authority').status, 'fail');
    assert.deepEqual(await readFile(database), peerBefore);
    assert.equal((await readControllerState(fixture.stateDir)).workspace_lease.state_parent_authority, undefined);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('does not reconcile an initializing entry without its persisted state parent authority', async () => {
  const fixture = await setup();
  try {
    await dispatch('init', { state_dir: fixture.stateDir, manifest: fixture.manifest });
    const state = await readControllerState(fixture.stateDir);
    delete state.workspace_lease.state_parent_authority;
    await writeControllerState(fixture.stateDir, state);
    const leasePath = await writeLeaseForTest(fixture.workspace, lease => {
      delete lease.active_tasks[0].state_parent_authority;
      lease.active_tasks[0].phase = 'initializing';
    });
    const stateBefore = await readFile(path.join(fixture.stateDir, 'feature-1.sqlite'));
    const leaseBefore = await readFile(leasePath);
    await assert.rejects(() => dispatch('reconcile-workspace', { workspace: fixture.workspace, task_id: 'feature-1', state_dir: fixture.stateDir }), /parent authority is missing; controlled recovery is required/);
    assert.deepEqual(await readFile(path.join(fixture.stateDir, 'feature-1.sqlite')), stateBefore);
    assert.deepEqual(await readFile(leasePath), leaseBefore);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('registry publication preserves the established workspace and control authority', async () => {
  const fixture = await setup();
  try {
    await writeFile(fixture.manifest, JSON.stringify({ task_id: 'feature-1', workspace: fixture.workspace, workspace_claims: [{ mode: 'write', prefix: 'feature-a' }], goal: 'retain prior authority', requirements: [{ id: 'R1', text: 'publication remains in one control tree' }], nodes: [{ id: 'total-review', kind: 'total_review', agent_type: 'avsp_sol_high', depends_on: [] }] }));
    await dispatch('init', { state_dir: fixture.stateDir, manifest: fixture.manifest });
    const authorityPath = path.join(fixture.workspace, '.codex-workflow-controller-authority.json'); const before = JSON.parse(await readFile(authorityPath, 'utf8'));
    const controlDirectory = path.join(fixture.workspace, '.codex', 'workflow-controller'); const leasePath = path.join(controlDirectory, 'workspace-lease.json');
    const secondManifest = path.join(fixture.root, 'publication-second.json'); const secondStateDir = path.join(fixture.root, 'publication-second-state');
    await writeFile(secondManifest, JSON.stringify({ task_id: 'feature-2', workspace: fixture.workspace, workspace_claims: [{ mode: 'write', prefix: 'feature-b' }], goal: 'must not adopt replacement control', requirements: [{ id: 'R2', text: 'replacement remains unauthorized' }], nodes: [{ id: 'total-review', kind: 'total_review', agent_type: 'avsp_sol_high', depends_on: [] }] }));
    await dispatch('init', { state_dir: secondStateDir, manifest: secondManifest });
    const after = JSON.parse(await readFile(authorityPath, 'utf8')); const registryMetadata = await fsPromises.lstat(leasePath, { bigint: true });
    assert.deepEqual(after.workspace_identity, before.workspace_identity);
    assert.deepEqual(after.control_identity, before.control_identity);
    assert.equal(after.control_real_path, before.control_real_path);
    assert.deepEqual(after.registry_identity, { dev: registryMetadata.dev.toString(), ino: registryMetadata.ino.toString() });
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('keeps publication recovery locked and read-only diagnosis does not mutate the journal', async () => {
  const fixture = await setup();
  try {
    await dispatch('init', { state_dir: fixture.stateDir, manifest: fixture.manifest });
    const workspace = await fsPromises.realpath(fixture.workspace);
    const authorityPath = path.join(workspace, '.codex-workflow-controller-authority.json');
    const leasePath = path.join(workspace, '.codex', 'workflow-controller', 'workspace-lease.json');
    const priorAuthority = JSON.parse(await readFile(authorityPath, 'utf8'));
    const replacement = JSON.parse(await readFile(leasePath, 'utf8'));
    replacement.updated_at = new Date(Date.now() + 1_000).toISOString();
    const intentPath = `${authorityPath}.publication.json`;
    await writeFile(intentPath, JSON.stringify({ version: 1, workspace, authority_path: authorityPath, registry_path: leasePath, prior_authority: priorAuthority, lease: replacement }));
    await rename(leasePath, `${leasePath}.prior`); await writeFile(leasePath, JSON.stringify(replacement));
    await dispatch('doctor', { state_dir: fixture.stateDir, task_id: 'feature-1' });
    assert.deepEqual(JSON.parse(await readFile(authorityPath, 'utf8')), priorAuthority);
    assert.deepEqual(JSON.parse(await readFile(intentPath, 'utf8')).lease, replacement);
    await dispatch('claim', { state_dir: fixture.stateDir, task_id: 'feature-1', node_id: 'implement', agent_task_path: '/root/recover-publication', agent_role: 'avsp_terra_high' });
    const recovered = JSON.parse(await readFile(authorityPath, 'utf8')); const registry = await fsPromises.lstat(leasePath, { bigint: true });
    assert.deepEqual(recovered.registry_identity, { dev: registry.dev.toString(), ino: registry.ino.toString() });
    await assert.rejects(() => readFile(intentPath, 'utf8'), /ENOENT/);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('treats high filesystem identity values as distinct decimal strings', () => {
  const high = '9007199254740993'; const adjacent = '9007199254740994';
  assert.notEqual(high, adjacent);
  assert.notEqual(BigInt(high).toString(), BigInt(adjacent).toString());
});

test('rejects a numeric legacy authority identity before authority migration can write', async () => {
  const fixture = await setup();
  try {
    await dispatch('init', { state_dir: fixture.stateDir, manifest: fixture.manifest });
    const authorityPath = path.join(fixture.workspace, '.codex-workflow-controller-authority.json');
    const authority = JSON.parse(await readFile(authorityPath, 'utf8'));
    const legacy = { ...authority, version: 1, workspace_identity: { dev: 1, ino: 2 }, control_identity: { dev: 3, ino: 4 } };
    delete legacy.registry_initialized; delete legacy.registry_identity; delete legacy.registry_bound_at;
    await writeFile(authorityPath, JSON.stringify(legacy));
    const before = await readFile(authorityPath);
    await assert.rejects(
      () => dispatch('claim', { state_dir: fixture.stateDir, task_id: 'feature-1', node_id: 'implement', agent_task_path: '/root/numeric-legacy-authority', agent_role: 'avsp_terra_high' }),
      /Unsupported workspace lease authority/,
    );
    assert.deepEqual(await readFile(authorityPath), before);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('normal prune rejects a structurally valid replacement registry file', async () => {
  const fixture = await setup();
  try {
    await dispatch('init', { state_dir: fixture.stateDir, manifest: fixture.manifest });
    await dispatch('release-workspace', { state_dir: fixture.stateDir, task_id: 'feature-1', previous_agents_stopped: true });
    const state = await readControllerState(fixture.stateDir); state.updated_at = '1970-01-01T00:00:00.000Z'; await writeControllerState(fixture.stateDir, state);
    const leasePath = path.join(fixture.workspace, '.codex', 'workflow-controller', 'workspace-lease.json');
    const replacement = JSON.parse(await readFile(leasePath, 'utf8'));
    await rename(leasePath, `${leasePath}.displaced`);
    await writeFile(leasePath, JSON.stringify(replacement));
    const [pruned] = await dispatch('prune-expired', { state_dir: fixture.stateDir });
    assert.equal(pruned.deleted_count, 0);
    assert.match(pruned.retained[0].reason, /registry identity changed/);
    assert.equal((await readControllerState(fixture.stateDir)).task_id, 'feature-1');
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

test('CLI processes initialize disjoint workspace claims concurrently', async () => {
  const fixture = await setup();
  try {
    await mkdir(path.join(fixture.workspace, 'left')); await mkdir(path.join(fixture.workspace, 'right'));
    const secondStateDir = path.join(fixture.root, 'second-state');
    const firstManifest = path.join(fixture.root, 'first-claims.json'); const secondManifest = path.join(fixture.root, 'second-claims.json');
    const task = (taskId, prefix) => ({ task_id: taskId, workspace: fixture.workspace, workspace_claims: [{ mode: 'write', prefix }], goal: taskId, requirements: [{ id: 'R1', text: taskId }], nodes: [{ id: 'total-review', kind: 'total_review', agent_type: 'avsp_sol_high', depends_on: [] }] });
    await writeFile(firstManifest, JSON.stringify(task('left-task', 'left'))); await writeFile(secondManifest, JSON.stringify(task('right-task', 'right')));
    const invoke = (stateDir, manifest) => execFile(process.execPath, [controllerCli, 'init', '--state-dir', stateDir, '--manifest', manifest], { cwd: fixture.root, windowsHide: true });
    const results = await Promise.allSettled([invoke(fixture.stateDir, firstManifest), invoke(secondStateDir, secondManifest)]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 2);
    const lease = JSON.parse(await readFile(path.join(fixture.workspace, '.codex', 'workflow-controller', 'workspace-lease.json'), 'utf8'));
    assert.equal(lease.version, 2); assert.equal(lease.active_tasks.length, 2);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

async function writeNode(root, node) {
  const file = path.join(root, `${node.id}.json`); await writeFile(file, JSON.stringify(node)); return file;
}
