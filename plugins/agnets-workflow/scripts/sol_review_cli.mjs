import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { dispatch } from './workflow_controller.mjs';

const STATE_FILE = 'deny_read_acl_state.json';
const REPAIR_LOCK_WAIT_MS = 5_000;
const REPAIR_LOCK_RETRY_MS = 25;
export const DEFAULT_SOL_REVIEW_TIMEOUT_SEC = 30 * 60;
export const MAX_SOL_REVIEW_TIMEOUT_SEC = 2 * 60 * 60;
export const BOUNDED_EXTERNAL_REVIEW_PROFILE = 'bounded-external';
const BOUNDED_EXTERNAL_REVIEW_INSTRUCTIONS = [
  'Review profile: bounded-external.',
  'Use the caller-provided fixed evidence package as the primary source.',
  'Inspect only the listed changed files and necessary adjacent call chains.',
  'Do not enumerate the entire workspace to search for scope drift.',
  'Do not inspect .git, .codex, node_modules, .venv, .yarn, or .yarn-cache*.',
  'If evidence is insufficient, stop and emit the required final JSON with verdict "unavailable" or "fail"; do not guess.',
].join('\n');
const TERMINATION_GRACE_MS = 15_000;
const MAX_CAPTURE_BYTES = 256 * 1024;
const WORKFLOW_RESULT_DIRECTORY = '.workflow-review-results';

export function resolveCodexHome(environment = process.env, platform = process.platform) {
  const configured = environment.CODEX_HOME?.trim();
  if (configured) return path.resolve(configured);
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

async function writeJsonAtomically(filePath, value) {
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: 'utf8', flag: 'wx' });
    await fs.rename(temporary, filePath);
  } catch (error) {
    await fs.unlink(temporary).catch(cleanupError => { if (cleanupError.code !== 'ENOENT') throw cleanupError; });
    throw error;
  }
}

async function acquireRepairLock(lockPath, statePath) {
  const deadline = Date.now() + REPAIR_LOCK_WAIT_MS;
  while (true) {
    try {
      const handle = await fs.open(lockPath, 'wx');
      await handle.writeFile(`pid=${process.pid} hostname=${os.hostname()} created=${new Date().toISOString()}\n`);
      return handle;
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

  const lockPath = `${statePath}.repair`;
  const lock = await acquireRepairLock(lockPath, statePath);
  if (!lock) return { repaired: false, reason: 'repaired_by_another_process', state_path: statePath };
  try {
    const current = await readAclState(statePath);
    if (current.kind !== 'invalid') return { repaired: false, reason: current.kind, state_path: statePath };
    const backupPath = `${statePath}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`;
    await fs.rename(statePath, backupPath);
    await writeJsonAtomically(statePath, { principals: {} });
    return { repaired: true, state_path: statePath, backup_path: backupPath };
  } finally {
    await lock.close();
    await fs.unlink(lockPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
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

function parseInvocation(argv, environment = process.env, platform = process.platform) {
  const args = [...argv];
  // Windows PATH resolution can prefer the Desktop package's inaccessible codex.exe.
  let codexBin = environment.CODEX_BIN || (platform === 'win32' ? 'codex.cmd' : 'codex');
  let timeoutSec = DEFAULT_SOL_REVIEW_TIMEOUT_SEC;
  let hardTimeoutSec = null;
  let reviewProfile = null;
  let evidenceDirectory = null;
  let resultPath = null;
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
    if (option === '--workflow-state-dir') { workflow.state_dir = path.resolve(requiredOption(args, index, option)); index += 2; continue; }
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
  if (workflowConfigured) {
    const resultRoot = path.resolve(workflow.state_dir, WORKFLOW_RESULT_DIRECTORY);
    const expectedResultPath = path.join(resultRoot, workflow.task_id, workflow.claim_id, 'outcome.json');
    if (!resultPath) resultPath = expectedResultPath;
    if (path.resolve(resultPath) !== path.resolve(expectedResultPath)) throw new Error(`--result must be exactly ${expectedResultPath} when workflow binding is used`);
  }
  return { codexBin, timeoutSec, hardTimeoutSec, reviewProfile, evidenceDirectory, resultPath, workflow: workflowConfigured ? workflow : null, promptArgs: args.slice(index) };
}

function reviewPrompt(promptArgs, reviewProfile) {
  const callerPrompt = promptArgs.join(' ');
  if (reviewProfile === null) return callerPrompt;
  return callerPrompt ? `${BOUNDED_EXTERNAL_REVIEW_INSTRUCTIONS}\n\n${callerPrompt}` : BOUNDED_EXTERNAL_REVIEW_INSTRUCTIONS;
}

async function resolveEvidenceDirectory(reviewProfile, evidenceDirectory) {
  if (reviewProfile !== BOUNDED_EXTERNAL_REVIEW_PROFILE) return null;
  try {
    const details = await fs.stat(evidenceDirectory);
    if (!details.isDirectory()) throw new Error('--evidence-dir must name an existing directory');
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error('--evidence-dir must name an existing directory');
    throw error;
  }
  return evidenceDirectory;
}

async function writeAtomically(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await fs.open(temporary, 'wx');
    await handle.writeFile(value);
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
    await fs.unlink(temporary).catch(cleanupError => { if (cleanupError.code !== 'ENOENT') throw cleanupError; });
    throw error;
  } finally {
    await handle?.close();
  }
}

function captureStream(stream, destination) {
  const capture = { chunks: [], bytes: 0, truncated: false, drained: false, drain_timed_out: false };
  if (!stream) { capture.done = Promise.resolve(); return capture; }
  let settle;
  const done = new Promise(resolve => { settle = resolve; });
  const settleOnce = () => {
    if (!settle) return;
    const resolve = settle; settle = null; resolve();
  };
  stream.once('end', settleOnce);
  stream.once('close', settleOnce);
  stream.once('error', settleOnce);
  stream.on('data', chunk => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    destination.write(bytes);
    if (capture.bytes >= MAX_CAPTURE_BYTES) { capture.truncated = true; return; }
    const available = MAX_CAPTURE_BYTES - capture.bytes;
    capture.chunks.push(bytes.subarray(0, available)); capture.bytes += Math.min(bytes.byteLength, available);
    if (bytes.byteLength > available) capture.truncated = true;
  });
  capture.done = done;
  return capture;
}

function waitForCaptureDrain(capture, milliseconds = 250) {
  return new Promise(resolve => {
    const timer = setTimeout(() => { capture.drain_timed_out = true; resolve(false); }, milliseconds);
    capture.done.then(() => { clearTimeout(timer); capture.drained = true; resolve(true); }, () => { clearTimeout(timer); capture.drained = true; resolve(true); });
  });
}

function waitForExit(child) {
  return new Promise(resolve => {
    child.once('error', error => resolve({ code: null, signal: null, spawn_error: error.message }));
    child.once('exit', (code, signal) => resolve({ code, signal }));
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
    const terminator = spawnProcess('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, shell: false, stdio: 'ignore' });
    terminator.once('error', reject);
    terminator.once('exit', code => code === 0 ? resolve() : reject(new Error(`taskkill exited with ${code}`)));
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
    try { termination = await terminateProcess(child, platform, spawnProcess); }
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

async function persistOutcome(resultPath, outcome, stdout, stderr) {
  const paths = artifactPaths(resultPath);
  await writeAtomically(paths.stdout, Buffer.concat(stdout.chunks));
  await writeAtomically(paths.stderr, Buffer.concat(stderr.chunks));
  const result = {
    version: 1,
    ...outcome,
    stdout: { path: paths.stdout, captured_bytes: stdout.bytes, truncated: stdout.truncated || stdout.drain_timed_out, drain_timed_out: stdout.drain_timed_out },
    stderr: { path: paths.stderr, captured_bytes: stderr.bytes, truncated: stderr.truncated || stderr.drain_timed_out, drain_timed_out: stderr.drain_timed_out },
  };
  await writeAtomically(paths.result, `${JSON.stringify(result, null, 2)}\n`);
  return { result, paths };
}

async function completeUnavailableWorkflowReview(workflow, resultPath, outcome) {
  if (!workflow || (!outcome.timed_out && outcome.exit_code === 0 && !outcome.signal)) return null;
  if (outcome.timed_out && !outcome.termination?.confirmed) return { completed: false, reason: 'timed_out_process_exit_not_confirmed' };
  try {
    const [completion] = await dispatch('complete', {
      state_dir: workflow.state_dir,
      task_id: workflow.task_id,
      node_id: workflow.node_id,
      claim_id: workflow.claim_id,
      status: 'unavailable',
      result: resultPath,
    });
    return { completed: true, completion };
  } catch (error) {
    return { completed: false, reason: `workflow completion failed: ${error.message}` };
  }
}

export async function runSolReview(argv = process.argv.slice(2), environment = process.env, platform = process.platform, spawnProcess = spawn, terminateProcess = terminateSolReviewProcess) {
  const { codexBin, timeoutSec, hardTimeoutSec, reviewProfile, evidenceDirectory, resultPath, workflow, promptArgs } = parseInvocation(argv, environment, platform);
  const startedAt = new Date().toISOString(); const started = Date.now();
  const softDeadline = started + timeoutSec * 1000;
  const hardDeadline = hardTimeoutSec === null ? null : started + hardTimeoutSec * 1000;
  const codexHome = resolveCodexHome(environment, platform);
  const repair = await repairInvalidDenyReadAclState(codexHome, platform);
  const childEnvironment = { ...environment, CODEX_HOME: codexHome };
  const prompt = reviewPrompt(promptArgs, reviewProfile);
  const reviewWorkspace = await resolveEvidenceDirectory(reviewProfile, evidenceDirectory);
  const childArgs = ['exec', '--model', 'gpt-5.6-sol', '--sandbox', 'read-only'];
  if (reviewWorkspace) childArgs.push('-C', reviewWorkspace, '--skip-git-repo-check');
  if (prompt) childArgs.push('--', prompt);
  const usesWindowsCommandScript = platform === 'win32' && /\.(?:cmd|bat)$/i.test(codexBin);
  let spawnCommand = codexBin;
  let spawnedArgs = childArgs;
  let spawnOptions = { env: childEnvironment, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false, detached: platform !== 'win32', ...(reviewWorkspace ? { cwd: reviewWorkspace } : {}) };
  if (usesWindowsCommandScript) {
    // Keep untrusted prompt text in an environment value; it must never become PowerShell/cmd source.
    childEnvironment.CODEX_REVIEW_BIN = codexBin;
    childEnvironment.CODEX_REVIEW_PROMPT = prompt;
    if (reviewWorkspace) childEnvironment.CODEX_REVIEW_WORKSPACE = reviewWorkspace;
    spawnCommand = 'powershell.exe';
    spawnedArgs = ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', "$prompt = [Environment]::GetEnvironmentVariable('CODEX_REVIEW_PROMPT'); $workspace = [Environment]::GetEnvironmentVariable('CODEX_REVIEW_WORKSPACE'); $arguments = @('exec','--model','gpt-5.6-sol','--sandbox','read-only'); if ($workspace) { $arguments += @('-C', $workspace, '--skip-git-repo-check') }; if ($prompt) { $arguments += '--'; $arguments += $prompt }; & $env:CODEX_REVIEW_BIN @arguments; exit $LASTEXITCODE"];
    spawnOptions = { ...spawnOptions, detached: false };
  }
  let child = null;
  let childOutcome;
  let stdout = captureStream(null, process.stdout);
  let stderr = captureStream(null, process.stderr);
  child = spawnProcess(spawnCommand, spawnedArgs, spawnOptions);
  stdout = captureStream(child.stdout, process.stdout);
  stderr = captureStream(child.stderr, process.stderr);
  childOutcome = await waitForReviewOutcome(child, Math.max(0, softDeadline - Date.now()), hardDeadline === null ? null : Math.max(0, hardDeadline - Date.now()), platform, terminateProcess, spawnProcess);
  await Promise.all([waitForCaptureDrain(stdout), waitForCaptureDrain(stderr)]);
  const exitCode = childOutcome.timed_out ? 124 : childOutcome.signal ? 1 : childOutcome.code ?? 1;
  const outcome = {
    codex_home: codexHome,
    codex_bin: codexBin,
    child_pid: Number.isSafeInteger(child?.pid) ? child.pid : null,
    timeout_sec: timeoutSec,
    hard_timeout_sec: hardTimeoutSec,
    timeout_scope: hardTimeoutSec === null ? 'soft_deadline_to_child_exit' : 'soft_deadline_with_explicit_hard_cap',
    review_profile: reviewProfile,
    evidence_directory: reviewWorkspace,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    duration_ms: Date.now() - started,
    exit_code: exitCode,
    child_exit_code: childOutcome.code,
    spawn_error: childOutcome.spawn_error ?? null,
    signal: childOutcome.signal,
    timed_out: childOutcome.timed_out,
    deadline_reached: childOutcome.deadline_reached,
    hard_timeout_reached: childOutcome.hard_timeout_reached,
    termination: childOutcome.termination,
    repair,
    workflow,
  };
  let stored = null;
  if (resultPath) stored = await persistOutcome(resultPath, outcome, stdout, stderr);
  const workflowCompletion = stored ? await completeUnavailableWorkflowReview(workflow, stored.paths.result, outcome) : null;
  return { ...outcome, result_path: stored?.paths.result ?? null, workflow_completion: workflowCompletion };
}

export async function main() {
  try {
    const result = await runSolReview();
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = result.exit_code;
  } catch (error) {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
