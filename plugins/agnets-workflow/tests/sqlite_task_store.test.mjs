import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { access, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { deleteTaskState, readTaskState, taskStateExists, withTaskStateTransaction, writeTaskState } from '../scripts/sqlite_task_store.mjs';

async function parentAuthority(filePath) {
  const directory = path.dirname(filePath);
  const metadata = await lstat(directory, { bigint: true });
  return { path: directory, realPath: await realpath(directory), identity: { dev: metadata.dev.toString(), ino: metadata.ino.toString() } };
}

function deferred() {
  let resolve;
  const promise = new Promise(resolvePromise => { resolve = resolvePromise; });
  return { promise, resolve };
}

function state(taskId, counter = 0, updatedAt = '2026-08-04T00:00:00.000Z') {
  return { version: 1, task_id: taskId, updated_at: updatedAt, counter, nodes: {} };
}

async function pathExists(filePath) {
  try { await access(filePath); return true; }
  catch (cause) { if (cause.code === 'ENOENT') return false; throw cause; }
}

async function completesWithin(promise, milliseconds) {
  let timeout;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise(resolve => { timeout = setTimeout(() => resolve(false), milliseconds); }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

test('native SQLite persists task state, supports an explicit transaction, and creates no .lock sidecar', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agnets-workflow-sqlite-'));
  const databasePath = path.join(directory, 'task.sqlite');
  const initial = state('sqlite-test');
  try {
    assert.equal(await taskStateExists(databasePath), false);
    await writeTaskState(databasePath, initial, { parentAuthority: await parentAuthority(databasePath) });
    assert.equal(await taskStateExists(databasePath), true);
    assert.deepEqual(await readTaskState(databasePath), initial);
    const result = await withTaskStateTransaction(databasePath, { parentAuthority: await parentAuthority(databasePath) }, async (current, save) => {
      assert.deepEqual(current, initial);
      assert.equal(await pathExists(`${databasePath}.lock`), false);
      current.counter++;
      current.updated_at = '2026-08-04T00:01:00.000Z';
      save(current);
      return { committed_counter: current.counter };
    });
    assert.deepEqual(result, { committed_counter: 1 });
    assert.equal((await readTaskState(databasePath)).counter, 1);
    const bytes = await readFile(databasePath);
    assert.deepEqual(bytes.subarray(0, 16), Buffer.from('SQLite format 3\u0000'));
    assert.equal(await pathExists(`${databasePath}.lock`), false);
    await deleteTaskState(databasePath, { parentAuthority: await parentAuthority(databasePath) });
    assert.equal(await taskStateExists(databasePath), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('does not create a missing task database from a mutation transaction', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agnets-workflow-sqlite-missing-'));
  const databasePath = path.join(directory, 'missing.sqlite');
  try {
    const authority = await parentAuthority(databasePath);
    await assert.rejects(
      () => withTaskStateTransaction(databasePath, { parentAuthority: authority }, async (_current, save) => save(state('missing'))),
      /SQLite task state does not exist/,
    );
    assert.equal(await pathExists(databasePath), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('rolls back saved changes when the callback fails or omits save(state)', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agnets-workflow-sqlite-rollback-'));
  const databasePath = path.join(directory, 'task.sqlite');
  const initial = state('rollback-test');
  try {
    const authority = await parentAuthority(databasePath);
    await writeTaskState(databasePath, initial, { parentAuthority: authority });
    await assert.rejects(
      () => withTaskStateTransaction(databasePath, { parentAuthority: authority }, async current => { assert.deepEqual(current, initial); }),
      /must call save\(state\) before commit/,
    );
    assert.deepEqual(await readTaskState(databasePath), initial);
    await assert.rejects(
      () => withTaskStateTransaction(databasePath, { parentAuthority: authority }, async (current, save) => {
        current.counter = 99;
        current.updated_at = '2026-08-04T00:02:00.000Z';
        save(current);
        throw new Error('rollback sentinel');
      }),
      /rollback sentinel/,
    );
    assert.deepEqual(await readTaskState(databasePath), initial);
    await assert.rejects(
      () => withTaskStateTransaction(databasePath, { parentAuthority: authority }, async current => {
        current.counter = 2;
      }),
      /must call save\(state\) before commit/,
    );
    assert.deepEqual(await readTaskState(databasePath), initial);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('serializes concurrent transactions for the same database without blocking the active callback', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agnets-workflow-sqlite-serial-'));
  const databasePath = path.join(directory, 'task.sqlite');
  const enteredFirst = deferred();
  const releaseFirst = deferred();
  let secondStarted = false;
  let first;
  let second;
  try {
    await writeTaskState(databasePath, state('serial-test'), { parentAuthority: await parentAuthority(databasePath) });
    first = withTaskStateTransaction(databasePath, { parentAuthority: await parentAuthority(databasePath) }, async (current, save) => {
      enteredFirst.resolve();
      await releaseFirst.promise;
      current.counter++;
      current.updated_at = '2026-08-04T00:03:00.000Z';
      save(current);
    });
    await enteredFirst.promise;
    second = withTaskStateTransaction(databasePath, { parentAuthority: await parentAuthority(databasePath) }, async (current, save) => {
      secondStarted = true;
      current.counter++;
      current.updated_at = '2026-08-04T00:04:00.000Z';
      save(current);
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(secondStarted, false);
    releaseFirst.resolve();
    await Promise.all([first, second]);
    assert.equal((await readTaskState(databasePath)).counter, 2);
  } finally {
    releaseFirst.resolve();
    await Promise.allSettled([first, second].filter(Boolean));
    await rm(directory, { recursive: true, force: true });
  }
});

test('allows transactions for different databases to enter concurrently', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agnets-workflow-sqlite-parallel-'));
  const firstPath = path.join(directory, 'first.sqlite');
  const secondPath = path.join(directory, 'second.sqlite');
  const firstEntered = deferred();
  const secondEntered = deferred();
  const releaseBoth = deferred();
  const enteredBoth = Promise.all([firstEntered.promise, secondEntered.promise]);
  let first;
  let second;
  try {
    await Promise.all([
      writeTaskState(firstPath, state('first'), { parentAuthority: await parentAuthority(firstPath) }),
      writeTaskState(secondPath, state('second'), { parentAuthority: await parentAuthority(secondPath) }),
    ]);
    first = withTaskStateTransaction(firstPath, { parentAuthority: await parentAuthority(firstPath) }, async (current, save) => {
      firstEntered.resolve();
      await releaseBoth.promise;
      current.counter++;
      current.updated_at = '2026-08-04T00:05:00.000Z';
      save(current);
    });
    second = withTaskStateTransaction(secondPath, { parentAuthority: await parentAuthority(secondPath) }, async (current, save) => {
      secondEntered.resolve();
      await releaseBoth.promise;
      current.counter++;
      current.updated_at = '2026-08-04T00:06:00.000Z';
      save(current);
    });
    const bothEntered = await completesWithin(enteredBoth, 1_000);
    assert.equal(bothEntered, true, 'different task databases should not share a process-local queue');
    releaseBoth.resolve();
    await Promise.all([first, second]);
    assert.equal((await readTaskState(firstPath)).counter, 1);
    assert.equal((await readTaskState(secondPath)).counter, 1);
  } finally {
    releaseBoth.resolve();
    await Promise.allSettled([first, second].filter(Boolean));
    await rm(directory, { recursive: true, force: true });
  }
});

test('rejects an unrelated SQLite schema without modifying the database', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agnets-workflow-foreign-sqlite-'));
  const databasePath = path.join(directory, 'foreign.sqlite');
  const database = new DatabaseSync(databasePath);
  try {
    database.exec('CREATE TABLE application_data (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
    database.prepare('INSERT INTO application_data (value) VALUES (?)').run('must remain untouched');
  } finally {
    database.close();
  }
  const original = await readFile(databasePath);
  try {
    await assert.rejects(() => taskStateExists(databasePath), /unknown schema/);
    assert.deepEqual(await readFile(databasePath), original);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('rejects a controller-shaped SQLite table without the single-row constraint', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agnets-workflow-weak-sqlite-'));
  const databasePath = path.join(directory, 'weak.sqlite');
  const database = new DatabaseSync(databasePath);
  try {
    database.exec('CREATE TABLE controller_state (id INTEGER PRIMARY KEY, version INTEGER NOT NULL, payload TEXT NOT NULL, updated_at TEXT NOT NULL)');
  } finally {
    database.close();
  }
  const original = await readFile(databasePath);
  try {
    await assert.rejects(() => taskStateExists(databasePath), /incompatible controller schema/);
    assert.deepEqual(await readFile(databasePath), original);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('rejects a transaction when the caller-verified parent directory identity changes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agnets-workflow-sqlite-parent-'));
  const stateDirectory = path.join(root, 'state');
  const displaced = path.join(root, 'state-displaced');
  const databasePath = path.join(stateDirectory, 'task.sqlite');
  try {
    await mkdir(stateDirectory);
    const authority = await parentAuthority(databasePath);
    await rename(stateDirectory, displaced);
    await mkdir(stateDirectory);
    await assert.rejects(
      () => withTaskStateTransaction(databasePath, { parentAuthority: authority }, async (_current, save) => { save(state('parent-test')); }),
      /parent changed/,
    );
    assert.equal(await pathExists(databasePath), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('does not replace a foreign database while validating a task transaction parent authority', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agnets-workflow-sqlite-authority-'));
  const databasePath = path.join(directory, 'task.sqlite');
  try {
    await writeFile(databasePath, 'peer database');
    const authority = await parentAuthority(databasePath);
    await assert.rejects(
      () => withTaskStateTransaction(databasePath, { parentAuthority: authority }, async (_current, save) => { save(state('authority-test')); }),
      /file is not a database/,
    );
    assert.equal(await readFile(databasePath, 'utf8'), 'peer database');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
