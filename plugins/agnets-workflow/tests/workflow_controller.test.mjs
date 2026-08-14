import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
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
