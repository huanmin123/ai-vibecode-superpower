import { createRequire } from 'node:module';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const initSqlJs = require('../vendor/sqljs/sql-wasm.js');
const MAX_DATABASE_BYTES = 64 * 1024 * 1024;
const MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;
const VENDOR_DIRECTORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'vendor', 'sqljs');
const CONTROLLER_TABLE = 'controller_state';
let sqlPromise;

function error(message, cause) {
  const result = new Error(message);
  if (cause) result.cause = cause;
  return result;
}

async function sql() {
  sqlPromise ??= initSqlJs({ locateFile: name => path.join(VENDOR_DIRECTORY, name) });
  try {
    return await sqlPromise;
  } catch (cause) {
    throw error(`Cannot initialize bundled SQLite/WASM runtime: ${cause.message}`, cause);
  }
}

async function readDatabase(databasePath) {
  try {
    const metadata = await fs.stat(databasePath);
    if (!metadata.isFile()) throw error(`SQLite task state is not a regular file: ${databasePath}`);
    if (metadata.size > MAX_DATABASE_BYTES) throw error(`SQLite task state exceeds the ${MAX_DATABASE_BYTES}-byte limit: ${databasePath}`);
    return await fs.readFile(databasePath);
  } catch (cause) {
    if (cause.code === 'ENOENT') return null;
    throw cause;
  }
}

async function open(databasePath) {
  const SQL = await sql();
  const bytes = await readDatabase(databasePath);
  let database;
  try {
    database = bytes ? new SQL.Database(bytes) : new SQL.Database();
    if (bytes) validateControllerSchema(database, databasePath);
    database.run(`
      CREATE TABLE IF NOT EXISTS controller_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        version INTEGER NOT NULL,
        payload TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    return database;
  } catch (cause) {
    database?.close();
    throw error(`Cannot open SQLite task state: ${databasePath}: ${cause.message}`, cause);
  }
}

function validateControllerSchema(database, databasePath) {
  const objects = database.exec("SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name");
  const entries = objects[0]?.values ?? [];
  if (entries.length !== 1 || entries[0][0] !== 'table' || entries[0][1] !== CONTROLLER_TABLE) {
    throw error(`SQLite task state has an unknown schema and was not modified: ${databasePath}`);
  }
  const columns = database.exec(`PRAGMA table_info(${CONTROLLER_TABLE})`)[0]?.values ?? [];
  const expected = [
    ['id', 'INTEGER', 0, null, 1],
    ['version', 'INTEGER', 1, null, 0],
    ['payload', 'TEXT', 1, null, 0],
    ['updated_at', 'TEXT', 1, null, 0],
  ];
  const tableSql = database.exec(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = '${CONTROLLER_TABLE}'`)[0]?.values?.[0]?.[0];
  const normalizedSql = typeof tableSql === 'string' ? tableSql.replace(/\s+/g, ' ').toLowerCase() : '';
  const hasSingleRowGuard = /primary key\s+check\s*\(\s*id\s*=\s*1\s*\)/i.test(normalizedSql);
  if (columns.length !== expected.length || columns.some((column, index) => column[1] !== expected[index][0] || column[2] !== expected[index][1] || column[3] !== expected[index][2] || column[4] !== expected[index][3] || column[5] !== expected[index][4]) || !hasSingleRowGuard) {
    throw error(`SQLite task state has an incompatible controller schema and was not modified: ${databasePath}`);
  }
}

async function atomicWriteBinary(filePath, bytes) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await fs.open(temporary, 'wx');
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close(); handle = null;
    await fs.rename(temporary, filePath);
    handle = await fs.open(filePath, 'r+');
    await handle.sync();
    if (process.platform !== 'win32') {
      const directoryHandle = await fs.open(path.dirname(filePath), 'r');
      try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
    }
  } catch (cause) {
    await handle?.close(); handle = null;
    await fs.unlink(temporary).catch(cleanupError => {
      if (cleanupError.code !== 'ENOENT') throw cleanupError;
    });
    throw cause;
  } finally {
    await handle?.close();
  }
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

export async function taskStateExists(databasePath) {
  const database = await open(databasePath);
  try {
    return database.exec('SELECT 1 FROM controller_state WHERE id = 1').length > 0;
  } finally {
    database.close();
  }
}

export async function readTaskState(databasePath) {
  const database = await open(databasePath);
  try {
    const statement = database.prepare('SELECT payload FROM controller_state WHERE id = 1');
    try {
      if (!statement.step()) return null;
      return parsePayload(databasePath, statement.getAsObject());
    } finally {
      statement.free();
    }
  } finally {
    database.close();
  }
}

export async function writeTaskState(databasePath, state) {
  const payload = JSON.stringify(state);
  if (Buffer.byteLength(payload, 'utf8') > MAX_PAYLOAD_BYTES) {
    throw error(`SQLite task payload exceeds the ${MAX_PAYLOAD_BYTES}-byte limit: ${databasePath}`);
  }
  const database = await open(databasePath);
  try {
    database.run(
      'INSERT INTO controller_state (id, version, payload, updated_at) VALUES (1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET version = excluded.version, payload = excluded.payload, updated_at = excluded.updated_at',
      [state.version, payload, state.updated_at],
    );
    const exported = database.export();
    if (exported.byteLength > MAX_DATABASE_BYTES) throw error(`SQLite task state exceeds the ${MAX_DATABASE_BYTES}-byte limit: ${databasePath}`);
    await atomicWriteBinary(databasePath, exported);
  } finally {
    database.close();
  }
}

export async function deleteTaskState(databasePath) {
  await fs.unlink(databasePath).catch(cause => {
    if (cause.code !== 'ENOENT') throw cause;
  });
}

export const SQLITE_LIMITS = Object.freeze({ MAX_DATABASE_BYTES, MAX_PAYLOAD_BYTES });
