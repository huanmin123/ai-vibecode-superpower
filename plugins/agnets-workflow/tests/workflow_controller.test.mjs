import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const previousCodexHome = process.env.CODEX_HOME;
const isolatedCodexHome = await mkdtemp(path.join(os.tmpdir(), 'agnets-workflow-controller-codex-home-'));
process.env.CODEX_HOME = isolatedCodexHome;
test.after(async () => {
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  await rm(isolatedCodexHome, { recursive: true, force: true });
});
const controller = path.join(root, 'scripts', 'workflow_controller.mjs');
const { globalStateDirectoryForWorkspace } = await import('../scripts/workflow_controller.mjs');
const stateDirFor = workspace => { mkdirSync(workspace, { recursive: true }); return globalStateDirectoryForWorkspace(workspace); };

async function canonicalStateNamespace(stateDir) {
  const { canonicalStateDirectory } = await import('../scripts/workflow_controller.mjs');
  return canonicalStateDirectory(stateDir);
}

function assessment(level) {
  const dimension = (status) => ({ status, evidence: ['verified local evidence'], rationale: `risk is ${status}` });
  const uncertainty = level === 'sol' ? 'unknown' : level === 'terra' ? 'partial' : 'controlled';
  return { impact: dimension('controlled'), recoverability: dimension('controlled'), uncertainty: dimension(uncertainty), verifiability: dimension('controlled'), coupling: dimension('controlled'), selection_reason: 'Current evidence determines the assurance level.' };
}

function v3Manifest(workspace, overrides = {}) {
  const work = { execution_risk: 'protected', routing_reason: 'bounded change', execution_owner: '/root/work', integration_owner: '/root', quality_guard: 'targeted verification' };
  const review = { execution_risk: 'read_only', routing_reason: 'independent quality gate', execution_owner: '/root/reviewer', integration_owner: '/root', quality_guard: 'requirements and evidence review' };
  return {
    task_id: 'feature', workspace, workspace_claims: [{ mode: 'write', prefix: '.' }], global_write_justification: 'The fixture intentionally validates a workspace-wide claim.', goal: 'Validate the v3-only workflow contract.', requirements: [{ id: 'R1', text: 'Only v3 manifests are accepted.' }], scope: [], non_goals: [], routing_schema_version: 3, assurance_level: 'terra', assurance_assessment: assessment('terra'), review_context: { environment: 'local test workspace', scenarios: ['current protocol'], boundaries: 'declared workspace only' }, review_entry_stage: 'terra_single', nodes: [{ id: 'work', kind: 'implementation', ...work }, { id: 'review', kind: 'quality_review', depends_on: ['work'], ...review }], ...overrides,
  };
}

test('controller accepts only the current v3 manifest and SQLite state path', async () => {
  const source = await readFile(controller, 'utf8');
  assert.match(source, /routing_schema_version must be 3/);
  assert.match(source, /Current global controller state does not exist/);
  assert.doesNotMatch(source, /migrate.*Terra.*Delegable|route_migration/);
  assert.doesNotMatch(source, new RegExp(['avsp', 'luna', 'high', 'writer'].join('_')));
  assert.doesNotMatch(source, /record-verification/);
  assert.match(source, /const initialState = normalizeState\(await loadState\(filePath\)\)/);
});

test('v3 requires an explicit justification for a workspace-wide write claim', async () => {
  const { ControllerError, dispatch } = await import('../scripts/workflow_controller.mjs');
  const temp = await mkdtemp(path.join(os.tmpdir(), 'agnets-workflow-v3-claim-scope-'));
  const workspace = path.join(temp, 'workspace');
  const stateDir = stateDirFor(workspace);
  const manifestPath = path.join(temp, 'manifest.json');
  try {
    await mkdir(workspace, { recursive: true });
    const manifest = v3Manifest(workspace);
    delete manifest.global_write_justification;
    await writeFile(manifestPath, JSON.stringify(manifest));
    await assert.rejects(
      () => dispatch('init', { manifest: manifestPath, }),
      error => error instanceof ControllerError && /global_write_justification is required/.test(error.message),
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('v3 surfaces structured manifest validation errors for review context and workspace claims', async () => {
  const { ControllerError, dispatch } = await import('../scripts/workflow_controller.mjs');
  const temp = await mkdtemp(path.join(os.tmpdir(), 'agnets-workflow-v3-manifest-errors-'));
  const workspace = path.join(temp, 'workspace');
  const manifestPath = path.join(temp, 'manifest.json');
  try {
    await mkdir(workspace, { recursive: true });
    const invalidContext = v3Manifest(workspace, { task_id: 'invalid-context', review_context: { environment: 'test', scenarios: [], boundaries: 'workspace' } });
    await writeFile(manifestPath, JSON.stringify(invalidContext));
    await assert.rejects(
      () => dispatch('init', { manifest: manifestPath }),
      error => error instanceof ControllerError
        && error.code === 'INVALID_ARGUMENT'
        && error.field_errors[0]?.path === 'review_context.scenarios'
        && /scenarios must be a non-empty array/.test(error.message),
    );
    const invalidClaim = v3Manifest(workspace, { task_id: 'invalid-claim', workspace_claims: [{ mode: 'write', prefix: 'frontend/src/views/common_tools/hosts/' }] });
    await writeFile(manifestPath, JSON.stringify(invalidClaim));
    await assert.rejects(
      () => dispatch('init', { manifest: manifestPath }),
      error => error instanceof ControllerError
        && error.code === 'INVALID_ARGUMENT'
        && error.field_errors[0]?.path === 'workspace_claims[].prefix'
        && /Invalid workspace_claim prefix/.test(error.message),
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('delegable work starts with Luna and can only move to Terra through a protected takeover', async () => {
  const { ControllerError, dispatch } = await import('../scripts/workflow_controller.mjs');
  const temp = await mkdtemp(path.join(os.tmpdir(), 'agnets-workflow-luna-routing-'));
  const workspace = path.join(temp, 'workspace');
  const stateDir = stateDirFor(workspace);
  const manifestPath = path.join(temp, 'manifest.json');
  const work = { id: 'work', kind: 'implementation', execution_risk: 'delegable', routing_reason: 'The implementation steps, rollback, and verification are fixed.', execution_owner: '/root/luna-executor', integration_owner: '/root', quality_guard: 'Run the focused verification command.' };
  const review = { id: 'review', kind: 'quality_review', depends_on: ['work'], execution_risk: 'read_only', routing_reason: 'Independent quality gate', execution_owner: '/root/reviewer', integration_owner: '/root', quality_guard: 'Review requirements and evidence' };
  try {
    await mkdir(workspace, { recursive: true });
    await writeFile(manifestPath, JSON.stringify(v3Manifest(workspace, { task_id: 'direct-terra-delegable', nodes: [{ ...work, agent_type: 'avsp_terra_high' }, review] })));
    await assert.rejects(
      () => dispatch('init', { manifest: manifestPath }),
      error => error instanceof ControllerError && /delegable node agent_type must be a Luna executor/.test(error.message),
    );

    await writeFile(manifestPath, JSON.stringify(v3Manifest(workspace, { task_id: 'luna-to-protected', nodes: [work, review] })));
    const [initialized] = await dispatch('init', { manifest: manifestPath });
    assert.equal(initialized.task.nodes.find(node => node.id === 'work').agent_type, 'avsp_luna_high_executor');

    const [luna] = await dispatch('start', { task_id: 'luna-to-protected', node_id: 'work', agent_task_path: '/root/luna-executor', agent_role: 'avsp_luna_high_executor', native_agent_started: true, state_dir: stateDir });
    await dispatch('acquire-write-lock', { task_id: 'luna-to-protected', node_id: 'work', claim_id: luna.claim_id, write_prefixes: ['src/feature.mjs'], purpose: 'Apply the delegated implementation.', state_dir: stateDir });
    await assert.rejects(
      () => dispatch('escalate-execution', { task_id: 'luna-to-protected', node_id: 'work', claim_id: luna.claim_id, reason: 'A newly discovered compatibility boundary invalidates the original rollback plan.', routing_reason: 'Compatibility impact is no longer bounded by the delegable contract.', quality_guard: 'Run the compatibility regression suite before integration.', assurance_assessment: assessment('terra'), replacement_agent_task_path: '/root/terra-takeover', previous_agent_stopped: false, state_dir: stateDir }),
      error => error instanceof ControllerError && /previous_agent_stopped must be true/.test(error.message),
    );
    await assert.rejects(
      () => dispatch('escalate-execution', { task_id: 'luna-to-protected', node_id: 'work', claim_id: luna.claim_id, reason: 'A newly discovered compatibility boundary invalidates the original rollback plan.', routing_reason: 'Compatibility impact is no longer bounded by the delegable contract.', quality_guard: 'Run the compatibility regression suite before integration.', assurance_assessment: assessment('sol'), replacement_agent_task_path: '/root/terra-takeover', previous_agent_stopped: true, state_dir: stateDir }),
      error => error instanceof ControllerError && /requires sol assurance/.test(error.message),
    );

    const [takeover] = await dispatch('escalate-execution', { task_id: 'luna-to-protected', node_id: 'work', claim_id: luna.claim_id, reason: 'A newly discovered compatibility boundary invalidates the original rollback plan.', routing_reason: 'Compatibility impact is no longer bounded by the delegable contract.', quality_guard: 'Run the compatibility regression suite before integration.', assurance_assessment: assessment('terra'), replacement_agent_task_path: '/root/terra-takeover', previous_agent_stopped: true, state_dir: stateDir });
    assert.equal(takeover.protected_takeover, true);
    assert.equal(takeover.node.execution_risk, 'protected');
    assert.equal(takeover.node.agent_type, 'avsp_terra_high');
    assert.equal(takeover.node.execution_owner, '/root/terra-takeover');
    assert.equal(takeover.node.integration_owner, '/root/terra-takeover');
    assert.equal(takeover.recovery_package.previous_attempt.agent_role, 'avsp_luna_high_executor');
    assert.equal(takeover.recovery_package.node.execution_risk, 'protected');
    assert.equal(takeover.assurance_assessment.uncertainty.status, 'partial');
    assert.equal(takeover.assurance_assessment.selection_reason, 'Current evidence determines the assurance level.');
    const [status] = await dispatch('status', { task_id: 'luna-to-protected', state_dir: stateDir });
    assert.deepEqual(status.active_write_locks, []);

    const [terra] = await dispatch('start', { task_id: 'luna-to-protected', node_id: 'work', agent_task_path: '/root/terra-takeover', agent_role: 'avsp_terra_high', native_agent_started: true, state_dir: stateDir });
    assert.equal(terra.node.agent_role, 'avsp_terra_high');
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('old workflow state is rejected without automatic migration', async () => {
  const { ControllerError, dispatch } = await import('../scripts/workflow_controller.mjs');
  const { readGlobalTaskState, writeGlobalTaskState } = await import('../scripts/global_workflow_store.mjs');
  const temp = await mkdtemp(path.join(os.tmpdir(), 'agnets-workflow-unsupported-routing-policy-'));
  const workspace = path.join(temp, 'workspace');
  const stateDir = stateDirFor(workspace);
  const manifestPath = path.join(temp, 'manifest.json');
  try {
    await mkdir(workspace, { recursive: true });
    await writeFile(manifestPath, JSON.stringify(v3Manifest(workspace, { task_id: 'unsupported-routing-policy' })));
    const [initialized] = await dispatch('init', { manifest: manifestPath });
    const logicalPath = path.join(initialized.task_key.namespace, `${initialized.task_key.task_id}.sqlite`);
    const oldState = await readGlobalTaskState(logicalPath);
    delete oldState.execution_routing_policy_version;
    await writeGlobalTaskState(logicalPath, oldState);
    await assert.rejects(
      () => dispatch('status', { task_id: 'unsupported-routing-policy', state_dir: stateDir }),
      error => error instanceof ControllerError
        && error.code === 'UNSUPPORTED_WORKFLOW_STATE'
        && error.field_errors[0]?.path === 'execution_routing_policy_version'
        && error.recovery?.action === 'start_new_workflow',
    );
    const retained = await readGlobalTaskState(logicalPath);
    assert.equal(Object.hasOwn(retained, 'execution_routing_policy_version'), false);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('current workflow store never opens a former global store and init does not enumerate a large workspace', async () => {
  const { ControllerError, dispatch } = await import('../scripts/workflow_controller.mjs');
  const { globalWorkflowStorePath } = await import('../scripts/global_workflow_store.mjs');
  const temp = await mkdtemp(path.join(os.tmpdir(), 'agnets-workflow-clean-store-and-large-workspace-'));
  const workspace = path.join(temp, 'workspace');
  const manifestPath = path.join(temp, 'manifest.json');
  const formerStore = path.join(isolatedCodexHome, 'state', 'agnets-workflow', 'workflow.sqlite');
  try {
    await mkdir(path.join(workspace, 'large-tree'), { recursive: true });
    for (let index = 0; index < 256; index++) await writeFile(path.join(workspace, 'large-tree', `file-${index}.txt`), String(index));
    await mkdir(path.dirname(formerStore), { recursive: true });
    await writeFile(formerStore, 'not a SQLite database and not current state');
    await writeFile(manifestPath, JSON.stringify(v3Manifest(workspace, { task_id: 'large-workspace', workspace_claims: [{ mode: 'write', prefix: '.' }] })));
    const [initialized] = await dispatch('init', { manifest: manifestPath });
    assert.equal(initialized.database_path, globalWorkflowStorePath());
    assert.match(initialized.database_path, /[\\/]state[\\/]agnets-workflow[\\/]current[\\/]workflow\.sqlite$/);
    assert.equal(await readFile(formerStore, 'utf8'), 'not a SQLite database and not current state');
    const source = await readFile(controller, 'utf8');
    assert.doesNotMatch(source, /MAX_FINGERPRINT_FILES|function walkFiles|createReadStream\(/);
    assert.equal(initialized.task.workspace_claims[0].prefix, '.');
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('current state rejects missing required fields instead of defaulting them', async () => {
  const { ControllerError, dispatch } = await import('../scripts/workflow_controller.mjs');
  const { readGlobalTaskState, writeGlobalTaskState } = await import('../scripts/global_workflow_store.mjs');
  const temp = await mkdtemp(path.join(os.tmpdir(), 'agnets-workflow-strict-current-state-'));
  const workspace = path.join(temp, 'workspace');
  const stateDir = stateDirFor(workspace);
  const manifestPath = path.join(temp, 'manifest.json');
  try {
    await mkdir(workspace, { recursive: true });
    await writeFile(manifestPath, JSON.stringify(v3Manifest(workspace, { task_id: 'strict-current-state' })));
    const [initialized] = await dispatch('init', { manifest: manifestPath });
    const logicalPath = path.join(initialized.task_key.namespace, `${initialized.task_key.task_id}.sqlite`);
    const stored = await readGlobalTaskState(logicalPath);
    delete stored.nodes.work.recovery_history;
    await writeGlobalTaskState(logicalPath, stored);
    await assert.rejects(
      () => dispatch('status', { task_id: 'strict-current-state', state_dir: stateDir }),
      error => error instanceof ControllerError
        && error.code === 'UNSUPPORTED_WORKFLOW_STATE'
        && error.field_errors[0]?.path === 'nodes.work.recovery_history'
        && error.recovery?.action === 'start_new_workflow',
    );
    const retained = await readGlobalTaskState(logicalPath);
    assert.equal(Object.hasOwn(retained.nodes.work, 'recovery_history'), false);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('v3 derives a global namespace and rejects caller-selected state directories', async () => {
  const { ControllerError, dispatch } = await import('../scripts/workflow_controller.mjs');
  const temp = await mkdtemp(path.join(os.tmpdir(), 'agnets-workflow-v3-state-boundary-'));
  const workspace = path.join(temp, 'workspace');
  const stateDir = stateDirFor(workspace);
  const externalStateDir = path.join(temp, 'external-state');
  const ignoredStateDirs = [
    path.join(workspace, '.git', 'workflow-state'),
    path.join(workspace, 'node_modules', 'workflow-state'),
    path.join(workspace, '.codex', 'workflow-fix-state'),
  ];
  const manifestPath = path.join(temp, 'manifest.json');
  try {
    await mkdir(workspace, { recursive: true });
    await writeFile(manifestPath, JSON.stringify(v3Manifest(workspace)));
    const [initialized] = await dispatch('init', { manifest: manifestPath });
    assert.equal(initialized.state_dir, await canonicalStateNamespace(stateDir));
    assert.equal(existsSync(path.join(workspace, '.codex')), false);
    await writeFile(manifestPath, JSON.stringify(v3Manifest(workspace, { task_id: 'external-state' })));
    await assert.rejects(
      () => dispatch('init', { manifest: manifestPath, state_dir: externalStateDir }),
      error => error instanceof ControllerError && /derives state_dir from manifest\.workspace|global namespace returned by workflow_init/.test(error.message),
    );
    for (const [index, ignoredStateDir] of ignoredStateDirs.entries()) {
      await writeFile(manifestPath, JSON.stringify(v3Manifest(workspace, { task_id: `ignored-state-${index}` })));
      await assert.rejects(
        () => dispatch('init', { manifest: manifestPath, state_dir: ignoredStateDir }),
        error => error instanceof ControllerError && /derives state_dir from manifest\.workspace|global namespace returned by workflow_init/.test(error.message),
      );
      assert.equal(existsSync(ignoredStateDir), false);
    }
    assert.equal(existsSync(externalStateDir), false);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('v3 rejects an unsafe quality_review manifest before any task state is created', async () => {
  const { ControllerError, dispatch } = await import('../scripts/workflow_controller.mjs');
  const temp = await mkdtemp(path.join(os.tmpdir(), 'agnets-workflow-v3-quality-risk-'));
  const workspace = path.join(temp, 'workspace');
  const stateDir = stateDirFor(workspace);
  const manifestPath = path.join(temp, 'manifest.json');
  try {
    await mkdir(workspace, { recursive: true });
    const manifest = v3Manifest(workspace, { task_id: 'unsafe-quality-risk' });
    manifest.nodes[1].execution_risk = 'protected';
    await writeFile(manifestPath, JSON.stringify(manifest));
    await assert.rejects(
      () => dispatch('init', { manifest: manifestPath, }),
      error => error instanceof ControllerError
        && error.code === 'INVALID_ARGUMENT'
        && error.field_errors[0]?.path === 'nodes[].execution_risk'
        && /quality_review node must be read_only; set execution_risk/.test(error.message),
    );
    assert.equal(existsSync(stateDir), false);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('v3 runtime initializes current manifests and rejects non-v3 schema states', async () => {
  const { ControllerError, dispatch } = await import('../scripts/workflow_controller.mjs');
  const temp = await mkdtemp(path.join(os.tmpdir(), 'agnets-workflow-v3-'));
  const workspace = path.join(temp, 'workspace');
  const stateDir = stateDirFor(workspace);
  const manifestPath = path.join(temp, 'manifest.json');
  try {
    await mkdir(workspace, { recursive: true });
    await writeFile(manifestPath, JSON.stringify(v3Manifest(workspace)));
    const [initialized] = await dispatch('init', { manifest: manifestPath, });
    assert.equal(initialized.task.task_id, 'feature');

    const [work] = await dispatch('claim', { task_id: 'feature', node_id: 'work', agent_task_path: '/root/work', agent_role: 'avsp_terra_high', state_dir: stateDir });
    const resultPath = path.join(temp, 'work-result.json');
    await writeFile(resultPath, JSON.stringify({ changed: true }));
    await assert.rejects(
      () => dispatch('checkpoint', { task_id: 'feature', node_id: 'work', claim_id: 'wrong-claim', checkpoint: { progress: 'not owned' }, state_dir: stateDir }),
      error => error instanceof ControllerError
        && error.code === 'FAILED_PRECONDITION'
        && error.field_errors[0]?.path === 'claim_id'
        && error.recovery?.action === 'workflow_status',
    );
    await dispatch('heartbeat', { task_id: 'feature', node_id: 'work', claim_id: work.claim_id, state_dir: stateDir });
    await assert.rejects(
      () => dispatch('complete', { task_id: 'feature', node_id: 'work', claim_id: work.claim_id, status: 'succeeded', result: resultPath, state_dir: stateDir }),
      error => error instanceof ControllerError
        && error.code === 'INVALID_ARGUMENT'
        && error.field_errors[0]?.path === 'completion_attestation'
        && error.field_errors[0]?.expected === 'native_agent_finished'
        && /requires completion_attestation=native_agent_finished.*main\/root.*Completed/.test(error.message),
    );
    const [beforeCompletion] = await dispatch('status', { task_id: 'feature', state_dir: stateDir });
    assert.equal(beforeCompletion.nodes.find(node => node.id === 'work').status, 'running');
    const [completed] = await dispatch('complete', { task_id: 'feature', node_id: 'work', claim_id: work.claim_id, status: 'succeeded', result: resultPath, completion_attestation: 'native_agent_finished', state_dir: stateDir });
    assert.equal(completed.node.status, 'succeeded');

    const assessmentPath = path.join(temp, 'sol-assessment.json');
    await writeFile(assessmentPath, JSON.stringify(assessment('sol')));
    const [raised] = await dispatch('raise-assurance', { task_id: 'feature', target_assurance_level: 'sol', reason: 'Execution revealed an unknown global boundary.', assurance_assessment: assessmentPath, replacement_agent_task_path: '/root/sol-reviewer', integration_owner: '/root', state_dir: stateDir });
    assert.equal(raised.assurance_level, 'sol');
    assert.equal(raised.node.agent_type, 'avsp_sol_high');

    await writeFile(manifestPath, JSON.stringify(v3Manifest(workspace, { task_id: 'non-v3', routing_schema_version: 2 })));
    await assert.rejects(() => dispatch('init', { manifest: manifestPath, }), error => error instanceof ControllerError && /routing_schema_version must be 3/.test(error.message));

    await writeFile(manifestPath, JSON.stringify(v3Manifest(workspace, { task_id: 'controlled', assurance_assessment: assessment('controlled') })));
    await assert.rejects(() => dispatch('init', { manifest: manifestPath, }), error => error instanceof ControllerError && /cannot initialize a persistent workflow/.test(error.message));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('workflow payloads are inline and workspace-local JSON result paths are rejected', async () => {
  const { ControllerError, dispatch } = await import('../scripts/workflow_controller.mjs');
  const temp = await mkdtemp(path.join(os.tmpdir(), 'agnets-workflow-inline-payloads-'));
  const workspace = path.join(temp, 'workspace');
  const stateDir = stateDirFor(workspace);
  const manifestPath = path.join(temp, 'manifest.json');
  const localResultPath = path.join(workspace, 'agent-result.json');
  try {
    await mkdir(workspace, { recursive: true });
    await writeFile(manifestPath, JSON.stringify(v3Manifest(workspace, { task_id: 'inline-payloads' })));
    await dispatch('init', { manifest: manifestPath, });
    // A project-local JSON file is input data, never a controller payload.
    for (const [command, parameter] of [['checkpoint', 'checkpoint'], ['record-review', 'review'], ['record-repair', 'repair'], ['raise-assurance', 'assurance_assessment']]) {
      const localPath = path.join(workspace, `${parameter}.json`);
      await writeFile(localPath, JSON.stringify({ forbidden: true }));
      await assert.rejects(
        () => dispatch(command, { task_id: 'inline-payloads', [parameter]: localPath, state_dir: stateDir }),
        error => error instanceof ControllerError && /must be an inline JSON value; workspace-local JSON files are not workflow state/.test(error.message),
      );
    }
    const [claimed] = await dispatch('claim', { task_id: 'inline-payloads', node_id: 'work', agent_task_path: '/root/work', agent_role: 'avsp_terra_high', state_dir: stateDir });
    await dispatch('heartbeat', { task_id: 'inline-payloads', node_id: 'work', claim_id: claimed.claim_id, state_dir: stateDir });
    await writeFile(localResultPath, JSON.stringify({ changed: true }));
    await assert.rejects(
      () => dispatch('complete', { task_id: 'inline-payloads', node_id: 'work', claim_id: claimed.claim_id, status: 'succeeded', result: localResultPath, completion_attestation: 'native_agent_finished', state_dir: stateDir }),
      error => error instanceof ControllerError && /must be an inline JSON value; workspace-local JSON files are not workflow state/.test(error.message),
    );
    const [completed] = await dispatch('complete', { task_id: 'inline-payloads', node_id: 'work', claim_id: claimed.claim_id, status: 'succeeded', result: { changed: true }, completion_attestation: 'native_agent_finished', state_dir: stateDir });
    assert.equal(completed.node.status, 'succeeded');
    assert.equal(await readFile(localResultPath, 'utf8'), JSON.stringify({ changed: true }));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('v3 writes workspace coordination only to the user-level SQLite store', async () => {
  const { dispatch } = await import('../scripts/workflow_controller.mjs');
  const { globalWorkflowStorePath } = await import('../scripts/global_workflow_store.mjs');
  const temp = await mkdtemp(path.join(os.tmpdir(), 'agnets-workflow-v3-sqlite-control-'));
  const workspace = path.join(temp, 'workspace');
  const stateDir = stateDirFor(workspace);
  const manifestPath = path.join(temp, 'manifest.json');
  const controlPath = path.join(workspace, '.codex', 'workflow-controller', 'workflow.sqlite');
  try {
    await mkdir(workspace, { recursive: true });
    await writeFile(manifestPath, JSON.stringify(v3Manifest(workspace)));
    const [initialized] = await dispatch('init', { manifest: manifestPath, });
    const canonicalStateDir = stateDir;
    assert.equal(initialized.database_path, globalWorkflowStorePath());
    assert.equal(initialized.state_path, globalWorkflowStorePath());
    assert.deepEqual(initialized.task_key, { namespace: canonicalStateDir, task_id: 'feature' });
    assert.equal(existsSync(controlPath), false);
    assert.equal(existsSync(path.join(stateDir, 'workspace-lease.json')), false);
    assert.equal(existsSync(path.join(workspace, '.codex-workflow-controller-authority.json')), false);
    assert.equal(existsSync(stateDir), false);
    const [status] = await dispatch('status', { task_id: 'feature', state_dir: stateDir });
    assert.equal(status.state_path, globalWorkflowStorePath());
    assert.equal(status.database_path, globalWorkflowStorePath());
    assert.deepEqual(status.task_key, { namespace: canonicalStateDir, task_id: 'feature' });
    assert.equal(status.workspace_lease.database_path, globalWorkflowStorePath());
    assert.equal(status.workspace_lease.state_path, globalWorkflowStorePath());
    assert.deepEqual(status.workspace_lease.task_key, { namespace: canonicalStateDir, task_id: 'feature' });
    assert.equal('registry_path' in status.workspace_lease, false);
    const [reconciled] = await dispatch('reconcile-workspace', { workspace, task_id: 'feature', state_dir: stateDir });
    assert.equal(reconciled.reconciled, false);
    assert.equal(reconciled.state_path, globalWorkflowStorePath());
    assert.equal(reconciled.database_path, globalWorkflowStorePath());
    assert.deepEqual(reconciled.task_key, { namespace: canonicalStateDir, task_id: 'feature' });
    const [doctor] = await dispatch('doctor', { task_id: 'feature', state_dir: stateDir });
    const databaseCheck = doctor.checks.find(check => check.id === 'state_database');
    const leaseCheck = doctor.checks.find(check => check.id === 'workspace_lease');
    assert.equal(databaseCheck.detail.database_path, globalWorkflowStorePath());
    assert.deepEqual(databaseCheck.detail.task_key, { namespace: canonicalStateDir, task_id: 'feature' });
    assert.equal(leaseCheck.detail.database_path, globalWorkflowStorePath());
    assert.deepEqual(leaseCheck.detail.task_key, { namespace: canonicalStateDir, task_id: 'feature' });
    assert.equal('path' in leaseCheck.detail, false);
    assert.equal('state_path' in leaseCheck.detail.registry_active_tasks[0], false);
    const [claimed] = await dispatch('claim', { task_id: 'feature', node_id: 'work', agent_task_path: '/root/work', agent_role: 'avsp_terra_high', state_dir: stateDir });
    assert.equal(claimed.node.status, 'running');
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('v3 permits independent write claims in one workspace without taking a whole-workspace claim', async () => {
  const { dispatch } = await import('../scripts/workflow_controller.mjs');
  const temp = await mkdtemp(path.join(os.tmpdir(), 'agnets-workflow-v3-disjoint-claims-'));
  const workspace = path.join(temp, 'workspace');
  const stateDir = stateDirFor(workspace);
  const alphaManifestPath = path.join(temp, 'alpha.json');
  const betaManifestPath = path.join(temp, 'beta.json');
  try {
    await mkdir(workspace, { recursive: true });
    await writeFile(alphaManifestPath, JSON.stringify(v3Manifest(workspace, { task_id: 'alpha', workspace_claims: [{ mode: 'write', prefix: 'apps/alpha' }] })));
    await writeFile(betaManifestPath, JSON.stringify(v3Manifest(workspace, { task_id: 'beta', workspace_claims: [{ mode: 'write', prefix: 'apps/beta' }] })));
    const [alpha] = await dispatch('init', { manifest: alphaManifestPath, });
    const [beta] = await dispatch('init', { manifest: betaManifestPath, });
    assert.equal(alpha.task.task_id, 'alpha');
    assert.equal(beta.task.task_id, 'beta');
    assert.equal(existsSync(path.join(stateDir, 'workflow.sqlite')), false);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('v3 treats workspace claims as a write-lock envelope and locks only actual paths on demand', async () => {
  const { ControllerError, dispatch } = await import('../scripts/workflow_controller.mjs');
  const temp = await mkdtemp(path.join(os.tmpdir(), 'agnets-workflow-v3-demand-locks-'));
  const workspace = path.join(temp, 'workspace');
  const stateDir = stateDirFor(workspace);
  const alphaManifestPath = path.join(temp, 'alpha.json');
  const betaManifestPath = path.join(temp, 'beta.json');
  const resultPath = path.join(temp, 'result.json');
  try {
    await mkdir(workspace, { recursive: true });
    const sharedClaim = [{ mode: 'write', prefix: 'apps/shared' }];
    await writeFile(alphaManifestPath, JSON.stringify(v3Manifest(workspace, { task_id: 'alpha', workspace_claims: sharedClaim })));
    await writeFile(betaManifestPath, JSON.stringify(v3Manifest(workspace, { task_id: 'beta', workspace_claims: sharedClaim })));
    await dispatch('init', { manifest: alphaManifestPath, });
    await dispatch('init', { manifest: betaManifestPath, });

    const [alphaStart] = await dispatch('start', { task_id: 'alpha', node_id: 'work', agent_task_path: '/root/work', agent_role: 'avsp_terra_high', native_agent_started: true, state_dir: stateDir });
    const [betaStart] = await dispatch('start', { task_id: 'beta', node_id: 'work', agent_task_path: '/root/work', agent_role: 'avsp_terra_high', native_agent_started: true, state_dir: stateDir });
    const [alphaLock] = await dispatch('acquire-write-lock', { task_id: 'alpha', node_id: 'work', claim_id: alphaStart.claim_id, write_prefixes: ['apps/shared/alpha.ts'], purpose: 'Edit Alpha implementation.', state_dir: stateDir });
    assert.equal(alphaLock.acquired.length, 1);
    const [betaStatus] = await dispatch('status', { task_id: 'beta', state_dir: stateDir });
    assert.deepEqual(betaStatus.active_write_locks.map(lock => lock.prefix), ['apps/shared/alpha.ts']);
    const [betaStale] = await dispatch('stale', { task_id: 'beta', state_dir: stateDir });
    assert.deepEqual(betaStale.active_write_locks.map(lock => lock.prefix), ['apps/shared/alpha.ts']);
    await assert.rejects(
      () => dispatch('acquire-write-lock', { task_id: 'beta', node_id: 'work', claim_id: betaStart.claim_id, write_prefixes: ['apps/shared/alpha.ts'], purpose: 'Conflicting edit.', state_dir: stateDir }),
      error => error instanceof ControllerError && /conflicts with active task alpha/.test(error.message),
    );
    const [betaLock] = await dispatch('acquire-write-lock', { task_id: 'beta', node_id: 'work', claim_id: betaStart.claim_id, write_prefixes: ['apps/shared/beta.ts'], purpose: 'Edit Beta implementation.', state_dir: stateDir });
    assert.equal(betaLock.acquired[0].prefix, 'apps/shared/beta.ts');
    await assert.rejects(
      () => dispatch('acquire-write-lock', { task_id: 'beta', node_id: 'work', claim_id: betaStart.claim_id, write_prefixes: ['outside/file.ts'], purpose: 'Outside declared envelope.', state_dir: stateDir }),
      error => error instanceof ControllerError && /outside this task's declared write claims/.test(error.message),
    );
    const [released] = await dispatch('release-write-lock', { task_id: 'beta', node_id: 'work', claim_id: betaStart.claim_id, lock_ids: [betaLock.acquired[0].lock_id], state_dir: stateDir });
    assert.equal(released.released[0].prefix, 'apps/shared/beta.ts');

    await dispatch('heartbeat', { task_id: 'alpha', node_id: 'work', claim_id: alphaStart.claim_id, state_dir: stateDir });
    await writeFile(resultPath, JSON.stringify({ changed: ['apps/shared/alpha.ts'] }));
    await dispatch('complete', { task_id: 'alpha', node_id: 'work', claim_id: alphaStart.claim_id, status: 'succeeded', result: resultPath, completion_attestation: 'native_agent_finished', state_dir: stateDir });
    const [reviewStart] = await dispatch('start', { task_id: 'alpha', node_id: 'review', agent_task_path: '/root/reviewer', agent_role: 'avsp_terra_xhigh', native_agent_started: true, state_dir: stateDir });
    await assert.rejects(
      () => dispatch('acquire-write-lock', { task_id: 'alpha', node_id: 'review', claim_id: reviewStart.claim_id, write_prefixes: ['apps/shared/review.txt'], purpose: 'A reviewer must not write.', state_dir: stateDir }),
      error => error instanceof ControllerError && /read_only node cannot acquire/.test(error.message),
    );
    const [afterCompletion] = await dispatch('acquire-write-lock', { task_id: 'beta', node_id: 'work', claim_id: betaStart.claim_id, write_prefixes: ['apps/shared/alpha.ts'], purpose: 'Continue after Alpha completed.', state_dir: stateDir });
    assert.equal(afterCompletion.acquired[0].prefix, 'apps/shared/alpha.ts');
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('new workflow initialization ignores a materialized state_dir without scanning or writing it', async () => {
  const { dispatch } = await import('../scripts/workflow_controller.mjs');
  const { globalWorkflowStorePath } = await import('../scripts/global_workflow_store.mjs');
  const temp = await mkdtemp(path.join(os.tmpdir(), 'agnets-workflow-v3-unrecognized-local-state-'));
  const workspace = path.join(temp, 'workspace');
  const stateDir = stateDirFor(workspace);
  const unmanagedProjectStateDir = path.join(workspace, '.codex', 'workflow-controller');
  const manifestPath = path.join(temp, 'manifest.json');
  const localFiles = [
    path.join(unmanagedProjectStateDir, 'feature.sqlite'),
    path.join(unmanagedProjectStateDir, 'workflow.sqlite'),
    path.join(unmanagedProjectStateDir, 'feature.json'),
    path.join(unmanagedProjectStateDir, 'workspace-lease.json'),
    path.join(workspace, '.codex-workflow-controller-authority.json'),
  ];
  try {
    await mkdir(unmanagedProjectStateDir, { recursive: true });
    const contents = new Map();
    for (const localPath of localFiles) {
      const value = `unrecognized local state: ${path.basename(localPath)}`;
      await writeFile(localPath, value);
      contents.set(localPath, value);
    }
    await writeFile(manifestPath, JSON.stringify(v3Manifest(workspace)));
    const [initialized] = await dispatch('init', { manifest: manifestPath, });
    assert.equal(initialized.state_path, globalWorkflowStorePath());
    assert.equal(initialized.database_path, globalWorkflowStorePath());
    for (const [localPath, value] of contents) assert.equal(await readFile(localPath, 'utf8'), value);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('v3 blocks missing workspace control when global task state exists without scanning the workspace tree', async () => {
  const { ControllerError, dispatch } = await import('../scripts/workflow_controller.mjs');
  const { globalWorkflowStorePath } = await import('../scripts/global_workflow_store.mjs');
  const temp = await mkdtemp(path.join(os.tmpdir(), 'agnets-workflow-v3-global-orphan-'));
  const workspace = path.join(temp, 'workspace');
  const stateDir = stateDirFor(workspace);
  const manifestPath = path.join(temp, 'manifest.json');
  try {
    await mkdir(workspace, { recursive: true });
    await writeFile(manifestPath, JSON.stringify(v3Manifest(workspace)));
    const [initialized] = await dispatch('init', { manifest: manifestPath, });
    const store = new DatabaseSync(globalWorkflowStorePath());
    try {
      assert.equal(store.prepare('DELETE FROM workspace_control WHERE workspace = ?').run(initialized.task.workspace).changes, 1);
    } finally {
      store.close();
    }
    await writeFile(manifestPath, JSON.stringify(v3Manifest(workspace, { task_id: 'replacement' })));
    await assert.rejects(
      () => dispatch('init', { manifest: manifestPath, }),
      error => error instanceof ControllerError && /Workspace control database is missing while current v3 task state exists/.test(error.message),
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('v3 ignores malformed global task state for another workspace when recreating missing control', async () => {
  const { dispatch } = await import('../scripts/workflow_controller.mjs');
  const { globalWorkflowStorePath } = await import('../scripts/global_workflow_store.mjs');
  const temp = await mkdtemp(path.join(os.tmpdir(), 'agnets-workflow-v3-unrelated-corrupt-state-'));
  const workspace = path.join(temp, 'workspace');
  const stateDir = stateDirFor(workspace);
  const manifestPath = path.join(temp, 'manifest.json');
  try {
    await mkdir(workspace, { recursive: true });
    await writeFile(manifestPath, JSON.stringify(v3Manifest(workspace)));
    const [initialized] = await dispatch('init', { manifest: manifestPath, });
    const store = new DatabaseSync(globalWorkflowStorePath());
    try {
      assert.equal(store.prepare('DELETE FROM workspace_control WHERE workspace = ?').run(initialized.task.workspace).changes, 1);
      assert.equal(store.prepare("DELETE FROM task_state WHERE json_valid(payload) AND json_extract(payload, '$.workspace') = ?").run(initialized.task.workspace).changes, 1);
      store.prepare('INSERT INTO task_state (namespace_key, task_id, payload, updated_at, prune_after, instance_id, change_counter) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run('unrelated-corrupt-namespace', 'unrelated-corrupt-task', '{not valid JSON', new Date().toISOString(), null, '00000000-0000-0000-0000-000000000001', 1);
    } finally {
      store.close();
    }
    await writeFile(manifestPath, JSON.stringify(v3Manifest(workspace, { task_id: 'replacement' })));
    const [replacement] = await dispatch('init', { manifest: manifestPath, });
    assert.equal(replacement.task.task_id, 'replacement');
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('v3 retries an abandoned ordinary protocol review at the same stage with a new reviewer', async () => {
  const { dispatch } = await import('../scripts/workflow_controller.mjs');
  const temp = await mkdtemp(path.join(os.tmpdir(), 'agnets-workflow-v3-abandoned-review-'));
  const workspace = path.join(temp, 'workspace');
  const stateDir = stateDirFor(workspace);
  const manifestPath = path.join(temp, 'manifest.json');
  const resultPath = path.join(temp, 'work-result.json');
  try {
    await mkdir(workspace, { recursive: true });
    await writeFile(manifestPath, JSON.stringify(v3Manifest(workspace)));
    await dispatch('init', { manifest: manifestPath, });
    const [work] = await dispatch('start', { task_id: 'feature', node_id: 'work', agent_task_path: '/root/work', agent_role: 'avsp_terra_high', native_agent_started: true, state_dir: stateDir });
    await writeFile(resultPath, JSON.stringify({ changed: true }));
    await dispatch('complete', { task_id: 'feature', node_id: 'work', claim_id: work.claim_id, status: 'succeeded', result: resultPath, completion_attestation: 'native_agent_finished', state_dir: stateDir });
    const [review] = await dispatch('start', { task_id: 'feature', node_id: 'review', agent_task_path: '/root/reviewer', agent_role: 'avsp_terra_xhigh', native_agent_started: true, state_dir: stateDir });
    await dispatch('abandon', { task_id: 'feature', node_id: 'review', claim_id: review.claim_id, reason: 'reviewer exited before producing a review', previous_agent_stopped: true, state_dir: stateDir });
    const [retried] = await dispatch('retry', { task_id: 'feature', node_id: 'review', reason: 'replace unavailable reviewer without escalating', replacement_agent_task_path: '/root/reviewer-two', previous_agent_stopped: true, state_dir: stateDir });
    assert.equal(retried.node.status, 'pending');
    assert.equal(retried.node.review_gate.stage, 'terra_single');
    assert.equal(retried.node.agent_type, 'avsp_terra_xhigh');
    const [replacement] = await dispatch('start', { task_id: 'feature', node_id: 'review', agent_task_path: '/root/reviewer-two', agent_role: 'avsp_terra_xhigh', native_agent_started: true, state_dir: stateDir });
    assert.notEqual(replacement.claim_id, review.claim_id);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('v3 abandons a Terra cohort lane after its reviewer stops', async () => {
  const { dispatch } = await import('../scripts/workflow_controller.mjs');
  const temp = await mkdtemp(path.join(os.tmpdir(), 'agnets-workflow-v3-abandoned-cohort-'));
  const workspace = path.join(temp, 'workspace');
  const stateDir = stateDirFor(workspace);
  const manifestPath = path.join(temp, 'manifest.json');
  const resultPath = path.join(temp, 'work-result.json');
  try {
    await mkdir(workspace, { recursive: true });
    await writeFile(manifestPath, JSON.stringify(v3Manifest(workspace, { review_entry_stage: 'terra_cohort' })));
    await dispatch('init', { manifest: manifestPath });
    const [work] = await dispatch('start', { task_id: 'feature', node_id: 'work', agent_task_path: '/root/work', agent_role: 'avsp_terra_high', native_agent_started: true, state_dir: stateDir });
    await writeFile(resultPath, JSON.stringify({ changed: true }));
    await dispatch('complete', { task_id: 'feature', node_id: 'work', claim_id: work.claim_id, status: 'succeeded', result: resultPath, completion_attestation: 'native_agent_finished', state_dir: stateDir });
    const [review] = await dispatch('start', { task_id: 'feature', node_id: 'review', reviewer_slot: 'coverage', agent_task_path: '/root/cohort-coverage', agent_role: 'avsp_terra_xhigh', native_agent_started: true, state_dir: stateDir });
    const [abandoned] = await dispatch('abandon', { task_id: 'feature', node_id: 'review', reviewer_slot: 'coverage', claim_id: review.claim_id, reason: 'cohort reviewer stopped before recording a review', previous_agent_stopped: true, state_dir: stateDir });
    assert.equal(abandoned.node.status, 'abandoned');
    assert.equal(abandoned.node.review_gate.cohort.lanes.coverage.status, 'abandoned');
    const [status] = await dispatch('status', { task_id: 'feature', state_dir: stateDir });
    assert.deepEqual(status.stale_nodes, []);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('v3 non-cohort review completion accepts only its exact recorded verdict/status pair', async () => {
  const { ControllerError, dispatch } = await import('../scripts/workflow_controller.mjs');
  const temp = await mkdtemp(path.join(os.tmpdir(), 'agnets-workflow-v3-review-matrix-'));
  const workspace = path.join(temp, 'workspace');
  const stateDir = stateDirFor(workspace);
  const manifestPath = path.join(temp, 'manifest.json');
  const resultPath = path.join(temp, 'result.json');
  const prepare = async (taskId, verdict) => {
    await writeFile(manifestPath, JSON.stringify(v3Manifest(workspace, { task_id: taskId })));
    await dispatch('init', { manifest: manifestPath, });
    const [work] = await dispatch('start', { task_id: taskId, node_id: 'work', agent_task_path: '/root/work', agent_role: 'avsp_terra_high', native_agent_started: true, state_dir: stateDir });
    await writeFile(resultPath, JSON.stringify({ taskId }));
    await dispatch('complete', { task_id: taskId, node_id: 'work', claim_id: work.claim_id, status: 'succeeded', result: resultPath, completion_attestation: 'native_agent_finished', state_dir: stateDir });
    const reviewer = '/root/reviewer';
    const [review] = await dispatch('start', { task_id: taskId, node_id: 'review', agent_task_path: reviewer, agent_role: 'avsp_terra_xhigh', native_agent_started: true, state_dir: stateDir });
    const [context] = await dispatch('audit-context', { task_id: taskId, state_dir: stateDir });
    const payload = {
      auditor_task: reviewer, auditor_role: 'avsp_terra_xhigh', claim_id: review.claim_id, verdict,
      findings: verdict === 'fail' ? [{ id: 'blocking-1', severity: 'blocking', requirement_id: 'R1', summary: 'A required behavior is absent.', evidence: 'Targeted test fails.' }] : [],
      requirement_coverage: { R1: verdict === 'pass' ? 'covered' : verdict === 'fail' ? 'not covered' : 'unavailable to assess' },
      workflow_snapshot: context.workflow_snapshot, workspace_fingerprint: context.workspace_fingerprint,
      scope_and_regression: 'reviewed scope', verification_gaps: verdict === 'unavailable' ? 'reviewer unavailable' : 'none', residual_risk: verdict === 'pass' ? 'accepted' : 'not accepted',
      independent_assessment: 'Independent reviewer assessment.', history_reconciliation: 'No prior review changes this outcome.', review_history_digest: context.review_history_digest,
    };
    const reviewPath = path.join(temp, `${taskId}-review.json`);
    await writeFile(reviewPath, JSON.stringify(payload));
    await dispatch('record-review', { task_id: taskId, review: reviewPath, state_dir: stateDir });
    return { review, reviewPath };
  };
  try {
    await mkdir(workspace, { recursive: true });
    for (const [taskId, verdict, accepted, rejected] of [
      ['pass-pair', 'pass', 'succeeded', 'failed'],
      ['fail-pair', 'fail', 'failed', 'succeeded'],
      ['unavailable-pair', 'unavailable', 'unavailable', 'blocked'],
    ]) {
      const { review } = await prepare(taskId, verdict);
      await assert.rejects(
        () => dispatch('complete', { task_id: taskId, node_id: 'review', claim_id: review.claim_id, status: rejected, result: resultPath, completion_attestation: 'native_agent_finished', state_dir: stateDir }),
        error => error instanceof ControllerError && /completion status must match/.test(error.message),
      );
      const [before] = await dispatch('status', { task_id: taskId, state_dir: stateDir, detail: 'full' });
      assert.equal(before.nodes.find(node => node.id === 'review').status, 'running');
      const [completed] = await dispatch('complete', { task_id: taskId, node_id: 'review', claim_id: review.claim_id, status: accepted, result: resultPath, completion_attestation: 'native_agent_finished', state_dir: stateDir });
      assert.equal(completed.node.status, accepted);
      if (taskId === 'fail-pair') {
        const [repairContext] = await dispatch('audit-context', { task_id: taskId, state_dir: stateDir });
        assert.equal(repairContext.repair_input_contract.action, 'record_repair');
        assert.equal(repairContext.repair_input_contract.source_review_claim_id, review.claim_id);
        assert.deepEqual(repairContext.repair_input_contract.blocking_finding_ids, ['blocking-1']);
        await dispatch('record-repair', {
          task_id: taskId,
          state_dir: stateDir,
          repair: {
            source_review_claim_id: review.claim_id,
            repaired_by: '/root/fail-pair-repair',
            addressed_findings: [{ finding_id: 'blocking-1', resolution: 'The missing behavior was implemented.', verification_evidence: 'The focused regression passes.' }],
            verification_evidence: 'The focused regression passes.',
            workspace_fingerprint: repairContext.workspace_fingerprint,
          },
        });
        const [afterRepair] = await dispatch('audit-context', { task_id: taskId, state_dir: stateDir });
        assert.equal(afterRepair.repair_input_contract.action, null);
        assert.equal(afterRepair.repair_input_contract.source_review_claim_id, null);
        assert.match(afterRepair.repair_input_contract.instruction, /already has a repair record/);
        await dispatch('retry', {
          task_id: taskId,
          node_id: 'review',
          reason: 'Advance only after the recorded repair.',
          replacement_agent_task_path: '/root/fail-pair-cohort',
          previous_agent_stopped: true,
          state_dir: stateDir,
        });
        const [afterAdvance] = await dispatch('audit-context', { task_id: taskId, state_dir: stateDir });
        assert.equal(afterAdvance.repair_input_contract.action, null);
        assert.equal(afterAdvance.repair_input_contract.source_review_claim_id, null);
        assert.match(afterAdvance.repair_input_contract.instruction, /No failed current-protocol review/);
      }
    }
    await writeFile(manifestPath, JSON.stringify(v3Manifest(workspace, { task_id: 'missing-record' })));
    await dispatch('init', { manifest: manifestPath, });
    const [work] = await dispatch('start', { task_id: 'missing-record', node_id: 'work', agent_task_path: '/root/work', agent_role: 'avsp_terra_high', native_agent_started: true, state_dir: stateDir });
    await dispatch('complete', { task_id: 'missing-record', node_id: 'work', claim_id: work.claim_id, status: 'succeeded', result: resultPath, completion_attestation: 'native_agent_finished', state_dir: stateDir });
    const [review] = await dispatch('start', { task_id: 'missing-record', node_id: 'review', agent_task_path: '/root/reviewer', agent_role: 'avsp_terra_xhigh', native_agent_started: true, state_dir: stateDir });
    await assert.rejects(
      () => dispatch('complete', { task_id: 'missing-record', node_id: 'review', claim_id: review.claim_id, status: 'succeeded', result: resultPath, completion_attestation: 'native_agent_finished', state_dir: stateDir }),
      error => error instanceof ControllerError
        && error.code === 'FAILED_PRECONDITION'
        && error.field_errors[0]?.path === 'review'
        && error.recovery?.action === 'workflow_record_review'
        && /requires a recorded review.*workflow_record_review.*exact claim_id/.test(error.message),
    );
    const [afterMissingRecord] = await dispatch('status', { task_id: 'missing-record', state_dir: stateDir });
    assert.equal(afterMissingRecord.nodes.find(node => node.id === 'review').status, 'running');
    assert.equal(afterMissingRecord.reviews.length, 0);
    await assert.rejects(
      () => dispatch('complete', { task_id: 'missing-record', node_id: 'review', claim_id: review.claim_id, status: 'unavailable', result: resultPath, completion_attestation: 'native_agent_finished', state_dir: stateDir }),
      error => error instanceof ControllerError
        && error.code === 'FAILED_PRECONDITION'
        && error.field_errors[0]?.path === 'review'
        && error.recovery?.action === 'workflow_record_review'
        && /requires a recorded review.*workflow_record_review.*exact claim_id/.test(error.message),
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('v3 max closure abandon and stale requeue restore the frozen charter for a new reviewer', async () => {
  const { dispatch } = await import('../scripts/workflow_controller.mjs');
  const temp = await mkdtemp(path.join(os.tmpdir(), 'agnets-workflow-v3-max-closure-'));
  const workspace = path.join(temp, 'workspace');
  const stateDir = stateDirFor(workspace);
  const manifestPath = path.join(temp, 'manifest.json');
  const resultPath = path.join(temp, 'result.json');
  const reviewPath = path.join(temp, 'review.json');
  const repairPath = path.join(temp, 'repair.json');
  const reviewNode = { id: 'review', kind: 'total_review', agent_type: 'avsp_sol_high', execution_risk: 'read_only', routing_reason: 'independent Sol review', execution_owner: '/root/sol-high', integration_owner: '/root', quality_guard: 'review all requirements' };
  const recordFailure = async (role, reviewer) => {
    const [claim] = await dispatch('start', { task_id: 'max-closure', node_id: 'review', agent_task_path: reviewer, agent_role: role, native_agent_started: true, state_dir: stateDir });
    const [context] = await dispatch('audit-context', { task_id: 'max-closure', state_dir: stateDir });
    await writeFile(reviewPath, JSON.stringify({
      auditor_task: reviewer, auditor_role: role, claim_id: claim.claim_id, verdict: 'fail',
      findings: [{ id: 'blocking-1', severity: 'blocking', requirement_id: 'R1', summary: 'A guarded requirement is not met.', evidence: 'Focused failure evidence.' }],
      requirement_coverage: { R1: 'not met' }, workflow_snapshot: context.workflow_snapshot, workspace_fingerprint: context.workspace_fingerprint,
      scope_and_regression: 'within scope', verification_gaps: 'blocking issue', residual_risk: 'not accepted', independent_assessment: 'Independent failed assessment.', history_reconciliation: 'History does not remove the blocker.', review_history_digest: context.review_history_digest,
    }));
    await dispatch('record-review', { task_id: 'max-closure', review: reviewPath, state_dir: stateDir });
    await writeFile(resultPath, JSON.stringify({ verdict: 'fail', reviewer }));
    await dispatch('complete', { task_id: 'max-closure', node_id: 'review', claim_id: claim.claim_id, status: 'failed', result: resultPath, completion_attestation: 'native_agent_finished', state_dir: stateDir });
    return claim.claim_id;
  };
  const recordRepair = async sourceClaimId => {
    const [context] = await dispatch('audit-context', { task_id: 'max-closure', state_dir: stateDir });
    await writeFile(repairPath, JSON.stringify({
      source_review_claim_id: sourceClaimId, repaired_by: '/root/protected-fix',
      addressed_findings: [{ finding_id: 'blocking-1', resolution: 'Corrected the guarded issue.', verification_evidence: 'Targeted regression passes.' }],
      verification_evidence: 'Targeted regression passes.', workspace_fingerprint: context.workspace_fingerprint,
    }));
    await dispatch('record-repair', { task_id: 'max-closure', repair: repairPath, state_dir: stateDir });
  };
  try {
    await mkdir(workspace, { recursive: true });
    await writeFile(manifestPath, JSON.stringify(v3Manifest(workspace, {
      task_id: 'max-closure', assurance_level: 'sol', assurance_assessment: assessment('sol'), review_entry_stage: 'sol_high', nodes: [{ id: 'work', kind: 'implementation', execution_risk: 'protected', routing_reason: 'bounded work', execution_owner: '/root/work', integration_owner: '/root', quality_guard: 'targeted test' }, reviewNode],
    })));
    await dispatch('init', { manifest: manifestPath, });
    const [work] = await dispatch('start', { task_id: 'max-closure', node_id: 'work', agent_task_path: '/root/work', agent_role: 'avsp_terra_high', native_agent_started: true, state_dir: stateDir });
    await writeFile(resultPath, JSON.stringify({ changed: true }));
    await dispatch('complete', { task_id: 'max-closure', node_id: 'work', claim_id: work.claim_id, status: 'succeeded', result: resultPath, completion_attestation: 'native_agent_finished', state_dir: stateDir });

    const highClaim = await recordFailure('avsp_sol_high', '/root/sol-high');
    await recordRepair(highClaim);
    await dispatch('retry', { task_id: 'max-closure', node_id: 'review', reason: 'advance after repaired high finding', replacement_agent_task_path: '/root/sol-xhigh', previous_agent_stopped: true, state_dir: stateDir });
    const xhighClaim = await recordFailure('avsp_sol_xhigh', '/root/sol-xhigh');
    await recordRepair(xhighClaim);
    await dispatch('retry', { task_id: 'max-closure', node_id: 'review', reason: 'advance after repaired xhigh finding', replacement_agent_task_path: '/root/sol-max-initial', previous_agent_stopped: true, state_dir: stateDir });
    const maxInitialClaim = await recordFailure('avsp_sol_max', '/root/sol-max-initial');
    const [beforeFreeze] = await dispatch('audit-context', { task_id: 'max-closure', state_dir: stateDir });
    assert.equal(beforeFreeze.repair_input_contract.action, null);
    assert.match(beforeFreeze.repair_input_contract.instruction, /workflow_retry first/);
    const [frozen] = await dispatch('retry', { task_id: 'max-closure', node_id: 'review', reason: 'freeze max initial failure into closure charter', replacement_agent_task_path: '/root/sol-max-closure', previous_agent_stopped: true, state_dir: stateDir });
    assert.equal(frozen.node.review_gate.stage, 'sol_max_closure');
    assert.equal(frozen.max_review_charter.status, 'initial_repair_required');
    const [frozenContext] = await dispatch('audit-context', { task_id: 'max-closure', state_dir: stateDir });
    assert.equal(frozenContext.repair_input_contract.action, 'record_repair');
    assert.equal(frozenContext.repair_input_contract.source_review_claim_id, maxInitialClaim);
    assert.deepEqual(frozenContext.repair_input_contract.blocking_finding_ids, ['blocking-1']);
    await recordRepair(maxInitialClaim);
    await dispatch('retry', { task_id: 'max-closure', node_id: 'review', reason: 'open repaired max closure for its reviewer', replacement_agent_task_path: '/root/sol-max-closure', previous_agent_stopped: true, state_dir: stateDir });

    const [firstClosure] = await dispatch('start', { task_id: 'max-closure', node_id: 'review', agent_task_path: '/root/sol-max-closure', agent_role: 'avsp_sol_max', native_agent_started: true, state_dir: stateDir });
    await dispatch('abandon', { task_id: 'max-closure', node_id: 'review', claim_id: firstClosure.claim_id, reason: 'closure reviewer exited', previous_agent_stopped: true, state_dir: stateDir });
    let [afterAbandon] = await dispatch('audit-context', { task_id: 'max-closure', state_dir: stateDir });
    assert.equal(afterAbandon.max_review_charter.status, 'closure_ready');
    assert.equal(afterAbandon.max_review_charter.active_closure_claim_id, null);
    assert.equal(afterAbandon.max_review_charter.closure_attempt_count, 0);
    await dispatch('retry', { task_id: 'max-closure', node_id: 'review', reason: 'replace abandoned closure reviewer', replacement_agent_task_path: '/root/sol-max-closure-retry', previous_agent_stopped: true, state_dir: stateDir });
    const [staleClosure] = await dispatch('start', { task_id: 'max-closure', node_id: 'review', agent_task_path: '/root/sol-max-closure-retry', agent_role: 'avsp_sol_max', native_agent_started: true, lease_duration_sec: 1, state_dir: stateDir });
    await new Promise(resolve => setTimeout(resolve, 1_100));
    await dispatch('requeue-stale', { task_id: 'max-closure', node_id: 'review', claim_id: staleClosure.claim_id, reason: 'closure reviewer heartbeat expired', replacement_agent_task_path: '/root/sol-max-closure-final', previous_agent_stopped: true, state_dir: stateDir });
    const [afterStale] = await dispatch('audit-context', { task_id: 'max-closure', state_dir: stateDir });
    assert.equal(afterStale.max_review_charter.status, 'closure_ready');
    assert.equal(afterStale.max_review_charter.active_closure_claim_id, null);
    assert.equal(afterStale.max_review_charter.closure_attempt_count, 0);
    const [replacement] = await dispatch('start', { task_id: 'max-closure', node_id: 'review', agent_task_path: '/root/sol-max-closure-final', agent_role: 'avsp_sol_max', native_agent_started: true, state_dir: stateDir });
    assert.ok(replacement.claim_id);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('v3 initialization supports the documented workspace control state_dir', async () => {
  const { dispatch } = await import('../scripts/workflow_controller.mjs');
  const { globalWorkflowStorePath } = await import('../scripts/global_workflow_store.mjs');
  const temp = await mkdtemp(path.join(os.tmpdir(), 'agnets-workflow-v3-control-state-'));
  const workspace = path.join(temp, 'workspace');
  const stateDir = stateDirFor(workspace);
  const manifestPath = path.join(temp, 'manifest.json');
  try {
    await mkdir(workspace, { recursive: true });
    await writeFile(manifestPath, JSON.stringify(v3Manifest(workspace)));
    const [initialized] = await dispatch('init', { manifest: manifestPath, });
    assert.equal(initialized.database_path, globalWorkflowStorePath());
    assert.equal(initialized.state_path, globalWorkflowStorePath());
    assert.deepEqual(initialized.task_key, { namespace: await canonicalStateNamespace(stateDir), task_id: 'feature' });
    const [ready] = await dispatch('ready', { task_id: 'feature', state_dir: stateDir });
    assert.equal(ready.ready_nodes[0].id, 'work');
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('v3 initialization completes missing direct review dependencies', async () => {
  const { dispatch } = await import('../scripts/workflow_controller.mjs');
  const temp = await mkdtemp(path.join(os.tmpdir(), 'agnets-workflow-v3-review-topology-'));
  const workspace = path.join(temp, 'workspace');
  const stateDir = stateDirFor(workspace);
  const manifestPath = path.join(temp, 'manifest.json');
  const evidence = id => ({ id, kind: 'evidence', execution_risk: 'read_only', routing_reason: 'independent evidence', execution_owner: `/root/${id}`, integration_owner: '/root', quality_guard: 'record evidence' });
  const review = { id: 'review', kind: 'quality_review', depends_on: ['work-a'], execution_risk: 'read_only', routing_reason: 'independent quality gate', execution_owner: '/root/reviewer', integration_owner: '/root', quality_guard: 'review requirements' };
  try {
    await mkdir(workspace, { recursive: true });
    await writeFile(manifestPath, JSON.stringify(v3Manifest(workspace, { nodes: [evidence('work-a'), evidence('work-b'), evidence('work-c'), review] })));
    const [initialized] = await dispatch('init', { manifest: manifestPath, });
    assert.deepEqual(initialized.task.nodes.find(node => node.id === 'review').depends_on, ['work-a', 'work-b', 'work-c']);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('v3 namespace authority rejects a replaced workspace before a claim can mutate it', async () => {
  const { dispatch } = await import('../scripts/workflow_controller.mjs');
  const temp = await mkdtemp(path.join(os.tmpdir(), 'agnets-workflow-v3-authority-'));
  const workspace = path.join(temp, 'workspace');
  const stateDir = stateDirFor(workspace);
  const manifestPath = path.join(temp, 'manifest.json');
  try {
    await mkdir(workspace, { recursive: true });
    await writeFile(manifestPath, JSON.stringify(v3Manifest(workspace)));
    await dispatch('init', { manifest: manifestPath, });
    const displaced = path.join(temp, 'displaced-workspace');
    await rename(workspace, displaced);
    await mkdir(workspace);
    await assert.rejects(
      () => dispatch('claim', { task_id: 'feature', node_id: 'work', agent_task_path: '/root/work', agent_role: 'avsp_terra_high', state_dir: stateDir }),
      /Controller namespace workspace anchor changed/,
    );
    assert.equal(existsSync(stateDir), false);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('v3 release-only state is never pruned merely by age', async () => {
  const { dispatch } = await import('../scripts/workflow_controller.mjs');
  const { globalWorkflowStorePath } = await import('../scripts/global_workflow_store.mjs');
  const temp = await mkdtemp(path.join(os.tmpdir(), 'agnets-workflow-v3-prune-'));
  const workspace = path.join(temp, 'workspace');
  const stateDir = stateDirFor(workspace);
  const manifestPath = path.join(temp, 'manifest.json');
  try {
    await mkdir(workspace, { recursive: true });
    await writeFile(manifestPath, JSON.stringify(v3Manifest(workspace)));
    await dispatch('init', { manifest: manifestPath, });
    const [activeCloseCheck, activeCloseCode] = await dispatch('close-check', { task_id: 'feature', state_dir: stateDir });
    assert.equal(activeCloseCode, 2);
    assert.equal(activeCloseCheck.close_allowed, false);
    assert.equal(activeCloseCheck.state_path, globalWorkflowStorePath());
    assert.equal(activeCloseCheck.database_path, globalWorkflowStorePath());
    assert.deepEqual(activeCloseCheck.task_key, { namespace: await canonicalStateNamespace(stateDir), task_id: 'feature' });
    const [released] = await dispatch('release-workspace', { task_id: 'feature', previous_agent_stopped: true, state_dir: stateDir });
    assert.equal(released.state_path, globalWorkflowStorePath());
    assert.equal(released.database_path, globalWorkflowStorePath());
    assert.deepEqual(released.task_key, { namespace: await canonicalStateNamespace(stateDir), task_id: 'feature' });
    assert.equal('lease_path' in released, false);
    const [closeCheck] = await dispatch('close-check', { task_id: 'feature', state_dir: stateDir });
    assert.equal(closeCheck.state_path, globalWorkflowStorePath());
    assert.equal(closeCheck.database_path, globalWorkflowStorePath());
    assert.deepEqual(closeCheck.task_key, { namespace: await canonicalStateNamespace(stateDir), task_id: 'feature' });
    assert.equal(closeCheck.workspace_lease.state_path, globalWorkflowStorePath());
    assert.equal(closeCheck.workspace_lease.database_path, globalWorkflowStorePath());
    assert.deepEqual(closeCheck.workspace_lease.task_key, { namespace: await canonicalStateNamespace(stateDir), task_id: 'feature' });
    const [freshPrune] = await dispatch('prune-expired', { state_dir: stateDir });
    assert.equal(freshPrune.deleted_count, 0);
    const [expiredPrune] = await dispatch('prune-expired', { state_dir: stateDir });
    assert.equal(expiredPrune.deleted_count, 0);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('v3 prune deletes only fully closed released tasks and keeps corrupt or artifact-failed rows', async () => {
  const { dispatch } = await import('../scripts/workflow_controller.mjs');
  const { globalTaskStateExists, globalWorkflowArtifactTaskPath, globalWorkflowStorePath, readGlobalTaskState, taskNamespaceKey, writeGlobalTaskState } = await import('../scripts/global_workflow_store.mjs');
  const temp = await mkdtemp(path.join(os.tmpdir(), 'agnets-workflow-v3-prune-contract-'));
  const workspace = path.join(temp, 'workspace');
  const stateDir = stateDirFor(workspace);
  const manifestPath = path.join(temp, 'manifest.json');
  const old = '1970-01-01T00:00:00.000Z';
  const makeReleasedState = async (taskId, status, { closedRevisionMatches = true } = {}) => {
    await writeFile(manifestPath, JSON.stringify(v3Manifest(workspace, { task_id: taskId })));
    const [initialized] = await dispatch('init', { manifest: manifestPath, });
    await dispatch('release-workspace', { task_id: taskId, previous_agent_stopped: true, state_dir: stateDir });
    const logicalPath = path.join(initialized.task_key.namespace, `${initialized.task_key.task_id}.sqlite`);
    const state = await readGlobalTaskState(logicalPath);
    for (const node of Object.values(state.nodes)) node.status = status;
    state.closed_at = old;
    state.closed_revision = closedRevisionMatches ? state.workflow_revision : state.workflow_revision + 1;
    state.updated_at = old;
    await writeGlobalTaskState(logicalPath, state);
    return logicalPath;
  };
  try {
    await mkdir(workspace, { recursive: true });
    const eligible = await makeReleasedState('eligible', 'succeeded');
    const releaseOnly = await makeReleasedState('release-only', 'pending');
    const mismatchedRevision = await makeReleasedState('revision-mismatch', 'succeeded', { closedRevisionMatches: false });
    const retainedByStatus = [];
    for (const status of ['failed', 'blocked', 'abandoned', 'unavailable']) retainedByStatus.push(await makeReleasedState(`retained-${status}`, status));
    const artifactFailure = await makeReleasedState('artifact-failure', 'succeeded');
    const corrupt = await makeReleasedState('corrupt', 'succeeded');
    const store = new DatabaseSync(globalWorkflowStorePath());
    try {
      const result = store.prepare('UPDATE task_state SET payload = ? WHERE namespace_key = ? AND task_id = ?').run('{not valid JSON', taskNamespaceKey(corrupt), 'corrupt');
      assert.equal(result.changes, 1);
    } finally {
      store.close();
    }
    const artifactFailurePath = globalWorkflowArtifactTaskPath(await canonicalStateNamespace(stateDir), 'artifact-failure');
    await mkdir(path.dirname(artifactFailurePath), { recursive: true });
    await writeFile(artifactFailurePath, 'not a directory, so artifact cleanup must fail');
    const [prune] = await dispatch('prune-expired', { state_dir: stateDir });
    assert.deepEqual(prune.deleted.map(item => item.task_id), ['eligible']);
    assert.equal(await globalTaskStateExists(eligible), false);
    assert.equal(await globalTaskStateExists(releaseOnly), true);
    assert.equal(await globalTaskStateExists(mismatchedRevision), true);
    for (const logicalPath of retainedByStatus) assert.equal(await globalTaskStateExists(logicalPath), true);
    assert.equal(await globalTaskStateExists(artifactFailure), true);
    assert.equal(await globalTaskStateExists(corrupt), true);
    assert.ok(prune.retained.some(item => item.task_id === 'artifact-failure' && /artifact cleanup/.test(item.reason)));
    assert.ok(prune.retained.some(item => item.task_id === 'corrupt' && /corrupt or unreadable/.test(item.reason)));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('v3 startup prune advances past a full retained batch to a later eligible task', async () => {
  const { dispatch, pruneExpiredTasksAtMcpStartup } = await import('../scripts/workflow_controller.mjs');
  const { globalTaskStateExists, globalWorkflowStorePath, readGlobalTaskState, taskNamespaceKey, writeGlobalTaskState } = await import('../scripts/global_workflow_store.mjs');
  const temp = await mkdtemp(path.join(os.tmpdir(), 'agnets-workflow-v3-prune-progress-'));
  const workspace = path.join(temp, 'workspace');
  const stateDir = stateDirFor(workspace);
  const manifestPath = path.join(temp, 'manifest.json');
  const old = '1970-01-01T00:00:00.000Z';
  const validTaskId = 'zzz-valid';
  try {
    await mkdir(workspace, { recursive: true });
    await writeFile(manifestPath, JSON.stringify(v3Manifest(workspace, { task_id: validTaskId })));
    const [initialized] = await dispatch('init', { manifest: manifestPath, });
    await dispatch('release-workspace', { task_id: validTaskId, previous_agent_stopped: true, state_dir: stateDir });
    const validPath = path.join(initialized.task_key.namespace, `${validTaskId}.sqlite`);
    const baseState = await readGlobalTaskState(validPath);
    for (const node of Object.values(baseState.nodes)) node.status = 'succeeded';
    baseState.closed_at = old;
    baseState.closed_revision = baseState.workflow_revision;
    baseState.updated_at = old;
    await writeGlobalTaskState(validPath, baseState);

    const retainedPaths = [];
    for (let index = 0; index < 33; index++) {
      const taskId = `retained-${String(index).padStart(2, '0')}`;
      const logicalPath = path.join(initialized.task_key.namespace, `${taskId}.sqlite`);
      const retainedState = structuredClone(baseState);
      retainedState.task_id = taskId;
      retainedState.workspace_lease.state_path = logicalPath;
      await writeGlobalTaskState(logicalPath, retainedState);
      retainedPaths.push(logicalPath);
    }

    const store = new DatabaseSync(globalWorkflowStorePath());
    try {
      const corrupt = store.prepare('UPDATE task_state SET payload = ? WHERE namespace_key = ? AND task_id = ?');
      for (const logicalPath of retainedPaths) {
        const taskId = path.basename(logicalPath, '.sqlite');
        assert.equal(corrupt.run('{not valid JSON', taskNamespaceKey(logicalPath), taskId).changes, 1);
      }
    } finally {
      store.close();
    }

    const prune = await pruneExpiredTasksAtMcpStartup({ max_batches: 2 });
    assert.equal(prune.deleted_count, 1);
    assert.equal(await globalTaskStateExists(validPath), false);
    for (const logicalPath of retainedPaths) assert.equal(await globalTaskStateExists(logicalPath), true);

    const inspected = new DatabaseSync(globalWorkflowStorePath(), { readOnly: true });
    try {
      assert.equal(inspected.prepare("SELECT count(*) AS count FROM task_prune_job WHERE namespace_key = ? AND phase = 'retry'").get(taskNamespaceKey(validPath)).count, retainedPaths.length);
    } finally {
      inspected.close();
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
