import { createRequire } from 'node:module';
import { promises as fs } from 'node:fs';
import path from 'node:path';

let DatabaseSync;
try {
  ({ DatabaseSync } = createRequire(import.meta.url)('node:sqlite'));
} catch (cause) {
  throw new Error(`SQLite task state requires Node node:sqlite (Node 22.5 or newer): ${cause.message}`, { cause });
}

const MAX_DATABASE_BYTES = 64 * 1024 * 1024;
const MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;
const BUSY_TIMEOUT_MS = 10_000;
const CONTROLLER_TABLE = 'controller_state';
const CREATE_CONTROLLER_TABLE = `
  CREATE TABLE controller_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    version INTEGER NOT NULL,
    payload TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`;
const taskWriteQueues = new Map();

function error(message, cause) {
  return new Error(message, cause ? { cause } : undefined);
}

function normalizedDatabasePath(databasePath) {
  if (typeof databasePath !== 'string' || databasePath.length === 0) throw error('SQLite task state path must be a non-empty string');
  return path.resolve(databasePath);
}

function sameFilesystemPath(left, right) {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

async function taskWriteQueueKey(databasePath) {
  let directory = path.dirname(databasePath);
  try { directory = await fs.realpath(directory); }
  catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
  const key = path.join(directory, path.basename(databasePath));
  return process.platform === 'win32' ? key.toLowerCase() : key;
}

async function withTaskWriteQueue(databasePath, callback) {
  const key = await taskWriteQueueKey(databasePath);
  const previous = taskWriteQueues.get(key) ?? Promise.resolve();
  let release;
  const current = new Promise(resolve => { release = resolve; });
  const tail = previous.then(() => current);
  taskWriteQueues.set(key, tail);
  await previous;
  try {
    return await callback();
  } finally {
    release();
    if (taskWriteQueues.get(key) === tail) taskWriteQueues.delete(key);
  }
}

function objectIdentity(metadata) {
  return { dev: metadata.dev.toString(), ino: metadata.ino.toString() };
}

async function snapshotRegularDirectory(directory) {
  const metadata = await fs.lstat(directory, { bigint: true });
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw error(`SQLite task state parent is not a regular directory: ${directory}`);
  return { path: directory, realPath: await fs.realpath(directory), identity: objectIdentity(metadata) };
}

async function verifyRegularDirectory(snapshot) {
  const current = await snapshotRegularDirectory(snapshot.path);
  const expectedRealPath = snapshot.realPath ?? snapshot.real_path;
  if (current.realPath !== expectedRealPath || current.identity.dev !== snapshot.identity?.dev || current.identity.ino !== snapshot.identity?.ino) {
    throw error(`SQLite task state parent changed: ${snapshot.path}`);
  }
}

function requireParentAuthority(databasePath, parentAuthority, operation) {
  const realPath = parentAuthority?.realPath ?? parentAuthority?.real_path;
  const identity = parentAuthority?.identity;
  if (!parentAuthority || typeof parentAuthority.path !== 'string' || typeof realPath !== 'string' || !identity || typeof identity.dev !== 'string' || typeof identity.ino !== 'string' || !sameFilesystemPath(parentAuthority.path, path.dirname(databasePath))) {
    throw error(`${operation} requires a caller-verified parent authority: ${databasePath}`);
  }
  return parentAuthority;
}

async function inspectTaskDatabase(databasePath) {
  try {
    const metadata = await fs.lstat(databasePath, { bigint: true });
    if (metadata.isSymbolicLink() || !metadata.isFile()) throw error(`SQLite task state is not a regular file: ${databasePath}`);
    if (metadata.size > BigInt(MAX_DATABASE_BYTES)) throw error(`SQLite task state exceeds the ${MAX_DATABASE_BYTES}-byte limit: ${databasePath}`);
    return metadata;
  } catch (cause) {
    if (cause.code === 'ENOENT') return null;
    throw cause;
  }
}

async function verifyOwnedFile(filePath, identity, label) {
  const metadata = await fs.lstat(filePath, { bigint: true });
  const current = objectIdentity(metadata);
  if (metadata.isSymbolicLink() || !metadata.isFile() || current.dev !== identity.dev || current.ino !== identity.ino) {
    throw error(`${label} changed: ${filePath}`);
  }
}

async function openTaskDatabase(databasePath, { create = false, writable = false, timeout = 0 } = {}) {
  const before = await inspectTaskDatabase(databasePath);
  if (!before && !create) return null;
  if (before?.size === 0n && !create) return { database: null, identity: objectIdentity(before), blank: true };
  let database;
  try {
    database = new DatabaseSync(databasePath, { readOnly: !create && !writable });
    database.exec(`PRAGMA busy_timeout = ${timeout}`);
    const after = await inspectTaskDatabase(databasePath);
    if (!after) throw error(`SQLite task state disappeared while opening: ${databasePath}`);
    const identity = objectIdentity(after);
    if (before && (identity.dev !== objectIdentity(before).dev || identity.ino !== objectIdentity(before).ino)) {
      throw error(`SQLite task state changed while opening: ${databasePath}`);
    }
    return { database, identity, blank: false };
  } catch (cause) {
    database?.close();
    if (cause?.message?.startsWith('SQLite task state')) throw cause;
    throw error(`Cannot open SQLite task state: ${databasePath}: ${cause.message}`, cause);
  }
}

function validateControllerSchema(database, databasePath) {
  const entries = database.prepare("SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all();
  if (entries.length === 0) return false;
  if (entries.length !== 1 || entries[0].type !== 'table' || entries[0].name !== CONTROLLER_TABLE) {
    throw error(`SQLite task state has an unknown schema and was not modified: ${databasePath}`);
  }
  const columns = database.prepare(`PRAGMA table_info(${CONTROLLER_TABLE})`).all();
  const expected = [
    ['id', 'INTEGER', 0, null, 1],
    ['version', 'INTEGER', 1, null, 0],
    ['payload', 'TEXT', 1, null, 0],
    ['updated_at', 'TEXT', 1, null, 0],
  ];
  const tableSql = database.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`).get(CONTROLLER_TABLE)?.sql;
  const normalizedSql = typeof tableSql === 'string' ? tableSql.replace(/\s+/g, ' ').toLowerCase() : '';
  const hasSingleRowGuard = /primary key\s+check\s*\(\s*id\s*=\s*1\s*\)/i.test(normalizedSql);
  if (columns.length !== expected.length || columns.some((column, index) => column.name !== expected[index][0] || String(column.type).toUpperCase() !== expected[index][1] || column.notnull !== expected[index][2] || column.dflt_value !== expected[index][3] || column.pk !== expected[index][4]) || !hasSingleRowGuard) {
    throw error(`SQLite task state has an incompatible controller schema and was not modified: ${databasePath}`);
  }
  return true;
}

function ensureControllerSchema(database, databasePath) {
  if (!validateControllerSchema(database, databasePath)) database.exec(CREATE_CONTROLLER_TABLE);
}

function parsePayload(databasePath, row) {
  if (!row) return null;
  if (typeof row.payload !== 'string' || Buffer.byteLength(row.payload, 'utf8') > MAX_PAYLOAD_BYTES) {
    throw error(`SQLite task payload is invalid or exceeds the ${MAX_PAYLOAD_BYTES}-byte limit: ${databasePath}`);
  }
  try {
    return JSON.parse(row.payload);
  } catch (cause) {
    throw error(`SQLite task payload contains invalid JSON: ${databasePath}: ${cause.message}`, cause);
  }
}

function readTaskStateFromDatabase(database, databasePath) {
  return parsePayload(databasePath, database.prepare('SELECT payload FROM controller_state WHERE id = 1').get());
}

function encodeTaskState(databasePath, state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw error(`SQLite task state must be an object: ${databasePath}`);
  if (!Number.isSafeInteger(state.version)) throw error(`SQLite task state version must be an integer: ${databasePath}`);
  if (typeof state.updated_at !== 'string') throw error(`SQLite task state updated_at must be a string: ${databasePath}`);
  let payload;
  try { payload = JSON.stringify(state); }
  catch (cause) { throw error(`SQLite task payload is not valid JSON: ${databasePath}: ${cause.message}`, cause); }
  if (typeof payload !== 'string' || Buffer.byteLength(payload, 'utf8') > MAX_PAYLOAD_BYTES) {
    throw error(`SQLite task payload exceeds the ${MAX_PAYLOAD_BYTES}-byte limit: ${databasePath}`);
  }
  return payload;
}

function databaseBytes(database) {
  const pageCount = Number(database.prepare('PRAGMA page_count').get()?.page_count);
  const pageSize = Number(database.prepare('PRAGMA page_size').get()?.page_size);
  return pageCount * pageSize;
}

function isBusyError(cause) {
  return /(?:SQLITE_BUSY|database is locked|database is busy)/i.test(String(cause?.message ?? cause));
}

async function taskStateTransaction(databasePath, options, callback, operation) {
  if (typeof callback !== 'function') throw error('SQLite task state transaction callback must be a function');
  const { parentAuthority, create = false } = options ?? {};
  const authority = requireParentAuthority(databasePath, parentAuthority, operation);
  return withTaskWriteQueue(databasePath, async () => {
    await verifyRegularDirectory(authority);
    const opened = await openTaskDatabase(databasePath, { create, writable: true, timeout: BUSY_TIMEOUT_MS });
    if (!opened?.database) throw error(`SQLite task state does not exist: ${databasePath}`);
    const database = opened.database;
    let inTransaction = false;
    let saved = false;
    let callbackActive = true;
    try {
      try {
        database.exec('BEGIN IMMEDIATE');
        inTransaction = true;
      } catch (cause) {
        const message = isBusyError(cause)
          ? `SQLite task state transaction busy timeout exceeded: ${databasePath}: ${cause.message}`
          : `Cannot begin SQLite task state transaction: ${databasePath}: ${cause.message}`;
        throw error(message, cause);
      }
      await verifyRegularDirectory(authority);
      await verifyOwnedFile(databasePath, opened.identity, 'SQLite task state');
      ensureControllerSchema(database, databasePath);
      const current = readTaskStateFromDatabase(database, databasePath);
      const save = state => {
        if (!callbackActive) throw error('SQLite task state transaction save(state) cannot be called after the callback completes');
        if (saved) throw error('SQLite task state transaction save(state) may only be called once');
        const payload = encodeTaskState(databasePath, state);
        database.prepare('INSERT INTO controller_state (id, version, payload, updated_at) VALUES (1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET version = excluded.version, payload = excluded.payload, updated_at = excluded.updated_at').run(state.version, payload, state.updated_at);
        if (databaseBytes(database) > MAX_DATABASE_BYTES) throw error(`SQLite task state exceeds the ${MAX_DATABASE_BYTES}-byte limit: ${databasePath}`);
        saved = true;
      };
      let result;
      try { result = await callback(current, save); }
      finally { callbackActive = false; }
      if (!saved) throw error('SQLite task state transaction callback must call save(state) before commit');
      await verifyRegularDirectory(authority);
      await verifyOwnedFile(databasePath, opened.identity, 'SQLite task state');
      database.exec('COMMIT');
      inTransaction = false;
      await verifyRegularDirectory(authority);
      await verifyOwnedFile(databasePath, opened.identity, 'SQLite task state');
      return result;
    } catch (cause) {
      if (inTransaction) {
        try { database.exec('ROLLBACK'); }
        catch (rollbackCause) { if (cause && typeof cause === 'object') cause.rollbackCause = rollbackCause; }
      }
      throw cause;
    } finally {
      database.close();
    }
  });
}

export async function withTaskStateTransaction(databasePath, options, callback) {
  const resolved = normalizedDatabasePath(databasePath);
  return taskStateTransaction(resolved, { ...options, create: false }, callback, 'SQLite task state transaction');
}

export async function taskStateExists(databasePath) {
  const resolved = normalizedDatabasePath(databasePath);
  const opened = await openTaskDatabase(resolved);
  if (!opened?.database) return false;
  try {
    if (!validateControllerSchema(opened.database, resolved)) return false;
    return opened.database.prepare('SELECT 1 AS present FROM controller_state WHERE id = 1').get()?.present === 1;
  } finally {
    opened.database.close();
  }
}

export async function readTaskState(databasePath) {
  const resolved = normalizedDatabasePath(databasePath);
  const opened = await openTaskDatabase(resolved);
  if (!opened?.database) return null;
  try {
    if (!validateControllerSchema(opened.database, resolved)) return null;
    return readTaskStateFromDatabase(opened.database, resolved);
  } finally {
    opened.database.close();
  }
}

export async function writeTaskState(databasePath, state, options = {}) {
  const resolved = normalizedDatabasePath(databasePath);
  return taskStateTransaction(resolved, { ...options, create: true }, async (_current, save) => { save(state); }, 'SQLite task state');
}

export async function deleteTaskState(databasePath, options = {}) {
  const resolved = normalizedDatabasePath(databasePath);
  const { parentAuthority } = options ?? {};
  const authority = requireParentAuthority(resolved, parentAuthority, 'SQLite task state deletion');
  await withTaskWriteQueue(resolved, async () => {
    await verifyRegularDirectory(authority);
    const metadata = await inspectTaskDatabase(resolved);
    if (metadata) await fs.unlink(resolved);
    await verifyRegularDirectory(authority);
  });
}

export const SQLITE_LIMITS = Object.freeze({ MAX_DATABASE_BYTES, MAX_PAYLOAD_BYTES });
