import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { repairInvalidDenyReadAclState, resolveCodexHome, runSolReview } from '../scripts/sol_review_cli.mjs';

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agnets-sol-cli-'));
  const codexHome = path.join(root, 'codex-home');
  const sandbox = path.join(codexHome, '.sandbox');
  await mkdir(sandbox, { recursive: true });
  return { root, codexHome, sandbox, state: path.join(sandbox, 'deny_read_acl_state.json') };
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
    assert.deepEqual(invocation.args, ['exec', '--model', 'gpt-5.6-sol', '--sandbox', 'read-only', 'review prompt']);
    assert.equal(invocation.options.env.CODEX_HOME, item.codexHome);
    assert.equal(invocation.options.shell, false);
    assert.equal(resolveCodexHome({ USERPROFILE: 'C:\\Users\\Administrator' }, 'win32'), path.join('C:\\Users\\Administrator', '.codex'));
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
    assert.equal(invocation.command, 'codex.cmd');
    assert.equal(invocation.options.shell, true);
    assert.equal(invocation.args.at(-1), '"review prompt"');
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
