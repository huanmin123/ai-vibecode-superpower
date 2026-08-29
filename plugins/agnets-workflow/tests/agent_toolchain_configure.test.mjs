import assert from 'node:assert/strict';
import { execFile as execFileCallback, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const skillDirectory = path.dirname(fileURLToPath(new URL('../../../skills/agent-toolchain/SKILL.md', import.meta.url)));
const powershellDriver = path.join(skillDirectory, 'scripts', 'agent-toolchain.ps1');
const shellDriver = path.join(skillDirectory, 'scripts', 'agent-toolchain.sh');
const managedHeading = '## CodeGraph 与 RTK';
const managedBlock = `${managedHeading}\n\n- CodeGraph MCP 可用于查询跨模块依赖、调用链和影响范围；其结果必须以当前源码、\`rg\`、未跟踪文件和刚修改文件复核。\n- 对只读且输出量大的命令，优先使用匹配的 \`rtk\` 子命令：\`git\`、\`rg\`、\`log\`、\`diff\`、\`test\`、\`mvn\`、\`npm\`、\`pnpm\`、\`read\`、\`find\`、\`ls\`、\`tree\`。未列出的只读命令先用 \`rtk rewrite "<command>"\` 或 \`rtk --help\` 核实；写操作和精确排障使用原生命令。\n- 只有工具注册表或 \`--help\` 未列出目标命令时，才能判定该命令不存在；其他工具错误保留原始输出，不得归因于能力缺失。\n- 安装、配置修复、初始化或修复索引、健康检查、升级审查和回滚使用全局 \`$agent-toolchain\`；不得在日常开发中自行安装、升级、重配或维护工具链。\n`;
const codeGraphConfig = `[mcp_servers.codegraph]\ncommand = "codegraph"\nargs = [\n    "serve",\n    "--mcp",\n]\n\n[mcp_servers.codegraph.env]\nCODEGRAPH_TELEMETRY = "0"\nCODEGRAPH_NO_UPDATE_CHECK = "1"\nDO_NOT_TRACK = "1"\n`;

function findWindowsBash() {
  const candidates = [];
  const configured = process.env.AGENT_TOOLCHAIN_TEST_BASH;
  if (configured) candidates.push(configured);
  for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
    for (const name of ['bash.exe', 'bash']) {
      candidates.push(path.join(directory, name));
    }
  }
  const where = spawnSync('where.exe', ['bash.exe'], { encoding: 'utf8', windowsHide: true });
  if (where.status === 0) candidates.push(...where.stdout.split(/\r?\n/).filter(Boolean));
  for (const candidate of new Set(candidates)) {
    if (!existsSync(candidate)) continue;
    const probe = spawnSync(candidate, ['-c', 'command -v file >/dev/null 2>&1 && command -v rg >/dev/null 2>&1'], { windowsHide: true });
    if (probe.status === 0) return candidate;
  }
  return null;
}

function findPowerShell() {
  if (process.platform !== 'win32') return null;
  const candidates = [];
  const configured = process.env.AGENT_TOOLCHAIN_TEST_PWSH;
  if (configured) candidates.push(configured);
  for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
    candidates.push(path.join(directory, 'pwsh.exe'), path.join(directory, 'pwsh'));
  }
  const where = spawnSync('where.exe', ['pwsh.exe'], { encoding: 'utf8', windowsHide: true });
  if (where.status === 0) candidates.push(...where.stdout.split(/\r?\n/).filter(Boolean));
  for (const candidate of new Set(candidates)) {
    if (!existsSync(candidate)) continue;
    const probe = spawnSync(candidate, ['-NoLogo', '-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'], { windowsHide: true });
    if (probe.status === 0) return candidate;
  }
  return null;
}

const windowsBash = process.platform === 'win32' ? findWindowsBash() : null;
const powershell = findPowerShell();

async function run(executable, args) {
  return execFile(executable, args, { windowsHide: true, encoding: 'utf8' });
}

function invokePosixDriver(project) {
  if (process.platform !== 'win32') return run('sh', [shellDriver, 'configure', '--project', project]);
  return run(windowsBash, [
    '-c',
    'uname() { case "$1" in -s) printf "%s\\n" Linux ;; -m) printf "%s\\n" x86_64 ;; *) command uname "$@" ;; esac; }; . "$1" configure --project "$2"',
    '--',
    shellDriver,
    project,
  ]);
}

function normalizeNewlines(text) {
  return text.replace(/\r\n/g, '\n');
}

async function expectConfiguredProject(project) {
  const agentsPath = path.join(project, 'AGENTS.md');
  const configPath = path.join(project, '.codex', 'config.toml');
  const ignorePath = path.join(project, '.gitignore');
  const agents = normalizeNewlines(await readFile(agentsPath, 'utf8'));
  assert.equal((agents.match(/^## CodeGraph 与 RTK\s*$/gm) ?? []).length, 1);
  assert.equal(agents, managedBlock);
  assert.match(await readFile(configPath, 'utf8'), /^\[mcp_servers\.codegraph\]$/m);
  assert.equal(normalizeNewlines(await readFile(ignorePath, 'utf8')), '/.codegraph/\n');
  return agents;
}

async function expectNoManagedArtifacts(project) {
  await assert.rejects(() => stat(path.join(project, '.codex')));
  await assert.rejects(() => stat(path.join(project, '.codex', 'config.toml')));
  await assert.rejects(() => stat(path.join(project, '.gitignore')));
}

async function writeExistingManagedArtifacts(project) {
  const codexDirectory = path.join(project, '.codex');
  await mkdir(codexDirectory);
  await writeFile(path.join(codexDirectory, 'config.toml'), codeGraphConfig);
  await writeFile(path.join(project, '.gitignore'), '/.codegraph/\nexisting-rule\n');
}

async function expectExistingManagedArtifactsUnchanged(project) {
  assert.equal(await readFile(path.join(project, '.codex', 'config.toml'), 'utf8'), codeGraphConfig);
  assert.equal(await readFile(path.join(project, '.gitignore'), 'utf8'), '/.codegraph/\nexisting-rule\n');
}

async function verifyDriver(label, invoke) {
  const root = await mkdtemp(path.join(os.tmpdir(), `agent-toolchain-${label}-`));
  try {
    const project = path.join(root, 'project');
    await mkdir(project);
    await invoke(project);
    const first = await expectConfiguredProject(project);
    await invoke(project);
    assert.equal(normalizeNewlines(await readFile(path.join(project, 'AGENTS.md'), 'utf8')), first);

    const middle = path.join(root, 'middle');
    await mkdir(middle);
    const middleAgents = path.join(middle, 'AGENTS.md');
    const middleContent = `${managedBlock}\n\n## Other rules\n\n- keep this section\n`;
    await writeFile(middleAgents, middleContent);
    await invoke(middle);
    assert.equal(normalizeNewlines(await readFile(middleAgents, 'utf8')), middleContent);
    await invoke(middle);
    assert.equal(normalizeNewlines(await readFile(middleAgents, 'utf8')), middleContent);

    for (const [name, content] of [
      ['legacy', '## AI 工具\n\n- legacy\n'],
      ['legacy-closing-hash', '## AI 工具 ##\n\n- legacy\n'],
      ['legacy-extra-space', '##  AI 工具\n\n- legacy\n'],
      ['legacy-leading-space', '   ## AI 工具\n\n- legacy\n'],
      ['legacy-internal-space', '## AI  工具\n\n- legacy\n'],
      ['legacy-internal-tab', '## AI\t工具\n\n- legacy\n'],
      ['legacy-bom', '\ufeff## AI 工具\n\n- legacy\n'],
    ]) {
      const legacy = path.join(root, name);
      await mkdir(legacy);
      const legacyAgents = path.join(legacy, 'AGENTS.md');
      await writeFile(legacyAgents, content);
      await assert.rejects(() => invoke(legacy), /agent-toolchain:/);
      assert.equal(await readFile(legacyAgents, 'utf8'), content);
      await expectNoManagedArtifacts(legacy);
    }

    const duplicate = path.join(root, 'duplicate');
    await mkdir(duplicate);
    const duplicateAgents = path.join(duplicate, 'AGENTS.md');
    await writeFile(duplicateAgents, `${managedBlock}\n${managedBlock}`);
    const duplicateBefore = await readFile(duplicateAgents, 'utf8');
    await assert.rejects(() => invoke(duplicate), /agent-toolchain:/);
    assert.equal(await readFile(duplicateAgents, 'utf8'), duplicateBefore);
    await expectNoManagedArtifacts(duplicate);

    const blockLines = managedBlock.trimEnd().split('\n');
    const invalidSections = [
      ['extra', `${managedBlock}- extra rule\n`],
      ['missing', `${[...blockLines.slice(0, 2), ...blockLines.slice(3)].join('\n')}\n`],
      ['reordered', `${[blockLines[0], blockLines[1], blockLines[3], blockLines[2], ...blockLines.slice(4)].join('\n')}\n`],
      ['heading-whitespace', managedBlock.replace(managedHeading, `${managedHeading} `)],
      ['heading-closing-hash', managedBlock.replace(managedHeading, `${managedHeading} ##`)],
      ['heading-extra-space', managedBlock.replace(managedHeading, '##  CodeGraph 与 RTK')],
      ['heading-leading-space', managedBlock.replace(managedHeading, `   ${managedHeading}`)],
      ['heading-case', managedBlock.replace(managedHeading, '## codegraph 与 rtk')],
      ['heading-setext', managedBlock.replace(managedHeading, 'CodeGraph 与 RTK\n---')],
      ['heading-setext-one', managedBlock.replace(managedHeading, 'CodeGraph 与 RTK\n-')],
      ['heading-setext-two', managedBlock.replace(managedHeading, 'CodeGraph 与 RTK\n--')],
      ['heading-internal-space', managedBlock.replace(managedHeading, '## CodeGraph  与 RTK')],
      ['heading-internal-tab', managedBlock.replace(managedHeading, '## CodeGraph\t与 RTK')],
      ['heading-setext-internal-space', managedBlock.replace(managedHeading, 'CodeGraph  与 RTK\n---')],
      ['heading-setext-internal-tab', managedBlock.replace(managedHeading, 'CodeGraph\t与 RTK\n---')],
      ['trailing-space', managedBlock.replace('维护工具链。', '维护工具链。 ')],
    ];
    for (const [name, content] of invalidSections) {
      const invalidProject = path.join(root, name);
      await mkdir(invalidProject);
      const invalidAgents = path.join(invalidProject, 'AGENTS.md');
      await writeFile(invalidAgents, content);
      await assert.rejects(() => invoke(invalidProject), /agent-toolchain:/);
      assert.equal(await readFile(invalidAgents, 'utf8'), content);
      await expectNoManagedArtifacts(invalidProject);
    }

    for (const [name, content] of [
      ['legacy-before-managed', `## AI 工具\n\n- legacy\n\n${managedBlock}`],
      ['legacy-after-managed', `${managedBlock}\n## AI 工具\n\n- legacy\n`],
      ['legacy-setext', 'AI 工具\n---\n\n- legacy\n'],
      ['legacy-setext-one', 'AI 工具\n-\n\n- legacy\n'],
      ['legacy-setext-two', 'AI 工具\n--\n\n- legacy\n'],
      ['legacy-case', '## ai 工具\n\n- legacy\n'],
      ['legacy-setext-internal-space', 'AI  工具\n---\n\n- legacy\n'],
      ['legacy-setext-internal-tab', 'AI\t工具\n---\n\n- legacy\n'],
    ]) {
      const conflictProject = path.join(root, name);
      await mkdir(conflictProject);
      const conflictAgents = path.join(conflictProject, 'AGENTS.md');
      await writeFile(conflictAgents, content);
      await assert.rejects(() => invoke(conflictProject), /agent-toolchain:/);
      assert.equal(await readFile(conflictAgents, 'utf8'), content);
      await expectNoManagedArtifacts(conflictProject);
    }

    for (const [name, content] of [
      ['existing-legacy-setext-one', 'AI 工具\n-\n\n- legacy\n'],
      ['existing-legacy-internal-tab', '## AI\t工具\n\n- legacy\n'],
      ['existing-managed-setext-two', managedBlock.replace(managedHeading, 'CodeGraph 与 RTK\n--')],
      ['existing-managed-internal-space', managedBlock.replace(managedHeading, '## CodeGraph  与 RTK')],
    ]) {
      const conflictProject = path.join(root, name);
      await mkdir(conflictProject);
      await writeExistingManagedArtifacts(conflictProject);
      const conflictAgents = path.join(conflictProject, 'AGENTS.md');
      await writeFile(conflictAgents, content);
      await assert.rejects(() => invoke(conflictProject), /agent-toolchain:/);
      assert.equal(await readFile(conflictAgents, 'utf8'), content);
      await expectExistingManagedArtifactsUnchanged(conflictProject);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('PowerShell configure writes one complete CodeGraph/RTK block and rejects the legacy block', { skip: process.platform !== 'win32' ? 'Windows PowerShell driver test runs only on Windows.' : !powershell && 'No PowerShell 7 found; set AGENT_TOOLCHAIN_TEST_PWSH to a PowerShell executable.' }, async () => {
  await verifyDriver('powershell', project => run(powershell, ['-NoLogo', '-NoProfile', '-File', powershellDriver, 'configure', '--project', project]));
});

test('POSIX configure declares the same complete CodeGraph/RTK block', async () => {
  const source = normalizeNewlines(await readFile(shellDriver, 'utf8'));
  assert.ok(source.includes(`agents_block='${managedBlock.trimEnd()}'`));
  assert.ok(source.includes('managed_section=$(managed_agents_section "$agents" "$agents_heading")'));
  assert.ok(source.includes('expected_section=$(printf \'%s\\n__agent_toolchain_section_end__\' "$agents_block")'));
  assert.ok(source.includes('[ "$managed_section" = "$expected_section" ] || die \'AGENTS.md 的 CodeGraph 与 RTK 受管标题冲突\''));
  assert.ok(source.includes("die 'AGENTS.md 包含旧版 AI 工具注入标题；请人工迁移为当前 CodeGraph 与 RTK 受管标题'"));
});

test('upgrade action is pinned to supported versions and includes required post-upgrade checks', async () => {
  const [powershellSource, shellSource, skill, installReference] = await Promise.all([
    readFile(powershellDriver, 'utf8'),
    readFile(shellDriver, 'utf8'),
    readFile(path.join(skillDirectory, 'SKILL.md'), 'utf8'),
    readFile(path.join(skillDirectory, 'references', 'install.md'), 'utf8'),
  ]);

  assert.match(powershellSource, /agent-toolchain\.ps1 upgrade --project PATH --dry-run\|--apply/);
  assert.match(powershellSource, /function Invoke-Upgrade/);
  assert.match(powershellSource, /\$codeGraphNeedsUpgrade = -not \(Test-Ready 'codegraph'\)/);
  assert.match(powershellSource, /Invoke-RebuildCodeGraphIndex/);
  assert.match(powershellSource, /'upgrade' \{ .* Invoke-Upgrade \}/);

  assert.match(shellSource, /agent-toolchain\.sh upgrade --project PATH --dry-run\|--apply/);
  assert.match(shellSource, /upgrade\(\)/);
  assert.match(shellSource, /is_ready codegraph \|\| codegraph_needs_upgrade=1/);
  assert.match(shellSource, /rebuild_codegraph_index/);
  assert.match(shellSource, /upgrade\) upgrade ;;/);

  assert.match(skill, /只把旧受管安装升级到驱动内置 manifest 的当前受支持版本，不查询 GitHub\/npm 最新版/);
  assert.match(installReference, /不查询 GitHub\/npm 的最新版本，也不接受目标版本参数/);
  assert.match(installReference, /CodeGraph 发生版本变化时，`--apply` 会全量重建 `.codegraph\/`，随后运行完整 `doctor`/);
});

test('PowerShell help accepts the documented --help invocation', { skip: process.platform !== 'win32' ? 'Windows PowerShell driver test runs only on Windows.' : !powershell && 'No PowerShell 7 found; set AGENT_TOOLCHAIN_TEST_PWSH to a PowerShell executable.' }, async () => {
  const { stdout } = await run(powershell, ['-NoLogo', '-NoProfile', '-File', powershellDriver, '--help']);
  assert.match(stdout, /agent-toolchain\.ps1 upgrade --project PATH --dry-run\|--apply/);
});

test('POSIX configure writes one complete CodeGraph/RTK block and rejects modified blocks', { skip: process.platform === 'win32' && !windowsBash && 'No Bash found on PATH; set AGENT_TOOLCHAIN_TEST_BASH to a Bash executable.' }, async () => {
  await verifyDriver('posix', invokePosixDriver);
});
