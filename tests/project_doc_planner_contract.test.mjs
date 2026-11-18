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

// Match related requirements in one paragraph or list item, regardless of numbering or wrapping.
function assertGuidance(markdown, subject, ...requirements) {
  const passages = markdown.split(/\n\s*\n|^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/m)
    .map(passage => passage.replace(/\r?\n[ \t]*/g, ''));
  const matches = passages.some(passage =>
    subject.test(passage) && requirements.every(requirement => requirement.test(passage)));
  assert.ok(matches, 'Missing guidance for ' + subject + ' with ' + requirements.join(', '));
}

test('project doc planner defines the SDD layer boundaries', async () => {
  const skill = await read('SKILL.md');
  assert.match(skill, /SDD 分层/);
  assert.match(skill, /定性与定量是内容属性/);
  assert.match(skill, /计划不得越权成为需求来源/);
  assert.match(skill, /waiver 只接受执行风险/);
  assert.match(skill, /API、schema、权限、UI、错误语义/);
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
  assertGuidance(plan, /定量项/, /契约/, /阈值/, /环境/, /样本/, /实际值/, /证据/);

  assert.match(report, /环境|样本|命令|原始产物/);
  assert.match(report, /实际|证据|边界/);
});

test('lightweight delivery and conditional baseline remain distinct', async () => {
  const skill = await read('SKILL.md');
  const architecture = await read('references/doc-architecture.md');
  const plan = await read('references/templates/plan-template.md');
  const standards = await read('references/development-standards.md');

  assertGuidance(skill, /低风险任务/, /diff/, /验证结果/);
  assertGuidance(architecture, /稳定行为变化/, /先更新.*契约/, /再实施/);
  assert.match(standards, /低风险.*直接实施并验证.*交付中说明结果/);

  const [normalPlan, baseline] = plan.split(/^#{2,6}[ \t]+.*追溯基线.*$/m);
  assert.ok(baseline, 'the optional baseline section must exist');
  for (const field of ['范围', '验收', '验证', '结果']) {
    assert.match(normalPlan, new RegExp(`^[-*]\\s+${field}\\s*[：:]`, 'm'));
  }
  assert.doesNotMatch(normalPlan, /SHA-256|快照 hash|精确.*AC\/NFR/);
  assertGuidance(baseline, /逐项追溯/, /跨版本/, /多人/, /明确追溯要求/, /验证/, /证据/);
  assertGuidance(baseline, /SHA-256/, /范围/, /可重算/, /无独立设计.*删除/);
  assertGuidance(baseline, /AC\/NFR/, /精确/, /plan-only/, /本次验收条件/);
  assertGuidance(baseline, /设计变更/, /重新验证/);
  assertGuidance(architecture, /plan-only/, /没有独立设计/, /追踪.*验收条件/);
});

test('document cleanup guidance is part of the planner contract', async () => {
  const architecture = await read('references/doc-architecture.md');
  const cleanup = await read('references/document-cleanup-guide.md');
  assert.match(architecture, /document-cleanup-guide\.md/);
  assert.match(architecture, /生命周期|清理|归档/);
  assert.match(cleanup, /保留|合并|归档|废弃|删除/);
  assert.match(cleanup, /引用|基线|证据|可恢复/);
  assert.match(cleanup, /预检|执行步骤|审计/);
  const guidance = cleanup.split('## 清理前证据与恢复性')[1].split('## 执行步骤')[0];
  assertGuidance(guidance, /修正.*失效.*链接/, /目标文件/, /锚点/, /验证结果/, /无需.*计划或审计记录/);
  assert.match(guidance, /普通内部文档.*可恢复改名、移动.*同次变更.*原因.*入链、恢复性和验证.*无需单独建立计划/);
  assert.match(guidance, /已发布入口、冻结基线、历史证据.*清理前准备影响与恢复计划/);
  assert.match(guidance, /无法确认影响、授权或恢复能力时.*先解决未知项/);
  assert.match(guidance, /暂存、未暂存和未跟踪的内容均可恢复/);
  assert.match(cleanup, /迁移链接.*改名原因.*新路径.*验证结果/);
});

test('directory entry pages are created only when they have a purpose', async () => {
  const skill = await read('SKILL.md');
  const architecture = await read('references/doc-architecture.md');
  const template = await read('references/templates/dir-readme-template.md');

  assert.match(architecture, /阅读顺序.*维护规则.*当前与历史.*按需建立 `README\.md`/);
  assert.match(architecture, /父级.*项目根入口直接链接/);
  assert.match(skill, /\]\(references\/doc-architecture\.md\)/);
  assert.match(template, /按实际职责裁剪章节/);
  for (const text of [skill, template]) {
    assert.doesNotMatch(text, /每个保留.*目录.*(?:都有|必须.*)\s*`README\.md`/);
  }
  assert.match(template, /保留已有项目专用索引及其维护义务/);
  assert.doesNotMatch(template, /新文件在本表登记后才算交付完成/);
});

test('stable contract changes reuse the project authority before considering a new document', async () => {
  const skill = await read('SKILL.md');
  const architecture = await read('references/doc-architecture.md');
  const plan = await read('references/templates/plan-template.md');
  const design = await read('references/templates/feature-design-template.md');
  const bug = await read('references/templates/bug-template.md');
  const refactor = await read('references/templates/refactor-template.md');

  assert.match(skill, /(?:已有|现有).*权威(?:设计|契约)/);
  assert.match(architecture, /既有长期契约优先沿用项目的权威文档.*没有合适文档时.*创建.*`functions\/` 是可选/);
  assert.match(plan, /先更新现有权威设计.*缺少设计时创建相应契约/);
  assert.match(design, /优先更新项目已有的权威契约.*没有适用契约.*创建.*`docs\/functions\/` 是候选位置/);
  for (const template of [bug, refactor]) {
    assert.match(template, /(?:更新|沿用).*(?:现有|已有).*权威(?:设计|契约)/);
  }
  for (const template of [design, bug, refactor]) {
    assert.doesNotMatch(template, /(?:必须|先|始终).*(?:创建|更新).*`(?:docs\/)?functions\/` 设计/);
  }
});

test('report and reserve templates retain optional directory indexes', async () => {
  const report = await read('references/templates/report-template.md');
  const reserve = await read('references/templates/reserve-items-template.md');

  assert.match(report, /项目实际入口可访问.*已有适用索引时同步登记/);
  assert.match(reserve, /清单条目中链接.*已有适用目录索引时同步登记/);
  assert.doesNotMatch(report, /目录 README 的文件索引登记后才算交付完成/);
  assert.doesNotMatch(reserve, /(?:必须|应当|须)在.*目录 README 索引登记/);
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

test('secret persistence requires verified effective access before any plaintext write', async () => {
  const resources = await read('references/local-project-resources.md');
  const rootAgents = await read('references/root-agents-template.md');
  assert.match(resources, /Git 忽略.*不.*访问权限/);
  assert.match(resources, /已有目标文件.*父路径.*有效 ACL/);
  assert.match(resources, /创建时.*原子.*受限权限/);
  assert.match(resources, /检查失败或无法确认.*停止.*明文/s);
  assert.match(resources, /显式授权的共享范围/);
  assert.match(resources, /密钥管理器.*只登记引用/);
  assert.match(resources, /不要求用户重复提供/);
  assert.match(rootAgents, /访问检查.*权威/);
  assert.doesNotMatch(rootAgents, /私密交付物写入对应私有目录并登记/);
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
  assertGuidance(template, /新增条目/, /价值/, /触发条件/, /关键未知/, /没有方案时/);
  assertGuidance(template, /决定启动后/, /补齐.*方案/, /验证方式/);
  assert.doesNotMatch(template, /没有技术方案的条目不得进入|未来执行者不必重新调研即可开工/);
  assert.match(template, /储备方案-<短标题>/);
  assert.match(template, /reserves\//);
  assert.match(template, /状态：草稿/);
  assert.match(template, /`R` \+ 递增序号/);
  assert.match(template, /代码 TODO/);
  assert.match(template, /待办与阻塞事项/);
  assert.match(template, /储备方案不是契约/);
  assert.match(architecture, /reserves\/储备方案-<短标题>/);
  assert.match(architecture, /`reserves\/` 可保存尚未转正的储备方案草稿/);
  assert.match(architecture, /不得按未引用草稿清理/);
  assert.match(cleanup, /储备与触发事项\.md/);
  assert.match(cleanup, /`docs\/reserves\/` 中、被在用储备条目引用的草稿/);
  assert.match(cleanup, /`reserves\/` 储备方案草稿/);
});

test('reserve promotion preserves the spec boundary and plan-only exception', async () => {
  const template = await read('references/templates/reserve-items-template.md');
  assertGuidance(template, /条目转正.*稳定契约变化/, /先更新.*权威契约/, /没有适用契约.*创建/, /再实施/);
  assertGuidance(template, /才可使用 plan-only/, /不改变 API/, /schema/, /权限/, /UI/, /错误语义/, /稳定质量指标/);
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
  assert.match(skill, /即使没有条目也能在项目内找到并执行规则/);
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
  assert.match(architecture, /decisions\/README\.md` 索引与冲突检查规则/);
  assert.match(architecture, /单条决策记录/);
  assert.match(architecture, /复核后维持/);
  assert.match(architecture, /部分推翻/);
  assert.match(architecture, /第 2 项由 D-005 取代/);
  assert.match(architecture, /不复制契约正文/);
  assert.match(architecture, /reserves\//);

  assert.match(index, /决策索引/);
  assert.match(index, /范围 \/ 关键词/);
  assert.match(index, /冲突检查/);
  assert.match(index, /任何条目（含草稿）不删除/);
  assert.match(index, /放弃的草稿标记/);
  assert.match(index, /部分推翻/);
  assert.match(index, /索引仍是唯一入口/);
  assert.match(index, /#d-001/);
  assert.match(index, /正式状态只用：.*已接受.*已实施.*已被 D-xxx 取代.*已废弃/);
  assert.match(index, /草稿.*不能作为冲突检查依据/);
  assert.match(index, /创建后不复用/);
  assert.match(index, /第 N 项由 D-xxx 取代/);
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
  assert.match(rootAgents, /架构边界、稳定契约、权限或存储策略、产品范围或明确排除项发生变化/);
  assert.match(rootAgents, /同一行包含多个入口时只删去不存在的链接/);

  assert.match(standards, /启用 `docs\/decisions\/` 时/);
});

test('decision conflict rules route to an authoritative section for a self-contained project index', async () => {
  const skill = await read('SKILL.md');
  const architecture = await read('references/doc-architecture.md');
  const indexTemplate = await read('references/templates/decisions-readme-template.md');
  const rootAgents = await read('references/root-agents-template.md');
  const standards = await read('references/development-standards.md');

  assert.match(skill, /\]\(references\/doc-architecture\.md#决策记录-decisions\)/);
  assert.match(architecture, /^## 决策记录 `decisions\/`$/m);
  assert.match(standards, /\]\(doc-architecture\.md#冲突检查与取代\)/);
  assert.match(rootAgents, /\]\(docs\/decisions\/README\.md#冲突检查\)/);
  const projectSection = '## 冲突检查';
  const instruction = indexTemplate.match(/^## 冲突检查\n\n(> [^\n]+)/m)?.[1];
  assert.ok(instruction, 'the project index must explain how to populate its conflict section');
  assert.match(instruction, /\]\(\.\.\/doc-architecture\.md#冲突检查与取代\)/);
  assert.match(instruction, /完整正文.*替换/);
  for (const route of [skill, standards, rootAgents, indexTemplate]) {
    assert.doesNotMatch(route, /不再二次确认/);
  }

  const [, conflictSection] = architecture.split(/^### 冲突检查与取代\s*$/m);
  assert.ok(conflictSection, 'the linked decision conflict section must exist');
  const conflictRules = conflictSection.split(/^#{1,3} /m)[0].trim();
  assert.match(conflictRules, /架构边界.*稳定契约.*权限\/存储策略.*产品范围.*明确排除项/);
  assert.match(conflictRules, /只对 `已接受`\/`已实施`.*判定冲突/);
  assert.match(conflictRules, /用户当前明确指令优先/);
  assert.match(conflictRules, /当前指令已覆盖目标、范围和副作用.*按指令执行.*同一交付.*取代.*不再二次确认/);
  assert.match(conflictRules, /指令含糊.*授权不清.*写入前停止/);
  assert.match(conflictRules, /整条被推翻.*互链.*部分推翻.*逐项标注.*更新索引和受影响契约/);
  assert.doesNotMatch(conflictRules, /\]\([^)]*(?:doc-architecture\.md|skills\/project-doc-planner|references\/)[^)]*\)/, 'copied rules must not depend on skill-local links');
  assert.doesNotMatch(conflictRules, /按「条目与索引」/, 'copied rules must stand alone');
  const indexContent = indexTemplate.replace(instruction, () => conflictRules);
  assert.ok(indexContent.includes(`${projectSection}\n\n${conflictRules}`));
  assert.doesNotMatch(indexContent, /\.\.\/doc-architecture\.md/);
  const availableHeadings = new Set([...indexContent.matchAll(/^#{1,6} (.+)$/gm)]
    .map(([, heading]) => heading.trim().toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s+/g, '-')));
  for (const [, anchor] of indexContent.matchAll(/<a\s+id=["']([^"']+)["']\s*>/gi)) {
    availableHeadings.add(anchor);
  }
  for (const [, anchor] of conflictRules.matchAll(/\]\(#([^)]+)\)/g)) {
    assert.ok(availableHeadings.has(decodeURIComponent(anchor)), `local anchor #${anchor} must exist in the project index`);
  }
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

  assert.match(skill, /符合记录边界/);
  assert.match(architecture, /符合记录边界.*均指会约束后续工作/);
  assert.match(architecture, /符合记录边界的方向判断/);
  assert.match(architecture, /以下涉及 `decisions\/` 的规则仅在项目启用该目录时适用/);
  assert.match(architecture, /涉及 `decisions\/` 的行仅在项目启用该目录时适用/);
  assert.doesNotMatch(architecture, /会约束后续工作的方向判断按「决策记录」/);
  assert.doesNotMatch(architecture, /会约束后续工作的方向判断先转入/);
  assert.match(architecture, /计划、问题、重构、报告、储备条目和待办裁决/);
  assert.match(architecture, /抽到 `decisions\/`/);
  assert.match(architecture, /若同时改变稳定行为契约，先更新项目现有权威设计.*缺少时创建/);
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
  assert.match(plan, /执行决策|执行选择/);
  assert.match(plan, /未启用时，把长期判断回写 spec\/architecture/);

  assert.match(report, /决策记录：/);
  assert.match(report, /符合记录边界/);
  assert.match(report, /必须已在权威契约或决策记录落位/);
  assert.match(report, /未启用时回写 spec\/architecture/);

  assert.match(bug, /关联决策：D-xxx/);
  assert.match(bug, /修复确立符合记录边界的判断/);
  assert.match(bug, /未启用时，把结论回写现有权威契约/);

  assert.match(refactor, /关联决策：D-xxx/);
  assert.match(refactor, /重构确立符合记录边界的判断/);
  assert.match(refactor, /未启用时，把结论回写现有权威契约/);

  assert.match(todo, /裁决符合记录边界时建立决策记录/);
  assert.match(todo, /未启用时回写对应设计或保留在档案/);
  assert.match(reserve, /长期取舍.*决策记录规则/);
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
