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

test('local private layer boundary is part of the planner contract', async () => {
  const skill = await read('SKILL.md');
  const resources = await read('references/local-project-resources.md');
  assert.match(skill, /`\.local\/` 是整体 Git 忽略的私有层/);
  assert.match(skill, /`tmp\/` 与 `project-resources\/` 是固定成员/);
  assert.match(resources, /`\.local\/` 私有层布局/);
  assert.match(resources, /\/\.local\/`/);
  assert.match(resources, /私密交付物/);
  assert.match(resources, /`<env>\/logs\/`|releases\/<版本>\//);
});

test('reserve register for conditional future work is part of the planner contract', async () => {
  const skill = await read('SKILL.md');
  const architecture = await read('references/doc-architecture.md');
  const template = await read('references/templates/reserve-items-template.md');
  const cleanup = await read('references/document-cleanup-guide.md');

  assert.match(skill, /reserve-items-template\.md/);
  assert.match(architecture, /docs\/储备与触发事项\.md/);
  assert.match(architecture, /储备与触发事项\.md[\s\S]*reserve-items-template\.md/);
  assert.match(architecture, /`R` \+ 递增序号/);
  assert.match(template, /当前不做/);
  assert.match(template, /触发条件/);
  assert.match(template, /方案失效条件/);
  assert.match(template, /技术方案/);
  assert.match(template, /可独立开工/);
  assert.match(template, /只有一句描述、没有技术方案的条目不得进入本清单/);
  assert.match(template, /几句话说不清/);
  assert.match(template, /储备方案-<短标题>/);
  assert.match(template, /reserves\//);
  assert.match(template, /完整方案/);
  assert.match(template, /状态：草稿/);
  assert.match(template, /`R` \+ 递增序号/);
  assert.match(template, /代码 TODO/);
  assert.match(template, /待办与阻塞事项/);
  assert.match(template, /储备方案不是契约/);
  assert.match(architecture, /reserves\/储备方案-<短标题>/);
  assert.match(architecture, /├── reserves\//);
  assert.match(architecture, /`reserves\/` 保存尚未转正的储备方案草稿/);
  assert.match(architecture, /不得按未引用草稿清理/);
  assert.match(cleanup, /储备与触发事项\.md/);
  assert.match(cleanup, /`docs\/reserves\/` 中、被在用储备条目引用的草稿/);
  assert.match(cleanup, /`reserves\/` 储备方案草稿/);
});

test('reserve promotion preserves the spec boundary and plan-only exception', async () => {
  const template = await read('references/templates/reserve-items-template.md');
  const promotionRule = template.match(/^7\. .+$/m)?.[0] ?? '';

  assert.match(promotionRule, /涉及稳定契约变化时，必须先创建或更新功能设计（spec）再实施/);
  assert.match(promotionRule, /只有不改变 API、schema、权限、UI、错误语义和稳定质量指标的文档整理、机械性整理或内部重构，才可使用 plan-only/);
  assert.doesNotMatch(template, /条目转正时必须先按 SDD 流程落 spec/);
  assert.doesNotMatch(template, /先建功能设计或计划再实施/);
});

test('external-facing resources directory is part of the planner contract', async () => {
  const skill = await read('SKILL.md');
  const architecture = await read('references/doc-architecture.md');
  const template = await read('references/templates/external-docs-readme-template.md');
  const cleanup = await read('references/document-cleanup-guide.md');
  const rootAgents = await read('references/root-agents-template.md');

  assert.match(skill, /`external\/`（与 `docs\/`、`\.local\/` 平级的仓库根目录）保存面向外部使用者的交付资料/);
  assert.match(skill, /不读取、不检查、不主动更新/);
  assert.match(skill, /external-docs-readme-template\.md/);
  assert.match(architecture, /## 对外资料 `external\/`/);
  assert.match(architecture, /与 `docs\/`、`\.local\/` 平级/);
  assert.match(architecture, /不放入 `docs\/` 的原因/);
  assert.match(architecture, /├── external\//);
  assert.match(architecture, /不读取、不检查、不主动更新/);
  assert.match(architecture, /以内部契约为准/);
  assert.match(architecture, /脱敏/);
  assert.match(template, /仓库根 `external\/README\.md`/);
  assert.match(template, /资料索引/);
  assert.match(template, /不读取、不检查、不主动更新/);
  assert.match(template, /脱敏/);
  assert.match(template, /索引与实际文件不一致视为缺陷/);
  assert.match(cleanup, /`external\/` 的对外资料/);
  assert.match(cleanup, /已分发副本/);
  assert.match(rootAgents, /仓库根 `external\/README\.md`/);
  assert.match(rootAgents, /AI 日常不读取、不主动同步/);
});
