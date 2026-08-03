import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir, utimes } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ControllerError, dispatch, workspaceFingerprint } from '../scripts/workflow_controller.mjs';

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agnets-workflow-'));
  const workspace = path.join(root, 'workspace'); const stateDir = path.join(root, 'state');
  await mkdir(workspace); await writeFile(path.join(workspace, 'app.txt'), 'before\n');
  const manifest = path.join(root, 'manifest.json');
  await writeFile(manifest, JSON.stringify({ task_id: 'feature-1', workspace, goal: 'Change app safely', requirements: [{ id: 'R1', text: 'app changes' }], nodes: [{ id: 'implement', kind: 'implementation', agent_type: 'avsp_terra_high' }, { id: 'verify', kind: 'verification', depends_on: ['implement'] }] }));
  return { root, workspace, stateDir, manifest };
}

test('DAG, total review, and workspace fingerprint gate', async () => {
  const fixture = await setup();
  try {
    const call = (command, parameters) => dispatch(command, { state_dir: fixture.stateDir, ...parameters });
    const [initialized] = await call('init', { manifest: fixture.manifest }); assert.equal(initialized.task.ready_nodes[0].id, 'implement');
    await call('add-node', { task_id: 'feature-1', node: await writeNode(fixture.root, { id: 'total-review', kind: 'total_review', depends_on: ['implement', 'verify'] }) });
    let [claim] = await call('claim', { task_id: 'feature-1', node_id: 'implement', agent_task_path: '/root/implement', agent_role: 'avsp_terra_high' });
    const implementation = path.join(fixture.root, 'implementation.json'); await writeFile(implementation, '{}'); await call('complete', { task_id: 'feature-1', node_id: 'implement', claim_id: claim.node.claim_id, status: 'succeeded', result: implementation });
    [claim] = await call('claim', { task_id: 'feature-1', node_id: 'verify', agent_task_path: '/root/verify', agent_role: 'avsp_luna_high' });
    const verification = path.join(fixture.root, 'verification.json'); await writeFile(verification, '{}'); await call('complete', { task_id: 'feature-1', node_id: 'verify', claim_id: claim.node.claim_id, status: 'succeeded', result: verification });
    const [reviewClaim] = await call('claim', { task_id: 'feature-1', node_id: 'total-review', agent_task_path: '/root/total-review', agent_role: 'avsp_sol_high' });
    const [context] = await call('audit-context', { task_id: 'feature-1' }); const review = path.join(fixture.root, 'review.json');
    await writeFile(review, JSON.stringify({ auditor_task: '/root/total-review', auditor_role: 'avsp_sol_high', claim_id: reviewClaim.node.claim_id, verdict: 'pass', requirement_coverage: { R1: 'verified' }, workspace_fingerprint: context.workspace_fingerprint, scope_and_regression: 'none', verification_gaps: 'none', residual_risk: 'none' }));
    await call('record-review', { task_id: 'feature-1', review }); const reviewResult = path.join(fixture.root, 'total-review.json'); await writeFile(reviewResult, '{}'); await call('complete', { task_id: 'feature-1', node_id: 'total-review', claim_id: reviewClaim.node.claim_id, status: 'succeeded', result: reviewResult }); let [allowed, code] = await call('close-check', { task_id: 'feature-1' }); assert.equal(code, 0); assert.equal(allowed.close_allowed, true);
    await writeFile(path.join(fixture.workspace, 'app.txt'), 'after\n'); [allowed, code] = await call('close-check', { task_id: 'feature-1' }); assert.equal(code, 2); assert.ok(allowed.reasons.includes('workspace changed after total review'));
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

test('allows a newly claimed total-review node to record its own review', async () => {
  const fixture = await setup();
  try {
    const call = (command, parameters) => dispatch(command, { state_dir: fixture.stateDir, ...parameters });
    await call('init', { manifest: fixture.manifest });
    await call('add-node', { task_id: 'feature-1', node: await writeNode(fixture.root, { id: 'total-review', kind: 'total_review', depends_on: ['implement', 'verify'] }) });
    for (const [nodeId, taskPath, role] of [['implement', '/root/implement', 'avsp_terra_high'], ['verify', '/root/verify', 'avsp_luna_high']]) {
      const [claim] = await call('claim', { task_id: 'feature-1', node_id: nodeId, agent_task_path: taskPath, agent_role: role });
      const result = path.join(fixture.root, `${nodeId}.json`); await writeFile(result, '{}'); await call('complete', { task_id: 'feature-1', node_id: nodeId, claim_id: claim.node.claim_id, status: 'succeeded', result });
    }
    const [reviewClaim] = await call('claim', { task_id: 'feature-1', node_id: 'total-review', agent_task_path: '/root/total-review', agent_role: 'avsp_sol_high' });
    const [context] = await call('audit-context', { task_id: 'feature-1' }); const review = path.join(fixture.root, 'review.json');
    await writeFile(review, JSON.stringify({ auditor_task: '/root/total-review', auditor_role: 'avsp_sol_high', verdict: 'pass', requirement_coverage: { R1: 'verified' }, workspace_fingerprint: context.workspace_fingerprint, scope_and_regression: 'none', verification_gaps: 'none', residual_risk: 'none' }));
    await assert.rejects(() => call('record-review', { task_id: 'feature-1', review }), /claim_id/);
    await writeFile(review, JSON.stringify({ auditor_task: '/root/total-review', auditor_role: 'avsp_sol_high', claim_id: 'forged-claim', verdict: 'pass', requirement_coverage: { R1: 'verified' }, workspace_fingerprint: context.workspace_fingerprint, scope_and_regression: 'none', verification_gaps: 'none', residual_risk: 'none' }));
    await assert.rejects(() => call('record-review', { task_id: 'feature-1', review }), /Claim does not own node/);
    await writeFile(review, JSON.stringify({ auditor_task: '/root/total-review', auditor_role: 'avsp_sol_xhigh', claim_id: reviewClaim.node.claim_id, verdict: 'pass', requirement_coverage: { R1: 'verified' }, workspace_fingerprint: context.workspace_fingerprint, scope_and_regression: 'none', verification_gaps: 'none', residual_risk: 'none' }));
    await assert.rejects(() => call('record-review', { task_id: 'feature-1', review }), /role must match/);
    await writeFile(review, JSON.stringify({ auditor_task: '/root/total-review', auditor_role: 'avsp_sol_high', claim_id: reviewClaim.node.claim_id, verdict: 'pass', requirement_coverage: { R1: 'verified' }, workspace_fingerprint: context.workspace_fingerprint, scope_and_regression: 'none', verification_gaps: 'none', residual_risk: 'none' }));
    await call('record-review', { task_id: 'feature-1', review });
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('requires a recorded review before total review succeeds and reconciles legacy orphaned reviews', async () => {
  const fixture = await setup();
  try {
    const call = (command, parameters) => dispatch(command, { state_dir: fixture.stateDir, ...parameters });
    await call('init', { manifest: fixture.manifest });
    await call('add-node', { task_id: 'feature-1', node: await writeNode(fixture.root, { id: 'total-review', kind: 'total_review', depends_on: ['implement', 'verify'] }) });
    for (const [nodeId, taskPath, role] of [['implement', '/root/implement', 'avsp_terra_high'], ['verify', '/root/verify', 'avsp_luna_high']]) {
      const [claim] = await call('claim', { task_id: 'feature-1', node_id: nodeId, agent_task_path: taskPath, agent_role: role });
      const result = path.join(fixture.root, `${nodeId}.json`); await writeFile(result, '{}'); await call('complete', { task_id: 'feature-1', node_id: nodeId, claim_id: claim.node.claim_id, status: 'succeeded', result });
    }
    const [reviewClaim] = await call('claim', { task_id: 'feature-1', node_id: 'total-review', agent_task_path: '/root/total-review', agent_role: 'avsp_sol_high' });
    const result = path.join(fixture.root, 'total-review.json'); await writeFile(result, '{}');
    await assert.rejects(() => call('complete', { task_id: 'feature-1', node_id: 'total-review', claim_id: reviewClaim.node.claim_id, status: 'succeeded', result }), /requires a recorded review/);
    await assert.rejects(() => call('retry', { task_id: 'feature-1', node_id: 'implement', reason: 'ordinary success is final', previous_agent_stopped: true }), /Only failed, blocked, unavailable, abandoned, or an unrecorded successful total_review can be retried/);

    const stateFile = path.join(fixture.stateDir, 'feature-1.json'); const legacy = JSON.parse(await readFile(stateFile, 'utf8'));
    legacy.nodes['total-review'].status = 'succeeded'; legacy.nodes['total-review'].result = {};
    await writeFile(stateFile, JSON.stringify(legacy));
    await assert.rejects(() => call('retry', { task_id: 'feature-1', node_id: 'total-review', reason: 'old process is not yet confirmed stopped', previous_agent_stopped: false }), /must be true/);
    await call('retry', { task_id: 'feature-1', node_id: 'total-review', reason: 'reconcile legacy unrecorded completion', previous_agent_stopped: true });
    const recovered = JSON.parse(await readFile(stateFile, 'utf8'));
    assert.equal(recovered.nodes['total-review'].status, 'pending');
    assert.equal(recovered.events.at(-1).orphaned_total_review, true);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('claim ownership, abandon, retry, unavailable, and stale-lock recovery are explicit', async () => {
  const fixture = await setup();
  try {
    const call = (command, parameters) => dispatch(command, { state_dir: fixture.stateDir, ...parameters });
    await call('init', { manifest: fixture.manifest });
    await assert.rejects(() => call('claim', { task_id: 'feature-1', node_id: 'implement', agent_task_path: '', agent_role: 'avsp_terra_high' }), ControllerError);
    const [firstClaim] = await call('claim', { task_id: 'feature-1', node_id: 'implement', agent_task_path: '/root/first', agent_role: 'avsp_terra_high', lease_duration_sec: 60 });
    await assert.rejects(() => call('heartbeat', { task_id: 'feature-1', node_id: 'implement', claim_id: 'wrong' }), ControllerError);
    await call('heartbeat', { task_id: 'feature-1', node_id: 'implement', claim_id: firstClaim.node.claim_id });
    await call('abandon', { task_id: 'feature-1', node_id: 'implement', claim_id: firstClaim.node.claim_id, reason: 'confirmed process stopped' });
    await assert.rejects(() => call('retry', { task_id: 'feature-1', node_id: 'implement', reason: 'replace worker', previous_agent_stopped: false }), ControllerError);
    await call('retry', { task_id: 'feature-1', node_id: 'implement', reason: 'replace worker', previous_agent_stopped: true });
    const stateFile = path.join(fixture.stateDir, 'feature-1.json');
    const stateAfterRetry = JSON.parse(await readFile(stateFile, 'utf8'));
    assert.equal(stateAfterRetry.events.at(-1).previous_agent_stopped, true);
    const [secondClaim] = await call('claim', { task_id: 'feature-1', node_id: 'implement', agent_task_path: '/root/second', agent_role: 'avsp_terra_high' });
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

test('serializes stale-lock recovery and validates manifest and review fields', async () => {
  const fixture = await setup();
  try {
    const call = (command, parameters) => dispatch(command, { state_dir: fixture.stateDir, ...parameters });
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
    await writeFile(review, JSON.stringify({ auditor_task: '/root/total-review', auditor_role: 'avsp_sol_high', verdict: 'pass', requirement_coverage: { R1: 'verified' }, workspace_fingerprint: context.workspace_fingerprint, scope_and_regression: 'none', verification_gaps: '', residual_risk: 'none' }));
    await assert.rejects(() => call('record-review', { task_id: 'feature-1', review }), ControllerError);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

async function writeNode(root, node) {
  const file = path.join(root, `${node.id}.json`); await writeFile(file, JSON.stringify(node)); return file;
}
