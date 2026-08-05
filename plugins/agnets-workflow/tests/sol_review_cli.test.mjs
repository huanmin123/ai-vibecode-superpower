import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { promises as fsPromises } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { repairInvalidDenyReadAclState, resolveCodexHome, runSolReview } from '../scripts/sol_review_cli.mjs';
import { dispatch } from '../scripts/workflow_controller.mjs';
import { readTaskState } from '../scripts/sqlite_task_store.mjs';

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agnets-sol-cli-'));
  const codexHome = path.join(root, 'codex-home');
  const sandbox = path.join(codexHome, '.sandbox');
  const evidence = path.join(root, 'evidence');
  await mkdir(sandbox, { recursive: true });
  await mkdir(evidence);
  await writeFile(path.join(evidence, 'evidence-manifest.json'), JSON.stringify({ version: 1, allowed_files: [] }));
  return { root, codexHome, sandbox, evidence, state: path.join(sandbox, 'deny_read_acl_state.json') };
}

test('repairs only an invalid Windows deny-read ACL state and keeps a backup', async () => {
  const item = await fixture();
  try {
    const corruptState = Buffer.alloc(22);
    await writeFile(item.state, corruptState);
    const repaired = await repairInvalidDenyReadAclState(item.codexHome, 'win32');
    assert.equal(repaired.repaired, true);
    assert.deepEqual(JSON.parse(await readFile(item.state, 'utf8')), { principals: {} });
    assert.ok((await readdir(item.sandbox)).some(name => name.startsWith('deny_read_acl_state.json.corrupt-')));
    assert.deepEqual(await readFile(repaired.backup_path), corruptState);

    await writeFile(item.state, '{"principals":{"kept":true}}\n');
    const preserved = await repairInvalidDenyReadAclState(item.codexHome, 'win32');
    assert.equal(preserved.repaired, false);
    assert.equal(preserved.reason, 'valid');
    assert.equal(await readFile(item.state, 'utf8'), '{"principals":{"kept":true}}\n');
  } finally { await rm(item.root, { recursive: true, force: true }); }
});

test('serializes concurrent repair attempts without replacing a valid result', async () => {
  const item = await fixture();
  try {
    await writeFile(item.state, Buffer.alloc(22));
    const results = await Promise.all(Array.from({ length: 8 }, () => repairInvalidDenyReadAclState(item.codexHome, 'win32')));
    assert.equal(results.filter(result => result.repaired).length, 1);
    assert.equal(results.filter(result => !result.repaired).length, 7);
    assert.deepEqual(JSON.parse(await readFile(item.state, 'utf8')), { principals: {} });
  } finally { await rm(item.root, { recursive: true, force: true }); }
});

test('waits for an active repair to publish a valid state before returning', async () => {
  const item = await fixture();
  const lock = `${item.state}.repair`;
  try {
    await writeFile(item.state, Buffer.alloc(22));
    await writeFile(lock, 'active repair\n', { flag: 'wx' });
    const completion = new Promise((resolve, reject) => {
      setTimeout(() => {
        (async () => {
          await writeFile(item.state, '{"principals":{}}\n');
          await rm(lock, { force: true });
        })().then(resolve, reject);
      }, 1_200);
    });
    const [result] = await Promise.all([repairInvalidDenyReadAclState(item.codexHome, 'win32'), completion]);
    assert.equal(result.repaired, false);
    assert.deepEqual(JSON.parse(await readFile(item.state, 'utf8')), { principals: {} });
  } finally { await rm(item.root, { recursive: true, force: true }); }
});

test('uses the resolved current-account CODEX_HOME and preserves the Codex exit result', async () => {
  const item = await fixture();
  try {
    let invocation;
    const spawnProcess = (command, args, options) => {
      invocation = { command, args, options };
      const child = new EventEmitter();
      queueMicrotask(() => child.emit('exit', 2, null));
      return child;
    };
    const result = await runSolReview(['--codex-bin', 'fake-codex', '--', 'review', 'prompt'], { CODEX_HOME: item.codexHome, USERPROFILE: 'C:\\Users\\CodexSandboxOffline' }, 'win32', spawnProcess);
    assert.equal(result.exit_code, 2);
    assert.equal(invocation.command, 'fake-codex');
    assert.deepEqual(invocation.args.slice(0, 9), ['exec', '--ephemeral', '--model', 'gpt-5.6-sol', '--config', 'model_reasoning_effort="high"', '--sandbox', 'read-only', '--']);
    assert.match(invocation.args.at(-1), /independent leaf Sol reviewer/);
    assert.match(invocation.args.at(-1), /Final response contract/);
    assert.match(invocation.args.at(-1), /claim_id to a non-empty value/);
    assert.match(invocation.args.at(-1), /review prompt$/);
    assert.equal(invocation.options.env.CODEX_HOME, item.codexHome);
    assert.equal(invocation.options.shell, false);
    assert.equal(resolveCodexHome({ USERPROFILE: 'C:\\Users\\Administrator' }, 'win32'), path.join('C:\\Users\\Administrator', '.codex'));
  } finally { await rm(item.root, { recursive: true, force: true }); }
});

test('selects the requested Sol reasoning effort and rejects unsupported review roles', async () => {
  const item = await fixture();
  try {
    let invocation;
    const spawnProcess = (command, args, options) => {
      invocation = { command, args, options };
      const child = new EventEmitter();
      queueMicrotask(() => child.emit('exit', 2, null));
      return child;
    };
    await runSolReview(['--review-role', 'avsp_sol_max', '--codex-bin', 'fake-codex', '--', 'review prompt'], { CODEX_HOME: item.codexHome }, 'linux', spawnProcess);
    assert.deepEqual(invocation.args.slice(0, 8), ['exec', '--ephemeral', '--model', 'gpt-5.6-sol', '--config', 'model_reasoning_effort="max"', '--sandbox', 'read-only']);
    assert.match(invocation.args.at(-1), /auditor_role to exactly "avsp_sol_max"/);
    await assert.rejects(
      runSolReview(['--review-role', 'avsp_sol_unknown', '--', 'review prompt'], { CODEX_HOME: item.codexHome }, 'linux', spawnProcess),
      /must be avsp_sol_high, avsp_sol_xhigh, or avsp_sol_max/
    );
  } finally { await rm(item.root, { recursive: true, force: true }); }
});

test('sends bounded-external profile instructions to a native Codex invocation', async () => {
  const item = await fixture();
  try {
    let invocation;
    const spawnProcess = (command, args, options) => {
      invocation = { command, args, options };
      const child = new EventEmitter();
      queueMicrotask(() => child.emit('exit', 0, null));
      return child;
    };
    const result = await runSolReview([
      '--review-profile', 'bounded-external', '--evidence-dir', item.evidence, '--codex-bin', 'fake-codex', '--', 'review prompt',
    ], { CODEX_HOME: item.codexHome }, 'linux', spawnProcess);
    assert.equal(result.exit_code, 1);
    assert.equal(invocation.command, 'fake-codex');
    assert.deepEqual(invocation.args.slice(0, 11), ['exec', '--ephemeral', '--model', 'gpt-5.6-sol', '--config', 'model_reasoning_effort="high"', '--sandbox', 'read-only', '-C', invocation.options.cwd, '--skip-git-repo-check']);
    assert.notEqual(invocation.options.cwd, item.evidence);
    assert.equal(result.evidence_directory, item.evidence);
    assert.equal(result.review_workspace, invocation.options.cwd);
    const prompt = invocation.args.at(-1);
    assert.match(prompt, /Review profile: bounded-external/);
    assert.match(prompt, /fixed evidence package/);
    assert.match(prompt, /evidence-manifest\.json/);
    assert.match(prompt, /listed changed files and necessary adjacent call chains/);
    assert.match(prompt, /Do not enumerate the entire workspace/);
    assert.match(prompt, /\.git, \.codex, node_modules, \.venv, \.yarn, or \.yarn-cache\*/);
    assert.match(prompt, /verdict "unavailable" or "fail"/);
    assert.match(prompt, /Final response contract/);
    assert.match(prompt, /independent leaf Sol reviewer/);
    assert.match(prompt, /claim_id to a non-empty value/);
    assert.match(prompt, /review prompt$/);
  } finally { await rm(item.root, { recursive: true, force: true }); }
});

test('rejects an unknown or unconfined review profile before spawning Codex', async () => {
  const item = await fixture();
  try {
    await assert.rejects(
      runSolReview(['--review-profile', 'unbounded', '--', 'review prompt'], { CODEX_HOME: item.codexHome }, 'linux', () => {
        throw new Error('spawn must not be called');
      }),
      /Unknown review profile: unbounded/,
    );
    await assert.rejects(runSolReview(['--review-profile', 'bounded-external', '--', 'review prompt'], { CODEX_HOME: item.codexHome }, 'linux', () => {
      throw new Error('spawn must not be called');
    }), /requires --evidence-dir/);
    await assert.rejects(runSolReview(['--review-profile', 'bounded-external', '--evidence-dir', 'relative', '--', 'review prompt'], { CODEX_HOME: item.codexHome }, 'linux', () => {
      throw new Error('spawn must not be called');
    }), /must be an absolute path/);
    await assert.rejects(runSolReview(['--review-profile', 'bounded-external', '--evidence-dir', path.join(item.root, 'missing'), '--', 'review prompt'], { CODEX_HOME: item.codexHome }, 'linux', () => {
      throw new Error('spawn must not be called');
    }), /must name an existing directory/);
    const notDirectory = path.join(item.root, 'not-a-directory');
    await writeFile(notDirectory, 'file');
    await assert.rejects(runSolReview(['--review-profile', 'bounded-external', '--evidence-dir', notDirectory, '--', 'review prompt'], { CODEX_HOME: item.codexHome }, 'linux', () => {
      throw new Error('spawn must not be called');
    }), /must name an existing directory/);
    const missingManifest = path.join(item.root, 'missing-manifest');
    await mkdir(missingManifest);
    await assert.rejects(runSolReview(['--review-profile', 'bounded-external', '--evidence-dir', missingManifest, '--', 'review prompt'], { CODEX_HOME: item.codexHome }, 'linux', () => {
      throw new Error('spawn must not be called');
    }), /must contain evidence-manifest\.json/);
    await writeFile(path.join(item.evidence, 'unlisted.txt'), 'not allowed');
    await assert.rejects(runSolReview(['--review-profile', 'bounded-external', '--evidence-dir', item.evidence, '--', 'review prompt'], { CODEX_HOME: item.codexHome }, 'linux', () => {
      throw new Error('spawn must not be called');
    }), /contains file not listed in evidence-manifest\.json/);
  } finally { await rm(item.root, { recursive: true, force: true }); }
});

test('rejects linked evidence manifests and linked evidence files when the platform permits links', async t => {
  const item = await fixture();
  try {
    const outsideManifest = path.join(item.root, 'outside-manifest.json');
    await writeFile(outsideManifest, JSON.stringify({ version: 1, allowed_files: [] }));
    await rm(path.join(item.evidence, 'evidence-manifest.json'));
    try { await symlink(outsideManifest, path.join(item.evidence, 'evidence-manifest.json'), 'file'); }
    catch (error) {
      if (error?.code === 'EPERM' || error?.code === 'EACCES') { t.skip(`symbolic links are unavailable: ${error.code}`); return; }
      throw error;
    }
    await assert.rejects(runSolReview(['--review-profile', 'bounded-external', '--evidence-dir', item.evidence, '--', 'review prompt'], { CODEX_HOME: item.codexHome }, 'linux', () => {
      throw new Error('spawn must not be called');
    }), /evidence-manifest\.json must be a regular file/);
    await rm(path.join(item.evidence, 'evidence-manifest.json'));
    const outsideFile = path.join(item.root, 'outside.txt');
    await writeFile(outsideFile, 'outside');
    await writeFile(path.join(item.evidence, 'evidence-manifest.json'), JSON.stringify({ version: 1, allowed_files: ['linked.txt'] }));
    await symlink(outsideFile, path.join(item.evidence, 'linked.txt'), 'file');
    await assert.rejects(runSolReview(['--review-profile', 'bounded-external', '--evidence-dir', item.evidence, '--', 'review prompt'], { CODEX_HOME: item.codexHome }, 'linux', () => {
      throw new Error('spawn must not be called');
    }), /evidence file must be a regular file/);
  } finally { await rm(item.root, { recursive: true, force: true }); }
});

test('rejects a root junction passed as the evidence directory on Windows', async t => {
  if (process.platform !== 'win32') { t.skip('junction evidence requires Windows'); return; }
  const item = await fixture();
  try {
    const junction = path.join(item.root, 'evidence-junction');
    try { await symlink(item.evidence, junction, 'junction'); }
    catch (error) {
      if (['EPERM', 'EACCES', 'UNKNOWN'].includes(error?.code)) { t.skip(`junctions are unavailable: ${error.code}`); return; }
      throw error;
    }
    await assert.rejects(runSolReview(['--review-profile', 'bounded-external', '--evidence-dir', junction, '--', 'review prompt'], { CODEX_HOME: item.codexHome }, 'win32', () => {
      throw new Error('spawn must not be called');
    }), /--evidence-dir must not be a symlink or junction/);
  } finally { await rm(item.root, { recursive: true, force: true }); }
});

test('rejects a nested junction in an evidence package on Windows', async t => {
  if (process.platform !== 'win32') { t.skip('junction evidence requires Windows'); return; }
  const item = await fixture();
  try {
    const outside = path.join(item.root, 'outside');
    await mkdir(outside);
    const junction = path.join(item.evidence, 'linked-directory');
    try { await symlink(outside, junction, 'junction'); }
    catch (error) {
      if (['EPERM', 'EACCES', 'UNKNOWN'].includes(error?.code)) { t.skip(`junctions are unavailable: ${error.code}`); return; }
      throw error;
    }
    await assert.rejects(runSolReview(['--review-profile', 'bounded-external', '--evidence-dir', item.evidence, '--', 'review prompt'], { CODEX_HOME: item.codexHome }, 'win32', () => {
      throw new Error('spawn must not be called');
    }), /evidence package cannot contain symlinks/);
  } finally { await rm(item.root, { recursive: true, force: true }); }
});

test('rejects a nested directory replacement during evidence snapshot', async () => {
  const item = await fixture();
  const nested = path.join(item.evidence, 'nested');
  const nestedFile = path.join(nested, 'source.txt');
  const originalCopyFile = fsPromises.copyFile;
  let copyCount = 0;
  try {
    await mkdir(nested);
    await writeFile(nestedFile, 'original');
    await writeFile(path.join(item.evidence, 'evidence-manifest.json'), JSON.stringify({ version: 1, allowed_files: ['nested/source.txt'] }));
    fsPromises.copyFile = async (...args) => {
      copyCount += 1;
      if (copyCount === 1) {
        await rm(nested, { recursive: true });
        await mkdir(nested);
        await writeFile(nestedFile, 'replacement');
      }
      return originalCopyFile(...args);
    };
    await assert.rejects(runSolReview(['--review-profile', 'bounded-external', '--evidence-dir', item.evidence, '--', 'review prompt'], { CODEX_HOME: item.codexHome }, 'linux', () => {
      throw new Error('spawn must not be called');
    }), error => error.message.startsWith('evidence package changed during snapshot: nested') && error.message.endsWith('source.txt'));
  } finally {
    fsPromises.copyFile = originalCopyFile;
    await rm(item.root, { recursive: true, force: true });
  }
});

test('rejects an allowed file replacement during evidence snapshot', async () => {
  const item = await fixture();
  const evidenceFile = path.join(item.evidence, 'source.txt');
  const originalCopyFile = fsPromises.copyFile;
  let copyCount = 0;
  try {
    await writeFile(evidenceFile, 'original');
    await writeFile(path.join(item.evidence, 'evidence-manifest.json'), JSON.stringify({ version: 1, allowed_files: ['source.txt'] }));
    fsPromises.copyFile = async (...args) => {
      copyCount += 1;
      if (copyCount === 2) {
        await rm(evidenceFile);
        await writeFile(evidenceFile, 'replacement');
      }
      return originalCopyFile(...args);
    };
    await assert.rejects(runSolReview(['--review-profile', 'bounded-external', '--evidence-dir', item.evidence, '--', 'review prompt'], { CODEX_HOME: item.codexHome }, 'linux', () => {
      throw new Error('spawn must not be called');
    }), /evidence package changed during snapshot: source\.txt/);
  } finally {
    fsPromises.copyFile = originalCopyFile;
    await rm(item.root, { recursive: true, force: true });
  }
});

test('rejects a nested manifest even when it is listed by the package root manifest', async () => {
  const item = await fixture();
  try {
    const nested = path.join(item.evidence, 'nested');
    await mkdir(nested);
    await writeFile(path.join(nested, 'evidence-manifest.json'), JSON.stringify({ version: 1, allowed_files: [] }));
    await writeFile(path.join(item.evidence, 'evidence-manifest.json'), JSON.stringify({ version: 1, allowed_files: ['nested/evidence-manifest.json'] }));
    await assert.rejects(runSolReview(['--review-profile', 'bounded-external', '--evidence-dir', item.evidence, '--', 'review prompt'], { CODEX_HOME: item.codexHome }, 'win32', () => {
      throw new Error('spawn must not be called');
    }), /cannot contain a nested evidence-manifest\.json/);
  } finally { await rm(item.root, { recursive: true, force: true }); }
});

test('counts the root manifest toward the bounded evidence file limit', async () => {
  const item = await fixture();
  try {
    const allowed = Array.from({ length: 512 }, (_, index) => `file-${index}.txt`);
    await writeFile(path.join(item.evidence, 'evidence-manifest.json'), JSON.stringify({ version: 1, allowed_files: allowed }));
    await Promise.all(allowed.slice(0, -1).map(entry => writeFile(path.join(item.evidence, entry), 'x')));
    await assert.rejects(runSolReview(['--review-profile', 'bounded-external', '--evidence-dir', item.evidence, '--', 'review prompt'], { CODEX_HOME: item.codexHome }, 'linux', () => {
      throw new Error('spawn must not be called');
    }), /512-file limit including evidence-manifest\.json/);
  } finally { await rm(item.root, { recursive: true, force: true }); }
});

test('rejects an evidence package with more than the bounded number of directories', async () => {
  const item = await fixture();
  try {
    await Promise.all(Array.from({ length: 513 }, (_, index) => mkdir(path.join(item.evidence, `directory-${index}`))));
    await assert.rejects(runSolReview(['--review-profile', 'bounded-external', '--evidence-dir', item.evidence, '--', 'review prompt'], { CODEX_HOME: item.codexHome }, 'linux', () => {
      throw new Error('spawn must not be called');
    }), /512-directory limit excluding the evidence root/);
  } finally { await rm(item.root, { recursive: true, force: true }); }
});

test('closes a workflow-bound evidence validation failure as unavailable before spawning Sol', async () => {
  const item = await fixture();
  const workspace = path.join(item.root, 'workspace'); const stateDir = path.join(item.root, 'state'); const manifest = path.join(item.root, 'manifest.json'); const missingEvidence = path.join(item.root, 'missing-evidence');
  try {
    await mkdir(workspace);
    await writeFile(path.join(workspace, 'source.txt'), 'review target\n');
    await writeFile(manifest, JSON.stringify({ task_id: 'review-task', workspace, goal: 'Persist evidence preflight failure', requirements: [{ id: 'R1', text: 'preflight failure is visible' }], nodes: [{ id: 'total-review', kind: 'total_review', agent_type: 'avsp_sol_high', depends_on: [] }] }));
    await dispatch('init', { state_dir: stateDir, manifest });
    const [claim] = await dispatch('claim', { state_dir: stateDir, task_id: 'review-task', node_id: 'total-review', agent_task_path: '/root/evidence-preflight', agent_role: 'avsp_sol_high' });
    await dispatch('heartbeat', { state_dir: stateDir, task_id: 'review-task', node_id: 'total-review', claim_id: claim.node.claim_id });
    const result = await runSolReview([
      '--review-profile', 'bounded-external', '--evidence-dir', missingEvidence,
      '--workflow-state-dir', stateDir, '--workflow-task-id', 'review-task', '--workflow-node-id', 'total-review', '--workflow-claim-id', claim.node.claim_id,
      '--codex-bin', 'fake-codex', '--', 'review this frozen evidence package',
    ], { CODEX_HOME: item.codexHome }, 'win32', () => { throw new Error('spawn must not be called'); });
    assert.equal(result.exit_code, 1);
    assert.match(result.review_verdict.reason, /evidence validation failed/);
    assert.equal(result.workflow_completion.completed, true);
    const persisted = JSON.parse(await readFile(result.result_path, 'utf8'));
    assert.equal(persisted.workflow_completion.completed, true);
    const state = await readTaskState(path.join(stateDir, 'review-task.sqlite'));
    assert.equal(state.nodes['total-review'].status, 'unavailable');
    assert.deepEqual(persisted.workflow_completion, state.nodes['total-review'].result.workflow_completion);
    assert.equal(persisted.workflow_completion.completion, undefined);
    assert.equal(persisted.workflow_completion.task_id, 'review-task');
    assert.equal(persisted.workflow_completion.node_id, 'total-review');
    assert.equal(persisted.workflow_completion.claim_id, claim.node.claim_id);
    assert.equal(persisted.workflow_completion.status, 'unavailable');
    assert.equal(persisted.workflow_completion.completion_attestation, 'native_agent_start_failed');
    assert.ok(state.events.some(event => event.type === 'node_completed' && event.completion_attestation === 'native_agent_start_failed'));
  } finally { await rm(item.root, { recursive: true, force: true }); }
});

test('retains the pending artifact when automatic unavailable completion cannot finalize it', async () => {
  const item = await fixture();
  const workspace = path.join(item.root, 'workspace'); const stateDir = path.join(item.root, 'state'); const manifest = path.join(item.root, 'manifest.json'); const missingEvidence = path.join(item.root, 'missing-evidence');
  const originalRename = fsPromises.rename;
  try {
    await mkdir(workspace);
    await writeFile(path.join(workspace, 'source.txt'), 'review target\n');
    await writeFile(manifest, JSON.stringify({ task_id: 'review-task', workspace, goal: 'Keep unavailable review retryable', requirements: [{ id: 'R1', text: 'artifact failure remains visible' }], nodes: [{ id: 'total-review', kind: 'total_review', agent_type: 'avsp_sol_high', depends_on: [] }] }));
    await dispatch('init', { state_dir: stateDir, manifest });
    const [claim] = await dispatch('claim', { state_dir: stateDir, task_id: 'review-task', node_id: 'total-review', agent_task_path: '/root/retryable-unavailable', agent_role: 'avsp_sol_high' });
    await dispatch('heartbeat', { state_dir: stateDir, task_id: 'review-task', node_id: 'total-review', claim_id: claim.node.claim_id });
    const outcome = path.join(stateDir, '.workflow-review-results', 'review-task', claim.node.claim_id, 'outcome.json');
    let outcomeRenames = 0;
    fsPromises.rename = async (source, destination) => {
      if (path.resolve(destination) === path.resolve(outcome) && ++outcomeRenames === 2) {
        const error = new Error('injected unavailable finalization failure'); error.code = 'EIO'; throw error;
      }
      return originalRename(source, destination);
    };
    const result = await runSolReview([
      '--review-profile', 'bounded-external', '--evidence-dir', missingEvidence,
      '--workflow-state-dir', stateDir, '--workflow-task-id', 'review-task', '--workflow-node-id', 'total-review', '--workflow-claim-id', claim.node.claim_id,
      '--codex-bin', 'fake-codex', '--', 'review this frozen evidence package',
    ], { CODEX_HOME: item.codexHome }, 'win32', () => { throw new Error('spawn must not be called'); });
    assert.deepEqual(result.workflow_completion, { state: 'pending' });
    assert.match(result.workflow_completion_error, /injected unavailable finalization failure/);
    assert.deepEqual(JSON.parse(await readFile(result.result_path, 'utf8')).workflow_completion, { state: 'pending' });
    assert.equal((await readTaskState(path.join(stateDir, 'review-task.sqlite'))).nodes['total-review'].status, 'running');
    fsPromises.rename = originalRename;
    const [completion] = await dispatch('complete', {
      state_dir: stateDir, task_id: 'review-task', node_id: 'total-review', claim_id: claim.node.claim_id, status: 'unavailable', result: result.result_path, completion_attestation: 'native_agent_start_failed',
    });
    assert.equal(completion.workflow_outcome_completion.completed, true);
    assert.equal((await readTaskState(path.join(stateDir, 'review-task.sqlite'))).nodes['total-review'].status, 'unavailable');
  } finally {
    fsPromises.rename = originalRename;
    await rm(item.root, { recursive: true, force: true });
  }
});

test('uses codex.cmd by default on Windows to avoid an inaccessible Desktop codex.exe', async () => {
  const item = await fixture();
  try {
    let invocation;
    const spawnProcess = (command, args, options) => {
      invocation = { command, args, options };
      const child = new EventEmitter();
      queueMicrotask(() => child.emit('exit', 0, null));
      return child;
    };
    await runSolReview(['review prompt'], { CODEX_HOME: item.codexHome }, 'win32', spawnProcess);
    assert.equal(invocation.command, 'powershell.exe');
    assert.equal(invocation.options.shell, false);
    assert.equal(invocation.options.env.CODEX_REVIEW_BIN, 'codex.cmd');
    assert.match(invocation.args.at(-1), /'--ephemeral'/);
    assert.equal(invocation.options.env.CODEX_REVIEW_PROMPT, undefined);
    assert.doesNotMatch(invocation.args.at(-1), /CODEX_REVIEW_PROMPT|\$arguments \+= '--'/);
    assert.doesNotMatch(invocation.args.at(-1), /review prompt/);
  } finally { await rm(item.root, { recursive: true, force: true }); }
});

test('normalizes CRLF caller prompts before the Windows codex.cmd bridge', async () => {
  const item = await fixture();
  try {
    let invocation;
    const spawnProcess = (command, args, options) => {
      invocation = { command, args, options };
      const child = new EventEmitter();
      queueMicrotask(() => child.emit('exit', 0, null));
      return child;
    };
    await runSolReview(['first line\r\nsecond line'], { CODEX_HOME: item.codexHome }, 'win32', spawnProcess);
    assert.equal(invocation.command, 'powershell.exe');
    assert.equal(invocation.options.env.CODEX_REVIEW_PROMPT, undefined);
  } finally { await rm(item.root, { recursive: true, force: true }); }
});

test('sends bounded-external profile instructions through the Windows codex.cmd bridge', async () => {
  const item = await fixture();
  try {
    let invocation;
    const spawnProcess = (command, args, options) => {
      invocation = { command, args, options };
      const child = new EventEmitter();
      queueMicrotask(() => child.emit('exit', 0, null));
      return child;
    };
    const result = await runSolReview(['--review-profile', 'bounded-external', '--evidence-dir', item.evidence, 'review prompt'], { CODEX_HOME: item.codexHome }, 'win32', spawnProcess);
    assert.equal(invocation.command, 'powershell.exe');
    assert.equal(invocation.options.shell, false);
    assert.equal(invocation.options.env.CODEX_REVIEW_BIN, 'codex.cmd');
    assert.equal(invocation.options.env.CODEX_REVIEW_WORKSPACE, invocation.options.cwd);
    assert.notEqual(invocation.options.cwd, item.evidence);
    assert.equal(result.evidence_directory, item.evidence);
    assert.equal(invocation.options.env.CODEX_REVIEW_PROMPT, undefined);
    assert.doesNotMatch(invocation.args.at(-1), /Review profile|fixed evidence package|review prompt/);
    assert.match(invocation.args.at(-1), /CODEX_REVIEW_WORKSPACE/);
    assert.match(invocation.args.at(-1), /--skip-git-check|--skip-git-repo-check/);
  } finally { await rm(item.root, { recursive: true, force: true }); }
});

test('keeps a malicious Windows prompt out of the PowerShell command source', async () => {
  const item = await fixture();
  try {
    let invocation;
    const prompt = 'safe%PATH%" & echo SHELL_INJECTION_OBSERVED & "tail';
    const spawnProcess = (command, args, options) => {
      invocation = { command, args, options };
      const child = new EventEmitter(); child.stdin = new EventEmitter(); child.stdin.value = null; child.stdin.end = function end(value) { this.value = value; }; invocation.stdin = child.stdin;
      queueMicrotask(() => child.emit('exit', 0, null));
      return child;
    };
    await runSolReview([prompt], { CODEX_HOME: item.codexHome }, 'win32', spawnProcess);
    assert.equal(invocation.command, 'powershell.exe');
    assert.equal(invocation.options.shell, false);
    assert.equal(invocation.options.env.CODEX_REVIEW_PROMPT, undefined);
    assert.match(invocation.stdin?.value ?? '', new RegExp(`${prompt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n$`));
    assert.doesNotMatch(invocation.args.at(-1), /SHELL_INJECTION_OBSERVED|safe/);
  } finally { await rm(item.root, { recursive: true, force: true }); }
});

test('records a Windows stdin bridge error instead of accepting the review', async () => {
  const item = await fixture();
  try {
    const spawnProcess = () => {
      const child = new EventEmitter();
      child.stdin = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.end = undefined;
      child.stdin.end = function end() { setTimeout(() => this.emit('error', new Error('EPIPE')), 25); };
      queueMicrotask(() => { child.emit('exit', 0, null); child.stdout.emit('end'); child.stderr.emit('end'); });
      return child;
    };
    const result = await runSolReview(['review prompt'], { CODEX_HOME: item.codexHome }, 'win32', spawnProcess);
    assert.equal(result.exit_code, 1);
    assert.match(result.stdin_error, /EPIPE/);
    assert.equal(result.review_verdict, null);
  } finally { await rm(item.root, { recursive: true, force: true }); }
});

test('rejects a workflow-bound result path outside the review artifact directory', async () => {
  const item = await fixture();
  try {
    await assert.rejects(
      runSolReview([
        '--result', path.join(item.root, 'state.sqlite'),
        '--workflow-state-dir', path.join(item.root, 'state'),
        '--workflow-task-id', 'review-task',
        '--workflow-node-id', 'total-review',
        '--workflow-claim-id', 'claim-1',
        '--', 'review prompt',
      ], { CODEX_HOME: item.codexHome }, 'win32', () => { throw new Error('spawn must not be called'); }),
      /--result must be exactly/,
    );
    await assert.rejects(
      runSolReview([
        '--result', path.join(item.root, 'state', '.workflow-review-results', 'other-task', 'other-claim', 'outcome.json'),
        '--workflow-state-dir', path.join(item.root, 'state'),
        '--workflow-task-id', 'review-task',
        '--workflow-node-id', 'total-review',
        '--workflow-claim-id', 'claim-1',
        '--', 'review prompt',
      ], { CODEX_HOME: item.codexHome }, 'win32', () => { throw new Error('spawn must not be called'); }),
      /--result must be exactly/,
    );
  } finally { await rm(item.root, { recursive: true, force: true }); }
});

test('drains output emitted immediately after child exit before saving the result', async () => {
  const item = await fixture();
  try {
    let child;
    const spawnProcess = () => {
      child = new EventEmitter();
      child.pid = 4243; child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      queueMicrotask(() => {
        child.emit('exit', 0, null);
        setTimeout(() => child.stdout.emit('data', Buffer.from('tail after exit\n')), 10);
      });
      return child;
    };
    const result = await runSolReview([
      '--result', path.join(item.root, 'result.json'), '--codex-bin', 'fake-codex', '--', 'review prompt',
    ], { CODEX_HOME: item.codexHome }, 'win32', spawnProcess);
    assert.match(await readFile(result.result_path.replace(/\.json$/, '.stdout.log'), 'utf8'), /tail after exit/);
    const artifact = JSON.parse(await readFile(result.result_path, 'utf8'));
    assert.equal(result.exit_code, 1);
    assert.deepEqual(artifact.review_verdict, { valid: false, reason: 'review output capture is incomplete' });
    assert.equal(artifact.stdout.drain_timed_out, true);
    assert.equal(artifact.stdout.truncated, true);
  } finally { await rm(item.root, { recursive: true, force: true }); }
});

test('does not use a shell for a native executable on Windows', async () => {
  const item = await fixture();
  try {
    let invocation;
    const spawnProcess = (command, args, options) => {
      invocation = { command, args, options };
      const child = new EventEmitter();
      queueMicrotask(() => child.emit('exit', 0, null));
      return child;
    };
    await runSolReview(['--codex-bin', 'codex.exe', '--', 'review prompt'], { CODEX_HOME: item.codexHome }, 'win32', spawnProcess);
    assert.equal(invocation.command, 'codex.exe');
    assert.equal(invocation.options.shell, false);
  } finally { await rm(item.root, { recursive: true, force: true }); }
});

test('derives the CLI reasoning effort from the active workflow total-review role', async () => {
  const item = await fixture();
  const workspace = path.join(item.root, 'workspace'); const stateDir = path.join(item.root, 'state'); const manifest = path.join(item.root, 'manifest.json');
  try {
    await mkdir(workspace);
    await writeFile(path.join(workspace, 'source.txt'), 'review target\n');
    await writeFile(manifest, JSON.stringify({ task_id: 'review-task', workspace, goal: 'Use xhigh review', requirements: [{ id: 'R1', text: 'role is derived' }], nodes: [{ id: 'total-review', kind: 'total_review', agent_type: 'avsp_sol_xhigh', depends_on: [] }] }));
    await dispatch('init', { state_dir: stateDir, manifest });
    const [claim] = await dispatch('claim', { state_dir: stateDir, task_id: 'review-task', node_id: 'total-review', agent_task_path: '/root/xhigh-review', agent_role: 'avsp_sol_xhigh' });
    await dispatch('heartbeat', { state_dir: stateDir, task_id: 'review-task', node_id: 'total-review', claim_id: claim.node.claim_id });
    let invocation;
    const spawnProcess = (command, args, options) => {
      invocation = { command, args, options };
      const child = new EventEmitter(); child.pid = 4246; child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      queueMicrotask(() => { child.emit('exit', 2, null); child.stdout.emit('end'); child.stderr.emit('end'); });
      return child;
    };
    const result = await runSolReview([
      '--workflow-state-dir', stateDir, '--workflow-task-id', 'review-task', '--workflow-node-id', 'total-review', '--workflow-claim-id', claim.node.claim_id,
      '--codex-bin', 'codex.cmd', '--', 'review this frozen evidence package',
    ], { CODEX_HOME: item.codexHome }, 'win32', spawnProcess);
    assert.equal(result.exit_code, 2);
    assert.equal(invocation.options.env.CODEX_REVIEW_REASONING_EFFORT, 'xhigh');
    assert.equal(invocation.options.env.CODEX_REVIEW_PROMPT, undefined);
  } finally { await rm(item.root, { recursive: true, force: true }); }
});

test('keeps a workflow-bound Sol review running past the soft deadline and saves the eventual result', async () => {
  const item = await fixture();
  const workspace = path.join(item.root, 'workspace'); const stateDir = path.join(item.root, 'state'); const manifest = path.join(item.root, 'manifest.json');
  try {
    await mkdir(workspace);
    await writeFile(path.join(workspace, 'source.txt'), 'review target\n');
    await writeFile(manifest, JSON.stringify({
      task_id: 'review-task', workspace, goal: 'Verify timeout closure', requirements: [{ id: 'R1', text: 'timeout result is persisted' }],
      nodes: [{ id: 'total-review', kind: 'total_review', agent_type: 'avsp_sol_high', depends_on: [] }],
    }));
    await dispatch('init', { state_dir: stateDir, manifest });
    const [claim] = await dispatch('claim', { state_dir: stateDir, task_id: 'review-task', node_id: 'total-review', agent_task_path: '/root/timeout-review', agent_role: 'avsp_sol_high' });
    await dispatch('heartbeat', { state_dir: stateDir, task_id: 'review-task', node_id: 'total-review', claim_id: claim.node.claim_id });
    const [auditContext] = await dispatch('audit-context', { state_dir: stateDir, task_id: 'review-task' });
    const spawnProcess = () => {
      const child = new EventEmitter();
      child.pid = 4242; child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from('partial review output\n'));
        child.stdout.emit('data', Buffer.from(`${JSON.stringify({
          auditor_task: '/root/timeout-review', auditor_role: 'avsp_sol_high', claim_id: claim.node.claim_id, verdict: 'pass',
          requirement_coverage: { R1: 'timeout result is persisted' }, workflow_snapshot: auditContext.workflow_snapshot, workspace_fingerprint: auditContext.workspace_fingerprint, scope_and_regression: 'none', verification_gaps: 'none', residual_risk: 'none',
        })}\n`));
        child.stderr.emit('data', Buffer.from('partial diagnostics\n'));
        setTimeout(() => { child.emit('exit', 0, null); child.stdout.emit('end'); child.stderr.emit('end'); }, 1_100);
      });
      return child;
    };
    const result = await runSolReview([
      '--timeout-sec', '1',
      '--workflow-state-dir', stateDir,
      '--workflow-task-id', 'review-task',
      '--workflow-node-id', 'total-review',
      '--workflow-claim-id', claim.node.claim_id,
      '--', 'review this frozen evidence package',
    ], { CODEX_HOME: item.codexHome }, 'win32', spawnProcess);
    assert.equal(result.exit_code, 0);
    assert.equal(result.timed_out, false);
    assert.equal(result.deadline_reached, true);
    assert.equal(result.hard_timeout_reached, false);
    assert.deepEqual(result.workflow_completion, { state: 'pending' });
    assert.deepEqual(result.review_verdict, { valid: true, verdict: 'pass' });
    const artifact = JSON.parse(await readFile(result.result_path, 'utf8'));
    assert.deepEqual(artifact.workflow_completion, { state: 'pending' });
    assert.equal(artifact.timed_out, false);
    assert.equal(artifact.deadline_reached, true);
    assert.match(await readFile(artifact.stdout.path, 'utf8'), /partial review output/);
    assert.match(await readFile(artifact.stderr.path, 'utf8'), /partial diagnostics/);
    const state = await readTaskState(path.join(stateDir, 'review-task.sqlite'));
    assert.equal(state.nodes['total-review'].status, 'running');
    assert.equal(state.nodes['total-review'].result, null);
    const review = path.join(item.root, 'review.json');
    await writeFile(review, JSON.stringify({
      auditor_task: '/root/timeout-review', auditor_role: 'avsp_sol_high', claim_id: claim.node.claim_id, verdict: 'pass',
      requirement_coverage: { R1: 'timeout result is persisted' }, workflow_snapshot: auditContext.workflow_snapshot, workspace_fingerprint: auditContext.workspace_fingerprint, scope_and_regression: 'none', verification_gaps: 'none', residual_risk: 'none',
    }));
    await dispatch('record-review', { state_dir: stateDir, task_id: 'review-task', review });
    const [completion] = await dispatch('complete', {
      state_dir: stateDir, task_id: 'review-task', node_id: 'total-review', claim_id: claim.node.claim_id, status: 'succeeded', result: result.result_path, completion_attestation: 'native_agent_finished',
    });
    assert.equal(completion.workflow_outcome_completion.completed, true);
    const completedArtifact = JSON.parse(await readFile(result.result_path, 'utf8'));
    assert.equal(completedArtifact.workflow_completion.completed, true);
    assert.equal(completedArtifact.workflow_completion.status, 'succeeded');
  } finally { await rm(item.root, { recursive: true, force: true }); }
});

test('marks an exit-zero workflow-bound review unavailable when no valid verdict was emitted', async () => {
  const item = await fixture();
  const workspace = path.join(item.root, 'workspace'); const stateDir = path.join(item.root, 'state'); const manifest = path.join(item.root, 'manifest.json');
  try {
    await mkdir(workspace);
    await writeFile(path.join(workspace, 'source.txt'), 'review target\n');
    await writeFile(manifest, JSON.stringify({ task_id: 'review-task', workspace, goal: 'Reject empty review', requirements: [{ id: 'R1', text: 'invalid output is visible' }], nodes: [{ id: 'total-review', kind: 'total_review', agent_type: 'avsp_sol_high', depends_on: [] }] }));
    await dispatch('init', { state_dir: stateDir, manifest });
    const [claim] = await dispatch('claim', { state_dir: stateDir, task_id: 'review-task', node_id: 'total-review', agent_task_path: '/root/empty-review', agent_role: 'avsp_sol_high' });
    await dispatch('heartbeat', { state_dir: stateDir, task_id: 'review-task', node_id: 'total-review', claim_id: claim.node.claim_id });
    const spawnProcess = () => {
      const child = new EventEmitter(); child.pid = 4245; child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      queueMicrotask(() => { child.emit('exit', 0, null); child.stdout.emit('end'); child.stderr.emit('end'); });
      return child;
    };
    const result = await runSolReview([
      '--workflow-state-dir', stateDir, '--workflow-task-id', 'review-task', '--workflow-node-id', 'total-review', '--workflow-claim-id', claim.node.claim_id,
      '--codex-bin', 'fake-codex', '--', 'review this frozen evidence package',
    ], { CODEX_HOME: item.codexHome }, 'win32', spawnProcess);
    assert.equal(result.exit_code, 1);
    assert.deepEqual(result.review_verdict, { valid: false, reason: 'review output did not contain a JSON object' });
    assert.equal(result.workflow_completion.completed, true);
    const state = await readTaskState(path.join(stateDir, 'review-task.sqlite'));
    assert.equal(state.nodes['total-review'].status, 'unavailable');
  } finally { await rm(item.root, { recursive: true, force: true }); }
});

test('rejects a nested review object inside an unclosed array', async () => {
  const item = await fixture();
  try {
    const spawnProcess = () => {
      const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from('[{"auditor_task":"/root/review","verdict":"pass"}'));
        child.emit('exit', 0, null); child.stdout.emit('end'); child.stderr.emit('end');
      });
      return child;
    };
    const result = await runSolReview(['--codex-bin', 'fake-codex', '--', 'review prompt'], { CODEX_HOME: item.codexHome }, 'win32', spawnProcess);
    assert.equal(result.exit_code, 1);
    assert.deepEqual(result.review_verdict, { valid: false, reason: 'review output did not contain a JSON object' });
  } finally { await rm(item.root, { recursive: true, force: true }); }
});

test('rejects a nested review object after an unclosed string prefix', async () => {
  const item = await fixture();
  try {
    const review = {
      auditor_task: '/root/review', auditor_role: 'avsp_sol_high', claim_id: 'review-claim', verdict: 'pass',
      requirement_coverage: { R1: 'covered' }, workflow_snapshot: { revision: 1 }, workspace_fingerprint: { value: 'fingerprint' }, scope_and_regression: 'none', verification_gaps: 'none', residual_risk: 'none',
    };
    const spawnProcess = () => {
      const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from(`"unterminated prefix ${JSON.stringify(review)}`));
        child.emit('exit', 0, null); child.stdout.emit('end'); child.stderr.emit('end');
      });
      return child;
    };
    const result = await runSolReview(['--codex-bin', 'fake-codex', '--', 'review prompt'], { CODEX_HOME: item.codexHome }, 'win32', spawnProcess);
    assert.equal(result.exit_code, 1);
    assert.deepEqual(result.review_verdict, { valid: false, reason: 'review output did not contain a JSON object' });
  } finally { await rm(item.root, { recursive: true, force: true }); }
});

test('rejects an unclosed top-level review object', async () => {
  const item = await fixture();
  try {
    const spawnProcess = () => {
      const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from('{"auditor_task":"/root/review","verdict":"pass"'));
        child.emit('exit', 0, null); child.stdout.emit('end'); child.stderr.emit('end');
      });
      return child;
    };
    const result = await runSolReview(['--codex-bin', 'fake-codex', '--', 'review prompt'], { CODEX_HOME: item.codexHome }, 'win32', spawnProcess);
    assert.equal(result.exit_code, 1);
    assert.deepEqual(result.review_verdict, { valid: false, reason: 'review output did not contain a JSON object' });
  } finally { await rm(item.root, { recursive: true, force: true }); }
});

test('rejects empty review fields and coverage values that contradict the final JSON contract', async () => {
  const item = await fixture();
  try {
    const invalidReviews = [
      { scope_and_regression: {} },
      { verification_gaps: [] },
      { residual_risk: false },
      { requirement_coverage: { R1: {} } },
    ];
    for (const override of invalidReviews) {
      const review = {
        auditor_task: '/root/review', auditor_role: 'avsp_sol_high', claim_id: 'review-claim', verdict: 'pass',
        requirement_coverage: { R1: 'covered' }, workflow_snapshot: { revision: 1 }, workspace_fingerprint: { value: 'fingerprint' }, scope_and_regression: 'none', verification_gaps: 'none', residual_risk: 'none', ...override,
      };
      const spawnProcess = () => {
        const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
        queueMicrotask(() => {
          child.stdout.emit('data', Buffer.from(`${JSON.stringify(review)}\n`));
          child.emit('exit', 0, null); child.stdout.emit('end'); child.stderr.emit('end');
        });
        return child;
      };
      const result = await runSolReview(['--codex-bin', 'fake-codex', '--', 'review prompt'], { CODEX_HOME: item.codexHome }, 'win32', spawnProcess);
      assert.equal(result.exit_code, 1);
      assert.match(result.review_verdict.reason, /non-empty/);
    }
  } finally { await rm(item.root, { recursive: true, force: true }); }
});

test('rejects inherited coverage for a workflow requirement named toString', async () => {
  const item = await fixture();
  const workspace = path.join(item.root, 'workspace'); const stateDir = path.join(item.root, 'state'); const manifest = path.join(item.root, 'manifest.json');
  try {
    await mkdir(workspace); await writeFile(path.join(workspace, 'source.txt'), 'review target\n');
    await writeFile(manifest, JSON.stringify({ task_id: 'review-task', workspace, goal: 'Reject inherited coverage', requirements: [{ id: 'toString', text: 'coverage must be own' }], nodes: [{ id: 'total-review', kind: 'total_review', agent_type: 'avsp_sol_high', depends_on: [] }] }));
    await dispatch('init', { state_dir: stateDir, manifest });
    const [claim] = await dispatch('claim', { state_dir: stateDir, task_id: 'review-task', node_id: 'total-review', agent_task_path: '/root/to-string-review', agent_role: 'avsp_sol_high' });
    await dispatch('heartbeat', { state_dir: stateDir, task_id: 'review-task', node_id: 'total-review', claim_id: claim.node.claim_id });
    const [context] = await dispatch('audit-context', { state_dir: stateDir, task_id: 'review-task' });
    const spawnProcess = () => {
      const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from(`${JSON.stringify({
          auditor_task: '/root/to-string-review', auditor_role: 'avsp_sol_high', claim_id: claim.node.claim_id, verdict: 'pass',
          requirement_coverage: { R1: 'wrong inherited coverage' }, workflow_snapshot: context.workflow_snapshot, workspace_fingerprint: context.workspace_fingerprint, scope_and_regression: 'none', verification_gaps: 'none', residual_risk: 'none',
        })}\n`));
        child.emit('exit', 0, null); child.stdout.emit('end'); child.stderr.emit('end');
      });
      return child;
    };
    const result = await runSolReview([
      '--workflow-state-dir', stateDir, '--workflow-task-id', 'review-task', '--workflow-node-id', 'total-review', '--workflow-claim-id', claim.node.claim_id,
      '--codex-bin', 'fake-codex', '--', 'review prompt',
    ], { CODEX_HOME: item.codexHome }, 'win32', spawnProcess);
    assert.equal(result.exit_code, 1);
    assert.deepEqual(result.review_verdict, { valid: false, reason: 'review output does not cover every workflow requirement' });
  } finally { await rm(item.root, { recursive: true, force: true }); }
});

test('marks a structurally complete workflow review unavailable when its audit context is stale or mismatched', async () => {
  const item = await fixture();
  const workspace = path.join(item.root, 'workspace'); const stateDir = path.join(item.root, 'state'); const manifest = path.join(item.root, 'manifest.json');
  try {
    await mkdir(workspace);
    await writeFile(path.join(workspace, 'source.txt'), 'review target\n');
    await writeFile(manifest, JSON.stringify({ task_id: 'review-task', workspace, goal: 'Reject mismatched review', requirements: [{ id: 'R1', text: 'review context must match' }], nodes: [{ id: 'total-review', kind: 'total_review', agent_type: 'avsp_sol_high', depends_on: [] }] }));
    await dispatch('init', { state_dir: stateDir, manifest });
    const [claim] = await dispatch('claim', { state_dir: stateDir, task_id: 'review-task', node_id: 'total-review', agent_task_path: '/root/mismatched-review', agent_role: 'avsp_sol_high' });
    await dispatch('heartbeat', { state_dir: stateDir, task_id: 'review-task', node_id: 'total-review', claim_id: claim.node.claim_id });
    const [auditContext] = await dispatch('audit-context', { state_dir: stateDir, task_id: 'review-task' });
    const spawnProcess = () => {
      const child = new EventEmitter(); child.pid = 4246; child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from(`${JSON.stringify({
          auditor_task: '/root/mismatched-review', auditor_role: 'avsp_sol_high', claim_id: claim.node.claim_id, verdict: 'pass',
          requirement_coverage: { R1: 'review context must match' }, workflow_snapshot: auditContext.workflow_snapshot, workspace_fingerprint: { changed: true }, scope_and_regression: 'none', verification_gaps: 'none', residual_risk: 'none',
        })}\n`));
        child.emit('exit', 0, null); child.stdout.emit('end'); child.stderr.emit('end');
      });
      return child;
    };
    const result = await runSolReview([
      '--workflow-state-dir', stateDir, '--workflow-task-id', 'review-task', '--workflow-node-id', 'total-review', '--workflow-claim-id', claim.node.claim_id,
      '--codex-bin', 'fake-codex', '--', 'review this frozen evidence package',
    ], { CODEX_HOME: item.codexHome }, 'win32', spawnProcess);
    assert.equal(result.exit_code, 1);
    assert.deepEqual(result.review_verdict, { valid: false, reason: 'review output workspace_fingerprint does not match the current workspace' });
    assert.equal(result.workflow_completion.completed, true);
    const persisted = JSON.parse(await readFile(result.result_path, 'utf8'));
    assert.equal(persisted.workflow_completion.completed, true);
    const state = await readTaskState(path.join(stateDir, 'review-task.sqlite'));
    assert.equal(state.nodes['total-review'].status, 'unavailable');
  } finally { await rm(item.root, { recursive: true, force: true }); }
});

test('closes a workflow-bound unavailable Sol review with an explicit completion attestation', async () => {
  const item = await fixture();
  const workspace = path.join(item.root, 'workspace'); const stateDir = path.join(item.root, 'state'); const manifest = path.join(item.root, 'manifest.json');
  try {
    await mkdir(workspace);
    await writeFile(path.join(workspace, 'source.txt'), 'review target\n');
    await writeFile(manifest, JSON.stringify({ task_id: 'review-task', workspace, goal: 'Persist unavailable review', requirements: [{ id: 'R1', text: 'unavailable result is visible' }], nodes: [{ id: 'total-review', kind: 'total_review', agent_type: 'avsp_sol_high', depends_on: [] }] }));
    await dispatch('init', { state_dir: stateDir, manifest });
    const [claim] = await dispatch('claim', { state_dir: stateDir, task_id: 'review-task', node_id: 'total-review', agent_task_path: '/root/unavailable-review', agent_role: 'avsp_sol_high' });
    await dispatch('heartbeat', { state_dir: stateDir, task_id: 'review-task', node_id: 'total-review', claim_id: claim.node.claim_id });
    const spawnProcess = () => {
      const child = new EventEmitter(); child.pid = 4243; child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      queueMicrotask(() => child.emit('exit', 2, null));
      return child;
    };
    const result = await runSolReview([
      '--workflow-state-dir', stateDir,
      '--workflow-task-id', 'review-task',
      '--workflow-node-id', 'total-review',
      '--workflow-claim-id', claim.node.claim_id,
      '--codex-bin', 'fake-codex', '--', 'review this frozen evidence package',
    ], { CODEX_HOME: item.codexHome }, 'win32', spawnProcess);
    assert.equal(result.exit_code, 2);
    assert.equal(result.workflow_completion.completed, true);
    const state = await readTaskState(path.join(stateDir, 'review-task.sqlite'));
    assert.equal(state.nodes['total-review'].status, 'unavailable');
    assert.ok(state.events.some(event => event.type === 'node_completed' && event.completion_attestation === 'native_agent_exit_confirmed'));
  } finally { await rm(item.root, { recursive: true, force: true }); }
});

test('records native_agent_start_failed when the workflow-bound Sol process cannot start', async () => {
  const item = await fixture();
  const workspace = path.join(item.root, 'workspace'); const stateDir = path.join(item.root, 'state'); const manifest = path.join(item.root, 'manifest.json');
  try {
    await mkdir(workspace);
    await writeFile(path.join(workspace, 'source.txt'), 'review target\n');
    await writeFile(manifest, JSON.stringify({ task_id: 'review-task', workspace, goal: 'Persist start failure', requirements: [{ id: 'R1', text: 'start failure is visible' }], nodes: [{ id: 'total-review', kind: 'total_review', agent_type: 'avsp_sol_high', depends_on: [] }] }));
    await dispatch('init', { state_dir: stateDir, manifest });
    const [claim] = await dispatch('claim', { state_dir: stateDir, task_id: 'review-task', node_id: 'total-review', agent_task_path: '/root/start-failure-review', agent_role: 'avsp_sol_high' });
    await dispatch('heartbeat', { state_dir: stateDir, task_id: 'review-task', node_id: 'total-review', claim_id: claim.node.claim_id });
    const spawnProcess = () => {
      const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      queueMicrotask(() => { child.emit('error', new Error('test spawn failure')); child.stdout.emit('end'); child.stderr.emit('end'); });
      return child;
    };
    const result = await runSolReview([
      '--workflow-state-dir', stateDir, '--workflow-task-id', 'review-task', '--workflow-node-id', 'total-review', '--workflow-claim-id', claim.node.claim_id,
      '--codex-bin', 'fake-codex', '--', 'review this frozen evidence package',
    ], { CODEX_HOME: item.codexHome }, 'win32', spawnProcess);
    assert.equal(result.exit_code, 1);
    assert.equal(result.spawn_error, 'test spawn failure');
    assert.equal(result.workflow_completion.completed, true);
    const state = await readTaskState(path.join(stateDir, 'review-task.sqlite'));
    assert.equal(state.nodes['total-review'].status, 'unavailable');
    assert.ok(state.events.some(event => event.type === 'node_completed' && event.completion_attestation === 'native_agent_start_failed'));
  } finally { await rm(item.root, { recursive: true, force: true }); }
});

test('records native_agent_exit_confirmed when a started Sol process later reports an error', async () => {
  const item = await fixture();
  const workspace = path.join(item.root, 'workspace'); const stateDir = path.join(item.root, 'state'); const manifest = path.join(item.root, 'manifest.json');
  try {
    await mkdir(workspace);
    await writeFile(path.join(workspace, 'source.txt'), 'review target\n');
    await writeFile(manifest, JSON.stringify({ task_id: 'review-task', workspace, goal: 'Persist post-start process error', requirements: [{ id: 'R1', text: 'post-start failure is visible' }], nodes: [{ id: 'total-review', kind: 'total_review', agent_type: 'avsp_sol_high', depends_on: [] }] }));
    await dispatch('init', { state_dir: stateDir, manifest });
    const [claim] = await dispatch('claim', { state_dir: stateDir, task_id: 'review-task', node_id: 'total-review', agent_task_path: '/root/post-start-error-review', agent_role: 'avsp_sol_high' });
    await dispatch('heartbeat', { state_dir: stateDir, task_id: 'review-task', node_id: 'total-review', claim_id: claim.node.claim_id });
    const spawnProcess = () => {
      const child = new EventEmitter(); child.pid = 4247; child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      queueMicrotask(() => { child.emit('spawn'); child.emit('error', new Error('test post-start error')); child.emit('exit', 1, null); child.stdout.emit('end'); child.stderr.emit('end'); });
      return child;
    };
    const result = await runSolReview([
      '--workflow-state-dir', stateDir, '--workflow-task-id', 'review-task', '--workflow-node-id', 'total-review', '--workflow-claim-id', claim.node.claim_id,
      '--codex-bin', 'fake-codex', '--', 'review this frozen evidence package',
    ], { CODEX_HOME: item.codexHome }, 'win32', spawnProcess);
    assert.equal(result.spawn_started, true);
    assert.equal(result.workflow_completion.completed, true);
    const state = await readTaskState(path.join(stateDir, 'review-task.sqlite'));
    assert.ok(state.events.some(event => event.type === 'node_completed' && event.completion_attestation === 'native_agent_exit_confirmed'));
  } finally { await rm(item.root, { recursive: true, force: true }); }
});

test('records native_agent_start_failed when spawning synchronously throws', async () => {
  const item = await fixture();
  const workspace = path.join(item.root, 'workspace'); const stateDir = path.join(item.root, 'state'); const manifest = path.join(item.root, 'manifest.json');
  try {
    await mkdir(workspace);
    await writeFile(path.join(workspace, 'source.txt'), 'review target\n');
    await writeFile(manifest, JSON.stringify({ task_id: 'review-task', workspace, goal: 'Persist synchronous start failure', requirements: [{ id: 'R1', text: 'sync start failure is visible' }], nodes: [{ id: 'total-review', kind: 'total_review', agent_type: 'avsp_sol_high', depends_on: [] }] }));
    await dispatch('init', { state_dir: stateDir, manifest });
    const [claim] = await dispatch('claim', { state_dir: stateDir, task_id: 'review-task', node_id: 'total-review', agent_task_path: '/root/sync-start-failure-review', agent_role: 'avsp_sol_high' });
    await dispatch('heartbeat', { state_dir: stateDir, task_id: 'review-task', node_id: 'total-review', claim_id: claim.node.claim_id });
    const result = await runSolReview([
      '--workflow-state-dir', stateDir, '--workflow-task-id', 'review-task', '--workflow-node-id', 'total-review', '--workflow-claim-id', claim.node.claim_id,
      '--codex-bin', 'fake-codex', '--', 'review this frozen evidence package',
    ], { CODEX_HOME: item.codexHome }, 'win32', () => { throw new Error('test synchronous spawn failure'); });
    assert.equal(result.spawn_started, false);
    assert.equal(result.workflow_completion.completed, true);
    const state = await readTaskState(path.join(stateDir, 'review-task.sqlite'));
    assert.ok(state.events.some(event => event.type === 'node_completed' && event.completion_attestation === 'native_agent_start_failed'));
  } finally { await rm(item.root, { recursive: true, force: true }); }
});

test('only an explicit hard timeout terminates a still-running Sol review', async () => {
  const item = await fixture();
  try {
    let child;
    const spawnProcess = () => {
      child = new EventEmitter();
      child.pid = 4244; child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      return child;
    };
    const terminateProcess = async currentChild => {
      queueMicrotask(() => currentChild.emit('exit', null, 'SIGTERM'));
      return { method: 'test termination', pid: currentChild.pid };
    };
    const result = await runSolReview([
      '--timeout-sec', '10', '--hard-timeout-sec', '1',
      '--result', path.join(item.root, 'result.json'), '--', 'review this evidence package',
    ], { CODEX_HOME: item.codexHome }, 'win32', spawnProcess, terminateProcess);
    assert.equal(result.exit_code, 124);
    assert.equal(result.timed_out, true);
    assert.equal(result.hard_timeout_reached, true);
    assert.equal(result.termination.confirmed, true);
  } finally { await rm(item.root, { recursive: true, force: true }); }
});
