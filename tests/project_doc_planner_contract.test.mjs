import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const planner = path.join(repository, 'shared', 'skills', 'project-doc-planner');

async function read(relativePath) {
  return readFile(path.join(planner, relativePath), 'utf8');
}

test('project doc planner defines the SDD layer boundaries', async () => {
  const skill = await read('SKILL.md');
  assert.match(skill, /SDD 分层/);
  assert.match(skill, /定性与定量是内容属性/);
  assert.match(skill, /计划不得越权成为需求来源/);
  assert.match(skill, /waiver 只接受执行风险/);
  assert.match(skill, /API、schema、权限、UI、错误语义/);
  assert.match(skill, /设计基线必须可冻结和复核/);
  assert.match(skill, /定性与定量的职责分工/);
  assert.match(skill, /需求\/设计（spec）.*计划（plan）.*报告（report）/s);
  assert.match(skill, /排除 hash 字段本身|hash 字段本身/);
  assert.match(skill, /document-cleanup-guide\.md/);
});

test('design and plan templates expose stable baselines and quantitative evidence fields', async () => {
  const design = await read('references/templates/feature-design-template.md');
  const plan = await read('references/templates/plan-template.md');
  const report = await read('references/templates/report-template.md');

  assert.match(design, /NFR-ID|量化|指标/);
  assert.match(design, /单位/);
  assert.match(design, /目标|阈值/);
  assert.match(design, /定量判定（如适用）/);
  assert.match(design, /运算符.*阈值\/目标.*基线\/对照.*条件和测量方法/);
  assert.match(design, /MUST|SHOULD|OUT-OF-SCOPE/);
  assert.match(design, /revision|hash|基线/i);

  assert.match(plan, /plan-only|无独立需求|waiver/);
  assert.match(plan, /waiver 不能授权计划定义长期契约/);
  assert.match(plan, /revision|hash|AC\/NFR|精确/gi);
  assert.match(plan, /算法与范围|规范化方式/);
  assert.match(plan, /环境|样本|实际值|证据/);
  assert.match(plan, /需求\/设计.*AC.*任务.*验证.*证据|追踪/);

  assert.match(report, /环境|样本|命令|原始产物/);
  assert.match(report, /实际|证据|边界/);
});

test('document cleanup guidance is part of the planner contract', async () => {
  const architecture = await read('references/doc-architecture.md');
  const cleanup = await read('references/document-cleanup-guide.md');
  assert.match(architecture, /document-cleanup-guide\.md/);
  assert.match(architecture, /生命周期|清理|归档/);
  assert.match(cleanup, /保留|合并|归档|废弃|删除/);
  assert.match(cleanup, /引用|基线|证据|可恢复/);
  assert.match(cleanup, /docs\/plans\/.*PLAN/);
  assert.match(cleanup, /预检|执行步骤|审计/);
});
