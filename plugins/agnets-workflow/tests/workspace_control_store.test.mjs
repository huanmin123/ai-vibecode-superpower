import assert from 'node:assert/strict';
import { readFile, readdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import {
  createWorkspaceControl,
  readWorkspaceControl,
  withWorkspaceControlTransaction,
  workspaceControlExists,
} from '../scripts/workspace_control_store.mjs';

async function temporaryDatabase() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agnets-workflow-workspace-control-'));
  return { directory, databasePath: path.join(directory, 'workflow.sqlite') };
}

test('creates a native SQLite workspace control database and commits with a monotonic change counter', async () => {
  const { directory, databasePath } = await temporaryDatabase();
  try {
    const initial = createWorkspaceControl(databasePath, '/workspace/example');
    assert.equal(initial.workspace, '/workspace/example');
    assert.deepEqual(initial.payload, {});
    assert.equal(initial.change_counter, 0);
    assert.equal(workspaceControlExists(databasePath), true);
    const bytes = await readFile(databasePath);
    assert.deepEqual(bytes.subarray(0, 16), Buffer.from('SQLite format 3\u0000'));
    await withWorkspaceControlTransaction(databasePath, '/workspace/example', async (control, save) => {
      control.owner = 'agent-a';
      save(control);
    });
    const updated = readWorkspaceControl(databasePath, '/workspace/example');
    assert.deepEqual(updated.payload, { owner: 'agent-a' });
    assert.equal(updated.change_counter, 1);
    assert.deepEqual(await readdir(directory), ['workflow.sqlite']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('rolls back callback failures and requires save before commit', async () => {
  const { directory, databasePath } = await temporaryDatabase();
  try {
    createWorkspaceControl(databasePath, '/workspace/example');
    await assert.rejects(
      () => withWorkspaceControlTransaction(databasePath, '/workspace/example', (control, save) => {
        save({ changed: true });
        throw new Error('callback failed');
      }),
      /callback failed/,
    );
    assert.deepEqual(readWorkspaceControl(databasePath, '/workspace/example').payload, {});
    assert.equal(readWorkspaceControl(databasePath, '/workspace/example').change_counter, 0);
    await assert.rejects(
      () => withWorkspaceControlTransaction(databasePath, '/workspace/example', control => {
        control.changed = true;
      }),
      /must call save/,
    );
    assert.deepEqual(readWorkspaceControl(databasePath, '/workspace/example').payload, {});
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('serializes same-process async workspace transactions without blocking the active callback', async () => {
  const { directory, databasePath } = await temporaryDatabase();
  try {
    createWorkspaceControl(databasePath, '/workspace/example');
    let releaseFirst;
    const firstMayFinish = new Promise(resolve => { releaseFirst = resolve; });
    let firstEntered;
    const firstEnteredPromise = new Promise(resolve => { firstEntered = resolve; });
    const order = [];
    const first = withWorkspaceControlTransaction(databasePath, '/workspace/example', async (control, save) => {
      order.push('first-enter');
      firstEntered();
      await firstMayFinish;
      control.first = true;
      save(control);
      order.push('first-exit');
    });
    await firstEnteredPromise;
    const second = withWorkspaceControlTransaction(databasePath, '/workspace/example', async (control, save) => {
      order.push('second-enter');
      control.second = true;
      save(control);
    });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(order, ['first-enter']);
    releaseFirst();
    await Promise.all([first, second]);
    assert.deepEqual(order, ['first-enter', 'first-exit', 'second-enter']);
    assert.deepEqual(readWorkspaceControl(databasePath, '/workspace/example').payload, { first: true, second: true });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('fails closed for missing databases, wrong workspaces, and unknown schemas', async () => {
  const missing = await temporaryDatabase();
  try {
    assert.equal(workspaceControlExists(missing.databasePath), false);
    assert.throws(() => readWorkspaceControl(missing.databasePath, '/workspace/example'), /does not exist/);
  } finally {
    await rm(missing.directory, { recursive: true, force: true });
  }

  const foreign = await temporaryDatabase();
  try {
    const database = new DatabaseSync(foreign.databasePath);
    database.exec('CREATE TABLE foreign_data (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
    database.close();
    assert.throws(() => workspaceControlExists(foreign.databasePath), /unknown schema/);
    assert.throws(() => readWorkspaceControl(foreign.databasePath, '/workspace/example'), /unknown schema/);
  } finally {
    await rm(foreign.directory, { recursive: true, force: true });
  }

  const mismatch = await temporaryDatabase();
  try {
    createWorkspaceControl(mismatch.databasePath, '/workspace/example');
    assert.throws(() => readWorkspaceControl(mismatch.databasePath, '/workspace/other'), /workspace mismatch/);
    await assert.rejects(() => withWorkspaceControlTransaction(mismatch.databasePath, '/workspace/other', () => {}), /workspace mismatch/);
  } finally {
    await rm(mismatch.directory, { recursive: true, force: true });
  }
});
