import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { promisify } from 'node:util';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const skill = path.join(repository, 'skills', 'orchestrate-model-workflow', 'SKILL.md');
const roles = path.join(repository, 'codex-global-config', 'agents', 'ai-vibecode-superpower');
const manifest = path.join(repository, 'codex-global-config', 'agents', 'ai-vibecode-superpower.sha256');
const posixInstaller = path.join(repository, 'install-codex.sh');
const run = promisify(execFile);

function normalizedHash(buffer) {
  return crypto.createHash('sha256').update(buffer.toString('utf8').replaceAll('\r\n', '\n')).digest('hex');
}

async function runResult(command, args, options) {
  try {
    const result = await run(command, args, { windowsHide: true, maxBuffer: 8 * 1024 * 1024, ...options });
    return { code: 0, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  } catch (error) {
    return { code: typeof error.code === 'number' ? error.code : 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '', error };
  }
}

async function findPosixShell() {
  const candidates = process.platform === 'win32'
    ? ['E:\\Git\\bin\\bash.exe', 'E:\\tools\\w64devkit-2.8.0\\w64devkit\\bin\\bash.exe', 'bash']
    : ['sh', 'bash'];
  for (const candidate of candidates) {
    const result = await runResult(candidate, ['-c', 'exit 0'], {});
    if (result.code === 0) return candidate;
  }
  return null;
}

test('standalone workflow skill has the five behavior stages and no obsolete protocol terms', async () => {
  const text = await readFile(skill, 'utf8');
  assert.match(text, /^---\nname: orchestrate-model-workflow\n/);
  for (const stage of ['Explore', 'Plan', 'Work', 'Critique', 'Promote']) assert.match(text, new RegExp(`\\b${stage}\\b`));
  for (const forbidden of [
    'workflow_controller', 'workflow_', 'claim_id', 'routing_schema_version',
    'coordinator_task_path', 'review_history_digest', 'controller', 'plugin',
    'MCP', 'SQLite', 'DAG', 'checkpoint', 'lease', 'heartbeat', 'cursor', 'envelope'
  ]) {
    assert.doesNotMatch(text, new RegExp(forbidden));
  }
  assert.match(text, /默认优先选择 Luna/);
  assert.match(text, /fallback 仅对本次派发生效，是临时且可重新评估的选择/);
  assert.match(text, /恢复后优先回到 Luna/);
  assert.match(text, /按功能、模块或文件形成非重叠区域/);
  assert.match(text, /只能修改事先分配的最小范围/);
  assert.match(text, /仅在存在独立边界时并发/);
  assert.match(text, /边界清晰的工作保持并行/);
  assert.doesNotMatch(text, /路径锁|并行写入安全|所有.*串行/);
  for (const role of [
    'avsp_luna_high', 'avsp_luna_xhigh', 'avsp_luna_high_executor', 'avsp_luna_xhigh_executor',
    'avsp_terra_high', 'avsp_terra_xhigh', 'avsp_terra_xhigh_readonly',
    'avsp_terra_low_readonly', 'avsp_terra_medium_readonly',
    'avsp_sol_high', 'avsp_sol_xhigh', 'avsp_sol_max'
  ]) assert.match(text, new RegExp(role));
});

test('all twelve managed roles remain hash-addressed with model routing fields', async () => {
  const lines = (await readFile(manifest, 'utf8')).trim().split(/\r?\n/);
  assert.equal(lines.length, 12);
  const entries = new Map(lines.map((line) => {
    const match = line.trim().match(/^([0-9a-f]{64})\s+([^\s]+)$/);
    assert.ok(match, `invalid manifest line: ${line}`);
    return [match[1], match[2]];
  }));
  const files = (await readdir(roles)).filter((name) => name.endsWith('.toml')).sort();
  assert.equal(files.length, 12);
  for (const file of files) {
    const source = await readFile(path.join(roles, file));
    assert.ok([...entries].some(([hash, name]) => name === file && hash === normalizedHash(source)));
    const text = source.toString('utf8');
    for (const key of ['name', 'model', 'model_reasoning_effort', 'sandbox_mode']) assert.match(text, new RegExp(`^${key}\\s*=`, 'm'));
    assert.doesNotMatch(text, /workflow_controller|workflow_|claim_id|audit-context|review_history_digest/);
  }
});

test('PowerShell installer has no compatibility or legacy-removal surface', async () => {
  const text = await readFile(path.join(repository, 'install-codex.ps1'), 'utf8');
  assert.doesNotMatch(text, /Get-LegacyPluginState|Remove-LegacyPlugins|workflow-controller|agnets-workflow|plugin remove/);
  assert.match(text, /Expand-Placeholders/);
});

test('POSIX installer has no compatibility or legacy-removal surface', async () => {
  const text = await readFile(posixInstaller, 'utf8');
  assert.doesNotMatch(text, /get_legacy_plugin_state|remove_legacy_plugins|workflow-controller|agnets-workflow|plugin remove/);
  assert.match(text, /source_model_provider_settings=/);
});

test('PowerShell installer deploys the standalone skill into an isolated nested home', { skip: process.platform !== 'win32' }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-powershell-contract-'));
  const codexHome = path.join(root, 'missing', 'nested', '.codex');
  try {
    await mkdir(path.dirname(codexHome), { recursive: true });
    await mkdir(codexHome, { recursive: true });
    await writeFile(path.join(codexHome, 'config.toml'), 'keep_me = "untouched"\n"custom.setting" = "root quoted"\nmodel = "old"\n\n[desktop.open-in-target-preferences.perPath]\n"/Users/example/project" = "cursor"\n"part=key" = "equals"\n\n[tui.model_availability_nux]\n"gpt-5.5" = true\n\n[model_providers.local]\nname = "local"\nrequest_max_retries = 1\nstream_max_retries = 2\nstream_idle_timeout_ms = 3\nwebsocket_connect_timeout_ms = 4\n\n[agents]\nmax_threads = 1\nmax_depth = 1\n\n[features]\ngoals = false\n');
    const result = await runResult('pwsh.exe', ['-NoLogo', '-NoProfile', '-File', path.join(repository, 'install-codex.ps1')], {
      env: { ...process.env, CODEX_HOME: codexHome },
    });
    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
    const installed = await readFile(path.join(codexHome, 'skills', 'orchestrate-model-workflow', 'SKILL.md'), 'utf8');
    assert.match(installed, /^---\r?\nname: orchestrate-model-workflow\r?\n/);
    const agents = await readFile(path.join(codexHome, 'AGENTS.md'), 'utf8');
    assert.doesNotMatch(agents, /<CODEX_HOME>|\$CODEX_HOME/);
    assert.match(agents, /codex-powershell-contract-/i);
    const config = await readFile(path.join(codexHome, 'config.toml'), 'utf8');
    assert.match(config, /keep_me = "untouched"/);
    assert.match(config, /"custom\.setting" = "root quoted"/);
    assert.match(config, /"\/Users\/example\/project" = "cursor"/);
    assert.match(config, /"part=key" = "equals"/);
    assert.match(config, /"gpt-5\.5" = true/);
    assert.match(config, /\[model_providers\.local\][\s\S]*request_max_retries = 120[\s\S]*stream_max_retries = 120[\s\S]*stream_idle_timeout_ms = 300000[\s\S]*websocket_connect_timeout_ms = 15000/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('PowerShell installer rejects unsafe non-bare TOML keys', { skip: process.platform !== 'win32' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-powershell-unsafe-toml-'));
  const codexHome = path.join(root, 'nested', '.codex');
  try {
    await mkdir(codexHome, { recursive: true });
    await writeFile(path.join(codexHome, 'config.toml'), '[agents]\n"max_threads" = 1\n');
    const result = await runResult('pwsh.exe', ['-NoLogo', '-NoProfile', '-File', path.join(repository, 'install-codex.ps1')], {
      env: { ...process.env, CODEX_HOME: codexHome },
    });
    assert.notEqual(result.code, 0, result.stdout);
    assert.match(result.stdout + '\n' + result.stderr, /Quoted TOML key aliases a managed key/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('PowerShell installer rejects non-scalar Unicode escapes in quoted TOML keys', { skip: process.platform !== 'win32' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-powershell-invalid-unicode-'));
  const codexHome = path.join(root, 'nested', '.codex');
  try {
    await mkdir(codexHome, { recursive: true });
    await writeFile(path.join(codexHome, 'config.toml'), '[custom]\n"\\uD800" = true\n');
    const result = await runResult('pwsh.exe', ['-NoLogo', '-NoProfile', '-File', path.join(repository, 'install-codex.ps1')], {
      env: { ...process.env, CODEX_HOME: codexHome },
    });
    assert.notEqual(result.code, 0, result.stdout);
    assert.match(result.stdout + '\n' + result.stderr, /Unsupported TOML key syntax/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('POSIX installer deploys a fresh standalone home without legacy prerequisites', async (t) => {
  const shell = await findPosixShell();
  if (!shell) return t.skip('POSIX shell is unavailable');
  const root = await mkdtemp(path.join(repository, '.codex-posix-contract-'));
  const codexHome = path.join(root, 'missing', 'nested', '.codex');
  const relativeHome = path.relative(repository, codexHome).split(path.sep).join('/');
  try {
    const result = await runResult(shell, ['install-codex.sh'], {
      cwd: repository,
      env: { ...process.env, CODEX_HOME: relativeHome },
    });
    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
    const installed = await readFile(path.join(codexHome, 'skills', 'orchestrate-model-workflow', 'SKILL.md'), 'utf8');
    assert.match(installed, /^---\nname: orchestrate-model-workflow\n/);
    const agents = await readFile(path.join(codexHome, 'AGENTS.md'), 'utf8');
    assert.doesNotMatch(agents, /<CODEX_HOME>|\$CODEX_HOME/);
    const config = await readFile(path.join(codexHome, 'config.toml'), 'utf8');
    assert.match(config, /^model = "gpt-5\.6-terra"/m);
    assert.match(config, /\[features\]\ngoals = true/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('POSIX installer preserves safe quoted TOML keys', async (t) => {
  const shell = await findPosixShell();
  if (!shell) return t.skip('POSIX shell is unavailable');
  const root = await mkdtemp(path.join(repository, '.codex-posix-quoted-contract-'));
  const codexHome = path.join(root, 'nested', '.codex');
  try {
    await mkdir(codexHome, { recursive: true });
    await writeFile(path.join(codexHome, 'config.toml'), 'keep_me = "untouched"\n"custom.setting" = "root quoted"\nmodel = "old"\n\n[desktop.open-in-target-preferences.perPath]\n"/Users/example/project" = "cursor"\n"part=key" = "equals"\n\n[tui.model_availability_nux]\n"gpt-5.5" = true\n\n[model_providers.local]\nname = "local"\nrequest_max_retries = 1\nstream_max_retries = 2\nstream_idle_timeout_ms = 3\nwebsocket_connect_timeout_ms = 4\n\n[agents]\nmax_threads = 1\nmax_depth = 1\n\n[features]\ngoals = false\n');
    const result = await runResult(shell, ['install-codex.sh'], {
      cwd: repository,
      env: { ...process.env, CODEX_HOME: codexHome },
    });
    assert.equal(result.code, 0, result.stdout + '\n' + result.stderr);
    const config = await readFile(path.join(codexHome, 'config.toml'), 'utf8');
    assert.match(config, /"custom\.setting" = "root quoted"/);
    assert.match(config, /"\/Users\/example\/project" = "cursor"/);
    assert.match(config, /"part=key" = "equals"/);
    assert.match(config, /"gpt-5\.5" = true/);
    assert.match(config, /^model = "gpt-5\.6-terra"/m);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('POSIX installer rejects unsafe non-bare TOML keys', async (t) => {
  const shell = await findPosixShell();
  if (!shell) return t.skip('POSIX shell is unavailable');
  const root = await mkdtemp(path.join(repository, '.codex-posix-unsafe-toml-'));
  const codexHome = path.join(root, 'nested', '.codex');
  try {
    await mkdir(codexHome, { recursive: true });
    await writeFile(path.join(codexHome, 'config.toml'), '[agents]\n"max_threads" = 1\n');
    const result = await runResult(shell, ['install-codex.sh'], {
      cwd: repository,
      env: { ...process.env, CODEX_HOME: codexHome },
    });
    assert.notEqual(result.code, 0, result.stdout);
    assert.match(result.stdout + '\n' + result.stderr, /unsupported TOML syntax for safe merge: quoted key aliases a managed key/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('POSIX installer rejects non-scalar Unicode escapes in quoted TOML keys', async (t) => {
  const shell = await findPosixShell();
  if (!shell) return t.skip('POSIX shell is unavailable');
  const root = await mkdtemp(path.join(repository, '.codex-posix-invalid-unicode-'));
  const codexHome = path.join(root, 'nested', '.codex');
  try {
    await mkdir(codexHome, { recursive: true });
    await writeFile(path.join(codexHome, 'config.toml'), '[custom]\n"\\uD800" = true\n');
    const result = await runResult(shell, ['install-codex.sh'], {
      cwd: repository,
      env: { ...process.env, CODEX_HOME: codexHome },
    });
    assert.notEqual(result.code, 0, result.stdout);
    assert.match(result.stdout + '\n' + result.stderr, /unsupported TOML syntax for safe merge: unsupported key syntax/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('installer sources statically enforce target boundaries and transactional state', async () => {
  const text = await readFile(posixInstaller, 'utf8');
  assert.ok(text.indexOf('mkdir -p "$(dirname -- "$raw_home")"') < text.indexOf('codex_home=$(CDPATH= cd --'));
  assert.match(text, /script_dir=\$\(CDPATH= cd --/);
  assert.match(text, /source_model_provider_settings=/);
  assert.match(text, /sed "s\|<CODEX_HOME>\|\$escaped_home\|g;/);
  assert.match(text, /mark_state backed-up/);
  assert.match(text, /mark_state install-started/);
  assert.match(text, /assert_directory_container "\$codex_home\/backups"/);
});
