import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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
    assert.deepEqual(invocation.args, ['exec', '--model', 'gpt-5.6-sol', '--sandbox', 'read-only', '--', 'review prompt']);
    assert.equal(invocation.options.env.CODEX_HOME, item.codexHome);
    assert.equal(invocation.options.shell, false);
    assert.equal(resolveCodexHome({ USERPROFILE: 'C:\\Users\\Administrator' }, 'win32'), path.join('C:\\Users\\Administrator', '.codex'));
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
    await runSolReview([
      '--review-profile', 'bounded-external', '--evidence-dir', item.evidence, '--codex-bin', 'fake-codex', '--', 'review prompt',
    ], { CODEX_HOME: item.codexHome }, 'linux', spawnProcess);
    assert.equal(invocation.command, 'fake-codex');
    assert.deepEqual(invocation.args.slice(0, 8), ['exec', '--model', 'gpt-5.6-sol', '--sandbox', 'read-only', '-C', item.evidence, '--skip-git-repo-check']);
    assert.equal(invocation.options.cwd, item.evidence);
    const prompt = invocation.args.at(-1);
    assert.match(prompt, /Review profile: bounded-external/);
    assert.match(prompt, /fixed evidence package/);
    assert.match(prompt, /listed changed files and necessary adjacent call chains/);
    assert.match(prompt, /Do not enumerate the entire workspace/);
    assert.match(prompt, /\.git, \.codex, node_modules, \.venv, \.yarn, or \.yarn-cache\*/);
    assert.match(prompt, /verdict "unavailable" or "fail"/);
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
  } finally { await rm(item.root, { recursive: true, force: true }); }
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
    assert.equal(invocation.options.env.CODEX_REVIEW_PROMPT, 'review prompt');
    assert.match(invocation.args.at(-1), /\$arguments \+= '--'/);
    assert.doesNotMatch(invocation.args.at(-1), /review prompt/);
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
    await runSolReview(['--review-profile', 'bounded-external', '--evidence-dir', item.evidence, 'review prompt'], { CODEX_HOME: item.codexHome }, 'win32', spawnProcess);
    assert.equal(invocation.command, 'powershell.exe');
    assert.equal(invocation.options.shell, false);
    assert.equal(invocation.options.env.CODEX_REVIEW_BIN, 'codex.cmd');
    assert.equal(invocation.options.env.CODEX_REVIEW_WORKSPACE, item.evidence);
    assert.equal(invocation.options.cwd, item.evidence);
    assert.match(invocation.options.env.CODEX_REVIEW_PROMPT, /Review profile: bounded-external/);
    assert.match(invocation.options.env.CODEX_REVIEW_PROMPT, /fixed evidence package/);
    assert.match(invocation.options.env.CODEX_REVIEW_PROMPT, /verdict "unavailable" or "fail"/);
    assert.doesNotMatch(invocation.args.at(-1), /Review profile|fixed evidence package|review prompt/);
    assert.match(invocation.args.at(-1), /CODEX_REVIEW_WORKSPACE/);
    assert.match(invocation.args.at(-1), /--skip-git-check|--skip-git-repo-check/);
  } finally { await rm(item.root, { recursive: true, force: true }); }
});

test('keeps a malicious Windows prompt out of the PowerShell command source', async () => {
  const item = await fixture();
  try {
    let invocation;
    const prompt = 'safe" & echo SHELL_INJECTION_OBSERVED & "tail';
    const spawnProcess = (command, args, options) => {
      invocation = { command, args, options };
      const child = new EventEmitter();
      queueMicrotask(() => child.emit('exit', 0, null));
      return child;
    };
    await runSolReview([prompt], { CODEX_HOME: item.codexHome }, 'win32', spawnProcess);
    assert.equal(invocation.command, 'powershell.exe');
    assert.equal(invocation.options.shell, false);
    assert.equal(invocation.options.env.CODEX_REVIEW_PROMPT, prompt);
    assert.doesNotMatch(invocation.args.at(-1), /SHELL_INJECTION_OBSERVED|safe/);
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
    const spawnProcess = () => {
      const child = new EventEmitter();
      child.pid = 4242; child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from('partial review output\n'));
        child.stderr.emit('data', Buffer.from('partial diagnostics\n'));
        setTimeout(() => child.emit('exit', 0, null), 1_100);
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
    assert.equal(result.workflow_completion, null);
    const artifact = JSON.parse(await readFile(result.result_path, 'utf8'));
    assert.equal(artifact.timed_out, false);
    assert.equal(artifact.deadline_reached, true);
    assert.match(await readFile(artifact.stdout.path, 'utf8'), /partial review output/);
    assert.match(await readFile(artifact.stderr.path, 'utf8'), /partial diagnostics/);
    const state = await readTaskState(path.join(stateDir, 'review-task.sqlite'));
    assert.equal(state.nodes['total-review'].status, 'running');
    assert.equal(state.nodes['total-review'].result, null);
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
