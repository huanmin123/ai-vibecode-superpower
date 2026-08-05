import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { deleteTaskState, readTaskState, taskStateExists, writeTaskState } from './sqlite_task_store.mjs';

export const VERSION = 1;
const PENDING = 'pending';
const RUNNING = 'running';
const SUCCEEDED = 'succeeded';
const TERMINAL = new Set([SUCCEEDED, 'failed', 'blocked', 'skipped', 'unavailable', 'abandoned']);
const COMPLETABLE = new Set([SUCCEEDED, 'failed', 'blocked', 'skipped', 'unavailable']);
const SOL_ROLES = new Set(['avsp_sol_high', 'avsp_sol_xhigh', 'avsp_sol_max']);
const SOL_ESCALATION_ORDER = ['avsp_sol_high', 'avsp_sol_xhigh', 'avsp_sol_max'];
const FALLBACK_ROLE = 'avsp_terra_xhigh_readonly';
const LUNA_EXECUTOR_ROLES = new Set([
  'avsp_luna_high_executor',
  'avsp_luna_xhigh_executor',
  // Writers are retained for existing tasks; new tasks use the executor roles.
  'avsp_luna_high_writer',
  'avsp_luna_xhigh_writer',
]);
const LEGACY_LUNA_WRITER_ROLES = new Set(['avsp_luna_high_writer', 'avsp_luna_xhigh_writer']);
const READ_ONLY_ROLES = new Set([
  'avsp_luna_high',
  'avsp_luna_xhigh',
  'avsp_sol_high',
  'avsp_sol_xhigh',
  'avsp_sol_max',
  'avsp_terra_low_readonly',
  'avsp_terra_medium_readonly',
  'avsp_terra_xhigh',
  'avsp_terra_xhigh_readonly',
]);
const PROTECTED_EXECUTOR_ROLE = 'avsp_terra_high';
const ROUTING_FIELDS = ['execution_risk', 'routing_reason', 'execution_owner', 'integration_owner', 'quality_guard'];
const IGNORED_DIRECTORIES = new Set(['.git', '.codex', 'node_modules', '.venv']);
const MAX_MANIFEST_BYTES = 1 * 1024 * 1024;
const MAX_NODE_RESULT_BYTES = 64 * 1024;
const MAX_REVIEW_BYTES = 128 * 1024;
const MAX_STATE_BYTES = 8 * 1024 * 1024;
const MAX_FINGERPRINT_FILES = 100_000;
const MAX_FINGERPRINT_FILE_BYTES = 512 * 1024 * 1024;
const MAX_FINGERPRINT_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;
const FINGERPRINT_ATTEMPTS = 3;
const MAX_NODES = 64;
const MAX_REQUIREMENTS = 64;
const MAX_NODE_ATTEMPTS = 8;
const MAX_REVIEWS = 16;
const MAX_CHECKPOINT_BYTES = 32 * 1024;
const MAX_RECOVERY_RESULT_BYTES = 8 * 1024;
const DEFAULT_TASK_RETENTION_DAYS = 7;
const QUARANTINE_AFTER_DAYS = 30;
const ERROR_STATE_RETENTION_DAYS = 365;
const DAY_MS = 24 * 60 * 60 * 1000;
const PRUNE_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const MAX_PRUNE_REPORT_ENTRIES = 128;
const PRUNE_SWEEP_FILENAME = '.workflow-prune-sweep.json';
const SQLITE_STATE_SUFFIX = '.sqlite';
const ERROR_STATE_DIRECTORY = '.workflow-errors';
const ERROR_QUARANTINE_FILENAME = 'quarantine.json';
const QUARANTINE_EXPIRY_FILENAME = '.quarantine-expiry.json';
const REVIEW_ARTIFACT_DIRECTORY = '.workflow-review-results';
const QUARANTINE_REVIEW_DIRECTORY = 'review-results';
const MAX_QUARANTINE_BYTES = 32 * 1024;
const READ_ONLY_COMMANDS = new Set(['audit-context', 'doctor', 'fingerprint', 'ready', 'stale', 'status']);

export class ControllerError extends Error {}

const utcNow = () => new Date().toISOString();
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const DEFAULT_STALE_LOCK_SEC = 30;
const DEFAULT_LEASE_SEC = 1800;
const DEFAULT_ACTIVATION_TIMEOUT_SEC = 600;
const WORKSPACE_LEASE_VERSION = 1;
const ROOT_RESCUE_ROLE = 'main/root';
const NATIVE_AGENT_FINISHED = 'native_agent_finished';
const ROOT_RESCUE_SELF_COMPLETION = 'root_rescue_self_completion';
const NATIVE_AGENT_EXIT_CONFIRMED = 'native_agent_exit_confirmed';
const NATIVE_AGENT_START_FAILED = 'native_agent_start_failed';

function requiredString(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new ControllerError(`${name} must be a non-empty string`);
  return value.trim();
}

function requiredIdentifier(value, name) {
  const identifier = requiredString(value, name);
  if (!/^[A-Za-z][A-Za-z0-9._-]{0,79}$/.test(identifier)) throw new ControllerError(`${name} must use letters, digits, dot, underscore, or hyphen and start with a letter`);
  return identifier;
}

function optionalString(value, name) {
  if (value === undefined || value === null) return null;
  return requiredString(value, name);
}

function requiredStateDirectory(value) {
  const stateDir = requiredString(value, 'state_dir');
  if (!path.isAbsolute(stateDir)) throw new ControllerError('state_dir must be an absolute path');
  return path.resolve(stateDir);
}

function positiveInteger(value, name, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new ControllerError(`${name} must be a positive integer`);
  return parsed;
}

function trueValue(value, name) {
  if (value !== true && value !== 'true') throw new ControllerError(`${name} must be true`);
}

function retryConfirmation(parameters) {
  const hasCanonical = hasOwn(parameters, 'previous_agent_stopped');
  const hasLegacyAlias = hasOwn(parameters, 'previous_agents_stopped');
  if (!hasCanonical && !hasLegacyAlias) throw new ControllerError('previous_agent_stopped or previous_agents_stopped is required');
  const canonicalValue = hasCanonical && (parameters.previous_agent_stopped === true || parameters.previous_agent_stopped === 'true');
  const legacyValue = hasLegacyAlias && (parameters.previous_agents_stopped === true || parameters.previous_agents_stopped === 'true');
  if (hasCanonical && hasLegacyAlias && canonicalValue !== legacyValue) throw new ControllerError('previous_agent_stopped and previous_agents_stopped must not conflict');
  if (hasCanonical) trueValue(parameters.previous_agent_stopped, 'previous_agent_stopped');
  if (hasLegacyAlias) trueValue(parameters.previous_agents_stopped, 'previous_agents_stopped');
}

function nonEmptyReviewValue(value) {
  if (typeof value === 'string') return Boolean(value.trim());
  if (Array.isArray(value)) return value.length > 0;
  return Boolean(value) && typeof value === 'object' && Object.keys(value).length > 0;
}

function requiredReviewValue(value, name) {
  if (!nonEmptyReviewValue(value)) throw new ControllerError(`${name} must be a non-empty string, array, or object`);
  return value;
}

async function readJson(filePath, { label = 'JSON input', maxBytes = MAX_MANIFEST_BYTES } = {}) {
  try {
    const metadata = await fs.stat(filePath);
    if (!metadata.isFile()) throw new ControllerError(`${label} is not a regular file: ${filePath}`);
    if (metadata.size > maxBytes) throw new ControllerError(`${label} exceeds the ${maxBytes}-byte limit: ${filePath}`);
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') throw new ControllerError(`${label} does not exist: ${filePath}`);
    if (error instanceof SyntaxError) throw new ControllerError(`Invalid JSON in ${label}: ${error.message}`);
    throw error;
  }
}

async function atomicWrite(filePath, value, maxBytes = MAX_STATE_BYTES) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(serialized, 'utf8') > maxBytes) throw new ControllerError(`State exceeds the ${maxBytes}-byte limit: ${filePath}`);
  let handle;
  try {
    handle = await fs.open(temporary, 'wx');
    await handle.writeFile(serialized, 'utf8');
    await handle.sync();
    await handle.close(); handle = null;
    await fs.rename(temporary, filePath);
    handle = await fs.open(filePath, 'r+');
    await handle.sync();
    if (process.platform !== 'win32') {
      const directoryHandle = await fs.open(path.dirname(filePath), 'r');
      try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
    }
  } catch (error) {
    await handle?.close(); handle = null;
    await fs.unlink(temporary).catch(cleanupError => {
      if (cleanupError.code !== 'ENOENT') throw cleanupError;
    });
    throw error;
  } finally {
    await handle?.close();
  }
}

function statePath(stateDir, taskId) {
  requiredIdentifier(taskId, 'task_id');
  return path.join(path.resolve(stateDir), `${taskId}.json`);
}

function databasePath(filePath) {
  if (!filePath.endsWith('.json')) throw new ControllerError(`Invalid logical task state path: ${filePath}`);
  return `${filePath.slice(0, -'.json'.length)}${SQLITE_STATE_SUFFIX}`;
}

async function stateExists(filePath) {
  if (await taskStateExists(databasePath(filePath))) return true;
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function writeState(filePath, state) {
  let legacyStateExists = false;
  try {
    const legacyState = await fs.stat(filePath);
    if (!legacyState.isFile()) throw new ControllerError(`Legacy controller state is not a regular file: ${filePath}`);
    legacyStateExists = true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (legacyStateExists) {
    try {
      const archive = await fs.stat(`${filePath}.legacy`);
      if (!archive.isFile()) throw new ControllerError(`Legacy controller archive is not a regular file: ${filePath}.legacy`);
      throw new ControllerError(`Both legacy controller state and archive exist; resolve migration manually: ${filePath}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  await writeTaskState(databasePath(filePath), state);
  // A legacy file is retained as an immutable recovery copy after the SQLite commit succeeds.
  if (legacyStateExists) {
    try { await fs.rename(filePath, `${filePath}.legacy`); }
    catch (error) {
      if (error.code !== 'ENOENT') throw new ControllerError(`SQLite state committed but legacy state could not be archived: ${filePath}: ${error.message}`);
    }
  }
}

async function deleteState(filePath) {
  const taskId = path.basename(filePath, '.json');
  if (/^[A-Za-z][A-Za-z0-9._-]{0,79}$/.test(taskId)) {
    // Remove review evidence first; if this fails, keep the task indexable for a later sweep.
    await fs.rm(path.join(path.dirname(filePath), REVIEW_ARTIFACT_DIRECTORY, taskId), { recursive: true, force: true });
  }
  await deleteTaskState(databasePath(filePath));
  for (const suffix of ['', '.legacy']) {
    await fs.unlink(`${filePath}${suffix}`).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}


async function canonicalWorkspace(workspaceValue) {
  const requested = path.resolve(requiredString(workspaceValue, 'workspace'));
  let workspace;
  try { workspace = await fs.realpath(requested); } catch { throw new ControllerError(`Workspace is not a directory: ${requested}`); }
  let metadata;
  try { metadata = await fs.stat(workspace); } catch { throw new ControllerError(`Workspace is not a directory: ${workspace}`); }
  if (!metadata.isDirectory()) throw new ControllerError(`Workspace is not a directory: ${workspace}`);
  return workspace;
}

function workspaceLeasePath(workspace) {
  return path.join(workspace, '.codex', 'workflow-controller', 'workspace-lease.json');
}

async function sleep(milliseconds) { await new Promise(resolve => setTimeout(resolve, milliseconds)); }

async function lockDetails(lockPath) {
  const [text, metadata] = await Promise.all([fs.readFile(lockPath, 'utf8'), fs.stat(lockPath)]);
  const values = Object.fromEntries(text.trim().split(/\s+/).map(part => part.split('=', 2)).filter(([key, value]) => key && value));
  return {
    lockPath,
    pid: Number(values.pid),
    hostname: values.hostname,
    created: values.created,
    createdMs: Date.parse(values.created),
    ageMs: Date.now() - metadata.mtimeMs,
    identity: { dev: metadata.dev, ino: metadata.ino, size: metadata.size, mtimeMs: metadata.mtimeMs, ctimeMs: metadata.ctimeMs },
  };
}

function sameFileIdentity(expected, metadata) {
  return expected.dev === metadata.dev
    && expected.ino === metadata.ino
    && expected.size === metadata.size
    && expected.mtimeMs === metadata.mtimeMs
    && expected.ctimeMs === metadata.ctimeMs;
}

async function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

async function recoveryGuardExists(lockPath) {
  try { await fs.access(`${lockPath}.recover`); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function tryReclaimStaleCoordinationFile(intentPath, staleAfterSec = DEFAULT_STALE_LOCK_SEC) {
  let details;
  try { details = await lockDetails(intentPath); } catch (error) { if (error.code === 'ENOENT') return { reclaimed: false, reason: 'does not exist' }; throw error; }
  const staleAfterMs = positiveInteger(staleAfterSec, 'stale_after_sec', DEFAULT_STALE_LOCK_SEC) * 1000;
  if (!details.hostname || !Number.isSafeInteger(details.pid) || details.pid <= 0 || !Number.isFinite(details.createdMs) || Math.abs(details.identity.mtimeMs - details.createdMs) > 5_000) return { reclaimed: false, reason: 'untrusted metadata', details };
  if (details.hostname !== os.hostname()) return { reclaimed: false, reason: 'another host', details };
  if (details.ageMs < staleAfterMs) return { reclaimed: false, reason: 'younger than stale threshold', details };
  if (await processIsAlive(details.pid)) return { reclaimed: false, reason: 'owner is alive', details };
  let latestMetadata;
  try { latestMetadata = await fs.stat(intentPath); } catch (error) { if (error.code === 'ENOENT') return { reclaimed: false, reason: 'already removed' }; throw error; }
  if (!sameFileIdentity(details.identity, latestMetadata)) return { reclaimed: false, reason: 'changed while recovering', details };
  const recoveredPath = `${intentPath}.stale-${utcNow().replace(/[:.]/g, '-')}-${randomUUID()}`;
  try { await fs.rename(intentPath, recoveredPath); }
  catch (error) { if (error.code === 'ENOENT') return { reclaimed: false, reason: 'already removed' }; throw error; }
  return { reclaimed: true, recovered_path: recoveredPath, prior_lock: details };
}

async function acquireReclaimGuard(intentPath) {
  const guardPath = `${intentPath}.reclaim`;
  try {
    const handle = await fs.open(guardPath, 'wx');
    await handle.writeFile(`pid=${process.pid} hostname=${os.hostname()} created=${utcNow()}\n`);
    return { handle, guardPath };
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const recovered = await tryReclaimStaleCoordinationFile(guardPath);
    if (recovered.reclaimed) return acquireReclaimGuard(intentPath);
    return null;
  }
}

async function reclaimStaleCoordinationFile(intentPath, staleAfterSec = DEFAULT_STALE_LOCK_SEC) {
  const guard = await acquireReclaimGuard(intentPath);
  if (!guard) return { reclaimed: false, reason: 'recovery in progress' };
  try { return await tryReclaimStaleCoordinationFile(intentPath, staleAfterSec); }
  finally { await releaseIntent(guard.handle, guard.guardPath); }
}

async function ensureNoRecoveryGuard(lockPath) {
  if (!await recoveryGuardExists(lockPath)) return;
  const result = await reclaimStaleCoordinationFile(`${lockPath}.recover`);
  if (result.reclaimed || !await recoveryGuardExists(lockPath)) return;
  throw new ControllerError(`Task recovery is in progress: ${lockPath}`);
}

async function coordinationIntentExists(lockPath) {
  for (const suffix of ['.writer', '.release']) {
    try { await fs.access(`${lockPath}${suffix}`); return true; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return false;
}

async function waitForRecoveryGuardRelease(lockPath, deadline) {
  while (await recoveryGuardExists(lockPath)) {
    const reclaimed = await reclaimStaleCoordinationFile(`${lockPath}.recover`);
    if (reclaimed.reclaimed) continue;
    if (Date.now() >= deadline) throw new ControllerError(`Task recovery is still in progress: ${lockPath}`);
    await sleep(25);
  }
}

async function waitForCoordinationIntents(lockPath, deadline) {
  while (await coordinationIntentExists(lockPath)) {
    for (const suffix of ['.writer', '.release']) await reclaimStaleCoordinationFile(`${lockPath}${suffix}`);
    if (!await coordinationIntentExists(lockPath)) return;
    if (Date.now() >= deadline) throw new ControllerError(`Lock turnover is still in progress: ${lockPath}`);
    await sleep(25);
  }
}

async function acquireIntent(intentPath, deadline) {
  let handle;
  while (!handle) {
    try { handle = await fs.open(intentPath, 'wx'); await handle.writeFile(`pid=${process.pid} hostname=${os.hostname()} created=${utcNow()}\n`); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const reclaimed = await reclaimStaleCoordinationFile(intentPath);
      if (reclaimed.reclaimed) continue;
      if (Date.now() >= deadline) throw new ControllerError(`Lock turnover is busy: ${intentPath}`);
      await sleep(25);
    }
  }
  return handle;
}

async function releaseIntent(handle, intentPath) {
  await handle.close();
  await fs.unlink(intentPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
}

async function acquireRecoveryGuard(lockPath) {
  const recoveryGuardPath = `${lockPath}.recover`;
  try {
    const handle = await fs.open(recoveryGuardPath, 'wx');
    await handle.writeFile(`pid=${process.pid} hostname=${os.hostname()} created=${utcNow()}\n`);
    return { handle, recoveryGuardPath };
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const reclaimed = await reclaimStaleCoordinationFile(recoveryGuardPath);
    if (reclaimed.reclaimed) return acquireRecoveryGuard(lockPath);
    throw new ControllerError(`Stale-lock recovery is already in progress: ${lockPath}`);
  }
}

async function recoverStaleLock(filePath, staleAfterSec) {
  const lockPath = `${filePath}.lock`;
  const { handle: recoveryGuard, recoveryGuardPath } = await acquireRecoveryGuard(lockPath);
  try {
    await waitForCoordinationIntents(lockPath, Date.now() + 10_000);
    let details;
    try { details = await lockDetails(lockPath); } catch (error) { if (error.code === 'ENOENT') return { recovered: false, reason: 'no lock exists' }; throw error; }
    const recovered = await reclaimStaleCoordinationFile(lockPath, staleAfterSec);
    if (!recovered.reclaimed) {
      if (recovered.reason === 'another host') throw new ControllerError(`Cannot prove a lock from another host is stale: ${lockPath}`);
      if (recovered.reason === 'younger than stale threshold') throw new ControllerError(`Lock is younger than stale_after_sec: ${lockPath}`);
      if (recovered.reason === 'owner is alive') throw new ControllerError(`Lock owner is still alive: ${lockPath}`);
      throw new ControllerError(`Cannot safely recover lock: ${lockPath} (${recovered.reason})`);
    }
    return { recovered: true, recovered_lock_path: recovered.recovered_path, prior_lock: details };
  } finally {
    await releaseIntent(recoveryGuard, recoveryGuardPath);
  }
}

async function withStateLock(filePath, callback) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const lockPath = `${filePath}.lock`;
  const deadline = Date.now() + 10_000;
  let handle;
  const writerIntentPath = `${lockPath}.writer`;
  const writerIntent = await acquireIntent(writerIntentPath, deadline);
  try {
    await ensureNoRecoveryGuard(lockPath);
    while (!handle) {
      try {
      handle = await fs.open(lockPath, 'wx');
      await handle.writeFile(`pid=${process.pid} hostname=${os.hostname()} created=${utcNow()}\n`);
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        await ensureNoRecoveryGuard(lockPath);
        if (Date.now() >= deadline) throw new ControllerError(`Task state is busy: ${filePath}`);
        await sleep(100);
      }
    }
  } finally {
    await releaseIntent(writerIntent, writerIntentPath);
  }
  try {
    return await callback();
  } finally {
    const releaseIntentPath = `${lockPath}.release`;
    let releaseHandle = await acquireIntent(releaseIntentPath, Date.now() + 10_000);
    try {
      while (await recoveryGuardExists(lockPath)) {
        await releaseIntent(releaseHandle, releaseIntentPath);
        releaseHandle = null;
        await waitForRecoveryGuardRelease(lockPath, Date.now() + 10_000);
        releaseHandle = await acquireIntent(releaseIntentPath, Date.now() + 10_000);
      }
      await handle.close();
      await fs.unlink(lockPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
    } finally {
      if (releaseHandle) await releaseIntent(releaseHandle, releaseIntentPath);
    }
  }
}

async function loadState(filePath) {
  let state = await readTaskState(databasePath(filePath));
  if (state === null) state = await readJson(filePath, { label: 'Controller state', maxBytes: MAX_STATE_BYTES });
  if (!state || typeof state !== 'object' || state.version !== VERSION) throw new ControllerError(`Unsupported controller state: ${filePath}`);
  return state;
}

function addEvent(state, type, details = {}) {
  state.events ??= [];
  state.events.push({ at: utcNow(), type, ...details });
  state.updated_at = utcNow();
}

async function walkFiles(root, directory = root, files = []) {
  let entries;
  try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch (error) { throw new ControllerError(`Workspace is not a directory: ${root}`); }
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!isIgnoredFingerprintDirectory(entry.name)) await walkFiles(root, path.join(directory, entry.name), files);
    } else if (entry.isSymbolicLink()) {
      throw new ControllerError(`Workspace contains a symbolic link that cannot be fingerprinted safely: ${entryPath}`);
    } else if (entry.isFile()) {
      files.push(path.relative(root, path.join(directory, entry.name)));
      if (files.length > MAX_FINGERPRINT_FILES) throw new ControllerError(`Workspace exceeds the ${MAX_FINGERPRINT_FILES}-file fingerprint limit`);
    }
  }
  return files;
}

function isIgnoredFingerprintDirectory(name) {
  // Package-manager caches are derived download artifacts, like node_modules.
  // They may be populated while verification runs and must not invalidate a
  // source review or make the fingerprint traverse a large transient cache.
  return IGNORED_DIRECTORIES.has(name) || name === '.yarn' || name.startsWith('.yarn-cache');
}

class WorkspaceChangedDuringFingerprint extends Error {}

function fixedLength(value) {
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(value));
  return length;
}

function framedString(hash, value) {
  const bytes = Buffer.from(value, 'utf8');
  hash.update(fixedLength(bytes.length));
  hash.update(bytes);
}

function sameFingerprintMetadata(left, right) {
  return left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

async function fingerprintItem(root, relativePath) {
  const filePath = path.join(root, relativePath);
  const before = await fs.stat(filePath);
  if (!before.isFile()) throw new WorkspaceChangedDuringFingerprint(`File changed type while fingerprinting: ${filePath}`);
  if (before.size > MAX_FINGERPRINT_FILE_BYTES) throw new ControllerError(`Workspace file exceeds the ${MAX_FINGERPRINT_FILE_BYTES}-byte fingerprint limit: ${filePath}`);
  const item = createHash('sha256');
  framedString(item, 'file');
  framedString(item, relativePath.split(path.sep).join('/'));
  item.update(fixedLength(before.size));
  for await (const chunk of createReadStream(filePath)) item.update(chunk);
  const after = await fs.stat(filePath);
  if (!sameFingerprintMetadata(before, after)) throw new WorkspaceChangedDuringFingerprint(`File changed while fingerprinting: ${filePath}`);
  return { digest: item.digest(), bytes: before.size };
}

async function fingerprintAttempt(workspace) {
  const files = (await walkFiles(workspace)).sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  const digest = createHash('sha256');
  let totalBytes = 0;
  for (const relative of files) {
    const item = await fingerprintItem(workspace, relative);
    totalBytes += item.bytes;
    if (totalBytes > MAX_FINGERPRINT_TOTAL_BYTES) throw new ControllerError(`Workspace exceeds the ${MAX_FINGERPRINT_TOTAL_BYTES}-byte fingerprint limit`);
    digest.update(item.digest);
  }
  const after = (await walkFiles(workspace)).sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  if (files.length !== after.length || files.some((entry, index) => entry !== after[index])) throw new WorkspaceChangedDuringFingerprint('Workspace file set changed while fingerprinting');
  return { algorithm: 'sha256-item-v1', value: digest.digest('hex'), file_count: files.length, total_bytes: totalBytes };
}

export async function workspaceFingerprint(workspaceValue) {
  const workspace = await canonicalWorkspace(workspaceValue);
  for (let attempt = 1; attempt <= FINGERPRINT_ATTEMPTS; attempt++) {
    try { return await fingerprintAttempt(workspace); }
    catch (error) {
      if (!(error instanceof WorkspaceChangedDuringFingerprint) || attempt === FINGERPRINT_ATTEMPTS) {
        if (error instanceof WorkspaceChangedDuringFingerprint) throw new ControllerError(`Workspace did not stabilize after ${FINGERPRINT_ATTEMPTS} fingerprint attempts: ${error.message}`);
        throw error;
      }
    }
  }
  throw new ControllerError('Workspace fingerprint did not complete');
}

function validateNodes(nodes) {
  const visiting = new Set();
  const visited = new Set();
  const visit = nodeId => {
    if (visited.has(nodeId)) return;
    if (visiting.has(nodeId)) throw new ControllerError(`Task DAG contains a cycle at node ${nodeId}`);
    const dependencies = nodes[nodeId].depends_on ?? [];
    if (!Array.isArray(dependencies) || dependencies.some(dependency => !hasOwn(nodes, dependency))) throw new ControllerError(`Node ${nodeId} has an unknown dependency`);
    visiting.add(nodeId);
    dependencies.forEach(visit);
    visiting.delete(nodeId);
    visited.add(nodeId);
  };
  Object.keys(nodes).forEach(visit);
  const delegableOwners = new Set();
  for (const node of Object.values(nodes)) {
    if (node.execution_risk !== 'delegable') continue;
    if (delegableOwners.has(node.execution_owner)) throw new ControllerError(`Delegable nodes must have distinct execution_owner values: ${node.execution_owner}`);
    delegableOwners.add(node.execution_owner);
  }
}

function validateTotalReviewTopology(nodes) {
  const allNodes = Object.values(nodes);
  const reviews = allNodes.filter(node => node.kind === 'total_review');
  if (reviews.length !== 1) throw new ControllerError('A new task manifest must contain exactly one total_review node');
  const review = reviews[0];
  const expectedDependencies = allNodes.filter(node => node.id !== review.id).map(node => node.id).sort();
  const actualDependencies = [...new Set(review.depends_on)].sort();
  if (expectedDependencies.length !== actualDependencies.length || expectedDependencies.some((id, index) => id !== actualDependencies[index])) {
    throw new ControllerError('The total_review node must directly depend on every non-review node');
  }
  if (allNodes.some(node => node.id !== review.id && node.depends_on.includes(review.id))) {
    throw new ControllerError('No node may depend on total_review');
  }
}

export function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function workflowSnapshot(state) {
  const materialNodes = Object.values(state.nodes)
    .filter(node => node.kind !== 'total_review')
    .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
    .map(node => ({
      id: node.id,
      kind: node.kind,
      agent_type: node.agent_type,
      depends_on: [...node.depends_on].sort(),
      execution_risk: node.execution_risk,
      routing_reason: node.routing_reason,
      execution_owner: node.execution_owner,
      integration_owner: node.integration_owner,
      quality_guard: node.quality_guard,
      status: node.status,
      result: node.result,
    }));
  const material = {
    task_id: state.task_id,
    goal: state.goal,
    requirements: [...state.requirements].sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
    scope: state.scope,
    non_goals: state.non_goals,
    nodes: materialNodes,
  };
  return {
    workflow_revision: state.workflow_revision ?? 0,
    digest_algorithm: 'sha256-stable-json-v1',
    digest: createHash('sha256').update(stableJson(material)).digest('hex'),
  };
}

export function sameJson(left, right) { return stableJson(left) === stableJson(right); }

function bumpWorkflowRevision(state, eventType, details = {}) {
  state.workflow_revision = (state.workflow_revision ?? 0) + 1;
  addEvent(state, eventType, { ...details, workflow_revision: state.workflow_revision });
}

function nodeRouting(raw, routingRequired) {
  const supplied = ROUTING_FIELDS.filter(field => hasOwn(raw, field));
  if (!supplied.length) {
    if (routingRequired) throw new ControllerError(`node requires routing fields: ${ROUTING_FIELDS.join(', ')}`);
    // Legacy manifests remain runnable only as protected work; they cannot authorize a Luna executor.
    return {
      execution_risk: 'protected',
      routing_reason: 'legacy manifest omitted routing audit fields; Luna executor delegation is prohibited',
      execution_owner: null,
      integration_owner: null,
      quality_guard: 'legacy routing metadata unavailable',
      routing_legacy: true,
    };
  }
  if (supplied.length !== ROUTING_FIELDS.length) throw new ControllerError(`node routing fields must be complete: ${ROUTING_FIELDS.join(', ')}`);
  const executionRisk = requiredString(raw.execution_risk, 'node.execution_risk');
  if (!['read_only', 'delegable', 'protected'].includes(executionRisk)) throw new ControllerError('node.execution_risk must be read_only, delegable, or protected');
  return {
    execution_risk: executionRisk,
    routing_reason: requiredString(raw.routing_reason, 'node.routing_reason'),
    execution_owner: requiredString(raw.execution_owner, 'node.execution_owner'),
    integration_owner: requiredString(raw.integration_owner, 'node.integration_owner'),
    quality_guard: requiredString(raw.quality_guard, 'node.quality_guard'),
    routing_legacy: false,
  };
}

function nodeRecord(raw, options = {}) {
  if (!raw || typeof raw !== 'object') throw new ControllerError('Each node must be an object');
  const id = requiredIdentifier(raw.id, 'node.id'); const kind = requiredString(raw.kind, 'node.kind');
  if (raw.agent_type !== undefined && raw.agent_type !== null) requiredString(raw.agent_type, 'node.agent_type');
  const dependencies = raw.depends_on ?? [];
  if (!Array.isArray(dependencies) || dependencies.some(dependency => typeof dependency !== 'string' || !dependency.trim())) throw new ControllerError('node.depends_on must contain non-empty string identifiers');
  return { id, kind, agent_type: raw.agent_type ?? null, depends_on: dependencies, ...nodeRouting(raw, options.routingRequired === true), rescue_role: null, rescue_reason: null, rescued_at: null, rescue_count: 0, status: PENDING, agent_task_path: null, agent_thread_id: null, agent_role: null, claim_id: null, claimed_at: null, activation_at: null, activation_deadline_at: null, heartbeat_at: null, heartbeat_count: 0, lease_duration_sec: null, attempt: 0, result: null, checkpoint: null, checkpoint_at: null, workflow_completion_intent: null, recovery_history: [] };
}

function normalizeState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new ControllerError('Task state must be an object');
  if (!state.nodes || typeof state.nodes !== 'object' || Array.isArray(state.nodes) || !Object.keys(state.nodes).length) throw new ControllerError('Task state must contain nodes');
  state.workflow_revision ??= 0;
  state.closed_revision ??= null;
  state.closed_at ??= null;
  for (const [nodeId, node] of Object.entries(state.nodes)) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) throw new ControllerError(`Task node must be an object: ${nodeId}`);
    if (node.id !== nodeId) throw new ControllerError(`Task node key and id must match: ${nodeId}`);
    node.agent_thread_id ??= null; node.agent_role ??= null; node.claim_id ??= null; node.claimed_at ??= null; node.activation_at ??= null; node.activation_deadline_at ??= null; node.heartbeat_at ??= null;
    node.lease_duration_sec ??= null; node.heartbeat_count ??= 0; node.attempt ??= node.agent_task_path ? 1 : 0;
    node.checkpoint ??= null; node.checkpoint_at ??= null; node.recovery_history ??= []; node.workflow_completion_intent ??= null;
    node.rescue_role ??= null; node.rescue_reason ??= null; node.rescued_at ??= null; node.rescue_count ??= 0;
    if (!hasOwn(node, 'execution_risk')) Object.assign(node, nodeRouting(node, false));
  }
  validateNodes(state.nodes);
  validateTotalReviewTopology(state.nodes);
  return state;
}

async function makeState(manifest) {
  const required = ['task_id', 'workspace', 'goal', 'requirements'];
  if (!manifest || typeof manifest !== 'object' || required.some(key => !hasOwn(manifest, key))) throw new ControllerError('Manifest requires task_id, workspace, goal, and requirements');
  const taskId = requiredIdentifier(manifest.task_id, 'task_id');
  const routingSchemaVersion = manifest.routing_schema_version ?? 0;
  if (routingSchemaVersion !== 0 && routingSchemaVersion !== 1) throw new ControllerError('routing_schema_version must be 1 when provided');
  const workspace = await canonicalWorkspace(manifest.workspace);
  const goal = requiredString(manifest.goal, 'goal');
  await workspaceFingerprint(workspace);
  if (!Array.isArray(manifest.requirements) || !manifest.requirements.length || manifest.requirements.length > MAX_REQUIREMENTS) throw new ControllerError(`Manifest requires between 1 and ${MAX_REQUIREMENTS} requirements`);
  const requirements = manifest.requirements.map(item => {
    if (!item || typeof item !== 'object') throw new ControllerError('Each requirement must be an object');
    return { ...item, id: requiredIdentifier(item.id, 'requirement.id'), text: requiredString(item.text, 'requirement.text') };
  });
  const ids = requirements.map(item => item.id);
  if (new Set(ids).size !== ids.length) throw new ControllerError('Each requirement needs a unique id and non-empty text');
  if (!Array.isArray(manifest.nodes) || !manifest.nodes.length || manifest.nodes.length > MAX_NODES) throw new ControllerError(`Manifest requires between 1 and ${MAX_NODES} nodes`);
  const nodes = Object.create(null);
  for (const rawNode of manifest.nodes ?? []) {
    const node = nodeRecord(rawNode, { routingRequired: routingSchemaVersion === 1 });
    if (hasOwn(nodes, node.id)) throw new ControllerError(`Duplicate node id: ${node.id}`);
    nodes[node.id] = node;
  }
  validateNodes(nodes);
  validateTotalReviewTopology(nodes);
  const created = utcNow();
  return { version: VERSION, routing_schema_version: routingSchemaVersion || null, task_id: taskId, workspace, goal, requirements, scope: manifest.scope ?? [], non_goals: manifest.non_goals ?? [], nodes, participants: [], reviews: [], events: [{ at: created, type: 'task_initialized', workflow_revision: 0 }], workflow_revision: 0, closed_revision: null, closed_at: null, created_at: created, updated_at: created };
}

function readyNodes(state) {
  return Object.values(state.nodes).filter(node => node.status === PENDING && node.depends_on.every(dependency => [SUCCEEDED, 'skipped'].includes(state.nodes[dependency].status)));
}

function participantPaths(state) { return new Set(state.participants.map(item => item.agent_task_path)); }
function runningParticipantPaths(state) { return new Set(Object.values(state.nodes).filter(node => node.status === RUNNING && node.agent_task_path).map(node => node.agent_task_path)); }
function configuredStatePath(parameters, taskId) { return statePath(requiredStateDirectory(parameters.state_dir), taskId); }
async function readTask(parameters) { const filePath = configuredStatePath(parameters, requiredString(parameters.task_id, 'task_id')); return [filePath, normalizeState(await loadState(filePath))]; }

function activationDeadline(node) {
  const stored = Date.parse(node.activation_deadline_at);
  if (Number.isFinite(stored)) return stored;
  const claimed = Date.parse(node.claimed_at);
  if (!Number.isFinite(claimed)) return null;
  return claimed + Math.min(DEFAULT_ACTIVATION_TIMEOUT_SEC, node.lease_duration_sec ?? DEFAULT_LEASE_SEC) * 1000;
}

function staleNodes(state, now = Date.now()) {
  return Object.values(state.nodes).flatMap(node => {
    if (node.status !== RUNNING || !node.lease_duration_sec) return [];
    if (!node.activation_at || node.heartbeat_count === 0) {
      const deadline = activationDeadline(node);
      if (deadline === null || deadline >= now) return [];
      return [{ id: node.id, agent_task_path: node.agent_task_path, agent_thread_id: node.agent_thread_id, claim_id: node.claim_id, reason: 'never_activated', claimed_at: node.claimed_at, activation_deadline_at: new Date(deadline).toISOString(), lease_duration_sec: node.lease_duration_sec }];
    }
    const heartbeat = Date.parse(node.heartbeat_at);
    if (!Number.isFinite(heartbeat) || heartbeat + node.lease_duration_sec * 1000 >= now) return [];
    return [{ id: node.id, agent_task_path: node.agent_task_path, agent_thread_id: node.agent_thread_id, claim_id: node.claim_id, reason: 'heartbeat_expired', heartbeat_at: node.heartbeat_at, lease_duration_sec: node.lease_duration_sec }];
  });
}

function compactState(state) {
  return { task_id: state.task_id, workspace: state.workspace, workspace_lease: state.workspace_lease ?? null, goal: state.goal, nodes: Object.values(state.nodes), ready_nodes: readyNodes(state), stale_nodes: staleNodes(state), participants: state.participants, reviews: state.reviews, updated_at: state.updated_at };
}

async function coordinationStatus(lockPath) {
  const files = [];
  for (const suffix of ['', '.writer', '.release', '.recover']) {
    const candidate = `${lockPath}${suffix}`;
    try {
      const details = await lockDetails(candidate);
      let owner_alive = null;
      if (details.hostname === os.hostname()) {
        try { owner_alive = await processIsAlive(details.pid); }
        catch { owner_alive = null; }
      }
      files.push({ path: candidate, kind: suffix || '.lock', present: true, hostname: details.hostname || null, pid: Number.isSafeInteger(details.pid) ? details.pid : null, created_at: details.created || null, age_ms: details.ageMs, owner_alive });
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      files.push({ path: candidate, kind: suffix || '.lock', present: true, readable: false, error: error.message });
    }
  }
  return files;
}

function doctorCheck(id, status, detail) { return { id, status, detail }; }

async function unreadableDoctor(parameters, filePath, error) {
  const database = databasePath(filePath);
  let databaseDetail = { path: database, error: error.message };
  try {
    const metadata = await fs.stat(database);
    databaseDetail = { path: database, bytes: metadata.size, modified_at: metadata.mtime.toISOString(), error: error.message };
  } catch (statError) {
    if (statError.code !== 'ENOENT') databaseDetail = { path: database, error: `${error.message}; ${statError.message}` };
  }
  const coordinationFiles = await coordinationStatus(`${filePath}.lock`);
  return {
    task_id: requiredString(parameters.task_id, 'task_id'),
    workspace: null,
    health: 'blocked',
    checks: [
      doctorCheck('state_database', 'fail', databaseDetail),
      doctorCheck('task_state', 'fail', { path: filePath, error: error.message }),
      doctorCheck('coordination', coordinationFiles.length ? 'attention' : 'pass', { files: coordinationFiles }),
    ],
    recovery_candidates: [],
    close_status: { close_allowed: false, reasons: [`task state is unreadable: ${error.message}`] },
  };
}

async function quarantinedDoctor(parameters, filePath, metadata) {
  const coordinationFiles = await coordinationStatus(`${filePath}.lock`);
  return {
    task_id: requiredString(parameters.task_id, 'task_id'),
    workspace: null,
    health: 'blocked',
    checks: [
      doctorCheck('quarantined_state', 'fail', {
        state_path: filePath,
        error_path: metadata.error_path,
        reason: metadata.reason,
        status: metadata.status,
        quarantined_at: metadata.quarantined_at,
        delete_after: metadata.delete_after,
        files: metadata.files,
        move_error: metadata.move_error,
      }),
      doctorCheck('coordination', coordinationFiles.length ? 'attention' : 'pass', { files: coordinationFiles }),
    ],
    recovery_candidates: [],
    close_status: { close_allowed: false, reasons: [`task state is quarantined until ${metadata.delete_after}`] },
  };
}

async function doctorTask(parameters) {
  if (parameters.task_id === undefined || parameters.task_id === null) return doctorStateDirectory(parameters);
  const filePath = configuredStatePath(parameters, requiredString(parameters.task_id, 'task_id'));
  let state;
  try { state = normalizeState(await loadState(filePath)); }
  catch (error) {
    const metadata = await findQuarantinedState(path.dirname(filePath), filePath);
    if (metadata) return quarantinedDoctor(parameters, filePath, metadata);
    return unreadableDoctor(parameters, filePath, error);
  }
  const checks = [];
  const database = databasePath(filePath);
  try {
    const metadata = await fs.stat(database);
    checks.push(doctorCheck('state_database', 'pass', { path: database, bytes: metadata.size, modified_at: metadata.mtime.toISOString() }));
  } catch (error) {
    if (error.code === 'ENOENT') checks.push(doctorCheck('state_database', 'attention', { path: database, reason: 'legacy JSON state is in use' }));
    else checks.push(doctorCheck('state_database', 'fail', { path: database, error: error.message }));
  }

  if (!state.workspace_lease) {
    checks.push(doctorCheck('workspace_lease', 'attention', { reason: 'legacy task has no workspace lease' }));
  } else {
    try {
      const lease = await loadWorkspaceLease(state.workspace_lease.registry_path, state.workspace);
      const active = state.workspace_lease.status === 'active';
      const released = state.workspace_lease.status === 'released';
      const matches = active ? workspaceLeaseMatches(lease, state, filePath) : released && lease.active_task === null;
      checks.push(doctorCheck('workspace_lease', matches ? 'pass' : 'fail', {
        path: state.workspace_lease.registry_path,
        task_status: state.workspace_lease.status,
        registry_active_task: lease.active_task?.task_id ?? null,
        reason: matches ? null : 'workspace lease does not match task state',
      }));
    } catch (error) {
      checks.push(doctorCheck('workspace_lease', 'fail', { path: state.workspace_lease.registry_path, error: error.message }));
    }
  }

  const stale = staleNodes(state);
  checks.push(doctorCheck('running_nodes', stale.length ? 'attention' : 'pass', {
    running: Object.values(state.nodes).filter(node => node.status === RUNNING).map(node => node.id),
    stale: stale.map(node => ({ id: node.id, reason: node.reason, claim_id: node.claim_id })),
  }));
  const coordination_files = await coordinationStatus(`${filePath}.lock`);
  checks.push(doctorCheck('coordination', coordination_files.length ? 'attention' : 'pass', { files: coordination_files }));

  let closeStatus;
  try {
    const closeReasonsList = await closeReasons(state);
    closeStatus = { close_allowed: closeReasonsList.length === 0, reasons: closeReasonsList };
  } catch (error) {
    checks.push(doctorCheck('close_gate', 'fail', { error: error.message }));
    closeStatus = { close_allowed: false, reasons: [`close check unavailable: ${error.message}`] };
  }
  const failed = checks.some(check => check.status === 'fail');
  const attention = checks.some(check => check.status === 'attention');
  return {
    task_id: state.task_id,
    workspace: state.workspace,
    health: failed ? 'blocked' : attention ? 'attention' : 'healthy',
    checks,
    recovery_candidates: stale.map(node => ({
      node_id: node.id,
      claim_id: node.claim_id,
      reason: node.reason,
      required_actions: ['确认旧原生代理已停止且不再写入工作区', '创建新的替代代理实例', '使用 replacement_agent_task_path 和 previous_agent_stopped=true 调用 workflow_requeue_stale'],
      automatic_requeue: 'controller cannot prove native agent termination or create a Codex agent; the coordinator must perform these actions before requeueing',
    })),
    close_status: closeStatus,
  };
}

async function loadWorkspaceLease(leasePath, workspace) {
  try {
    const lease = await readJson(leasePath);
    if (!lease || typeof lease !== 'object' || lease.version !== WORKSPACE_LEASE_VERSION || lease.workspace !== workspace || !hasOwn(lease, 'active_task')) throw new ControllerError(`Unsupported workspace lease: ${leasePath}`);
    return lease;
  } catch (error) {
    if (error instanceof ControllerError && error.message.startsWith('JSON input does not exist:')) return { version: WORKSPACE_LEASE_VERSION, workspace, active_task: null, updated_at: utcNow() };
    throw error;
  }
}

function workspaceLeaseMatches(lease, state, filePath) {
  return lease.active_task
    && lease.active_task.task_id === state.task_id
    && lease.active_task.state_path === filePath
    && (lease.active_task.phase ?? 'active') === 'active';
}

async function requireActiveWorkspaceLease(state, filePath) {
  if (!state.workspace_lease) throw new ControllerError('Legacy task has no workspace lease and cannot change state; create a new workflow task');
  if (state.workspace_lease.status !== 'active') throw new ControllerError(`Workspace lease is not active for this task: ${state.workspace_lease.registry_path}`);
  const lease = await loadWorkspaceLease(state.workspace_lease.registry_path, state.workspace);
  if (!workspaceLeaseMatches(lease, state, filePath)) throw new ControllerError(`Workspace lease does not belong to this active task: ${state.workspace_lease.registry_path}`);
  return lease;
}

async function releaseWorkspaceLease(parameters, { closeAllowed = false } = {}) {
  const filePath = configuredStatePath(parameters, requiredString(parameters.task_id, 'task_id'));
  const initialState = await loadState(filePath);
  const stateLease = initialState.workspace_lease;
  if (!stateLease) return { released: false, reason: 'legacy task has no workspace lease' };
  if (!stateLease || typeof stateLease !== 'object' || typeof initialState.workspace !== 'string' || !path.isAbsolute(initialState.workspace)
    || typeof stateLease.registry_path !== 'string' || !path.isAbsolute(stateLease.registry_path)
    || path.resolve(stateLease.registry_path) !== workspaceLeasePath(initialState.workspace)
    || stateLease.state_path !== filePath) throw new ControllerError('Cannot release workspace lease: lease metadata is not a complete matching registry');
  const leasePath = stateLease.registry_path;
  return withStateLock(leasePath, async () => withStateLock(filePath, async () => {
    const state = await loadState(filePath);
    if (!state.nodes || typeof state.nodes !== 'object' || Array.isArray(state.nodes)) throw new ControllerError('Cannot release workspace lease: task nodes are unreadable');
    const unknownNodes = Object.values(state.nodes).filter(node => !node || typeof node !== 'object' || ![PENDING, RUNNING, ...TERMINAL].includes(node.status));
    if (unknownNodes.length) throw new ControllerError('Cannot release workspace lease while node statuses are unknown');
    const running = Object.values(state.nodes).filter(node => node.status === RUNNING).map(node => node.id);
    if (running.length) throw new ControllerError(`Cannot release workspace lease while nodes are running: ${running.join(', ')}`);
    if (!closeAllowed) trueValue(parameters.previous_agents_stopped, 'previous_agents_stopped');
    const lease = await loadWorkspaceLease(leasePath, state.workspace);
    if (state.workspace_lease.status === 'released' && !lease.active_task) return { released: true, already_released: true, lease_path: leasePath };
    if (!workspaceLeaseMatches(lease, state, filePath)) throw new ControllerError(`Workspace lease does not belong to this active task: ${leasePath}`);
    if (state.workspace_lease.status !== 'released') {
      state.workflow_revision ??= 0; state.events ??= []; state.updated_at = utcNow();
      state.workspace_lease.status = 'released'; state.workspace_lease.released_at = utcNow();
      addEvent(state, 'workspace_lease_released', { close_allowed: closeAllowed }); await writeState(filePath, state);
    }
    lease.active_task = null; lease.updated_at = utcNow(); await atomicWrite(leasePath, lease);
    return { released: true, lease_path: leasePath };
  }));
}

async function initTask(parameters) {
  const manifest = await readJson(parameters.manifest, { label: 'Manifest', maxBytes: MAX_MANIFEST_BYTES });
  const state = await makeState(manifest);
  const filePath = configuredStatePath(parameters, state.task_id);
  const leasePath = workspaceLeasePath(state.workspace);
  state.workspace_lease = { registry_path: leasePath, state_path: filePath, status: 'active', acquired_at: utcNow() };
  await withStateLock(leasePath, async () => {
    const lease = await loadWorkspaceLease(leasePath, state.workspace);
    if (lease.active_task) throw new ControllerError(`Workspace already has an active workflow task: ${lease.active_task.task_id} (${lease.active_task.state_path})`);
    await withStateLock(filePath, async () => {
      if (await stateExists(filePath)) throw new ControllerError(`Task already exists: ${state.task_id}`);
      lease.active_task = { task_id: state.task_id, state_path: filePath, state_dir: path.dirname(filePath), acquired_at: state.workspace_lease.acquired_at, phase: 'initializing' };
      lease.updated_at = utcNow(); await atomicWrite(leasePath, lease);
      try { await writeState(filePath, state); }
      catch (error) {
        lease.active_task = null; lease.updated_at = utcNow(); await atomicWrite(leasePath, lease);
        throw error;
      }
    });
    lease.active_task.phase = 'active'; lease.updated_at = utcNow();
    try { await atomicWrite(leasePath, lease); }
    catch (error) {
      await deleteState(filePath);
      lease.active_task = null; lease.updated_at = utcNow(); await atomicWrite(leasePath, lease);
      throw error;
    }
  });
  return { state_path: filePath, task: compactState(state) };
}

async function reconcileWorkspace(parameters) {
  const workspace = await canonicalWorkspace(parameters.workspace);
  const leasePath = workspaceLeasePath(workspace);
  return withStateLock(leasePath, async () => {
    const lease = await loadWorkspaceLease(leasePath, workspace);
    if (!lease.active_task) return { workspace, lease_path: leasePath, reconciled: false, reason: 'no active task' };
    if ((lease.active_task.phase ?? 'active') === 'active') return { workspace, lease_path: leasePath, reconciled: false, reason: 'active task is already consistent', active_task: lease.active_task };
    if (lease.active_task.phase !== 'initializing') throw new ControllerError(`Unsupported workspace lease phase: ${lease.active_task.phase}`);
    let state;
    try { state = normalizeState(await loadState(lease.active_task.state_path)); }
    catch (error) {
      if (error instanceof ControllerError && error.message.startsWith('JSON input does not exist:')) {
        lease.active_task = null; lease.updated_at = utcNow(); await atomicWrite(leasePath, lease);
        return { workspace, lease_path: leasePath, reconciled: true, action: 'cleared_missing_initialization' };
      }
      throw error;
    }
    if (state.task_id !== lease.active_task.task_id || state.workspace !== workspace || state.workspace_lease?.registry_path !== leasePath || state.workspace_lease?.state_path !== lease.active_task.state_path || state.workspace_lease?.acquired_at !== lease.active_task.acquired_at) throw new ControllerError(`Initializing workspace lease does not match its task state: ${leasePath}`);
    if (state.workspace_lease.status === 'released') {
      lease.active_task = null; lease.updated_at = utcNow(); await atomicWrite(leasePath, lease);
      return { workspace, lease_path: leasePath, reconciled: true, action: 'cleared_released_initialization' };
    }
    if (state.workspace_lease.status !== 'active') throw new ControllerError(`Initializing task state has unsupported lease status: ${state.workspace_lease.status}`);
    lease.active_task.phase = 'active'; lease.updated_at = utcNow(); await atomicWrite(leasePath, lease);
    return { workspace, lease_path: leasePath, reconciled: true, action: 'activated_existing_initialization', active_task: lease.active_task };
  });
}

async function addNode(parameters) {
  void parameters;
  throw new ControllerError('Task DAG is immutable after workflow_init; create a replacement workflow task for additional work');
}

async function claimNode(parameters, activateImmediately = false) {
  const [filePath] = await readTask(parameters); const nodeId = requiredIdentifier(parameters.node_id, 'node_id'); const taskPath = requiredString(parameters.agent_task_path, 'agent_task_path'); const threadId = optionalString(parameters.agent_thread_id, 'agent_thread_id'); const role = requiredString(parameters.agent_role, 'agent_role'); const leaseDurationSec = positiveInteger(parameters.lease_duration_sec, 'lease_duration_sec', DEFAULT_LEASE_SEC); const activationTimeoutSec = positiveInteger(parameters.activation_timeout_sec, 'activation_timeout_sec', Math.min(DEFAULT_ACTIVATION_TIMEOUT_SEC, leaseDurationSec));
  if (activateImmediately) trueValue(parameters.native_agent_started, 'native_agent_started');
  return withStateLock(filePath, async () => {
    const state = normalizeState(await loadState(filePath)); await requireActiveWorkspaceLease(state, filePath); const node = state.nodes[nodeId];
    if (!node || !readyNodes(state).some(candidate => candidate.id === nodeId)) throw new ControllerError(`Node is not ready: ${nodeId}`);
    if (runningParticipantPaths(state).has(taskPath)) throw new ControllerError('Agent already has a running node in this task');
    if (node.kind === 'total_review' && participantPaths(state).has(taskPath)) throw new ControllerError('A prior participant cannot claim the total review');
    const expectedAgentType = node.rescue_role ?? node.agent_type;
    if (expectedAgentType && expectedAgentType !== role) throw new ControllerError(`Node agent_type must match claimed role: ${expectedAgentType}`);
    // Total reviews are read-only guards, not protected execution work.
    if (node.execution_risk === 'protected' && node.kind !== 'total_review' && role !== PROTECTED_EXECUTOR_ROLE) throw new ControllerError('Only avsp_terra_high can claim protected work');
    if (node.execution_risk === 'read_only' && node.kind !== 'total_review' && !READ_ONLY_ROLES.has(role)) throw new ControllerError('A read_only node requires a configured read-only role');
    if (node.execution_risk === 'delegable' && !LUNA_EXECUTOR_ROLES.has(role) && role !== PROTECTED_EXECUTOR_ROLE && !(node.rescue_role === ROOT_RESCUE_ROLE && role === ROOT_RESCUE_ROLE)) throw new ControllerError('A delegable node requires a Luna executor or legacy writer, avsp_terra_high, or an explicit main/root rescue');
    if (node.execution_risk === 'delegable' && LEGACY_LUNA_WRITER_ROLES.has(role) && node.agent_type !== role) throw new ControllerError('A legacy Luna writer requires an explicitly matching node agent_type');
    if (LUNA_EXECUTOR_ROLES.has(role)) {
      if (node.routing_legacy || node.execution_risk !== 'delegable') throw new ControllerError('A Luna executor requires complete delegable routing metadata');
      if (node.execution_owner !== taskPath) throw new ControllerError('Luna executor claim must match node execution_owner');
    }
    if (!node.routing_legacy && node.execution_owner !== taskPath) throw new ControllerError('Node claim must match execution_owner');
    if (node.attempt >= MAX_NODE_ATTEMPTS) throw new ControllerError(`Node exceeded the ${MAX_NODE_ATTEMPTS}-attempt limit: ${nodeId}`);
    const now = utcNow(); node.status = RUNNING; node.agent_task_path = taskPath; node.agent_thread_id = threadId; node.agent_role = role; node.claim_id = randomUUID(); node.claimed_at = now; node.activation_at = activateImmediately ? now : null; node.activation_deadline_at = activateImmediately ? null : new Date(Date.now() + activationTimeoutSec * 1000).toISOString(); node.heartbeat_at = now; node.heartbeat_count = activateImmediately ? 1 : 0; node.lease_duration_sec = leaseDurationSec; node.attempt += 1;
    state.participants.push({ agent_task_path: taskPath, agent_thread_id: threadId, agent_role: role, node_id: nodeId, claim_id: node.claim_id, attempt: node.attempt });
    addEvent(state, 'node_claimed', { node_id: nodeId, agent_task_path: taskPath, agent_thread_id: threadId, agent_role: role, claim_id: node.claim_id, attempt: node.attempt });
    if (activateImmediately) addEvent(state, 'node_started', { node_id: nodeId, agent_task_path: taskPath, agent_thread_id: threadId, agent_role: role, claim_id: node.claim_id, native_agent_started: true });
    await writeState(filePath, state);
    return { task_id: state.task_id, node };
  });
}

function requireActiveClaim(node, parameters) {
  const claimId = requiredString(parameters.claim_id, 'claim_id');
  if (!node || node.status !== RUNNING) throw new ControllerError(`Only a running node accepts this operation: ${parameters.node_id}`);
  if (!node.claim_id || node.claim_id !== claimId) throw new ControllerError(`Claim does not own node: ${parameters.node_id}`);
  return claimId;
}

function hasRecordedReview(state, node) {
  return state.reviews.some(review => review.auditor_task === node.agent_task_path && review.claim_id === node.claim_id);
}

function reviewCompletion(state, review) {
  const completionEvent = [...state.events].reverse().find(event => event.type === 'node_completed' && event.node_id === review.node_id && event.claim_id === review.claim_id) ?? (() => {
    const reviews = state.reviews.filter(candidate => candidate.node_id === review.node_id && !state.events.some(event => event.type === 'node_completed' && event.node_id === candidate.node_id && event.claim_id === candidate.claim_id)).sort((left, right) => Date.parse(left.recorded_at) - Date.parse(right.recorded_at));
    const legacyEvents = state.events.filter(event => event.type === 'node_completed' && event.node_id === review.node_id && !hasOwn(event, 'claim_id')).sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
    const used = new Set();
    for (const candidate of reviews) {
      const recordedAt = Date.parse(candidate.recorded_at);
      const eventIndex = legacyEvents.findIndex((event, index) => !used.has(index) && (!Number.isFinite(recordedAt) || !Number.isFinite(Date.parse(event.at)) || Date.parse(event.at) >= recordedAt));
      if (eventIndex >= 0) {
        used.add(eventIndex);
        if (candidate === review) return legacyEvents[eventIndex];
      }
    }
    return null;
  })();
  return {
    status: review.completion_status ?? completionEvent?.status ?? null,
    completion_attestation: review.completion_attestation ?? completionEvent?.completion_attestation ?? null,
  };
}

function isFinalFailedReview(state, review) {
  return review.verdict === 'fail' && reviewCompletion(state, review).status === 'failed';
}

function nextTotalReviewRole(state, node) {
  if (!node || node.kind !== 'total_review') return null;
  const reviews = state.reviews.filter(review => review.node_id === node.id);
  const latest = reviews.at(-1);
  const currentRole = SOL_ESCALATION_ORDER.includes(node.agent_type) ? node.agent_type : 'avsp_sol_high';
  if (!latest || latest.auditor_role !== currentRole || !isFinalFailedReview(state, latest)) return currentRole;
  const latestIndex = SOL_ESCALATION_ORDER.indexOf(currentRole);
  if (latestIndex < 0) return currentRole;
  if (currentRole === 'avsp_sol_high') {
    let consecutiveHighFailures = 0;
    for (let index = reviews.length - 1; index >= 0; index -= 1) {
      const review = reviews[index];
      if (review.auditor_role !== 'avsp_sol_high' || !isFinalFailedReview(state, review)) break;
      consecutiveHighFailures += 1;
    }
    if (consecutiveHighFailures >= 2) return 'avsp_sol_xhigh';
  } else if (currentRole === 'avsp_sol_xhigh') {
    return 'avsp_sol_max';
  }
  return SOL_ESCALATION_ORDER[Math.min(latestIndex, SOL_ESCALATION_ORDER.length - 1)];
}

function hasWorkflowOutcomeMarker(result) {
  return Boolean(result && typeof result === 'object' && !Array.isArray(result) && result.workflow !== null && result.workflow !== undefined);
}

function hasMatchingWorkflowBinding(workflow, parameters, node) {
  return Boolean(
    workflow && typeof workflow === 'object' && !Array.isArray(workflow) && typeof workflow.state_dir === 'string'
    && workflow.task_id === parameters.task_id && workflow.node_id === parameters.node_id && workflow.claim_id === parameters.claim_id
    && node.id === parameters.node_id && path.resolve(workflow.state_dir) === path.resolve(parameters.state_dir),
  );
}

function isPendingWorkflowOutcome(result, parameters, node) {
  if (!hasWorkflowOutcomeMarker(result)) return false;
  const workflow = result?.workflow;
  return Boolean(
    hasMatchingWorkflowBinding(workflow, parameters, node)
    && result.workflow_completion?.state === 'pending',
  );
}

function isFinalizedWorkflowOutcome(result, parameters, node, status, completionAttestation) {
  if (!hasWorkflowOutcomeMarker(result) || !hasMatchingWorkflowBinding(result.workflow, parameters, node)) return false;
  const completion = result.workflow_completion;
  return Boolean(
    completion && typeof completion === 'object' && !Array.isArray(completion)
    && completion.completed === true && typeof completion.completed_at === 'string' && completion.completed_at.length > 0
    && completion.task_id === parameters.task_id && completion.node_id === parameters.node_id && completion.claim_id === parameters.claim_id
    && completion.status === status && completion.completion_attestation === completionAttestation,
  );
}

function workflowOutcomePayload(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
  const { workflow_completion: _workflowCompletion, ...payload } = result;
  return payload;
}

function workflowOutcomeDigest(result) {
  return createHash('sha256').update(stableJson(workflowOutcomePayload(result))).digest('hex');
}

function workflowCompletionIntentResultDigest(intent) {
  if (typeof intent?.result_digest === 'string' && /^[a-f0-9]{64}$/.test(intent.result_digest)) return intent.result_digest;
  // Older persisted intents predate result_digest but retain the pending result.
  return intent?.result && typeof intent.result === 'object' ? workflowOutcomeDigest(intent.result) : null;
}

function isCompletedWorkflowOutcome(result, state, node) {
  if (!hasWorkflowOutcomeMarker(result)) return false;
  const workflow = result.workflow;
  const completion = result.workflow_completion;
  return Boolean(
    workflow && typeof workflow === 'object' && !Array.isArray(workflow)
    && workflow.task_id === state.task_id && workflow.node_id === node.id && workflow.claim_id === node.claim_id
    && completion && typeof completion === 'object' && !Array.isArray(completion)
    && completion.completed === true && typeof completion.completed_at === 'string' && completion.completed_at.length > 0
    && completion.task_id === state.task_id && completion.node_id === node.id && completion.claim_id === node.claim_id
    && completion.status === node.status && typeof completion.completion_attestation === 'string' && completion.completion_attestation.length > 0,
  );
}

function addWorkflowOutcomeEnvelope(result, parameters) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new ControllerError('A total_review result must be a JSON object');
  if (hasWorkflowOutcomeMarker(result)) return result;
  return {
    ...result,
    workflow: {
      state_dir: path.resolve(parameters.state_dir),
      task_id: parameters.task_id,
      node_id: parameters.node_id,
      claim_id: parameters.claim_id,
    },
    workflow_completion: { state: 'pending' },
  };
}

async function finalizeWorkflowOutcome(result, parameters, node, status, completionAttestation) {
  if (!isPendingWorkflowOutcome(result, parameters, node)) return null;
  const workflowCompletion = {
    completed: true,
    completed_at: utcNow(),
    task_id: parameters.task_id,
    node_id: parameters.node_id,
    claim_id: parameters.claim_id,
    status,
    completion_attestation: completionAttestation,
  };
  const finalized = { ...result, workflow_completion: workflowCompletion };
  await atomicWrite(parameters.result, finalized, MAX_NODE_RESULT_BYTES);
  Object.assign(result, finalized);
  return workflowCompletion;
}

function workflowCompletionIntentMatches(intent, parameters, status, completionAttestation) {
  return Boolean(
    intent && typeof intent === 'object' && !Array.isArray(intent)
    && intent.claim_id === parameters.claim_id && intent.task_id === parameters.task_id && intent.node_id === parameters.node_id
    && intent.status === status && intent.completion_attestation === completionAttestation
    && typeof intent.result_path === 'string' && path.resolve(intent.result_path) === path.resolve(parameters.result),
  );
}

async function completeNode(parameters) {
  const status = String(parameters.status); if (!COMPLETABLE.has(status)) throw new ControllerError(`Completion status must be one of: ${[...COMPLETABLE].sort().join(', ')}`);
  let result = await readJson(parameters.result, { label: 'Node result', maxBytes: MAX_NODE_RESULT_BYTES }); const [filePath] = await readTask(parameters); const nodeId = requiredIdentifier(parameters.node_id, 'node_id');
  return withStateLock(filePath, async () => {
    const state = normalizeState(await loadState(filePath)); await requireActiveWorkspaceLease(state, filePath); const node = state.nodes[nodeId]; requireActiveClaim(node, parameters);
    if (!node.activation_at || node.heartbeat_count < 1) throw new ControllerError('An unactivated node cannot be completed; the claiming agent must first call workflow_heartbeat or workflow_start');
    const expectedAttestation = node.rescue_role === ROOT_RESCUE_ROLE && node.agent_role === ROOT_RESCUE_ROLE
      ? ROOT_RESCUE_SELF_COMPLETION
      : node.kind === 'total_review' && status === 'unavailable' && [NATIVE_AGENT_EXIT_CONFIRMED, NATIVE_AGENT_START_FAILED].includes(parameters.completion_attestation)
        ? parameters.completion_attestation
        : NATIVE_AGENT_FINISHED;
    if (parameters.completion_attestation !== expectedAttestation) throw new ControllerError(`workflow_complete requires completion_attestation=${expectedAttestation}`);
    if (node.kind === 'total_review' && status === 'skipped') throw new ControllerError('A total_review node cannot be skipped');
    if (node.kind === 'total_review' && status === SUCCEEDED && !hasRecordedReview(state, node)) throw new ControllerError('A successful total_review requires a recorded review for its active claim');
    let workflowOutcomeCompletion = null;
    if (node.kind === 'total_review') {
      result = addWorkflowOutcomeEnvelope(result, parameters);
      if (node.workflow_completion_intent && !workflowCompletionIntentMatches(node.workflow_completion_intent, parameters, status, expectedAttestation)) {
        throw new ControllerError('A total_review completion is already pending for a different result, claim, or status');
      }
      if (isPendingWorkflowOutcome(result, parameters, node)) {
        if (node.workflow_completion_intent && !sameJson(node.workflow_completion_intent.result, result)) throw new ControllerError('A total_review pending result does not match its persisted completion intent');
        if (!node.workflow_completion_intent) {
          node.workflow_completion_intent = {
            task_id: parameters.task_id,
            node_id: parameters.node_id,
            claim_id: parameters.claim_id,
            status,
            completion_attestation: expectedAttestation,
            result_path: path.resolve(parameters.result),
            result_digest: workflowOutcomeDigest(result),
            result,
            created_at: utcNow(),
          };
          await writeState(filePath, state);
        }
        workflowOutcomeCompletion = await finalizeWorkflowOutcome(result, parameters, node, status, expectedAttestation);
      } else if (isFinalizedWorkflowOutcome(result, parameters, node, status, expectedAttestation)) {
        if (!node.workflow_completion_intent) {
          throw new ControllerError('A finalized total_review result requires a persisted completion intent');
        }
        const intentResultDigest = workflowCompletionIntentResultDigest(node.workflow_completion_intent);
        if (node.workflow_completion_intent && intentResultDigest !== workflowOutcomeDigest(result)) {
          throw new ControllerError('A total_review finalized result does not match its persisted completion intent');
        }
        workflowOutcomeCompletion = result.workflow_completion;
      } else {
        throw new ControllerError('A workflow-bound total_review requires a matching workflow_completion.state=pending outcome');
      }
    }
    if (node.kind === 'total_review') {
      const recordedReview = state.reviews.find(review => review.node_id === node.id && review.claim_id === node.claim_id);
      if (recordedReview) {
        recordedReview.completion_status = status;
        recordedReview.completion_attestation = expectedAttestation;
        recordedReview.completed_at = utcNow();
      }
    }
    if (node.kind === 'total_review') node.workflow_completion_intent = null;
    node.status = status; node.result = result;
    if (node.kind === 'total_review') addEvent(state, 'node_completed', { node_id: nodeId, claim_id: node.claim_id, status, completion_attestation: expectedAttestation });
    else bumpWorkflowRevision(state, 'node_completed', { node_id: nodeId, status, completion_attestation: expectedAttestation });
    await writeState(filePath, state);
    return { task_id: state.task_id, node, ready_nodes: readyNodes(state), workflow_outcome_completion: workflowOutcomeCompletion };
  });
}

async function heartbeatNode(parameters) {
  const [filePath] = await readTask(parameters); const nodeId = requiredIdentifier(parameters.node_id, 'node_id');
  return withStateLock(filePath, async () => {
    const state = normalizeState(await loadState(filePath)); await requireActiveWorkspaceLease(state, filePath); const node = state.nodes[nodeId]; requireActiveClaim(node, parameters);
    const now = utcNow(); node.activation_at ??= now; node.activation_deadline_at = null; node.heartbeat_at = now; node.heartbeat_count += 1; state.updated_at = now; await writeState(filePath, state);
    return { task_id: state.task_id, node };
  });
}

async function checkpointNode(parameters) {
  const checkpointPath = requiredString(parameters.checkpoint, 'checkpoint');
  const checkpoint = await readJson(checkpointPath, { label: 'Node checkpoint', maxBytes: MAX_CHECKPOINT_BYTES });
  if (!checkpoint || typeof checkpoint !== 'object' || Array.isArray(checkpoint)) throw new ControllerError('Node checkpoint must be a JSON object');
  const [filePath] = await readTask(parameters); const nodeId = requiredIdentifier(parameters.node_id, 'node_id');
  return withStateLock(filePath, async () => {
    const state = normalizeState(await loadState(filePath)); await requireActiveWorkspaceLease(state, filePath); const node = state.nodes[nodeId]; requireActiveClaim(node, parameters);
    node.checkpoint = checkpoint; node.checkpoint_at = utcNow(); node.activation_at ??= node.checkpoint_at; node.activation_deadline_at = null; node.heartbeat_at = node.checkpoint_at; node.heartbeat_count += 1; state.updated_at = node.checkpoint_at; await writeState(filePath, state);
    return { task_id: state.task_id, node_id: nodeId, checkpoint_at: node.checkpoint_at };
  });
}

function compactRecoveryResult(result) {
  const serialized = stableJson(result) ?? 'null';
  const bytes = Buffer.byteLength(serialized, 'utf8');
  if (bytes <= MAX_RECOVERY_RESULT_BYTES) return { value: result, bytes, truncated: false };
  return { bytes, truncated: true, digest: createHash('sha256').update(serialized).digest('hex') };
}

function recoveryPacket(state, node, stale, reason, priorExecutionOwner = node.execution_owner) {
  const previousAttempt = {
    attempt: node.attempt,
    agent_task_path: node.agent_task_path,
    agent_thread_id: node.agent_thread_id,
    agent_role: node.agent_role,
    claim_id: node.claim_id,
    claimed_at: node.claimed_at,
    activation_at: node.activation_at,
    heartbeat_at: node.heartbeat_at,
    heartbeat_count: node.heartbeat_count,
    execution_owner: priorExecutionOwner,
    stale_reason: stale.reason,
    checkpoint: node.checkpoint,
    checkpoint_at: node.checkpoint_at,
    recovery_reason: reason,
  };
  return {
    version: 1,
    continuation: { kind: 'new_agent_required', prior_agent_thread_id: node.agent_thread_id, reason: 'This operation invalidated the old claim. Native session resumption, when available, must be attempted before workflow_requeue_stale.' },
    task: { task_id: state.task_id, workspace: state.workspace, goal: state.goal, requirements: state.requirements, scope: state.scope, non_goals: state.non_goals },
    node: { id: node.id, kind: node.kind, agent_type: node.agent_type, rescue_role: node.rescue_role, depends_on: node.depends_on, execution_risk: node.execution_risk, routing_reason: node.routing_reason, execution_owner: node.execution_owner, integration_owner: node.integration_owner, quality_guard: node.quality_guard },
    completed_dependencies: node.depends_on.map(id => ({ id, status: state.nodes[id].status, result: compactRecoveryResult(state.nodes[id].result) })),
    previous_attempt: previousAttempt,
    instructions: 'This is a replacement agent. Do not assume the previous agent session was restored. Inspect the current workspace and diff, validate the saved checkpoint and dependency evidence, then write a fresh checkpoint before material work.',
  };
}

function replacementExecutionOwner(state, node, parameters) {
  const replacement = requiredString(parameters.replacement_agent_task_path, 'replacement_agent_task_path');
  if (replacement === node.agent_task_path) throw new ControllerError('replacement_agent_task_path must differ from the stale or prior agent_task_path');
  if (node.kind === 'total_review' && participantPaths(state).has(replacement)) throw new ControllerError('A replacement total reviewer must not be a prior participant');
  if (!node.routing_legacy && Object.values(state.nodes).some(candidate => candidate.id !== node.id && candidate.execution_owner === replacement)) throw new ControllerError(`replacement_agent_task_path is already reserved by another node: ${replacement}`);
  return replacement;
}

function rebindExecutionOwner(node, replacement) {
  const priorExecutionOwner = node.execution_owner;
  if (!node.routing_legacy) node.execution_owner = replacement;
  return priorExecutionOwner;
}

function clearAttemptForRetry(node) {
  node.status = PENDING; node.agent_task_path = null; node.agent_thread_id = null; node.agent_role = null; node.claim_id = null; node.claimed_at = null; node.activation_at = null; node.activation_deadline_at = null; node.heartbeat_at = null; node.heartbeat_count = 0; node.lease_duration_sec = null; node.result = null; node.checkpoint = null; node.checkpoint_at = null; node.workflow_completion_intent = null;
}

function clearRescueRouting(node) {
  node.rescue_role = null; node.rescue_reason = null; node.rescued_at = null;
}

async function requeueStaleNode(parameters) {
  const [filePath] = await readTask(parameters); const nodeId = requiredIdentifier(parameters.node_id, 'node_id'); const reason = requiredString(parameters.reason, 'reason'); retryConfirmation(parameters); const claimId = requiredString(parameters.claim_id, 'claim_id');
  return withStateLock(filePath, async () => {
    const state = normalizeState(await loadState(filePath)); await requireActiveWorkspaceLease(state, filePath); const node = state.nodes[nodeId]; requireActiveClaim(node, parameters);
    const stale = staleNodes(state).find(candidate => candidate.id === nodeId && candidate.claim_id === claimId);
    if (!stale) throw new ControllerError(`Node is not stale for its active claim: ${nodeId}`);
    if (node.attempt >= MAX_NODE_ATTEMPTS) throw new ControllerError(`Node exceeded the ${MAX_NODE_ATTEMPTS}-attempt limit: ${nodeId}`);
    const replacement = replacementExecutionOwner(state, node, parameters); const priorExecutionOwner = rebindExecutionOwner(node, replacement);
    const packet = recoveryPacket(state, node, stale, reason, priorExecutionOwner);
    node.recovery_history.push({ at: utcNow(), ...packet.previous_attempt });
    if (node.recovery_history.length > MAX_NODE_ATTEMPTS) node.recovery_history.splice(0, node.recovery_history.length - MAX_NODE_ATTEMPTS);
    clearRescueRouting(node); clearAttemptForRetry(node);
    const details = { node_id: nodeId, prior_claim_id: claimId, prior_execution_owner: priorExecutionOwner, replacement_execution_owner: replacement, reason, stale_reason: stale.reason, previous_agent_stopped: true, auto_requeue: true };
    if (node.kind === 'total_review') addEvent(state, 'stale_node_requeued', details); else bumpWorkflowRevision(state, 'stale_node_requeued', details);
    await writeState(filePath, state);
    return { task_id: state.task_id, node, recovery_package: packet, ready_nodes: readyNodes(state) };
  });
}

async function rescueNode(parameters) {
  const [filePath] = await readTask(parameters); const nodeId = requiredIdentifier(parameters.node_id, 'node_id'); const reason = requiredString(parameters.reason, 'reason'); retryConfirmation(parameters); const claimId = requiredString(parameters.claim_id, 'claim_id');
  return withStateLock(filePath, async () => {
    const state = normalizeState(await loadState(filePath)); await requireActiveWorkspaceLease(state, filePath); const node = state.nodes[nodeId]; requireActiveClaim(node, parameters);
    if (node.kind === 'total_review') throw new ControllerError('A total_review node cannot be rescued by main/root');
    if (node.execution_risk !== 'delegable') throw new ControllerError('Only delegable Luna execution can be rescued by main/root');
    if (!LUNA_EXECUTOR_ROLES.has(node.agent_role)) throw new ControllerError('Only a Luna executor or explicitly matched legacy writer attempt can be rescued by main/root');
    if (node.rescue_role) throw new ControllerError(`Node already has an active rescue role: ${nodeId}`);
    if (node.attempt >= MAX_NODE_ATTEMPTS) throw new ControllerError(`Node exceeded the ${MAX_NODE_ATTEMPTS}-attempt limit: ${nodeId}`);
    const replacement = replacementExecutionOwner(state, node, parameters);
    const priorExecutionOwner = rebindExecutionOwner(node, replacement);
    const now = utcNow();
    const stale = staleNodes(state).find(candidate => candidate.id === nodeId && candidate.claim_id === claimId) ?? { reason: 'explicit_root_rescue' };
    const packet = recoveryPacket(state, node, stale, reason, priorExecutionOwner);
    node.recovery_history.push({ at: now, ...packet.previous_attempt });
    if (node.recovery_history.length > MAX_NODE_ATTEMPTS) node.recovery_history.splice(0, node.recovery_history.length - MAX_NODE_ATTEMPTS);
    node.rescue_role = ROOT_RESCUE_ROLE; node.rescue_reason = reason; node.rescued_at = now; node.rescue_count += 1;
    clearAttemptForRetry(node);
    bumpWorkflowRevision(state, 'root_rescue', { node_id: nodeId, prior_claim_id: claimId, prior_execution_owner: priorExecutionOwner, replacement_execution_owner: replacement, reason, previous_agent_stopped: true, rescue_role: ROOT_RESCUE_ROLE });
    await writeState(filePath, state);
    return { task_id: state.task_id, node, recovery_package: packet, rescue_role: ROOT_RESCUE_ROLE, ready_nodes: readyNodes(state) };
  });
}

async function abandonNode(parameters) {
  const [filePath] = await readTask(parameters); const nodeId = requiredIdentifier(parameters.node_id, 'node_id'); const reason = requiredString(parameters.reason, 'reason'); trueValue(parameters.previous_agent_stopped, 'previous_agent_stopped');
  return withStateLock(filePath, async () => {
    const state = normalizeState(await loadState(filePath)); await requireActiveWorkspaceLease(state, filePath); const node = state.nodes[nodeId]; requireActiveClaim(node, parameters);
    node.status = 'abandoned'; node.workflow_completion_intent = null; node.result = { summary: 'Node abandoned after explicit reconciliation.', reason, abandoned_at: utcNow(), claim_id: node.claim_id };
    if (node.kind === 'total_review') addEvent(state, 'node_abandoned', { node_id: nodeId, claim_id: node.claim_id, reason, previous_agent_stopped: true });
    else bumpWorkflowRevision(state, 'node_abandoned', { node_id: nodeId, claim_id: node.claim_id, reason, previous_agent_stopped: true });
    await writeState(filePath, state);
    return { task_id: state.task_id, node };
  });
}

async function retryNode(parameters) {
  const [filePath] = await readTask(parameters); const nodeId = requiredIdentifier(parameters.node_id, 'node_id'); const reason = requiredString(parameters.reason, 'reason'); retryConfirmation(parameters);
  return withStateLock(filePath, async () => {
    const state = normalizeState(await loadState(filePath)); await requireActiveWorkspaceLease(state, filePath); const node = state.nodes[nodeId];
    const orphanedTotalReview = node?.kind === 'total_review' && node.status === SUCCEEDED && !hasRecordedReview(state, node);
    if (!node || (!['failed', 'blocked', 'unavailable', 'abandoned'].includes(node.status) && !orphanedTotalReview)) throw new ControllerError(`Only failed, blocked, unavailable, abandoned, or an unrecorded successful total_review can be retried: ${nodeId}`);
    const downstreamStarted = Object.values(state.nodes).some(candidate => candidate.depends_on.includes(nodeId) && candidate.status !== PENDING);
    if (downstreamStarted) throw new ControllerError(`Cannot retry after a dependent node changed state: ${nodeId}`);
    const replacement = node.routing_legacy ? null : replacementExecutionOwner(state, node, parameters); const priorExecutionOwner = replacement ? rebindExecutionOwner(node, replacement) : node.execution_owner;
    const priorClaimId = node.claim_id; const priorReviewRole = node.kind === 'total_review' ? node.agent_type : null; const nextReviewRole = node.kind === 'total_review' ? nextTotalReviewRole(state, node) : null;
    clearRescueRouting(node); clearAttemptForRetry(node);
    if (nextReviewRole) node.agent_type = nextReviewRole;
    const details = { node_id: nodeId, prior_claim_id: priorClaimId, prior_execution_owner: priorExecutionOwner, replacement_execution_owner: replacement, reason, previous_agent_stopped: true, orphaned_total_review: orphanedTotalReview, prior_review_role: priorReviewRole, review_role: nextReviewRole };
    if (node.kind === 'total_review' && nextReviewRole && nextReviewRole !== priorReviewRole) {
      details.review_escalated = true;
      addEvent(state, 'total_review_escalated', { node_id: nodeId, prior_role: priorReviewRole, role: nextReviewRole, reason, prior_claim_id: priorClaimId });
    }
    if (node.kind === 'total_review') addEvent(state, 'node_retried', details); else bumpWorkflowRevision(state, 'node_retried', details);
    await writeState(filePath, state);
    return { task_id: state.task_id, node, ready_nodes: readyNodes(state) };
  });
}

const PRUNABLE_STATE_FIELDS = new Set(['version', 'routing_schema_version', 'task_id', 'workspace', 'goal', 'requirements', 'scope', 'non_goals', 'nodes', 'participants', 'reviews', 'events', 'workflow_revision', 'closed_revision', 'closed_at', 'created_at', 'updated_at', 'workspace_lease']);
const PRUNABLE_NODE_FIELDS = new Set(['id', 'kind', 'agent_type', 'depends_on', 'execution_risk', 'routing_reason', 'execution_owner', 'integration_owner', 'quality_guard', 'routing_legacy', 'rescue_role', 'rescue_reason', 'rescued_at', 'rescue_count', 'status', 'agent_task_path', 'agent_thread_id', 'agent_role', 'claim_id', 'claimed_at', 'activation_at', 'activation_deadline_at', 'heartbeat_at', 'heartbeat_count', 'lease_duration_sec', 'attempt', 'result', 'checkpoint', 'checkpoint_at', 'workflow_completion_intent', 'recovery_history']);
const PRUNABLE_LEASE_FIELDS = new Set(['version', 'workspace', 'active_task', 'updated_at']);
const PRUNABLE_TASK_LEASE_FIELDS = new Set(['registry_path', 'state_path', 'status', 'acquired_at', 'released_at']);
const PRUNE_SWEEP_FIELDS = new Set(['version', 'last_sweep_at', 'last_result']);
const QUARANTINE_FIELDS_V1 = new Set(['version', 'status', 'task_id', 'original_state_path', 'error_path', 'reason', 'quarantined_at', 'delete_after', 'files', 'move_error']);
const QUARANTINE_FIELDS = new Set([...QUARANTINE_FIELDS_V1, 'review_artifacts']);
const QUARANTINE_EXPIRY_FIELDS = new Set(['version', 'task_id', 'original_state_path', 'quarantined_at', 'delete_after', 'files', 'review_artifacts']);
const PRUNE_RESULT_FIELDS = new Set(['deleted_count', 'quarantined_count', 'retained_count', 'quarantine_deleted_count', 'quarantine_retained_count', 'report_truncated']);

function hasExactFields(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === fields.size && keys.every(key => fields.has(key));
}
function validTimestamp(value) { return typeof value === 'string' && Number.isFinite(Date.parse(value)); }

function taskPruneEligibility(state, filePath, now) {
  if (!hasExactFields(state, PRUNABLE_STATE_FIELDS)) return { eligible: false, reason: 'incomplete or unknown state fields' };
  if (state.version !== VERSION || state.routing_schema_version !== 1) return { eligible: false, reason: 'legacy or unsupported state schema' };
  try { requiredIdentifier(state.task_id, 'task_id'); requiredString(state.workspace, 'workspace'); requiredString(state.goal, 'goal'); }
  catch (error) { return { eligible: false, reason: `invalid task identity: ${error.message}` }; }
  if (state.task_id !== path.basename(filePath, '.json')) return { eligible: false, reason: 'task_id does not match state path' };
  if (!path.isAbsolute(state.workspace) || path.resolve(state.workspace) !== state.workspace) return { eligible: false, reason: 'workspace is not canonical absolute path' };
  if (!Array.isArray(state.requirements) || !Array.isArray(state.scope) || !Array.isArray(state.non_goals) || !Array.isArray(state.participants) || !Array.isArray(state.reviews) || !Array.isArray(state.events)) return { eligible: false, reason: 'invalid state collection' };
  if (state.requirements.some(item => !item || typeof item !== 'object' || Array.isArray(item) || typeof item.id !== 'string' || !item.id.trim() || typeof item.text !== 'string' || !item.text.trim()) || state.participants.some(item => !item || typeof item !== 'object' || Array.isArray(item)) || state.reviews.some(item => !item || typeof item !== 'object' || Array.isArray(item)) || state.events.some(item => !item || typeof item !== 'object' || Array.isArray(item) || !validTimestamp(item.at) || typeof item.type !== 'string' || !item.type.trim())) return { eligible: false, reason: 'malformed state collection item' };
  if (!state.nodes || typeof state.nodes !== 'object' || Array.isArray(state.nodes) || !Object.keys(state.nodes).length) return { eligible: false, reason: 'invalid node collection' };
  for (const [id, node] of Object.entries(state.nodes)) {
    if (!hasExactFields(node, PRUNABLE_NODE_FIELDS) || node.id !== id || (node.status !== PENDING && !TERMINAL.has(node.status))) return { eligible: false, reason: 'incomplete, unknown, or active node state' };
    try { requiredIdentifier(node.id, 'node.id'); requiredString(node.kind, 'node.kind'); requiredString(node.execution_risk, 'node.execution_risk'); requiredString(node.routing_reason, 'node.routing_reason'); requiredString(node.execution_owner, 'node.execution_owner'); requiredString(node.integration_owner, 'node.integration_owner'); requiredString(node.quality_guard, 'node.quality_guard'); }
    catch (error) { return { eligible: false, reason: `invalid node state: ${error.message}` }; }
    if (!['read_only', 'delegable', 'protected'].includes(node.execution_risk) || !Array.isArray(node.depends_on) || node.depends_on.some(dependency => typeof dependency !== 'string') || node.routing_legacy !== false || !Number.isSafeInteger(node.attempt) || node.attempt < 0 || node.attempt > MAX_NODE_ATTEMPTS || !Number.isSafeInteger(node.heartbeat_count) || node.heartbeat_count < 0 || !Array.isArray(node.recovery_history)) return { eligible: false, reason: 'legacy or invalid node routing' };
  }
  try { validateNodes(state.nodes); validateTotalReviewTopology(state.nodes); }
  catch (error) { return { eligible: false, reason: `invalid task topology: ${error.message}` }; }
  if (!Number.isSafeInteger(state.workflow_revision) || state.workflow_revision < 0 || !validTimestamp(state.created_at) || !validTimestamp(state.updated_at)) return { eligible: false, reason: 'invalid task timestamps or revision' };
  const updatedAt = Date.parse(state.updated_at);
  if (!Number.isFinite(updatedAt)) return { eligible: false, reason: 'invalid updated_at' };
  if (now - updatedAt < DEFAULT_TASK_RETENTION_DAYS * DAY_MS) return { eligible: false, reason: 'younger than retention period' };
  if (!state.workspace_lease || state.workspace_lease.status !== 'released') return { eligible: false, reason: 'workspace lease is not released' };
  if (!hasExactFields(state.workspace_lease, PRUNABLE_TASK_LEASE_FIELDS)) return { eligible: false, reason: 'workspace lease is not a complete released state' };
  if (Object.values(state.nodes).some(node => node.status === RUNNING)) return { eligible: false, reason: 'has running nodes' };
  if (typeof state.workspace_lease.registry_path !== 'string' || !path.isAbsolute(state.workspace_lease.registry_path) || path.resolve(state.workspace_lease.registry_path) !== workspaceLeasePath(state.workspace)) return { eligible: false, reason: 'invalid workspace lease path' };
  if (state.workspace_lease.state_path !== filePath || !validTimestamp(state.workspace_lease.acquired_at) || !validTimestamp(state.workspace_lease.released_at)) return { eligible: false, reason: 'invalid released workspace lease state' };
  if (path.resolve(state.workspace_lease.registry_path) === path.resolve(filePath)) return { eligible: false, reason: 'state path conflicts with workspace lease path' };
  return { eligible: true };
}

async function releasedLeaseEligibility(leasePath, state) {
  let lease;
  try { lease = await readJson(leasePath, { label: 'Workspace lease', maxBytes: MAX_MANIFEST_BYTES }); }
  catch (error) { return { eligible: false, reason: `workspace lease is unreadable: ${error.message}` }; }
  if (!hasExactFields(lease, PRUNABLE_LEASE_FIELDS) || lease.version !== WORKSPACE_LEASE_VERSION || lease.workspace !== state.workspace || lease.active_task !== null || !validTimestamp(lease.updated_at)) return { eligible: false, reason: 'workspace lease is not a verified released registry' };
  return { eligible: true };
}

async function quarantineEligibility(state, filePath, now) {
  let storageMetadata;
  try { storageMetadata = await fs.stat(databasePath(filePath)); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    try { storageMetadata = await fs.stat(filePath); }
    catch (legacyError) {
      if (legacyError.code !== 'ENOENT') throw legacyError;
      try { storageMetadata = await fs.stat(`${filePath}.legacy`); }
      catch (archiveError) {
        if (archiveError.code === 'ENOENT') return { eligible: false, reason: 'state disappeared before quarantine' };
        throw archiveError;
      }
    }
  }
  const updatedAt = state && validTimestamp(state.updated_at) ? Date.parse(state.updated_at) : storageMetadata.mtimeMs;
  if (now - updatedAt < QUARANTINE_AFTER_DAYS * DAY_MS) return { eligible: false, reason: 'younger than quarantine retention period' };
  if (!state || typeof state !== 'object' || Array.isArray(state)) return { eligible: true, unverified: true, reason: 'state is unreadable; direct quarantine is required' };
  if (state.nodes !== undefined && (!state.nodes || typeof state.nodes !== 'object' || Array.isArray(state.nodes))) return { eligible: true, unverified: true, reason: 'node collection is not verifiable; direct quarantine is required' };
  if (state.nodes && Object.values(state.nodes).some(node => node?.status === RUNNING)) return { eligible: false, reason: 'has running nodes' };
  if (state.nodes && Object.values(state.nodes).some(node => !node || typeof node !== 'object' || ![PENDING, ...TERMINAL].includes(node.status))) return { eligible: true, unverified: true, reason: 'node states are unknown; direct quarantine is required' };
  if (state.workspace_lease?.status === 'active') return { eligible: false, reason: 'state workspace lease is still active' };
  const leasePath = state?.workspace_lease?.registry_path;
  const canonicalLeasePath = typeof state.workspace === 'string' && path.isAbsolute(state.workspace) && path.resolve(state.workspace) === state.workspace
    ? workspaceLeasePath(state.workspace)
    : null;
  const lockableLeasePath = typeof leasePath === 'string' && path.isAbsolute(leasePath) && canonicalLeasePath && path.resolve(leasePath) === canonicalLeasePath ? leasePath : null;
  if (!lockableLeasePath) return { eligible: true, unverified: true, reason: 'state has no verifiable workspace lease; direct quarantine is required' };
  let lease;
  try { lease = await readJson(lockableLeasePath, { label: 'Workspace lease', maxBytes: MAX_MANIFEST_BYTES }); }
  catch (error) { return { eligible: true, unverified: true, reason: `workspace lease is unreadable; direct quarantine is required: ${error.message}`, lease_path: lockableLeasePath }; }
  if (!hasExactFields(lease, PRUNABLE_LEASE_FIELDS)
    || lease.version !== WORKSPACE_LEASE_VERSION
    || typeof state.workspace !== 'string'
    || !path.isAbsolute(state.workspace)
    || path.resolve(state.workspace) !== state.workspace
    || lease.workspace !== state.workspace
    || !validTimestamp(lease.updated_at)
     || path.resolve(lockableLeasePath) !== workspaceLeasePath(state.workspace)) {
    return { eligible: true, unverified: true, reason: 'workspace lease is not a complete matching registry; direct quarantine is required', lease_path: lockableLeasePath };
  }
  if (lease.active_task !== null) return { eligible: false, reason: 'workspace lease still has an active task' };
  return { eligible: true, verified: true, lease_path: lockableLeasePath, reason: 'verified inactive workspace lease' };
}

function errorStateRoot(stateDir) { return path.join(path.resolve(stateDir), ERROR_STATE_DIRECTORY); }
function errorQuarantinePath(errorPath) { return path.join(errorPath, ERROR_QUARANTINE_FILENAME); }
function quarantineExpiryPath(errorPath) { return path.join(errorPath, QUARANTINE_EXPIRY_FILENAME); }
function reviewArtifactTaskPath(stateDir, taskId) { return path.join(path.resolve(stateDir), REVIEW_ARTIFACT_DIRECTORY, taskId); }
function quarantineReviewArtifactPath(errorPath) { return path.join(errorPath, QUARANTINE_REVIEW_DIRECTORY); }

async function reviewArtifactDirectoryIsSafe(directoryPath) {
  let entries;
  try { entries = await fs.readdir(directoryPath, { withFileTypes: true }); }
  catch { return false; }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) return false;
    const childPath = path.join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      if (!await reviewArtifactDirectoryIsSafe(childPath)) return false;
    } else if (!entry.isFile()) return false;
  }
  return true;
}

function isDirectChild(parent, candidate) {
  return path.dirname(path.resolve(candidate)) === path.resolve(parent);
}

async function stateFilesForQuarantine(filePath) {
  const files = [];
  for (const sourcePath of [databasePath(filePath), filePath, `${filePath}.legacy`]) {
    try {
      const metadata = await fs.lstat(sourcePath);
      if (!metadata.isFile()) return { files: null, reason: `state component is not a regular file: ${sourcePath}` };
      files.push(sourcePath);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  if (!files.length) return { files: null, reason: 'state disappeared before quarantine' };
  return { files };
}

function quarantineMetadataIsValid(metadata, stateDir, errorPath) {
  const currentMetadata = hasExactFields(metadata, QUARANTINE_FIELDS) && metadata.version === 2;
  const legacyMetadata = hasExactFields(metadata, QUARANTINE_FIELDS_V1) && metadata.version === 1;
  if ((!currentMetadata && !legacyMetadata) || !['quarantining', 'quarantined'].includes(metadata.status)) return false;
  if (currentMetadata && metadata.review_artifacts !== null && metadata.review_artifacts !== QUARANTINE_REVIEW_DIRECTORY) return false;
  if (metadata.task_id !== null && (typeof metadata.task_id !== 'string' || !metadata.task_id.trim())) return false;
  if (typeof metadata.original_state_path !== 'string' || typeof metadata.error_path !== 'string' || typeof metadata.reason !== 'string' || !metadata.reason.trim()) return false;
  if (!validTimestamp(metadata.quarantined_at) || !validTimestamp(metadata.delete_after) || (metadata.move_error !== null && (typeof metadata.move_error !== 'string' || !metadata.move_error.trim()))) return false;
  if (!Array.isArray(metadata.files) || !metadata.files.length || metadata.files.some(name => typeof name !== 'string' || !name || path.basename(name) !== name) || new Set(metadata.files).size !== metadata.files.length) return false;
  const root = errorStateRoot(stateDir);
  if (!isDirectChild(root, errorPath) || path.resolve(metadata.error_path) !== path.resolve(errorPath)) return false;
  if (path.dirname(path.resolve(metadata.original_state_path)) !== path.resolve(stateDir) || !metadata.original_state_path.endsWith('.json')) return false;
  const logicalName = path.basename(metadata.original_state_path);
  const allowedNames = new Set([logicalName, databasePath(metadata.original_state_path), `${logicalName}.legacy`].map(candidate => path.basename(candidate)));
  if (metadata.files.some(name => !allowedNames.has(name))) return false;
  const expiry = Date.parse(metadata.quarantined_at) + ERROR_STATE_RETENTION_DAYS * DAY_MS;
  return metadata.delete_after === new Date(expiry).toISOString();
}

function quarantineExpiryFromMetadata(metadata) {
  return {
    version: 1,
    task_id: metadata.task_id,
    original_state_path: metadata.original_state_path,
    quarantined_at: metadata.quarantined_at,
    delete_after: metadata.delete_after,
    files: metadata.files,
    review_artifacts: metadata.review_artifacts ?? null,
  };
}

function quarantineExpiryIsValid(expiry, stateDir, errorPath) {
  if (!hasExactFields(expiry, QUARANTINE_EXPIRY_FIELDS) || expiry.version !== 1) return false;
  if (expiry.task_id !== null && (typeof expiry.task_id !== 'string' || !expiry.task_id.trim())) return false;
  if (typeof expiry.original_state_path !== 'string' || !validTimestamp(expiry.quarantined_at) || !validTimestamp(expiry.delete_after)) return false;
  if (!Array.isArray(expiry.files) || !expiry.files.length || expiry.files.some(name => typeof name !== 'string' || !name || path.basename(name) !== name) || new Set(expiry.files).size !== expiry.files.length) return false;
  if (expiry.review_artifacts !== null && expiry.review_artifacts !== QUARANTINE_REVIEW_DIRECTORY) return false;
  if (path.dirname(path.resolve(expiry.original_state_path)) !== path.resolve(stateDir) || !expiry.original_state_path.endsWith('.json')) return false;
  const logicalName = path.basename(expiry.original_state_path);
  const allowedNames = new Set([logicalName, databasePath(expiry.original_state_path), `${logicalName}.legacy`].map(candidate => path.basename(candidate)));
  if (expiry.files.some(name => !allowedNames.has(name))) return false;
  const expectedDeleteAfter = new Date(Date.parse(expiry.quarantined_at) + ERROR_STATE_RETENTION_DAYS * DAY_MS).toISOString();
  return expiry.delete_after === expectedDeleteAfter && isDirectChild(errorStateRoot(stateDir), errorPath);
}

async function readQuarantineExpiry(stateDir, errorPath) {
  try {
    const expiry = await readJson(quarantineExpiryPath(errorPath), { label: 'Quarantined workflow expiry metadata', maxBytes: MAX_QUARANTINE_BYTES });
    if (!quarantineExpiryIsValid(expiry, stateDir, errorPath)) throw new ControllerError(`Quarantined workflow expiry metadata is invalid: ${quarantineExpiryPath(errorPath)}`);
    return expiry;
  } catch (error) {
    if (error instanceof ControllerError && error.message.includes('does not exist:')) return null;
    throw error;
  }
}

async function ensureQuarantineExpiry(stateDir, errorPath, metadata) {
  const existing = await readQuarantineExpiry(stateDir, errorPath);
  if (existing) return existing;
  const expiry = quarantineExpiryFromMetadata(metadata);
  await atomicWrite(quarantineExpiryPath(errorPath), expiry, MAX_QUARANTINE_BYTES);
  return expiry;
}

async function readQuarantineMetadata(stateDir, errorPath) {
  const metadata = await readJson(errorQuarantinePath(errorPath), { label: 'Quarantined workflow state metadata', maxBytes: MAX_QUARANTINE_BYTES });
  if (!quarantineMetadataIsValid(metadata, stateDir, errorPath)) throw new ControllerError(`Quarantined workflow state metadata is invalid: ${errorQuarantinePath(errorPath)}`);
  return metadata;
}

async function quarantineIfEligible(filePath, initialState, now) {
  const initial = await quarantineEligibility(initialState, filePath, now);
  if (!initial.eligible) return { quarantined: false, reason: initial.reason, task_id: initialState?.task_id ?? null };
  try {
    const run = async () => withStateLock(filePath, async () => {
      let state;
      try { state = await loadState(filePath); } catch { state = null; }
      const current = await quarantineEligibility(state, filePath, now);
      if (!current.eligible) return { quarantined: false, reason: current.reason, task_id: state?.task_id ?? null };
      const components = await stateFilesForQuarantine(filePath);
      if (!components.files) return { quarantined: false, reason: components.reason, task_id: state?.task_id ?? null };
      const taskId = typeof state?.task_id === 'string' && /^[A-Za-z][A-Za-z0-9._-]{0,79}$/.test(state.task_id)
        ? state.task_id
        : path.basename(filePath, '.json');
      let artifactSource = null;
      if (/^[A-Za-z][A-Za-z0-9._-]{0,79}$/.test(taskId)) {
        const candidate = reviewArtifactTaskPath(path.dirname(filePath), taskId);
        try {
          const artifactMetadata = await fs.lstat(candidate);
          if (artifactMetadata.isSymbolicLink() || !artifactMetadata.isDirectory()) return { quarantined: false, reason: `review artifact path is not a regular directory: ${candidate}`, task_id: state?.task_id ?? null };
          artifactSource = candidate;
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      }
      const errorRoot = errorStateRoot(path.dirname(filePath));
      await fs.mkdir(errorRoot, { recursive: true });
      const errorPath = path.join(errorRoot, randomUUID());
      await fs.mkdir(errorPath, { recursive: false });
      const metadata = {
        version: 2,
        status: 'quarantining',
        task_id: typeof state?.task_id === 'string' && state.task_id.trim() ? state.task_id : null,
        original_state_path: filePath,
        error_path: errorPath,
        reason: current.verified ? 'legacy or incomplete task state passed the verified inactive-lease quarantine gate' : current.reason,
        quarantined_at: new Date(now).toISOString(),
        delete_after: new Date(now + ERROR_STATE_RETENTION_DAYS * DAY_MS).toISOString(),
        files: components.files.map(component => path.basename(component)),
        move_error: null,
        review_artifacts: artifactSource ? QUARANTINE_REVIEW_DIRECTORY : null,
      };
      await atomicWrite(errorQuarantinePath(errorPath), metadata, MAX_QUARANTINE_BYTES);
      await atomicWrite(quarantineExpiryPath(errorPath), quarantineExpiryFromMetadata(metadata), MAX_QUARANTINE_BYTES);
      try {
        for (const sourcePath of components.files) await fs.rename(sourcePath, path.join(errorPath, path.basename(sourcePath)));
        if (artifactSource) await fs.rename(artifactSource, quarantineReviewArtifactPath(errorPath));
      } catch (error) {
        metadata.move_error = error.message;
        try { await atomicWrite(errorQuarantinePath(errorPath), metadata, MAX_QUARANTINE_BYTES); }
        catch (metadataError) { return { quarantined: false, reason: `quarantine move failed: ${error.message}; metadata update failed: ${metadataError.message}`, task_id: metadata.task_id, error_path: errorPath }; }
        return { quarantined: false, reason: `quarantine move failed: ${error.message}`, task_id: metadata.task_id, error_path: errorPath };
      }
      metadata.status = 'quarantined';
      await atomicWrite(errorQuarantinePath(errorPath), metadata, MAX_QUARANTINE_BYTES);
      return { quarantined: true, task_id: metadata.task_id, error_path: errorPath, delete_after: metadata.delete_after };
    });
    return initial.lease_path ? await withStateLock(initial.lease_path, run) : await run();
  } catch (error) {
    return { quarantined: false, reason: `quarantine lock unavailable: ${error.message}`, task_id: initialState?.task_id ?? null };
  }
}

function validQuarantineTaskId(taskId) {
  return typeof taskId === 'string' && /^[A-Za-z][A-Za-z0-9._-]{0,79}$/.test(taskId);
}

async function quarantineContentsAreSafe(errorPath, record) {
  const contents = await fs.readdir(errorPath, { withFileTypes: true });
  const expectedFiles = new Set([...record.files, ERROR_QUARANTINE_FILENAME, QUARANTINE_EXPIRY_FILENAME]);
  if (record.review_artifacts) expectedFiles.add(record.review_artifacts);
  const unexpected = contents.filter(entry => !expectedFiles.has(entry.name) || (entry.name === record.review_artifacts ? !entry.isDirectory() : !entry.isFile()));
  if (contents.length !== expectedFiles.size || unexpected.length) return false;
  return !record.review_artifacts || await reviewArtifactDirectoryIsSafe(quarantineReviewArtifactPath(errorPath));
}

async function upgradeLegacyQuarantine(stateDir, errorPath, metadata) {
  if (metadata.version !== 1 || metadata.status !== 'quarantined' || metadata.move_error !== null) return metadata;
  let reviewArtifacts = null;
  if (validQuarantineTaskId(metadata.task_id)) {
    const artifactPath = reviewArtifactTaskPath(stateDir, metadata.task_id);
    try {
      const artifact = await fs.lstat(artifactPath);
      if (artifact.isSymbolicLink() || !artifact.isDirectory() || !await reviewArtifactDirectoryIsSafe(artifactPath)) {
        throw new ControllerError(`Legacy review artifact is not a safe regular directory: ${artifactPath}`);
      }
      reviewArtifacts = QUARANTINE_REVIEW_DIRECTORY;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  const upgraded = {
    ...metadata,
    version: 2,
    status: reviewArtifacts ? 'quarantining' : 'quarantined',
    move_error: reviewArtifacts ? 'legacy review artifact migration is pending' : null,
    review_artifacts: reviewArtifacts,
  };
  await atomicWrite(errorQuarantinePath(errorPath), upgraded, MAX_QUARANTINE_BYTES);
  await ensureQuarantineExpiry(stateDir, errorPath, upgraded);
  return upgraded;
}

async function reconcileQuarantineEntry(stateDir, errorPath, metadata) {
  let current = await upgradeLegacyQuarantine(stateDir, errorPath, metadata);
  await ensureQuarantineExpiry(stateDir, errorPath, current);
  if (current.status === 'quarantined' && current.move_error === null) return { complete: true, metadata: current };
  const sourceDirectory = path.dirname(current.original_state_path);
  const missing = [];
  try {
    for (const name of current.files) {
      const destination = path.join(errorPath, name);
      try {
        const target = await fs.lstat(destination);
        if (target.isSymbolicLink() || !target.isFile()) throw new ControllerError(`Quarantine destination is not a regular file: ${destination}`);
        continue;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      const source = path.join(sourceDirectory, name);
      try {
        const sourceMetadata = await fs.lstat(source);
        if (sourceMetadata.isSymbolicLink() || !sourceMetadata.isFile()) throw new ControllerError(`Quarantine source is not a regular file: ${source}`);
        await fs.rename(source, destination);
      } catch (error) {
        if (error.code === 'ENOENT') missing.push(name);
        else throw error;
      }
    }
    if (current.review_artifacts) {
      const destination = quarantineReviewArtifactPath(errorPath);
      try {
        const target = await fs.lstat(destination);
        if (target.isSymbolicLink() || !target.isDirectory() || !await reviewArtifactDirectoryIsSafe(destination)) throw new ControllerError(`Quarantine review artifact destination is unsafe: ${destination}`);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        if (!validQuarantineTaskId(current.task_id)) throw new ControllerError('Quarantine review artifact has no valid task_id');
        const source = reviewArtifactTaskPath(stateDir, current.task_id);
        try {
          const sourceMetadata = await fs.lstat(source);
          if (sourceMetadata.isSymbolicLink() || !sourceMetadata.isDirectory() || !await reviewArtifactDirectoryIsSafe(source)) throw new ControllerError(`Quarantine review artifact source is unsafe: ${source}`);
          await fs.rename(source, destination);
        } catch (sourceError) {
          if (sourceError.code === 'ENOENT') missing.push(QUARANTINE_REVIEW_DIRECTORY);
          else throw sourceError;
        }
      }
    }
  } catch (error) {
    current = { ...current, status: 'quarantining', move_error: error.message };
    await atomicWrite(errorQuarantinePath(errorPath), current, MAX_QUARANTINE_BYTES);
    return { complete: false, metadata: current };
  }
  if (missing.length) {
    current = { ...current, status: 'quarantining', move_error: `quarantine transfer is missing: ${missing.join(', ')}` };
    await atomicWrite(errorQuarantinePath(errorPath), current, MAX_QUARANTINE_BYTES);
    return { complete: false, metadata: current };
  }
  current = { ...current, status: 'quarantined', move_error: null };
  await atomicWrite(errorQuarantinePath(errorPath), current, MAX_QUARANTINE_BYTES);
  return { complete: true, metadata: current };
}

async function pruneQuarantinedStates(stateDir, now) {
  const root = errorStateRoot(stateDir); const deleted = []; const retained = []; let deletedCount = 0; let retainedCount = 0;
  let entries;
  try { entries = await fs.readdir(root, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return { deleted, retained, deleted_count: deletedCount, retained_count: retainedCount }; throw error; }
  for (const entry of entries) {
    const errorPath = path.join(root, entry.name);
    if (!entry.isDirectory() || !isDirectChild(root, errorPath)) {
      retainedCount++; retained.push({ error_path: errorPath, reason: 'unknown quarantine entry is not a direct regular directory' });
      continue;
    }
    let metadata = null;
    try { metadata = await readQuarantineMetadata(stateDir, errorPath); }
    catch (metadataError) {
      let expiry;
      try { expiry = await readQuarantineExpiry(stateDir, errorPath); }
      catch (expiryError) { retainedCount++; retained.push({ error_path: errorPath, reason: `${metadataError.message}; ${expiryError.message}` }); continue; }
      if (!expiry) { retainedCount++; retained.push({ error_path: errorPath, reason: `${metadataError.message}; expiry metadata is unavailable` }); continue; }
      if (now < Date.parse(expiry.delete_after)) {
        retainedCount++; retained.push({ task_id: expiry.task_id, error_path: errorPath, delete_after: expiry.delete_after, reason: 'quarantine metadata is unreadable; expiry retention period has not elapsed' });
        continue;
      }
      try {
        if (!await quarantineContentsAreSafe(errorPath, expiry)) {
          retainedCount++; retained.push({ task_id: expiry.task_id, error_path: errorPath, reason: 'quarantine contains unexpected files and requires manual recovery' });
          continue;
        }
        await fs.rm(errorPath, { recursive: true, force: false });
        deletedCount++; deleted.push({ task_id: expiry.task_id, error_path: errorPath, quarantined_at: expiry.quarantined_at, delete_after: expiry.delete_after, recovered_from_invalid_metadata: true });
      } catch (error) {
        retainedCount++; retained.push({ task_id: expiry.task_id, error_path: errorPath, reason: `quarantined state deletion failed: ${error.message}` });
      }
      continue;
    }
    try {
      const reconciled = await reconcileQuarantineEntry(stateDir, errorPath, metadata);
      metadata = reconciled.metadata;
      if (!reconciled.complete) {
        retainedCount++; retained.push({ task_id: metadata.task_id, error_path: errorPath, reason: 'quarantine transfer is incomplete and will be retried by a later cleanup' });
        continue;
      }
    } catch (error) {
      retainedCount++; retained.push({ task_id: metadata.task_id, error_path: errorPath, reason: `quarantine reconciliation failed: ${error.message}` });
      continue;
    }
    let expiry;
    try { expiry = await ensureQuarantineExpiry(stateDir, errorPath, metadata); }
    catch (error) { retainedCount++; retained.push({ task_id: metadata.task_id, error_path: errorPath, reason: `quarantine expiry metadata failed: ${error.message}` }); continue; }
    if (now < Date.parse(expiry.delete_after)) {
      retainedCount++; retained.push({ task_id: metadata.task_id, error_path: errorPath, delete_after: expiry.delete_after, reason: 'quarantined state retention period has not elapsed' });
      continue;
    }
    try {
      if (!await quarantineContentsAreSafe(errorPath, expiry)) {
        retainedCount++; retained.push({ task_id: metadata.task_id, error_path: errorPath, reason: 'quarantine contains unexpected files and requires manual recovery' });
        continue;
      }
      await fs.rm(errorPath, { recursive: true, force: false });
      deletedCount++; deleted.push({ task_id: metadata.task_id, error_path: errorPath, quarantined_at: metadata.quarantined_at, delete_after: metadata.delete_after });
    } catch (error) {
      retainedCount++; retained.push({ task_id: metadata.task_id, error_path: errorPath, reason: `quarantined state deletion failed: ${error.message}` });
    }
  }
  return { deleted, retained, deleted_count: deletedCount, retained_count: retainedCount };
}

async function reconcileQuarantinedStates(parameters) {
  const stateDir = requiredStateDirectory(parameters.state_dir);
  const root = errorStateRoot(stateDir);
  const reconciled = []; const retained = [];
  let entries;
  try { entries = await fs.readdir(root, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return { state_dir: stateDir, reconciled, retained, reconciled_count: 0, retained_count: 0 }; throw error; }
  for (const entry of entries) {
    const errorPath = path.join(root, entry.name);
    if (!entry.isDirectory() || !isDirectChild(root, errorPath)) {
      retained.push({ error_path: errorPath, reason: 'unknown quarantine entry is not a direct regular directory' });
      continue;
    }
    let metadata;
    try { metadata = await readQuarantineMetadata(stateDir, errorPath); }
    catch (error) { retained.push({ error_path: errorPath, reason: error.message }); continue; }
    try {
      const outcome = await reconcileQuarantineEntry(stateDir, errorPath, metadata);
      if (outcome.complete) reconciled.push({ task_id: outcome.metadata.task_id, error_path: errorPath, status: outcome.metadata.status });
      else retained.push({ task_id: outcome.metadata.task_id, error_path: errorPath, reason: outcome.metadata.move_error ?? 'quarantine transfer is incomplete' });
    } catch (error) {
      retained.push({ task_id: metadata.task_id, error_path: errorPath, reason: error.message });
    }
  }
  return { state_dir: stateDir, reconciled, retained, reconciled_count: reconciled.length, retained_count: retained.length };
}

async function findQuarantinedState(stateDir, filePath) {
  const root = errorStateRoot(stateDir);
  let entries;
  try { entries = await fs.readdir(root, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const errorPath = path.join(root, entry.name);
    try {
      const metadata = await readQuarantineMetadata(stateDir, errorPath);
      if (path.resolve(metadata.original_state_path) === path.resolve(filePath)) return metadata;
    } catch {
      // Malformed entries are intentionally left in place and are not attributed to a task.
    }
  }
  return null;
}

async function listOrphanLegacyPaths(stateDir) {
  let entries;
  try { entries = await fs.readdir(stateDir, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const orphaned = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json.legacy')) continue;
    const logicalPath = path.join(stateDir, entry.name.slice(0, -'.legacy'.length));
    try {
      await fs.access(logicalPath);
      continue;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    try {
      await fs.access(databasePath(logicalPath));
    } catch (error) {
      if (error.code === 'ENOENT') orphaned.push(entry.name);
      else throw error;
    }
  }
  return orphaned.sort();
}

async function doctorStateDirectory(parameters) {
  const stateDir = requiredStateDirectory(parameters.state_dir);
  const root = errorStateRoot(stateDir);
  const quarantinedStates = [];
  const invalidEntries = [];
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      const errorPath = path.join(root, entry.name);
      if (!entry.isDirectory()) { invalidEntries.push({ path: errorPath, reason: 'entry is not a quarantine directory' }); continue; }
      try {
        const metadata = await readQuarantineMetadata(stateDir, errorPath);
        quarantinedStates.push({ task_id: metadata.task_id, state_path: metadata.original_state_path, error_path: errorPath, status: metadata.status, delete_after: metadata.delete_after, review_artifacts: metadata.review_artifacts ?? null });
      } catch (error) {
        invalidEntries.push({ path: errorPath, reason: error.message });
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const orphanLegacy = await listOrphanLegacyPaths(stateDir);
  const pruneSweep = await readPruneSweep(stateDir);
  const attention = quarantinedStates.length > 0 || orphanLegacy.length > 0 || Boolean(pruneSweep.error);
  return {
    task_id: null,
    state_dir: stateDir,
    health: invalidEntries.length ? 'blocked' : attention ? 'attention' : 'healthy',
    checks: [
      doctorCheck('quarantined_states', invalidEntries.length ? 'fail' : quarantinedStates.length ? 'attention' : 'pass', { entries: quarantinedStates, invalid_entries: invalidEntries }),
      doctorCheck('orphan_legacy', orphanLegacy.length ? 'attention' : 'pass', { paths: orphanLegacy }),
      doctorCheck('prune_sweep', pruneSweep.error ? 'attention' : 'pass', pruneSweep.error ? { error: pruneSweep.error } : pruneSweep.sweep ?? { last_sweep_at: null, last_result: null }),
    ],
    close_status: { close_allowed: false, reasons: ['directory-level diagnosis does not represent a task close gate'] },
  };
}

async function listTaskStatePaths(stateDir) {
  const entries = await fs.readdir(stateDir, { withFileTypes: true });
  const paths = new Set();
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (entry.name.endsWith(SQLITE_STATE_SUFFIX)) {
      paths.add(path.join(stateDir, `${entry.name.slice(0, -SQLITE_STATE_SUFFIX.length)}.json`));
      continue;
    }
    if (!entry.name.endsWith('.json') || entry.name === 'workspace-lease.json' || entry.name === PRUNE_SWEEP_FILENAME) continue;
    const logicalPath = path.join(stateDir, entry.name);
    try {
      await fs.access(databasePath(logicalPath));
    } catch (error) {
      if (error.code === 'ENOENT') paths.add(logicalPath);
      else throw error;
    }
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json.legacy')) continue;
    const logicalPath = path.join(stateDir, entry.name.slice(0, -'.legacy'.length));
    if (paths.has(logicalPath)) continue;
    try {
      await fs.access(databasePath(logicalPath));
    } catch (error) {
      if (error.code === 'ENOENT') paths.add(logicalPath);
      else throw error;
    }
  }
  return [...paths].sort();
}

function appendPruneReport(reports, target, value) {
  if (Object.values(reports).reduce((count, entries) => count + entries.length, 0) < MAX_PRUNE_REPORT_ENTRIES) target.push(value);
}

function compactPruneResult(result) {
  return {
    deleted_count: result.deleted_count,
    quarantined_count: result.quarantined_count,
    retained_count: result.retained_count,
    quarantine_deleted_count: result.quarantine_deleted_count,
    quarantine_retained_count: result.quarantine_retained_count,
    report_truncated: result.report_truncated,
  };
}

function pruneSweepIsValid(value) {
  return hasExactFields(value, PRUNE_SWEEP_FIELDS)
    && value.version === 1
    && validTimestamp(value.last_sweep_at)
    && hasExactFields(value.last_result, PRUNE_RESULT_FIELDS)
    && Object.values(value.last_result).every(item => typeof item === 'boolean' || (Number.isSafeInteger(item) && item >= 0));
}

async function readPruneSweep(stateDir) {
  try {
    const sweep = await readJson(path.join(stateDir, PRUNE_SWEEP_FILENAME), { label: 'Prune sweep state', maxBytes: 4096 });
    if (!pruneSweepIsValid(sweep)) throw new ControllerError('Prune sweep state is invalid');
    return { sweep, error: null };
  } catch (error) {
    if (error instanceof ControllerError && error.message.includes('does not exist:')) return { sweep: null, error: null };
    return { sweep: null, error: error.message };
  }
}

async function pruneExpiredTasks(parameters) {
  const stateDir = requiredStateDirectory(parameters.state_dir);
  const now = Date.now();
  const reports = { deleted: [], quarantined: [], retained: [], quarantine_deleted: [], quarantine_retained: [] };
  const quarantinedStateCleanup = await pruneQuarantinedStates(stateDir, now);
  for (const entry of quarantinedStateCleanup.deleted) appendPruneReport(reports, reports.quarantine_deleted, entry);
  for (const entry of quarantinedStateCleanup.retained) appendPruneReport(reports, reports.quarantine_retained, entry);
  let filePaths;
  try { filePaths = await listTaskStatePaths(stateDir); }
  catch (error) {
    if (error.code === 'ENOENT') return {
      state_dir: stateDir,
      retention_days: DEFAULT_TASK_RETENTION_DAYS,
      quarantine_after_days: QUARANTINE_AFTER_DAYS,
      error_retention_days: ERROR_STATE_RETENTION_DAYS,
      deleted_count: 0,
      quarantined_count: 0,
      retained_count: 0,
      quarantine_deleted_count: quarantinedStateCleanup.deleted_count,
      quarantine_retained_count: quarantinedStateCleanup.retained_count,
      report_truncated: quarantinedStateCleanup.deleted_count > reports.quarantine_deleted.length || quarantinedStateCleanup.retained_count > reports.quarantine_retained.length,
      ...reports,
    };
    throw error;
  }
  let deletedCount = 0; let quarantinedCount = 0; let retainedCount = 0;
  for (const filePath of filePaths) {
    let initial;
    try { initial = await loadState(filePath); }
    catch (error) {
      const quarantine = await quarantineIfEligible(filePath, null, now);
      if (quarantine.quarantined) { quarantinedCount++; appendPruneReport(reports, reports.quarantined, { task_id: quarantine.task_id, state_path: filePath, error_path: quarantine.error_path, delete_after: quarantine.delete_after }); }
      else { retainedCount++; appendPruneReport(reports, reports.retained, { state_path: filePath, reason: `unreadable state: ${error.message}; ${quarantine.reason}` }); }
      continue;
    }
    const initialEligibility = taskPruneEligibility(initial, filePath, now);
    if (!initialEligibility.eligible) {
      const quarantine = await quarantineIfEligible(filePath, initial, now);
      if (quarantine.quarantined) { quarantinedCount++; appendPruneReport(reports, reports.quarantined, { task_id: quarantine.task_id, state_path: filePath, error_path: quarantine.error_path, delete_after: quarantine.delete_after }); }
      else { retainedCount++; appendPruneReport(reports, reports.retained, { task_id: initial.task_id ?? null, state_path: filePath, reason: quarantine.reason === 'younger than quarantine retention period' ? initialEligibility.reason : `${initialEligibility.reason}; ${quarantine.reason}` }); }
      continue;
    }
    const leasePath = initial.workspace_lease.registry_path;
    try {
      const outcome = await withStateLock(leasePath, async () => withStateLock(filePath, async () => {
        let state;
        try { state = await loadState(filePath); }
        catch (error) { if (error instanceof ControllerError && error.message.startsWith('JSON input does not exist:')) return { deleted: false, reason: 'state disappeared before cleanup' }; throw error; }
        const eligibility = taskPruneEligibility(state, filePath, now);
        if (!eligibility.eligible) return { deleted: false, reason: eligibility.reason, task_id: state.task_id };
        const leaseEligibility = await releasedLeaseEligibility(leasePath, state);
        if (!leaseEligibility.eligible) return { deleted: false, reason: leaseEligibility.reason, task_id: state.task_id };
        await deleteState(filePath);
        return { deleted: true, task_id: state.task_id };
      }));
      if (outcome.deleted) { deletedCount++; appendPruneReport(reports, reports.deleted, { task_id: outcome.task_id, state_path: filePath }); }
      else { retainedCount++; appendPruneReport(reports, reports.retained, { task_id: outcome.task_id ?? initial.task_id, state_path: filePath, reason: outcome.reason }); }
    } catch (error) {
      retainedCount++; appendPruneReport(reports, reports.retained, { task_id: initial.task_id, state_path: filePath, reason: `cleanup failed: ${error.message}` });
    }
  }
  return {
    state_dir: stateDir,
    retention_days: DEFAULT_TASK_RETENTION_DAYS,
    quarantine_after_days: QUARANTINE_AFTER_DAYS,
    error_retention_days: ERROR_STATE_RETENTION_DAYS,
    deleted_count: deletedCount,
    quarantined_count: quarantinedCount,
    retained_count: retainedCount,
    quarantine_deleted_count: quarantinedStateCleanup.deleted_count,
    quarantine_retained_count: quarantinedStateCleanup.retained_count,
    report_truncated: deletedCount > reports.deleted.length
      || quarantinedCount > reports.quarantined.length
      || retainedCount > reports.retained.length
      || quarantinedStateCleanup.deleted_count > reports.quarantine_deleted.length
      || quarantinedStateCleanup.retained_count > reports.quarantine_retained.length,
    ...reports,
  };
}

async function maybePruneExpiredTasks(parameters) {
  const stateDir = requiredStateDirectory(parameters.state_dir);
  try {
    const directory = await fs.stat(stateDir);
    if (!directory.isDirectory()) throw new ControllerError(`state_dir is not a directory: ${stateDir}`);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  const sweepPath = path.join(stateDir, PRUNE_SWEEP_FILENAME);
  await withStateLock(sweepPath, async () => {
    const { sweep: prior } = await readPruneSweep(stateDir);
    if (prior && Date.now() - Date.parse(prior.last_sweep_at) < PRUNE_SWEEP_INTERVAL_MS) return;
    const result = await pruneExpiredTasks({ state_dir: stateDir });
    await atomicWrite(sweepPath, { version: 1, last_sweep_at: utcNow(), last_result: compactPruneResult(result) });
  });
}

async function recoverTaskLock(parameters) {
  const [filePath, state] = await readTask(parameters);
  if (!state.workspace_lease) throw new ControllerError('Legacy task has no workspace lease and cannot recover its lock; create a new workflow task');
  return withStateLock(state.workspace_lease.registry_path, async () => {
    await requireActiveWorkspaceLease(state, filePath);
    return recoverStaleLock(filePath, parameters.stale_after_sec);
  });
}

async function auditContext(parameters) {
  const [, state] = await readTask(parameters);
  return { task_id: state.task_id, goal: state.goal, requirements: state.requirements, scope: state.scope, non_goals: state.non_goals, nodes: Object.values(state.nodes), participants: state.participants, reviews: state.reviews, workflow_snapshot: workflowSnapshot(state), workspace_fingerprint: await workspaceFingerprint(state.workspace) };
}

async function recordReview(parameters) {
  const review = await readJson(parameters.review, { label: 'Review', maxBytes: MAX_REVIEW_BYTES }); if (!review || typeof review !== 'object') throw new ControllerError('Review must be a JSON object');
  const [filePath] = await readTask(parameters);
  return withStateLock(filePath, async () => {
    const state = normalizeState(await loadState(filePath)); await requireActiveWorkspaceLease(state, filePath); const auditor = String(review.auditor_task ?? ''); const role = String(review.auditor_role ?? ''); const verdict = String(review.verdict ?? '');
    const priorReviewers = new Set(state.reviews.map(item => item.auditor_task));
    const participatedOutsideTotalReview = state.participants.some(item => item.agent_task_path === auditor && state.nodes[item.node_id]?.kind !== 'total_review');
    if (!auditor || participatedOutsideTotalReview || priorReviewers.has(auditor)) throw new ControllerError('Total reviewer must be a new agent that did not previously participate');
    if (!SOL_ROLES.has(role) && role !== FALLBACK_ROLE) throw new ControllerError('Unsupported total reviewer role');
    const totalReviewNode = Object.values(state.nodes).find(node => node.kind === 'total_review' && node.status === RUNNING && node.agent_task_path === auditor);
    if (!totalReviewNode) throw new ControllerError('Total reviewer must own a running total_review node');
    if (totalReviewNode.agent_role !== role) throw new ControllerError('Total reviewer role must match its claimed total_review node');
    requireActiveClaim(totalReviewNode, { node_id: totalReviewNode.id, claim_id: review.claim_id });
    if (!totalReviewNode.activation_at || totalReviewNode.heartbeat_count < 1) throw new ControllerError('Total reviewer must activate its claim with workflow_heartbeat before recording a review');
    if (role === FALLBACK_ROLE && !review.fallback_reason) throw new ControllerError('Terra fallback review requires fallback_reason');
    if (!['pass', 'fail', 'unavailable'].includes(verdict)) throw new ControllerError('Review verdict must be pass, fail, or unavailable');
    const expectedIds = new Set(state.requirements.map(item => item.id)); const coverage = review.requirement_coverage;
    if (!coverage || typeof coverage !== 'object' || Array.isArray(coverage) || Object.keys(coverage).length !== expectedIds.size || [...expectedIds].some(id => !hasOwn(coverage, id) || !nonEmptyReviewValue(coverage[id]))) throw new ControllerError('Review must provide non-empty coverage for every requirement');
    const snapshot = workflowSnapshot(state);
    if (!sameJson(review.workflow_snapshot, snapshot)) throw new ControllerError('Review workflow_snapshot does not match the current task state');
    const unfinishedMaterialNodes = Object.values(state.nodes).filter(node => node.kind !== 'total_review' && ![SUCCEEDED, 'skipped'].includes(node.status));
    if (unfinishedMaterialNodes.length) throw new ControllerError(`Total review cannot be recorded before all work nodes finish: ${unfinishedMaterialNodes.map(node => node.id).join(', ')}`);
    const fingerprint = await workspaceFingerprint(state.workspace);
    if (!sameJson(review.workspace_fingerprint, fingerprint)) throw new ControllerError('Review fingerprint does not match the current workspace');
    const scopeAndRegression = requiredReviewValue(review.scope_and_regression, 'scope_and_regression');
    const verificationGaps = requiredReviewValue(review.verification_gaps, 'verification_gaps');
    const residualRisk = requiredReviewValue(review.residual_risk, 'residual_risk');
    if (state.reviews.length >= MAX_REVIEWS) throw new ControllerError(`Task exceeded the ${MAX_REVIEWS}-review limit; create a replacement workflow task`);
    const stored = { auditor_task: auditor, auditor_role: role, node_id: totalReviewNode.id, claim_id: totalReviewNode.claim_id, verdict, requirement_coverage: coverage, scope_and_regression: scopeAndRegression, verification_gaps: verificationGaps, residual_risk: residualRisk, fallback_reason: review.fallback_reason ?? null, workflow_snapshot: snapshot, workspace_fingerprint: fingerprint, recorded_at: utcNow() };
    state.reviews.push(stored); addEvent(state, 'total_review_recorded', { auditor_task: auditor, verdict }); await writeState(filePath, state);
    return { task_id: state.task_id, review: stored };
  });
}

async function closeReasons(state) {
  const incomplete = Object.entries(state.nodes).filter(([, node]) => ![SUCCEEDED, 'skipped'].includes(node.status)).map(([id]) => id);
  const reasons = incomplete.length ? [`incomplete nodes: ${incomplete.join(', ')}`] : [];
  const totalReview = Object.values(state.nodes).find(node => node.kind === 'total_review');
  if (!totalReview || totalReview.status !== SUCCEEDED) reasons.push('total_review is not succeeded');
  if (totalReview && !isCompletedWorkflowOutcome(totalReview.result, state, totalReview)) reasons.push('total_review workflow outcome completion is pending or invalid');
  const review = state.reviews.at(-1);
  if (!review) reasons.push('no total review'); else {
    if (review.verdict !== 'pass') reasons.push(`latest review verdict is ${review.verdict}`);
    if (!totalReview || review.node_id !== totalReview.id || review.claim_id !== totalReview.claim_id || review.auditor_task !== totalReview.agent_task_path || review.auditor_role !== totalReview.agent_role) reasons.push('latest review does not belong to the succeeded total_review node');
    if (!review.workflow_snapshot || !sameJson(review.workflow_snapshot, workflowSnapshot(state))) reasons.push('task state changed after total review');
    if (!sameJson(review.workspace_fingerprint, await workspaceFingerprint(state.workspace))) reasons.push('workspace changed after total review');
  }
  return reasons;
}

async function closeCheck(parameters) {
  const [filePath, initialState] = await readTask(parameters);
  if (!initialState.workspace_lease) {
    const reasons = await closeReasons(initialState);
    return [{ task_id: initialState.task_id, close_allowed: !reasons.length, reasons, workspace_lease: { released: false, reason: 'legacy task has no workspace lease' } }, reasons.length ? 2 : 0];
  }
  const leasePath = initialState.workspace_lease.registry_path;
  return withStateLock(leasePath, async () => withStateLock(filePath, async () => {
    const state = normalizeState(await loadState(filePath));
    if (state.workspace_lease.status === 'released') {
      const lease = await loadWorkspaceLease(leasePath, state.workspace);
      let selfHealed = false;
      if (lease.active_task?.task_id === state.task_id && lease.active_task?.state_path === filePath) {
        lease.active_task = null; lease.updated_at = utcNow(); await atomicWrite(leasePath, lease); selfHealed = true;
      }
      const reasons = await closeReasons(state);
      return [{ task_id: state.task_id, close_allowed: !reasons.length, reasons, workspace_lease: { released: true, already_released: true, self_healed: selfHealed, lease_path: leasePath } }, reasons.length ? 2 : 0];
    }
    const lease = await requireActiveWorkspaceLease(state, filePath);
    const reasons = await closeReasons(state);
    if (reasons.length) return [{ task_id: state.task_id, close_allowed: false, reasons }, 2];
    state.workspace_lease.status = 'released'; state.workspace_lease.released_at = utcNow(); state.closed_revision = state.workflow_revision; state.closed_at = utcNow();
    addEvent(state, 'workspace_lease_released', { close_allowed: true }); await writeState(filePath, state);
    lease.active_task = null; lease.updated_at = utcNow(); await atomicWrite(leasePath, lease);
    return [{ task_id: state.task_id, close_allowed: true, reasons: [], workspace_lease: { released: true, lease_path: leasePath } }, 0];
  }));
}

export async function dispatch(command, parameters) {
  if (command === 'prune-expired') return [await pruneExpiredTasks(parameters), 0];
  if (command === 'reconcile-quarantine') return [await reconcileQuarantinedStates(parameters), 0];
  // Diagnostic commands stay side-effect free; other operations lazily keep expired state bounded.
  if (parameters && hasOwn(parameters, 'state_dir') && !READ_ONLY_COMMANDS.has(command)) await maybePruneExpiredTasks(parameters);
  switch (command) {
    case 'init': return [await initTask(parameters), 0]; case 'reconcile-workspace': return [await reconcileWorkspace(parameters), 0]; case 'add-node': return [await addNode(parameters), 0];
    case 'ready': return [{ ready_nodes: readyNodes((await readTask(parameters))[1]) }, 0]; case 'claim': return [await claimNode(parameters), 0]; case 'start': return [await claimNode(parameters, true), 0];
    case 'complete': return [await completeNode(parameters), 0]; case 'heartbeat': return [await heartbeatNode(parameters), 0]; case 'checkpoint': return [await checkpointNode(parameters), 0];
    case 'abandon': return [await abandonNode(parameters), 0]; case 'retry': return [await retryNode(parameters), 0]; case 'requeue-stale': return [await requeueStaleNode(parameters), 0]; case 'rescue': return [await rescueNode(parameters), 0];
    case 'recover-lock': return [await recoverTaskLock(parameters), 0]; case 'audit-context': return [await auditContext(parameters), 0];
    case 'record-review': return [await recordReview(parameters), 0]; case 'close-check': return closeCheck(parameters);
    case 'release-workspace': return [await releaseWorkspaceLease(parameters), 0];
    case 'stale': {
      const [, state] = await readTask(parameters);
      return [{ task_id: state.task_id, stale_nodes: staleNodes(state) }, 0];
    }
    case 'status': return [compactState((await readTask(parameters))[1]), 0]; case 'doctor': return [await doctorTask(parameters), 0]; case 'fingerprint': return [{ workspace_fingerprint: await workspaceFingerprint(parameters.workspace) }, 0];
    default: throw new ControllerError(`Unknown command: ${command}`);
  }
}

function parseCli(argumentsList) {
  const values = {}; let command = null;
  for (let index = 0; index < argumentsList.length; index++) {
    const value = argumentsList[index];
    if (!value.startsWith('--') && !command) { command = value; continue; }
    if (!value.startsWith('--')) throw new ControllerError(`Unexpected argument: ${value}`);
    values[value.slice(2).replaceAll('-', '_')] = argumentsList[++index];
  }
  if (!command) throw new ControllerError('A command is required');
  return { command, ...values };
}

export async function main() {
  try { const parameters = parseCli(process.argv.slice(2)); const { command, ...rest } = parameters; const [result, exitCode] = await dispatch(command, rest); process.stdout.write(`${JSON.stringify(result, null, 2)}\n`); process.exitCode = exitCode; }
  catch (error) { process.stderr.write(`${JSON.stringify({ error: error.message })}\n`); process.exitCode = 1; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
