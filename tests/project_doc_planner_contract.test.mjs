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

test('decision records and conflict interception are part of the planner contract', async () => {
  const skill = await read('SKILL.md');
  const architecture = await read('references/doc-architecture.md');
  const index = await read('references/templates/decisions-readme-template.md');
  const record = await read('references/templates/decision-record-template.md');
  const cleanup = await read('references/document-cleanup-guide.md');
  const rootAgents = await read('references/root-agents-template.md');
  const standards = await read('references/development-standards.md');

  assert.match(skill, /docs\/decisions\//);
  assert.match(skill, /decision-record-template\.md/);
  assert.match(skill, /decisions-readme-template\.md/);
  assert.match(skill, /用户当前明确指令优先/);
  assert.match(skill, /不构成否决/);
  assert.match(skill, /不复制契约正文/);
  assert.match(skill, /无条目时保留空索引/);
  assert.match(skill, /当前指令已覆盖目标、范围和副作用/);
  assert.match(skill, /不再二次确认/);
  assert.match(skill, /明确排除项/);
  assert.doesNotMatch(skill, /决策记录优先于用户|冲突时以决策为准/);

  assert.match(architecture, /## 决策记录 `decisions\/`/);
  assert.match(architecture, /├── decisions\//);
  assert.match(architecture, /`D-` \+ 三位递增序号/);
  assert.match(architecture, /创建后不复用/);
  assert.match(architecture, /索引仍是唯一入口/);
  assert.match(architecture, /索引可以暂时为空/);
  assert.match(architecture, /正式状态使用：.*已接受.*已实施.*已被 D-xxx 取代.*已废弃/);
  assert.match(architecture, /草稿.*不能作为冲突检查依据/);
  assert.match(architecture, /含草稿/);
  assert.match(architecture, /用户当前明确指令优先/);
  assert.match(architecture, /不构成否决权/);
  assert.match(architecture, /只对 .*条目判定冲突/);
  assert.match(architecture, /以当前契约为准/);
  assert.match(architecture, /当前指令已覆盖目标、范围和副作用/);
  assert.match(architecture, /当前指令覆盖目标、范围和副作用时按指令执行并同次记录取代/);
  assert.match(architecture, /不再二次确认/);
  assert.match(architecture, /明确排除项/);
  assert.match(architecture, /decisions\/README\.md` 索引与冲突检查规则/);
  assert.match(architecture, /单条决策记录/);
  assert.match(architecture, /decisions\/` 除外/);
  assert.match(architecture, /复核后维持/);
  assert.match(architecture, /部分推翻/);
  assert.match(architecture, /第 2 项由 D-005 取代/);
  assert.match(architecture, /不得静默删除、改写旧条目或用新计划覆盖历史/);
  assert.match(architecture, /不复制契约正文/);
  assert.match(architecture, /reserves\//);
  assert.match(architecture, /在写入前停止/);

  assert.match(index, /决策索引/);
  assert.match(index, /范围 \/ 关键词/);
  assert.match(index, /冲突检查/);
  assert.match(index, /在写入前停止/);
  assert.match(index, /保留原决策/);
  assert.match(index, /用户当前明确指令优先/);
  assert.match(index, /不构成否决权/);
  assert.match(index, /任何条目（含草稿）不删除/);
  assert.match(index, /放弃的草稿标记/);
  assert.match(index, /整条被推翻时/);
  assert.match(index, /部分推翻/);
  assert.match(index, /索引仍是唯一入口/);
  assert.match(index, /#d-001/);
  assert.match(index, /只对 .*条目判定冲突/);
  assert.match(index, /以当前契约为准/);
  assert.match(index, /正式状态只用：.*已接受.*已实施.*已被 D-xxx 取代.*已废弃/);
  assert.match(index, /草稿.*不能作为冲突检查依据/);
  assert.match(index, /创建后不复用/);
  assert.match(index, /第 N 项由 D-xxx 取代/);
  assert.match(index, /当前指令已覆盖目标、范围和副作用/);
  assert.match(index, /不再二次确认/);
  assert.doesNotMatch(index, /冲突时以决策为准/);

  assert.match(record, /备选方案/);
  assert.match(record, /决定/);
  assert.match(record, /理由/);
  assert.match(record, /后果/);
  assert.match(record, /影响/);
  assert.match(record, /复核条件/);
  assert.match(record, /决策者 \/ 批准人/);
  assert.match(record, /D-<三位序号>/);
  assert.match(record, /第 2 项由 D-005 取代/);
  assert.match(record, /转正或放弃后的去向/);
  assert.match(record, /已被 D-xxx 取代/);
  assert.match(record, /放弃的草稿改为/);

  assert.match(cleanup, /决策条目（含草稿）默认长期保留/);
  assert.match(cleanup, /不能删除或原地改写结论/);
  assert.match(cleanup, /决策记录（含草稿）不适用上述合并、归档或删除动作/);
  assert.match(cleanup, /docs\/decisions\/` 下的条目除外/);
  assert.match(cleanup, /下的任何条目（含草稿）不适用/);
  assert.match(cleanup, /决策草稿除外/);
  assert.match(cleanup, /部分判断被推翻/);
  assert.match(cleanup, /储备引用/);

  assert.match(rootAgents, /docs\/decisions\/README\.md/);
  assert.match(rootAgents, /用户当前明确指令优先/);
  assert.match(rootAgents, /不构成否决/);
  assert.match(rootAgents, /当前指令已覆盖目标、范围和副作用/);
  assert.match(rootAgents, /不再二次确认/);
  assert.match(rootAgents, /明确排除项/);
  assert.match(rootAgents, /架构、模块、功能契约或架构方向变化/);
  assert.match(rootAgents, /同一行包含多个入口时只删去不存在的链接/);

  assert.match(standards, /启用 `docs\/decisions\/` 时/);
  assert.match(standards, /用户当前明确指令优先/);
  assert.match(standards, /不构成否决/);
  assert.match(standards, /当前指令已覆盖目标、范围和副作用/);
  assert.match(standards, /不再二次确认/);
  assert.match(standards, /明确排除项/);
  assert.match(standards, /决策记录解释历史和取舍/);
  assert.match(standards, /不替代当前契约/);
});

test('decision extraction keeps specs, plans, reports and records on one boundary', async () => {
  const skill = await read('SKILL.md');
  const architecture = await read('references/doc-architecture.md');
  const standards = await read('references/development-standards.md');
  const cleanup = await read('references/document-cleanup-guide.md');
  const rootAgents = await read('references/root-agents-template.md');
  const design = await read('references/templates/feature-design-template.md');
  const overview = await read('references/templates/architecture-overview-template.md');
  const plan = await read('references/templates/plan-template.md');
  const report = await read('references/templates/report-template.md');
  const bug = await read('references/templates/bug-template.md');
  const refactor = await read('references/templates/refactor-template.md');
  const todo = await read('references/templates/todo-blockers-template.md');
  const reserve = await read('references/templates/reserve-items-template.md');
  const record = await read('references/templates/decision-record-template.md');
  const index = await read('references/templates/decisions-readme-template.md');

  assert.match(skill, /符合记录边界的长期判断也抽到这里/);
  assert.match(architecture, /符合记录边界.*均指会约束后续工作/);
  assert.match(architecture, /符合记录边界的方向判断/);
  assert.match(architecture, /以下涉及 `decisions\/` 的规则仅在项目启用该目录时适用/);
  assert.match(architecture, /涉及 `decisions\/` 的行仅在项目启用该目录时适用/);
  assert.doesNotMatch(architecture, /会约束后续工作的方向判断按「决策记录」/);
  assert.doesNotMatch(architecture, /会约束后续工作的方向判断先转入/);
  assert.match(architecture, /计划、问题、重构、报告、储备条目和待办裁决/);
  assert.match(architecture, /抽到 `decisions\/`/);
  assert.match(architecture, /若同时改变稳定行为契约，先更新 `functions\/` 设计/);
  assert.match(architecture, /`已接受` 表示方向成立但未必已实施/);
  assert.match(architecture, /多条决策重叠时，不合并删除/);

  assert.match(design, /关联决策/);
  assert.match(design, /取舍结论/);
  assert.match(design, /符合记录边界/);
  assert.match(design, /定义见 `docs\/decisions\/README\.md` 规则 1/);
  assert.match(design, /不建决策/);
  assert.match(design, /生效前补 D-ID/);
  assert.match(design, /未启用时，在本表保留最小采用理由和放弃方案/);
  assert.doesNotMatch(design, /会约束后续工作且理由不能由当前契约完整表达/);

  assert.match(overview, /关键选择与取舍/);
  assert.match(overview, /符合记录边界/);
  assert.match(overview, /定义见 `docs\/decisions\/README\.md` 规则 1/);
  assert.match(overview, /对架构 \/ 契约的影响/);
  assert.match(overview, /决策记录仅作历史依据链接/);
  assert.match(overview, /未启用时，在本表保留最小采用理由和替代方案/);
  assert.doesNotMatch(overview, /会约束后续工作且理由不能由当前契约完整表达/);

  assert.match(plan, /关联决策/);
  assert.match(plan, /符合记录边界的判断/);
  assert.match(plan, /符合记录边界的长期方向判断/);
  assert.match(plan, /执行决策/);
  assert.match(plan, /未启用时，把长期判断回写 spec\/architecture/);

  assert.match(report, /决策记录：/);
  assert.match(report, /符合记录边界/);
  assert.match(report, /必须已在 spec 或 decisions 落位/);
  assert.match(report, /未启用时回写 spec\/architecture/);

  assert.match(bug, /关联决策：D-xxx/);
  assert.match(bug, /修复确立符合记录边界的判断/);
  assert.match(bug, /创建或更新 `functions\/` 设计/);
  assert.match(bug, /未启用时，把结论回写 spec\/architecture/);

  assert.match(refactor, /关联决策：D-xxx/);
  assert.match(refactor, /重构确立符合记录边界的判断/);
  assert.match(refactor, /创建或更新 `functions\/` 设计/);
  assert.match(refactor, /未启用时，把结论回写 spec\/architecture/);

  assert.match(todo, /裁决符合记录边界时建立决策记录/);
  assert.match(todo, /未启用时回写对应设计或保留在档案/);
  assert.match(reserve, /规则 8/);
  assert.match(reserve, /符合记录边界的判断/);
  assert.match(reserve, /普通的优先级、资源或时效原因不建决策/);
  assert.match(reserve, /未启用时，把长期理由回写对应设计/);

  assert.match(standards, /符合记录边界.*方向判断和被否方案写入决策记录/);
  assert.match(standards, /修复确立符合记录边界的判断/);
  assert.match(standards, /重构确立符合记录边界的判断/);
  assert.match(cleanup, /不适用上述草稿删除、已废弃归档\/删除和合并删除规则/);
  assert.match(cleanup, /多条决策重叠时新增一条整合决策/);
  assert.match(cleanup, /符合记录边界的裁决先转入 `decisions\/`/);
  assert.match(cleanup, /符合记录边界的放弃理由先转入 `decisions\/`/);
  assert.match(cleanup, /已实施决策与当前契约内容仍一致/);
  assert.match(cleanup, /以下涉及 `docs\/decisions\/` 的规则仅在项目启用该目录时适用/);
  assert.match(index, /符合记录边界/);
  assert.match(index, /已实施决策与当前契约是否仍一致/);
  assert.match(record, /已接受（方向成立，未必已实施）/);
  assert.match(record, /已实施（已落地并与当前契约一致）/);
  assert.match(record, /草稿` 仅候选，不作冲突检查依据/);
  assert.match(rootAgents, /长期决策见 `docs\/decisions\/`/);
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
