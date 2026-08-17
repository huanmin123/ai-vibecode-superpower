import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { promises as fs } from 'node:fs';
import path from 'node:path';

let DatabaseSync;
try {
  ({ DatabaseSync } = createRequire(import.meta.url)('node:sqlite'));
} catch (cause) {
  throw new Error(`Global workflow store requires Node node:sqlite (Node 22.5 or newer): ${cause.message}`, { cause });
}

const BUSY_TIMEOUT_MS = 30_000;
const MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;
const APPLICATION_ID = 0x41475746; // "AGWF"
const USER_VERSION = 1;
const PUBLISH_WAIT_MS = 5_000;
const transactionContext = new AsyncLocalStorage();
let writerTail = Promise.resolve();

function storeError(message, cause) {
  return new Error(message, cause ? { cause } : undefined);
}

function isBusy(cause) {
  return /(?:SQLITE_BUSY|database is locked|database is busy)/i.test(String(cause?.message ?? cause));
}

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function pathKey(value) {
  const resolved = path.resolve(value).normalize('NFC');
  return process.platform === 'win32' ? resolved.toLocaleLowerCase('und') : resolved;
}

function defaultCodexHome() {
  const configured = process.env.CODEX_HOME?.trim();
  if (configured) {
    if (!path.isAbsolute(configured)) throw storeError('CODEX_HOME must be an absolute path');
    return path.resolve(configured);
  }
  const home = process.platform === 'win32'
    ? process.env.USERPROFILE
    : process.env.HOME;
  if (typeof home !== 'string' || !home.trim()) throw storeError('Cannot determine the user Codex home; set CODEX_HOME or the platform home environment variable');
  return path.join(home, '.codex');
}

export function globalWorkflowStorePath() {
  return path.join(defaultCodexHome(), 'state', 'agnets-workflow', 'workflow.sqlite');
}

export function taskNamespaceKey(logicalStatePath) {
  return pathKey(path.dirname(logicalStatePath));
}

export function taskStoreKey(logicalStatePath) {
  return `${taskNamespaceKey(logicalStatePath)}\u0000${path.basename(logicalStatePath, '.sqlite')}`;
}

function workspaceKeyFromControlPath(databasePath) {
  return pathKey(path.dirname(path.dirname(path.dirname(databasePath))));
}

function payload(value, label) {
  let serialized;
  try { serialized = JSON.stringify(value); }
  catch (cause) { throw storeError(`${label} is not valid JSON: ${cause.message}`, cause); }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_PAYLOAD_BYTES) throw storeError(`${label} exceeds the ${MAX_PAYLOAD_BYTES}-byte limit`);
  return serialized;
}

function parsePayload(value, label) {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > MAX_PAYLOAD_BYTES) throw storeError(`${label} is invalid or exceeds the ${MAX_PAYLOAD_BYTES}-byte limit`);
  try { return JSON.parse(value); }
  catch (cause) { throw storeError(`${label} contains invalid JSON: ${cause.message}`, cause); }
}

async function ensureParent(databasePath) {
  const parent = path.dirname(databasePath);
  await fs.mkdir(parent, { recursive: true });
  const metadata = await fs.lstat(parent);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw storeError(`Global workflow store parent is not a regular directory: ${parent}`);
}

function objectIdentity(metadata) { return { dev: metadata.dev.toString(), ino: metadata.ino.toString() }; }
function sameIdentity(left, right) { return left?.dev === right?.dev && left?.ino === right?.ino; }

async function databaseFileBeforeOpen(databasePath) {
  try {
    const metadata = await fs.lstat(databasePath, { bigint: true });
    if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size === 0n) throw storeError(`Global workflow store is not a non-empty regular SQLite file: ${databasePath}`);
    return { exists: true, identity: objectIdentity(metadata) };
  } catch (cause) {
    if (cause?.code === 'ENOENT') return { exists: false, identity: null };
    throw cause;
  }
}

async function verifyDatabaseIdentity(databasePath, expected) {
  const metadata = await fs.lstat(databasePath, { bigint: true });
  if (metadata.isSymbolicLink() || !metadata.isFile() || (expected && !sameIdentity(expected, objectIdentity(metadata)))) {
    throw storeError(`Global workflow store identity changed: ${databasePath}`);
  }
  return objectIdentity(metadata);
}

async function removeBootstrapFiles(bootstrapPath) {
  for (const candidate of [bootstrapPath, `${bootstrapPath}-wal`, `${bootstrapPath}-shm`, `${bootstrapPath}-journal`]) {
    try { await fs.unlink(candidate); }
    catch (cause) { if (cause?.code !== 'ENOENT') throw cause; }
  }
}

function configureNew(database) {
  // journal_mode is persistent. A peer may briefly hold the exclusive mode
  // switch while opening the same store; it is already safe to continue when
  // that switch reports busy because the existing store has been initialized.
  try { database.exec('PRAGMA journal_mode = WAL;'); }
  catch (cause) { if (!/(?:SQLITE_BUSY|database is locked|database is busy)/i.test(String(cause?.message ?? cause))) throw cause; }
  database.exec(`PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}; PRAGMA application_id = ${APPLICATION_ID}; PRAGMA user_version = ${USER_VERSION};`);
  database.exec(`
    CREATE TABLE IF NOT EXISTS store_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS workspace_control (
      workspace_key TEXT PRIMARY KEY,
      workspace TEXT NOT NULL,
      payload TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      change_counter INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS task_state (
      namespace_key TEXT NOT NULL,
      task_id TEXT NOT NULL,
      payload TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (namespace_key, task_id)
    );
  `);
  database.prepare("INSERT INTO store_meta (key, value) VALUES ('schema_version', ?), ('store_id', lower(hex(randomblob(16))))").run(String(USER_VERSION));
  database.exec('PRAGMA wal_checkpoint(TRUNCATE);');
}

function requireColumns(database, table, expected) {
  const actual = database.prepare(`PRAGMA table_info(${table})`).all().map(column => [column.name, String(column.type).toUpperCase(), column.notnull, column.pk]);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw storeError(`Global workflow store has an incompatible ${table} schema`);
}

function verifySchema(database, databasePath) {
  const applicationId = Number(database.prepare('PRAGMA application_id').get()?.application_id);
  const userVersion = Number(database.prepare('PRAGMA user_version').get()?.user_version);
  if (applicationId !== APPLICATION_ID || userVersion !== USER_VERSION) throw storeError(`Global workflow store schema marker mismatch: ${databasePath}`);
  const objects = database.prepare("SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all();
  const expectedObjects = [{ type: 'table', name: 'store_meta' }, { type: 'table', name: 'task_state' }, { type: 'table', name: 'workspace_control' }];
  if (JSON.stringify(objects) !== JSON.stringify(expectedObjects)) throw storeError(`Global workflow store has unknown managed objects: ${databasePath}`);
  requireColumns(database, 'store_meta', [['key', 'TEXT', 0, 1], ['value', 'TEXT', 1, 0]]);
  requireColumns(database, 'workspace_control', [['workspace_key', 'TEXT', 0, 1], ['workspace', 'TEXT', 1, 0], ['payload', 'TEXT', 1, 0], ['updated_at', 'TEXT', 1, 0], ['change_counter', 'INTEGER', 1, 0]]);
  requireColumns(database, 'task_state', [['namespace_key', 'TEXT', 1, 1], ['task_id', 'TEXT', 1, 2], ['payload', 'TEXT', 1, 0], ['updated_at', 'TEXT', 1, 0]]);
  const meta = database.prepare("SELECT key, value FROM store_meta ORDER BY key").all();
  if (meta.length !== 2 || meta[0]?.key !== 'schema_version' || meta[0]?.value !== String(USER_VERSION) || meta[1]?.key !== 'store_id' || !/^[a-f0-9]{32}$/.test(meta[1]?.value ?? '')) throw storeError(`Global workflow store metadata is invalid: ${databasePath}`);
}

async function waitForPublishedDatabase(databasePath) {
  const deadline = Date.now() + PUBLISH_WAIT_MS;
  for (;;) {
    try {
      const metadata = await fs.lstat(databasePath, { bigint: true });
      if (metadata.isSymbolicLink() || !metadata.isFile()) throw storeError(`Global workflow store is not a regular SQLite file: ${databasePath}`);
      if (metadata.size > 0n) return objectIdentity(metadata);
    } catch (cause) {
      if (cause?.code !== 'ENOENT') throw cause;
    }
    if (Date.now() >= deadline) throw storeError(`Global workflow store publication did not produce a non-empty file: ${databasePath}`);
    await delay(20);
  }
}

async function verifyExistingDatabase(databasePath, identity) {
  let database;
  try {
    database = new DatabaseSync(databasePath, { readOnly: true });
    await verifyDatabaseIdentity(databasePath, identity);
    verifySchema(database, databasePath);
  } finally {
    database?.close();
  }
}

async function publishNewDatabase(databasePath) {
  const bootstrapPath = path.join(path.dirname(databasePath), `.${path.basename(databasePath)}.${randomUUID()}.bootstrap`);
  let database;
  try {
    database = new DatabaseSync(bootstrapPath);
    configureNew(database);
    verifySchema(database, bootstrapPath);
    database.close();
    database = null;
    const bootstrapIdentity = await verifyDatabaseIdentity(bootstrapPath, null);
    try {
      // link() creates the final pathname only when it does not already exist.
      // The published file is already fully initialized and checkpointed.
      await fs.link(bootstrapPath, databasePath);
      const publishedIdentity = await verifyDatabaseIdentity(databasePath, bootstrapIdentity);
      return { created: true, identity: publishedIdentity };
    } catch (cause) {
      if (cause?.code !== 'EEXIST') throw cause;
      return { created: false, identity: await waitForPublishedDatabase(databasePath) };
    }
  } finally {
    database?.close();
    await removeBootstrapFiles(bootstrapPath);
  }
}

async function openWritable() {
  const databasePath = globalWorkflowStorePath();
  await ensureParent(databasePath);
  const before = await databaseFileBeforeOpen(databasePath);
  const published = before.exists
    ? { created: false, identity: before.identity }
    : await publishNewDatabase(databasePath);
  let database;
  try {
    if (!published.created) await verifyExistingDatabase(databasePath, published.identity);
    database = new DatabaseSync(databasePath);
    await verifyDatabaseIdentity(databasePath, published.identity);
    verifySchema(database, databasePath);
    database.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}; PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL;`);
    await verifyDatabaseIdentity(databasePath, published.identity);
    return database;
  } catch (cause) {
    database?.close();
    throw storeError(`Cannot open global workflow store: ${databasePath}: ${cause.message}`, cause);
  }
}

async function withWriter(callback) {
  const active = transactionContext.getStore();
  if (active) return callback(active.database);
  let release;
  const predecessor = writerTail;
  const gate = new Promise(resolve => { release = resolve; });
  writerTail = predecessor.then(() => gate);
  await predecessor;
  const deadline = Date.now() + BUSY_TIMEOUT_MS;
  let backoff = 25;
  try {
    for (;;) {
      let database;
      let inTransaction = false;
      try {
        database = await openWritable();
        database.exec('BEGIN IMMEDIATE');
        inTransaction = true;
        const result = await transactionContext.run({ database }, () => callback(database));
        database.exec('COMMIT');
        inTransaction = false;
        return result;
      } catch (cause) {
        if (inTransaction) {
          try { database.exec('ROLLBACK'); } catch {}
        }
        if (!isBusy(cause) || Date.now() >= deadline) throw cause;
        await delay(backoff);
        backoff = Math.min(500, Math.ceil(backoff * 1.6));
      } finally {
        database?.close();
      }
    }
  } finally {
    release();
  }
}

async function withReadOnly(callback) {
  const active = transactionContext.getStore();
  if (active) return callback(active.database);
  const databasePath = globalWorkflowStorePath();
  const before = await databaseFileBeforeOpen(databasePath);
  if (!before.exists) return callback(null);
  let database;
  try {
    database = new DatabaseSync(databasePath, { readOnly: true });
    database.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}; PRAGMA foreign_keys = ON;`);
    await verifyDatabaseIdentity(databasePath, before.identity);
    verifySchema(database, databasePath);
    return callback(database);
  } catch (cause) {
    throw storeError(`Cannot read global workflow store: ${databasePath}: ${cause.message}`, cause);
  } finally {
    database?.close();
  }
}

function taskIdentity(databasePath) {
  const statePath = path.resolve(databasePath);
  const taskId = path.basename(statePath, '.sqlite');
  if (!taskId || taskId === path.basename(statePath)) throw storeError(`Task state path must end in .sqlite: ${databasePath}`);
  return { namespaceKey: taskNamespaceKey(statePath), taskId };
}

export async function withGlobalTaskStateTransaction(databasePath, _options, callback) {
  const identity = taskIdentity(databasePath);
  return withWriter(async database => {
    const row = database.prepare('SELECT payload FROM task_state WHERE namespace_key = ? AND task_id = ?').get(identity.namespaceKey, identity.taskId);
    const current = row ? parsePayload(row.payload, `Global task state ${taskStoreKey(databasePath)}`) : null;
    let saved = false;
    const save = state => {
      if (saved) throw storeError('Global task state transaction save(state) may only be called once');
      const serialized = payload(state, `Global task state ${taskStoreKey(databasePath)}`);
      const updatedAt = typeof state?.updated_at === 'string' ? state.updated_at : new Date().toISOString();
      database.prepare('INSERT INTO task_state (namespace_key, task_id, payload, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(namespace_key, task_id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at').run(identity.namespaceKey, identity.taskId, serialized, updatedAt);
      saved = true;
    };
    const result = await callback(current, save);
    if (!saved) throw storeError('Global task state transaction callback must call save(state) before commit');
    return result;
  });
}

export async function globalTaskStateExists(databasePath) {
  const identity = taskIdentity(databasePath);
  return withReadOnly(database => Boolean(database?.prepare('SELECT 1 AS present FROM task_state WHERE namespace_key = ? AND task_id = ?').get(identity.namespaceKey, identity.taskId)?.present));
}

export async function readGlobalTaskState(databasePath) {
  const identity = taskIdentity(databasePath);
  return withReadOnly(database => {
    if (!database) return null;
    const row = database.prepare('SELECT payload FROM task_state WHERE namespace_key = ? AND task_id = ?').get(identity.namespaceKey, identity.taskId);
    return row ? parsePayload(row.payload, `Global task state ${taskStoreKey(databasePath)}`) : null;
  });
}

export async function writeGlobalTaskState(databasePath, state, options = {}) {
  return withGlobalTaskStateTransaction(databasePath, options, async (_current, save) => { save(state); });
}

export async function deleteGlobalTaskState(databasePath) {
  const identity = taskIdentity(databasePath);
  return withWriter(database => database.prepare('DELETE FROM task_state WHERE namespace_key = ? AND task_id = ?').run(identity.namespaceKey, identity.taskId));
}

export async function listGlobalTaskStatesForNamespace(logicalStateDirectory) {
  const namespaceKey = pathKey(logicalStateDirectory);
  return withReadOnly(database => {
    if (!database) return [];
    return database.prepare('SELECT task_id, payload, updated_at FROM task_state WHERE namespace_key = ? ORDER BY task_id').all(namespaceKey)
      .map(row => ({ task_id: row.task_id, state: parsePayload(row.payload, `Global task state ${namespaceKey}/${row.task_id}`), updated_at: row.updated_at }));
  });
}

// Holds the global BEGIN IMMEDIATE transaction while maintenance verifies and
// removes rows. Artifact cleanup is deliberately awaited inside this callback;
// a failure leaves the SQL row untouched and concurrent init/prune calls queue.
export async function withGlobalWorkflowStoreMaintenance(logicalStateDirectory, callback) {
  const namespaceKey = pathKey(logicalStateDirectory);
  return withWriter(async database => {
    const rows = database.prepare('SELECT task_id, payload, updated_at FROM task_state WHERE namespace_key = ? ORDER BY task_id').all(namespaceKey)
      .map(row => {
        try {
          return { task_id: row.task_id, state: parsePayload(row.payload, `Global task state ${namespaceKey}/${row.task_id}`), updated_at: row.updated_at, parse_error: null };
        } catch (error) {
          // A corrupt row is retained and reported by the controller. Do not
          // let one row prevent eligible siblings from being pruned.
          return { task_id: row.task_id, state: null, updated_at: row.updated_at, parse_error: error };
        }
      });
    const maintenance = {
      rows,
      deleteTask(taskId) {
        if (typeof taskId !== 'string' || !taskId) throw storeError('Maintenance task_id must be a non-empty string');
        return database.prepare('DELETE FROM task_state WHERE namespace_key = ? AND task_id = ?').run(namespaceKey, taskId).changes;
      },
    };
    return callback(maintenance);
  });
}

export async function deleteGlobalTaskStatesForNamespace(logicalStateDirectory, taskIds) {
  if (!Array.isArray(taskIds) || !taskIds.length) return 0;
  const namespaceKey = pathKey(logicalStateDirectory);
  return withWriter(database => {
    const statement = database.prepare('DELETE FROM task_state WHERE namespace_key = ? AND task_id = ?');
    let deleted = 0;
    for (const taskId of taskIds) deleted += statement.run(namespaceKey, taskId).changes;
    return deleted;
  });
}

export async function globalWorkspaceControlExists(databasePath) {
  const active = transactionContext.getStore();
  const key = workspaceKeyFromControlPath(databasePath);
  if (active) return Boolean(active.database.prepare('SELECT 1 AS present FROM workspace_control WHERE workspace_key = ?').get(key)?.present);
  return withReadOnly(database => Boolean(database?.prepare('SELECT 1 AS present FROM workspace_control WHERE workspace_key = ?').get(key)?.present));
}

export async function createGlobalWorkspaceControl(databasePath, workspace, initialPayload = {}) {
  const key = workspaceKeyFromControlPath(databasePath);
  return withWriter(database => {
    if (database.prepare('SELECT 1 AS present FROM workspace_control WHERE workspace_key = ?').get(key)?.present) throw storeError(`Workspace control already exists: ${databasePath}`);
    database.prepare('INSERT INTO workspace_control (workspace_key, workspace, payload, updated_at, change_counter) VALUES (?, ?, ?, ?, 0)').run(key, workspace, payload(initialPayload, 'Global workspace control'), new Date().toISOString());
  });
}

export async function readGlobalWorkspaceControl(databasePath, workspace) {
  const key = workspaceKeyFromControlPath(databasePath);
  const active = transactionContext.getStore();
  const read = database => {
    const row = database.prepare('SELECT workspace, payload, updated_at, change_counter FROM workspace_control WHERE workspace_key = ?').get(key);
    if (!row) throw storeError(`Workspace control does not exist: ${databasePath}`);
    if (row.workspace !== workspace) throw storeError(`Workspace control workspace mismatch: ${databasePath}`);
    return { payload: parsePayload(row.payload, `Global workspace control ${workspace}`), updated_at: row.updated_at, change_counter: row.change_counter };
  };
  if (active) return read(active.database);
  return withReadOnly(database => {
    if (!database) throw storeError(`Workspace control does not exist: ${databasePath}`);
    return read(database);
  });
}

export async function withGlobalWorkspaceControlTransaction(databasePath, workspace, callback) {
  const key = workspaceKeyFromControlPath(databasePath);
  return withWriter(async database => {
    const row = database.prepare('SELECT workspace, payload, change_counter FROM workspace_control WHERE workspace_key = ?').get(key);
    if (!row) throw storeError(`Workspace control does not exist: ${databasePath}`);
    if (row.workspace !== workspace) throw storeError(`Workspace control workspace mismatch: ${databasePath}`);
    const current = parsePayload(row.payload, `Global workspace control ${workspace}`);
    let saved = false;
    const save = value => {
      if (saved) throw storeError('Global workspace control transaction save(payload) may only be called once');
      database.prepare('UPDATE workspace_control SET payload = ?, updated_at = ?, change_counter = ? WHERE workspace_key = ?').run(payload(value, `Global workspace control ${workspace}`), new Date().toISOString(), row.change_counter + 1, key);
      saved = true;
    };
    const result = await callback(current, save);
    if (!saved) throw storeError('Global workspace control transaction callback must call save(payload) before commit');
    return result;
  });
}

export const GLOBAL_WORKFLOW_STORE = Object.freeze({ BUSY_TIMEOUT_MS, MAX_PAYLOAD_BYTES, path: globalWorkflowStorePath });
