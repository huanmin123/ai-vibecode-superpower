import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises';
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
const sqljsRuntime = path.join(root, 'vendor', 'sqljs', 'sql-wasm.js');

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

function quarantinedMetadataFixture({ stateDir, taskId, errorRoot, stableJson }) {
  const originalStatePath = path.join(stateDir, `${taskId}.sqlite`);
  const quarantinedAt = '2025-01-01T00:00:00.000Z';
  const metadata = {
    version: 4,
    status: 'quarantined',
    task_id: taskId,
    original_state_path: originalStatePath,
    error_path: '',
    reason: 'legacy state fixture is quarantined',
    quarantined_at: quarantinedAt,
    delete_after: '2026-01-01T00:00:00.000Z',
    files: [path.basename(originalStatePath)],
    move_error: null,
    review_artifacts: null,
    workspace: null,
    registry_path: null,
    binding: '',
    authority_anchor: '',
  };
  metadata.authority_anchor = createHash('sha256').update(stableJson({
    schema: 'workflow-quarantine-authority-v1',
    workspace: metadata.workspace,
    registry_path: metadata.registry_path,
    task_id: metadata.task_id,
    original_state_path: metadata.original_state_path,
    files: metadata.files,
    review_artifacts: metadata.review_artifacts,
  })).digest('hex');
  const errorPath = path.join(errorRoot, `${taskId}-${metadata.authority_anchor}-00000000-0000-4000-8000-000000000000`);
  metadata.error_path = errorPath;
  metadata.binding = createHash('sha256').update(stableJson({
    schema: 'workflow-quarantine-binding-v2',
    error_path: path.resolve(errorPath),
    task_id: metadata.task_id,
    original_state_path: metadata.original_state_path,
    files: metadata.files,
    review_artifacts: metadata.review_artifacts,
    workspace: metadata.workspace,
    registry_path: metadata.registry_path,
    authority_anchor: metadata.authority_anchor,
  })).digest('hex');
  return { metadata, errorPath };
}

test('controller accepts only the current v3 manifest and SQLite state path', async () => {
  const source = await readFile(controller, 'utf8');
  assert.match(source, /routing_schema_version must be 3/);
  assert.match(source, /Current global controller state does not exist/);
  assert.doesNotMatch(source, new RegExp(['avsp', 'luna', 'high', 'writer'].join('_')));
  assert.doesNotMatch(source, /record-verification/);
  assert.match(source, /const initialState = normalizeState\(await loadState\(filePath\)\)/);
});

test('v3 requires an explicit justification for a workspace-wide write claim', { skip: !existsSync(sqljsRuntime) }, async () => {
  const { ControllerError, dispatch } = await import('../scripts/workflow_controller.mjs');
  const temp = await mkdtemp(path.join(os.tmpdir(), 'agnets-workflow-v3-claim-scope-'));
  const workspace = path.join(temp, 'workspace');
  const stateDir = path.join(workspace, '.codex', 'workflow-controller');
  const manifestPath = path.join(temp, 'manifest.json');
  try {
    await mkdir(workspace, { recursive: true });
    const manifest = v3Manifest(workspace);
    delete manifest.global_write_justification;
    await writeFile(manifestPath, JSON.stringify(manifest));
    await assert.rejects(
      () => dispatch('init', { manifest: manifestPath, state_dir: stateDir }),
      error => error instanceof ControllerError && /global_write_justification is required/.test(error.message),
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('v3 requires every new task state directory to stay in a non-ignored workspace directory', { skip: !existsSync(sqljsRuntime) }, async () => {
  const { ControllerError, dispatch } = await import('../scripts/workflow_controller.mjs');
  const temp = await mkdtemp(path.join(os.tmpdir(), 'agnets-workflow-v3-state-boundary-'));
  const workspace = path.join(temp, 'workspace');
  const stateDir = path.join(workspace, '.codex', 'workflow-controller');
  const externalStateDir = path.join(temp, 'external-state');
  const ignoredStateDirs = [
    path.join(workspace, '.git', 'workflow-state'),
    path.join(workspace, '.workflow-errors', 'workflow-state'),
    path.join(workspace, '.workflow-review-results', 'workflow-state'),
  ];
  const manifestPath = path.join(temp, 'manifest.json');
  try {
    await mkdir(workspace, { recursive: true });
    await writeFile(manifestPath, JSON.stringify(v3Manifest(workspace)));
    await dispatch('init', { manifest: manifestPath, state_dir: stateDir });
    await writeFile(manifestPath, JSON.stringify(v3Manifest(workspace, { task_id: 'external-state' })));
    await assert.rejects(
      () => dispatch('init', { manifest: manifestPath, state_dir: externalStateDir }),
      error => error instanceof ControllerError && /state_dir must be inside its workspace/.test(error.message),
    );
    for (const [index, ignoredStateDir] of ignoredStateDirs.entries()) {
      await writeFile(manifestPath, JSON.stringify(v3Manifest(workspace, { task_id: `ignored-state-${index}` })));
      await assert.rejects(
        () => dispatch('init', { manifest: manifestPath, state_dir: ignoredStateDir }),
        error => error instanceof ControllerError && /state_dir cannot be inside an ignored workspace directory/.test(error.message),
      );
      assert.equal(existsSync(ignoredStateDir), false);
    }
    assert.equal(existsSync(externalStateDir), false);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('v3 runtime initializes current manifests and rejects retired schema states', { skip: !existsSync(sqljsRuntime) }, async () => {
  const { ControllerError, dispatch } = await import('../scripts/workflow_controller.mjs');
  const temp = await mkdtemp(path.join(os.tmpdir(), 'agnets-workflow-v3-'));
  const workspace = path.join(temp, 'workspace');
  const stateDir = path.join(workspace, '.codex', 'workflow-controller');
  const manifestPath = path.join(temp, 'manifest.json');
  try {
    await mkdir(workspace, { recursive: true });
    await mkdir(stateDir, { recursive: true });
    await writeFile(manifestPath, JSON.stringify(v3Manifest(workspace)));
    const [initialized] = await dispatch('init', { manifest: manifestPath, state_dir: stateDir });
    assert.equal(initialized.task.task_id, 'feature');

    const [work] = await dispatch('claim', { task_id: 'feature', node_id: 'work', agent_task_path: '/root/work', agent_role: 'avsp_terra_high', state_dir: stateDir });
    const resultPath = path.join(temp, 'work-result.json');
    await writeFile(resultPath, JSON.stringify({ changed: true }));
    await dispatch('heartbeat', { task_id: 'feature', node_id: 'work', claim_id: work.claim_id, state_dir: stateDir });
    const [completed] = await dispatch('complete', { task_id: 'feature', node_id: 'work', claim_id: work.claim_id, status: 'succeeded', result: resultPath, completion_attestation: 'native_agent_finished', state_dir: stateDir });
    assert.equal(completed.node.status, 'succeeded');

    const assessmentPath = path.join(temp, 'sol-assessment.json');
    await writeFile(assessmentPath, JSON.stringify(assessment('sol')));
    const [raised] = await dispatch('raise-assurance', { task_id: 'feature', target_assurance_level: 'sol', reason: 'Execution revealed an unknown global boundary.', assurance_assessment: assessmentPath, replacement_agent_task_path: '/root/sol-reviewer', integration_owner: '/root', state_dir: stateDir });
    assert.equal(raised.assurance_level, 'sol');
    assert.equal(raised.node.agent_type, 'avsp_sol_high');

    await writeFile(manifestPath, JSON.stringify(v3Manifest(workspace, { task_id: 'retired', routing_schema_version: 2 })));
    await assert.rejects(() => dispatch('init', { manifest: manifestPath, state_dir: stateDir }), error => error instanceof ControllerError && /routing_schema_version must be 3/.test(error.message));

    await writeFile(manifestPath, JSON.stringify(v3Manifest(workspace, { task_id: 'controlled', assurance_assessment: assessment('controlled') })));
    await assert.rejects(() => dispatch('init', { manifest: manifestPath, state_dir: stateDir }), error => error instanceof ControllerError && /cannot initialize a persistent workflow/.test(error.message));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('v3 writes workspace coordination only to the user-level SQLite store', { skip: !existsSync(sqljsRuntime) }, async () => {
  const { dispatch } = await import('../scripts/workflow_controller.mjs');
  const { globalWorkflowStorePath } = await import('../scripts/global_workflow_store.mjs');
  const temp = await mkdtemp(path.join(os.tmpdir(), 'agnets-workflow-v3-sqlite-control-'));
  const workspace = path.join(temp, 'workspace');
  const stateDir = path.join(workspace, 'state-a');
  const manifestPath = path.join(temp, 'manifest.json');
  const controlPath = path.join(workspace, '.codex', 'workflow-controller', 'workflow.sqlite');
  try {
    await mkdir(workspace, { recursive: true });
    await writeFile(manifestPath, JSON.stringify(v3Manifest(workspace)));
    const [initialized] = await dispatch('init', { manifest: manifestPath, state_dir: stateDir });
    const canonicalStateDir = await realpath(stateDir);
    assert.equal(initialized.database_path, globalWorkflowStorePath());
    assert.equal(initialized.state_path, globalWorkflowStorePath());
    assert.deepEqual(initialized.task_key, { namespace: canonicalStateDir, task_id: 'feature' });
    assert.equal(existsSync(controlPath), false);
    assert.equal(existsSync(path.join(stateDir, 'workspace-lease.json')), false);
    assert.equal(existsSync(path.join(workspace, '.codex-workflow-controller-authority.json')), false);
    assert.deepEqual((await readdir(stateDir)).sort(), []);
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

test('directory doctor reports quarantined legacy state by global database and task key', { skip: !existsSync(sqljsRuntime) }, async () => {
  const { dispatch, stableJson } = await import('../scripts/workflow_controller.mjs');
  const { globalWorkflowStorePath } = await import('../scripts/global_workflow_store.mjs');
  const temp = await mkdtemp(path.join(os.tmpdir(), 'agnets-workflow-v3-doctor-quarantine-'));
  const workspace = path.join(temp, 'workspace');
  const stateDir = path.join(workspace, '.codex', 'workflow-controller');
  const errorRoot = path.join(stateDir, '.workflow-errors');
  const taskId = 'legacy-task';
  try {
    await mkdir(errorRoot, { recursive: true });
    const canonicalStateDir = await realpath(stateDir);
    const canonicalErrorRoot = path.join(canonicalStateDir, '.workflow-errors');
    const { metadata, errorPath } = quarantinedMetadataFixture({ stateDir: canonicalStateDir, taskId, errorRoot: canonicalErrorRoot, stableJson });
    await mkdir(errorPath);
    const database = new DatabaseSync(path.join(canonicalErrorRoot, 'quarantine.sqlite'));
    try {
      database.exec('CREATE TABLE quarantine_entry (error_path TEXT NOT NULL PRIMARY KEY, schema_version INTEGER NOT NULL, payload TEXT NOT NULL, updated_at TEXT NOT NULL)');
      database.prepare('INSERT INTO quarantine_entry (error_path, schema_version, payload, updated_at) VALUES (?, ?, ?, ?)')
        .run(path.resolve(errorPath), 1, JSON.stringify(metadata), metadata.quarantined_at);
      assert.equal(database.prepare('SELECT schema_version FROM quarantine_entry WHERE error_path = ?').get(path.resolve(errorPath)).schema_version, 1);
    } finally {
      database.close();
    }
    const [doctor] = await dispatch('doctor', { state_dir: stateDir });
    const entry = doctor.checks.find(check => check.id === 'quarantined_states').detail.entries[0];
    assert.ok(entry, JSON.stringify(doctor.checks));
    assert.equal(entry.state_path, globalWorkflowStorePath());
    assert.equal(entry.database_path, globalWorkflowStorePath());
    assert.deepEqual(entry.task_key, { namespace: canonicalStateDir, task_id: taskId });
    assert.equal(entry.legacy_state_path, path.join(canonicalStateDir, `${taskId}.sqlite`));
    assert.equal(entry.error_path, errorPath);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('v3 permits independent write claims in one workspace without taking a whole-workspace claim', { skip: !existsSync(sqljsRuntime) }, async () => {
  const { dispatch } = await import('../scripts/workflow_controller.mjs');
  const temp = await mkdtemp(path.join(os.tmpdir(), 'agnets-workflow-v3-disjoint-claims-'));
  const workspace = path.join(temp, 'workspace');
  const stateDir = path.join(workspace, '.codex', 'workflow-controller');
  const alphaManifestPath = path.join(temp, 'alpha.json');
  const betaManifestPath = path.join(temp, 'beta.json');
  try {
    await mkdir(workspace, { recursive: true });
    await writeFile(alphaManifestPath, JSON.stringify(v3Manifest(workspace, { task_id: 'alpha', workspace_claims: [{ mode: 'write', prefix: 'apps/alpha' }] })));
    await writeFile(betaManifestPath, JSON.stringify(v3Manifest(workspace, { task_id: 'beta', workspace_claims: [{ mode: 'write', prefix: 'apps/beta' }] })));
    const [alpha] = await dispatch('init', { manifest: alphaManifestPath, state_dir: stateDir });
    const [beta] = await dispatch('init', { manifest: betaManifestPath, state_dir: stateDir });
    assert.equal(alpha.task.task_id, 'alpha');
    assert.equal(beta.task.task_id, 'beta');
    assert.equal(existsSync(path.join(stateDir, 'workflow.sqlite')), false);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('v3 treats workspace claims as a write-lock envelope and locks only actual paths on demand', { skip: !existsSync(sqljsRuntime) }, async () => {
  const { ControllerError, dispatch } = await import('../scripts/workflow_controller.mjs');
  const temp = await mkdtemp(path.join(os.tmpdir(), 'agnets-workflow-v3-demand-locks-'));
  const workspace = path.join(temp, 'workspace');
  const stateDir = path.join(workspace, '.codex', 'workflow-controller');
  const alphaManifestPath = path.join(temp, 'alpha.json');
  const betaManifestPath = path.join(temp, 'beta.json');
  const resultPath = path.join(temp, 'result.json');
  try {
    await mkdir(workspace, { recursive: true });
    const sharedClaim = [{ mode: 'write', prefix: 'apps/shared' }];
    await writeFile(alphaManifestPath, JSON.stringify(v3Manifest(workspace, { task_id: 'alpha', workspace_claims: sharedClaim })));
    await writeFile(betaManifestPath, JSON.stringify(v3Manifest(workspace, { task_id: 'beta', workspace_claims: sharedClaim })));
    await dispatch('init', { manifest: alphaManifestPath, state_dir: stateDir });
    await dispatch('init', { manifest: betaManifestPath, state_dir: stateDir });

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

test('v3 removes retired JSON coordination instead of loading or migrating it', { skip: !existsSync(sqljsRuntime) }, async () => {
  const { dispatch } = await import('../scripts/workflow_controller.mjs');
  const temp = await mkdtemp(path.join(os.tmpdir(), 'agnets-workflow-v3-retired-control-'));
  const workspace = path.join(temp, 'workspace');
  const stateDir = path.join(workspace, '.codex', 'workflow-controller');
  const manifestPath = path.join(temp, 'manifest.json');
  const legacyLeasePath = path.join(stateDir, 'workspace-lease.json');
  const legacyAuthorityPath = path.join(workspace, '.codex-workflow-controller-authority.json');
  try {
    await mkdir(stateDir, { recursive: true });
    await writeFile(legacyLeasePath, '{legacy lease is intentionally unreadable}');
    await writeFile(legacyAuthorityPath, '{legacy authority is intentionally unreadable}');
    await writeFile(manifestPath, JSON.stringify(v3Manifest(workspace)));
    const [initialized] = await dispatch('init', { manifest: manifestPath, state_dir: stateDir });
    assert.equal(initialized.task.task_id, 'feature');
    assert.equal(existsSync(legacyLeasePath), false);
    assert.equal(existsSync(legacyAuthorityPath), false);
    assert.equal((await readdir(stateDir)).some(name => name.startsWith('workspace-lease.json.')), false);
    assert.equal((await readdir(workspace)).some(name => name.startsWith('.codex-workflow-controller-authority.json.')), false);
    assert.equal(existsSync(path.join(stateDir, 'workflow.sqlite')), false);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('v3 initialization removes a retired JSON state before creating SQLite state', { skip: !existsSync(sqljsRuntime) }, async () => {
  const { dispatch } = await import('../scripts/workflow_controller.mjs');
  const { globalWorkflowStorePath } = await import('../scripts/global_workflow_store.mjs');
  const temp = await mkdtemp(path.join(os.tmpdir(), 'agnets-workflow-v3-legacy-json-'));
  const workspace = path.join(temp, 'workspace');
  const stateDir = path.join(workspace, '.codex', 'workflow-controller');
  const manifestPath = path.join(temp, 'manifest.json');
  const legacyStatePath = path.join(stateDir, 'feature.json');
  try {
    await mkdir(workspace, { recursive: true });
    await mkdir(stateDir, { recursive: true });
    await writeFile(legacyStatePath, JSON.stringify({ version: 1, task_id: 'feature', workspace }));
    await writeFile(manifestPath, JSON.stringify(v3Manifest(workspace)));
    const [initialized] = await dispatch('init', { manifest: manifestPath, state_dir: stateDir });
    assert.equal(existsSync(legacyStatePath), false);
    assert.equal(existsSync(path.join(stateDir, 'feature.sqlite')), false);
    assert.equal(initialized.state_path, globalWorkflowStorePath());
    assert.equal(existsSync(initialized.database_path), true);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('v3 blocks legacy local task and workspace SQLite files without modifying them', { skip: !existsSync(sqljsRuntime) }, async () => {
  const { ControllerError, dispatch } = await import('../scripts/workflow_controller.mjs');
  const temp = await mkdtemp(path.join(os.tmpdir(), 'agnets-workflow-v3-legacy-sqlite-'));
  const workspace = path.join(temp, 'workspace');
  const stateDir = path.join(workspace, '.codex', 'workflow-controller');
  const manifestPath = path.join(temp, 'manifest.json');
  const legacyPaths = [path.join(stateDir, 'feature.sqlite'), path.join(stateDir, 'workflow.sqlite')];
  try {
    await mkdir(stateDir, { recursive: true });
    for (const legacyPath of legacyPaths) {
      await writeFile(legacyPath, `legacy bytes must remain untouched: ${path.basename(legacyPath)}`);
      const before = await readFile(legacyPath);
      await writeFile(manifestPath, JSON.stringify(v3Manifest(workspace)));
      await assert.rejects(
        () => dispatch('init', { manifest: manifestPath, state_dir: stateDir }),
        error => error instanceof ControllerError && /LEGACY_STATE_MIGRATION_REQUIRED/.test(error.message),
      );
      assert.deepEqual(await readFile(legacyPath), before);
      await unlink(legacyPath);
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('v3 retries an abandoned ordinary protocol review at the same stage with a new reviewer', { skip: !existsSync(sqljsRuntime) }, async () => {
  const { dispatch } = await import('../scripts/workflow_controller.mjs');
  const temp = await mkdtemp(path.join(os.tmpdir(), 'agnets-workflow-v3-abandoned-review-'));
  const workspace = path.join(temp, 'workspace');
  const stateDir = path.join(workspace, '.codex', 'workflow-controller');
  const manifestPath = path.join(temp, 'manifest.json');
  const resultPath = path.join(temp, 'work-result.json');
  try {
    await mkdir(workspace, { recursive: true });
    await writeFile(manifestPath, JSON.stringify(v3Manifest(workspace)));
    await dispatch('init', { manifest: manifestPath, state_dir: stateDir });
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

test('v3 non-cohort review completion accepts only its exact recorded verdict/status pair', { skip: !existsSync(sqljsRuntime) }, async () => {
  const { ControllerError, dispatch } = await import('../scripts/workflow_controller.mjs');
  const temp = await mkdtemp(path.join(os.tmpdir(), 'agnets-workflow-v3-review-matrix-'));
  const workspace = path.join(temp, 'workspace');
  const stateDir = path.join(workspace, '.codex', 'workflow-controller');
  const manifestPath = path.join(temp, 'manifest.json');
  const resultPath = path.join(temp, 'result.json');
  const prepare = async (taskId, verdict) => {
    await writeFile(manifestPath, JSON.stringify(v3Manifest(workspace, { task_id: taskId })));
    await dispatch('init', { manifest: manifestPath, state_dir: stateDir });
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
    }
    await writeFile(manifestPath, JSON.stringify(v3Manifest(workspace, { task_id: 'missing-record' })));
    await dispatch('init', { manifest: manifestPath, state_dir: stateDir });
    const [work] = await dispatch('start', { task_id: 'missing-record', node_id: 'work', agent_task_path: '/root/work', agent_role: 'avsp_terra_high', native_agent_started: true, state_dir: stateDir });
    await dispatch('complete', { task_id: 'missing-record', node_id: 'work', claim_id: work.claim_id, status: 'succeeded', result: resultPath, completion_attestation: 'native_agent_finished', state_dir: stateDir });
    const [review] = await dispatch('start', { task_id: 'missing-record', node_id: 'review', agent_task_path: '/root/reviewer', agent_role: 'avsp_terra_xhigh', native_agent_started: true, state_dir: stateDir });
    await assert.rejects(
      () => dispatch('complete', { task_id: 'missing-record', node_id: 'review', claim_id: review.claim_id, status: 'succeeded', result: resultPath, completion_attestation: 'native_agent_finished', state_dir: stateDir }),
      error => error instanceof ControllerError && /requires a recorded review/.test(error.message),
    );
    await assert.rejects(
      () => dispatch('complete', { task_id: 'missing-record', node_id: 'review', claim_id: review.claim_id, status: 'unavailable', result: resultPath, completion_attestation: 'native_agent_finished', state_dir: stateDir }),
      error => error instanceof ControllerError && /requires a recorded review/.test(error.message),
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('v3 max closure abandon and stale requeue restore the frozen charter for a new reviewer', { skip: !existsSync(sqljsRuntime) }, async () => {
  const { dispatch } = await import('../scripts/workflow_controller.mjs');
  const temp = await mkdtemp(path.join(os.tmpdir(), 'agnets-workflow-v3-max-closure-'));
  const workspace = path.join(temp, 'workspace');
  const stateDir = path.join(workspace, '.codex', 'workflow-controller');
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
    await dispatch('init', { manifest: manifestPath, state_dir: stateDir });
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
    const [frozen] = await dispatch('retry', { task_id: 'max-closure', node_id: 'review', reason: 'freeze max initial failure into closure charter', replacement_agent_task_path: '/root/sol-max-closure', previous_agent_stopped: true, state_dir: stateDir });
    assert.equal(frozen.node.review_gate.stage, 'sol_max_closure');
    assert.equal(frozen.max_review_charter.status, 'initial_repair_required');
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

test('v3 initialization supports the documented workspace control state_dir', { skip: !existsSync(sqljsRuntime) }, async () => {
  const { dispatch } = await import('../scripts/workflow_controller.mjs');
  const { globalWorkflowStorePath } = await import('../scripts/global_workflow_store.mjs');
  const temp = await mkdtemp(path.join(os.tmpdir(), 'agnets-workflow-v3-control-state-'));
  const workspace = path.join(temp, 'workspace');
  const stateDir = path.join(workspace, '.codex', 'workflow-controller');
  const manifestPath = path.join(temp, 'manifest.json');
  try {
    await mkdir(workspace, { recursive: true });
    await writeFile(manifestPath, JSON.stringify(v3Manifest(workspace)));
    const [initialized] = await dispatch('init', { manifest: manifestPath, state_dir: stateDir });
    assert.equal(initialized.database_path, globalWorkflowStorePath());
    assert.equal(initialized.state_path, globalWorkflowStorePath());
    assert.deepEqual(initialized.task_key, { namespace: await realpath(stateDir), task_id: 'feature' });
    const [ready] = await dispatch('ready', { task_id: 'feature', state_dir: stateDir });
    assert.equal(ready.ready_nodes[0].id, 'work');
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('v3 initialization completes missing direct review dependencies', { skip: !existsSync(sqljsRuntime) }, async () => {
  const { dispatch } = await import('../scripts/workflow_controller.mjs');
  const temp = await mkdtemp(path.join(os.tmpdir(), 'agnets-workflow-v3-review-topology-'));
  const workspace = path.join(temp, 'workspace');
  const stateDir = path.join(workspace, '.codex', 'workflow-controller');
  const manifestPath = path.join(temp, 'manifest.json');
  const evidence = id => ({ id, kind: 'evidence', execution_risk: 'read_only', routing_reason: 'independent evidence', execution_owner: `/root/${id}`, integration_owner: '/root', quality_guard: 'record evidence' });
  const review = { id: 'review', kind: 'quality_review', depends_on: ['work-a'], execution_risk: 'read_only', routing_reason: 'independent quality gate', execution_owner: '/root/reviewer', integration_owner: '/root', quality_guard: 'review requirements' };
  try {
    await mkdir(workspace, { recursive: true });
    await writeFile(manifestPath, JSON.stringify(v3Manifest(workspace, { nodes: [evidence('work-a'), evidence('work-b'), evidence('work-c'), review] })));
    const [initialized] = await dispatch('init', { manifest: manifestPath, state_dir: stateDir });
    assert.deepEqual(initialized.task.nodes.find(node => node.id === 'review').depends_on, ['work-a', 'work-b', 'work-c']);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('v3 state authority rejects a replaced state directory before a claim can mutate it', { skip: !existsSync(sqljsRuntime) }, async () => {
  const { dispatch } = await import('../scripts/workflow_controller.mjs');
  const temp = await mkdtemp(path.join(os.tmpdir(), 'agnets-workflow-v3-authority-'));
  const workspace = path.join(temp, 'workspace');
  const stateDir = path.join(workspace, '.codex', 'workflow-controller');
  const manifestPath = path.join(temp, 'manifest.json');
  try {
    await mkdir(workspace, { recursive: true });
    await writeFile(manifestPath, JSON.stringify(v3Manifest(workspace)));
    await dispatch('init', { manifest: manifestPath, state_dir: stateDir });
    const displaced = path.join(temp, 'displaced-state');
    await rename(stateDir, displaced);
    await mkdir(stateDir);
    await assert.rejects(
      () => dispatch('claim', { task_id: 'feature', node_id: 'work', agent_task_path: '/root/work', agent_role: 'avsp_terra_high', state_dir: stateDir }),
      /Controller state parent changed/,
    );
    assert.equal(existsSync(path.join(stateDir, 'feature.sqlite')), false);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('v3 release-only state is never pruned merely by age', { skip: !existsSync(sqljsRuntime) }, async () => {
  const { dispatch } = await import('../scripts/workflow_controller.mjs');
  const { globalWorkflowStorePath } = await import('../scripts/global_workflow_store.mjs');
  const temp = await mkdtemp(path.join(os.tmpdir(), 'agnets-workflow-v3-prune-'));
  const workspace = path.join(temp, 'workspace');
  const stateDir = path.join(workspace, '.codex', 'workflow-controller');
  const manifestPath = path.join(temp, 'manifest.json');
  try {
    await mkdir(workspace, { recursive: true });
    await writeFile(manifestPath, JSON.stringify(v3Manifest(workspace)));
    await dispatch('init', { manifest: manifestPath, state_dir: stateDir });
    const [activeCloseCheck, activeCloseCode] = await dispatch('close-check', { task_id: 'feature', state_dir: stateDir });
    assert.equal(activeCloseCode, 2);
    assert.equal(activeCloseCheck.close_allowed, false);
    assert.equal(activeCloseCheck.state_path, globalWorkflowStorePath());
    assert.equal(activeCloseCheck.database_path, globalWorkflowStorePath());
    assert.deepEqual(activeCloseCheck.task_key, { namespace: await realpath(stateDir), task_id: 'feature' });
    const [released] = await dispatch('release-workspace', { task_id: 'feature', previous_agent_stopped: true, state_dir: stateDir });
    assert.equal(released.state_path, globalWorkflowStorePath());
    assert.equal(released.database_path, globalWorkflowStorePath());
    assert.deepEqual(released.task_key, { namespace: await realpath(stateDir), task_id: 'feature' });
    assert.equal('lease_path' in released, false);
    const [closeCheck] = await dispatch('close-check', { task_id: 'feature', state_dir: stateDir });
    assert.equal(closeCheck.state_path, globalWorkflowStorePath());
    assert.equal(closeCheck.database_path, globalWorkflowStorePath());
    assert.deepEqual(closeCheck.task_key, { namespace: await realpath(stateDir), task_id: 'feature' });
    assert.equal(closeCheck.workspace_lease.state_path, globalWorkflowStorePath());
    assert.equal(closeCheck.workspace_lease.database_path, globalWorkflowStorePath());
    assert.deepEqual(closeCheck.workspace_lease.task_key, { namespace: await realpath(stateDir), task_id: 'feature' });
    const [freshPrune] = await dispatch('prune-expired', { state_dir: stateDir });
    assert.equal(freshPrune.deleted_count, 0);
    const [expiredPrune] = await dispatch('prune-expired', { state_dir: stateDir });
    assert.equal(expiredPrune.deleted_count, 0);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('v3 prune deletes only fully closed released tasks and keeps corrupt or artifact-failed rows', { skip: !existsSync(sqljsRuntime) }, async () => {
  const { dispatch } = await import('../scripts/workflow_controller.mjs');
  const { globalTaskStateExists, globalWorkflowStorePath, readGlobalTaskState, taskNamespaceKey, writeGlobalTaskState } = await import('../scripts/global_workflow_store.mjs');
  const temp = await mkdtemp(path.join(os.tmpdir(), 'agnets-workflow-v3-prune-contract-'));
  const workspace = path.join(temp, 'workspace');
  const stateDir = path.join(workspace, '.codex', 'workflow-controller');
  const manifestPath = path.join(temp, 'manifest.json');
  const old = '1970-01-01T00:00:00.000Z';
  const makeReleasedState = async (taskId, status, { closedRevisionMatches = true } = {}) => {
    await writeFile(manifestPath, JSON.stringify(v3Manifest(workspace, { task_id: taskId })));
    const [initialized] = await dispatch('init', { manifest: manifestPath, state_dir: stateDir });
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
    await mkdir(path.join(stateDir, '.workflow-review-results'), { recursive: true });
    await writeFile(path.join(stateDir, '.workflow-review-results', 'artifact-failure'), 'not a directory, so artifact cleanup must fail');
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
