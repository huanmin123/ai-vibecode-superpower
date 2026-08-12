import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir, rename, lstat, realpath } from 'node:fs/promises';
import { promises as fsPromises } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { deleteTaskState, readTaskState, taskStateExists, writeTaskState } from '../scripts/sqlite_task_store.mjs';

const require = createRequire(import.meta.url);
const initSqlJs = require('../vendor/sqljs/sql-wasm.js');

async function parentAuthority(filePath) {
  const directory = path.dirname(filePath); const metadata = await lstat(directory, { bigint: true });
  return { path: directory, realPath: await realpath(directory), identity: { dev: metadata.dev.toString(), ino: metadata.ino.toString() } };
}

test('bundled SQLite/WASM persists and releases a task database without native handles', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agnets-workflow-sqlite-'));
  const databasePath = path.join(directory, 'task.sqlite');
  const state = { version: 1, task_id: 'sqlite-test', updated_at: '2026-08-04T00:00:00.000Z', nodes: {} };
  try {
    assert.equal(await taskStateExists(databasePath), false);
    await writeTaskState(databasePath, state, { parentAuthority: await parentAuthority(databasePath) });
    assert.equal(await taskStateExists(databasePath), true);
    assert.deepEqual(await readTaskState(databasePath), state);
    const bytes = await readFile(databasePath);
    assert.deepEqual(bytes.subarray(0, 16), Buffer.from('SQLite format 3\u0000'));
    await deleteTaskState(databasePath, { parentAuthority: await parentAuthority(databasePath) });
    assert.equal(await taskStateExists(databasePath), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('rejects an unrelated SQLite schema without modifying the database', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agnets-workflow-foreign-sqlite-'));
  const databasePath = path.join(directory, 'foreign.sqlite');
  const SQL = await initSqlJs({ locateFile: name => path.join(path.dirname(fileURLToPath(new URL('../vendor/sqljs/sql-wasm.wasm', import.meta.url))), name) });
  const database = new SQL.Database();
  database.run('CREATE TABLE application_data (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
  database.run("INSERT INTO application_data (value) VALUES ('must remain untouched')");
  const original = Buffer.from(database.export());
  database.close();
  await writeFile(databasePath, original);
  try {
    await (assert.rejects(() => taskStateExists(databasePath), /unknown schema/));
    assert.deepEqual(await readFile(databasePath), original);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('rejects a controller-shaped SQLite table without the single-row constraint', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agnets-workflow-weak-sqlite-'));
  const databasePath = path.join(directory, 'weak.sqlite');
  const SQL = await initSqlJs({ locateFile: name => path.join(path.dirname(fileURLToPath(new URL('../vendor/sqljs/sql-wasm.wasm', import.meta.url))), name) });
  const database = new SQL.Database();
  database.run('CREATE TABLE controller_state (id INTEGER PRIMARY KEY, version INTEGER NOT NULL, payload TEXT NOT NULL, updated_at TEXT NOT NULL)');
  const original = Buffer.from(database.export());
  database.close();
  await writeFile(databasePath, original);
  try {
    await assert.rejects(() => taskStateExists(databasePath), /incompatible controller schema/);
    assert.deepEqual(await readFile(databasePath), original);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('does not write a replacement parent tree when SQLite publication loses its directory identity', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agnets-workflow-sqlite-peer-'));
  const stateDirectory = path.join(root, 'state'); const displaced = path.join(root, 'state-displaced'); const databasePath = path.join(stateDirectory, 'task.sqlite');
  const originalRename = fsPromises.rename;
  try {
    await mkdir(stateDirectory); await writeFile(databasePath, 'peer database');
    fsPromises.rename = async (source, destination) => {
      if (path.resolve(destination) === path.resolve(databasePath) && source.endsWith('.tmp')) {
        await rename(stateDirectory, displaced); await mkdir(stateDirectory); await writeFile(databasePath, 'peer database');
      }
      return originalRename(source, destination);
    };
    const authority = await parentAuthority(databasePath);
    await assert.rejects(() => writeTaskState(databasePath, { version: 1, task_id: 'peer', updated_at: '2026-08-04T00:00:00.000Z', nodes: {} }, { parentAuthority: authority }));
    assert.equal(await readFile(databasePath, 'utf8'), 'peer database');
  } finally {
    fsPromises.rename = originalRename;
    await rm(root, { recursive: true, force: true });
  }
});
