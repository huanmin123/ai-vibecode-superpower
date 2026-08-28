import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const SCHEMA_VERSION = 1;
const ARM_IDS = ['baseline', 'assisted'];
const CATEGORIES = [
  'single_file',
  'event_lifecycle',
  'configuration',
  'database',
  'async',
  'cross_service',
];
const OBSERVATIONS = new Set(['present', 'absent', 'unknown']);
const MAX_EVIDENCE_PACKET_CHARS = 100_000;

export class BenchmarkValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BenchmarkValidationError';
  }
}

function fail(location, message) {
  throw new BenchmarkValidationError(`${location}: ${message}`);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireObject(value, location) {
  if (!isObject(value)) fail(location, 'must be an object');
  return value;
}

function requireArray(value, location) {
  if (!Array.isArray(value)) fail(location, 'must be an array');
  return value;
}

function requireString(value, location) {
  if (typeof value !== 'string' || value.trim() === '') fail(location, 'must be a non-empty string');
  return value;
}

function requireInteger(value, location, minimum = 0) {
  if (!Number.isInteger(value) || value < minimum) fail(location, `must be an integer >= ${minimum}`);
  return value;
}

function requireFiniteNumber(value, location, minimum = 0) {
  if (!Number.isFinite(value) || value < minimum) fail(location, `must be a finite number >= ${minimum}`);
  return value;
}

function requireSha256(value, location) {
  const digest = requireString(value, location).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(digest)) fail(location, 'must be a 64-character SHA-256 hex digest');
  return digest;
}

function requireAllowedKeys(value, allowed, location) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(location, `unknown field ${JSON.stringify(key)}`);
  }
}

function requireUniqueStrings(values, location) {
  const seen = new Set();
  for (const [index, value] of values.entries()) {
    const item = requireString(value, `${location}[${index}]`);
    if (seen.has(item)) fail(`${location}[${index}]`, `duplicate value ${JSON.stringify(item)}`);
    seen.add(item);
  }
}

function normalizeRepositoryPath(value, location) {
  const raw = requireString(value, location).replaceAll('\\', '/');
  // Models often report a source location as `path/to/file.ts:123` or
  // `path/to/file.ts:123:45`. Metrics compare repository files, so retain the
  // file identity while discarding an optional line/column suffix. A colon is
  // not a valid repository-relative path separator in this contract.
  const input = raw.replace(/:\d+(?::\d+)?$/, '');
  if (path.posix.isAbsolute(input) || /^[A-Za-z]:\//.test(input)) fail(location, 'must be repository-relative');
  const normalized = path.posix.normalize(input);
  if (normalized === '..' || normalized.startsWith('../')) fail(location, 'must not escape the repository');
  if (normalized === '.') fail(location, 'must identify a file or symbol');
  return normalized;
}

function validateRelation(value, location, prediction = false) {
  requireObject(value, location);
  const allowed = prediction
    ? new Set(['relationId', 'source', 'target', 'kind', 'observation', 'confidence'])
    : new Set(['relationId', 'source', 'target', 'kind', 'observation']);
  requireAllowedKeys(value, allowed, location);
  const relation = {
    source: requireString(value.source, `${location}.source`),
    target: requireString(value.target, `${location}.target`),
    kind: requireString(value.kind, `${location}.kind`),
    observation: requireString(value.observation, `${location}.observation`),
  };
  if (value.relationId !== undefined) {
    relation.relationId = requireString(value.relationId, `${location}.relationId`);
  }
  if (!OBSERVATIONS.has(relation.observation)) {
    fail(`${location}.observation`, 'must be present, absent, or unknown');
  }
  if (prediction) {
    requireFiniteNumber(value.confidence, `${location}.confidence`);
    if (value.confidence > 1) fail(`${location}.confidence`, 'must be <= 1');
    relation.confidence = value.confidence;
  }
  return relation;
}

export function createEvidencePacket(input) {
  const value = requireObject(input, 'evidencePacket');
  requireAllowedKeys(value, new Set(['elapsedMs', 'generator', 'query', 'content', 'claims']), 'evidencePacket');
  const content = requireString(value.content, 'evidencePacket.content');
  if (content.length > MAX_EVIDENCE_PACKET_CHARS) {
    fail('evidencePacket.content', `must not exceed ${MAX_EVIDENCE_PACKET_CHARS} characters`);
  }
  const claims = requireArray(value.claims, 'evidencePacket.claims').map((claim, index) =>
    validateRelation(claim, `evidencePacket.claims[${index}]`, true),
  );
  requireUniqueStrings(claims.map(relationKey), 'evidencePacket.claims');
  for (const [index, claim] of claims.entries()) {
    for (const reference of relationRepositoryPaths(claim)) {
      if (!content.includes(reference)) {
        fail(
          `evidencePacket.claims[${index}]`,
          `references ${JSON.stringify(reference)} but evidencePacket.content does not cite that file`,
        );
      }
    }
  }
  return {
    elapsedMs: requireFiniteNumber(value.elapsedMs, 'evidencePacket.elapsedMs'),
    generator: requireString(value.generator, 'evidencePacket.generator'),
    query: requireString(value.query, 'evidencePacket.query'),
    content,
    claims,
  };
}

function relationRepositoryPaths(relation) {
  const paths = new Set();
  for (const value of [relation.source, relation.target]) {
    if (!value.startsWith('symbol:')) continue;
    const separator = value.indexOf(':', 'symbol:'.length);
    if (separator === -1) continue;
    const candidate = value.slice('symbol:'.length, separator);
    if (candidate.includes('/') && /\.[a-z0-9]+$/i.test(candidate)) paths.add(candidate);
  }
  return paths;
}

function relationIdentity(relation) {
  if (relation.relationId !== undefined) return `id:${relation.relationId}`;
  return `${relation.kind}\u0000${relation.source}\u0000${relation.target}`;
}

function relationExactIdentity(relation) {
  return `${relation.kind}\u0000${relation.source}\u0000${relation.target}`;
}

function relationKey(relation) {
  return `${relationIdentity(relation)}\u0000${relation.observation}`;
}

function validateExecutionProfile(value, location) {
  requireObject(value, location);
  requireAllowedKeys(
    value,
    new Set(['model', 'reasoningEffort', 'promptVersion', 'tokenBudget', 'timeoutMs', 'maxToolCalls']),
    location,
  );
  return {
    model: requireString(value.model, `${location}.model`),
    reasoningEffort: requireString(value.reasoningEffort, `${location}.reasoningEffort`),
    promptVersion: requireString(value.promptVersion, `${location}.promptVersion`),
    tokenBudget: requireInteger(value.tokenBudget, `${location}.tokenBudget`, 1),
    timeoutMs: requireInteger(value.timeoutMs, `${location}.timeoutMs`, 1),
    maxToolCalls: requireInteger(value.maxToolCalls, `${location}.maxToolCalls`, 1),
  };
}

function validateArm(value, location) {
  requireObject(value, location);
  requireAllowedKeys(value, new Set(['id', 'evidenceMode']), location);
  const arm = {
    id: requireString(value.id, `${location}.id`),
    evidenceMode: requireString(value.evidenceMode, `${location}.evidenceMode`),
  };
  if (!['none', 'packet'].includes(arm.evidenceMode)) {
    fail(`${location}.evidenceMode`, 'must be none or packet');
  }
  return arm;
}

function validateCase(value, location, armMap) {
  requireObject(value, location);
  requireAllowedKeys(
    value,
    new Set([
      'id',
      'repositoryId',
      'split',
      'category',
      'caseKind',
      'workspace',
      'problem',
      'evidencePackets',
      'truth',
    ]),
    location,
  );
  const split = requireString(value.split, `${location}.split`);
  if (!['design', 'holdout'].includes(split)) fail(`${location}.split`, 'must be design or holdout');
  const category = requireString(value.category, `${location}.category`);
  if (!CATEGORIES.includes(category)) fail(`${location}.category`, `must be one of ${CATEGORIES.join(', ')}`);
  const caseKind = requireString(value.caseKind, `${location}.caseKind`);
  if (!['bug', 'fixed_regression'].includes(caseKind)) {
    fail(`${location}.caseKind`, 'must be bug or fixed_regression');
  }

  const workspace = requireObject(value.workspace, `${location}.workspace`);
  requireAllowedKeys(workspace, new Set(['path', 'snapshot']), `${location}.workspace`);
  const problem = requireObject(value.problem, `${location}.problem`);
  requireAllowedKeys(problem, new Set(['text']), `${location}.problem`);
  const evidencePackets = requireObject(value.evidencePackets, `${location}.evidencePackets`);
  requireAllowedKeys(evidencePackets, new Set([...armMap.keys()]), `${location}.evidencePackets`);

  for (const [armId, arm] of armMap) {
    if (arm.evidenceMode === 'none') {
      if (Object.hasOwn(evidencePackets, armId)) {
        fail(`${location}.evidencePackets.${armId}`, 'must be omitted for evidenceMode=none');
      }
      continue;
    }
    const packet = requireObject(evidencePackets[armId], `${location}.evidencePackets.${armId}`);
    requireAllowedKeys(packet, new Set(['path', 'sha256']), `${location}.evidencePackets.${armId}`);
    requireString(packet.path, `${location}.evidencePackets.${armId}.path`);
    requireSha256(packet.sha256, `${location}.evidencePackets.${armId}.sha256`);
  }

  const truth = requireObject(value.truth, `${location}.truth`);
  requireAllowedKeys(truth, new Set(['rootCauseFiles', 'criticalRelations']), `${location}.truth`);
  const rootCauseFiles = requireArray(truth.rootCauseFiles, `${location}.truth.rootCauseFiles`).map((item, index) =>
    normalizeRepositoryPath(item, `${location}.truth.rootCauseFiles[${index}]`),
  );
  requireUniqueStrings(rootCauseFiles, `${location}.truth.rootCauseFiles`);
  const criticalRelations = requireArray(
    truth.criticalRelations,
    `${location}.truth.criticalRelations`,
  ).map((item, index) => validateRelation(item, `${location}.truth.criticalRelations[${index}]`));
  requireUniqueStrings(criticalRelations.map(relationKey), `${location}.truth.criticalRelations`);
  if (caseKind === 'bug' && rootCauseFiles.length === 0) {
    fail(`${location}.truth.rootCauseFiles`, 'must not be empty for a bug case');
  }
  if (caseKind === 'fixed_regression') {
    if (rootCauseFiles.length !== 0) {
      fail(`${location}.truth.rootCauseFiles`, 'must be empty for a fixed_regression case');
    }
    if (!criticalRelations.some((relation) => relation.observation === 'present')) {
      fail(`${location}.truth.criticalRelations`, 'must contain a present relation for fixed_regression');
    }
  }

  return {
    id: requireString(value.id, `${location}.id`),
    repositoryId: requireString(value.repositoryId, `${location}.repositoryId`),
    split,
    category,
    caseKind,
    workspace: {
      path: requireString(workspace.path, `${location}.workspace.path`),
      snapshot: requireString(workspace.snapshot, `${location}.workspace.snapshot`),
    },
    problem: { text: requireString(problem.text, `${location}.problem.text`) },
    evidencePackets: Object.fromEntries(
      Object.entries(evidencePackets).map(([armId, packet]) => [
        armId,
        { path: packet.path, sha256: packet.sha256.toLowerCase() },
      ]),
    ),
    truth: { rootCauseFiles, criticalRelations },
  };
}

export function validateSuite(input) {
  const suite = requireObject(input, 'suite');
  requireAllowedKeys(
    suite,
    new Set([
      'schemaVersion',
      'suiteId',
      'mode',
      'seed',
      'repetitions',
      'executionProfile',
      'arms',
      'cases',
    ]),
    'suite',
  );
  if (suite.schemaVersion !== SCHEMA_VERSION) fail('suite.schemaVersion', `must equal ${SCHEMA_VERSION}`);
  const mode = requireString(suite.mode, 'suite.mode');
  if (!['spike', 'gate'].includes(mode)) fail('suite.mode', 'must be spike or gate');
  const arms = requireArray(suite.arms, 'suite.arms').map(validateArm);
  if (arms.length !== ARM_IDS.length) fail('suite.arms', 'must contain exactly baseline and assisted');
  requireUniqueStrings(arms.map((arm) => arm.id), 'suite.arms');
  const armMap = new Map(arms.map((arm) => [arm.id, arm]));
  for (const armId of ARM_IDS) {
    if (!armMap.has(armId)) fail('suite.arms', `missing required arm ${armId}`);
  }
  if (armMap.get('baseline').evidenceMode !== 'none') {
    fail('suite.arms.baseline', 'baseline must use evidenceMode=none');
  }
  if (armMap.get('assisted').evidenceMode !== 'packet') {
    fail('suite.arms.assisted', 'assisted must use evidenceMode=packet');
  }

  const cases = requireArray(suite.cases, 'suite.cases').map((item, index) =>
    validateCase(item, `suite.cases[${index}]`, armMap),
  );
  if (cases.length === 0) fail('suite.cases', 'must not be empty');
  requireUniqueStrings(cases.map((item) => item.id), 'suite.cases');
  if (mode === 'gate') {
    for (const [index, benchmarkCase] of cases.entries()) {
      for (const [relationIndex, relation] of benchmarkCase.truth.criticalRelations.entries()) {
        if (relation.relationId === undefined) {
          fail(
            `suite.cases[${index}].truth.criticalRelations[${relationIndex}].relationId`,
            'is required for mode=gate; freeze a stable relation identity before running the holdout',
          );
        }
      }
    }
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    suiteId: requireString(suite.suiteId, 'suite.suiteId'),
    mode,
    seed: requireString(suite.seed, 'suite.seed'),
    repetitions: requireInteger(suite.repetitions, 'suite.repetitions', 1),
    executionProfile: validateExecutionProfile(suite.executionProfile, 'suite.executionProfile'),
    arms,
    cases,
  };
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function digest(value) {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function seedNumber(seed) {
  return Number.parseInt(createHash('sha256').update(seed).digest('hex').slice(0, 8), 16) >>> 0;
}

function randomGenerator(seed) {
  let state = seedNumber(seed);
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled(values, seed) {
  const output = [...values];
  const random = randomGenerator(seed);
  for (let index = output.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [output[index], output[swap]] = [output[swap], output[index]];
  }
  return output;
}

function resolveReference(baseDirectory, value) {
  return path.resolve(baseDirectory, value);
}

export function createRunPlan(input, options = {}) {
  const suite = validateSuite(input);
  const baseDirectory = path.resolve(options.baseDirectory ?? process.cwd());
  const suiteDigest = digest(suite);
  const runs = [];
  for (const benchmarkCase of suite.cases) {
    for (const arm of suite.arms) {
      for (let trial = 1; trial <= suite.repetitions; trial += 1) {
        const packet = benchmarkCase.evidencePackets[arm.id];
        runs.push({
          runId: `${benchmarkCase.id}:${arm.id}:${trial}`,
          caseId: benchmarkCase.id,
          repositoryId: benchmarkCase.repositoryId,
          armId: arm.id,
          trial,
          workspace: {
            path: resolveReference(baseDirectory, benchmarkCase.workspace.path),
            snapshot: benchmarkCase.workspace.snapshot,
          },
          problem: benchmarkCase.problem,
          evidence: packet
            ? { path: resolveReference(baseDirectory, packet.path), sha256: packet.sha256 }
            : null,
        });
      }
    }
  }
  const runOrder = shuffled(runs, `${suite.seed}\u0000${suiteDigest}`);
  const publicPlan = {
    schemaVersion: SCHEMA_VERSION,
    suiteId: suite.suiteId,
    suiteDigest,
    mode: suite.mode,
    executionProfile: suite.executionProfile,
    runOrder,
  };
  return { ...publicPlan, planId: digest(publicPlan) };
}

export function validateRunPlan(suiteInput, planInput, options = {}) {
  const expectedPlan = createRunPlan(suiteInput, options);
  if (stableJson(planInput) !== stableJson(expectedPlan)) {
    fail('plan', 'does not match the deterministic plan generated from this suite');
  }
  return expectedPlan;
}

export function createRunnerTask(suiteInput, planInput, runId, options = {}) {
  const plan = validateRunPlan(suiteInput, planInput, options);
  const plannedRun = plan.runOrder.find((run) => run.runId === runId);
  if (!plannedRun) fail('runId', `is not present in plan: ${JSON.stringify(runId)}`);
  return {
    schemaVersion: SCHEMA_VERSION,
    planId: plan.planId,
    executionProfile: plan.executionProfile,
    run: {
      runId: plannedRun.runId,
      workspace: plannedRun.workspace,
      problem: plannedRun.problem,
      evidence: plannedRun.evidence,
    },
  };
}

function validateCandidate(value, location) {
  requireObject(value, location);
  requireAllowedKeys(value, new Set(['path', 'confidence']), location);
  const confidence = requireFiniteNumber(value.confidence, `${location}.confidence`);
  if (confidence > 1) fail(`${location}.confidence`, 'must be <= 1');
  return {
    path: normalizeRepositoryPath(value.path, `${location}.path`),
    confidence,
  };
}

function validateUsage(value, location) {
  requireObject(value, location);
  requireAllowedKeys(
    value,
    new Set(['source', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']),
    location,
  );
  return {
    source: requireString(value.source, `${location}.source`),
    inputTokens: requireInteger(value.inputTokens, `${location}.inputTokens`),
    outputTokens: requireInteger(value.outputTokens, `${location}.outputTokens`),
    cacheReadTokens: requireInteger(value.cacheReadTokens, `${location}.cacheReadTokens`),
    cacheWriteTokens: requireInteger(value.cacheWriteTokens, `${location}.cacheWriteTokens`),
  };
}

function validateMetrics(value, location) {
  requireObject(value, location);
  requireAllowedKeys(
    value,
    new Set(['wallTimeMs', 'evidencePreparationMs', 'toolCalls', 'filesRead', 'charactersRead']),
    location,
  );
  return {
    wallTimeMs: requireFiniteNumber(value.wallTimeMs, `${location}.wallTimeMs`),
    evidencePreparationMs: requireFiniteNumber(
      value.evidencePreparationMs,
      `${location}.evidencePreparationMs`,
    ),
    toolCalls: requireInteger(value.toolCalls, `${location}.toolCalls`),
    filesRead: value.filesRead === null ? null : requireInteger(value.filesRead, `${location}.filesRead`),
    charactersRead:
      value.charactersRead === null ? null : requireInteger(value.charactersRead, `${location}.charactersRead`),
  };
}

function validateRunResult(value, location) {
  requireObject(value, location);
  requireAllowedKeys(
    value,
    new Set([
      'runId',
      'status',
      'rootCauseCandidates',
      'relations',
      'candidateEvents',
      'usage',
      'metrics',
      'error',
    ]),
    location,
  );
  const status = requireString(value.status, `${location}.status`);
  if (!['completed', 'failed'].includes(status)) fail(`${location}.status`, 'must be completed or failed');
  const result = { runId: requireString(value.runId, `${location}.runId`), status };
  if (status === 'failed') {
    result.error = requireString(value.error, `${location}.error`);
    return result;
  }
  result.rootCauseCandidates = requireArray(
    value.rootCauseCandidates,
    `${location}.rootCauseCandidates`,
  ).map((item, index) => validateCandidate(item, `${location}.rootCauseCandidates[${index}]`));
  result.relations = requireArray(value.relations, `${location}.relations`).map((item, index) =>
    validateRelation(item, `${location}.relations[${index}]`, true),
  );
  if (value.candidateEvents !== undefined) {
    result.candidateEvents = requireArray(value.candidateEvents, `${location}.candidateEvents`).map(
      (event, index) => {
        const eventLocation = `${location}.candidateEvents[${index}]`;
        requireObject(event, eventLocation);
        requireAllowedKeys(event, new Set(['elapsedMs', 'rootCauseFiles', 'source']), eventLocation);
        const normalized = {
          elapsedMs: requireFiniteNumber(event.elapsedMs, `${eventLocation}.elapsedMs`),
          rootCauseFiles: requireArray(event.rootCauseFiles, `${eventLocation}.rootCauseFiles`).map(
            (item, itemIndex) => normalizeRepositoryPath(item, `${eventLocation}.rootCauseFiles[${itemIndex}]`),
          ),
        };
        if (event.source !== undefined) {
          normalized.source = requireString(event.source, `${eventLocation}.source`);
        }
        return normalized;
      },
    );
    for (let index = 1; index < result.candidateEvents.length; index += 1) {
      if (result.candidateEvents[index].elapsedMs < result.candidateEvents[index - 1].elapsedMs) {
        fail(`${location}.candidateEvents`, 'must be ordered by elapsedMs');
      }
    }
  }
  if (value.usage !== undefined) result.usage = validateUsage(value.usage, `${location}.usage`);
  if (value.metrics !== undefined) result.metrics = validateMetrics(value.metrics, `${location}.metrics`);
  return result;
}

export function validateResults(input) {
  const value = requireObject(input, 'results');
  requireAllowedKeys(value, new Set(['schemaVersion', 'planId', 'runs']), 'results');
  if (value.schemaVersion !== SCHEMA_VERSION) fail('results.schemaVersion', `must equal ${SCHEMA_VERSION}`);
  const runs = requireArray(value.runs, 'results.runs').map((item, index) =>
    validateRunResult(item, `results.runs[${index}]`),
  );
  requireUniqueStrings(runs.map((run) => run.runId), 'results.runs');
  return {
    schemaVersion: SCHEMA_VERSION,
    planId: requireString(value.planId, 'results.planId'),
    runs,
  };
}

function createUnavailableEvidenceAudit(planId, suite, message) {
  return {
    schemaVersion: SCHEMA_VERSION,
    planId,
    cases: suite.cases
      .filter((item) => item.split === 'holdout')
      .map((item) => ({
        caseId: item.id,
        status: 'failed',
        packetSha256: item.evidencePackets.assisted.sha256,
        error: message,
      })),
  };
}

function validateEvidenceAudit(suite, plan, input) {
  const value = input ?? createUnavailableEvidenceAudit(plan.planId, suite, 'evidence audit was not provided');
  requireObject(value, 'evidenceAudit');
  requireAllowedKeys(value, new Set(['schemaVersion', 'planId', 'cases']), 'evidenceAudit');
  if (value.schemaVersion !== SCHEMA_VERSION) {
    fail('evidenceAudit.schemaVersion', `must equal ${SCHEMA_VERSION}`);
  }
  if (requireString(value.planId, 'evidenceAudit.planId') !== plan.planId) {
    fail('evidenceAudit.planId', 'does not match plan.planId');
  }
  const expectedCases = new Map(
    suite.cases.filter((item) => item.split === 'holdout').map((item) => [item.id, item]),
  );
  const cases = requireArray(value.cases, 'evidenceAudit.cases').map((item, index) => {
    const location = `evidenceAudit.cases[${index}]`;
    requireObject(item, location);
    const status = requireString(item.status, `${location}.status`);
    const allowed = status === 'completed'
      ? new Set(['caseId', 'status', 'packetSha256', 'claims'])
      : new Set(['caseId', 'status', 'packetSha256', 'error']);
    if (!['completed', 'failed'].includes(status)) fail(`${location}.status`, 'must be completed or failed');
    requireAllowedKeys(item, allowed, location);
    const caseId = requireString(item.caseId, `${location}.caseId`);
    const benchmarkCase = expectedCases.get(caseId);
    if (!benchmarkCase) fail(`${location}.caseId`, `is not a holdout case: ${JSON.stringify(caseId)}`);
    const packetSha256 = requireSha256(item.packetSha256, `${location}.packetSha256`);
    if (packetSha256 !== benchmarkCase.evidencePackets.assisted.sha256) {
      fail(`${location}.packetSha256`, 'does not match suite evidence packet digest');
    }
    if (status === 'failed') {
      return { caseId, status, packetSha256, error: requireString(item.error, `${location}.error`) };
    }
    const claims = requireArray(item.claims, `${location}.claims`).map((claim, claimIndex) =>
      validateRelation(claim, `${location}.claims[${claimIndex}]`, true),
    );
    requireUniqueStrings(claims.map(relationKey), `${location}.claims`);
    return { caseId, status, packetSha256, claims };
  });
  requireUniqueStrings(cases.map((item) => item.caseId), 'evidenceAudit.cases');
  for (const caseId of expectedCases.keys()) {
    if (!cases.some((item) => item.caseId === caseId)) {
      fail('evidenceAudit.cases', `missing holdout case ${JSON.stringify(caseId)}`);
    }
  }
  return { schemaVersion: SCHEMA_VERSION, planId: plan.planId, cases };
}

export async function auditEvidencePackets(suiteInput, planInput, options = {}) {
  const suite = validateSuite(suiteInput);
  const baseDirectory = path.resolve(options.baseDirectory ?? process.cwd());
  const plan = validateRunPlan(suite, planInput, { baseDirectory });
  const cases = [];
  for (const benchmarkCase of suite.cases.filter((item) => item.split === 'holdout')) {
    const packet = benchmarkCase.evidencePackets.assisted;
    const packetPath = resolveReference(baseDirectory, packet.path);
    try {
      const contents = await readFile(packetPath);
      const actualSha256 = createHash('sha256').update(contents).digest('hex');
      if (actualSha256 !== packet.sha256) {
        throw new Error(`SHA-256 mismatch: expected ${packet.sha256}, got ${actualSha256}`);
      }
      const value = JSON.parse(contents.toString('utf8'));
      if (!isObject(value) || !Array.isArray(value.claims)) {
        throw new Error('packet must declare a top-level claims array');
      }
      const claims = value.claims.map((claim, index) =>
        validateRelation(claim, `packet ${packetPath}.claims[${index}]`, true),
      );
      requireUniqueStrings(claims.map(relationKey), `packet ${packetPath}.claims`);
      cases.push({
        caseId: benchmarkCase.id,
        status: 'completed',
        packetSha256: actualSha256,
        claims,
      });
    } catch (error) {
      cases.push({
        caseId: benchmarkCase.id,
        status: 'failed',
        packetSha256: packet.sha256,
        error: `${packetPath}: ${error.message}`,
      });
    }
  }
  return { schemaVersion: SCHEMA_VERSION, planId: plan.planId, cases };
}

function inspectEvidenceAudit(suite, evidenceAudit) {
  const caseMap = new Map(suite.cases.map((item) => [item.id, item]));
  let expected = 0;
  let hits = 0;
  let contradictions = 0;
  let fixedRegressionFalsePositives = 0;
  const failedCases = [];
  for (const auditCase of evidenceAudit.cases) {
    if (auditCase.status !== 'completed') {
      failedCases.push({ caseId: auditCase.caseId, error: auditCase.error });
      continue;
    }
    const benchmarkCase = caseMap.get(auditCase.caseId);
    const inspection = inspectRelations(auditCase.claims, benchmarkCase.truth.criticalRelations, {
      requireStableRelationIds: suite.mode === 'gate',
    });
    expected += inspection.expected;
    hits += inspection.hits;
    contradictions += inspection.contradictions;
    if (benchmarkCase.caseKind === 'fixed_regression') {
      fixedRegressionFalsePositives += inspection.contradictions;
    }
  }
  return {
    complete: failedCases.length === 0,
    failedCases,
    expectedCriticalRelations: expected,
    matchedCriticalRelations: hits,
    criticalRelationRecall: meanRatio(hits, expected),
    contradictions,
    fixedRegressionFalsePositives,
  };
}

export function collectRunResults(suiteInput, planInput, runResultsInput, options = {}) {
  const plan = validateRunPlan(suiteInput, planInput, { baseDirectory: options.baseDirectory });
  if (!Array.isArray(runResultsInput) || runResultsInput.length === 0) {
    fail('runResults', 'must contain at least one runner result');
  }
  const results = validateResults({
    schemaVersion: SCHEMA_VERSION,
    planId: plan.planId,
    runs: runResultsInput,
  });
  const expectedRunIds = new Set(plan.runOrder.map((run) => run.runId));
  for (const run of results.runs) {
    if (!expectedRunIds.has(run.runId)) {
      fail('runResults', `contains unknown runId ${JSON.stringify(run.runId)}`);
    }
  }
  const collectedRunIds = new Set(results.runs.map((run) => run.runId));
  const missingRunIds = plan.runOrder
    .map((run) => run.runId)
    .filter((runId) => !collectedRunIds.has(runId));
  if (missingRunIds.length > 0) {
    fail('runResults', `missing planned runIds: ${missingRunIds.map(JSON.stringify).join(', ')}`);
  }
  return results;
}

function percentile(values, fraction) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.ceil(fraction * sorted.length) - 1;
  return sorted[Math.max(0, index)];
}

function meanRatio(numerator, denominator) {
  return denominator === 0 ? null : numerator / denominator;
}

function reduction(baseline, assisted) {
  if (baseline === null || assisted === null || baseline <= 0) return null;
  return (baseline - assisted) / baseline;
}

function rootCauseHit(candidates, truthFiles, limit) {
  const truth = new Set(truthFiles);
  return candidates.slice(0, limit).some((candidate) => truth.has(candidate.path));
}

function firstCorrectTime(result, truthFiles, timeoutMs) {
  if (!Array.isArray(result?.candidateEvents)) return null;
  const truth = new Set(truthFiles);
  for (const event of result.candidateEvents) {
    if (event.rootCauseFiles.some((file) => truth.has(file))) return event.elapsedMs;
  }
  return timeoutMs;
}

function inspectRelations(predictions, truthRelations, options = {}) {
  const requireStableRelationIds = options.requireStableRelationIds === true;
  const predictedKeys = new Set(predictions.map(relationKey));
  const predictedExactKeys = new Set(
    predictions.filter((relation) => relation.relationId === undefined).map((relation) => `${relationExactIdentity(relation)}\u0000${relation.observation}`),
  );
  const predictionsByIdentity = new Map();
  for (const prediction of predictions) {
    const identity = relationIdentity(prediction);
    const items = predictionsByIdentity.get(identity) ?? [];
    items.push(prediction);
    predictionsByIdentity.set(identity, items);
  }
  let hits = 0;
  let contradictions = 0;
  for (const truth of truthRelations) {
    const exactKey = `${relationExactIdentity(truth)}\u0000${truth.observation}`;
    const stableMatch = predictedKeys.has(relationKey(truth));
    const legacyExactMatch = predictedExactKeys.has(exactKey);
    if (stableMatch || (!requireStableRelationIds && legacyExactMatch)) {
      hits += 1;
    }
    const sameIdentity = [
      ...(predictionsByIdentity.get(relationIdentity(truth)) ?? []),
      ...(truth.relationId !== undefined
        ? predictions.filter((prediction) => prediction.relationId === undefined && relationExactIdentity(prediction) === relationExactIdentity(truth))
        : []),
    ];
    if (sameIdentity.some((item) => item.observation !== 'unknown' && item.observation !== truth.observation)) {
      contradictions += 1;
    }
  }
  return { hits, expected: truthRelations.length, contradictions };
}

function evaluateArm({ armId, expectedRuns, resultMap, caseMap, timeoutMs, tokenBudget, requireStableRelationIds }) {
  let completedRuns = 0;
  let bugRuns = 0;
  let top1Hits = 0;
  let top3Hits = 0;
  let highConfidenceWrong = 0;
  let highConfidencePredictions = 0;
  let relationHits = 0;
  let relationExpected = 0;
  let relationContradictions = 0;
  let fixedRegressionFalsePositives = 0;
  const firstCorrectTimes = [];
  const inputTokens = [];
  const evidencePreparationTimes = [];
  const usageSources = new Set();
  const incompleteRunIds = [];
  const overBudgetRunIds = [];

  for (const plannedRun of expectedRuns) {
    const benchmarkCase = caseMap.get(plannedRun.caseId);
    const result = resultMap.get(plannedRun.runId);
    if (!result || result.status !== 'completed') {
      incompleteRunIds.push(plannedRun.runId);
      if (benchmarkCase.caseKind === 'bug') {
        bugRuns += 1;
        firstCorrectTimes.push(timeoutMs);
      }
      relationExpected += benchmarkCase.truth.criticalRelations.length;
      continue;
    }

    completedRuns += 1;
    if (benchmarkCase.caseKind === 'bug') {
      bugRuns += 1;
      const top1 = rootCauseHit(result.rootCauseCandidates, benchmarkCase.truth.rootCauseFiles, 1);
      const top3 = rootCauseHit(result.rootCauseCandidates, benchmarkCase.truth.rootCauseFiles, 3);
      if (top1) top1Hits += 1;
      if (top3) top3Hits += 1;
      if (result.rootCauseCandidates[0]?.confidence >= 0.8) {
        highConfidencePredictions += 1;
        if (!top1) highConfidenceWrong += 1;
      }
      const firstCorrect = firstCorrectTime(result, benchmarkCase.truth.rootCauseFiles, timeoutMs);
      if (firstCorrect === null) incompleteRunIds.push(plannedRun.runId);
      else firstCorrectTimes.push(firstCorrect);
    }

    const relationInspection = inspectRelations(result.relations, benchmarkCase.truth.criticalRelations, {
      requireStableRelationIds,
    });
    relationHits += relationInspection.hits;
    relationExpected += relationInspection.expected;
    relationContradictions += relationInspection.contradictions;
    if (benchmarkCase.caseKind === 'fixed_regression') {
      fixedRegressionFalsePositives += relationInspection.contradictions;
    }

    if (!result.usage) incompleteRunIds.push(plannedRun.runId);
    else {
      inputTokens.push(result.usage.inputTokens);
      usageSources.add(result.usage.source);
      if (result.usage.inputTokens + result.usage.outputTokens > tokenBudget) {
        overBudgetRunIds.push(plannedRun.runId);
      }
    }
    if (!result.metrics) incompleteRunIds.push(plannedRun.runId);
    else if (armId === 'assisted') evidencePreparationTimes.push(result.metrics.evidencePreparationMs);
  }

  return {
    expectedRuns: expectedRuns.length,
    completedRuns,
    incompleteRunIds: [...new Set(incompleteRunIds)].sort(),
    overBudgetRunIds: [...new Set(overBudgetRunIds)].sort(),
    bugRuns,
    top1HitRate: meanRatio(top1Hits, bugRuns),
    top3HitRate: meanRatio(top3Hits, bugRuns),
    relationRecall: meanRatio(relationHits, relationExpected),
    relationContradictions,
    fixedRegressionFalsePositives,
    medianTimeToFirstCorrectRootCauseMs: percentile(firstCorrectTimes, 0.5),
    p75InputTokens: percentile(inputTokens, 0.75),
    p95EvidencePreparationMs: percentile(evidencePreparationTimes, 0.95),
    highConfidencePredictionRate: meanRatio(highConfidencePredictions, bugRuns),
    highConfidenceWrongRate: meanRatio(highConfidenceWrong, bugRuns),
    usageSources: [...usageSources].sort(),
  };
}

function sampleEligibility(suite) {
  const holdoutBugs = suite.cases.filter((item) => item.split === 'holdout' && item.caseKind === 'bug');
  const holdoutRegressions = suite.cases.filter(
    (item) => item.split === 'holdout' && item.caseKind === 'fixed_regression',
  );
  const repositories = new Set(holdoutBugs.map((item) => item.repositoryId));
  const categories = new Set(holdoutBugs.map((item) => item.category));
  const checks = {
    gateMode: suite.mode === 'gate',
    atLeastTwentyHoldoutBugs: holdoutBugs.length >= 20,
    atLeastThreeRepositories: repositories.size >= 3,
    allRequiredCategories: CATEGORIES.every((category) => categories.has(category)),
    atLeastThreeRepetitions: suite.repetitions >= 3,
    hasFixedRegression: holdoutRegressions.length >= 1,
    hasCriticalRelations: suite.cases
      .filter((item) => item.split === 'holdout')
      .some((item) => item.truth.criticalRelations.length > 0),
  };
  return {
    eligible: Object.values(checks).every(Boolean),
    checks,
    holdoutBugCount: holdoutBugs.length,
    holdoutRegressionCount: holdoutRegressions.length,
    repositoryCount: repositories.size,
    categories: [...categories].sort(),
  };
}

export function evaluateResults(suiteInput, planInput, resultsInput, options = {}) {
  const suite = validateSuite(suiteInput);
  const expectedPlan = validateRunPlan(suite, planInput, { baseDirectory: options.baseDirectory });
  const results = validateResults(resultsInput);
  if (results.planId !== expectedPlan.planId) fail('results.planId', 'does not match plan.planId');
  const evidenceAudit = validateEvidenceAudit(suite, expectedPlan, options.evidenceAudit);
  const evidenceMetrics = inspectEvidenceAudit(suite, evidenceAudit);
  const expectedRunMap = new Map(expectedPlan.runOrder.map((run) => [run.runId, run]));
  const resultMap = new Map(results.runs.map((run) => [run.runId, run]));
  for (const runId of resultMap.keys()) {
    if (!expectedRunMap.has(runId)) fail('results.runs', `contains unknown runId ${JSON.stringify(runId)}`);
  }

  const caseMap = new Map(suite.cases.map((item) => [item.id, item]));
  const expectedHoldoutRuns = expectedPlan.runOrder.filter(
    (run) => caseMap.get(run.caseId).split === 'holdout',
  );
  const armMetrics = {};
  for (const armId of ARM_IDS) {
    armMetrics[armId] = evaluateArm({
      armId,
      expectedRuns: expectedHoldoutRuns.filter((run) => run.armId === armId),
      resultMap,
      caseMap,
      timeoutMs: suite.executionProfile.timeoutMs,
      tokenBudget: suite.executionProfile.tokenBudget,
      requireStableRelationIds: suite.mode === 'gate' && armId === 'assisted',
    });
  }

  const allExpectedCompleted = expectedHoldoutRuns.every(
    (run) => resultMap.get(run.runId)?.status === 'completed',
  );
  const usageSources = new Set([...armMetrics.baseline.usageSources, ...armMetrics.assisted.usageSources]);
  const dataChecks = {
    everyHoldoutRunCompleted: allExpectedCompleted,
    baselineMeasurementsComplete: armMetrics.baseline.incompleteRunIds.length === 0,
    assistedMeasurementsComplete: armMetrics.assisted.incompleteRunIds.length === 0,
    commonUsageSource: usageSources.size === 1,
    assistedEvidenceAuditComplete: evidenceMetrics.complete,
    everyRunWithinTokenBudget:
      armMetrics.baseline.overBudgetRunIds.length === 0 &&
      armMetrics.assisted.overBudgetRunIds.length === 0,
  };
  const dataComplete = Object.values(dataChecks).every(Boolean);
  const sample = sampleEligibility(suite);
  const comparison = {
    top3HitRateDelta:
      armMetrics.baseline.top3HitRate === null || armMetrics.assisted.top3HitRate === null
        ? null
        : armMetrics.assisted.top3HitRate - armMetrics.baseline.top3HitRate,
    medianTimeReduction: reduction(
      armMetrics.baseline.medianTimeToFirstCorrectRootCauseMs,
      armMetrics.assisted.medianTimeToFirstCorrectRootCauseMs,
    ),
    p75InputTokenReduction: reduction(
      armMetrics.baseline.p75InputTokens,
      armMetrics.assisted.p75InputTokens,
    ),
  };
  const thresholdChecks = {
    assistedTop3AtLeastEightyPercent: armMetrics.assisted.top3HitRate >= 0.8,
    top3ImprovementAtLeastFifteenPoints: comparison.top3HitRateDelta >= 0.15,
    evidenceAuditCriticalRelationRecallAtLeastEightyFivePercent:
      evidenceMetrics.criticalRelationRecall >= 0.85,
    assistedModelCriticalRelationRecallAtLeastEightyFivePercent:
      armMetrics.assisted.relationRecall >= 0.85,
    medianTimeReductionAtLeastThirtyPercent: comparison.medianTimeReduction >= 0.3,
    p75InputTokenReductionAtLeastFortyPercent: comparison.p75InputTokenReduction >= 0.4,
    highConfidenceWrongRateNotWorse:
      armMetrics.assisted.highConfidenceWrongRate !== null &&
      armMetrics.baseline.highConfidenceWrongRate !== null &&
      armMetrics.assisted.highConfidenceWrongRate <= armMetrics.baseline.highConfidenceWrongRate,
    warmEvidencePreparationP95AtMostTwoSeconds:
      armMetrics.assisted.p95EvidencePreparationMs !== null &&
      armMetrics.assisted.p95EvidencePreparationMs <= 2000,
    noFixedRegressionFalsePositive:
      evidenceMetrics.fixedRegressionFalsePositives === 0 &&
      armMetrics.assisted.fixedRegressionFalsePositives === 0,
  };

  let decision = 'insufficient_data';
  if (sample.eligible && dataComplete) {
    decision = Object.values(thresholdChecks).every(Boolean) ? 'go' : 'no_go';
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    suiteId: suite.suiteId,
    planId: expectedPlan.planId,
    decision,
    sampleEligibility: sample,
    dataCompleteness: { complete: dataComplete, checks: dataChecks },
    evidenceMetrics,
    armMetrics,
    comparison,
    thresholdChecks,
    notes: [
      'Only holdout cases contribute to gate metrics.',
      'Missing provider/session token usage is never replaced with a character-based estimate.',
      'A failed or unresolved bug run is censored at executionProfile.timeoutMs for time-to-root-cause.',
    ],
  };
}

export const benchmarkConstants = Object.freeze({
  schemaVersion: SCHEMA_VERSION,
  armIds: [...ARM_IDS],
  categories: [...CATEGORIES],
});
