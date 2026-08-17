import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { existsSync, linkSync, lstatSync, realpathSync, unlinkSync } from 'node:fs';
import path from 'node:path';

let DatabaseSync;
try {
  ({ DatabaseSync } = createRequire(import.meta.url)('node:sqlite'));
} catch (cause) {
  throw new Error(`Workspace control store requires Node node:sqlite (Node 22.5 or newer): ${cause.message}`, { cause });
}

const SCHEMA_VERSION = 1;
const BUSY_TIMEOUT_MS = 30_000;
const MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;
const transactionQueues = new Map();

function error(message, cause) {
  return new Error(message, cause ? { cause } : undefined);
}

function checkPath(databasePath) {
  if (typeof databasePath !== 'string' || databasePath.length === 0) throw error('Workspace control database path must be a non-empty string');
  return databasePath;
}

function checkWorkspace(workspace) {
  if (typeof workspace !== 'string' || workspace.length === 0) throw error('Workspace control workspace must be a non-empty string');
  return workspace;
}

function objectIdentity(metadata) {
  return { dev: metadata.dev.toString(), ino: metadata.ino.toString() };
}

function sameIdentity(left, right) {
  return left?.dev === right?.dev && left?.ino === right?.ino;
}

function snapshotRegularPath(targetPath, label, expectedType) {
  let metadata;
  try { metadata = lstatSync(targetPath, { bigint: true }); }
  catch (cause) { throw error(`Cannot inspect ${label}: ${targetPath}: ${cause.message}`, cause); }
  if (metadata.isSymbolicLink() || (expectedType === 'file' ? !metadata.isFile() : !metadata.isDirectory())) {
    throw error(`${label} is not a regular ${expectedType}: ${targetPath}`);
  }
  let realPath;
  try { realPath = realpathSync.native(targetPath); }
  catch (cause) { throw error(`Cannot resolve ${label}: ${targetPath}: ${cause.message}`, cause); }
  return { path: path.resolve(targetPath), realPath, identity: objectIdentity(metadata) };
}

function sameSnapshot(left, right) {
  return left?.path === right?.path && left?.realPath === right?.realPath && sameIdentity(left?.identity, right?.identity);
}

function verifySnapshot(snapshot, label, expectedType) {
  const current = snapshotRegularPath(snapshot.path, label, expectedType);
  if (!sameSnapshot(snapshot, current)) throw error(`${label} changed: ${snapshot.path}`);
  return current;
}

async function withTransactionQueue(databasePath, callback) {
  const key = process.platform === 'win32' ? path.resolve(databasePath).toLocaleLowerCase('und') : path.resolve(databasePath);
  const prior = transactionQueues.get(key) ?? Promise.resolve();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const tail = prior.then(() => gate);
  transactionQueues.set(key, tail);
  await prior;
  try { return await callback(); }
  finally {
    release();
    if (transactionQueues.get(key) === tail) transactionQueues.delete(key);
  }
}

function encodePayload(value) {
  let payload;
  try { payload = JSON.stringify(value); } catch (cause) { throw error(`Workspace control payload is not valid JSON: ${cause.message}`, cause); }
  if (typeof payload !== 'string' || Buffer.byteLength(payload, 'utf8') > MAX_PAYLOAD_BYTES) {
    throw error(`Workspace control payload exceeds the ${MAX_PAYLOAD_BYTES}-byte limit`);
  }
  return payload;
}

function decodePayload(payload, databasePath) {
  if (typeof payload !== 'string' || Buffer.byteLength(payload, 'utf8') > MAX_PAYLOAD_BYTES) throw error(`Workspace control payload is invalid or exceeds the ${MAX_PAYLOAD_BYTES}-byte limit: ${databasePath}`);
  try { return JSON.parse(payload); } catch (cause) { throw error(`Workspace control payload contains invalid JSON: ${databasePath}: ${cause.message}`, cause); }
}

function validateSchema(database, databasePath) {
  const objects = database.prepare("SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all();
  if (objects.length !== 1 || objects[0].type !== 'table' || objects[0].name !== 'control') throw error(`Workspace control database has an unknown schema and was not modified: ${databasePath}`);
  const columns = database.prepare('PRAGMA table_info(control)').all();
  const expectedColumns = [
    ['id', 'INTEGER', 0, 1],
    ['schema_version', 'INTEGER', 1, 0],
    ['workspace', 'TEXT', 1, 0],
    ['payload', 'TEXT', 1, 0],
    ['updated_at', 'TEXT', 1, 0],
    ['change_counter', 'INTEGER', 1, 0],
  ];
  if (columns.length !== expectedColumns.length || columns.some((column, index) => column.name !== expectedColumns[index][0] || String(column.type).toUpperCase() !== expectedColumns[index][1] || column.notnull !== expectedColumns[index][2] || column.pk !== expectedColumns[index][3])) throw error(`Workspace control database has an incompatible schema and was not modified: ${databasePath}`);
  const sqlRow = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'control'").get();
  const sql = typeof sqlRow?.sql === 'string' ? sqlRow.sql.replace(/\s+/g, ' ').toLowerCase() : '';
  if (!/primary key\b.*check\s*\(\s*id\s*=\s*1\s*\)/i.test(sql)) throw error(`Workspace control database has an incompatible schema and was not modified: ${databasePath}`);
  const row = database.prepare('SELECT id, schema_version, workspace, payload, updated_at, change_counter FROM control WHERE id = 1').get();
  if (!row || row.id !== 1 || row.schema_version !== SCHEMA_VERSION || typeof row.workspace !== 'string' || typeof row.updated_at !== 'string' || !Number.isSafeInteger(row.change_counter) || row.change_counter < 0) throw error(`Workspace control database has an incompatible schema and was not modified: ${databasePath}`);
  decodePayload(row.payload, databasePath);
  return row;
}

function openExisting(databasePath, workspace) {
  checkPath(databasePath); checkWorkspace(workspace);
  if (!existsSync(databasePath)) throw error(`Workspace control database does not exist: ${databasePath}`);
  const parentSnapshot = snapshotRegularPath(path.dirname(databasePath), 'Workspace control database parent', 'directory');
  const databaseSnapshot = snapshotRegularPath(databasePath, 'Workspace control database', 'file');
  let database;
  try {
    database = new DatabaseSync(databasePath, { timeout: BUSY_TIMEOUT_MS });
    database.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    verifySnapshot(parentSnapshot, 'Workspace control database parent', 'directory');
    verifySnapshot(databaseSnapshot, 'Workspace control database', 'file');
    const row = validateSchema(database, databasePath);
    if (row.workspace !== workspace) throw error(`Workspace control workspace mismatch: expected ${workspace}, found ${row.workspace}`);
    return { database, row, parentSnapshot, databaseSnapshot };
  } catch (cause) {
    database?.close();
    if (cause?.message?.startsWith('Workspace control')) throw cause;
    throw error(`Cannot open workspace control database: ${databasePath}: ${cause.message}`, cause);
  }
}

function toControl(row, databasePath) {
  return {
    workspace: row.workspace,
    payload: decodePayload(row.payload, databasePath),
    updated_at: row.updated_at,
    change_counter: row.change_counter,
  };
}

/** The sole database creation entry point. */
export function createWorkspaceControl(databasePath, workspace, initialPayload = {}) {
  checkPath(databasePath); checkWorkspace(workspace);
  if (existsSync(databasePath)) throw error(`Workspace control database already exists: ${databasePath}`);
  const parentSnapshot = snapshotRegularPath(path.dirname(databasePath), 'Workspace control database parent', 'directory');
  const temporaryPath = `${databasePath}.bootstrap-${randomUUID()}.tmp`;
  let database;
  try {
    const payload = encodePayload(initialPayload);
    database = new DatabaseSync(temporaryPath, { timeout: BUSY_TIMEOUT_MS });
    database.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}; BEGIN IMMEDIATE; CREATE TABLE control (id INTEGER PRIMARY KEY CHECK (id = 1), schema_version INTEGER NOT NULL, workspace TEXT NOT NULL, payload TEXT NOT NULL, updated_at TEXT NOT NULL, change_counter INTEGER NOT NULL CHECK (change_counter >= 0));`);
    const now = new Date().toISOString();
    database.prepare('INSERT INTO control (id, schema_version, workspace, payload, updated_at, change_counter) VALUES (1, ?, ?, ?, ?, 0)').run(SCHEMA_VERSION, workspace, payload, now);
    database.exec('COMMIT');
    database.close();
    database = null;
    verifySnapshot(parentSnapshot, 'Workspace control database parent', 'directory');
    snapshotRegularPath(temporaryPath, 'Workspace control bootstrap database', 'file');
    linkSync(temporaryPath, databasePath);
    verifySnapshot(parentSnapshot, 'Workspace control database parent', 'directory');
    snapshotRegularPath(databasePath, 'Workspace control database', 'file');
    unlinkSync(temporaryPath);
  } catch (cause) {
    try { if (existsSync(temporaryPath)) unlinkSync(temporaryPath); } catch {}
    throw cause?.message?.startsWith('Workspace control') ? cause : error(`Cannot create workspace control database: ${databasePath}: ${cause.message}`, cause);
  } finally { database?.close(); }
  return readWorkspaceControl(databasePath, workspace);
}

export function workspaceControlExists(databasePath) {
  checkPath(databasePath);
  if (!existsSync(databasePath)) return false;
  const parentSnapshot = snapshotRegularPath(path.dirname(databasePath), 'Workspace control database parent', 'directory');
  const databaseSnapshot = snapshotRegularPath(databasePath, 'Workspace control database', 'file');
  let database;
  try {
    database = new DatabaseSync(databasePath, { timeout: BUSY_TIMEOUT_MS });
    verifySnapshot(parentSnapshot, 'Workspace control database parent', 'directory');
    verifySnapshot(databaseSnapshot, 'Workspace control database', 'file');
    validateSchema(database, databasePath);
    return true;
  } catch (cause) {
    if (cause?.message?.startsWith('Workspace control')) throw cause;
    throw error(`Cannot inspect workspace control database: ${databasePath}: ${cause.message}`, cause);
  } finally { database?.close(); }
}

export function readWorkspaceControl(databasePath, workspace) {
  const opened = openExisting(databasePath, workspace);
  try { return toControl(opened.row, databasePath); } finally { opened.database.close(); }
}

export async function withWorkspaceControlTransaction(databasePath, workspace, callback) {
  if (typeof callback !== 'function') throw error('Workspace control transaction callback must be a function');
  return withTransactionQueue(databasePath, async () => {
    const opened = openExisting(databasePath, workspace);
    const database = opened.database;
    let inTransaction = false;
    let saved = false;
    try {
      verifySnapshot(opened.parentSnapshot, 'Workspace control database parent', 'directory');
      verifySnapshot(opened.databaseSnapshot, 'Workspace control database', 'file');
      try { database.exec('BEGIN IMMEDIATE'); inTransaction = true; } catch (cause) { throw error(`Workspace control transaction busy timeout exceeded: ${databasePath}: ${cause.message}`, cause); }
      verifySnapshot(opened.parentSnapshot, 'Workspace control database parent', 'directory');
      verifySnapshot(opened.databaseSnapshot, 'Workspace control database', 'file');
      const current = toControl(validateSchema(database, databasePath), databasePath);
      const save = value => {
        if (saved) throw error('Workspace control transaction save(value) may only be called once');
        const payload = encodePayload(value);
        const now = new Date().toISOString();
        database.prepare('UPDATE control SET payload = ?, updated_at = ?, change_counter = change_counter + 1 WHERE id = 1').run(payload, now);
        saved = true;
      };
      await callback(current.payload, save, current);
      if (!saved) throw error('Workspace control transaction callback must call save(value) before commit');
      verifySnapshot(opened.parentSnapshot, 'Workspace control database parent', 'directory');
      verifySnapshot(opened.databaseSnapshot, 'Workspace control database', 'file');
      database.exec('COMMIT'); inTransaction = false;
      verifySnapshot(opened.parentSnapshot, 'Workspace control database parent', 'directory');
      verifySnapshot(opened.databaseSnapshot, 'Workspace control database', 'file');
      return readWorkspaceControl(databasePath, workspace);
    } catch (cause) {
      if (inTransaction) { try { database.exec('ROLLBACK'); } catch (rollbackCause) { cause.rollbackCause = rollbackCause; } }
      throw cause;
    } finally { database.close(); }
  });
}

export const WORKSPACE_CONTROL_SCHEMA_VERSION = SCHEMA_VERSION;
export const WORKSPACE_CONTROL_BUSY_TIMEOUT_MS = BUSY_TIMEOUT_MS;
