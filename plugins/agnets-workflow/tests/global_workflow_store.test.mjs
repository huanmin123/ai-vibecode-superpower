import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, mkdtemp, mkdir, readdir, realpath, rm, readFile, symlink, unlink } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  globalTaskStateExists,
  globalWorkflowStorePath,
  claimGlobalTaskPruneJobs,
  ensureGlobalNamespaceIdentity,
  finalizeGlobalTaskPruneJob,
  readGlobalTaskState,
  taskNamespaceKey,
  withGlobalTaskStateTransaction,
  writeGlobalTaskState,
} from '../scripts/global_workflow_store.mjs';

const storeModuleUrl = pathToFileURL(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../scripts/global_workflow_store.mjs')).href;

function runStoreChild(codexHome, statePath, mode, value = '') {
  const source = `
    import { readGlobalTaskState, withGlobalTaskStateTransaction, writeGlobalTaskState } from ${JSON.stringify(storeModuleUrl)};
    const statePath = process.env.WORKFLOW_TEST_STATE_PATH;
    if (process.env.WORKFLOW_TEST_MODE === 'write') {
      await writeGlobalTaskState(statePath, { version: 1, child: process.env.WORKFLOW_TEST_VALUE, updated_at: new Date().toISOString() });
    } else if (process.env.WORKFLOW_TEST_MODE === 'increment') {
      await withGlobalTaskStateTransaction(statePath, {}, async (current, save) => save({ ...current, counter: (current?.counter ?? 0) + 1, updated_at: new Date().toISOString() }));
    } else {
      await readGlobalTaskState(statePath);
    }
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '--eval', source], {
      env: { ...process.env, CODEX_HOME: codexHome, WORKFLOW_TEST_STATE_PATH: statePath, WORKFLOW_TEST_MODE: mode, WORKFLOW_TEST_VALUE: String(value) },
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`store child ${mode} failed (${code}): ${stderr}`)));
  });
}

test('global workflow store publishes one fully initialized database for concurrent first-process writers', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agnets-global-first-process-'));
  const codexHome = path.join(root, 'codex-home');
  const states = Array.from({ length: 12 }, (_, index) => path.join(root, 'workspace', `namespace-${index}`, `task-${index}.sqlite`));
  const previousHome = process.env.CODEX_HOME;
  try {
    await Promise.all(states.map((statePath, index) => runStoreChild(codexHome, statePath, 'write', index)));
    process.env.CODEX_HOME = codexHome;
    for (const [index, statePath] of states.entries()) assert.equal((await readGlobalTaskState(statePath)).child, String(index));
    const store = globalWorkflowStorePath();
    const database = new DatabaseSync(store, { readOnly: true });
    assert.equal(String(database.prepare('PRAGMA journal_mode').get().journal_mode).toLowerCase(), 'wal');
    assert.equal(Number(database.prepare('PRAGMA auto_vacuum').get().auto_vacuum), 2);
    assert.ok(Number(database.prepare('PRAGMA max_page_count').get().max_page_count) >= 131072);
    assert.equal(database.prepare("SELECT count(*) AS count FROM store_meta WHERE key IN ('schema_version', 'store_id')").get().count, 2);
    assert.equal(database.prepare('SELECT count(*) AS count FROM task_state').get().count, states.length);
    assert.deepEqual(database.prepare('PRAGMA index_info(task_state_prune_after_idx)').all().map(row => row.name), ['prune_after', 'namespace_key', 'task_id']);
    assert.deepEqual(database.prepare('PRAGMA index_info(task_prune_job_due_idx)').all().map(row => row.name), ['phase', 'retry_after', 'lease_deadline_at', 'namespace_key', 'task_id']);
    database.close();

    const shared = path.join(root, 'workspace', 'preheated', 'shared.sqlite');
    await writeGlobalTaskState(shared, { version: 1, counter: 0, updated_at: new Date().toISOString() });
    await Promise.all([
      ...Array.from({ length: 8 }, () => runStoreChild(codexHome, shared, 'increment')),
      ...Array.from({ length: 12 }, () => runStoreChild(codexHome, shared, 'read')),
    ]);
    assert.equal((await readGlobalTaskState(shared)).counter, 8);
  } finally {
    if (previousHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousHome;
    await rm(root, { recursive: true, force: true });
  }
});

test('global workflow store isolates same task id by namespace and serializes writers', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agnets-global-store-'));
  const previousHome = process.env.CODEX_HOME;
  const codexHome = path.join(root, 'codex-home');
  const first = path.join(root, 'workspace-a', 'state', 'shared.sqlite');
  const second = path.join(root, 'workspace-b', 'state', 'shared.sqlite');
  try {
    process.env.CODEX_HOME = codexHome;
    await mkdir(path.dirname(first), { recursive: true });
    await mkdir(path.dirname(second), { recursive: true });
    await writeGlobalTaskState(first, { version: 1, updated_at: '2026-08-17T00:00:00.000Z', counter: 0 });
    await writeGlobalTaskState(second, { version: 1, updated_at: '2026-08-17T00:00:00.000Z', counter: 7 });
    assert.equal((await readGlobalTaskState(first)).counter, 0);
    assert.equal((await readGlobalTaskState(second)).counter, 7);
    await Promise.all(Array.from({ length: 12 }, () => withGlobalTaskStateTransaction(first, {}, async (current, save) => {
      save({ ...current, counter: current.counter + 1, updated_at: new Date().toISOString() });
    })));
    assert.equal((await readGlobalTaskState(first)).counter, 12);
    assert.equal(await globalTaskStateExists(first), true);
    assert.equal(existsSync(first), false);
    assert.equal(existsSync(second), false);
    assert.equal(existsSync(globalWorkflowStorePath()), true);
    assert.deepEqual(await readdir(path.dirname(first)), []);
    assert.deepEqual(await readdir(path.dirname(second)), []);
  } finally {
    if (previousHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousHome;
    await rm(root, { recursive: true, force: true });
  }
});

test('global workflow store rejects a foreign SQLite without changing bytes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agnets-global-foreign-store-'));
  const previousHome = process.env.CODEX_HOME;
  try {
    process.env.CODEX_HOME = path.join(root, 'codex-home');
    const store = globalWorkflowStorePath();
    await mkdir(path.dirname(store), { recursive: true });
    const foreign = new DatabaseSync(store);
    foreign.exec('CREATE TABLE application_data (id INTEGER PRIMARY KEY, value TEXT NOT NULL); INSERT INTO application_data VALUES (1, \'foreign\');');
    foreign.close();
    const before = createHash('sha256').update(await readFile(store)).digest('hex');
    await assert.rejects(() => writeGlobalTaskState(path.join(root, 'state', 'task.sqlite'), { version: 1, updated_at: new Date().toISOString() }), /schema marker mismatch|unknown managed objects/);
    const after = createHash('sha256').update(await readFile(store)).digest('hex');
    assert.equal(after, before);
  } finally {
    if (previousHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousHome;
    await rm(root, { recursive: true, force: true });
  }
});

test('global workflow store rejects a relative CODEX_HOME before touching the cwd', async () => {
  const previousHome = process.env.CODEX_HOME;
  try {
    process.env.CODEX_HOME = 'relative-codex-home';
    assert.throws(() => globalWorkflowStorePath(), /CODEX_HOME must be an absolute path/);
    const absolute = path.join(os.tmpdir(), 'agnets-global-trimmed-home');
    process.env.CODEX_HOME = `  ${absolute}  `;
    assert.equal(globalWorkflowStorePath(), path.join(absolute, 'state', 'agnets-workflow', 'workflow.sqlite'));
  } finally {
    if (previousHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousHome;
  }
});

test('global workflow store validates existing parent links before creating any descendant', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agnets-global-parent-link-'));
  const previousHome = process.env.CODEX_HOME;
  const codexHome = path.join(root, 'codex-home');
  const linkedStateTarget = path.join(root, 'linked-state-target');
  const stateLink = path.join(codexHome, 'state');
  try {
    await mkdir(codexHome);
    await mkdir(linkedStateTarget);
    try { await symlink(linkedStateTarget, stateLink, process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error?.code)) { t.skip(`directory links are unavailable: ${error.code}`); return; }
      throw error;
    }
    process.env.CODEX_HOME = codexHome;
    await assert.rejects(
      () => writeGlobalTaskState(path.join(root, 'workspace', 'state', 'task.sqlite'), { version: 1, updated_at: new Date().toISOString() }),
      /parent is not a regular directory/,
    );
    assert.equal(existsSync(path.join(linkedStateTarget, 'agnets-workflow')), false);
    assert.equal(existsSync(path.join(linkedStateTarget, 'agnets-workflow', 'workflow.sqlite')), false);
  } finally {
    if (previousHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousHome;
    try { await unlink(stateLink); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    await rm(root, { recursive: true, force: true });
  }
});

test('global prune claim blocks a same-task replacement until finalization', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agnets-global-maintenance-'));
  const previousHome = process.env.CODEX_HOME;
  const codexHome = path.join(root, 'codex-home');
  const namespace = path.join(root, 'workspace', 'state');
  const statePath = path.join(namespace, 'race.sqlite');
  try {
    process.env.CODEX_HOME = codexHome;
    await mkdir(namespace, { recursive: true });
    const metadata = await lstat(namespace, { bigint: true });
    await ensureGlobalNamespaceIdentity(namespace, { path: namespace, real_path: await realpath(namespace), identity: { dev: metadata.dev.toString(), ino: metadata.ino.toString() } });
    await writeGlobalTaskState(statePath, { version: 1, generation: 'old', workflow_revision: 1, closed_revision: 1, closed_at: '1970-01-01T00:00:00.000Z', updated_at: '1970-01-01T00:00:00.000Z', workspace_lease: { status: 'released' }, nodes: { node: { status: 'succeeded' } } });
    const [claim] = await claimGlobalTaskPruneJobs(new Date().toISOString(), { namespace_key: namespace });
    assert.ok(claim);
    await assert.rejects(() => writeGlobalTaskState(statePath, { version: 1, generation: 'new', updated_at: new Date().toISOString() }), /reserved for retention cleanup/);
    await finalizeGlobalTaskPruneJob(claim);
    await writeGlobalTaskState(statePath, { version: 1, generation: 'new', updated_at: new Date().toISOString() });
    assert.equal((await readGlobalTaskState(statePath)).generation, 'new');
  } finally {
    if (previousHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousHome;
    await rm(root, { recursive: true, force: true });
  }
});
