import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const pluginRoot = fileURLToPath(new URL('..', import.meta.url));
const repositoryRoot = path.resolve(pluginRoot, '..', '..');
const root = 'plugins/agnets-workflow/skills';
const read = relativePath => readFile(path.join(repositoryRoot, relativePath), 'utf8');
const targets = [
  'workflow-controller/references/task-lifecycle.md',
  'workflow-controller/references/recovery.md',
  'workflow-controller/references/total-review.md',
  'workflow-controller/references/storage-maintenance.md',
];

test('workflow skills stay compact and link their direct authorities', async () => {
  const paths = ['workflow-common.md', 'orchestrate-read-workflow/SKILL.md', 'orchestrate-model-workflow/SKILL.md', 'workflow-controller/SKILL.md'];
  const limits = [2300, 1300, 4200, 4200];
  for (const [index, relative] of paths.entries()) {
    const content = await read(`${root}/${relative}`);
    assert.ok(content.length <= limits[index], `${relative} exceeds ${limits[index]} characters`);
    assert.ok(content.split(/\r?\n/).every(line => line.length <= 500), `${relative} has a line over 500 characters`);
  }
  const controller = await read(`${root}/workflow-controller/SKILL.md`);
  for (const target of targets) {
    assert.ok(controller.includes(`](references/${path.basename(target)})`));
    await access(path.join(repositoryRoot, root, target));
  }
  const model = await read(`${root}/orchestrate-model-workflow/SKILL.md`);
  assert.match(model, /\[workflow-controller\]\(\.\.\/workflow-controller\/SKILL\.md\)/);
  assert.match(model, /description: ".*任何状态变更.*无法证明纯只读.*持久控制.*恢复.*任务级总审/);
  assert.doesNotMatch(model, /evidence-manifest|sol_review_cli|hard-timeout|workflow_completion/);
});

test('authority boundaries and required stateful gates remain explicit', async () => {
  const [common, readSkill, model, lifecycle, recovery, review, storage] = await Promise.all([
    read(`${root}/workflow-common.md`),
    read(`${root}/orchestrate-read-workflow/SKILL.md`),
    read(`${root}/orchestrate-model-workflow/SKILL.md`),
    read(`${root}/${targets[0]}`), read(`${root}/${targets[1]}`),
    read(`${root}/${targets[2]}`), read(`${root}/${targets[3]}`),
  ]);
  assert.match(common, /状态变更包括/);
  assert.match(common, /路由判定早于执行授权/);
  assert.match(common, /连续性不完整.*先进入.*orchestrate-model-workflow.*只读恢复诊断/);
  assert.doesNotMatch(readSkill, /workflow-controller|workflow_ensure_context/);
  for (const term of ['workflow_ensure_context', 'execution_contract', 'delegable', 'protected', 'execution_owner', 'fork_turns="none"', '真实终态', '独立 Sol', '不得关闭']) assert.match(model, new RegExp(term));
  assert.match(model, /上下文不足.*只读盘点.*写入前停止.*不是退回无工作流状态/);
  for (const term of ['workflow_init', 'workflow_ready', 'workflow_start', 'workflow_heartbeat', 'workflow_checkpoint', 'workflow_complete', 'native_agent_finished']) assert.match(lifecycle, new RegExp(term));
  for (const term of ['workflow_ensure_context', 'workflow_stale', 'workflow_requeue_stale', 'workflow_rescue', 'workflow_release_workspace', 'workflow_recover_lock', 'workflow_doctor']) assert.match(recovery, new RegExp(term));
  assert.match(recovery, /状态库或必要状态不可读.*停止恢复或替换/);
  for (const term of ['workflow_audit_context', 'workflow_record_review', 'workflow_retry', 'workflow_complete', 'workflow_close_check', 'sol_review_cli']) assert.match(review, new RegExp(term));
  assert.match(review, /不得在已冻结的被审工作区执行可能写入的命令/);
  for (const term of ['SQLite', '原子', 'workspace-lease', 'prune', '隔离', 'evidence-manifest', '512']) assert.match(storage, new RegExp(term));
  assert.doesNotMatch(lifecycle, /workflow_requeue_stale|workflow_audit_context|SQLite/);
  assert.doesNotMatch(recovery, /workflow_record_review|evidence-manifest/);
  assert.doesNotMatch(review, /SQLite|workspace-lease/);
});
