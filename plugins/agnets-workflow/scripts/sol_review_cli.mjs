import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { canonicalStateDirectory, dispatch, sameJson } from './workflow_controller.mjs';
import { globalWorkflowArtifactPathForHome, globalWorkflowArtifactRootForHome, globalWorkflowArtifactRoot } from './global_workflow_store.mjs';

const STATE_FILE = 'deny_read_acl_state.json';
const REPAIR_LOCK_WAIT_MS = 5_000;
const REPAIR_LOCK_RETRY_MS = 25;
export const DEFAULT_SOL_REVIEW_TIMEOUT_SEC = 30 * 60;
export const MAX_SOL_REVIEW_TIMEOUT_SEC = 2 * 60 * 60;
export const BOUNDED_EXTERNAL_REVIEW_PROFILE = 'bounded-external';
const EVIDENCE_MANIFEST = 'evidence-manifest.json';
const BOUNDED_EXTERNAL_REVIEW_INSTRUCTIONS = [
  'Review profile: bounded-external.',
  'Use the caller-provided fixed evidence package as the primary source.',
  `The package boundary is defined by ${EVIDENCE_MANIFEST}; inspect only files listed in its allowed_files array.`,
  'Inspect only the listed changed files and necessary adjacent call chains.',
  'Do not enumerate the entire workspace to search for scope drift.',
  'Do not inspect .git, .codex, node_modules, .venv, .yarn, or .yarn-cache*.',
  'If evidence is insufficient, stop and emit the required final JSON with verdict "unavailable" or "fail"; do not guess.',
].join('\n');
const DIRECT_SOL_REVIEW_INSTRUCTIONS = [
  'You are already the independent leaf Sol reviewer selected by the caller.',
  'Directly perform this read-only review yourself.',
  'Do not create, request, wait for, delegate to, or cite any agent or collaboration tool.',
  'Do not return a progress acknowledgement; inspect the supplied task and produce the final review JSON in this invocation.',
].join(' ');
const TERMINATION_GRACE_MS = 15_000;
const TERMINATION_REQUEST_TIMEOUT_MS = 1_000;
const CLEANUP_TIMEOUT_MS = 5_000;
const MAX_CAPTURE_BYTES = 256 * 1024;
const REVIEW_VERDICTS = new Set(['pass', 'fail', 'unavailable']);
const SOL_REVIEW_ROLE_EFFORTS = new Map([
  ['avsp_sol_high', 'high'],
  ['avsp_sol_xhigh', 'xhigh'],
  ['avsp_sol_max', 'max'],
]);
const DEFAULT_SOL_REVIEW_ROLE = 'avsp_sol_high';
const REVIEW_REQUIRED_FIELDS = ['auditor_task', 'auditor_role', 'claim_id', 'verdict', 'requirement_coverage', 'workflow_snapshot', 'workspace_fingerprint', 'scope_and_regression', 'verification_gaps', 'residual_risk'];
const REVIEW_FINDING_FIELDS = ['id', 'severity', 'requirement_id', 'summary', 'evidence'];
const REVIEW_FINDING_SEVERITIES = new Set(['blocking', 'advisory']);
const MAX_REVIEW_FINDINGS = 64;
const NATIVE_AGENT_EXIT_CONFIRMED = 'native_agent_exit_confirmed';
const NATIVE_AGENT_START_FAILED = 'native_agent_start_failed';
const MAX_EVIDENCE_FILES = 512;
const MAX_EVIDENCE_FILE_BYTES = 64 * 1024 * 1024;
const MAX_EVIDENCE_TOTAL_BYTES = 128 * 1024 * 1024;
const MAX_EVIDENCE_PATH_DEPTH = 32;
const MAX_EVIDENCE_DIRECTORIES = 512;

export function resolveCodexHome(environment = process.env, platform = process.platform) {
  const configured = environment.CODEX_HOME?.trim();
  if (configured) {
    if (!path.isAbsolute(configured)) throw new Error('CODEX_HOME must be an absolute path');
    return path.resolve(configured);
  }
  const home = platform === 'win32' ? environment.USERPROFILE : environment.HOME;
  if (!home?.trim()) throw new Error('CODEX_HOME is required when the current account home cannot be resolved');
  return path.join(path.resolve(home), '.codex');
}

async function readAclState(statePath) {
  try {
    const contents = await fs.readFile(statePath, 'utf8');
    try { return { kind: 'valid', value: JSON.parse(contents) }; }
    catch (error) { if (error instanceof SyntaxError) return { kind: 'invalid', error }; throw error; }
  } catch (error) {
    if (error.code === 'ENOENT') return { kind: 'missing' };
    throw error;
  }
}

async function writeJsonAtomically(filePath, value, parentAuthority) {
  if (!parentAuthority || !sameFilesystemPath(parentAuthority.path, path.dirname(filePath))) throw new Error(`Artifact write requires a caller-verified parent authority: ${filePath}`);
  const parent = parentAuthority;
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  let temporaryIdentity = null;
  try {
    const handle = await fs.open(temporary, 'wx');
    try {
      temporaryIdentity = filesystemIdentity(await handle.stat({ bigint: true }));
      await verifyRegularDirectory(parent);
      await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8');
      await handle.sync();
    } finally { await handle.close(); }
    await verifyRegularDirectory(parent);
    await verifyOwnedFile(temporary, temporaryIdentity, 'artifact temporary');
    await fs.rename(temporary, filePath);
    await verifyRegularDirectory(parent);
    await verifyOwnedFile(filePath, temporaryIdentity, 'artifact');
  } catch (error) {
    await unlinkOwnedFile(temporary, temporaryIdentity);
    throw error;
  }
}

function filesystemIdentity(metadata) { return { dev: metadata.dev.toString(), ino: metadata.ino.toString() }; }
async function snapshotRegularDirectory(directory) {
  const metadata = await fs.lstat(directory, { bigint: true });
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error(`Artifact parent is not a regular directory: ${directory}`);
  return { path: directory, realPath: await fs.realpath(directory), identity: filesystemIdentity(metadata) };
}
async function verifyRegularDirectory(snapshot) {
  const current = await snapshotRegularDirectory(snapshot.path);
  const expectedRealPath = snapshot.realPath ?? snapshot.real_path;
  if (!sameFilesystemPath(current.realPath, expectedRealPath) || current.identity.dev !== snapshot.identity.dev || current.identity.ino !== snapshot.identity.ino) {
    throw new Error(`Artifact parent directory changed: ${snapshot.path}`);
  }
}
async function unlinkOwnedFile(filePath, identity) {
  if (!identity) return false;
  try {
    const metadata = await fs.lstat(filePath, { bigint: true });
    const current = filesystemIdentity(metadata);
    if (metadata.isSymbolicLink() || !metadata.isFile() || current.dev !== identity.dev || current.ino !== identity.ino) return false;
    await fs.unlink(filePath); return true;
  } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
async function verifyOwnedFile(filePath, identity, label) {
  const metadata = await fs.lstat(filePath, { bigint: true });
  const current = filesystemIdentity(metadata);
  if (metadata.isSymbolicLink() || !metadata.isFile() || current.dev !== identity?.dev || current.ino !== identity?.ino) {
    throw new Error(`${label} changed: ${filePath}`);
  }
}

async function openHandleOwnsPath(handle, filePath) {
  try {
    const [handleMetadata, pathMetadata] = await Promise.all([handle.stat({ bigint: true }), fs.lstat(filePath, { bigint: true })]);
    const handleIdentity = filesystemIdentity(handleMetadata); const pathIdentity = filesystemIdentity(pathMetadata);
    return !pathMetadata.isSymbolicLink() && pathMetadata.isFile() && handleIdentity.dev === pathIdentity.dev && handleIdentity.ino === pathIdentity.ino;
  } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function closeAndUnlinkOwnedPath(handle, filePath) {
  const identity = filesystemIdentity(await handle.stat({ bigint: true }));
  const ownsPath = await openHandleOwnsPath(handle, filePath);
  await handle.close();
  if (!ownsPath) return false;
  return unlinkOwnedFile(filePath, identity);
}

async function acquireRepairLock(lockPath, statePath, parentAuthority) {
  const deadline = Date.now() + REPAIR_LOCK_WAIT_MS;
  while (true) {
    try {
      const handle = await fs.open(lockPath, 'wx');
      try {
        await verifyRegularDirectory(parentAuthority);
        await handle.writeFile(`pid=${process.pid} hostname=${os.hostname()} created=${new Date().toISOString()}\n`);
        return handle;
      } catch (cause) {
        await closeAndUnlinkOwnedPath(handle, lockPath);
        throw cause;
      }
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const current = await readAclState(statePath);
      if (current.kind === 'valid') return null;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        // A repair may have committed just after the preceding state read.
        const finalState = await readAclState(statePath);
        if (finalState.kind === 'valid') return null;
        throw new Error(`deny-read ACL repair is already in progress: ${lockPath}`);
      }
      await new Promise(resolve => setTimeout(resolve, Math.min(REPAIR_LOCK_RETRY_MS, remaining)));
    }
  }
}

export async function repairInvalidDenyReadAclState(codexHome, platform = process.platform) {
  if (platform !== 'win32') return { repaired: false, reason: 'not_windows' };
  const sandboxDirectory = path.join(codexHome, '.sandbox');
  const statePath = path.join(sandboxDirectory, STATE_FILE);
  const initial = await readAclState(statePath);
  if (initial.kind !== 'invalid') return { repaired: false, reason: initial.kind, state_path: statePath };

  const parentAuthority = await snapshotRegularDirectory(sandboxDirectory);
  const lockPath = `${statePath}.repair`;
  const lock = await acquireRepairLock(lockPath, statePath, parentAuthority);
  if (!lock) return { repaired: false, reason: 'repaired_by_another_process', state_path: statePath };
  try {
    await verifyRegularDirectory(parentAuthority);
    const current = await readAclState(statePath);
    if (current.kind !== 'invalid') return { repaired: false, reason: current.kind, state_path: statePath };
    const backupPath = `${statePath}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`;
    await verifyRegularDirectory(parentAuthority);
    await fs.rename(statePath, backupPath);
    await writeJsonAtomically(statePath, { principals: {} }, parentAuthority);
    return { repaired: true, state_path: statePath, backup_path: backupPath };
  } finally {
    await closeAndUnlinkOwnedPath(lock, lockPath);
  }
}

function positiveInteger(value, option, fallback) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > MAX_SOL_REVIEW_TIMEOUT_SEC) throw new Error(`${option} must be an integer between 1 and ${MAX_SOL_REVIEW_TIMEOUT_SEC}`);
  return parsed;
}

function requiredOption(args, index, option) {
  const value = args[index + 1];
  if (!value || value === '--') throw new Error(`${option} requires a value`);
  return value;
}

function safeWorkflowIdentifier(value, option) {
  if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9._-]{0,127}$/.test(value)) throw new Error(`${option} must be a safe workflow identifier`);
  return value;
}

function safeWorkflowToken(value, option) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) throw new Error(`${option} must be a safe workflow token`);
  return value;
}

function solReviewRole(value, option) {
  if (!SOL_REVIEW_ROLE_EFFORTS.has(value)) throw new Error(`${option} must be avsp_sol_high, avsp_sol_xhigh, or avsp_sol_max`);
  return value;
}

function parseInvocation(argv, environment = process.env, platform = process.platform) {
  const args = [...argv];
  // Windows PATH resolution can prefer the Desktop package's inaccessible codex.exe.
  let codexBin = environment.CODEX_BIN || (platform === 'win32' ? 'codex.cmd' : 'codex');
  let timeoutSec = DEFAULT_SOL_REVIEW_TIMEOUT_SEC;
  let hardTimeoutSec = null;
  let reviewProfile = null;
  let evidenceDirectory = null;
  let resultPath = null;
  let reviewRole = null;
  const workflow = { state_dir: null, task_id: null, node_id: null, claim_id: null };
  let index = 0;
  while (index < args.length && args[index] !== '--' && args[index].startsWith('--')) {
    const option = args[index];
    if (option === '--codex-bin') { codexBin = requiredOption(args, index, option); index += 2; continue; }
    if (option === '--timeout-sec') { timeoutSec = positiveInteger(requiredOption(args, index, option), option); index += 2; continue; }
    if (option === '--hard-timeout-sec') { hardTimeoutSec = positiveInteger(requiredOption(args, index, option), option); index += 2; continue; }
    if (option === '--review-profile') {
      const value = requiredOption(args, index, option);
      if (value !== BOUNDED_EXTERNAL_REVIEW_PROFILE) throw new Error(`Unknown review profile: ${value}`);
      reviewProfile = value;
      index += 2;
      continue;
    }
    if (option === '--evidence-dir') {
      const value = requiredOption(args, index, option);
      if (!path.isAbsolute(value)) throw new Error('--evidence-dir must be an absolute path');
      evidenceDirectory = path.resolve(value);
      index += 2;
      continue;
    }
    if (option === '--result') { resultPath = path.resolve(requiredOption(args, index, option)); index += 2; continue; }
    if (option === '--review-role') { reviewRole = solReviewRole(requiredOption(args, index, option), option); index += 2; continue; }
    if (option === '--workflow-state-dir') {
      const value = requiredOption(args, index, option);
      if (!path.isAbsolute(value)) throw new Error('--workflow-state-dir must be an absolute path');
      workflow.state_dir = path.resolve(value);
      index += 2;
      continue;
    }
    if (option === '--workflow-task-id') { workflow.task_id = safeWorkflowIdentifier(requiredOption(args, index, option), option); index += 2; continue; }
    if (option === '--workflow-node-id') { workflow.node_id = safeWorkflowIdentifier(requiredOption(args, index, option), option); index += 2; continue; }
    if (option === '--workflow-claim-id') { workflow.claim_id = safeWorkflowToken(requiredOption(args, index, option), option); index += 2; continue; }
    throw new Error(`Unknown option: ${option}`);
  }
  if (args[index] === '--') index++;
  if (reviewProfile === BOUNDED_EXTERNAL_REVIEW_PROFILE && evidenceDirectory === null) throw new Error('--review-profile bounded-external requires --evidence-dir');
  if (reviewProfile !== BOUNDED_EXTERNAL_REVIEW_PROFILE && evidenceDirectory !== null) throw new Error('--evidence-dir is only supported with --review-profile bounded-external');
  const workflowValues = Object.values(workflow);
  const workflowConfigured = workflowValues.some(value => value !== null);
  if (workflowConfigured && workflowValues.some(value => value === null)) throw new Error('workflow result recording requires --workflow-state-dir, --workflow-task-id, --workflow-node-id, and --workflow-claim-id');
  return { codexBin, timeoutSec, hardTimeoutSec, reviewProfile, evidenceDirectory, resultPath, reviewRole: reviewRole ?? DEFAULT_SOL_REVIEW_ROLE, reviewRoleExplicit: reviewRole !== null, workflow: workflowConfigured ? workflow : null, promptArgs: args.slice(index) };
}

function reviewOutputContract(workflow, reviewRole) {
  const claim = workflow
    ? `Set claim_id to exactly "${workflow.claim_id}".`
    : 'Set claim_id to a non-empty value; use "unavailable-not-provided" for an independent review without a workflow claim.';
  const role = `Set auditor_role to exactly "${reviewRole}".`;
  return [
    'Final response contract: return exactly one final JSON object, with no Markdown or prose after it.',
    `auditor_task, auditor_role, and claim_id must be non-empty strings. requirement_coverage, workflow_snapshot, and workspace_fingerprint must be non-empty objects. scope_and_regression, verification_gaps, and residual_risk must be non-empty strings, arrays, or objects. verdict must be pass, fail, or unavailable. When verdict is fail, findings must be a non-empty array containing at least one blocking finding. Every finding must contain exactly id, severity, requirement_id, summary, and evidence; id must be unique, start with a letter, contain only letters, digits, dot, underscore, or hyphen, and be at most 80 characters, severity must be blocking or advisory, requirement_id must be a covered requirement id or null, and summary and evidence must be non-empty. A pass may contain advisory findings but cannot contain blocking findings. An unavailable result cannot contain findings. ${claim} ${role}`,
  ].join(' ');
}

function reviewPrompt(promptArgs, reviewProfile, workflow, reviewRole) {
  const callerPrompt = promptArgs.join(' ');
  const instructions = [DIRECT_SOL_REVIEW_INSTRUCTIONS, reviewOutputContract(workflow, reviewRole)];
  if (reviewProfile !== null) instructions.push(BOUNDED_EXTERNAL_REVIEW_INSTRUCTIONS);
  if (callerPrompt) instructions.push(callerPrompt);
  // Windows cmd bridges do not preserve embedded newlines in an argument reliably.
  return instructions.join(' ').replace(/\s+/g, ' ').trim();
}

async function resolveEvidenceDirectory(reviewProfile, evidenceDirectory, platform = process.platform) {
  if (reviewProfile !== BOUNDED_EXTERNAL_REVIEW_PROFILE) return null;
  const absoluteDirectory = path.resolve(evidenceDirectory);
  const sameManifestName = value => platform === 'win32' ? value.toLowerCase() === EVIDENCE_MANIFEST.toLowerCase() : value === EVIDENCE_MANIFEST;
  const isWithin = (root, target) => {
    const relative = path.relative(root, target);
    return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
  };
  const samePath = (left, right) => platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
  const decimalMetadata = (value, label) => {
    if (typeof value !== 'bigint') throw new Error(`${label} filesystem metadata must use bigint values`);
    return value.toString();
  };
  const identityOf = details => ({
    dev: decimalMetadata(details?.dev, 'Evidence'),
    ino: decimalMetadata(details?.ino, 'Evidence'),
    size: decimalMetadata(details?.size, 'Evidence'),
    mtimeMs: decimalMetadata(details?.mtimeMs, 'Evidence'),
    ctimeMs: decimalMetadata(details?.ctimeMs, 'Evidence'),
  });
  const boundedSize = (details, label) => {
    const size = decimalMetadata(details?.size, label);
    const value = BigInt(size);
    if (value > BigInt(MAX_EVIDENCE_FILE_BYTES)) throw new Error(`${label} exceeds the ${MAX_EVIDENCE_FILE_BYTES}-byte limit`);
    const number = Number(value);
    if (!Number.isSafeInteger(number)) throw new Error(`${label} size is outside the supported safe range`);
    return number;
  };
  const sameIdentity = (left, right) => left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
  const digestFile = async filePath => createHash('sha256').update(await fs.readFile(filePath)).digest('hex');
  try {
    const details = await fs.lstat(absoluteDirectory, { bigint: true });
    if (details.isSymbolicLink()) throw new Error('--evidence-dir must not be a symlink or junction');
    if (!details.isDirectory()) throw new Error('--evidence-dir must name an existing directory');
    const realDirectory = await fs.realpath(absoluteDirectory);
    const directoryIdentity = identityOf(details);

    const manifestPath = path.join(absoluteDirectory, EVIDENCE_MANIFEST);
    const manifestDetails = await fs.lstat(manifestPath, { bigint: true }).catch(error => { if (error?.code === 'ENOENT') throw new Error(`--evidence-dir must contain ${EVIDENCE_MANIFEST}`); throw error; });
    if (!manifestDetails.isFile() || manifestDetails.isSymbolicLink()) throw new Error(`${EVIDENCE_MANIFEST} must be a regular file inside the evidence directory`);
    const manifestSize = boundedSize(manifestDetails, EVIDENCE_MANIFEST);
    const realManifest = await fs.realpath(manifestPath);
    if (!isWithin(realDirectory, realManifest)) throw new Error(`${EVIDENCE_MANIFEST} escapes the evidence directory`);
    let manifest;
    let manifestContents;
    try { manifestContents = await fs.readFile(manifestPath); manifest = JSON.parse(manifestContents.toString('utf8')); }
    catch (error) {
      if (error instanceof SyntaxError) throw new Error(`${EVIDENCE_MANIFEST} must contain valid JSON`);
      throw error;
    }
    if (!manifest || manifest.version !== 1 || !Array.isArray(manifest.allowed_files)) {
      throw new Error(`${EVIDENCE_MANIFEST} must contain version 1 and an allowed_files array`);
    }
    const manifestIdentity = identityOf(manifestDetails);
    const manifestDetailsAfterRead = await fs.lstat(manifestPath, { bigint: true });
    const realManifestAfterRead = await fs.realpath(manifestPath);
    if (!sameIdentity(identityOf(manifestDetailsAfterRead), manifestIdentity) || !samePath(realManifestAfterRead, realManifest)) throw new Error(`${EVIDENCE_MANIFEST} changed during validation`);
    const manifestDigest = createHash('sha256').update(manifestContents).digest('hex');
    const allowed = new Set();
    const validatedEntries = new Map();
    let totalBytes = manifestSize;
    for (const entry of manifest.allowed_files) {
      if (allowed.size >= MAX_EVIDENCE_FILES - 1) throw new Error(`${EVIDENCE_MANIFEST} exceeds the ${MAX_EVIDENCE_FILES}-file limit including ${EVIDENCE_MANIFEST}`);
      if (typeof entry !== 'string' || !entry.trim() || path.isAbsolute(entry)) throw new Error(`${EVIDENCE_MANIFEST} allowed_files entries must be relative paths`);
      const resolved = path.resolve(absoluteDirectory, entry);
      if (!isWithin(absoluteDirectory, resolved) || path.normalize(entry) === '.') throw new Error(`${EVIDENCE_MANIFEST} contains a path outside the evidence directory`);
      const relative = path.relative(absoluteDirectory, resolved);
      if (relative.split(path.sep).length > MAX_EVIDENCE_PATH_DEPTH) throw new Error(`${EVIDENCE_MANIFEST} contains a path deeper than ${MAX_EVIDENCE_PATH_DEPTH} levels`);
      if (sameManifestName(relative)) throw new Error(`${EVIDENCE_MANIFEST} cannot list itself`);
      if (allowed.has(relative)) throw new Error(`${EVIDENCE_MANIFEST} contains a duplicate file: ${entry}`);
      allowed.add(relative);
      const fileDetails = await fs.lstat(resolved, { bigint: true }).catch(error => { if (error?.code === 'ENOENT') throw new Error(`evidence file is missing: ${entry}`); throw error; });
      if (!fileDetails.isFile() || fileDetails.isSymbolicLink()) throw new Error(`evidence file must be a regular file: ${entry}`);
      const realFile = await fs.realpath(resolved);
      if (!isWithin(realDirectory, realFile)) throw new Error(`evidence file escapes the package: ${entry}`);
      const fileSize = boundedSize(fileDetails, `evidence file ${entry}`);
      totalBytes += fileSize;
      if (totalBytes > MAX_EVIDENCE_TOTAL_BYTES) throw new Error(`evidence package exceeds the ${MAX_EVIDENCE_TOTAL_BYTES}-byte limit`);
      const identity = identityOf(fileDetails);
      const digest = await digestFile(resolved);
      const fileDetailsAfterRead = await fs.lstat(resolved, { bigint: true });
      const realFileAfterRead = await fs.realpath(resolved);
      if (!sameIdentity(identityOf(fileDetailsAfterRead), identity) || !samePath(realFileAfterRead, realFile)) throw new Error(`evidence file changed during validation: ${entry}`);
      validatedEntries.set(relative, { realPath: realFile, identity, digest });
    }

    const discovered = [];
    const validatedDirectories = new Map();
    let discoveredDirectoryCount = 0;
    const visit = async directory => {
      const handle = await fs.opendir(directory);
      try {
        for await (const entry of handle) {
        const current = path.join(directory, entry.name);
        const relative = path.relative(absoluteDirectory, current);
        const details = await fs.lstat(current, { bigint: true });
        if (details.isSymbolicLink()) throw new Error(`evidence package cannot contain symlinks: ${relative}`);
        const realCurrent = await fs.realpath(current);
        if (!isWithin(realDirectory, realCurrent)) throw new Error(`evidence package path escapes the package: ${relative}`);
        if (sameManifestName(path.basename(relative))) {
          if (path.dirname(relative) === '.') continue;
          throw new Error(`evidence package cannot contain a nested ${EVIDENCE_MANIFEST}: ${relative}`);
        }
        if (relative.split(path.sep).length > MAX_EVIDENCE_PATH_DEPTH) throw new Error(`evidence package path is deeper than ${MAX_EVIDENCE_PATH_DEPTH} levels: ${relative}`);
        if (details.isDirectory()) {
          discoveredDirectoryCount += 1;
          if (discoveredDirectoryCount > MAX_EVIDENCE_DIRECTORIES) throw new Error(`evidence package exceeds the ${MAX_EVIDENCE_DIRECTORIES}-directory limit excluding the evidence root`);
          validatedDirectories.set(relative, { realPath: realCurrent, identity: identityOf(details) });
          await visit(current);
        }
        else if (details.isFile()) {
          discovered.push(relative);
          if (discovered.length > MAX_EVIDENCE_FILES - 1) throw new Error(`evidence package exceeds the ${MAX_EVIDENCE_FILES}-file limit including ${EVIDENCE_MANIFEST}`);
        }
        else throw new Error(`evidence package contains an unsupported entry: ${relative}`);
      }
      } finally {
        await handle.close().catch(error => { if (error?.code !== 'ERR_DIR_CLOSED') throw error; });
      }
    };
    await visit(absoluteDirectory);
    const unexpected = discovered.filter(entry => !allowed.has(entry));
    if (unexpected.length) throw new Error(`evidence package contains file not listed in ${EVIDENCE_MANIFEST}: ${unexpected[0]}`);

    // Review a private snapshot so changes to the caller's package cannot alter the process after validation.
    const snapshotDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'agnets-sol-evidence-'));
    const sourceEntries = [EVIDENCE_MANIFEST, ...allowed];
    const signatures = new Map([[EVIDENCE_MANIFEST, { realPath: realManifest, identity: manifestIdentity, digest: manifestDigest }], ...validatedEntries]);
    try {
      const verifyDirectories = async () => {
        for (const [relative, expected] of validatedDirectories) {
          const current = path.join(absoluteDirectory, relative);
          const currentDetails = await fs.lstat(current, { bigint: true });
          if (!currentDetails.isDirectory() || currentDetails.isSymbolicLink()) throw new Error(`evidence package changed during snapshot: ${relative}`);
          const currentRealPath = await fs.realpath(current);
          if (!samePath(currentRealPath, expected.realPath) || !sameIdentity(identityOf(currentDetails), expected.identity)) throw new Error(`evidence package changed during snapshot: ${relative}`);
        }
      };
      const currentRoot = await fs.lstat(absoluteDirectory, { bigint: true });
      const currentRealDirectory = await fs.realpath(absoluteDirectory);
      if (!sameIdentity(identityOf(currentRoot), directoryIdentity) || !samePath(currentRealDirectory, realDirectory)) throw new Error('evidence directory changed during snapshot');
      await verifyDirectories();
      for (const relative of sourceEntries) {
        const source = path.join(absoluteDirectory, relative);
        const sourceDetails = await fs.lstat(source, { bigint: true });
        if (!sourceDetails.isFile() || sourceDetails.isSymbolicLink()) throw new Error(`evidence package changed during snapshot: ${relative}`);
        const sourceRealPath = await fs.realpath(source);
        const expected = signatures.get(relative);
        if (!samePath(sourceRealPath, expected.realPath) || !sameIdentity(identityOf(sourceDetails), expected.identity)) throw new Error(`evidence package changed during snapshot: ${relative}`);
        const destination = path.join(snapshotDirectory, relative);
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.copyFile(source, destination);
        if (await digestFile(destination) !== expected.digest) throw new Error(`evidence package changed during snapshot: ${relative}`);
      }
      for (const relative of sourceEntries) {
        const source = path.join(absoluteDirectory, relative);
        const sourceDetails = await fs.lstat(source, { bigint: true });
        const sourceRealPath = await fs.realpath(source);
        const sourceDigest = await digestFile(source);
        const before = signatures.get(relative);
        const currentRootAfterCopy = await fs.lstat(absoluteDirectory, { bigint: true });
        const currentRealDirectoryAfterCopy = await fs.realpath(absoluteDirectory);
        if (!sameIdentity(identityOf(currentRootAfterCopy), directoryIdentity) || !samePath(currentRealDirectoryAfterCopy, realDirectory) || sourceDetails.isSymbolicLink() || !samePath(sourceRealPath, before.realPath) || !sameIdentity(identityOf(sourceDetails), before.identity) || sourceDigest !== before.digest) {
          throw new Error(`evidence package changed during snapshot: ${relative}`);
        }
      }
      await verifyDirectories();
      let cleaned = false;
      return {
        source: absoluteDirectory,
        workspace: snapshotDirectory,
        cleanup: async () => {
          if (cleaned) return;
          cleaned = true;
          await fs.rm(snapshotDirectory, { recursive: true, force: true });
        },
      };
    } catch (error) {
      await fs.rm(snapshotDirectory, { recursive: true, force: true });
      throw error;
    }
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error('--evidence-dir must name an existing directory');
    throw error;
  }
}

function pathIsWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function sameFilesystemPath(left, right, platform = process.platform) {
  const normalizedLeft = path.normalize(left).normalize('NFC');
  const normalizedRight = path.normalize(right).normalize('NFC');
  return platform === 'win32' ? normalizedLeft.toLocaleLowerCase('und') === normalizedRight.toLocaleLowerCase('und') : normalizedLeft === normalizedRight;
}

function directoryIdentity(metadata) {
  return { dev: BigInt(metadata.dev).toString(), ino: BigInt(metadata.ino).toString() };
}
function sameDirectoryIdentity(left, right) { return left.dev === right.dev && left.ino === right.ino; }

async function prepareWorkflowArtifactAuthority(workflow, resultPath, platform = process.platform, codexHome = null) {
  const root = path.resolve(codexHome ? globalWorkflowArtifactRootForHome(codexHome) : globalWorkflowArtifactRoot());
  const targetDirectory = path.dirname(resultPath);
  await fs.mkdir(root, { recursive: true });
  const relative = path.relative(root, targetDirectory);
  if (!pathIsWithin(root, targetDirectory) || relative === '') throw new Error('workflow result directory must be a child of the global artifact root');
  const rootMetadata = await fs.lstat(root, { bigint: true });
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) throw new Error('global workflow artifact root must resolve to a regular directory');
  const rootRealPath = await fs.realpath(root);
  const directories = [{ path: root, real_path: rootRealPath, identity: directoryIdentity(rootMetadata) }];
  let current = root;
  for (const segment of relative.split(path.sep)) {
    if (!segment || segment === '.' || segment === '..') throw new Error('workflow result directory contains an invalid path segment');
    current = path.join(current, segment);
    try { await fs.mkdir(current); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    const metadata = await fs.lstat(current, { bigint: true });
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error(`workflow result directory must not contain a symlink or junction: ${current}`);
    const realPath = await fs.realpath(current);
    if (!pathIsWithin(rootRealPath, realPath)) throw new Error(`workflow result directory escapes the global artifact root: ${current}`);
    directories.push({ path: current, real_path: realPath, identity: directoryIdentity(metadata) });
  }
  return { version: 1, platform, root_real_path: rootRealPath, target_directory: targetDirectory, target_real_path: directories.at(-1).real_path, directories };
}

async function verifyWorkflowArtifactAuthority(authority) {
  for (const expected of authority.directories) {
    const metadata = await fs.lstat(expected.path, { bigint: true });
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error(`workflow result directory identity changed: ${expected.path}`);
    const realPath = await fs.realpath(expected.path);
    if (!sameFilesystemPath(realPath, expected.real_path, authority.platform) || !sameDirectoryIdentity(directoryIdentity(metadata), expected.identity)) throw new Error(`workflow result directory identity changed: ${expected.path}`);
  }
}

async function writeAtomically(filePath, value, authority = null) {
  if (authority?.directories) {
    if (!sameFilesystemPath(path.dirname(filePath), authority.target_directory, authority.platform)) throw new Error(`workflow artifact path is outside its verified result directory: ${filePath}`);
    await verifyWorkflowArtifactAuthority(authority);
    try {
      const existing = await fs.lstat(filePath, { bigint: true });
      if (existing.isSymbolicLink()) throw new Error(`workflow artifact target must not be a symlink or junction: ${filePath}`);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  } else if (!authority) throw new Error(`Workflow artifact write requires a caller-verified authority: ${filePath}`);
  const parent = authority.directories?.at(-1) ?? authority;
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  let handle; let temporaryIdentity = null;
  try {
    handle = await fs.open(temporary, 'wx');
    temporaryIdentity = filesystemIdentity(await handle.stat({ bigint: true }));
    await verifyRegularDirectory(parent);
    if (authority?.directories) {
      await verifyWorkflowArtifactAuthority(authority);
      const temporaryRealPath = await fs.realpath(temporary);
      if (!pathIsWithin(authority.target_real_path, temporaryRealPath)) throw new Error(`workflow artifact temporary file escaped its verified result directory: ${temporary}`);
    }
    await handle.writeFile(value);
    await handle.sync();
    await handle.close(); handle = null;
    await verifyRegularDirectory(parent);
    await verifyOwnedFile(temporary, temporaryIdentity, 'workflow artifact temporary');
    if (authority?.directories) await verifyWorkflowArtifactAuthority(authority);
    await fs.rename(temporary, filePath);
    await verifyRegularDirectory(parent);
    await verifyOwnedFile(filePath, temporaryIdentity, 'workflow artifact');
    if (authority?.directories) {
      await verifyWorkflowArtifactAuthority(authority);
      const resultRealPath = await fs.realpath(filePath);
      if (!pathIsWithin(authority.target_real_path, resultRealPath)) throw new Error(`workflow artifact escaped its verified result directory: ${filePath}`);
    }
    handle = await fs.open(filePath, 'r+');
    await handle.sync();
    if (process.platform !== 'win32') {
      const directoryHandle = await fs.open(path.dirname(filePath), 'r');
      try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
    }
  } catch (error) {
    await handle?.close(); handle = null;
    await unlinkOwnedFile(temporary, temporaryIdentity);
    throw error;
  } finally {
    await handle?.close();
  }
}

function captureStream(stream, destination) {
  const capture = { chunks: [], bytes: 0, truncated: false, drained: false, drain_timed_out: false, destination_error: null };
  if (!stream) { capture.done = Promise.resolve(); return capture; }
  let settle;
  let sourceEnded = false;
  let pendingDrain = false;
  let stopped = false;
  let drainListener = null;
  const done = new Promise(resolve => { settle = resolve; });
  const settleOnce = () => {
    if (!settle || !sourceEnded || pendingDrain) return;
    const resolve = settle; settle = null; resolve();
  };
  const clearDrainListener = () => {
    if (!drainListener) return;
    destination?.removeListener?.('drain', drainListener);
    drainListener = null;
    pendingDrain = false;
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearDrainListener();
    stream.removeListener?.('data', onData);
    // Resume without a data listener so the child pipe is drained and cannot
    // keep the child blocked after the bounded capture has stopped.
    stream.resume?.();
    sourceEnded = true;
    settleOnce();
  };
  const onSourceEnd = () => { sourceEnded = true; settleOnce(); };
  const onData = chunk => {
    if (stopped) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    if (capture.bytes >= MAX_CAPTURE_BYTES) { capture.truncated = true; return; }
    const available = MAX_CAPTURE_BYTES - capture.bytes;
    const retained = bytes.subarray(0, available);
    capture.chunks.push(retained); capture.bytes += retained.byteLength;
    if (bytes.byteLength > available) capture.truncated = true;
    if (!retained.byteLength || !destination?.write) return;
    let accepted;
    try { accepted = destination.write(retained); }
    catch (error) { capture.destination_error = error.message || String(error); capture.drain_timed_out = true; stop(); return; }
    if (accepted || typeof stream.pause !== 'function' || typeof destination.once !== 'function') return;
    pendingDrain = true;
    stream.pause();
    drainListener = () => {
      clearDrainListener();
      if (!stopped) stream.resume?.();
      settleOnce();
    };
    destination.once('drain', drainListener);
  };
  stream.once('end', onSourceEnd);
  stream.once('close', onSourceEnd);
  stream.once('error', onSourceEnd);
  stream.on('data', onData);
  capture.done = done;
  capture.stop = stop;
  return capture;
}

export function extractJsonObjects(text) {
  const values = [];
  const stack = [];
  let candidateStart = -1;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') { inString = true; continue; }
    if (character === '{' || character === '[') {
      if (stack.length === 0 && character === '{') candidateStart = index;
      stack.push(character);
      continue;
    }
    if (character !== '}' && character !== ']') continue;
    const expected = character === '}' ? '{' : '[';
    if (stack.at(-1) !== expected) {
      // An unmatched close invalidates the lexical prefix. Do not let a later
      // object bypass that malformed boundary.
      return values;
    }
    stack.pop();
    if (stack.length !== 0 || candidateStart < 0) continue;
    const start = candidateStart;
    candidateStart = -1;
    if (character !== '}') continue;
    try {
      const value = JSON.parse(text.slice(start, index + 1));
      if (value && typeof value === 'object' && !Array.isArray(value)) values.push({ value, start, end: index });
    } catch { /* Keep looking for the next complete top-level object. */ }
  }
  return values;
}

function nonEmptyString(value) {
  return typeof value === 'string' && Boolean(value.trim());
}

function nonEmptyObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0;
}

function nonEmptyReviewValue(value) {
  if (typeof value === 'string') return Boolean(value.trim());
  if (Array.isArray(value)) return value.length > 0;
  return Boolean(value) && typeof value === 'object' && Object.keys(value).length > 0;
}

function validateReviewFindings(value, workflowContract) {
  const findings = value.findings ?? [];
  if (!Array.isArray(findings)) return 'review output findings must be an array';
  if (findings.length > MAX_REVIEW_FINDINGS) return `review output findings exceed the ${MAX_REVIEW_FINDINGS}-finding limit`;
  const requirementIds = new Set(workflowContract?.requirement_ids ?? Object.keys(value.requirement_coverage));
  const findingIds = new Set();
  let blockingFindings = 0;
  for (const [index, finding] of findings.entries()) {
    if (!finding || typeof finding !== 'object' || Array.isArray(finding)) return `review output findings[${index}] must be an object`;
    const keys = Object.keys(finding).sort();
    const expectedFields = [...REVIEW_FINDING_FIELDS].sort();
    if (keys.length !== expectedFields.length || keys.some((key, keyIndex) => key !== expectedFields[keyIndex])) return `review output findings[${index}] must contain exactly: ${REVIEW_FINDING_FIELDS.join(', ')}`;
    if (!nonEmptyString(finding.id) || !/^[A-Za-z][A-Za-z0-9._-]{0,79}$/.test(finding.id)) return `review output findings[${index}].id must be a valid identifier of at most 80 characters`;
    if (findingIds.has(finding.id)) return 'review output finding ids must be unique';
    findingIds.add(finding.id);
    if (!REVIEW_FINDING_SEVERITIES.has(finding.severity)) return `review output findings[${index}].severity must be blocking or advisory`;
    if (finding.severity === 'blocking') blockingFindings += 1;
    if (finding.requirement_id !== null && (!nonEmptyString(finding.requirement_id) || !requirementIds.has(finding.requirement_id))) return `review output findings[${index}].requirement_id must name a covered requirement or be null`;
    if (!nonEmptyString(finding.summary) || !nonEmptyReviewValue(finding.evidence)) return `review output findings[${index}].summary and evidence must be non-empty`;
  }
  if (value.verdict === 'fail' && blockingFindings === 0) return 'a fail review requires at least one blocking finding';
  if (value.verdict === 'pass' && blockingFindings > 0) return 'a pass review cannot contain a blocking finding';
  if (value.verdict === 'unavailable' && findings.length > 0) return 'an unavailable review cannot contain findings';
  return null;
}

async function readWorkflowReviewContract(workflow) {
  if (!workflow) return null;
  try {
    const [context] = await dispatch('audit-context', { state_dir: workflow.state_dir, task_id: workflow.task_id });
    const node = context.nodes.find(candidate => candidate.id === workflow.node_id);
    if (!node || node.kind !== 'total_review' || node.status !== 'running' || node.claim_id !== workflow.claim_id) {
      return { error: 'workflow total-review claim is no longer active' };
    }
    return {
      auditor_task: node.agent_task_path,
      auditor_role: node.agent_role,
      claim_id: node.claim_id,
      requirement_ids: context.requirements.map(requirement => requirement.id),
      workflow_snapshot: context.workflow_snapshot,
      workspace_fingerprint: context.workspace_fingerprint,
    };
  } catch (error) {
    return { error: `workflow audit context is unavailable: ${error.message}` };
  }
}

function validateReviewOutput(stdout, workflowContract) {
  if (stdout.truncated || stdout.drain_timed_out) return { valid: false, reason: 'review output capture is incomplete' };
  const text = Buffer.concat(stdout.chunks).toString('utf8');
  const values = extractJsonObjects(text);
  if (!values.length) return { valid: false, reason: 'review output did not contain a JSON object' };
  let trailingEnd = text.length - 1;
  while (trailingEnd >= 0 && /\s/.test(text[trailingEnd])) trailingEnd -= 1;
  const terminal = values.filter(candidate => candidate.end === trailingEnd);
  if (!terminal.length) return { valid: false, reason: 'review output must end with a final JSON object' };
  const candidate = terminal.find(item => REVIEW_REQUIRED_FIELDS.every(field => Object.prototype.hasOwnProperty.call(item.value, field))) ?? terminal.at(-1);
  const value = candidate.value;
  const missing = REVIEW_REQUIRED_FIELDS.filter(field => !Object.prototype.hasOwnProperty.call(value, field));
  if (missing.length) return { valid: false, reason: `review output is missing required fields: ${missing.join(', ')}` };
  if (!REVIEW_VERDICTS.has(value.verdict)) return { valid: false, reason: 'review output verdict must be pass, fail, or unavailable' };
  if (!nonEmptyString(value.auditor_task) || !nonEmptyString(value.auditor_role) || !nonEmptyString(value.claim_id)) return { valid: false, reason: 'review output auditor_task, auditor_role, and claim_id must be non-empty strings' };
  if (!nonEmptyObject(value.requirement_coverage) || !nonEmptyObject(value.workflow_snapshot) || !nonEmptyObject(value.workspace_fingerprint)) return { valid: false, reason: 'review output requirement_coverage, workflow_snapshot, and workspace_fingerprint must be non-empty objects' };
  if (Object.values(value.requirement_coverage).some(item => !nonEmptyReviewValue(item))) return { valid: false, reason: 'review output requirement_coverage values must be non-empty strings, arrays, or objects' };
  if (!nonEmptyReviewValue(value.scope_and_regression) || !nonEmptyReviewValue(value.verification_gaps) || !nonEmptyReviewValue(value.residual_risk)) return { valid: false, reason: 'review output scope_and_regression, verification_gaps, and residual_risk must be non-empty strings, arrays, or objects' };
  if (workflowContract?.error) return { valid: false, reason: workflowContract.error };
  const findingError = validateReviewFindings(value, workflowContract);
  if (findingError) return { valid: false, reason: findingError };
  if (workflowContract) {
    if (value.auditor_task !== workflowContract.auditor_task || value.auditor_role !== workflowContract.auditor_role || value.claim_id !== workflowContract.claim_id) return { valid: false, reason: 'review output auditor identity or claim_id does not match the active workflow review' };
    const expectedIds = new Set(workflowContract.requirement_ids);
    if (Object.keys(value.requirement_coverage).length !== expectedIds.size || [...expectedIds].some(id => !Object.prototype.hasOwnProperty.call(value.requirement_coverage, id) || !nonEmptyReviewValue(value.requirement_coverage[id]))) return { valid: false, reason: 'review output does not cover every workflow requirement' };
    if (!sameJson(value.workflow_snapshot, workflowContract.workflow_snapshot)) return { valid: false, reason: 'review output workflow_snapshot does not match the current workflow' };
    if (!sameJson(value.workspace_fingerprint, workflowContract.workspace_fingerprint)) return { valid: false, reason: 'review output workspace_fingerprint does not match the current workspace' };
  }
  return { valid: true, verdict: value.verdict };
}

function waitForCaptureDrain(capture, milliseconds = 250) {
  return new Promise(resolve => {
    const timer = setTimeout(() => { capture.drain_timed_out = true; resolve(false); }, milliseconds);
    capture.done.then(() => { clearTimeout(timer); capture.drained = true; resolve(true); }, () => { clearTimeout(timer); capture.drained = true; resolve(true); });
    const timeout = setTimeout(() => capture.stop?.(), milliseconds);
    capture.done.then(() => clearTimeout(timeout), () => clearTimeout(timeout));
  });
}

function startWindowsPromptWrite(stream, prompt) {
  if (!stream || typeof stream.end !== 'function') return null;
  let error = null;
  let settle;
  let settled = false;
  let graceTimer;
  const done = new Promise(resolve => { settle = resolve; });
  const cleanup = () => {
    clearTimeout(graceTimer);
    clearTimeout(maxTimer);
    stream.removeListener?.('error', onError);
    stream.removeListener?.('finish', onTerminal);
    stream.removeListener?.('close', onTerminal);
  };
  const finish = () => {
    if (settled) return;
    settled = true;
    cleanup();
    settle();
  };
  const onError = value => { error = value; finish(); };
  const onTerminal = () => {
    clearTimeout(graceTimer);
    graceTimer = setTimeout(finish, 250);
  };
  const maxTimer = setTimeout(finish, 1500);
  stream.once?.('error', onError);
  stream.once?.('finish', onTerminal);
  stream.once?.('close', onTerminal);
  try { stream.end(prompt ? `${prompt}\n` : ''); }
  catch (caught) { onError(caught); }
  return { wait: () => done, get error() { return error; } };
}

function waitForExit(child) {
  return new Promise(resolve => {
    let spawned = false;
    let settled = false;
    let spawnError = null;
    const finish = result => {
      if (settled) return;
      settled = true;
      resolve({ spawn_started: spawned || result.code !== null || result.signal !== null, ...result });
    };
    child.once('spawn', () => { spawned = true; });
    child.once('error', error => {
      spawnError = error.message;
      if (!spawned) finish({ code: null, signal: null, spawn_error: spawnError });
    });
    child.once('exit', (code, signal) => finish({ code, signal, spawn_error: spawnError }));
  });
}

function waitForExitWithin(exit, milliseconds) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(null), milliseconds);
    exit.then(outcome => { clearTimeout(timer); resolve(outcome); }, error => { clearTimeout(timer); reject(error); });
  });
}

export async function terminateSolReviewProcess(child, platform = process.platform, spawnProcess = spawn) {
  if (!Number.isSafeInteger(child.pid) || child.pid <= 0) throw new Error('Cannot terminate Sol review because the spawned process has no PID');
  if (platform !== 'win32') {
    process.kill(-child.pid, 'SIGTERM');
    return { method: 'process-group SIGTERM', pid: child.pid };
  }
  await new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const finish = (error = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve();
    };
    let terminator;
    try { terminator = spawnProcess('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, shell: false, stdio: 'ignore' }); }
    catch (error) { finish(error); return; }
    terminator.once('error', error => finish(error));
    terminator.once('exit', code => code === 0 ? finish() : finish(new Error(`taskkill exited with ${code}`)));
    timer = setTimeout(() => {
      terminator.kill?.();
      finish(new Error(`taskkill timed out after ${TERMINATION_REQUEST_TIMEOUT_MS}ms`));
    }, TERMINATION_REQUEST_TIMEOUT_MS);
  });
  return { method: 'taskkill /pid /t /f', pid: child.pid };
}

async function waitForReviewOutcome(child, softTimeoutMs, hardTimeoutMs, platform, terminateProcess, spawnProcess) {
  const exit = waitForExit(child).then(outcome => ({ kind: 'exit', ...outcome }));
  const exitDetails = value => { const { kind, ...details } = value; return details; };
  let softTimer;
  let hardTimer;
  const softDeadline = new Promise(resolve => {
    if (softTimeoutMs <= 0) resolve({ kind: 'soft_deadline' });
    else softTimer = setTimeout(() => resolve({ kind: 'soft_deadline' }), softTimeoutMs);
  });
  const hardDeadline = hardTimeoutMs === null ? null : new Promise(resolve => {
    if (hardTimeoutMs <= 0) resolve({ kind: 'hard_deadline' });
    else hardTimer = setTimeout(() => resolve({ kind: 'hard_deadline' }), hardTimeoutMs);
  });
  const clearTimers = () => { clearTimeout(softTimer); clearTimeout(hardTimer); };
  const first = await Promise.race([exit, softDeadline, ...(hardDeadline ? [hardDeadline] : [])]);
  if (first?.kind === 'exit') {
    clearTimers();
    return { ...exitDetails(first), timed_out: false, deadline_reached: false, hard_timeout_reached: false, termination: null };
  }
  if (first?.kind === 'soft_deadline') {
    process.stderr.write(`[sol-review] soft deadline reached after ${softTimeoutMs}ms; continuing until Sol exits.\n`);
    const afterSoft = hardDeadline ? await Promise.race([exit, hardDeadline]) : await exit;
    if (afterSoft?.kind === 'exit') {
      clearTimers();
      return { ...exitDetails(afterSoft), timed_out: false, deadline_reached: true, hard_timeout_reached: false, termination: null };
    }
    // An explicit hard timeout is the only path that terminates a still-running Sol review.
  }
  if (first?.kind === 'hard_deadline' || (first?.kind === 'soft_deadline' && hardDeadline)) {
    clearTimers();
    let termination;
    try {
      termination = await waitForExitWithin(Promise.resolve().then(() => terminateProcess(child, platform, spawnProcess)), TERMINATION_REQUEST_TIMEOUT_MS);
      if (!termination) throw new Error(`process termination request timed out after ${TERMINATION_REQUEST_TIMEOUT_MS}ms`);
    }
    catch (error) {
      const naturallyCompleted = await waitForExitWithin(exit, TERMINATION_GRACE_MS);
      if (naturallyCompleted?.kind === 'exit') return { ...exitDetails(naturallyCompleted), timed_out: true, deadline_reached: first?.kind === 'soft_deadline', hard_timeout_reached: true, termination: { requested: false, confirmed: true, error: error.message, reason: 'child exited while termination was being requested' } };
      return { code: null, signal: null, timed_out: true, deadline_reached: first?.kind === 'soft_deadline', hard_timeout_reached: true, termination: { requested: false, confirmed: false, error: error.message } };
    }
    const completed = await waitForExitWithin(exit, TERMINATION_GRACE_MS);
    if (completed?.kind === 'exit') return { ...exitDetails(completed), timed_out: true, deadline_reached: first?.kind === 'soft_deadline', hard_timeout_reached: true, termination: { ...termination, requested: true, confirmed: true } };
    return { code: null, signal: null, timed_out: true, deadline_reached: first?.kind === 'soft_deadline', hard_timeout_reached: true, termination: { ...termination, requested: true, confirmed: false } };
  }
  clearTimers();
  return { code: null, signal: null, timed_out: false, deadline_reached: false, hard_timeout_reached: false, termination: null };
}

function artifactPaths(resultPath) {
  const parsed = path.parse(resultPath);
  return {
    result: resultPath,
    stdout: path.join(parsed.dir, `${parsed.name}.stdout.log`),
    stderr: path.join(parsed.dir, `${parsed.name}.stderr.log`),
  };
}

async function persistOutcome(resultPath, outcome, stdout, stderr, authority = null) {
  const paths = artifactPaths(resultPath);
  await writeAtomically(paths.stdout, Buffer.concat(stdout.chunks), authority);
  await writeAtomically(paths.stderr, Buffer.concat(stderr.chunks), authority);
  const result = {
    version: 1,
    ...outcome,
    stdout: { path: paths.stdout, captured_bytes: stdout.bytes, truncated: stdout.truncated || stdout.drain_timed_out, drain_timed_out: stdout.drain_timed_out },
    stderr: { path: paths.stderr, captured_bytes: stderr.bytes, truncated: stderr.truncated || stderr.drain_timed_out, drain_timed_out: stderr.drain_timed_out },
  };
  await writeAtomically(paths.result, `${JSON.stringify(result, null, 2)}\n`, authority);
  return { result, paths };
}

async function persistWorkflowCompletion(stored, workflowCompletion, authority = null) {
  if (!stored || workflowCompletion?.completed !== true) return;
  stored.result.workflow_completion = workflowCompletion;
  await writeAtomically(stored.paths.result, `${JSON.stringify(stored.result, null, 2)}\n`, authority);
}

async function recordUnavailableWorkflowReview(workflow, resultPath, authority = null) {
  if (!workflow) return;
  if (!authority?.directories) throw new Error('workflow unavailable review requires a verified artifact authority');
  await dispatch('heartbeat', { state_dir: workflow.state_dir, task_id: workflow.task_id, node_id: workflow.node_id, claim_id: workflow.claim_id });
  const [context] = await dispatch('audit-context', { state_dir: workflow.state_dir, task_id: workflow.task_id });
  const node = context.nodes.find(candidate => candidate.id === workflow.node_id);
  if (!node || node.claim_id !== workflow.claim_id || node.status !== 'running') throw new Error('workflow total-review claim is no longer active while recording unavailable review');
  const review = {
    auditor_task: node.agent_task_path,
    auditor_role: node.agent_role,
    claim_id: node.claim_id,
    verdict: 'unavailable',
    findings: [],
    requirement_coverage: Object.fromEntries(context.requirements.map(requirement => [requirement.id, 'Reviewer unavailable before assessment.'])),
    workflow_snapshot: context.workflow_snapshot,
    workspace_fingerprint: context.workspace_fingerprint,
    scope_and_regression: 'Unavailable before assessment.',
    verification_gaps: 'The review process did not produce a usable verdict.',
    residual_risk: 'Unassessed; the workflow remains retryable.',
    independent_assessment: 'No independent assessment was produced.',
    history_reconciliation: 'No review evidence was produced for this attempt.',
    review_history_digest: context.review_history_digest,
  };
  const reviewPath = path.join(path.dirname(resultPath), 'unavailable-review.json');
  await writeAtomically(reviewPath, `${JSON.stringify(review, null, 2)}\n`, authority);
  await dispatch('record-review', { state_dir: workflow.state_dir, task_id: workflow.task_id, review: reviewPath });
}

async function completeUnavailableWorkflowReview(workflow, resultPath, outcome, authority = null) {
  if (!workflow || (!outcome.timed_out && outcome.exit_code === 0 && !outcome.signal && !outcome.spawn_error && outcome.review_verdict?.valid === true)) return null;
  if (outcome.timed_out && !outcome.termination?.confirmed) return { completed: false, reason: 'timed_out_process_exit_not_confirmed' };
  try {
    await recordUnavailableWorkflowReview(workflow, resultPath, authority);
    const [completion] = await dispatch('complete', {
      state_dir: workflow.state_dir,
      task_id: workflow.task_id,
      node_id: workflow.node_id,
      claim_id: workflow.claim_id,
      status: 'unavailable',
      result: resultPath,
       completion_attestation: outcome.spawn_started === false ? NATIVE_AGENT_START_FAILED : NATIVE_AGENT_EXIT_CONFIRMED,
    });
    const workflowCompletion = completion?.workflow_outcome_completion;
    if (!workflowCompletion?.completed) return { completed: false, reason: 'workflow completion did not return a finalized outcome' };
    return workflowCompletion;
  } catch (error) {
    return { completed: false, reason: `workflow completion failed: ${error.message}` };
  }
}

export async function runSolReview(argv = process.argv.slice(2), environment = process.env, platform = process.platform, spawnProcess = spawn, terminateProcess = terminateSolReviewProcess) {
  const invocation = parseInvocation(argv, environment, platform);
  const { codexBin, timeoutSec, hardTimeoutSec, reviewProfile, evidenceDirectory, reviewRole: requestedReviewRole, reviewRoleExplicit, promptArgs } = invocation;
  const codexHome = resolveCodexHome(environment, platform);
  let workflow = invocation.workflow;
  let resultPath = invocation.resultPath;
  let workflowArtifactAuthority = null;
  if (workflow) {
    workflow = { ...workflow, state_dir: await canonicalStateDirectory(workflow.state_dir, '--workflow-state-dir') };
    const expectedResultPath = globalWorkflowArtifactPathForHome(workflow.state_dir, workflow.task_id, workflow.claim_id, 'outcome.json', codexHome);
    if (!resultPath) resultPath = expectedResultPath;
    if (path.resolve(resultPath) !== expectedResultPath) throw new Error(`--result must be exactly ${expectedResultPath} when workflow binding is used`);
    workflowArtifactAuthority = await prepareWorkflowArtifactAuthority(workflow, resultPath, platform, codexHome);
  } else if (resultPath) {
    throw new Error('--result is only valid for a workflow-bound review; standalone reviews never persist JSON to a caller-selected path');
  }
  const artifactAuthority = workflowArtifactAuthority;
  const startedAt = new Date().toISOString(); const started = Date.now();
  const softDeadline = started + timeoutSec * 1000;
  const hardDeadline = hardTimeoutSec === null ? null : started + hardTimeoutSec * 1000;
  const repair = await repairInvalidDenyReadAclState(codexHome, platform);
  const childEnvironment = { ...environment, CODEX_HOME: codexHome };
  const initialWorkflowContract = workflow ? await readWorkflowReviewContract(workflow) : null;
  const workflowPreflightError = initialWorkflowContract?.error
    ? initialWorkflowContract.error
    : initialWorkflowContract && !SOL_REVIEW_ROLE_EFFORTS.has(initialWorkflowContract.auditor_role)
      ? `workflow total-review role cannot be run by sol_review_cli: ${initialWorkflowContract.auditor_role}`
      : null;
  if (workflowPreflightError) {
    if (!workflow || !resultPath) throw new Error(workflowPreflightError);
    const outcome = {
      codex_home: codexHome, codex_bin: codexBin, child_pid: null, timeout_sec: timeoutSec, hard_timeout_sec: hardTimeoutSec,
      timeout_scope: hardTimeoutSec === null ? 'soft_deadline_to_child_exit' : 'soft_deadline_with_explicit_hard_cap', review_profile: reviewProfile,
      review_role: requestedReviewRole, evidence_directory: evidenceDirectory, review_workspace: null, started_at: startedAt, finished_at: new Date().toISOString(), duration_ms: Date.now() - started,
      exit_code: 1, child_exit_code: null, spawn_error: workflowPreflightError, spawn_started: false, signal: null, timed_out: false, deadline_reached: false, hard_timeout_reached: false,
      termination: null, review_verdict: { valid: false, reason: workflowPreflightError }, repair, workflow,
      workflow_artifact_authority: workflowArtifactAuthority,
      workflow_completion: { state: 'pending' },
    };
    const emptyCapture = { chunks: [], bytes: 0, truncated: false, drain_timed_out: false };
    const stored = await persistOutcome(resultPath, outcome, emptyCapture, emptyCapture, workflowArtifactAuthority);
    const workflowCompletion = await completeUnavailableWorkflowReview(workflow, stored.paths.result, outcome, workflowArtifactAuthority);
    await persistWorkflowCompletion(stored, workflowCompletion, workflowArtifactAuthority);
    return { ...outcome, result_path: stored.paths.result, workflow_completion: workflowCompletion?.completed === true ? workflowCompletion : outcome.workflow_completion, workflow_completion_error: workflowCompletion?.completed === false ? workflowCompletion.reason : null };
  }
  if (reviewRoleExplicit && initialWorkflowContract && !initialWorkflowContract.error && requestedReviewRole !== initialWorkflowContract.auditor_role) {
    throw new Error(`--review-role must match the active workflow total-review role: ${initialWorkflowContract.auditor_role}`);
  }
  const reviewRole = initialWorkflowContract && !initialWorkflowContract.error ? initialWorkflowContract.auditor_role : requestedReviewRole;
  const reasoningEffort = SOL_REVIEW_ROLE_EFFORTS.get(reviewRole);
  const prompt = reviewPrompt(promptArgs, reviewProfile, workflow, reviewRole);
  let evidencePackage;
  try { evidencePackage = await resolveEvidenceDirectory(reviewProfile, evidenceDirectory, platform); }
  catch (error) {
    if (!workflow || !resultPath) throw error;
    const reason = `evidence validation failed: ${error.message}`;
    const outcome = {
      codex_home: codexHome, codex_bin: codexBin, child_pid: null, timeout_sec: timeoutSec, hard_timeout_sec: hardTimeoutSec,
      timeout_scope: hardTimeoutSec === null ? 'soft_deadline_to_child_exit' : 'soft_deadline_with_explicit_hard_cap', review_profile: reviewProfile,
      evidence_directory: evidenceDirectory, review_workspace: null, started_at: startedAt, finished_at: new Date().toISOString(), duration_ms: Date.now() - started,
       exit_code: 1, child_exit_code: null, spawn_error: reason, spawn_started: false, signal: null, timed_out: false, deadline_reached: false, hard_timeout_reached: false,
       termination: null, review_verdict: { valid: false, reason }, repair, workflow,
       workflow_artifact_authority: workflowArtifactAuthority,
       workflow_completion: workflow ? { state: 'pending' } : null,
    };
    const emptyCapture = { chunks: [], bytes: 0, truncated: false, drain_timed_out: false };
    const stored = await persistOutcome(resultPath, outcome, emptyCapture, emptyCapture, workflowArtifactAuthority);
    const workflowCompletion = await completeUnavailableWorkflowReview(workflow, stored.paths.result, outcome, workflowArtifactAuthority);
    await persistWorkflowCompletion(stored, workflowCompletion, workflowArtifactAuthority);
    return { ...outcome, result_path: stored.paths.result, workflow_completion: workflowCompletion?.completed === true ? workflowCompletion : outcome.workflow_completion, workflow_completion_error: workflowCompletion?.completed === false ? workflowCompletion.reason : null };
  }
  const reviewWorkspace = evidencePackage?.workspace ?? null;
  let cleanupEvidence = true;
  const childArgs = ['exec', '--ephemeral', '--model', 'gpt-5.6-sol', '--config', `model_reasoning_effort="${reasoningEffort}"`, '--sandbox', 'read-only'];
  if (reviewWorkspace) childArgs.push('-C', reviewWorkspace, '--skip-git-repo-check');
  const usesWindowsCommandScript = platform === 'win32' && /\.(?:cmd|bat)$/i.test(codexBin);
  if (!usesWindowsCommandScript && prompt) childArgs.push('--', prompt);
  let spawnCommand = codexBin;
  let spawnedArgs = childArgs;
  let spawnOptions = { env: childEnvironment, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false, detached: platform !== 'win32', ...(reviewWorkspace ? { cwd: reviewWorkspace } : {}) };
  if (usesWindowsCommandScript) {
    // Keep the prompt out of the .cmd argument vector; cmd expands percent sequences in %*.
    childEnvironment.CODEX_REVIEW_BIN = codexBin;
    childEnvironment.CODEX_REVIEW_REASONING_EFFORT = reasoningEffort;
    if (reviewWorkspace) childEnvironment.CODEX_REVIEW_WORKSPACE = reviewWorkspace;
    spawnCommand = 'powershell.exe';
    spawnedArgs = ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', "$workspace = [Environment]::GetEnvironmentVariable('CODEX_REVIEW_WORKSPACE'); $effort = [Environment]::GetEnvironmentVariable('CODEX_REVIEW_REASONING_EFFORT'); $arguments = @('exec','--ephemeral','--model','gpt-5.6-sol','--config', ('model_reasoning_effort=\"' + $effort + '\"'),'--sandbox','read-only'); if ($workspace) { $arguments += @('-C', $workspace, '--skip-git-repo-check') }; & $env:CODEX_REVIEW_BIN @arguments; exit $LASTEXITCODE"];
    spawnOptions = { ...spawnOptions, stdio: ['pipe', 'pipe', 'pipe'], detached: false };
  }
  try {
    let child = null;
    let childOutcome;
    let stdout = captureStream(null, process.stdout);
    let stderr = captureStream(null, process.stderr);
    try { child = spawnProcess(spawnCommand, spawnedArgs, spawnOptions); }
    catch (error) {
      const reason = `Sol review process could not start: ${error.message}`;
      const outcome = {
        codex_home: codexHome, codex_bin: codexBin, child_pid: null, timeout_sec: timeoutSec, hard_timeout_sec: hardTimeoutSec,
        timeout_scope: hardTimeoutSec === null ? 'soft_deadline_to_child_exit' : 'soft_deadline_with_explicit_hard_cap', review_profile: reviewProfile,
        evidence_directory: evidencePackage?.source ?? null, review_workspace: reviewWorkspace, started_at: startedAt, finished_at: new Date().toISOString(), duration_ms: Date.now() - started,
        exit_code: 1, child_exit_code: null, spawn_error: reason, spawn_started: false, signal: null, timed_out: false, deadline_reached: false, hard_timeout_reached: false,
        termination: null, review_verdict: { valid: false, reason }, repair, workflow, workflow_completion: workflow ? { state: 'pending' } : null,
        workflow_artifact_authority: workflowArtifactAuthority,
      };
      const emptyCapture = { chunks: [], bytes: 0, truncated: false, drain_timed_out: false };
      const stored = resultPath ? await persistOutcome(resultPath, outcome, emptyCapture, emptyCapture, artifactAuthority) : null;
      const workflowCompletion = stored ? await completeUnavailableWorkflowReview(workflow, stored.paths.result, outcome, workflowArtifactAuthority) : null;
      await persistWorkflowCompletion(stored, workflowCompletion, workflowArtifactAuthority);
      return { ...outcome, result_path: stored?.paths.result ?? null, workflow_completion: workflowCompletion?.completed === true ? workflowCompletion : outcome.workflow_completion, workflow_completion_error: workflowCompletion?.completed === false ? workflowCompletion.reason : null };
    }
    const stdinWrite = usesWindowsCommandScript ? startWindowsPromptWrite(child.stdin, prompt) : null;
    // Child stdout/stderr are machine-readable review evidence. Capture them
    // for validation and artifact persistence, but never tee them into the
    // caller's terminal where a host may render them as user-facing text.
    stdout = captureStream(child.stdout);
    stderr = captureStream(child.stderr);
    childOutcome = await waitForReviewOutcome(child, Math.max(0, softDeadline - Date.now()), hardDeadline === null ? null : Math.max(0, hardDeadline - Date.now()), platform, terminateProcess, spawnProcess);
    if (childOutcome.timed_out && !childOutcome.termination?.confirmed) cleanupEvidence = false;
    await Promise.all([waitForCaptureDrain(stdout), waitForCaptureDrain(stderr)]);
    await stdinWrite?.wait();
    const stdinError = stdinWrite?.error ?? null;
    const childExitCode = stdinError ? 1 : childOutcome.timed_out ? 124 : childOutcome.signal ? 1 : childOutcome.code ?? 1;
    const workflowContract = !childOutcome.timed_out && childExitCode === 0 && !childOutcome.signal && !childOutcome.spawn_error
      ? await readWorkflowReviewContract(workflow)
      : null;
    const reviewVerdict = !childOutcome.timed_out && childExitCode === 0 && !childOutcome.signal && !childOutcome.spawn_error
      ? validateReviewOutput(stdout, workflowContract)
      : null;
    const exitCode = reviewVerdict && !reviewVerdict.valid ? 1 : childExitCode;
    const outcome = {
    codex_home: codexHome,
    codex_bin: codexBin,
    child_pid: Number.isSafeInteger(child?.pid) ? child.pid : null,
    timeout_sec: timeoutSec,
    hard_timeout_sec: hardTimeoutSec,
    timeout_scope: hardTimeoutSec === null ? 'soft_deadline_to_child_exit' : 'soft_deadline_with_explicit_hard_cap',
    review_profile: reviewProfile,
    evidence_directory: evidencePackage?.source ?? null,
    review_workspace: reviewWorkspace,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    duration_ms: Date.now() - started,
    exit_code: exitCode,
    child_exit_code: childOutcome.code,
    spawn_error: childOutcome.spawn_error ?? null,
    stdin_error: stdinError ? `Sol review prompt stdin failed: ${stdinError.message || stdinError}` : null,
    signal: childOutcome.signal,
    timed_out: childOutcome.timed_out,
    deadline_reached: childOutcome.deadline_reached,
    hard_timeout_reached: childOutcome.hard_timeout_reached,
    termination: childOutcome.termination,
    review_verdict: reviewVerdict,
    repair,
    workflow,
    workflow_artifact_authority: workflowArtifactAuthority,
    spawn_started: childOutcome.spawn_started === true,
    workflow_completion: workflow ? { state: 'pending' } : null,
    };
    let stored = null;
    if (resultPath) stored = await persistOutcome(resultPath, outcome, stdout, stderr, artifactAuthority);
    const workflowCompletion = stored ? await completeUnavailableWorkflowReview(workflow, stored.paths.result, outcome, workflowArtifactAuthority) : null;
    await persistWorkflowCompletion(stored, workflowCompletion, workflowArtifactAuthority);
    return { ...outcome, result_path: stored?.paths.result ?? null, workflow_completion: workflowCompletion?.completed === true ? workflowCompletion : outcome.workflow_completion, workflow_completion_error: workflowCompletion?.completed === false ? workflowCompletion.reason : null };
  } finally {
    if (cleanupEvidence) {
      try {
        const cleaned = await waitForExitWithin(Promise.resolve().then(() => evidencePackage?.cleanup?.()), CLEANUP_TIMEOUT_MS);
        if (cleaned === null) process.stderr.write(`[sol-review] evidence cleanup timed out after ${CLEANUP_TIMEOUT_MS}ms.\n`);
      } catch (error) {
        process.stderr.write(`[sol-review] evidence cleanup failed: ${error.message || error}\n`);
      }
    } else {
      process.stderr.write('[sol-review] evidence cleanup skipped because child process exit was not confirmed.\n');
    }
  }
}

export async function main() {
  try {
    const result = await runSolReview();
    const verdict = result.review_verdict?.valid === true ? 'valid' : 'unavailable';
    const artifact = typeof result.result_path === 'string' ? 'persisted' : 'not_persisted';
    process.stdout.write(`sol review: verdict=${verdict} exit_code=${result.exit_code} artifact=${artifact}\n`);
    process.exitCode = result.exit_code;
  } catch (error) {
    process.stderr.write(`sol review failed: ${error.message || error}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
