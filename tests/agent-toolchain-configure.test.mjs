import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { promisify } from 'node:util';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const powerShellDriver = path.join(repository, 'shared', 'skills', 'agent-toolchain', 'scripts', 'agent-toolchain.ps1');
const posixDriver = path.join(repository, 'shared', 'skills', 'agent-toolchain', 'scripts', 'agent-toolchain.sh');
const run = promisify(execFile);

async function runResult(command, args, options) {
  try {
    const result = await run(command, args, { windowsHide: true, maxBuffer: 8 * 1024 * 1024, ...options });
    return { code: 0, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  } catch (error) {
    return { code: typeof error.code === 'number' ? error.code : 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '', error };
  }
}

function assertCodegraphJson(config) {
  const parsed = JSON.parse(config);
  const server = parsed.mcp?.servers?.codegraph;
  assert.ok(server, 'mcp.servers.codegraph missing');
  assert.equal(server.type, 'stdio');
  assert.equal(server.command, 'codegraph');
  assert.deepEqual(server.args, ['serve', '--mcp']);
  assert.equal(server.env?.CODEGRAPH_TELEMETRY, '0');
  assert.equal(server.env?.CODEGRAPH_NO_UPDATE_CHECK, '1');
  assert.equal(server.env?.DO_NOT_TRACK, '1');
}

test('configure wires both clients and stays idempotent (PowerShell)', { skip: process.platform !== 'win32' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-toolchain-configure-'));
  const project = path.join(root, 'target-project');
  try {
    await mkdir(project, { recursive: true });
    let result = await runResult('pwsh.exe', ['-NoLogo', '-NoProfile', '-File', powerShellDriver, 'configure', '--project', project, '--client', 'both']);
    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
    const codexConfig = await readFile(path.join(project, '.codex', 'config.toml'), 'utf8');
    assert.match(codexConfig, /^\[mcp_servers\.codegraph\]$/m);
    assert.match(codexConfig, /^command = "codegraph"$/m);
    const zcodeConfig = await readFile(path.join(project, '.zcode', 'config.json'), 'utf8');
    assertCodegraphJson(zcodeConfig);
    assert.match(await readFile(path.join(project, 'AGENTS.md'), 'utf8'), /^## CodeGraph 与 RTK$/m);
    assert.match(await readFile(path.join(project, '.gitignore'), 'utf8'), /^\/\.codegraph\/$/m);

    result = await runResult('pwsh.exe', ['-NoLogo', '-NoProfile', '-File', powerShellDriver, 'configure', '--project', project]);
    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(await readFile(path.join(project, '.zcode', 'config.json'), 'utf8'), zcodeConfig, 'idempotent run rewrote .zcode/config.json');
    assert.equal(await readFile(path.join(project, '.codex', 'config.toml'), 'utf8'), codexConfig, 'idempotent run rewrote .codex/config.toml');

    const tampered = JSON.parse(zcodeConfig);
    tampered.mcp.servers.codegraph.command = 'other';
    await writeFile(path.join(project, '.zcode', 'config.json'), JSON.stringify(tampered, null, 2));
    result = await runResult('pwsh.exe', ['-NoLogo', '-NoProfile', '-File', powerShellDriver, 'configure', '--project', project]);
    assert.notEqual(result.code, 0, result.stdout);
    assert.match(result.stdout + '\n' + result.stderr, /\.zcode\/config\.json/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('configure merges into an existing zcode config without dropping keys (PowerShell)', { skip: process.platform !== 'win32' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-toolchain-merge-'));
  const project = path.join(root, 'target-project');
  try {
    await mkdir(path.join(project, '.zcode'), { recursive: true });
    await writeFile(path.join(project, '.zcode', 'config.json'), JSON.stringify({ mcp: { servers: { other: { command: 'foo' } } }, custom: { keep: true } }));
    const result = await runResult('pwsh.exe', ['-NoLogo', '-NoProfile', '-File', powerShellDriver, 'configure', '--project', project]);
    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
    const parsed = JSON.parse(await readFile(path.join(project, '.zcode', 'config.json'), 'utf8'));
    assertCodegraphJson(JSON.stringify(parsed));
    assert.equal(parsed.mcp.servers.other.command, 'foo');
    assert.deepEqual(parsed.custom, { keep: true });
    const entries = await readdir(path.join(project, '.zcode'));
    assert.ok(entries.includes('config.json'));
    assert.equal(entries.includes('config.toml'), false, '.zcode must not receive a codex config');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('configure refuses to guess when no client directory exists (PowerShell)', { skip: process.platform !== 'win32' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-toolchain-noguess-'));
  const project = path.join(root, 'target-project');
  try {
    await mkdir(project, { recursive: true });
    const result = await runResult('pwsh.exe', ['-NoLogo', '-NoProfile', '-File', powerShellDriver, 'configure', '--project', project]);
    assert.notEqual(result.code, 0, result.stdout);
    assert.match(result.stdout + '\n' + result.stderr, /--client codex\|zcode\|both/);
    const entries = await readdir(project);
    assert.equal(entries.length, 0, 'no files should be written on refusal');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('posix driver stays syntactically valid and keeps the client wiring branches', async () => {
  const syntax = await runResult('sh', ['-n', posixDriver], { cwd: repository });
  assert.equal(syntax.code, 0, syntax.stderr);
  const text = await readFile(posixDriver, 'utf8');
  assert.match(text, /--client\) \[ "\$#" -ge 2 \] \|\| die "--client 缺少取值"/);
  assert.match(text, /wire_codex=1; wire_zcode=1/);
  assert.match(text, /mcp\.servers/);
  assert.match(text, /python3 - "\$zcode_config"/);
  assert.match(text, /\[ -t 0 \]/);
  assert.match(text, /Enter number or name \(q to quit\)/);
});

test('powerShell driver keeps the interactive client prompt behind a tty guard', async () => {
  const text = await readFile(powerShellDriver, 'utf8');
  assert.match(text, /\[Console\]::IsInputRedirected/);
  assert.match(text, /Enter number or name \(q to quit\)/);
  assert.match(text, /'  3\) Both'/);
  assert.match(text, /Cancelled: no client selected; nothing was written\./);
});

test('configure wires both clients (POSIX)', { skip: process.platform === 'win32' }, async (t) => {
  const syntax = await runResult('sh', ['-c', 'command -v python3'], {});
  if (syntax.code !== 0) return t.skip('python3 is unavailable');
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-toolchain-posix-'));
  const project = path.join(root, 'target-project');
  try {
    await mkdir(project, { recursive: true });
    const result = await runResult('sh', [posixDriver, 'configure', '--project', project, '--client', 'both'], { cwd: repository });
    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(await readFile(path.join(project, '.codex', 'config.toml'), 'utf8'), /^\[mcp_servers\.codegraph\]$/m);
    assertCodegraphJson(await readFile(path.join(project, '.zcode', 'config.json'), 'utf8'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
