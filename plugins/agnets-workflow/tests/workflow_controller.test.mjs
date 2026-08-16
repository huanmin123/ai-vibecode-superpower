import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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
    task_id: 'feature', workspace, workspace_claims: [{ mode: 'write', prefix: '.' }], goal: 'Validate the v3-only workflow contract.', requirements: [{ id: 'R1', text: 'Only v3 manifests are accepted.' }], scope: [], non_goals: [], routing_schema_version: 3, assurance_level: 'terra', assurance_assessment: assessment('terra'), review_context: { environment: 'local test workspace', scenarios: ['current protocol'], boundaries: 'declared workspace only' }, review_entry_stage: 'terra_single', nodes: [{ id: 'work', kind: 'implementation', ...work }, { id: 'review', kind: 'quality_review', depends_on: ['work'], ...review }], ...overrides,
  };
}

test('controller accepts only the current v3 manifest and SQLite state path', async () => {
  const source = await readFile(controller, 'utf8');
  assert.match(source, /routing_schema_version must be 3/);
  assert.match(source, /Current SQLite controller state does not exist/);
  assert.doesNotMatch(source, new RegExp(['avsp', 'luna', 'high', 'writer'].join('_')));
  assert.doesNotMatch(source, /record-verification/);
  assert.match(source, /const initialState = normalizeState\(await loadState\(filePath\)\)/);
});

test('v3 runtime initializes current manifests and rejects retired schema states', { skip: !existsSync(sqljsRuntime) }, async () => {
  const { ControllerError, dispatch } = await import('../scripts/workflow_controller.mjs');
  const temp = await mkdtemp(path.join(os.tmpdir(), 'agnets-workflow-v3-'));
  const workspace = path.join(temp, 'workspace');
  const stateDir = path.join(temp, 'state');
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

test('v3 initialization rebuilds a missing authority for a current workspace lease', { skip: !existsSync(sqljsRuntime) }, async () => {
  const { dispatch } = await import('../scripts/workflow_controller.mjs');
  const temp = await mkdtemp(path.join(os.tmpdir(), 'agnets-workflow-v3-authority-rebuild-'));
  const workspace = path.join(temp, 'workspace');
  const stateDir = path.join(temp, 'state');
  const initialManifest = path.join(temp, 'initial.json');
  const rebuiltManifest = path.join(temp, 'rebuilt.json');
  const authorityPath = path.join(workspace, '.codex-workflow-controller-authority.json');
  try {
    await mkdir(workspace, { recursive: true });
    await writeFile(initialManifest, JSON.stringify(v3Manifest(workspace)));
    await dispatch('init', { manifest: initialManifest, state_dir: stateDir });
    await dispatch('release-workspace', { task_id: 'feature', previous_agent_stopped: true, state_dir: stateDir });
    await unlink(authorityPath);
    await writeFile(rebuiltManifest, JSON.stringify(v3Manifest(workspace, { task_id: 'rebuilt' })));
    const [rebuilt] = await dispatch('init', { manifest: rebuiltManifest, state_dir: stateDir });
    assert.equal(rebuilt.task.task_id, 'rebuilt');
    assert.equal(existsSync(authorityPath), true);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('v3 initialization archives a v2 authority before destructive rebuild', { skip: !existsSync(sqljsRuntime) }, async () => {
  const { dispatch } = await import('../scripts/workflow_controller.mjs');
  const temp = await mkdtemp(path.join(os.tmpdir(), 'agnets-workflow-v3-legacy-authority-'));
  const workspace = path.join(temp, 'workspace');
  const stateDir = path.join(temp, 'state');
  const manifestPath = path.join(temp, 'manifest.json');
  const rebuiltManifestPath = path.join(temp, 'rebuilt.json');
  const authorityPath = path.join(workspace, '.codex-workflow-controller-authority.json');
  const leasePath = path.join(workspace, '.codex', 'workflow-controller', 'workspace-lease.json');
  const publicationIntentPath = `${authorityPath}.publication.json`;
  try {
    await mkdir(workspace, { recursive: true });
    await writeFile(manifestPath, JSON.stringify(v3Manifest(workspace)));
    await dispatch('init', { manifest: manifestPath, state_dir: stateDir });
    await dispatch('release-workspace', { task_id: 'feature', previous_agent_stopped: true, state_dir: stateDir });
    const authority = JSON.parse(await readFile(authorityPath, 'utf8'));
    authority.version = 2;
    await writeFile(publicationIntentPath, JSON.stringify({ version: 1, workspace: await realpath(workspace), authority_path: authorityPath, registry_path: leasePath, prior_authority: authority, lease: JSON.parse(await readFile(leasePath, 'utf8')) }));
    await writeFile(authorityPath, JSON.stringify(authority));
    await writeFile(rebuiltManifestPath, JSON.stringify(v3Manifest(workspace, { task_id: 'rebuilt' })));
    const [rebuilt] = await dispatch('init', { manifest: rebuiltManifestPath, state_dir: stateDir });
    assert.equal(rebuilt.task.task_id, 'rebuilt');
    assert.equal(rebuilt.workspace_lease_recovery.mode, 'destructive_rebuild');
    assert.match(rebuilt.workspace_lease_recovery.legacy_authority_archive_path, /\.codex-workflow-controller-authority\.json\.legacy-v2-/);
    assert.match(rebuilt.workspace_lease_recovery.legacy_publication_intent_archive_path, /\.publication\.json\.legacy-v2-/);
    assert.equal(JSON.parse(await readFile(authorityPath, 'utf8')).version, 3);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('v3 initialization archives a v2 workspace lease before rebuilding', { skip: !existsSync(sqljsRuntime) }, async () => {
  const { dispatch } = await import('../scripts/workflow_controller.mjs');
  const temp = await mkdtemp(path.join(os.tmpdir(), 'agnets-workflow-v3-legacy-lease-'));
  const workspace = path.join(temp, 'workspace');
  const stateDir = path.join(temp, 'state');
  const manifestPath = path.join(temp, 'manifest.json');
  const controlDir = path.join(workspace, '.codex', 'workflow-controller');
  const leasePath = path.join(controlDir, 'workspace-lease.json');
  try {
    await mkdir(controlDir, { recursive: true });
    await writeFile(leasePath, JSON.stringify({ version: 2, workspace: await realpath(workspace), active_tasks: [], updated_at: new Date().toISOString() }));
    await writeFile(manifestPath, JSON.stringify(v3Manifest(workspace)));
    const [initialized] = await dispatch('init', { manifest: manifestPath, state_dir: stateDir });
    assert.equal(initialized.task.task_id, 'feature');
    assert.equal(initialized.workspace_lease_recovery.mode, 'destructive_rebuild');
    assert.match(initialized.workspace_lease_recovery.legacy_registry_archive_path, /workspace-lease\.json\.legacy-v2-/);
    assert.equal(JSON.parse(await readFile(leasePath, 'utf8')).version, 3);
    assert.equal((await readdir(controlDir)).some(name => name.startsWith('workspace-lease.json.legacy-v2-')), true);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('v3 initialization resets a same-task SQLite state when a v3 authority points to a v2 registry', { skip: !existsSync(sqljsRuntime) }, async () => {
  const { dispatch } = await import('../scripts/workflow_controller.mjs');
  const temp = await mkdtemp(path.join(os.tmpdir(), 'agnets-workflow-v3-registry-reset-'));
  const workspace = path.join(temp, 'workspace');
  const stateDir = path.join(temp, 'state');
  const manifestPath = path.join(temp, 'manifest.json');
  const leasePath = path.join(workspace, '.codex', 'workflow-controller', 'workspace-lease.json');
  try {
    await mkdir(workspace, { recursive: true });
    await writeFile(manifestPath, JSON.stringify(v3Manifest(workspace)));
    await dispatch('init', { manifest: manifestPath, state_dir: stateDir });
    await dispatch('release-workspace', { task_id: 'feature', previous_agent_stopped: true, state_dir: stateDir });
    const oldRegistry = JSON.parse(await readFile(leasePath, 'utf8'));
    oldRegistry.version = 2;
    await writeFile(leasePath, JSON.stringify(oldRegistry));
    const [rebuilt] = await dispatch('init', { manifest: manifestPath, state_dir: stateDir });
    assert.equal(rebuilt.workspace_lease_recovery.mode, 'destructive_rebuild');
    assert.equal(existsSync(rebuilt.state_path), true);
    assert.equal((await readdir(stateDir)).some(name => name.startsWith('feature.sqlite.legacy-orphaned-')), true);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('v3 initialization archives an active v2 lease with an old JSON state path and rebuilds v3 SQLite state', { skip: !existsSync(sqljsRuntime) }, async () => {
  const { dispatch } = await import('../scripts/workflow_controller.mjs');
  const temp = await mkdtemp(path.join(os.tmpdir(), 'agnets-workflow-v3-legacy-active-'));
  const workspace = path.join(temp, 'workspace');
  const stateDir = path.join(workspace, '.codex', 'workflow-controller');
  const manifestPath = path.join(temp, 'manifest.json');
  const rebuiltManifestPath = path.join(temp, 'rebuilt.json');
  const authorityPath = path.join(workspace, '.codex-workflow-controller-authority.json');
  const leasePath = path.join(stateDir, 'workspace-lease.json');
  try {
    await mkdir(workspace, { recursive: true });
    await writeFile(manifestPath, JSON.stringify(v3Manifest(workspace)));
    await dispatch('init', { manifest: manifestPath, state_dir: stateDir });
    const currentLease = JSON.parse(await readFile(leasePath, 'utf8'));
    const active = currentLease.active_tasks[0];
    await unlink(authorityPath);
    await unlink(leasePath);
    await writeFile(leasePath, JSON.stringify({ version: 2, workspace: await realpath(workspace), active_tasks: [{ ...active, state_path: path.join(stateDir, 'feature.json') }], updated_at: new Date().toISOString() }));
    await writeFile(rebuiltManifestPath, JSON.stringify(v3Manifest(workspace, { task_id: 'rebuilt' })));
    const [rebuilt] = await dispatch('init', { manifest: rebuiltManifestPath, state_dir: stateDir });
    assert.equal(rebuilt.workspace_lease_recovery.mode, 'destructive_rebuild');
    assert.equal(JSON.parse(await readFile(leasePath, 'utf8')).active_tasks.map(entry => entry.task_id)[0], 'rebuilt');
    assert.equal((await readdir(stateDir)).some(name => name.startsWith('feature.sqlite.legacy-orphaned-')), true);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('v3 initialization archives orphaned state files when rebuilding an unregistered control directory', { skip: !existsSync(sqljsRuntime) }, async () => {
  const { dispatch } = await import('../scripts/workflow_controller.mjs');
  const temp = await mkdtemp(path.join(os.tmpdir(), 'agnets-workflow-v3-orphaned-control-'));
  const workspace = path.join(temp, 'workspace');
  const stateDir = path.join(workspace, '.codex', 'workflow-controller');
  const manifestPath = path.join(temp, 'manifest.json');
  try {
    await mkdir(stateDir, { recursive: true });
    await writeFile(path.join(stateDir, 'orphan.sqlite'), 'legacy state');
    await writeFile(manifestPath, JSON.stringify(v3Manifest(workspace)));
    const [initialized] = await dispatch('init', { manifest: manifestPath, state_dir: stateDir });
    assert.equal(initialized.workspace_lease_recovery.mode, 'destructive_rebuild');
    assert.equal(existsSync(path.join(stateDir, 'orphan.sqlite')), false);
    assert.equal((await readdir(stateDir)).some(name => name.startsWith('orphan.sqlite.legacy-orphaned-')), true);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('v3 initialization archives a legacy JSON state before creating SQLite state', { skip: !existsSync(sqljsRuntime) }, async () => {
  const { dispatch } = await import('../scripts/workflow_controller.mjs');
  const temp = await mkdtemp(path.join(os.tmpdir(), 'agnets-workflow-v3-legacy-json-'));
  const workspace = path.join(temp, 'workspace');
  const stateDir = path.join(temp, 'state');
  const manifestPath = path.join(temp, 'manifest.json');
  const legacyStatePath = path.join(stateDir, 'feature.json');
  try {
    await mkdir(workspace, { recursive: true });
    await mkdir(stateDir, { recursive: true });
    await writeFile(legacyStatePath, JSON.stringify({ version: 1, task_id: 'feature', workspace }));
    await writeFile(manifestPath, JSON.stringify(v3Manifest(workspace)));
    const [initialized] = await dispatch('init', { manifest: manifestPath, state_dir: stateDir });
    assert.equal(existsSync(legacyStatePath), false);
    assert.equal(initialized.workspace_lease_recovery.legacy_state_archive_paths.length, 1);
    assert.equal(existsSync(initialized.state_path), true);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('v3 initialization supports the documented workspace control state_dir', { skip: !existsSync(sqljsRuntime) }, async () => {
  const { dispatch } = await import('../scripts/workflow_controller.mjs');
  const temp = await mkdtemp(path.join(os.tmpdir(), 'agnets-workflow-v3-control-state-'));
  const workspace = path.join(temp, 'workspace');
  const stateDir = path.join(workspace, '.codex', 'workflow-controller');
  const manifestPath = path.join(temp, 'manifest.json');
  try {
    await mkdir(workspace, { recursive: true });
    await writeFile(manifestPath, JSON.stringify(v3Manifest(workspace)));
    const [initialized] = await dispatch('init', { manifest: manifestPath, state_dir: stateDir });
    assert.equal(initialized.state_path, path.join(await realpath(stateDir), 'feature.sqlite'));
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
  const stateDir = path.join(temp, 'state');
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
  const stateDir = path.join(temp, 'state');
  const manifestPath = path.join(temp, 'manifest.json');
  const database = path.join(stateDir, 'feature.sqlite');
  try {
    await mkdir(workspace, { recursive: true });
    await writeFile(manifestPath, JSON.stringify(v3Manifest(workspace)));
    await dispatch('init', { manifest: manifestPath, state_dir: stateDir });
    const displaced = path.join(temp, 'displaced-state');
    await rename(stateDir, displaced);
    await mkdir(stateDir);
    await copyFile(path.join(displaced, 'feature.sqlite'), database);
    const peerBefore = await readFile(database);
    await assert.rejects(
      () => dispatch('claim', { task_id: 'feature', node_id: 'work', agent_task_path: '/root/work', agent_role: 'avsp_terra_high', state_dir: stateDir }),
      /Controller state parent changed/,
    );
    assert.deepEqual(await readFile(database), peerBefore);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('v3 released SQLite state is retained until expiry and then pruned', { skip: !existsSync(sqljsRuntime) }, async () => {
  const { dispatch } = await import('../scripts/workflow_controller.mjs');
  const { readTaskState, writeTaskState } = await import('../scripts/sqlite_task_store.mjs');
  const temp = await mkdtemp(path.join(os.tmpdir(), 'agnets-workflow-v3-prune-'));
  const workspace = path.join(temp, 'workspace');
  const stateDir = path.join(temp, 'state');
  const manifestPath = path.join(temp, 'manifest.json');
  const database = path.join(stateDir, 'feature.sqlite');
  try {
    await mkdir(workspace, { recursive: true });
    await writeFile(manifestPath, JSON.stringify(v3Manifest(workspace)));
    await dispatch('init', { manifest: manifestPath, state_dir: stateDir });
    await dispatch('release-workspace', { task_id: 'feature', previous_agent_stopped: true, state_dir: stateDir });
    const [freshPrune] = await dispatch('prune-expired', { state_dir: stateDir });
    assert.equal(freshPrune.deleted_count, 0);
    assert.equal(existsSync(database), true);

    const state = await readTaskState(database);
    state.updated_at = '1970-01-01T00:00:00.000Z';
    const parentPath = path.dirname(database);
    const parentMetadata = await lstat(parentPath, { bigint: true });
    await writeTaskState(database, state, {
      parentAuthority: {
        path: parentPath,
        real_path: await realpath(parentPath),
        identity: {
          dev: parentMetadata.dev.toString(),
          ino: parentMetadata.ino.toString(),
        },
      },
    });
    const [expiredPrune] = await dispatch('prune-expired', { state_dir: stateDir });
    assert.equal(expiredPrune.deleted_count, 1);
    assert.equal(existsSync(database), false);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
