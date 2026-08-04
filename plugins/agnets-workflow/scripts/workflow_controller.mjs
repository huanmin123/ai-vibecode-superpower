import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const VERSION = 1;
const PENDING = 'pending';
const RUNNING = 'running';
const SUCCEEDED = 'succeeded';
const TERMINAL = new Set([SUCCEEDED, 'failed', 'blocked', 'skipped', 'unavailable', 'abandoned']);
const COMPLETABLE = new Set([SUCCEEDED, 'failed', 'blocked', 'skipped', 'unavailable']);
const SOL_ROLES = new Set(['avsp_sol_high', 'avsp_sol_xhigh']);
const FALLBACK_ROLE = 'avsp_terra_xhigh_readonly';
const LUNA_EXECUTOR_ROLES = new Set(['avsp_luna_high_executor', 'avsp_luna_xhigh_executor']);
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
const DAY_MS = 24 * 60 * 60 * 1000;

export class ControllerError extends Error {}

const utcNow = () => new Date().toISOString();
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const DEFAULT_STALE_LOCK_SEC = 30;
const DEFAULT_LEASE_SEC = 1800;
const DEFAULT_ACTIVATION_TIMEOUT_SEC = 120;
const WORKSPACE_LEASE_VERSION = 1;

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

function requiredReviewValue(value, name) {
  if (value === undefined || value === null) throw new ControllerError(`${name} is required`);
  if (typeof value === 'string' && !value.trim()) throw new ControllerError(`${name} must not be empty`);
  if (Array.isArray(value) && !value.length) throw new ControllerError(`${name} must not be empty`);
  if (typeof value === 'object' && !Array.isArray(value) && !Object.keys(value).length) throw new ControllerError(`${name} must not be empty`);
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
  await fs.writeFile(temporary, serialized, 'utf8');
  await fs.rename(temporary, filePath);
}

function statePath(stateDir, taskId) {
  requiredIdentifier(taskId, 'task_id');
  return path.join(path.resolve(stateDir), `${taskId}.json`);
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
  const state = await readJson(filePath, { label: 'Controller state', maxBytes: MAX_STATE_BYTES });
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
      if (!IGNORED_DIRECTORIES.has(entry.name)) await walkFiles(root, path.join(directory, entry.name), files);
    } else if (entry.isSymbolicLink()) {
      throw new ControllerError(`Workspace contains a symbolic link that cannot be fingerprinted safely: ${entryPath}`);
    } else if (entry.isFile()) {
      files.push(path.relative(root, path.join(directory, entry.name)));
      if (files.length > MAX_FINGERPRINT_FILES) throw new ControllerError(`Workspace exceeds the ${MAX_FINGERPRINT_FILES}-file fingerprint limit`);
    }
  }
  return files;
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

function stableJson(value) {
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

function sameJson(left, right) { return stableJson(left) === stableJson(right); }

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
  if (!['delegable', 'protected'].includes(executionRisk)) throw new ControllerError('node.execution_risk must be delegable or protected');
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
  return { id, kind, agent_type: raw.agent_type ?? null, depends_on: dependencies, ...nodeRouting(raw, options.routingRequired === true), status: PENDING, agent_task_path: null, agent_thread_id: null, agent_role: null, claim_id: null, claimed_at: null, activation_at: null, activation_deadline_at: null, heartbeat_at: null, heartbeat_count: 0, lease_duration_sec: null, attempt: 0, result: null, checkpoint: null, checkpoint_at: null, recovery_history: [] };
}

function normalizeState(state) {
  state.workflow_revision ??= 0;
  state.closed_revision ??= null;
  state.closed_at ??= null;
  for (const node of Object.values(state.nodes ?? {})) {
    node.agent_thread_id ??= null; node.agent_role ??= null; node.claim_id ??= null; node.claimed_at ??= null; node.activation_at ??= null; node.activation_deadline_at ??= null; node.heartbeat_at ??= null;
    node.lease_duration_sec ??= null; node.heartbeat_count ??= 0; node.attempt ??= node.agent_task_path ? 1 : 0;
    node.checkpoint ??= null; node.checkpoint_at ??= null; node.recovery_history ??= [];
    if (!hasOwn(node, 'execution_risk')) Object.assign(node, nodeRouting(node, false));
  }
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
      return [{ id: node.id, agent_task_path: node.agent_task_path, claim_id: node.claim_id, reason: 'never_activated', claimed_at: node.claimed_at, activation_deadline_at: new Date(deadline).toISOString(), lease_duration_sec: node.lease_duration_sec }];
    }
    const heartbeat = Date.parse(node.heartbeat_at);
    if (!Number.isFinite(heartbeat) || heartbeat + node.lease_duration_sec * 1000 >= now) return [];
    return [{ id: node.id, agent_task_path: node.agent_task_path, claim_id: node.claim_id, reason: 'heartbeat_expired', heartbeat_at: node.heartbeat_at, lease_duration_sec: node.lease_duration_sec }];
  });
}

function compactState(state) {
  return { task_id: state.task_id, workspace: state.workspace, workspace_lease: state.workspace_lease ?? null, goal: state.goal, nodes: Object.values(state.nodes), ready_nodes: readyNodes(state), stale_nodes: staleNodes(state), participants: state.participants, reviews: state.reviews, updated_at: state.updated_at };
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
  const [filePath, initialState] = await readTask(parameters);
  const stateLease = initialState.workspace_lease;
  if (!stateLease) return { released: false, reason: 'legacy task has no workspace lease' };
  const leasePath = stateLease.registry_path;
  return withStateLock(leasePath, async () => withStateLock(filePath, async () => {
    const state = normalizeState(await loadState(filePath));
    const running = Object.values(state.nodes).filter(node => node.status === RUNNING).map(node => node.id);
    if (running.length) throw new ControllerError(`Cannot release workspace lease while nodes are running: ${running.join(', ')}`);
    if (!closeAllowed) trueValue(parameters.previous_agents_stopped, 'previous_agents_stopped');
    const lease = await loadWorkspaceLease(leasePath, state.workspace);
    if (state.workspace_lease.status === 'released' && !lease.active_task) return { released: true, already_released: true, lease_path: leasePath };
    if (!workspaceLeaseMatches(lease, state, filePath)) throw new ControllerError(`Workspace lease does not belong to this active task: ${leasePath}`);
    if (state.workspace_lease.status !== 'released') {
      state.workspace_lease.status = 'released'; state.workspace_lease.released_at = utcNow();
      addEvent(state, 'workspace_lease_released', { close_allowed: closeAllowed }); await atomicWrite(filePath, state);
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
      try { await fs.access(filePath); throw new ControllerError(`Task already exists: ${state.task_id}`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      lease.active_task = { task_id: state.task_id, state_path: filePath, state_dir: path.dirname(filePath), acquired_at: state.workspace_lease.acquired_at, phase: 'initializing' };
      lease.updated_at = utcNow(); await atomicWrite(leasePath, lease);
      try { await atomicWrite(filePath, state); }
      catch (error) {
        lease.active_task = null; lease.updated_at = utcNow(); await atomicWrite(leasePath, lease);
        throw error;
      }
    });
    lease.active_task.phase = 'active'; lease.updated_at = utcNow();
    try { await atomicWrite(leasePath, lease); }
    catch (error) {
      await fs.unlink(filePath).catch(cleanupError => { if (cleanupError.code !== 'ENOENT') throw cleanupError; });
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

async function claimNode(parameters) {
  const [filePath] = await readTask(parameters); const nodeId = requiredIdentifier(parameters.node_id, 'node_id'); const taskPath = requiredString(parameters.agent_task_path, 'agent_task_path'); const threadId = optionalString(parameters.agent_thread_id, 'agent_thread_id'); const role = requiredString(parameters.agent_role, 'agent_role'); const leaseDurationSec = positiveInteger(parameters.lease_duration_sec, 'lease_duration_sec', DEFAULT_LEASE_SEC); const activationTimeoutSec = positiveInteger(parameters.activation_timeout_sec, 'activation_timeout_sec', Math.min(DEFAULT_ACTIVATION_TIMEOUT_SEC, leaseDurationSec));
  return withStateLock(filePath, async () => {
    const state = normalizeState(await loadState(filePath)); await requireActiveWorkspaceLease(state, filePath); const node = state.nodes[nodeId];
    if (!node || !readyNodes(state).some(candidate => candidate.id === nodeId)) throw new ControllerError(`Node is not ready: ${nodeId}`);
    if (runningParticipantPaths(state).has(taskPath)) throw new ControllerError('Agent already has a running node in this task');
    if (node.kind === 'total_review' && participantPaths(state).has(taskPath)) throw new ControllerError('A prior participant cannot claim the total review');
    if (node.agent_type && node.agent_type !== role) throw new ControllerError(`Node agent_type must match claimed role: ${node.agent_type}`);
    // Total reviews are read-only guards, not protected execution work.
    if (node.execution_risk === 'protected' && node.kind !== 'total_review' && role !== PROTECTED_EXECUTOR_ROLE) throw new ControllerError('Only avsp_terra_high can claim protected work');
    if (LUNA_EXECUTOR_ROLES.has(role)) {
      if (node.routing_legacy || node.execution_risk !== 'delegable') throw new ControllerError('A Luna executor requires complete delegable routing metadata');
      if (node.execution_owner !== taskPath) throw new ControllerError('Luna executor claim must match node execution_owner');
    }
    if (!node.routing_legacy && node.execution_owner !== taskPath) throw new ControllerError('Node claim must match execution_owner');
    if (node.attempt >= MAX_NODE_ATTEMPTS) throw new ControllerError(`Node exceeded the ${MAX_NODE_ATTEMPTS}-attempt limit: ${nodeId}`);
    const now = utcNow(); node.status = RUNNING; node.agent_task_path = taskPath; node.agent_thread_id = threadId; node.agent_role = role; node.claim_id = randomUUID(); node.claimed_at = now; node.activation_at = null; node.activation_deadline_at = new Date(Date.now() + activationTimeoutSec * 1000).toISOString(); node.heartbeat_at = now; node.heartbeat_count = 0; node.lease_duration_sec = leaseDurationSec; node.attempt += 1;
    state.participants.push({ agent_task_path: taskPath, agent_thread_id: threadId, agent_role: role, node_id: nodeId, claim_id: node.claim_id, attempt: node.attempt });
    addEvent(state, 'node_claimed', { node_id: nodeId, agent_task_path: taskPath, agent_thread_id: threadId, agent_role: role, claim_id: node.claim_id, attempt: node.attempt }); await atomicWrite(filePath, state);
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

async function completeNode(parameters) {
  const status = String(parameters.status); if (!COMPLETABLE.has(status)) throw new ControllerError(`Completion status must be one of: ${[...COMPLETABLE].sort().join(', ')}`);
  const result = await readJson(parameters.result, { label: 'Node result', maxBytes: MAX_NODE_RESULT_BYTES }); const [filePath] = await readTask(parameters); const nodeId = requiredIdentifier(parameters.node_id, 'node_id');
  return withStateLock(filePath, async () => {
    const state = normalizeState(await loadState(filePath)); await requireActiveWorkspaceLease(state, filePath); const node = state.nodes[nodeId]; requireActiveClaim(node, parameters);
    if (node.kind === 'total_review' && status === 'skipped') throw new ControllerError('A total_review node cannot be skipped');
    if (node.kind === 'total_review' && status === SUCCEEDED && !hasRecordedReview(state, node)) throw new ControllerError('A successful total_review requires a recorded review for its active claim');
    node.status = status; node.result = result;
    if (node.kind === 'total_review') addEvent(state, 'node_completed', { node_id: nodeId, status });
    else bumpWorkflowRevision(state, 'node_completed', { node_id: nodeId, status });
    await atomicWrite(filePath, state);
    return { task_id: state.task_id, node, ready_nodes: readyNodes(state) };
  });
}

async function heartbeatNode(parameters) {
  const [filePath] = await readTask(parameters); const nodeId = requiredIdentifier(parameters.node_id, 'node_id');
  return withStateLock(filePath, async () => {
    const state = normalizeState(await loadState(filePath)); await requireActiveWorkspaceLease(state, filePath); const node = state.nodes[nodeId]; requireActiveClaim(node, parameters);
    const now = utcNow(); node.activation_at ??= now; node.activation_deadline_at = null; node.heartbeat_at = now; node.heartbeat_count += 1; state.updated_at = now; await atomicWrite(filePath, state);
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
    node.checkpoint = checkpoint; node.checkpoint_at = utcNow(); state.updated_at = node.checkpoint_at; await atomicWrite(filePath, state);
    return { task_id: state.task_id, node_id: nodeId, checkpoint_at: node.checkpoint_at };
  });
}

function compactRecoveryResult(result) {
  const serialized = stableJson(result) ?? 'null';
  const bytes = Buffer.byteLength(serialized, 'utf8');
  if (bytes <= MAX_RECOVERY_RESULT_BYTES) return { value: result, bytes, truncated: false };
  return { bytes, truncated: true, digest: createHash('sha256').update(serialized).digest('hex') };
}

function recoveryPacket(state, node, stale, reason) {
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
    stale_reason: stale.reason,
    checkpoint: node.checkpoint,
    checkpoint_at: node.checkpoint_at,
    recovery_reason: reason,
  };
  return {
    version: 1,
    continuation: node.agent_thread_id
      ? { kind: 'native_resume_candidate', agent_thread_id: node.agent_thread_id, requirement: 'Only use when the current Codex runtime exposes resume_agent and the old agent is closed.' }
      : { kind: 'new_agent_required', reason: 'No native agent thread ID was recorded for this attempt.' },
    task: { task_id: state.task_id, workspace: state.workspace, goal: state.goal, requirements: state.requirements, scope: state.scope, non_goals: state.non_goals },
    node: { id: node.id, kind: node.kind, agent_type: node.agent_type, depends_on: node.depends_on, execution_risk: node.execution_risk, routing_reason: node.routing_reason, execution_owner: node.execution_owner, integration_owner: node.integration_owner, quality_guard: node.quality_guard },
    completed_dependencies: node.depends_on.map(id => ({ id, status: state.nodes[id].status, result: compactRecoveryResult(state.nodes[id].result) })),
    previous_attempt: previousAttempt,
    instructions: 'This is a replacement agent. Do not assume the previous agent session was restored. Inspect the current workspace and diff, validate the saved checkpoint and dependency evidence, then write a fresh checkpoint before material work.',
  };
}

function clearAttemptForRetry(node) {
  node.status = PENDING; node.agent_task_path = null; node.agent_thread_id = null; node.agent_role = null; node.claim_id = null; node.claimed_at = null; node.activation_at = null; node.activation_deadline_at = null; node.heartbeat_at = null; node.heartbeat_count = 0; node.lease_duration_sec = null; node.result = null; node.checkpoint = null; node.checkpoint_at = null;
}

async function requeueStaleNode(parameters) {
  const [filePath] = await readTask(parameters); const nodeId = requiredIdentifier(parameters.node_id, 'node_id'); const reason = requiredString(parameters.reason, 'reason'); retryConfirmation(parameters); const claimId = requiredString(parameters.claim_id, 'claim_id');
  return withStateLock(filePath, async () => {
    const state = normalizeState(await loadState(filePath)); await requireActiveWorkspaceLease(state, filePath); const node = state.nodes[nodeId]; requireActiveClaim(node, parameters);
    const stale = staleNodes(state).find(candidate => candidate.id === nodeId && candidate.claim_id === claimId);
    if (!stale) throw new ControllerError(`Node is not stale for its active claim: ${nodeId}`);
    if (node.attempt >= MAX_NODE_ATTEMPTS) throw new ControllerError(`Node exceeded the ${MAX_NODE_ATTEMPTS}-attempt limit: ${nodeId}`);
    const packet = recoveryPacket(state, node, stale, reason);
    node.recovery_history.push({ at: utcNow(), ...packet.previous_attempt });
    if (node.recovery_history.length > MAX_NODE_ATTEMPTS) node.recovery_history.splice(0, node.recovery_history.length - MAX_NODE_ATTEMPTS);
    clearAttemptForRetry(node);
    const details = { node_id: nodeId, prior_claim_id: claimId, reason, stale_reason: stale.reason, previous_agent_stopped: true, auto_requeue: true };
    if (node.kind === 'total_review') addEvent(state, 'stale_node_requeued', details); else bumpWorkflowRevision(state, 'stale_node_requeued', details);
    await atomicWrite(filePath, state);
    return { task_id: state.task_id, node, recovery_package: packet, ready_nodes: readyNodes(state) };
  });
}

async function abandonNode(parameters) {
  const [filePath] = await readTask(parameters); const nodeId = requiredIdentifier(parameters.node_id, 'node_id'); const reason = requiredString(parameters.reason, 'reason');
  return withStateLock(filePath, async () => {
    const state = normalizeState(await loadState(filePath)); await requireActiveWorkspaceLease(state, filePath); const node = state.nodes[nodeId]; requireActiveClaim(node, parameters);
    node.status = 'abandoned'; node.result = { summary: 'Node abandoned after explicit reconciliation.', reason, abandoned_at: utcNow(), claim_id: node.claim_id };
    if (node.kind === 'total_review') addEvent(state, 'node_abandoned', { node_id: nodeId, claim_id: node.claim_id, reason });
    else bumpWorkflowRevision(state, 'node_abandoned', { node_id: nodeId, claim_id: node.claim_id, reason });
    await atomicWrite(filePath, state);
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
    const priorClaimId = node.claim_id; clearAttemptForRetry(node);
    const details = { node_id: nodeId, prior_claim_id: priorClaimId, reason, previous_agent_stopped: true, orphaned_total_review: orphanedTotalReview };
    if (node.kind === 'total_review') addEvent(state, 'node_retried', details); else bumpWorkflowRevision(state, 'node_retried', details);
    await atomicWrite(filePath, state);
    return { task_id: state.task_id, node, ready_nodes: readyNodes(state) };
  });
}

function taskPruneEligibility(state, filePath, now) {
  const updatedAt = Date.parse(state.updated_at);
  if (!Number.isFinite(updatedAt)) return { eligible: false, reason: 'invalid updated_at' };
  if (now - updatedAt < DEFAULT_TASK_RETENTION_DAYS * DAY_MS) return { eligible: false, reason: 'younger than retention period' };
  if (!state.workspace_lease || state.workspace_lease.status !== 'released') return { eligible: false, reason: 'workspace lease is not released' };
  if (Object.values(state.nodes).some(node => node.status === RUNNING)) return { eligible: false, reason: 'has running nodes' };
  if (typeof state.workspace_lease.registry_path !== 'string' || !path.isAbsolute(state.workspace_lease.registry_path)) return { eligible: false, reason: 'invalid workspace lease path' };
  if (path.resolve(state.workspace_lease.registry_path) === path.resolve(filePath)) return { eligible: false, reason: 'state path conflicts with workspace lease path' };
  return { eligible: true };
}

async function pruneExpiredTasks(parameters) {
  const stateDir = requiredStateDirectory(parameters.state_dir);
  let entries;
  try { entries = await fs.readdir(stateDir, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return { state_dir: stateDir, retention_days: DEFAULT_TASK_RETENTION_DAYS, deleted: [], retained: [] }; throw error; }
  const now = Date.now(); const deleted = []; const retained = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json') || entry.name === 'workspace-lease.json') continue;
    const filePath = path.join(stateDir, entry.name);
    let initial;
    try { initial = normalizeState(await loadState(filePath)); }
    catch (error) { retained.push({ state_path: filePath, reason: `unreadable state: ${error.message}` }); continue; }
    const initialEligibility = taskPruneEligibility(initial, filePath, now);
    if (!initialEligibility.eligible) { retained.push({ task_id: initial.task_id, state_path: filePath, reason: initialEligibility.reason }); continue; }
    const leasePath = initial.workspace_lease.registry_path;
    try {
      const outcome = await withStateLock(leasePath, async () => withStateLock(filePath, async () => {
        let state;
        try { state = normalizeState(await loadState(filePath)); }
        catch (error) { if (error instanceof ControllerError && error.message.startsWith('JSON input does not exist:')) return { deleted: false, reason: 'state disappeared before cleanup' }; throw error; }
        const eligibility = taskPruneEligibility(state, filePath, now);
        if (!eligibility.eligible) return { deleted: false, reason: eligibility.reason, task_id: state.task_id };
        const lease = await loadWorkspaceLease(leasePath, state.workspace);
        if (lease.active_task?.state_path === filePath || lease.active_task?.task_id === state.task_id) return { deleted: false, reason: 'workspace lease still references task', task_id: state.task_id };
        await fs.unlink(filePath);
        return { deleted: true, task_id: state.task_id };
      }));
      if (outcome.deleted) deleted.push({ task_id: outcome.task_id, state_path: filePath });
      else retained.push({ task_id: outcome.task_id ?? initial.task_id, state_path: filePath, reason: outcome.reason });
    } catch (error) {
      retained.push({ task_id: initial.task_id, state_path: filePath, reason: `cleanup failed: ${error.message}` });
    }
  }
  return { state_dir: stateDir, retention_days: DEFAULT_TASK_RETENTION_DAYS, deleted, retained };
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
    const state = await loadState(filePath); await requireActiveWorkspaceLease(state, filePath); const auditor = String(review.auditor_task ?? ''); const role = String(review.auditor_role ?? ''); const verdict = String(review.verdict ?? '');
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
    if (!coverage || typeof coverage !== 'object' || Object.keys(coverage).length !== expectedIds.size || [...expectedIds].some(id => !hasOwn(coverage, id) || !coverage[id])) throw new ControllerError('Review must provide non-empty coverage for every requirement');
    const snapshot = workflowSnapshot(state);
    if (!sameJson(review.workflow_snapshot, snapshot)) throw new ControllerError('Review workflow_snapshot does not match the current task state');
    const unfinishedMaterialNodes = Object.values(state.nodes).filter(node => node.kind !== 'total_review' && ![SUCCEEDED, 'skipped'].includes(node.status));
    if (unfinishedMaterialNodes.length) throw new ControllerError(`Total review cannot be recorded before all work nodes finish: ${unfinishedMaterialNodes.map(node => node.id).join(', ')}`);
    const fingerprint = await workspaceFingerprint(state.workspace);
    if (JSON.stringify(review.workspace_fingerprint) !== JSON.stringify(fingerprint)) throw new ControllerError('Review fingerprint does not match the current workspace');
    const scopeAndRegression = requiredReviewValue(review.scope_and_regression, 'scope_and_regression');
    const verificationGaps = requiredReviewValue(review.verification_gaps, 'verification_gaps');
    const residualRisk = requiredReviewValue(review.residual_risk, 'residual_risk');
    if (state.reviews.length >= MAX_REVIEWS) throw new ControllerError(`Task exceeded the ${MAX_REVIEWS}-review limit; create a replacement workflow task`);
    const stored = { auditor_task: auditor, auditor_role: role, node_id: totalReviewNode.id, claim_id: totalReviewNode.claim_id, verdict, requirement_coverage: coverage, scope_and_regression: scopeAndRegression, verification_gaps: verificationGaps, residual_risk: residualRisk, fallback_reason: review.fallback_reason ?? null, workflow_snapshot: snapshot, workspace_fingerprint: fingerprint, recorded_at: utcNow() };
    state.reviews.push(stored); addEvent(state, 'total_review_recorded', { auditor_task: auditor, verdict }); await atomicWrite(filePath, state);
    return { task_id: state.task_id, review: stored };
  });
}

async function closeReasons(state) {
  const incomplete = Object.entries(state.nodes).filter(([, node]) => ![SUCCEEDED, 'skipped'].includes(node.status)).map(([id]) => id);
  const reasons = incomplete.length ? [`incomplete nodes: ${incomplete.join(', ')}`] : [];
  const totalReview = Object.values(state.nodes).find(node => node.kind === 'total_review');
  if (!totalReview || totalReview.status !== SUCCEEDED) reasons.push('total_review is not succeeded');
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
    addEvent(state, 'workspace_lease_released', { close_allowed: true }); await atomicWrite(filePath, state);
    lease.active_task = null; lease.updated_at = utcNow(); await atomicWrite(leasePath, lease);
    return [{ task_id: state.task_id, close_allowed: true, reasons: [], workspace_lease: { released: true, lease_path: leasePath } }, 0];
  }));
}

export async function dispatch(command, parameters) {
  if (command === 'prune-expired') return [await pruneExpiredTasks(parameters), 0];
  // MCP is not a persistent daemon. Each state-dir operation performs the seven-day cleanup sweep.
  if (parameters && hasOwn(parameters, 'state_dir')) await pruneExpiredTasks(parameters);
  switch (command) {
    case 'init': return [await initTask(parameters), 0]; case 'reconcile-workspace': return [await reconcileWorkspace(parameters), 0]; case 'add-node': return [await addNode(parameters), 0];
    case 'ready': return [{ ready_nodes: readyNodes((await readTask(parameters))[1]) }, 0]; case 'claim': return [await claimNode(parameters), 0];
    case 'complete': return [await completeNode(parameters), 0]; case 'heartbeat': return [await heartbeatNode(parameters), 0]; case 'checkpoint': return [await checkpointNode(parameters), 0];
    case 'abandon': return [await abandonNode(parameters), 0]; case 'retry': return [await retryNode(parameters), 0]; case 'requeue-stale': return [await requeueStaleNode(parameters), 0];
    case 'recover-lock': return [await recoverTaskLock(parameters), 0]; case 'audit-context': return [await auditContext(parameters), 0];
    case 'record-review': return [await recordReview(parameters), 0]; case 'close-check': return closeCheck(parameters);
    case 'release-workspace': return [await releaseWorkspaceLease(parameters), 0];
    case 'stale': {
      const [, state] = await readTask(parameters);
      return [{ task_id: state.task_id, stale_nodes: staleNodes(state) }, 0];
    }
    case 'status': return [compactState((await readTask(parameters))[1]), 0]; case 'fingerprint': return [{ workspace_fingerprint: await workspaceFingerprint(parameters.workspace) }, 0];
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
