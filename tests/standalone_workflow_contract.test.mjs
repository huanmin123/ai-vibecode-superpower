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
const globalAgents = path.join(repository, 'codex-global-config', 'AGENTS.md');
const skill = path.join(repository, 'codex-global-config', 'skills', 'orchestrate-model-workflow', 'SKILL.md');
const skillInterface = path.join(repository, 'codex-global-config', 'skills', 'orchestrate-model-workflow', 'agents', 'openai.yaml');
const presetsRoot = path.join(repository, 'shared', 'roles', 'presets');
const presetManifest = path.join(repository, 'shared', 'roles', 'presets.sha256');
const presetGptRoles = path.join(presetsRoot, 'gpt', 'roles');
const posixInstaller = path.join(repository, 'install.sh');
const powerInstaller = path.join(repository, 'install.ps1');
const ripgrepDoc = path.join(repository, 'shared', 'docs', 'system', 'rg.md');
const zcodeAgents = path.join(repository, 'zcode-global-config', 'AGENTS.md');
const zcodeDocsReadme = path.join(repository, 'zcode-global-config', 'docs', 'README.md');
const zcodeSkill = path.join(repository, 'zcode-global-config', 'skills', 'orchestrate-model-workflow', 'SKILL.md');
const zcodePosixInstaller = path.join(repository, 'install.sh');
const zcodeRoleNames = [
  'glm_5.3_flash_low', 'glm_5.3_flash_high', 'glm_5.3_flash_max', 'glm_5.3_high', 'glm_5.3_max'
];
const bracketedTables = [
  '[hooks.state."browser@openai-bundled:plugin.json#hooks[0]:stop:0:0"]',
  'enabled = true',
  '',
  '[[skills."configured[0]#example"]]',
  'path = "local"',
  '',
  '[model_providers."local[0]#example"]',
  'name = "local"',
  'request_max_retries = 1',
  'stream_max_retries = 2',
  'stream_idle_timeout_ms = 3',
  'websocket_connect_timeout_ms = 4',
  ''
].join('\n');
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

function posixHome(codexHome) {
  return path.relative(repository, codexHome).split(path.sep).join('/');
}

const sharedSkillNames = ['agent-toolchain', 'project-doc-planner', 'visual-aesthetics', 'deep-dive-review'];

async function assertSharedSkillsDeployed(skillsDir) {
  for (const name of sharedSkillNames) {
    assert.match(await readFile(path.join(skillsDir, name, 'SKILL.md'), 'utf8'), /^---/);
  }
  assert.match(await readFile(path.join(skillsDir, 'visual-aesthetics', 'references', 'design-principles.md'), 'utf8'), /^# /);
}

test('global behavior rules do not hard-code obsolete host tool protocols', async () => {
  const text = await readFile(globalAgents, 'utf8');
  assert.doesNotMatch(text, /^## 工具调用契约$/m);
  for (const obsolete of [
    'functions.wait', 'functions.exec', 'collaboration.wait_agent',
    'collaboration.send_message', 'request_user_input', 'fallback_error', 'fallback_reason'
  ]) assert.doesNotMatch(text, new RegExp(obsolete.replaceAll('.', '\\.'), 'u'));
  assert.match(text, /保持正常语义/);
  assert.match(text, /不静默降级或改变业务行为/);
  assert.match(text, /按影响范围验证/);
});

test('standalone workflow skill has the five behavior stages and no obsolete protocol terms', async () => {
  const text = await readFile(skill, 'utf8');
  assert.match(text, /^---\r?\nname: orchestrate-model-workflow\r?\n/);
  for (const stage of ['Explore', 'Plan', 'Work', 'Critique', 'Promote']) assert.match(text, new RegExp(`\\b${stage}\\b`));
  for (const forbidden of [
    'workflow_controller', 'workflow_', 'claim_id', 'routing_schema_version',
    'coordinator_task_path', 'review_history_digest', 'controller', 'plugin',
    'MCP', 'SQLite', 'DAG', 'checkpoint', 'lease', 'heartbeat', 'cursor', 'envelope'
  ]) {
    assert.doesNotMatch(text, new RegExp(forbidden));
  }
  assert.match(text, /默认优先选择成本最低且能胜任的取证角色/);
  assert.match(text, /风险与回滚、验收、验证、停止条件/);
  assert.match(text, /默认并行优先/);
  assert.match(text, /不应只交给单个 agent 串行执行/);
  assert.match(text, /无法安全拆分、拆分成本高于收益或当前工具受限时，才使用单 agent/);
  assert.match(text, /fallback 只对本次派发生效/);
  assert.match(text, /能胜任同一职责的角色替代/);
  assert.match(text, /子代理只修改分配范围/);
  assert.match(text, /共享部分按必要顺序处理/);
  assert.match(text, /未决选择、权限、依赖或环境问题由主代理解决/);
  assert.match(text, /拒绝不等于角色或模型不可用，不触发 fallback/);
  assert.match(text, /不得把写入任务派给只读角色/);
  assert.match(text, /拒绝场景下，主代理仅在授权、权限、范围和责任边界均已满足时直接继续/);
  assert.match(text, /角色或模型不可用时，按档位就近回退/);
  assert.match(text, /派发一个继承主模型的子代理/);
  assert.match(text, /承担原角色职责，其余流程不变/);
  assert.match(text, /主代理不得改为在当前会话内直接执行/);
  assert.match(text, /恢复后回到原角色/);
  assert.doesNotMatch(text, /spawn_agent|agent_type|subagent_type/);
  assert.doesNotMatch(text, /路径锁|并行写入安全|所有.*串行/);
  assert.match(text, /角色定义的权威来源是 `<CODEX_HOME>\/agents\/ai-vibecode-superpower\/` 下的 toml role/);
  assert.match(text, /可用角色以下方清单为准/);
  assert.match(text, /不假定清单之外的角色/);
  assert.match(text, /<!-- preset-roles -->/);
  assert.doesNotMatch(text, /gpt_6_luna|gpt_6\.1_sol|gpt_6\.1_terra|gpt_6_astra|gpt_6_sol/);
  assert.doesNotMatch(text, /gpt_5\.6|terra/);
  const interfaceText = await readFile(skillInterface, 'utf8');
  assert.match(interfaceText, /可拆任务优先多 agent 并行/);
});

test('terra write tiers delegate simple writes to the luna_max leaf executor', async () => {
  const terraMax = await readFile(path.join(presetGptRoles, 'terra_max.md'), 'utf8');
  const delegation = terraMax.match(/可直接委派的执行子节点仅限 ([^；。]+)/u);
  assert.ok(delegation, 'terra_max must list its permitted execution children');
  assert.equal(delegation[1], '`{{role:luna_max}}`');
  const lunaMax = await readFile(path.join(presetGptRoles, 'luna_max.md'), 'utf8');
  const accepted = lunaMax.match(/只接受([^。]+)的直接委派/u);
  assert.ok(accepted, 'luna_max must define its direct-delegation boundary');
  const acceptedWriters = Array.from(accepted[1].matchAll(/\{\{role:([^}]+)\}\}/gu), (match) => match[1]).sort();
  assert.deepEqual(acceptedWriters, ['terra_high', 'terra_max', 'terra_xhigh'].sort(), 'luna_max must accept exactly the terra write tiers');
  assert.match(accepted[1], /主代理/);
  assert.doesNotMatch(accepted[1], /sol/);
});

test('the preset manifest covers every source file of all built-in presets', async () => {
  const lines = (await readFile(presetManifest, 'utf8')).trim().split(/\r?\n/);
  assert.equal(lines.length, 23);
  const entries = new Map(lines.map((line) => {
    const match = line.trim().match(/^([0-9a-f]{64}) {2}([^\s]+)$/);
    assert.ok(match, `invalid preset manifest line: ${line}`);
    return [match[2], match[1]];
  }));
  for (const preset of ['glm', 'gpt', 'ds']) {
    const presetFile = path.join(presetsRoot, preset, 'preset.toml');
    assert.equal(entries.get(`${preset}/preset.toml`), normalizedHash(await readFile(presetFile)), `preset manifest hash mismatch: ${preset}/preset.toml`);
    const roleDir = path.join(presetsRoot, preset, 'roles');
    for (const file of (await readdir(roleDir)).filter((name) => name.endsWith('.md')).sort()) {
      const rel = `${preset}/roles/${file}`;
      assert.equal(entries.get(rel), normalizedHash(await readFile(path.join(roleDir, file))), `preset manifest hash mismatch: ${rel}`);
    }
  }
});

test('all twelve gpt preset roles carry model routing fields', async () => {
  const expectedAllocation = {
    luna_medium: { model: 'gpt-6-luna', nativeEffort: 'medium' },
    luna_high: { model: 'gpt-6-luna', effort: 'deep' },
    luna_xhigh: { model: 'gpt-6-luna', nativeEffort: 'xhigh' },
    luna_max: { model: 'gpt-6-luna', effort: 'max', readonly: 'false' },
    terra_high: { model: 'gpt-6.1-terra', effort: 'deep', readonly: 'false' },
    terra_xhigh: { model: 'gpt-6.1-terra', nativeEffort: 'xhigh', readonly: 'false' },
    terra_max: { model: 'gpt-6.1-terra', effort: 'max', readonly: 'false' },
    sol_high: { model: 'gpt-6.1-sol', effort: 'deep' },
    sol_xhigh: { model: 'gpt-6.1-sol', nativeEffort: 'xhigh' },
    astra_high: { model: 'gpt-6-astra', effort: 'deep' },
    astra_xhigh: { model: 'gpt-6-astra', nativeEffort: 'xhigh' },
    astra_max: { model: 'gpt-6-astra', effort: 'max' }
  };
  const text = await readFile(path.join(presetsRoot, 'gpt', 'preset.toml'), 'utf8');
  const blocks = text.split(/\[\[codex\.role\]\]/).slice(1);
  assert.equal(blocks.length, 12);
  const field = (block, key) => block.match(new RegExp(`^${key} = "([^"]*)"`, 'm'))?.[1];
  for (const [id, expected] of Object.entries(expectedAllocation)) {
    const block = blocks.find((candidate) => field(candidate, 'id') === id);
    assert.ok(block, `missing gpt preset role: ${id}`);
    assert.equal(field(block, 'name'), `gpt_6${id.startsWith('sol_') || id.startsWith('terra_') ? '.1_' : '_'}${id}`, `name mismatch: ${id}`);
    assert.ok(field(block, 'description'), `description missing: ${id}`);
    assert.equal(field(block, 'model'), expected.model, `model mismatch: ${id}`);
    if (expected.nativeEffort) {
      assert.equal(field(block, 'model_reasoning_effort'), expected.nativeEffort, `native effort mismatch: ${id}`);
      assert.doesNotMatch(block, /^effort = /m, `effort must be absent when native effort is set: ${id}`);
    } else {
      assert.equal(field(block, 'effort'), expected.effort, `effort mismatch: ${id}`);
      assert.doesNotMatch(block, /^model_reasoning_effort = /m, `native effort must be absent when effort is set: ${id}`);
    }
    if (expected.readonly === 'false') assert.match(block, /^readonly = false$/m, `readonly mismatch: ${id}`);
    else assert.match(block, /^readonly = true$/m, `readonly mismatch: ${id}`);
  }
});

test('zcode workflow skill variant keeps the stages and drops codex-only mechanics', async () => {
  const text = await readFile(zcodeSkill, 'utf8');
  assert.match(text, /^---\r?\nname: orchestrate-model-workflow\r?\n/);
  for (const stage of ['Explore', 'Plan', 'Work', 'Critique', 'Promote']) assert.match(text, new RegExp(`\\b${stage}\\b`));
  assert.match(text, /<!-- preset-roles -->/);
  assert.match(text, /派发前以该目录实际存在的文件核对/);
  assert.match(text, /不假定清单之外的角色/);
  assert.match(text, /<ZCODE_HOME>/);
  assert.match(text, /宿主只扫描该层，子目录不参与发现/);
  for (const role of zcodeRoleNames) assert.doesNotMatch(text, new RegExp(role.replace(/\./g, '\\.')));
  assert.doesNotMatch(text, /agents\/ai-vibecode-superpower/);
  assert.match(text, /默认并行优先/);
  assert.match(text, /fallback 只对本次派发生效/);
  assert.match(text, /不得把写入任务派给只读角色/);
  assert.match(text, /角色或模型不可用时，按档位就近回退/);
  assert.match(text, /风险与回滚、验收、验证、停止条件/);
  assert.match(text, /派发一个继承当前会话模型的子代理/);
  assert.match(text, /承担原角色职责，其余流程不变/);
  assert.match(text, /主代理不得改为在当前会话内直接执行/);
  assert.match(text, /恢复后回到原角色/);
  assert.doesNotMatch(text, /Agent 工具|subagent_type|general-purpose|spawn_agent/);
  for (const forbidden of [
    'CODEX_HOME', 'coordinator_thread_id', 'gpt-5\\.6', 'sandbox_mode', 'avsp_'
  ]) assert.doesNotMatch(text, new RegExp(forbidden));
});

test('skill skeletons require fresh-instance review when a role carries both duties', async () => {
  for (const text of [await readFile(skill, 'utf8'), await readFile(zcodeSkill, 'utf8')]) {
    assert.match(text, /复审复用承担写入职责的角色时必须派发全新实例，不得把写入实例的自述当作事实/);
    assert.match(text, /由未参与本次写入的独立复审派发独立核对/);
    assert.doesNotMatch(text, /由未参与写入的只读角色独立核对/);
  }
});

test('glm preset keeps five roles with model routing and cross references', async () => {
  const presetText = await readFile(path.join(presetsRoot, 'glm', 'preset.toml'), 'utf8');
  assert.match(presetText, /\[zcode\]\nmodel = "account:bigmodel-individual-coding-plan\/GLM-5\.3-Flash"/);
  const expectedAllocation = {
    flash_low: { name: 'glm_5.3_flash_low', model: null, effort: 'basic', readonly: true },
    flash_high: { name: 'glm_5.3_flash_high', model: null, effort: 'deep', readonly: true },
    flash_max: { name: 'glm_5.3_flash_max', model: null, effort: 'max', readonly: false },
    review_high: { name: 'glm_5.3_high', model: 'account:bigmodel-individual-coding-plan/GLM-5.3', effort: 'deep', readonly: true },
    review_max: { name: 'glm_5.3_max', model: 'account:bigmodel-individual-coding-plan/GLM-5.3', effort: 'max', readonly: true }
  };
  const blocks = presetText.split(/\[\[zcode\.role\]\]/).slice(1);
  assert.equal(blocks.length, 5);
  const field = (block, key) => block.match(new RegExp(`^${key} = "([^"]*)"`, 'm'))?.[1];
  for (const [id, expected] of Object.entries(expectedAllocation)) {
    const block = blocks.find((candidate) => field(candidate, 'id') === id);
    assert.ok(block, `missing glm preset role: ${id}`);
    assert.equal(field(block, 'name'), expected.name, `name mismatch: ${id}`);
    assert.ok(field(block, 'description'), `description missing: ${id}`);
    if (expected.model === null) assert.equal(field(block, 'model'), undefined, `model must be inherited from host default: ${id}`);
    else assert.equal(field(block, 'model'), expected.model, `model mismatch: ${id}`);
    assert.equal(field(block, 'effort'), expected.effort, `effort mismatch: ${id}`);
    assert.match(block, new RegExp(`^readonly = ${expected.readonly}$`, 'm'), `readonly mismatch: ${id}`);
    assert.doesNotMatch(block, /^thoughtLevel = /m, `native effort must be absent: ${id}`);
  }
  const lowBody = await readFile(path.join(presetsRoot, 'glm', 'roles', 'flash_low.md'), 'utf8');
  assert.match(lowBody, /建议升级到 `\{\{role:flash_high\}\}` 取证/);
  const reviewHighBody = await readFile(path.join(presetsRoot, 'glm', 'roles', 'review_high.md'), 'utf8');
  assert.match(reviewHighBody, /升级到 `\{\{role:review_max\}\}` 复审/);
});

test('ds preset keeps three roles on a single model with max carrying review duty', async () => {
  const presetText = await readFile(path.join(presetsRoot, 'ds', 'preset.toml'), 'utf8');
  assert.match(presetText, /\[zcode\]\nmodel = "account:deepseek-coding-plan\/deepseek-v4\.1-flash"/);
  const expectedAllocation = {
    flash_low: { name: 'ds_4.1_flash_low', effort: 'basic', readonly: true },
    flash_high: { name: 'ds_4.1_flash_high', effort: 'deep', readonly: true },
    flash_max: { name: 'ds_4.1_flash_max', effort: 'max', readonly: false }
  };
  const blocks = presetText.split(/\[\[zcode\.role\]\]/).slice(1);
  assert.equal(blocks.length, 3);
  const field = (block, key) => block.match(new RegExp(`^${key} = "([^"]*)"`, 'm'))?.[1];
  for (const [id, expected] of Object.entries(expectedAllocation)) {
    const block = blocks.find((candidate) => field(candidate, 'id') === id);
    assert.ok(block, `missing ds preset role: ${id}`);
    assert.equal(field(block, 'name'), expected.name, `name mismatch: ${id}`);
    assert.ok(field(block, 'description'), `description missing: ${id}`);
    assert.equal(field(block, 'model'), undefined, `model must be inherited from host default: ${id}`);
    assert.equal(field(block, 'effort'), expected.effort, `effort mismatch: ${id}`);
    assert.match(block, new RegExp(`^readonly = ${expected.readonly}$`, 'm'), `readonly mismatch: ${id}`);
  }
  assert.match(field(blocks.find((c) => field(c, 'id') === 'flash_max'), 'skill_desc'), /复审时派发全新实例/);
  const lowBody = await readFile(path.join(presetsRoot, 'ds', 'roles', 'flash_low.md'), 'utf8');
  assert.match(lowBody, /升级到 `\{\{role:flash_high\}\}` 取证/);
  const highBody = await readFile(path.join(presetsRoot, 'ds', 'roles', 'flash_high.md'), 'utf8');
  assert.match(highBody, /派发 `\{\{role:flash_max\}\}` 或主代理自行处理/);
  const maxBody = await readFile(path.join(presetsRoot, 'ds', 'roles', 'flash_max.md'), 'utf8');
  assert.match(maxBody, /承担复审或终审时：始终只读/);
  assert.match(maxBody, /复审派发必须是全新实例，不得引用或信任写入实例的自述/);
});

test('zcode sources do not leak codex placeholders or model ids', async () => {
  const glmFiles = [zcodeAgents, zcodeDocsReadme, zcodeSkill];
  const glmDir = path.join(presetsRoot, 'glm');
  for (const file of (await readdir(glmDir, { recursive: true })).filter((name) => /\.(md|toml)$/.test(name))) {
    glmFiles.push(path.join(glmDir, file));
  }
  for (const file of glmFiles) {
    const text = await readFile(file, 'utf8');
    assert.doesNotMatch(text, /CODEX_HOME|gpt-5\.6|avsp_/, `codex leakage in: ${file}`);
  }
});

test('merged installer sources register the zcode client with transactional state', async () => {
  const text = await readFile(zcodePosixInstaller, 'utf8');
  assert.match(text, /client_label=ZCode/);
  assert.match(text, /home_env=ZCODE_HOME/);
  assert.match(text, /default_home=\.zcode/);
  assert.match(text, /placeholder=ZCODE_HOME/);
  assert.match(text, /client_label=Codex/);
  assert.match(text, /placeholder=CODEX_HOME/);
  assert.match(text, /sed "s\|<\$\{placeholder\}>\|\$escaped_home\|g;/);
  assert.match(text, /mark_state backed-up/);
  assert.match(text, /mark_state install-started/);
});

test('PowerShell installer has no compatibility or legacy-removal surface', async () => {
  const text = await readFile(powerInstaller, 'utf8');
  assert.doesNotMatch(text, /Get-LegacyPluginState|Remove-LegacyPlugins|workflow-controller|agnets-workflow|plugin remove/);
  assert.match(text, /Expand-Placeholders/);
});

test('POSIX installer has no compatibility or legacy-removal surface', async () => {
  const text = await readFile(posixInstaller, 'utf8');
  assert.doesNotMatch(text, /get_legacy_plugin_state|remove_legacy_plugins|workflow-controller|agnets-workflow|plugin remove/);
  assert.match(text, /source_model_provider_settings=/);
});

test('direct ripgrep release examples verify SHA-256 before extraction', async () => {
  const text = await readFile(ripgrepDoc, 'utf8');
  const windows = text.slice(text.indexOf('## Windows'), text.indexOf('## macOS'));
  const macos = text.slice(text.indexOf('## macOS'), text.indexOf('## Linux'));
  const linux = text.slice(text.indexOf('## Linux'));
  const assertBefore = (section, required, extraction) => {
    const requiredIndex = section.indexOf(required);
    const extractionIndex = section.indexOf(extraction);
    assert.notEqual(requiredIndex, -1, `missing checksum step: ${required}`);
    assert.notEqual(extractionIndex, -1, `missing extraction step: ${extraction}`);
    assert.ok(requiredIndex < extractionIndex, `${required} must run before ${extraction}`);
  };
  assertBefore(windows, '$checksumAsset = "$asset.sha256"', 'Expand-Archive');
  assertBefore(windows, 'Get-FileHash', 'Expand-Archive');
  assertBefore(macos, 'shasum -a 256', 'tar -xzf');
  assertBefore(linux, 'sha256sum', 'tar -xzf');
  assertBefore(linux, 'shasum', 'tar -xzf');
});

test('PowerShell installer deploys the standalone skill into an isolated nested home', { skip: process.platform !== 'win32' }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-powershell-contract-'));
  const codexHome = path.join(root, 'missing', 'nested', '.codex');
  try {
    await mkdir(path.dirname(codexHome), { recursive: true });
    await mkdir(codexHome, { recursive: true });
    await writeFile(path.join(codexHome, 'config.toml'), 'keep_me = "untouched"\n"custom.setting" = "root quoted"\nmodel = "old"\n\n[desktop.open-in-target-preferences.perPath]\n"/Users/example/project" = "cursor"\n"part=key" = "equals"\n\n[tui.model_availability_nux]\n"gpt-5.5" = true\n\n[model_providers.local]\nname = "local"\nrequest_max_retries = 1\nstream_max_retries = 2\nstream_idle_timeout_ms = 3\nwebsocket_connect_timeout_ms = 4\n\n[agents]\nmax_threads = 1\nmax_depth = 1\n\n[features]\ngoals = false\n\n' + bracketedTables);
    const result = await runResult('pwsh.exe', ['-NoLogo', '-NoProfile', '-File', powerInstaller, '-Client', 'codex', '-Preset', 'gpt'], {
      env: { ...process.env, CODEX_HOME: codexHome },
    });
    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
    const installed = await readFile(path.join(codexHome, 'skills', 'orchestrate-model-workflow', 'SKILL.md'), 'utf8');
    assert.match(installed, /^---\r?\nname: orchestrate-model-workflow\r?\n/);
    assert.match(installed, /- `gpt_6\.1_terra_high`：Terra\/high 常规契约写入角色。/);
    assert.doesNotMatch(installed, /<!-- preset-roles -->/);
    const roleDir = path.join(codexHome, 'agents', 'ai-vibecode-superpower');
    const roleFiles = (await readdir(roleDir)).filter((name) => name.endsWith('.toml')).sort();
    assert.equal(roleFiles.length, 12);
    assert.match(await readFile(path.join(roleDir, 'gpt_6.1_terra_high.toml'), 'utf8'), /^name = "gpt_6\.1_terra_high"$/m);
    await assertSharedSkillsDeployed(path.join(codexHome, 'skills'));
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
    assert.match(config, /\[hooks\.state\."browser@openai-bundled:plugin\.json#hooks\[0\]:stop:0:0"\]\r?\nenabled = true/);
    assert.match(config, /\[\[skills\."configured\[0\]#example"\]\]\r?\npath = "local"/);
    assert.match(config, /\[model_providers\."local\[0\]#example"\][\s\S]*request_max_retries = 120[\s\S]*websocket_connect_timeout_ms = 15000/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('PowerShell installer removes stale managed agents when switching presets', { skip: process.platform !== 'win32' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'preset-switch-'));
  const zcodeHome = path.join(root, 'home');
  try {
    const env = { ...process.env, ZCODE_HOME: zcodeHome };
    assert.equal((await runResult('pwsh.exe', ['-NoLogo', '-NoProfile', '-File', powerInstaller, '-Client', 'zcode', '-Preset', 'ds'], { env })).code, 0);
    await writeFile(path.join(zcodeHome, 'agents', 'custom.md'), 'user custom agent\n');
    assert.equal((await runResult('pwsh.exe', ['-NoLogo', '-NoProfile', '-File', powerInstaller, '-Client', 'zcode', '-Preset', 'glm'], { env })).code, 0);
    const names = (await readdir(path.join(zcodeHome, 'agents'))).sort();
    assert.ok(!names.some((name) => name.startsWith('ds_4.1_flash_')), `stale ds agents must be removed: ${names}`);
    for (const role of zcodeRoleNames) assert.ok(names.includes(`${role}.md`), `missing glm agent: ${role}`);
    assert.ok(names.includes('custom.md'), 'user agent must survive preset switch');
    assert.ok(names.includes('.ai-vibecode-superpower.managed'), 'managed list must be installed');
    const managed = await readFile(path.join(zcodeHome, 'agents', '.ai-vibecode-superpower.managed'), 'utf8');
    assert.deepEqual(managed.trim().split('\n'), [...zcodeRoleNames].sort().map((role) => `${role}.md`));
    const backups = (await readdir(path.join(zcodeHome, 'backups'), { recursive: true })).map((entry) => entry.split(/[\\/]/).pop());
    assert.ok(backups.includes('ds_4.1_flash_low.md'), 'stale ds agents must be backed up');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('POSIX installer removes stale managed agents when switching presets', async (t) => {
  const shell = await findPosixShell();
  if (!shell) return t.skip('POSIX shell is unavailable');
  const root = await mkdtemp(path.join(repository, '.zcode-posix-switch-'));
  const zcodeHome = path.join(root, 'home');
  try {
    const base = { cwd: repository, env: { ...process.env, ZCODE_HOME: posixHome(zcodeHome) } };
    assert.equal((await runResult(shell, ['install.sh', 'zcode', 'ds'], base)).code, 0);
    await writeFile(path.join(zcodeHome, 'agents', 'custom.md'), 'user custom agent\n');
    assert.equal((await runResult(shell, ['install.sh', 'zcode', 'glm'], base)).code, 0);
    const names = (await readdir(path.join(zcodeHome, 'agents'))).sort();
    assert.ok(!names.some((name) => name.startsWith('ds_4.1_flash_')), `stale ds agents must be removed: ${names}`);
    for (const role of zcodeRoleNames) assert.ok(names.includes(`${role}.md`), `missing glm agent: ${role}`);
    assert.ok(names.includes('custom.md'), 'user agent must survive preset switch');
    assert.ok(names.includes('.ai-vibecode-superpower.managed'), 'managed list must be installed');
    const managed = await readFile(path.join(zcodeHome, 'agents', '.ai-vibecode-superpower.managed'), 'utf8');
    assert.deepEqual(managed.trim().split('\n'), [...zcodeRoleNames].sort().map((role) => `${role}.md`));
    const backups = (await readdir(path.join(zcodeHome, 'backups'), { recursive: true })).map((entry) => entry.split(/[\\/]/).pop());
    assert.ok(backups.includes('ds_4.1_flash_low.md'), 'stale ds agents must be backed up');
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
    const result = await runResult('pwsh.exe', ['-NoLogo', '-NoProfile', '-File', powerInstaller, '-Client', 'codex', '-Preset', 'gpt'], {
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
    const result = await runResult('pwsh.exe', ['-NoLogo', '-NoProfile', '-File', powerInstaller, '-Client', 'codex', '-Preset', 'gpt'], {
      env: { ...process.env, CODEX_HOME: codexHome },
    });
    assert.notEqual(result.code, 0, result.stdout);
    assert.match(result.stdout + '\n' + result.stderr, /Unsupported TOML key syntax/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('PowerShell installer rejects a table header with trailing syntax', { skip: process.platform !== 'win32' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-powershell-invalid-header-'));
  const codexHome = path.join(root, 'nested', '.codex');
  try {
    await mkdir(codexHome, { recursive: true });
    await writeFile(path.join(codexHome, 'config.toml'), '[hooks.state."quoted[0]"] trailing\nenabled = true\n');
    const result = await runResult('pwsh.exe', ['-NoLogo', '-NoProfile', '-File', powerInstaller, '-Client', 'codex', '-Preset', 'gpt'], {
      env: { ...process.env, CODEX_HOME: codexHome },
    });
    assert.notEqual(result.code, 0, result.stdout);
    assert.match(result.stdout + '\n' + result.stderr, /Unsupported TOML table header/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('POSIX installer deploys a fresh standalone home without legacy prerequisites', async (t) => {
  const shell = await findPosixShell();
  if (!shell) return t.skip('POSIX shell is unavailable');
  const root = await mkdtemp(path.join(repository, '.codex-posix-contract-'));
  const codexHome = path.join(root, 'missing', 'nested', '.codex');
  try {
    const result = await runResult(shell, ['install.sh', 'codex', 'gpt'], {
      cwd: repository,
      env: { ...process.env, CODEX_HOME: posixHome(codexHome) },
    });
    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
    const installed = await readFile(path.join(codexHome, 'skills', 'orchestrate-model-workflow', 'SKILL.md'), 'utf8');
    assert.match(installed, /^---\nname: orchestrate-model-workflow\n/);
    await assertSharedSkillsDeployed(path.join(codexHome, 'skills'));
    const agents = await readFile(path.join(codexHome, 'AGENTS.md'), 'utf8');
    assert.doesNotMatch(agents, /<CODEX_HOME>|\$CODEX_HOME/);
    const config = await readFile(path.join(codexHome, 'config.toml'), 'utf8');
    assert.match(config, /^model = "gpt-6\.1-sol"/m);
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
    await writeFile(path.join(codexHome, 'config.toml'), 'keep_me = "untouched"\n"custom.setting" = "root quoted"\nmodel = "old"\n\n[desktop.open-in-target-preferences.perPath]\n"/Users/example/project" = "cursor"\n"part=key" = "equals"\n\n[tui.model_availability_nux]\n"gpt-5.5" = true\n\n[model_providers.local]\nname = "local"\nrequest_max_retries = 1\nstream_max_retries = 2\nstream_idle_timeout_ms = 3\nwebsocket_connect_timeout_ms = 4\n\n[agents]\nmax_threads = 1\nmax_depth = 1\n\n[features]\ngoals = false\n\n' + bracketedTables);
    const result = await runResult(shell, ['install.sh', 'codex', 'gpt'], {
      cwd: repository,
      env: { ...process.env, CODEX_HOME: posixHome(codexHome) },
    });
    assert.equal(result.code, 0, result.stdout + '\n' + result.stderr);
    const config = await readFile(path.join(codexHome, 'config.toml'), 'utf8');
    assert.match(config, /"custom\.setting" = "root quoted"/);
    assert.match(config, /"\/Users\/example\/project" = "cursor"/);
    assert.match(config, /"part=key" = "equals"/);
    assert.match(config, /"gpt-5\.5" = true/);
    assert.match(config, /^model = "gpt-6\.1-sol"/m);
    assert.match(config, /\[hooks\.state\."browser@openai-bundled:plugin\.json#hooks\[0\]:stop:0:0"\]\nenabled = true/);
    assert.match(config, /\[\[skills\."configured\[0\]#example"\]\]\npath = "local"/);
    assert.match(config, /\[model_providers\."local\[0\]#example"\][\s\S]*request_max_retries = 120[\s\S]*websocket_connect_timeout_ms = 15000/);
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
    const result = await runResult(shell, ['install.sh', 'codex', 'gpt'], {
      cwd: repository,
      env: { ...process.env, CODEX_HOME: posixHome(codexHome) },
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
    const result = await runResult(shell, ['install.sh', 'codex', 'gpt'], {
      cwd: repository,
      env: { ...process.env, CODEX_HOME: posixHome(codexHome) },
    });
    assert.notEqual(result.code, 0, result.stdout);
    assert.match(result.stdout + '\n' + result.stderr, /unsupported TOML syntax for safe merge: unsupported key syntax/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('POSIX installer rejects a table header with trailing syntax', async (t) => {
  const shell = await findPosixShell();
  if (!shell) return t.skip('POSIX shell is unavailable');
  const root = await mkdtemp(path.join(repository, '.codex-posix-invalid-header-'));
  const codexHome = path.join(root, 'nested', '.codex');
  try {
    await mkdir(codexHome, { recursive: true });
    await writeFile(path.join(codexHome, 'config.toml'), '[hooks.state."quoted[0]"] trailing\nenabled = true\n');
    const result = await runResult(shell, ['install.sh', 'codex', 'gpt'], {
      cwd: repository,
      env: { ...process.env, CODEX_HOME: posixHome(codexHome) },
    });
    assert.notEqual(result.code, 0, result.stdout);
    assert.match(result.stdout + '\n' + result.stderr, /unsupported TOML syntax for safe merge: ambiguous table header/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('POSIX installer normalizes parent segments without rejecting a safe explicit target', async (t) => {
  const shell = await findPosixShell();
  if (!shell) return t.skip('POSIX shell is unavailable');
  const root = await mkdtemp(path.join(repository, '.codex-posix-normalized-home-'));
  const cwd = path.join(root, 'workspace');
  const codexHome = path.join(cwd, 'target', '.codex');
  try {
    await mkdir(cwd, { recursive: true });
    const result = await runResult(shell, [posixInstaller, 'codex', 'gpt'], {
      cwd,
      env: { ...process.env, CODEX_HOME: 'unused/../target/.codex' },
    });
    assert.equal(result.code, 0, result.stdout + '\n' + result.stderr);
    const reportedHome = result.stdout.match(/Codex configuration installed in: (\S+)/)?.[1] ?? '';
    const styleInsensitive = (value) => value.replaceAll('\\', '/').replace(/^([A-Za-z]):/, '/$1').toLowerCase();
    assert.equal(styleInsensitive(reportedHome), styleInsensitive(codexHome), result.stdout);
    assert.match(await readFile(path.join(codexHome, 'AGENTS.md'), 'utf8'), /保持正常语义/);
    assert.equal(await readdir(path.join(cwd, 'unused')).catch(() => null), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('POSIX installer rejects paths that normalize to the filesystem root before writing', { skip: process.platform === 'win32' }, async (t) => {
  const shell = await findPosixShell();
  if (!shell) return t.skip('POSIX shell is unavailable');
  const root = await mkdtemp(path.join(repository, '.codex-posix-root-alias-'));
  const fakeBin = path.join(root, 'bin');
  const blockedMkdir = path.join(fakeBin, 'mkdir');
  const relativeRoot = path.relative(repository, path.parse(repository).root).split(path.sep).join('/');
  try {
    await mkdir(fakeBin, { recursive: true });
    await writeFile(blockedMkdir, '#!/bin/sh\nprintf "%s\\n" "unexpected mkdir: $*" >&2\nexit 99\n', { mode: 0o755 });
    for (const value of ['/.', '/..', '/../../', relativeRoot]) {
      const result = await runResult(shell, [posixInstaller, 'codex', 'gpt'], {
        cwd: repository,
        env: { ...process.env, CODEX_HOME: value, PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ''}` },
      });
      assert.notEqual(result.code, 0, `installer unexpectedly accepted root alias: ${value}`);
      assert.match(result.stdout + '\n' + result.stderr, /Refusing unsafe Codex home: \/$/m);
      assert.doesNotMatch(result.stderr, /unexpected mkdir/);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('installer sources statically enforce target boundaries and transactional state', async () => {
  const text = await readFile(posixInstaller, 'utf8');
  const normalizationIndex = text.indexOf('client_home=$(normalize_absolute_path "$raw_home")');
  const parentCreationIndex = text.indexOf('mkdir -p "$(dirname -- "$client_home")"');
  assert.notEqual(normalizationIndex, -1);
  assert.notEqual(parentCreationIndex, -1);
  assert.ok(normalizationIndex < parentCreationIndex);
  assert.match(text, /case "\$client_home" in \/\|\.\) die "Refusing unsafe \$client_label home:/);
  assert.match(text, /script_dir=\$\(CDPATH= cd --/);
  assert.match(text, /source_model_provider_settings=/);
  assert.match(text, /sed "s\|<\$\{placeholder\}>\|\$escaped_home\|g;/);
  assert.match(text, /mark_state backed-up/);
  assert.match(text, /mark_state install-started/);
  assert.match(text, /assert_directory_container "\$client_home\/backups"/);
});

test('PowerShell zcode installer composes shared and zcode sources and leaves unmanaged state untouched', { skip: process.platform !== 'win32' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'zcode-powershell-contract-'));
  const zcodeHome = path.join(root, 'missing', 'nested', '.zcode');
  try {
    await mkdir(zcodeHome, { recursive: true });
    await mkdir(path.join(zcodeHome, 'cli'), { recursive: true });
    await writeFile(path.join(zcodeHome, 'cli', 'config.json'), '{"keep":"me"}\n');
    const result = await runResult('pwsh.exe', ['-NoLogo', '-NoProfile', '-File', powerInstaller, '-Client', 'zcode', '-Preset', 'glm'], {
      env: { ...process.env, ZCODE_HOME: zcodeHome },
    });
    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
    const agents = await readFile(path.join(zcodeHome, 'AGENTS.md'), 'utf8');
    assert.doesNotMatch(agents, /<ZCODE_HOME>|\$ZCODE_HOME/);
    assert.match(agents, /zcode-powershell-contract-/i);
    const installedSkill = await readFile(path.join(zcodeHome, 'skills', 'orchestrate-model-workflow', 'SKILL.md'), 'utf8');
    assert.match(installedSkill, /^---\r?\nname: orchestrate-model-workflow\r?\n/);
    assert.match(installedSkill, /- `glm_5\.3_flash_low`：只读常规取证与实施后预审。/);
    assert.doesNotMatch(installedSkill, /<!-- preset-roles -->/);
    assert.doesNotMatch(installedSkill, /<ZCODE_HOME>/);
    const agentFiles = (await readdir(path.join(zcodeHome, 'agents'))).filter((name) => name.endsWith('.md'));
    for (const role of zcodeRoleNames) assert.ok(agentFiles.includes(`${role}.md`), `missing flat agent: ${role}.md`);
    assert.equal(agentFiles.filter((name) => zcodeRoleNames.includes(name.slice(0, -3))).length, 5);
    const docsReadme = await readFile(path.join(zcodeHome, 'docs', 'README.md'), 'utf8');
    assert.match(docsReadme, /ZCode 全局参考文档/);
    const systemDocs = await readdir(path.join(zcodeHome, 'docs', 'system'));
    for (const expected of ['README.md', 'windows.md', 'rg.md', 'ssh.md', 'linux.md', 'macos.md', '跨系统操作示例.md']) {
      assert.ok(systemDocs.includes(expected), `missing shared system doc: ${expected}`);
    }
    await assertSharedSkillsDeployed(path.join(zcodeHome, 'skills'));
    const cliConfig = await readFile(path.join(zcodeHome, 'cli', 'config.json'), 'utf8');
    assert.match(cliConfig, /"keep": ?"me"/);
    assert.equal(await readdir(path.join(zcodeHome, 'skills')).then((names) => names.length), 5);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('POSIX zcode installer deploys a fresh home without codex configuration', async (t) => {
  const shell = await findPosixShell();
  if (!shell) return t.skip('POSIX shell is unavailable');
  const root = await mkdtemp(path.join(repository, '.zcode-posix-contract-'));
  const zcodeHome = path.join(root, 'missing', 'nested', '.zcode');
  try {
    const result = await runResult(shell, ['install.sh', 'zcode', 'glm'], {
      cwd: repository,
      env: { ...process.env, ZCODE_HOME: posixHome(zcodeHome) },
    });
    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
    const agents = await readFile(path.join(zcodeHome, 'AGENTS.md'), 'utf8');
    assert.doesNotMatch(agents, /<ZCODE_HOME>|\$ZCODE_HOME/);
    const installedSkill = await readFile(path.join(zcodeHome, 'skills', 'orchestrate-model-workflow', 'SKILL.md'), 'utf8');
    assert.match(installedSkill, /^---\nname: orchestrate-model-workflow\n/);
    assert.match(installedSkill, /- `glm_5\.3_flash_low`：只读常规取证与实施后预审。/);
    assert.doesNotMatch(installedSkill, /<!-- preset-roles -->/);
    assert.doesNotMatch(installedSkill, /<ZCODE_HOME>/);
    await assertSharedSkillsDeployed(path.join(zcodeHome, 'skills'));
    const agentFiles = (await readdir(path.join(zcodeHome, 'agents'))).filter((name) => name.endsWith('.md'));
    for (const role of zcodeRoleNames) assert.ok(agentFiles.includes(`${role}.md`), `missing flat agent: ${role}.md`);
    assert.equal(agentFiles.filter((name) => zcodeRoleNames.includes(name.slice(0, -3))).length, 5);
    const systemDocs = await readdir(path.join(zcodeHome, 'docs', 'system'));
    for (const expected of ['README.md', 'windows.md', 'rg.md', 'ssh.md', 'linux.md', 'macos.md', '跨系统操作示例.md']) {
      assert.ok(systemDocs.includes(expected), `missing shared system doc: ${expected}`);
    }
    assert.equal(await readFile(path.join(zcodeHome, 'config.toml'), 'utf8').then(() => true, () => false), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('merged POSIX installer requires an explicit client when stdin is not interactive', async (t) => {
  const shell = await findPosixShell();
  if (!shell) return t.skip('POSIX shell is unavailable');
  const result = await runResult(shell, ['install.sh'], { cwd: repository });
  assert.notEqual(result.code, 0, result.stdout);
  assert.match(result.stdout + '\n' + result.stderr, /No client specified\. Usage: sh install\.sh <codex\|zcode>/);
});

test('merged POSIX installer rejects unknown clients', async (t) => {
  const shell = await findPosixShell();
  if (!shell) return t.skip('POSIX shell is unavailable');
  const result = await runResult(shell, ['install.sh', 'unknown-client'], { cwd: repository });
  assert.notEqual(result.code, 0, result.stdout);
  assert.match(result.stdout + '\n' + result.stderr, /Unknown client: unknown-client/);
});

test('PowerShell installer rejects a preset role without any model binding', { skip: process.platform !== 'win32' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'preset-bad-model-'));
  const presetDir = path.join(root, 'myds');
  try {
    await mkdir(path.join(presetDir, 'roles'), { recursive: true });
    await writeFile(path.join(presetDir, 'preset.toml'), 'description = "broken preset"\n\n[zcode]\n\n[[zcode.role]]\nid = "worker"\nname = "my_worker"\ndescription = "worker"\neffort = "max"\nreadonly = false\n');
    await writeFile(path.join(presetDir, 'roles', 'worker.md'), 'worker body\n');
    const result = await runResult('pwsh.exe', ['-NoLogo', '-NoProfile', '-File', powerInstaller, '-Client', 'zcode', '-Preset', presetDir], {
      env: { ...process.env, ZCODE_HOME: path.join(root, 'home') },
    });
    assert.notEqual(result.code, 0, result.stdout);
    assert.match(result.stdout + '\n' + result.stderr, /has no model/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('PowerShell installer rejects a preset body referencing an unknown role id', { skip: process.platform !== 'win32' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'preset-bad-reference-'));
  const presetDir = path.join(root, 'myds');
  try {
    await mkdir(path.join(presetDir, 'roles'), { recursive: true });
    await writeFile(path.join(presetDir, 'preset.toml'), 'description = "broken preset"\n\n[zcode]\nmodel = "account:bigmodel-individual-coding-plan/GLM-5.3-Flash"\n\n[[zcode.role]]\nid = "worker"\nname = "my_worker"\ndescription = "worker"\neffort = "max"\nreadonly = false\n');
    await writeFile(path.join(presetDir, 'roles', 'worker.md'), 'escalate to {{role:missing}}\n');
    const result = await runResult('pwsh.exe', ['-NoLogo', '-NoProfile', '-File', powerInstaller, '-Client', 'zcode', '-Preset', presetDir], {
      env: { ...process.env, ZCODE_HOME: path.join(root, 'home') },
    });
    assert.notEqual(result.code, 0, result.stdout);
    assert.match(result.stdout + '\n' + result.stderr, /references unknown role id/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('merged PowerShell installer requires an explicit preset when input is redirected', { skip: process.platform !== 'win32' }, async () => {
  const result = await runResult('pwsh.exe', ['-NoLogo', '-NoProfile', '-File', powerInstaller, '-Client', 'zcode'], { cwd: repository });
  assert.notEqual(result.code, 0, result.stdout);
  assert.match(result.stdout + '\n' + result.stderr, /No preset specified/i);
});

test('merged PowerShell installer requires an explicit client when input is redirected', { skip: process.platform !== 'win32' }, async () => {
  const result = await runResult('pwsh.exe', ['-NoLogo', '-NoProfile', '-File', powerInstaller], { cwd: repository });
  assert.notEqual(result.code, 0, result.stdout);
  assert.match(result.stdout + '\n' + result.stderr, /No client specified\. Usage: \.\\install\.ps1 -Client <codex\|zcode>/);
});
