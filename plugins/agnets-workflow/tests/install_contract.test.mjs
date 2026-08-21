import assert from 'node:assert/strict';
import { execFile as execFileCallback, spawnSync } from 'node:child_process';
import { cp, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(testDirectory, '../../..');
const powerShellInstaller = path.join(repository, 'install-codex.ps1');
const shellInstaller = path.join(repository, 'install-codex.sh');
const marketplace = 'ai-vibecode-superpower-local';
const plugin = 'agnets-workflow';
const retiredPlugin = 'workflow-controller@ai-vibecode-superpower-local';

function findPowerShell() {
  if (process.platform !== 'win32') return null;
  const candidates = [];
  if (process.env.INSTALL_CONTRACT_TEST_PWSH) candidates.push(process.env.INSTALL_CONTRACT_TEST_PWSH);
  const where = spawnSync('where.exe', ['pwsh.exe'], { encoding: 'utf8', windowsHide: true });
  if (where.status === 0) candidates.push(...where.stdout.split(/\r?\n/).filter(Boolean));
  for (const candidate of new Set(candidates)) {
    const probe = spawnSync(candidate, ['-NoLogo', '-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'], { windowsHide: true });
    if (probe.status === 0) return candidate;
  }
  return null;
}

const powershell = findPowerShell();

async function run(executable, args, options = {}) {
  return execFile(executable, args, { encoding: 'utf8', windowsHide: true, ...options });
}

async function writeFakeCodex(binDirectory) {
  const driver = String.raw`
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';

const home = process.env.CODEX_HOME;
const statePath = process.env.FAKE_CODEX_STATE;
const args = process.argv.slice(2);
if (!home || !statePath) throw new Error('missing fake Codex test environment');

const state = existsSync(statePath)
  ? JSON.parse(await readFile(statePath, 'utf8'))
  : { commands: [], marketplaceRegistered: false, pluginEnabled: false, marketplaceRoot: null };
state.commands.push(args.join(' '));

async function save() {
  await writeFile(statePath, JSON.stringify(state), 'utf8');
}

async function appendConfig(text) {
  const configPath = path.join(home, 'config.toml');
  const current = existsSync(configPath) ? await readFile(configPath, 'utf8') : '';
  if (!current.includes(text.trim())) await writeFile(configPath, current.trimEnd() + '\n' + text, 'utf8');
}

if (args[0] !== 'plugin') throw new Error('unsupported fake Codex command: ' + args.join(' '));
if (args[1] === 'marketplace' && args[2] === 'add') {
  state.marketplaceRoot = args[3];
  state.marketplaceRegistered = true;
  await appendConfig('[plugin_marketplaces."ai-vibecode-superpower-local"]\npath = "managed"\n');
  await save();
  process.exit(0);
}
if (args[1] === 'marketplace' && args[2] === 'list') {
  await save();
  if (!state.marketplaceRegistered) process.exit(1);
  process.stdout.write('ai-vibecode-superpower-local managed\n');
  process.exit(0);
}
if (args[1] === 'add') {
  if (!state.marketplaceRoot) throw new Error('plugin added before marketplace registration');
  const source = path.join(state.marketplaceRoot, 'plugins', 'agnets-workflow');
  const manifest = JSON.parse(await readFile(path.join(source, '.codex-plugin', 'plugin.json'), 'utf8'));
  const cache = path.join(home, 'plugins', 'cache', 'ai-vibecode-superpower-local', 'agnets-workflow', manifest.version);
  await mkdir(path.dirname(cache), { recursive: true });
  await cp(source, cache, { recursive: true, force: true, verbatimSymlinks: true });
  const descriptorPath = path.join(cache, '.mcp.json');
  // Codex plugin add copies the source descriptor; the production installer
  // owns placeholder expansion and UTF-8 normalization afterwards.
  state.cacheEntries = (await readdir(cache, { recursive: true })).sort();
  state.cacheDescriptorHash = createHash('sha256').update(await readFile(descriptorPath)).digest('hex');
  state.sourceDescriptorHash = createHash('sha256').update(await readFile(path.join(source, '.mcp.json'))).digest('hex');
  // Model plugin add replacing config from its snapshot is the regression this test models.
  await writeFile(path.join(home, 'config.toml'), '[plugins."agnets-workflow@ai-vibecode-superpower-local"]\nenabled = true\n', 'utf8');
  state.marketplaceRegistered = false;
  state.pluginEnabled = true;
  state.version = manifest.version;
  await save();
  process.exit(0);
}
if (args[1] === 'list') {
  await save();
  if (state.pluginEnabled) process.stdout.write('agnets-workflow@ai-vibecode-superpower-local installed, enabled ' + state.version + ' managed\n');
  process.exit(0);
}
if (args[1] === 'remove' && [
  'workflow-controller@ai-vibecode-superpower-local',
  'agnets-workflow@ai-vibecode-superpower-local',
].includes(args[2])) {
  const configPath = path.join(home, 'config.toml');
  if (existsSync(configPath)) {
    const config = await readFile(configPath, 'utf8');
    const header = '[plugins."' + args[2] + '"]';
    const start = config.indexOf(header);
    const end = start < 0 ? -1 : config.indexOf('\n[', start + header.length);
    if (start >= 0) await writeFile(configPath, config.slice(0, start) + (end < 0 ? '' : config.slice(end + 1)), 'utf8');
  }
  if (args[2] === 'agnets-workflow@ai-vibecode-superpower-local') state.pluginEnabled = false;
  await save();
  process.exit(0);
}
throw new Error('unsupported fake Codex command: ' + args.join(' '));
`;
  await writeFile(path.join(binDirectory, 'codex.mjs'), driver, 'utf8');
  await writeFile(path.join(binDirectory, 'codex.cmd'), '@echo off\r\nnode.exe "%~dp0codex.mjs" %*\r\n', 'utf8');
}

test('PowerShell installer preserves marketplace and plugin state after plugin add', {
  skip: process.platform !== 'win32' ? 'PowerShell installer contract runs on Windows only.' : !powershell && 'No PowerShell 7 found; set INSTALL_CONTRACT_TEST_PWSH.',
}, async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'codex-install-contract-'));
  try {
    const codexHome = path.join(temporaryRoot, 'home');
    const binDirectory = path.join(temporaryRoot, 'bin');
    const statePath = path.join(temporaryRoot, 'fake-codex-state.json');
    await mkdir(codexHome, { recursive: true });
    await mkdir(binDirectory);
    await writeFile(path.join(codexHome, 'config.toml'), `[plugins."${retiredPlugin}"]\nenabled = true\n`, 'utf8');
    await writeFakeCodex(binDirectory);

    // The production installer must reject a live Desktop. This isolated test
    // supplies the already-closed process state without touching the real app.
    const environment = {
      ...process.env,
      CODEX_HOME: codexHome,
      FAKE_CODEX_STATE: statePath,
      PATH: `${binDirectory}${path.delimiter}${process.env.PATH ?? ''}`,
    };
    try {
      await run(powershell, ['-NoLogo', '-NoProfile', '-Command', '& { function Get-CimInstance { @() }; & $args[0] }', '--', powerShellInstaller], { env: environment });
    } catch (error) {
      const state = await readFile(statePath, 'utf8').catch(() => 'state file was not created');
      const descriptor = await readFile(path.join(codexHome, 'plugins', 'cache', marketplace, plugin, '0.2.1+codex.20260820095530', '.mcp.json'), 'utf8').catch(() => 'descriptor was not created');
      const cache = path.join(codexHome, 'plugins', 'cache', marketplace, plugin, '0.2.1+codex.20260820095530');
      const diagnostic = String.raw`param([string]$source,[string]$cache,[string]$homePath)
        $homePath = ((Get-Content -LiteralPath (Join-Path $cache '.mcp.json') -Raw | ConvertFrom-Json).mcpServers.'workflow-controller'.env.CODEX_HOME)
        function H([string]$root,[bool]$expand) { $r=@{}; $a=[IO.Path]::GetFullPath($root).TrimEnd([IO.Path]::DirectorySeparatorChar,[IO.Path]::AltDirectorySeparatorChar); foreach($f in Get-ChildItem -LiteralPath $a -Recurse -File -Force) { $rel=$f.FullName.Substring($a.Length).TrimStart([IO.Path]::DirectorySeparatorChar,[IO.Path]::AltDirectorySeparatorChar).Replace('\','/'); if($expand -and $rel -eq '.mcp.json') { $c=[IO.File]::ReadAllText($f.FullName).Replace('<CODEX_HOME>',$homePath.Replace('\','/')); $s=[Security.Cryptography.SHA256]::Create(); try {$r[$rel]= (($s.ComputeHash([Text.UTF8Encoding]::new($false).GetBytes($c))|% {$_.ToString('x2')}) -join '')} finally {$s.Dispose()} } else {$r[$rel]=(Get-FileHash -LiteralPath $f.FullName -Algorithm SHA256).Hash.ToLowerInvariant()} }; return $r }
        $l=H $source $true; $r=H $cache $false; [ordered]@{source=$l.Count;cache=$r.Count;sourceMcp=$l['.mcp.json'];cacheMcp=$r['.mcp.json'];diff=@($l.Keys|?{-not $r.ContainsKey($_)-or $l[$_]-ne $r[$_]})}|ConvertTo-Json -Compress`;
      const diagnosticPath = path.join(temporaryRoot, 'hash-diagnostic.ps1');
      await writeFile(diagnosticPath, diagnostic, 'utf8');
      const hashes = await run(powershell, ['-NoLogo', '-NoProfile', '-File', diagnosticPath, path.join(repository, 'plugins', 'agnets-workflow'), cache, codexHome], { env: environment }).then(result => result.stdout.trim()).catch(diagnosticError => diagnosticError.message);
      const pluginList = await run(path.join(binDirectory, 'codex.cmd'), ['plugin', 'list'], { env: environment }).then(result => result.stdout.trim()).catch(listError => listError.message);
      error.message += `\nFake Codex state: ${state}\nFake cache descriptor: ${descriptor}\nPowerShell hashes: ${hashes}\nDirect fake plugin list: ${pluginList}`;
      throw error;
    }

    const state = JSON.parse(await readFile(statePath, 'utf8'));
    const commands = state.commands;
    const removeIndex = commands.indexOf(`plugin remove ${retiredPlugin}`);
    const firstMarketplaceAdd = commands.indexOf(`plugin marketplace add ${repository}`);
    const pluginAdd = commands.indexOf(`plugin add ${plugin}@${marketplace}`);
    const secondMarketplaceAdd = commands.lastIndexOf(`plugin marketplace add ${repository}`);
    const marketplaceList = commands.indexOf('plugin marketplace list', secondMarketplaceAdd);
    assert.ok(removeIndex >= 0, 'retired plugin must be removed when its entry exists');
    assert.ok(removeIndex < firstMarketplaceAdd, 'retired plugin removal must precede managed plugin registration');
    assert.ok(firstMarketplaceAdd >= 0 && firstMarketplaceAdd < pluginAdd);
    assert.ok(pluginAdd < secondMarketplaceAdd);
    assert.ok(secondMarketplaceAdd < marketplaceList);

    const config = await readFile(path.join(codexHome, 'config.toml'), 'utf8');
    assert.match(config, /\[plugins\."agnets-workflow@ai-vibecode-superpower-local"\]/);
    assert.match(config, /\[plugin_marketplaces\."ai-vibecode-superpower-local"\]/);
    assert.equal(state.pluginEnabled, true);
    assert.equal(state.marketplaceRegistered, true);

    const descriptorPath = path.join(codexHome, 'plugins', 'cache', marketplace, plugin, state.version, '.mcp.json');
    const descriptorText = await readFile(descriptorPath, 'utf8');
    const descriptor = JSON.parse(descriptorText);
    assert.equal(descriptor.mcpServers['workflow-controller'].env.CODEX_HOME, (await realpath(codexHome)).replaceAll('\\', '/'));
    assert.equal(Object.hasOwn(descriptor.mcpServers['workflow-controller'], 'env_vars'), false);
    assert.doesNotMatch(descriptorText, /<CODEX_HOME>/);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('POSIX installer keeps the same command ordering without a post-plugin config rewrite', async () => {
  const source = await readFile(shellInstaller, 'utf8');
  const removeCall = source.lastIndexOf('\nremove_retired_workflow_plugin\n');
  const installCall = source.lastIndexOf('\ninstall_managed_plugin\n');
  assert.ok(removeCall >= 0 && removeCall < installCall);
  assert.equal(source.includes('remerged-config.toml'), false);
});
