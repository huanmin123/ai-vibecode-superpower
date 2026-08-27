import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
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
const MAX_GLOBAL_TASK_ROWS = 16_384;
const MAX_TASKS_PER_NAMESPACE = 1_024;
const MAX_DATABASE_BYTES = 512 * 1024 * 1024;
const DEFAULT_PAGE_SIZE = 4_096;
const MAX_DATABASE_PAGES = Math.floor(MAX_DATABASE_BYTES / DEFAULT_PAGE_SIZE);
const APPLICATION_ID = 0x41475746; // "AGWF"
// This directory is an intentional clean boundary.  Older controller stores
// remain untouched at the former location and are never opened, scanned, or
// migrated by the current controller.
const CURRENT_STORE_DIRECTORY = 'current';
const USER_VERSION = 5;
const GLOBAL_ARTIFACT_DIRECTORY = 'artifacts';
const PRUNE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const PRUNE_INDEX_NAME = 'task_state_prune_after_idx';
const PRUNE_JOB_INDEX_NAME = 'task_prune_job_due_idx';
const PRUNE_CLAIM_LEASE_MS = 5 * 60 * 1000;
const MAX_PRUNE_CLAIMS_PER_SWEEP = 32;
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
  return path.join(defaultCodexHome(), 'state', 'agnets-workflow', CURRENT_STORE_DIRECTORY, 'workflow.sqlite');
}

export function globalWorkflowArtifactRoot() {
  return path.join(defaultCodexHome(), 'state', 'agnets-workflow', CURRENT_STORE_DIRECTORY, GLOBAL_ARTIFACT_DIRECTORY);
}

export function globalWorkflowArtifactRootForHome(codexHome) {
  if (typeof codexHome !== 'string' || !codexHome.trim() || !path.isAbsolute(codexHome)) {
    throw storeError('CODEX_HOME must be an absolute path');
  }
  return path.join(path.resolve(codexHome), 'state', 'agnets-workflow', CURRENT_STORE_DIRECTORY, GLOBAL_ARTIFACT_DIRECTORY);
}

function artifactSegment(value, label) {
  if (typeof value !== 'string' || !value || path.basename(value) !== value || value === '.' || value === '..' || value.includes('\0')) {
    throw storeError(`${label} must be a path-safe artifact segment`);
  }
  return value;
}

export function globalWorkflowArtifactNamespace(logicalStateDirectory) {
  if (typeof logicalStateDirectory !== 'string' || !path.isAbsolute(logicalStateDirectory)) {
    throw storeError('Workflow artifact namespace must be an absolute path');
  }
  const key = pathKey(logicalStateDirectory);
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

export function globalWorkflowArtifactTaskPath(logicalStateDirectory, taskId) {
  return path.join(globalWorkflowArtifactRoot(), globalWorkflowArtifactNamespace(logicalStateDirectory), artifactSegment(taskId, 'task_id'));
}

export function globalWorkflowArtifactPath(logicalStateDirectory, taskId, claimId, fileName = 'outcome.json') {
  return path.join(globalWorkflowArtifactTaskPath(logicalStateDirectory, taskId), artifactSegment(claimId, 'claim_id'), artifactSegment(fileName, 'artifact file name'));
}

export function globalWorkflowArtifactPathForHome(logicalStateDirectory, taskId, claimId, fileName, codexHome) {
  return path.join(globalWorkflowArtifactRootForHome(codexHome), globalWorkflowArtifactNamespace(logicalStateDirectory), artifactSegment(taskId, 'task_id'), artifactSegment(claimId, 'claim_id'), artifactSegment(fileName, 'artifact file name'));
}

export function taskNamespaceKey(logicalStatePath) {
  return pathKey(path.dirname(logicalStatePath));
}

export function taskStoreKey(logicalStatePath) {
  return `${taskNamespaceKey(logicalStatePath)}\u0000${path.basename(logicalStatePath, '.sqlite')}`;
}

function workspaceKey(workspace) {
  if (typeof workspace !== 'string' || !path.isAbsolute(workspace)) throw storeError('Workspace control requires an absolute canonical workspace path');
  return pathKey(workspace);
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

// This is an intentionally conservative performance hint, not the authority
// for deletion. The controller still normalizes every candidate and checks the
// workspace lease before the short finalization transaction.
function pruneAfterForState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return null;
  // A terminated lineage is a durable admission tombstone. Retention cleanup
  // must never remove its last task state and reopen the lineage.
  if (state.lineage_status === 'terminated') return null;
  if (!Number.isSafeInteger(state.workflow_revision) || state.workflow_revision < 0 || state.closed_revision !== state.workflow_revision) return null;
  if (state.workspace_lease?.status !== 'released') return null;
  if (!state.nodes || typeof state.nodes !== 'object' || Array.isArray(state.nodes)) return null;
  const nodes = Object.values(state.nodes);
  if (!nodes.length || nodes.some(node => !node || typeof node !== 'object' || !['succeeded', 'skipped'].includes(node.status))) return null;
  const closedAt = Date.parse(state.closed_at ?? '');
  const dueAt = closedAt + PRUNE_RETENTION_MS;
  if (!Number.isFinite(closedAt) || !Number.isFinite(dueAt)) return null;
  try { return new Date(dueAt).toISOString(); }
  catch { return null; }
}

async function ensureParent(databasePath) {
  const parent = path.dirname(databasePath);
  const missing = [];
  let current = path.resolve(parent);
  for (;;) {
    try {
      const metadata = await fs.lstat(current, { bigint: true });
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw storeError(`Global workflow store parent is not a regular directory: ${current}`);
      await verifyDirectoryChain(current);
      break;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      missing.push(current);
      const next = path.dirname(current);
      if (next === current) throw storeError(`Cannot locate an existing parent directory for the global workflow store: ${parent}`);
      current = next;
    }
  }
  for (const directory of missing.reverse()) {
    await verifyDirectoryChain(path.dirname(directory));
    try { await fs.mkdir(directory); }
    catch (error) { if (error?.code !== 'EEXIST') throw error; }
    await verifyDirectoryChain(directory);
  }
  return objectIdentity(await verifyDirectoryChain(parent));
}

async function verifyParentDirectoryChain(databasePath) {
  return verifyDirectoryChain(path.dirname(databasePath));
}

async function verifyDirectoryChain(directoryPath) {
  const leaf = path.resolve(directoryPath);
  let current = leaf;
  let finalMetadata = null;
  for (;;) {
    let metadata = await fs.lstat(current, { bigint: true });
    if (metadata.isSymbolicLink()) {
      // macOS exposes /var as a system-managed canonical link to /private/var.
      // It is safe to follow this one link, while continuing to reject every
      // user-controlled link in the store parent chain.
      let target;
      try { target = await fs.realpath(current); }
      catch (cause) { throw storeError(`Global workflow store parent is not a regular directory: ${current}`, cause); }
      const allowedSystemVar = process.platform === 'darwin'
        && current === '/var'
        && path.resolve(target) === '/private/var';
      if (!allowedSystemVar) throw storeError(`Global workflow store parent is not a regular directory: ${current}`);
      metadata = await fs.stat(current, { bigint: true });
    }
    if (!metadata.isDirectory()) throw storeError(`Global workflow store parent is not a regular directory: ${current}`);
    if (current === leaf) finalMetadata = metadata;
    const next = path.dirname(current);
    if (next === current) break;
    current = next;
  }
  return finalMetadata;
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

async function verifyParentIdentity(databasePath, expected) {
  const parent = path.dirname(databasePath);
  const metadata = await verifyParentDirectoryChain(databasePath);
  if (expected && !sameIdentity(expected, objectIdentity(metadata))) {
    throw storeError(`Global workflow store parent identity changed: ${parent}`);
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
  // Configure reclamation before creating any table. Existing databases are
  // upgraded without a full VACUUM so normal MCP startup never rewrites an
  // arbitrarily large user database on the foreground request thread.
  database.exec('PRAGMA auto_vacuum = INCREMENTAL; VACUUM;');
  try { database.exec('PRAGMA journal_mode = WAL;'); }
  catch (cause) { if (!/(?:SQLITE_BUSY|database is locked|database is busy)/i.test(String(cause?.message ?? cause))) throw cause; }
  database.exec(`PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}; PRAGMA wal_autocheckpoint = 1000; PRAGMA max_page_count = ${MAX_DATABASE_PAGES}; PRAGMA application_id = ${APPLICATION_ID}; PRAGMA user_version = ${USER_VERSION};`);
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
      prune_after TEXT,
      instance_id TEXT NOT NULL,
      change_counter INTEGER NOT NULL,
      PRIMARY KEY (namespace_key, task_id)
    );
    CREATE TABLE IF NOT EXISTS namespace_identity (
      namespace_key TEXT PRIMARY KEY,
      canonical_path TEXT NOT NULL,
      real_path TEXT NOT NULL,
      dev TEXT NOT NULL,
      ino TEXT NOT NULL,
      bound_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS task_prune_job (
      namespace_key TEXT NOT NULL,
      task_id TEXT NOT NULL,
      instance_id TEXT NOT NULL,
      claim_token TEXT NOT NULL,
      phase TEXT NOT NULL,
      lease_deadline_at TEXT NOT NULL,
      retry_after TEXT,
      attempt_count INTEGER NOT NULL,
      last_error TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (namespace_key, task_id)
    );
    CREATE INDEX IF NOT EXISTS ${PRUNE_INDEX_NAME}
      ON task_state (prune_after, namespace_key, task_id)
      WHERE prune_after IS NOT NULL;
    CREATE INDEX IF NOT EXISTS ${PRUNE_JOB_INDEX_NAME}
      ON task_prune_job (phase, retry_after, lease_deadline_at, namespace_key, task_id);
  `);
  database.prepare("INSERT INTO store_meta (key, value) VALUES ('schema_version', ?), ('store_id', lower(hex(randomblob(16))))").run(String(USER_VERSION));
  database.exec('PRAGMA wal_checkpoint(TRUNCATE);');
}

function requireColumns(database, table, expected) {
  const actual = database.prepare(`PRAGMA table_info(${table})`).all().map(column => [column.name, String(column.type).toUpperCase(), column.notnull, column.pk]);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw storeError(`Global workflow store has an incompatible ${table} schema`);
}

function requirePruneIndex(database) {
  const index = database.prepare('SELECT tbl_name, sql FROM sqlite_master WHERE type = ? AND name = ?').get('index', PRUNE_INDEX_NAME);
  const definition = typeof index?.sql === 'string' ? index.sql.replace(/\s+/g, ' ').trim().toUpperCase() : '';
  const expectedDefinition = `CREATE INDEX ${PRUNE_INDEX_NAME} ON TASK_STATE (PRUNE_AFTER, NAMESPACE_KEY, TASK_ID) WHERE PRUNE_AFTER IS NOT NULL`.toUpperCase();
  if (index?.tbl_name !== 'task_state' || definition !== expectedDefinition) throw storeError('Global workflow store has an incompatible prune index');
  const columns = database.prepare(`PRAGMA index_info(${PRUNE_INDEX_NAME})`).all().map(column => column.name);
  if (JSON.stringify(columns) !== JSON.stringify(['prune_after', 'namespace_key', 'task_id'])) throw storeError('Global workflow store prune index columns are incompatible');
  const details = database.prepare('PRAGMA index_list(task_state)').all().find(candidate => candidate.name === PRUNE_INDEX_NAME);
  if (!details || Number(details.unique) !== 0 || Number(details.partial) !== 1) throw storeError('Global workflow store prune index properties are incompatible');
}

function requireStoreMetadata(database, version, databasePath) {
  const meta = database.prepare("SELECT key, value FROM store_meta ORDER BY key").all();
  const schemaVersion = meta.find(row => row.key === 'schema_version');
  const storeId = meta.find(row => row.key === 'store_id');
  const unknown = meta.filter(row => row.key !== 'schema_version' && row.key !== 'store_id' && !/^application_binding:[a-f0-9]{64}$/.test(row.key ?? ''));
  const bindingsValid = meta.filter(row => /^application_binding:[a-f0-9]{64}$/.test(row.key ?? ''))
    .every(row => {
      try {
        const value = JSON.parse(row.value);
        return value && typeof value === 'object' && !Array.isArray(value)
          && typeof value.application_id === 'string' && value.application_id.trim()
          && typeof value.workspace === 'string' && path.isAbsolute(value.workspace)
          && typeof value.bound_at === 'string' && Number.isFinite(Date.parse(value.bound_at))
          && applicationBindingKey(value.application_id) === row.key;
      } catch {
        return false;
      }
    });
  if (!schemaVersion || schemaVersion.value !== String(version) || !storeId || !/^[a-f0-9]{32}$/.test(storeId.value ?? '') || unknown.length || !bindingsValid) {
    throw storeError(`Global workflow store metadata is invalid: ${databasePath}`);
  }
}

function applicationBindingKey(applicationId) {
  return `application_binding:${createHash('sha256').update(applicationId).digest('hex')}`;
}

function schemaMarkers(database) {
  return {
    applicationId: Number(database.prepare('PRAGMA application_id').get()?.application_id),
    userVersion: Number(database.prepare('PRAGMA user_version').get()?.user_version),
  };
}

function maxDatabasePages(database) {
  const pageSize = Number(database.prepare('PRAGMA page_size').get()?.page_size ?? DEFAULT_PAGE_SIZE);
  if (!Number.isSafeInteger(pageSize) || pageSize < 512) throw storeError('Global workflow store has an invalid SQLite page size');
  return Math.max(1, Math.floor(MAX_DATABASE_BYTES / pageSize));
}

function requireSchemaMarkers(database, databasePath, version) {
  const { applicationId, userVersion } = schemaMarkers(database);
  if (applicationId !== APPLICATION_ID || userVersion !== version) throw storeError(`Global workflow store schema marker mismatch: ${databasePath}`);
}

function requirePruneJobIndex(database) {
  const index = database.prepare('SELECT tbl_name, sql FROM sqlite_master WHERE type = ? AND name = ?').get('index', PRUNE_JOB_INDEX_NAME);
  const definition = typeof index?.sql === 'string' ? index.sql.replace(/\s+/g, ' ').trim().toUpperCase() : '';
  const expectedDefinition = `CREATE INDEX ${PRUNE_JOB_INDEX_NAME} ON TASK_PRUNE_JOB (PHASE, RETRY_AFTER, LEASE_DEADLINE_AT, NAMESPACE_KEY, TASK_ID)`.toUpperCase();
  if (index?.tbl_name !== 'task_prune_job' || definition !== expectedDefinition) throw storeError('Global workflow store has an incompatible prune job index');
  const columns = database.prepare(`PRAGMA index_info(${PRUNE_JOB_INDEX_NAME})`).all().map(column => column.name);
  if (JSON.stringify(columns) !== JSON.stringify(['phase', 'retry_after', 'lease_deadline_at', 'namespace_key', 'task_id'])) throw storeError('Global workflow store prune job index columns are incompatible');
}

function verifySchema(database, databasePath) {
  requireSchemaMarkers(database, databasePath, USER_VERSION);
  const objects = database.prepare("SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all();
  const expectedObjects = [
    { type: 'index', name: PRUNE_JOB_INDEX_NAME },
    { type: 'index', name: PRUNE_INDEX_NAME },
    { type: 'table', name: 'namespace_identity' },
    { type: 'table', name: 'store_meta' },
    { type: 'table', name: 'task_prune_job' },
    { type: 'table', name: 'task_state' },
    { type: 'table', name: 'workspace_control' },
  ];
  if (JSON.stringify(objects) !== JSON.stringify(expectedObjects)) throw storeError(`Global workflow store has unknown managed objects: ${databasePath}`);
  requireColumns(database, 'store_meta', [['key', 'TEXT', 0, 1], ['value', 'TEXT', 1, 0]]);
  requireColumns(database, 'workspace_control', [['workspace_key', 'TEXT', 0, 1], ['workspace', 'TEXT', 1, 0], ['payload', 'TEXT', 1, 0], ['updated_at', 'TEXT', 1, 0], ['change_counter', 'INTEGER', 1, 0]]);
  requireColumns(database, 'task_state', [['namespace_key', 'TEXT', 1, 1], ['task_id', 'TEXT', 1, 2], ['payload', 'TEXT', 1, 0], ['updated_at', 'TEXT', 1, 0], ['prune_after', 'TEXT', 0, 0], ['instance_id', 'TEXT', 1, 0], ['change_counter', 'INTEGER', 1, 0]]);
  requireColumns(database, 'namespace_identity', [['namespace_key', 'TEXT', 0, 1], ['canonical_path', 'TEXT', 1, 0], ['real_path', 'TEXT', 1, 0], ['dev', 'TEXT', 1, 0], ['ino', 'TEXT', 1, 0], ['bound_at', 'TEXT', 1, 0]]);
  requireColumns(database, 'task_prune_job', [['namespace_key', 'TEXT', 1, 1], ['task_id', 'TEXT', 1, 2], ['instance_id', 'TEXT', 1, 0], ['claim_token', 'TEXT', 1, 0], ['phase', 'TEXT', 1, 0], ['lease_deadline_at', 'TEXT', 1, 0], ['retry_after', 'TEXT', 0, 0], ['attempt_count', 'INTEGER', 1, 0], ['last_error', 'TEXT', 0, 0], ['updated_at', 'TEXT', 1, 0]]);
  requirePruneIndex(database);
  requirePruneJobIndex(database);
  requireStoreMetadata(database, USER_VERSION, databasePath);
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
  const parentIdentity = await ensureParent(databasePath);
  const before = await databaseFileBeforeOpen(databasePath);
  const published = before.exists
    ? { created: false, identity: before.identity }
    : await publishNewDatabase(databasePath);
  let database;
  try {
    if (!published.created) await verifyExistingDatabase(databasePath, published.identity);
    database = new DatabaseSync(databasePath);
    await verifyDatabaseIdentity(databasePath, published.identity);
    await verifyParentIdentity(databasePath, parentIdentity);
    verifySchema(database, databasePath);
    const maxPages = maxDatabasePages(database);
    database.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}; PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL; PRAGMA wal_autocheckpoint = 1000; PRAGMA max_page_count = ${maxPages}; PRAGMA journal_mode = WAL;`);
    const journalMode = String(database.prepare('PRAGMA journal_mode').get()?.journal_mode ?? '').toLowerCase();
    if (journalMode !== 'wal') throw storeError(`Global workflow store is not using WAL: ${databasePath}`);
    await verifyDatabaseIdentity(databasePath, published.identity);
    await verifyParentIdentity(databasePath, parentIdentity);
    return { database, identity: published.identity, parentIdentity, databasePath };
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
      let expectedIdentity;
      let expectedParentIdentity;
      let databasePath;
      let inTransaction = false;
      try {
        ({ database, identity: expectedIdentity, parentIdentity: expectedParentIdentity, databasePath } = await openWritable());
        database.exec('BEGIN IMMEDIATE');
        inTransaction = true;
        const result = await transactionContext.run({ database }, () => callback(database));
        await verifyDatabaseIdentity(databasePath, expectedIdentity);
        await verifyParentIdentity(databasePath, expectedParentIdentity);
        database.exec('COMMIT');
        inTransaction = false;
        await verifyDatabaseIdentity(databasePath, expectedIdentity);
        await verifyParentIdentity(databasePath, expectedParentIdentity);
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

async function withSerializedWritableConnection(callback) {
  if (transactionContext.getStore()) throw storeError('Global store connection maintenance cannot run inside a write transaction');
  let release;
  const predecessor = writerTail;
  const gate = new Promise(resolve => { release = resolve; });
  writerTail = predecessor.then(() => gate);
  await predecessor;
  let database;
  let expectedIdentity;
  let expectedParentIdentity;
  let databasePath;
  try {
    ({ database, identity: expectedIdentity, parentIdentity: expectedParentIdentity, databasePath } = await openWritable());
    const result = await callback(database);
    await verifyDatabaseIdentity(databasePath, expectedIdentity);
    await verifyParentIdentity(databasePath, expectedParentIdentity);
    return result;
  } finally {
    database?.close();
    release();
  }
}

export async function maintainGlobalWorkflowStoreSpace({ incremental_pages = 256 } = {}) {
  if (!Number.isSafeInteger(incremental_pages) || incremental_pages < 0 || incremental_pages > 4_096) throw storeError('incremental_pages must be an integer between 0 and 4096');
  return withSerializedWritableConnection(database => {
    const autoVacuum = Number(database.prepare('PRAGMA auto_vacuum').get()?.auto_vacuum ?? 0);
    database.exec('PRAGMA optimize;');
    try { database.prepare('PRAGMA wal_checkpoint(PASSIVE)').all(); }
    catch (cause) { if (!isBusy(cause)) throw cause; }
    if (autoVacuum === 2 && incremental_pages > 0) database.exec(`PRAGMA incremental_vacuum(${incremental_pages});`);
    const pageCount = Number(database.prepare('PRAGMA page_count').get()?.page_count ?? 0);
    const freePages = Number(database.prepare('PRAGMA freelist_count').get()?.freelist_count ?? 0);
    const pageSize = Number(database.prepare('PRAGMA page_size').get()?.page_size ?? DEFAULT_PAGE_SIZE);
    return {
      auto_vacuum: autoVacuum === 2 ? 'incremental' : autoVacuum === 1 ? 'full' : 'none',
      page_count: pageCount,
      free_page_count: freePages,
      page_size: pageSize,
      allocated_bytes: pageCount * pageSize,
      reusable_bytes: freePages * pageSize,
      configured_max_bytes: MAX_DATABASE_BYTES,
    };
  });
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

function namespaceAuthority(logicalStateDirectory, authority) {
  const canonicalPath = path.resolve(logicalStateDirectory);
  if (!authority || typeof authority !== 'object' || Array.isArray(authority)
    || typeof authority.path !== 'string' || pathKey(authority.path) !== pathKey(canonicalPath)
    || typeof authority.real_path !== 'string' || !path.isAbsolute(authority.real_path)
    || !authority.identity || typeof authority.identity !== 'object'
    || typeof authority.identity.dev !== 'string' || !/^-?\d+$/.test(authority.identity.dev)
    || typeof authority.identity.ino !== 'string' || !/^-?\d+$/.test(authority.identity.ino)) {
    throw storeError(`Namespace identity is invalid: ${canonicalPath}`);
  }
  return {
    namespace_key: pathKey(canonicalPath),
    canonical_path: canonicalPath,
    real_path: path.resolve(authority.real_path),
    dev: authority.identity.dev,
    ino: authority.identity.ino,
  };
}

function sameNamespaceIdentity(left, right) {
  return left?.namespace_key === right.namespace_key
    && pathKey(left?.canonical_path) === pathKey(right.canonical_path)
    && pathKey(left?.real_path) === pathKey(right.real_path)
    && left?.dev === right.dev
    && left?.ino === right.ino;
}

function storedStateAuthority(state) {
  const authority = state?.workspace_lease?.state_parent_authority;
  if (!authority || typeof authority !== 'object') return null;
  try { return namespaceAuthority(authority.path, authority); }
  catch { return null; }
}

export async function ensureGlobalNamespaceIdentity(logicalStateDirectory, authority) {
  const expected = namespaceAuthority(logicalStateDirectory, authority);
  return withWriter(database => {
    const existing = database.prepare('SELECT namespace_key, canonical_path, real_path, dev, ino, bound_at FROM namespace_identity WHERE namespace_key = ?').get(expected.namespace_key);
    if (existing) {
      if (!sameNamespaceIdentity(existing, expected)) throw storeError(`STATE_NAMESPACE_IDENTITY_CHANGED: ${expected.canonical_path}`);
      return existing;
    }
    const rows = database.prepare('SELECT task_id, payload FROM task_state WHERE namespace_key = ? ORDER BY task_id').all(expected.namespace_key);
    for (const row of rows) {
      let state;
      try { state = parsePayload(row.payload, `Global task state ${expected.namespace_key}/${row.task_id}`); }
      catch (cause) { throw storeError(`NAMESPACE_IDENTITY_INVALID: unreadable task ${row.task_id} in ${expected.canonical_path}`, cause); }
      const stored = storedStateAuthority(state);
      if (!stored || !sameNamespaceIdentity(stored, expected)) {
        throw storeError(`NAMESPACE_IDENTITY_INVALID: task ${row.task_id} does not prove the current directory identity for ${expected.canonical_path}`);
      }
    }
    const boundAt = new Date().toISOString();
    database.prepare('INSERT INTO namespace_identity (namespace_key, canonical_path, real_path, dev, ino, bound_at) VALUES (?, ?, ?, ?, ?, ?)').run(expected.namespace_key, expected.canonical_path, expected.real_path, expected.dev, expected.ino, boundAt);
    return { ...expected, bound_at: boundAt };
  });
}

export async function withGlobalTaskStateTransaction(databasePath, options = {}, callback) {
  const identity = taskIdentity(databasePath);
  return withWriter(async database => {
    const pruneJob = database.prepare('SELECT phase, retry_after, lease_deadline_at FROM task_prune_job WHERE namespace_key = ? AND task_id = ?').get(identity.namespaceKey, identity.taskId);
    if (pruneJob) throw storeError(`Task state is reserved for retention cleanup and cannot be changed: ${taskStoreKey(databasePath)}`);
    const row = database.prepare('SELECT payload, instance_id, change_counter FROM task_state WHERE namespace_key = ? AND task_id = ?').get(identity.namespaceKey, identity.taskId);
    const current = row ? parsePayload(row.payload, `Global task state ${taskStoreKey(databasePath)}`) : null;
    let saved = false;
    const save = state => {
      if (saved) throw storeError('Global task state transaction save(state) may only be called once');
      const serialized = payload(state, `Global task state ${taskStoreKey(databasePath)}`);
      const updatedAt = typeof state?.updated_at === 'string' ? state.updated_at : new Date().toISOString();
      const pruneAfter = pruneAfterForState(state);
      if (!row) {
        const globalCount = Number(database.prepare('SELECT count(*) AS count FROM task_state').get().count);
        const namespaceCount = Number(database.prepare('SELECT count(*) AS count FROM task_state WHERE namespace_key = ?').get(identity.namespaceKey).count);
        if (globalCount >= MAX_GLOBAL_TASK_ROWS) throw storeError(`Global workflow store reached the ${MAX_GLOBAL_TASK_ROWS}-task limit; allow background retention cleanup to finish before creating another task`);
        if (namespaceCount >= MAX_TASKS_PER_NAMESPACE) throw storeError(`Workflow namespace reached the ${MAX_TASKS_PER_NAMESPACE}-task limit: ${path.dirname(path.resolve(databasePath))}`);
      }
      const instanceId = row?.instance_id ?? randomUUID();
      const changeCounter = row ? row.change_counter + (options.cursor_relevant === false ? 0 : 1) : 1;
      database.prepare('INSERT INTO task_state (namespace_key, task_id, payload, updated_at, prune_after, instance_id, change_counter) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(namespace_key, task_id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at, prune_after = excluded.prune_after, change_counter = excluded.change_counter').run(identity.namespaceKey, identity.taskId, serialized, updatedAt, pruneAfter, instanceId, changeCounter);
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

export async function readGlobalTaskChangeToken(databasePath, workspace = null) {
  const identity = taskIdentity(databasePath);
  const controlKey = workspace ? workspaceKey(workspace) : null;
  return withReadOnly(database => {
    if (!database) return null;
    const task = database.prepare('SELECT instance_id, change_counter FROM task_state WHERE namespace_key = ? AND task_id = ?').get(identity.namespaceKey, identity.taskId);
    if (!task) return null;
    const control = controlKey ? database.prepare('SELECT change_counter FROM workspace_control WHERE workspace_key = ?').get(controlKey) : null;
    return { instance_id: task.instance_id, task_change_counter: task.change_counter, workspace_change_counter: control?.change_counter ?? null };
  });
}

export async function writeGlobalTaskState(databasePath, state, options = {}) {
  return withGlobalTaskStateTransaction(databasePath, options, async (_current, save) => { save(state); });
}

export async function deleteGlobalTaskState(databasePath) {
  const identity = taskIdentity(databasePath);
  return withWriter(database => {
    if (database.prepare('SELECT 1 AS present FROM task_prune_job WHERE namespace_key = ? AND task_id = ?').get(identity.namespaceKey, identity.taskId)?.present) {
      throw storeError(`Task state is reserved for retention cleanup and cannot be deleted: ${taskStoreKey(databasePath)}`);
    }
    return database.prepare('DELETE FROM task_state WHERE namespace_key = ? AND task_id = ?').run(identity.namespaceKey, identity.taskId);
  });
}

export async function listGlobalTaskStatesForNamespace(logicalStateDirectory) {
  const namespaceKey = pathKey(logicalStateDirectory);
  return withReadOnly(database => {
    if (!database) return [];
    return database.prepare('SELECT task_id, payload, updated_at FROM task_state WHERE namespace_key = ? ORDER BY task_id').all(namespaceKey)
      .map(row => ({ task_id: row.task_id, state: parsePayload(row.payload, `Global task state ${namespaceKey}/${row.task_id}`), updated_at: row.updated_at }));
  });
}

export async function listGlobalTaskStatesForWorkspace(workspace) {
  return withReadOnly(database => {
    if (!database) return [];
    return database.prepare("SELECT namespace_key, task_id, payload FROM task_state WHERE CASE WHEN json_valid(payload) THEN json_extract(payload, '$.workspace') END = ? ORDER BY namespace_key, task_id").all(workspace)
      .map(row => ({ namespace_key: row.namespace_key, task_id: row.task_id, state: parsePayload(row.payload, `Global task state ${row.namespace_key}/${row.task_id}`) }))
      .filter(entry => entry.state?.workspace === workspace);
  });
}

// Application identifiers are durable global bindings. The binding lives in
// store_meta rather than task_state so pruning a closed task cannot release it.
export async function bindGlobalApplication(applicationId, workspace) {
  if (typeof applicationId !== 'string' || !applicationId.trim()) throw storeError('application_id must be a non-empty string');
  if (typeof workspace !== 'string' || !workspace.trim() || !path.isAbsolute(workspace)) throw storeError('workspace must be an absolute path');
  const value = applicationId.trim();
  const canonicalWorkspace = path.resolve(workspace).normalize('NFC');
  const key = applicationBindingKey(value);
  return withWriter(database => {
    const row = database.prepare('SELECT value FROM store_meta WHERE key = ?').get(key);
    if (row) {
      let binding;
      try { binding = JSON.parse(row.value); } catch (cause) { throw storeError(`Application binding metadata is invalid: ${key}`, cause); }
      if (binding?.application_id !== value || typeof binding.workspace !== 'string' || !path.isAbsolute(binding.workspace)) {
        throw storeError(`Application binding metadata is invalid: ${key}`);
      }
      if (pathKey(binding.workspace) !== pathKey(canonicalWorkspace)) {
        throw storeError(`APPLICATION_WORKSPACE_BOUND: application_id ${value} is already bound to workspace ${binding.workspace}`);
      }
      return binding;
    }
    const binding = { application_id: value, workspace: canonicalWorkspace, bound_at: new Date().toISOString() };
    database.prepare('INSERT INTO store_meta (key, value) VALUES (?, ?)').run(key, JSON.stringify(binding));
    return binding;
  });
}

function pruneDueBefore(value) {
  if (typeof value !== 'string' || !value.trim()) throw storeError('prune_due_before must be a non-empty timestamp string');
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw storeError('prune_due_before must be a valid timestamp');
  return new Date(timestamp).toISOString();
}

// Startup maintenance has no caller-supplied namespace. Read only due rows
// through the partial index, then let the controller re-verify each saved
// namespace before it can touch external review artifacts.
export async function listGlobalTaskPruneCandidates(value) {
  const dueBefore = pruneDueBefore(value);
  return withReadOnly(database => {
    if (!database) return [];
    return database.prepare(`SELECT namespace_key, task_id FROM task_state INDEXED BY ${PRUNE_INDEX_NAME} WHERE prune_after <= ? ORDER BY prune_after, namespace_key, task_id`).all(dueBefore)
      .map(row => ({ namespace_key: row.namespace_key, task_id: row.task_id }));
  });
}

function pruneClaimLimit(value) {
  const limit = value ?? MAX_PRUNE_CLAIMS_PER_SWEEP;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PRUNE_CLAIMS_PER_SWEEP) throw storeError(`prune claim limit must be between 1 and ${MAX_PRUNE_CLAIMS_PER_SWEEP}`);
  return limit;
}

function pruneClaimResult(row, claimToken, leaseDeadlineAt, attemptCount) {
  let state = null;
  let parseError = null;
  try { state = parsePayload(row.payload, `Global task state ${row.namespace_key}/${row.task_id}`); }
  catch (error) { parseError = error.message; }
  return {
    namespace_key: row.namespace_key,
    task_id: row.task_id,
    instance_id: row.instance_id,
    claim_token: claimToken,
    lease_deadline_at: leaseDeadlineAt,
    attempt_count: attemptCount,
    updated_at: row.updated_at,
    state,
    parse_error: parseError,
    namespace_identity: {
      namespace_key: row.namespace_key,
      canonical_path: row.canonical_path,
      real_path: row.real_path,
      dev: row.dev,
      ino: row.ino,
      bound_at: row.bound_at,
    },
  };
}

// Claiming is deliberately a short SQLite-only transaction. Filesystem work
// happens after this returns, while the persistent job prevents same-key writes
// and init from creating an ABA replacement.
export async function claimGlobalTaskPruneJobs(value, options = {}) {
  const dueBefore = pruneDueBefore(value);
  const limit = pruneClaimLimit(options.limit);
  const leaseMs = options.lease_ms ?? PRUNE_CLAIM_LEASE_MS;
  const namespaceKey = options.namespace_key === undefined || options.namespace_key === null ? null : pathKey(options.namespace_key);
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 60 * 60 * 1000) throw storeError('prune claim lease_ms must be between 1000 and 3600000');
  return withWriter(database => {
    const now = new Date().toISOString();
    const leaseDeadlineAt = new Date(Date.now() + leaseMs).toISOString();
    const rows = database.prepare(`
      SELECT s.namespace_key, s.task_id, s.payload, s.updated_at, s.instance_id,
             n.canonical_path, n.real_path, n.dev, n.ino, n.bound_at,
             j.phase AS job_phase, j.attempt_count AS job_attempt_count
      FROM task_state AS s INDEXED BY ${PRUNE_INDEX_NAME}
      JOIN namespace_identity AS n ON n.namespace_key = s.namespace_key
      LEFT JOIN task_prune_job AS j ON j.namespace_key = s.namespace_key AND j.task_id = s.task_id
      WHERE s.prune_after <= ?
        AND (? IS NULL OR s.namespace_key = ?)
        AND (j.namespace_key IS NULL
          OR (j.phase = 'claimed' AND j.lease_deadline_at <= ?)
          OR (j.phase = 'retry' AND coalesce(j.retry_after, j.lease_deadline_at) <= ?))
      ORDER BY s.prune_after, s.namespace_key, s.task_id
      LIMIT ?
    `).all(dueBefore, namespaceKey, namespaceKey, now, now, limit);
    const insert = database.prepare(`
      INSERT INTO task_prune_job
        (namespace_key, task_id, instance_id, claim_token, phase, lease_deadline_at, retry_after, attempt_count, last_error, updated_at)
      VALUES (?, ?, ?, ?, 'claimed', ?, NULL, ?, NULL, ?)
      ON CONFLICT(namespace_key, task_id) DO UPDATE SET
        instance_id = excluded.instance_id,
        claim_token = excluded.claim_token,
        phase = 'claimed',
        lease_deadline_at = excluded.lease_deadline_at,
        retry_after = NULL,
        attempt_count = excluded.attempt_count,
        last_error = NULL,
        updated_at = excluded.updated_at
    `);
    return rows.map(row => {
      const claimToken = randomUUID();
      const attemptCount = Number(row.job_attempt_count ?? 0) + 1;
      insert.run(row.namespace_key, row.task_id, row.instance_id, claimToken, leaseDeadlineAt, attemptCount, now);
      return pruneClaimResult(row, claimToken, leaseDeadlineAt, attemptCount);
    });
  });
}

function requirePruneClaim(claim) {
  if (!claim || typeof claim !== 'object'
    || typeof claim.namespace_key !== 'string' || !claim.namespace_key
    || typeof claim.task_id !== 'string' || !claim.task_id
    || typeof claim.instance_id !== 'string' || !claim.instance_id
    || typeof claim.claim_token !== 'string' || !claim.claim_token) throw storeError('Invalid prune claim');
  return claim;
}

export async function cancelGlobalTaskPruneJob(claim) {
  const expected = requirePruneClaim(claim);
  return withWriter(database => database.prepare('DELETE FROM task_prune_job WHERE namespace_key = ? AND task_id = ? AND instance_id = ? AND claim_token = ?').run(expected.namespace_key, expected.task_id, expected.instance_id, expected.claim_token).changes);
}

export async function failGlobalTaskPruneJob(claim, error) {
  const expected = requirePruneClaim(claim);
  const message = String(error?.message ?? error ?? 'retention cleanup failed').slice(0, 4_096);
  const delayMs = Math.min(60 * 60 * 1000, 30_000 * (2 ** Math.min(7, Math.max(0, Number(expected.attempt_count ?? 1) - 1))));
  const retryAfter = new Date(Date.now() + delayMs).toISOString();
  return withWriter(database => database.prepare(`
    UPDATE task_prune_job
    SET phase = 'retry', lease_deadline_at = ?, retry_after = ?, last_error = ?, updated_at = ?
    WHERE namespace_key = ? AND task_id = ? AND instance_id = ? AND claim_token = ?
  `).run(retryAfter, retryAfter, message, new Date().toISOString(), expected.namespace_key, expected.task_id, expected.instance_id, expected.claim_token).changes);
}

export async function finalizeGlobalTaskPruneJob(claim) {
  const expected = requirePruneClaim(claim);
  return withWriter(database => {
    const job = database.prepare('SELECT phase, instance_id, claim_token FROM task_prune_job WHERE namespace_key = ? AND task_id = ?').get(expected.namespace_key, expected.task_id);
    const row = database.prepare('SELECT instance_id FROM task_state WHERE namespace_key = ? AND task_id = ?').get(expected.namespace_key, expected.task_id);
    if (!job || job.phase !== 'claimed' || job.instance_id !== expected.instance_id || job.claim_token !== expected.claim_token || !row || row.instance_id !== expected.instance_id) {
      throw storeError(`Prune claim is stale and cannot delete task state: ${expected.namespace_key}/${expected.task_id}`);
    }
    const deleted = database.prepare('DELETE FROM task_state WHERE namespace_key = ? AND task_id = ? AND instance_id = ?').run(expected.namespace_key, expected.task_id, expected.instance_id).changes;
    if (deleted !== 1) throw storeError(`Prune claim did not delete exactly one task state: ${expected.namespace_key}/${expected.task_id}`);
    database.prepare('DELETE FROM task_prune_job WHERE namespace_key = ? AND task_id = ? AND claim_token = ?').run(expected.namespace_key, expected.task_id, expected.claim_token);
    const remaining = Number(database.prepare('SELECT count(*) AS count FROM task_state WHERE namespace_key = ?').get(expected.namespace_key).count);
    if (remaining === 0) database.prepare('DELETE FROM namespace_identity WHERE namespace_key = ?').run(expected.namespace_key);
    return { deleted: 1, namespace_released: remaining === 0 };
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

export async function globalWorkspaceControlExists(workspace) {
  const active = transactionContext.getStore();
  const key = workspaceKey(workspace);
  if (active) return Boolean(active.database.prepare('SELECT 1 AS present FROM workspace_control WHERE workspace_key = ?').get(key)?.present);
  return withReadOnly(database => Boolean(database?.prepare('SELECT 1 AS present FROM workspace_control WHERE workspace_key = ?').get(key)?.present));
}

export async function createGlobalWorkspaceControl(workspace, initialPayload = {}) {
  const key = workspaceKey(workspace);
  return withWriter(database => {
    if (database.prepare('SELECT 1 AS present FROM workspace_control WHERE workspace_key = ?').get(key)?.present) throw storeError(`Workspace control already exists: ${workspace}`);
    database.prepare('INSERT INTO workspace_control (workspace_key, workspace, payload, updated_at, change_counter) VALUES (?, ?, ?, ?, 0)').run(key, workspace, payload(initialPayload, 'Global workspace control'), new Date().toISOString());
  });
}

export async function readGlobalWorkspaceControl(workspace) {
  const key = workspaceKey(workspace);
  const active = transactionContext.getStore();
  const read = database => {
    const row = database.prepare('SELECT workspace, payload, updated_at, change_counter FROM workspace_control WHERE workspace_key = ?').get(key);
    if (!row) throw storeError(`Workspace control does not exist: ${workspace}`);
    if (row.workspace !== workspace) throw storeError(`Workspace control workspace mismatch: ${workspace}`);
    return { payload: parsePayload(row.payload, `Global workspace control ${workspace}`), updated_at: row.updated_at, change_counter: row.change_counter };
  };
  if (active) return read(active.database);
  return withReadOnly(database => {
    if (!database) throw storeError(`Workspace control does not exist: ${workspace}`);
    return read(database);
  });
}

export async function withGlobalWorkspaceControlTransaction(workspace, callback) {
  const key = workspaceKey(workspace);
  return withWriter(async database => {
    const row = database.prepare('SELECT workspace, payload, change_counter FROM workspace_control WHERE workspace_key = ?').get(key);
    if (!row) throw storeError(`Workspace control does not exist: ${workspace}`);
    if (row.workspace !== workspace) throw storeError(`Workspace control workspace mismatch: ${workspace}`);
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
