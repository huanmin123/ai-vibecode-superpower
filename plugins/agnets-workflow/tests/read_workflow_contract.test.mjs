import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const pluginRoot = fileURLToPath(new URL('..', import.meta.url));
const repositoryRoot = path.resolve(pluginRoot, '..', '..');
const read = relativePath => readFile(path.join(repositoryRoot, relativePath), 'utf8');

test('read workflow is a bounded pure-read route', async () => {
  const skillPath = 'plugins/agnets-workflow/skills/orchestrate-read-workflow/SKILL.md';
  const [skill, metadata] = await Promise.all([
    read(skillPath),
    read('plugins/agnets-workflow/skills/orchestrate-read-workflow/agents/openai.yaml'),
  ]);
  assert.match(skill, /\[workflow-common\.md\]\(\.\.\/workflow-common\.md\)/);
  await access(path.resolve(path.dirname(path.join(repositoryRoot, skillPath)), '../workflow-common.md'));
  assert.match(skill, /单步、单域且无需判断或委派/);
  assert.match(skill, /复杂、可证明纯只读/);
  assert.match(skill, /不调用 MCP/);
  assert.match(skill, /WAL、锁、快照或测试产物/);
  assert.match(skill, /avsp_terra_high.*不得进入/);
  assert.doesNotMatch(skill, /workflow-controller|workflow_(?:init|start|heartbeat|checkpoint|complete|retry|audit_context)/);
  assert.match(metadata, /default_prompt: "使用 \$orchestrate-read-workflow/);
});

test('global entry separates direct reads, read workflow and model workflow', async () => {
  const agents = await read('codex-global-config/AGENTS.md');
  assert.match(agents, /单步、单域且无需判断或委派的纯读/);
  assert.match(agents, /\$orchestrate-read-workflow/);
  assert.match(agents, /\$orchestrate-model-workflow/);
  assert.match(agents, /两者互斥/);
});
