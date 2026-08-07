import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const pluginRoot = fileURLToPath(new URL('..', import.meta.url));
const repositoryRoot = path.resolve(pluginRoot, '..', '..');
const read = relativePath => readFile(path.join(repositoryRoot, relativePath), 'utf8');

test('project-doc-planner has exactly one plugin source path', async () => {
  await access(path.join(repositoryRoot, 'plugins/agnets-workflow/skills/project-doc-planner/SKILL.md'));
  await assert.rejects(access(path.join(repositoryRoot, 'skills/project-doc-planner/SKILL.md')));
  const rootReadme = await read('README.md');
  assert.match(rootReadme, /plugins\/agnets-workflow\/skills\/project-doc-planner\/SKILL\.md/);
  assert.doesNotMatch(rootReadme, /\]\(skills\/project-doc-planner\/SKILL\.md\)/);
});

test('installers classify planner as a plugin skill', async () => {
  const [powershell, posix] = await Promise.all([
    read('install-codex.ps1'),
    read('install-codex.sh'),
  ]);
  const standaloneBlock = powershell.match(/\$managedStandaloneSkillNames\s*=\s*@\(([\s\S]*?)\)/)?.[1] ?? '';
  assert.match(powershell, /\$managedPluginSkillNames\s*=\s*@\([\s\S]*?'project-doc-planner'[\s\S]*?\)/);
  assert.doesNotMatch(standaloneBlock, /project-doc-planner/);
  assert.match(posix, /managed_plugin_skill_names='[^']*project-doc-planner/);
  assert.match(posix, /managed_standalone_skill_names='gpt-image-2-cli'/);
  assert.doesNotMatch(posix, /managed_standalone_skill_names='[^']*project-doc-planner/);
});

test('plugin metadata and MCP binding use the same cachebuster', async () => {
  const [manifestText, mcp] = await Promise.all([
    read('plugins/agnets-workflow/.codex-plugin/plugin.json'),
    read('plugins/agnets-workflow/.mcp.json'),
  ]);
  const manifest = JSON.parse(manifestText);
  assert.match(manifest.version, /^0\.2\.0\+codex\.[0-9a-z-]+$/);
  assert.match(manifestText, /project-doc-planner/);
  assert.ok(mcp.includes(`version='${manifest.version}'`));
});

test('plugin keeps the three mutually exclusive workflow entry points', async () => {
  const [readme, readSkill, modelSkill] = await Promise.all([
    read('plugins/agnets-workflow/README.md'),
    read('plugins/agnets-workflow/skills/orchestrate-read-workflow/SKILL.md'),
    read('plugins/agnets-workflow/skills/orchestrate-model-workflow/SKILL.md'),
  ]);
  assert.match(readme, /三种/);
  assert.match(readme, /orchestrate-read-workflow/);
  assert.match(readme, /orchestrate-model-workflow/);
  assert.match(readSkill, /复杂、可证明纯只读/);
  assert.match(readSkill, /不调用 MCP/);
  assert.match(modelSkill, /任何状态变更/);
  assert.match(modelSkill, /两条工作流互斥/);
});
