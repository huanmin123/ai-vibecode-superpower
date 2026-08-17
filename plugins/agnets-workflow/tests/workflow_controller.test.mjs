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
    task_id: 'feature', workspace, workspace_claims: [{ mode: 'write', prefix: '.' }], global_write_justification: 'The fixture intentionally validates a workspace-wide claim.', goal: 'Validate the v3-only workflow contract.', requirements: [{ id: 'R1', text: 'Only v3 manifests are accepted.' }], scope: [], non_goals: [], routing_schema_version: 3, assurance_level: 'terra', assurance_assessment: assessment('terra'), review_context: { environment: 'local test workspace', scenarios: ['current protocol'], boundaries: 'declared workspace only' }, review_entry_stage: 'terra_single', nodes: [{ id: 'work', kind: 'implementation', ...work }, { id: 'review', kind: 'quality_review', depends_on: ['work'], ...review }], ...overrides,
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

test('v3 writes workspace coordination only to SQLite and never recreates a deleted control database during a task mutation', { skip: !existsSync(sqljsRuntime) }, async () => {
  const { ControllerError, dispatch } = await import('../scripts/workflow_controller.mjs');
  const temp = await mkdtemp(path.join(os.tmpdir(), 'agnets-workflow-v3-sqlite-control-'));
  const workspace = path.join(temp, 'workspace');
  const stateDir = path.join(workspace, 'state-a');
  const replacementStateDir = path.join(workspace, 'state-b');
  const manifestPath = path.join(temp, 'manifest.json');
  const controlPath = path.join(workspace, '.codex', 'workflow-controller', 'workflow.sqlite');
  try {
    await mkdir(workspace, { recursive: true });
    await writeFile(manifestPath, JSON.stringify(v3Manifest(workspace)));
    const [initialized] = await dispatch('init', { manifest: manifestPath, state_dir: stateDir });
    assert.equal(initialized.state_path, path.join(await realpath(stateDir), 'feature.sqlite'));
    assert.equal(existsSync(controlPath), true);
    assert.equal(existsSync(path.join(stateDir, 'workspace-lease.json')), false);
    assert.equal(existsSync(path.join(workspace, '.codex-workflow-controller-authority.json')), false);
    assert.deepEqual((await readdir(stateDir)).sort(), ['feature.sqlite']);

    await unlink(controlPath);
    await assert.rejects(
      () => dispatch('claim', { task_id: 'feature', node_id: 'work', agent_task_path: '/root/work', agent_role: 'avsp_terra_high', state_dir: stateDir }),
      error => error instanceof ControllerError && /Workspace control database does not exist/.test(error.message),
    );
    await writeFile(manifestPath, JSON.stringify(v3Manifest(workspace, { task_id: 'replacement', workspace_claims: [{ mode: 'write', prefix: 'replacement' }] })));
    const bootstrapPath = `${controlPath}.bootstrap-crash.tmp`;
    await writeFile(bootstrapPath, 'orphaned bootstrap control');
    await assert.rejects(
      () => dispatch('init', { manifest: manifestPath, state_dir: replacementStateDir }),
      error => error instanceof ControllerError && /bootstrap artifact remains/.test(error.message),
    );
    await unlink(bootstrapPath);
    await assert.rejects(
      () => dispatch('init', { manifest: manifestPath, state_dir: replacementStateDir }),
      error => error instanceof ControllerError && /current v3 task state exists/.test(error.message),
    );
    assert.equal(existsSync(controlPath), false);
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
    assert.equal(existsSync(path.join(stateDir, 'workflow.sqlite')), true);
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
    assert.equal(existsSync(path.join(stateDir, 'workflow.sqlite')), true);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('v3 initialization removes a retired JSON state before creating SQLite state', { skip: !existsSync(sqljsRuntime) }, async () => {
  const { dispatch } = await import('../scripts/workflow_controller.mjs');
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
  const stateDir = path.join(workspace, '.codex', 'workflow-controller');
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
