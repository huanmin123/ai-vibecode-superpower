import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const STATE_FILE = 'deny_read_acl_state.json';
const REPAIR_LOCK_WAIT_MS = 5_000;
const REPAIR_LOCK_RETRY_MS = 25;

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

function parseInvocation(argv, environment = process.env, platform = process.platform) {
  const args = [...argv];
  // Windows PATH resolution can prefer the Desktop package's inaccessible codex.exe.
  let codexBin = environment.CODEX_BIN || (platform === 'win32' ? 'codex.cmd' : 'codex');
  if (args[0] === '--codex-bin') {
    if (!args[1]) throw new Error('--codex-bin requires a command path');
    codexBin = args.splice(1, 1)[0]; args.shift();
  }
  if (args[0] === '--') args.shift();
  return { codexBin, promptArgs: args };
}

export async function runSolReview(argv = process.argv.slice(2), environment = process.env, platform = process.platform, spawnProcess = spawn) {
  const { codexBin, promptArgs } = parseInvocation(argv, environment, platform);
  const codexHome = resolveCodexHome(environment, platform);
  const repair = await repairInvalidDenyReadAclState(codexHome, platform);
  const childEnvironment = { ...environment, CODEX_HOME: codexHome };
  const childArgs = ['exec', '--model', 'gpt-5.6-sol', '--sandbox', 'read-only'];
  if (promptArgs.length) childArgs.push(promptArgs.join(' '));
  const usesWindowsCommandScript = platform === 'win32' && /\.(?:cmd|bat)$/i.test(codexBin);
  const spawnedArgs = usesWindowsCommandScript && promptArgs.length > 0
    ? [...childArgs.slice(0, -1), JSON.stringify(childArgs.at(-1))]
    : childArgs;
  const child = spawnProcess(codexBin, spawnedArgs, { env: childEnvironment, stdio: 'inherit', windowsHide: true, shell: usesWindowsCommandScript });
  const outcome = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  if (outcome.signal) return { exit_code: 1, signal: outcome.signal, codex_home: codexHome, repair };
  return { exit_code: outcome.code ?? 1, codex_home: codexHome, repair };
}

export async function main() {
  try {
    const result = await runSolReview();
    process.exitCode = result.exit_code;
  } catch (error) {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
