import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
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
const IGNORED_DIRECTORIES = new Set(['.git', '.codex', 'node_modules', '.venv', 'dist', 'build']);

export class ControllerError extends Error {}

const utcNow = () => new Date().toISOString();
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const DEFAULT_STALE_LOCK_SEC = 30;
const DEFAULT_LEASE_SEC = 1800;

function requiredString(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new ControllerError(`${name} must be a non-empty string`);
  return value.trim();
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

function requiredReviewValue(value, name) {
  if (value === undefined || value === null) throw new ControllerError(`${name} is required`);
  if (typeof value === 'string' && !value.trim()) throw new ControllerError(`${name} must not be empty`);
  if (Array.isArray(value) && !value.length) throw new ControllerError(`${name} must not be empty`);
  if (typeof value === 'object' && !Array.isArray(value) && !Object.keys(value).length) throw new ControllerError(`${name} must not be empty`);
  return value;
}

async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') throw new ControllerError(`JSON input does not exist: ${filePath}`);
    if (error instanceof SyntaxError) throw new ControllerError(`Invalid JSON in ${filePath}: ${error.message}`);
    throw error;
  }
}

async function atomicWrite(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.rename(temporary, filePath);
}

function statePath(stateDir, taskId) {
  if (!taskId || /[\\/:*?"<>|]/.test(taskId)) throw new ControllerError('task_id must be a non-empty filesystem-safe identifier');
  return path.join(path.resolve(stateDir), `${taskId}.json`);
}

async function sleep(milliseconds) { await new Promise(resolve => setTimeout(resolve, milliseconds)); }

async function lockDetails(lockPath) {
  const [text, metadata] = await Promise.all([fs.readFile(lockPath, 'utf8'), fs.stat(lockPath)]);
  const values = Object.fromEntries(text.trim().split(/\s+/).map(part => part.split('=', 2)).filter(([key, value]) => key && value));
  return { lockPath, pid: Number(values.pid), hostname: values.hostname, created: values.created, ageMs: Date.now() - metadata.mtimeMs };
}

async function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

async function recoveryGuardExists(lockPath) {
  try { await fs.access(`${lockPath}.recover`); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
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
    if (Date.now() >= deadline) throw new ControllerError(`Task recovery is still in progress: ${lockPath}`);
    await sleep(25);
  }
}

async function waitForCoordinationIntents(lockPath, deadline) {
  while (await coordinationIntentExists(lockPath)) {
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

async function recoverStaleLock(filePath, staleAfterSec) {
  const lockPath = `${filePath}.lock`;
  const recoveryGuardPath = `${lockPath}.recover`;
  let recoveryGuard;
  try {
    recoveryGuard = await fs.open(recoveryGuardPath, 'wx');
    await recoveryGuard.writeFile(`pid=${process.pid} hostname=${os.hostname()} created=${utcNow()}\n`);
  } catch (error) {
    if (error.code === 'EEXIST') throw new ControllerError(`Stale-lock recovery is already in progress: ${lockPath}`);
    throw error;
  }
  try {
    await waitForCoordinationIntents(lockPath, Date.now() + 10_000);
    let details;
    try { details = await lockDetails(lockPath); } catch (error) { if (error.code === 'ENOENT') return { recovered: false, reason: 'no lock exists' }; throw error; }
    const staleAfterMs = positiveInteger(staleAfterSec, 'stale_after_sec', DEFAULT_STALE_LOCK_SEC) * 1000;
    if (details.hostname !== os.hostname()) throw new ControllerError(`Cannot prove a lock from another host is stale: ${lockPath}`);
    if (details.ageMs < staleAfterMs) throw new ControllerError(`Lock is younger than stale_after_sec: ${lockPath}`);
    if (await processIsAlive(details.pid)) throw new ControllerError(`Lock owner is still alive: ${lockPath}`);
    const recoveredPath = `${lockPath}.stale-${utcNow().replace(/[:.]/g, '-')}-${randomUUID()}`;
    // The exclusive recovery guard prevents another recovery from replacing the lock between proof and rename.
    await fs.rename(lockPath, recoveredPath);
    return { recovered: true, recovered_lock_path: recoveredPath, prior_lock: details };
  } finally {
    await recoveryGuard.close();
    await fs.unlink(recoveryGuardPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
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
    if (await recoveryGuardExists(lockPath)) throw new ControllerError(`Task recovery is in progress: ${filePath}`);
    while (!handle) {
      try {
      handle = await fs.open(lockPath, 'wx');
      await handle.writeFile(`pid=${process.pid} hostname=${os.hostname()} created=${utcNow()}\n`);
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if (await recoveryGuardExists(lockPath)) throw new ControllerError(`Task recovery is in progress: ${filePath}`);
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
  const state = await readJson(filePath);
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
    if (entry.isDirectory()) {
      if (!IGNORED_DIRECTORIES.has(entry.name)) await walkFiles(root, path.join(directory, entry.name), files);
    } else if (entry.isFile()) {
      files.push(path.relative(root, path.join(directory, entry.name)));
    }
  }
  return files;
}

export async function workspaceFingerprint(workspaceValue) {
  const workspace = path.resolve(workspaceValue);
  let metadata;
  try { metadata = await fs.stat(workspace); } catch { throw new ControllerError(`Workspace is not a directory: ${workspace}`); }
  if (!metadata.isDirectory()) throw new ControllerError(`Workspace is not a directory: ${workspace}`);
  const digest = createHash('sha256');
  const files = (await walkFiles(workspace)).sort((left, right) => left.localeCompare(right));
  for (const relative of files) {
    digest.update(relative.split(path.sep).join('/'));
    digest.update('\0');
    digest.update(await fs.readFile(path.join(workspace, relative)));
  }
  return { algorithm: 'sha256', value: digest.digest('hex'), file_count: files.length };
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
}

function nodeRecord(raw) {
  if (!raw || typeof raw !== 'object') throw new ControllerError('Each node must be an object');
  const id = requiredString(raw.id, 'node.id'); const kind = requiredString(raw.kind, 'node.kind');
  if (raw.agent_type !== undefined && raw.agent_type !== null) requiredString(raw.agent_type, 'node.agent_type');
  const dependencies = raw.depends_on ?? [];
  if (!Array.isArray(dependencies) || dependencies.some(dependency => typeof dependency !== 'string' || !dependency.trim())) throw new ControllerError('node.depends_on must contain non-empty string identifiers');
  return { id, kind, agent_type: raw.agent_type ?? null, depends_on: dependencies, status: PENDING, agent_task_path: null, agent_role: null, claim_id: null, claimed_at: null, heartbeat_at: null, lease_duration_sec: null, attempt: 0, result: null };
}

function normalizeState(state) {
  for (const node of Object.values(state.nodes ?? {})) {
    node.agent_role ??= null; node.claim_id ??= null; node.claimed_at ??= null; node.heartbeat_at ??= null;
    node.lease_duration_sec ??= null; node.attempt ??= node.agent_task_path ? 1 : 0;
  }
  return state;
}

async function makeState(manifest) {
  const required = ['task_id', 'workspace', 'goal', 'requirements'];
  if (!manifest || typeof manifest !== 'object' || required.some(key => !hasOwn(manifest, key))) throw new ControllerError('Manifest requires task_id, workspace, goal, and requirements');
  const taskId = requiredString(manifest.task_id, 'task_id');
  const workspace = path.resolve(requiredString(manifest.workspace, 'workspace'));
  const goal = requiredString(manifest.goal, 'goal');
  await workspaceFingerprint(workspace);
  if (!Array.isArray(manifest.requirements) || !manifest.requirements.length) throw new ControllerError('Manifest requires a non-empty requirements list');
  const requirements = manifest.requirements.map(item => {
    if (!item || typeof item !== 'object') throw new ControllerError('Each requirement must be an object');
    return { ...item, id: requiredString(item.id, 'requirement.id'), text: requiredString(item.text, 'requirement.text') };
  });
  const ids = requirements.map(item => item.id);
  if (new Set(ids).size !== ids.length) throw new ControllerError('Each requirement needs a unique id and non-empty text');
  const nodes = {};
  for (const rawNode of manifest.nodes ?? []) {
    const node = nodeRecord(rawNode);
    if (hasOwn(nodes, node.id)) throw new ControllerError(`Duplicate node id: ${node.id}`);
    nodes[node.id] = node;
  }
  validateNodes(nodes);
  const created = utcNow();
  return { version: VERSION, task_id: taskId, workspace, goal, requirements, scope: manifest.scope ?? [], non_goals: manifest.non_goals ?? [], nodes, participants: [], reviews: [], events: [{ at: created, type: 'task_initialized' }], created_at: created, updated_at: created };
}

function readyNodes(state) {
  return Object.values(state.nodes).filter(node => node.status === PENDING && node.depends_on.every(dependency => state.nodes[dependency].status === SUCCEEDED));
}

function participantPaths(state) { return new Set(state.participants.map(item => item.agent_task_path)); }
async function readTask(parameters) { const filePath = statePath(parameters.state_dir ?? '.codex/workflow-controller', requiredString(parameters.task_id, 'task_id')); return [filePath, normalizeState(await loadState(filePath))]; }

function compactState(state) {
  return { task_id: state.task_id, workspace: state.workspace, goal: state.goal, nodes: Object.values(state.nodes), ready_nodes: readyNodes(state), participants: state.participants, reviews: state.reviews, updated_at: state.updated_at };
}

async function initTask(parameters) {
  const manifest = await readJson(parameters.manifest);
  const state = await makeState(manifest);
  const filePath = statePath(parameters.state_dir ?? '.codex/workflow-controller', state.task_id);
  await withStateLock(filePath, async () => {
    try { await fs.access(filePath); throw new ControllerError(`Task already exists: ${state.task_id}`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await atomicWrite(filePath, state);
  });
  return { state_path: filePath, task: compactState(state) };
}

async function addNode(parameters) {
  const raw = await readJson(parameters.node);
  const [filePath] = await readTask(parameters);
  return withStateLock(filePath, async () => {
    const state = await loadState(filePath); const node = nodeRecord(raw);
    if (hasOwn(state.nodes, node.id)) throw new ControllerError(`Node already exists: ${node.id}`);
    state.nodes[node.id] = node; validateNodes(state.nodes); addEvent(state, 'node_added', { node_id: node.id }); await atomicWrite(filePath, state);
    return { task_id: state.task_id, node };
  });
}

async function claimNode(parameters) {
  const [filePath] = await readTask(parameters); const nodeId = requiredString(parameters.node_id, 'node_id'); const taskPath = requiredString(parameters.agent_task_path, 'agent_task_path'); const role = requiredString(parameters.agent_role, 'agent_role'); const leaseDurationSec = positiveInteger(parameters.lease_duration_sec, 'lease_duration_sec', DEFAULT_LEASE_SEC);
  return withStateLock(filePath, async () => {
    const state = normalizeState(await loadState(filePath)); const node = state.nodes[nodeId];
    if (!node || !readyNodes(state).some(candidate => candidate.id === nodeId)) throw new ControllerError(`Node is not ready: ${nodeId}`);
    if (participantPaths(state).has(taskPath)) throw new ControllerError('Agent already participates in this task');
    const now = utcNow(); node.status = RUNNING; node.agent_task_path = taskPath; node.agent_role = role; node.claim_id = randomUUID(); node.claimed_at = now; node.heartbeat_at = now; node.lease_duration_sec = leaseDurationSec; node.attempt += 1;
    state.participants.push({ agent_task_path: taskPath, agent_role: role, node_id: nodeId, claim_id: node.claim_id, attempt: node.attempt });
    addEvent(state, 'node_claimed', { node_id: nodeId, agent_task_path: taskPath, agent_role: role, claim_id: node.claim_id, attempt: node.attempt }); await atomicWrite(filePath, state);
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
  const result = await readJson(parameters.result); const [filePath] = await readTask(parameters); const nodeId = requiredString(parameters.node_id, 'node_id');
  return withStateLock(filePath, async () => {
    const state = normalizeState(await loadState(filePath)); const node = state.nodes[nodeId]; requireActiveClaim(node, parameters);
    if (node.kind === 'total_review' && status === SUCCEEDED && !hasRecordedReview(state, node)) throw new ControllerError('A successful total_review requires a recorded review for its active claim');
    node.status = status; node.result = result; addEvent(state, 'node_completed', { node_id: nodeId, status }); await atomicWrite(filePath, state);
    return { task_id: state.task_id, node, ready_nodes: readyNodes(state) };
  });
}

async function heartbeatNode(parameters) {
  const [filePath] = await readTask(parameters); const nodeId = requiredString(parameters.node_id, 'node_id');
  return withStateLock(filePath, async () => {
    const state = normalizeState(await loadState(filePath)); const node = state.nodes[nodeId]; requireActiveClaim(node, parameters);
    node.heartbeat_at = utcNow(); addEvent(state, 'node_heartbeat', { node_id: nodeId, claim_id: node.claim_id }); await atomicWrite(filePath, state);
    return { task_id: state.task_id, node };
  });
}

async function abandonNode(parameters) {
  const [filePath] = await readTask(parameters); const nodeId = requiredString(parameters.node_id, 'node_id'); const reason = requiredString(parameters.reason, 'reason');
  return withStateLock(filePath, async () => {
    const state = normalizeState(await loadState(filePath)); const node = state.nodes[nodeId]; requireActiveClaim(node, parameters);
    node.status = 'abandoned'; node.result = { summary: 'Node abandoned after explicit reconciliation.', reason, abandoned_at: utcNow(), claim_id: node.claim_id };
    addEvent(state, 'node_abandoned', { node_id: nodeId, claim_id: node.claim_id, reason }); await atomicWrite(filePath, state);
    return { task_id: state.task_id, node };
  });
}

async function retryNode(parameters) {
  const [filePath] = await readTask(parameters); const nodeId = requiredString(parameters.node_id, 'node_id'); const reason = requiredString(parameters.reason, 'reason'); trueValue(parameters.previous_agent_stopped, 'previous_agent_stopped');
  return withStateLock(filePath, async () => {
    const state = normalizeState(await loadState(filePath)); const node = state.nodes[nodeId];
    const orphanedTotalReview = node?.kind === 'total_review' && node.status === SUCCEEDED && !hasRecordedReview(state, node);
    if (!node || (!['failed', 'blocked', 'unavailable', 'abandoned'].includes(node.status) && !orphanedTotalReview)) throw new ControllerError(`Only failed, blocked, unavailable, abandoned, or an unrecorded successful total_review can be retried: ${nodeId}`);
    const downstreamStarted = Object.values(state.nodes).some(candidate => candidate.depends_on.includes(nodeId) && candidate.status !== PENDING);
    if (downstreamStarted) throw new ControllerError(`Cannot retry after a dependent node changed state: ${nodeId}`);
    const priorClaimId = node.claim_id; node.status = PENDING; node.agent_task_path = null; node.agent_role = null; node.claim_id = null; node.claimed_at = null; node.heartbeat_at = null; node.lease_duration_sec = null; node.result = null;
    addEvent(state, 'node_retried', { node_id: nodeId, prior_claim_id: priorClaimId, reason, previous_agent_stopped: true, orphaned_total_review: orphanedTotalReview }); await atomicWrite(filePath, state);
    return { task_id: state.task_id, node, ready_nodes: readyNodes(state) };
  });
}

async function recoverTaskLock(parameters) {
  const filePath = statePath(parameters.state_dir ?? '.codex/workflow-controller', requiredString(parameters.task_id, 'task_id'));
  return recoverStaleLock(filePath, parameters.stale_after_sec);
}

async function auditContext(parameters) {
  const [, state] = await readTask(parameters);
  return { task_id: state.task_id, goal: state.goal, requirements: state.requirements, scope: state.scope, non_goals: state.non_goals, nodes: Object.values(state.nodes), participants: state.participants, reviews: state.reviews, workspace_fingerprint: await workspaceFingerprint(state.workspace) };
}

async function recordReview(parameters) {
  const review = await readJson(parameters.review); if (!review || typeof review !== 'object') throw new ControllerError('Review must be a JSON object');
  const [filePath] = await readTask(parameters);
  return withStateLock(filePath, async () => {
    const state = await loadState(filePath); const auditor = String(review.auditor_task ?? ''); const role = String(review.auditor_role ?? ''); const verdict = String(review.verdict ?? '');
    const priorReviewers = new Set(state.reviews.map(item => item.auditor_task));
    const participatedOutsideTotalReview = state.participants.some(item => item.agent_task_path === auditor && state.nodes[item.node_id]?.kind !== 'total_review');
    if (!auditor || participatedOutsideTotalReview || priorReviewers.has(auditor)) throw new ControllerError('Total reviewer must be a new agent that did not previously participate');
    if (!SOL_ROLES.has(role) && role !== FALLBACK_ROLE) throw new ControllerError('Unsupported total reviewer role');
    const totalReviewNode = Object.values(state.nodes).find(node => node.kind === 'total_review' && node.status === RUNNING && node.agent_task_path === auditor);
    if (!totalReviewNode) throw new ControllerError('Total reviewer must own a running total_review node');
    if (totalReviewNode.agent_role !== role) throw new ControllerError('Total reviewer role must match its claimed total_review node');
    requireActiveClaim(totalReviewNode, { node_id: totalReviewNode.id, claim_id: review.claim_id });
    if (role === FALLBACK_ROLE && !review.fallback_reason) throw new ControllerError('Terra fallback review requires fallback_reason');
    if (!['pass', 'fail', 'unavailable'].includes(verdict)) throw new ControllerError('Review verdict must be pass, fail, or unavailable');
    const expectedIds = new Set(state.requirements.map(item => item.id)); const coverage = review.requirement_coverage;
    if (!coverage || typeof coverage !== 'object' || Object.keys(coverage).length !== expectedIds.size || [...expectedIds].some(id => !coverage[id])) throw new ControllerError('Review must provide non-empty coverage for every requirement');
    const fingerprint = await workspaceFingerprint(state.workspace);
    if (JSON.stringify(review.workspace_fingerprint) !== JSON.stringify(fingerprint)) throw new ControllerError('Review fingerprint does not match the current workspace');
    const scopeAndRegression = requiredReviewValue(review.scope_and_regression, 'scope_and_regression');
    const verificationGaps = requiredReviewValue(review.verification_gaps, 'verification_gaps');
    const residualRisk = requiredReviewValue(review.residual_risk, 'residual_risk');
    const stored = { auditor_task: auditor, auditor_role: role, claim_id: totalReviewNode.claim_id, verdict, requirement_coverage: coverage, scope_and_regression: scopeAndRegression, verification_gaps: verificationGaps, residual_risk: residualRisk, fallback_reason: review.fallback_reason ?? null, workspace_fingerprint: fingerprint, recorded_at: utcNow() };
    state.reviews.push(stored); addEvent(state, 'total_review_recorded', { auditor_task: auditor, verdict }); await atomicWrite(filePath, state);
    return { task_id: state.task_id, review: stored };
  });
}

async function closeCheck(parameters) {
  const [, state] = await readTask(parameters); const incomplete = Object.entries(state.nodes).filter(([, node]) => ![SUCCEEDED, 'skipped'].includes(node.status)).map(([id]) => id);
  const reasons = incomplete.length ? [`incomplete nodes: ${incomplete.join(', ')}`] : [];
  const review = state.reviews.at(-1);
  if (!review) reasons.push('no total review'); else { if (review.verdict !== 'pass') reasons.push(`latest review verdict is ${review.verdict}`); if (JSON.stringify(review.workspace_fingerprint) !== JSON.stringify(await workspaceFingerprint(state.workspace))) reasons.push('workspace changed after total review'); }
  return [{ task_id: state.task_id, close_allowed: !reasons.length, reasons }, reasons.length ? 2 : 0];
}

export async function dispatch(command, parameters) {
  switch (command) {
    case 'init': return [await initTask(parameters), 0]; case 'add-node': return [await addNode(parameters), 0];
    case 'ready': return [{ ready_nodes: readyNodes((await readTask(parameters))[1]) }, 0]; case 'claim': return [await claimNode(parameters), 0];
    case 'complete': return [await completeNode(parameters), 0]; case 'heartbeat': return [await heartbeatNode(parameters), 0];
    case 'abandon': return [await abandonNode(parameters), 0]; case 'retry': return [await retryNode(parameters), 0];
    case 'recover-lock': return [await recoverTaskLock(parameters), 0]; case 'audit-context': return [await auditContext(parameters), 0];
    case 'record-review': return [await recordReview(parameters), 0]; case 'close-check': return closeCheck(parameters);
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
