import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  BenchmarkValidationError,
  benchmarkConstants,
  collectRunResults,
  createEvidencePacket,
  createRunPlan,
  createRunnerTask,
  evaluateResults,
  validateSuite,
} from '../src/benchmark.mjs';
import { buildGlobalCausalAnalysis } from '../src/causal-engine.mjs';
import { compressLogWithRtk } from '../src/runtime-evidence.mjs';
import { extractSourceLocations } from '../src/runtime-evidence.mjs';
import { selectNodesForSourceLocation } from '../src/codegraph-adapter.mjs';
import { buildCodexPrompt, parseCodexOutput, runCodexTask, validateRunnerTask } from '../src/codex-runner.mjs';
import { runBatch } from '../src/batch-runner-cli.mjs';

const experimentRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = path.join(experimentRoot, 'src', 'cli.mjs');

function bugCase(overrides = {}) {
  const id = overrides.id ?? 'case-1';
  const packetSha256 = createHash('sha256').update(`packet:${id}`).digest('hex');
  return {
    id,
    repositoryId: overrides.repositoryId ?? 'repo-1',
    split: overrides.split ?? 'holdout',
    category: overrides.category ?? 'event_lifecycle',
    caseKind: overrides.caseKind ?? 'bug',
    workspace: overrides.workspace ?? { path: `workspaces/${id}`, snapshot: `git:${id}-before` },
    problem: overrides.problem ?? { text: `Problem for ${id}` },
    evidencePackets: overrides.evidencePackets ?? {
      assisted: { path: `packets/${id}.json`, sha256: packetSha256 },
    },
    truth: overrides.truth ?? {
      rootCauseFiles: [`src/${id}-root.ts`],
      criticalRelations: [
        {
          relationId: `relation.${id}.guard`,
          source: `symbol:${id}:source`,
          target: `capability:${id}:guard`,
          kind: 'guard',
          observation: 'absent',
        },
      ],
    },
  };
}

function suiteFixture(overrides = {}) {
  return {
    schemaVersion: 1,
    suiteId: overrides.suiteId ?? 'suite-1',
    mode: overrides.mode ?? 'spike',
    seed: overrides.seed ?? 'stable-seed',
    repetitions: overrides.repetitions ?? 3,
    executionProfile: overrides.executionProfile ?? {
      model: 'test-model',
      reasoningEffort: 'high',
      promptVersion: 'v1',
      tokenBudget: 20000,
      timeoutMs: 10000,
      maxToolCalls: 12,
    },
    arms: overrides.arms ?? [
      { id: 'baseline', evidenceMode: 'none' },
      { id: 'assisted', evidenceMode: 'packet' },
    ],
    cases: overrides.cases ?? [bugCase()],
  };
}

function gateSuite() {
  const cases = [];
  for (let index = 0; index < 20; index += 1) {
    cases.push(
      bugCase({
        id: `bug-${index}`,
        repositoryId: `repo-${index % 3}`,
        category: benchmarkConstants.categories[index % benchmarkConstants.categories.length],
      }),
    );
  }
  cases.push(
    bugCase({
      id: 'fixed-regression',
      repositoryId: 'repo-0',
      category: 'event_lifecycle',
      caseKind: 'fixed_regression',
      truth: {
        rootCauseFiles: [],
        criticalRelations: [
          {
            relationId: 'relation.fixed.guard',
            source: 'symbol:fixed:surface',
            target: 'capability:fixed:guard',
            kind: 'guard',
            observation: 'present',
          },
        ],
      },
    }),
  );
  return suiteFixture({ mode: 'gate', cases });
}

function resultForRun(run, suite, options = {}) {
  const benchmarkCase = suite.cases.find((item) => item.id === run.caseId);
  const caseIndex = Number.parseInt(run.caseId.replace('bug-', ''), 10);
  const isRegression = benchmarkCase.caseKind === 'fixed_regression';
  const shouldHit = isRegression
    ? false
    : run.armId === 'assisted'
      ? caseIndex < 18
      : caseIndex < 12;
  const truthFile = benchmarkCase.truth.rootCauseFiles[0];
  const rootCauseCandidates = isRegression
    ? []
    : [
        {
          path: shouldHit ? truthFile : `src/wrong-${run.caseId}.ts`,
          confidence: 0.9,
        },
      ];
  let relations = benchmarkCase.truth.criticalRelations.map((relation) => ({ ...relation, confidence: 0.9 }));
  if (options.omitAssistedRelations && run.armId === 'assisted') {
    relations = [];
  }
  if (options.fixedRegressionFalsePositive && isRegression && run.armId === 'assisted') {
    relations = relations.map((relation) => ({ ...relation, observation: 'absent' }));
  }
  return {
    runId: run.runId,
    status: 'completed',
    rootCauseCandidates,
    relations,
    candidateEvents: isRegression
      ? []
      : [
          {
            elapsedMs: run.armId === 'assisted' ? 500 : 1000,
            rootCauseFiles: [rootCauseCandidates[0].path],
          },
        ],
    usage: {
      source: 'provider',
      inputTokens: run.armId === 'assisted' ? 500 : 1000,
      outputTokens: 100,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
    metrics: {
      wallTimeMs: run.armId === 'assisted' ? 600 : 1100,
      evidencePreparationMs: run.armId === 'assisted' ? 300 : 0,
      toolCalls: run.armId === 'assisted' ? 3 : 8,
      filesRead: run.armId === 'assisted' ? 5 : 20,
      charactersRead: run.armId === 'assisted' ? 5000 : 20000,
    },
  };
}

function completeResults(suite, plan, options = {}) {
  return {
    schemaVersion: 1,
    planId: plan.planId,
    runs: plan.runOrder.map((run) => resultForRun(run, suite, options)),
  };
}

function evidenceAuditForSuite(suite, plan, options = {}) {
  return {
    schemaVersion: 1,
    planId: plan.planId,
    cases: suite.cases
      .filter((item) => item.split === 'holdout')
      .map((item) => ({
        caseId: item.id,
        status: 'completed',
        packetSha256: item.evidencePackets.assisted.sha256,
        claims: item.truth.criticalRelations.map((relation) => ({
          ...relation,
          observation:
            options.fixedRegressionFalsePositive && item.caseKind === 'fixed_regression'
              ? 'absent'
              : relation.observation,
          confidence: 0.9,
        })),
      })),
  };
}

function evaluationOptions(suite, plan, options = {}) {
  return {
    baseDirectory: 'C:/benchmark',
    evidenceAudit: evidenceAuditForSuite(suite, plan, options),
  };
}

function runCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

test('validates strict suite fields and case truth rules', () => {
  const suite = suiteFixture();
  assert.equal(validateSuite(suite).suiteId, 'suite-1');
  assert.throws(
    () => validateSuite({ ...suite, hiddenFixCommit: 'secret' }),
    (error) => error instanceof BenchmarkValidationError && /unknown field/.test(error.message),
  );
  const invalidRegression = suiteFixture({
    cases: [bugCase({ caseKind: 'fixed_regression' })],
  });
  assert.throws(() => validateSuite(invalidRegression), /must be empty for a fixed_regression/);
  const absoluteTruth = suiteFixture({
    cases: [
      bugCase({
        truth: {
          rootCauseFiles: ['C:/secret/root.ts'],
          criticalRelations: [],
        },
      }),
    ],
  });
  assert.throws(() => validateSuite(absoluteTruth), /must be repository-relative/);
  const escapingTruth = suiteFixture({
    cases: [
      bugCase({
        truth: {
          rootCauseFiles: ['../secret/root.ts'],
          criticalRelations: [],
        },
      }),
    ],
  });
  assert.throws(() => validateSuite(escapingTruth), /must not escape the repository/);
});

test('freezes a bounded evidence packet with normalized claims', () => {
  const packet = createEvidencePacket({
    elapsedMs: 123,
    generator: 'test-generator',
    query: 'find an error boundary',
    content: 'raw graph output mentioning src/service.ts',
    claims: [
      {
        source: 'symbol:src/service.ts:stream',
        target: 'capability:response-error-boundary',
        kind: 'guard',
        observation: 'absent',
        confidence: 0.9,
      },
    ],
  });
  assert.equal(packet.claims.length, 1);
  assert.throws(
    () => createEvidencePacket({ ...packet, claims: [{ ...packet.claims[0] }, { ...packet.claims[0] }] }),
    /duplicate value/,
  );
  assert.throws(
    () => createEvidencePacket({ ...packet, content: 'unrelated graph output' }),
    /does not cite that file/,
  );
  assert.throws(
    () => createEvidencePacket({ ...packet, content: 'x'.repeat(100_001) }),
    /must not exceed/,
  );
});

test('creates deterministic randomized plans without truth or fix metadata', () => {
  const suite = suiteFixture({
    cases: [
      bugCase({
        id: 'secret-case',
        truth: {
          rootCauseFiles: ['src/do-not-leak.ts'],
          criticalRelations: [
            { source: 'secret-source', target: 'secret-target', kind: 'guard', observation: 'absent' },
          ],
        },
      }),
    ],
  });
  const first = createRunPlan(suite, { baseDirectory: 'C:/benchmark' });
  const second = createRunPlan(suite, { baseDirectory: 'C:/benchmark' });
  assert.deepEqual(first, second);
  const serialized = JSON.stringify(first);
  assert.doesNotMatch(serialized, /do-not-leak|secret-source|secret-target|truth|fixCommit/);
  assert.equal(first.runOrder.filter((run) => run.armId === 'baseline').every((run) => run.evidence === null), true);
  assert.equal(first.runOrder.filter((run) => run.armId === 'assisted').every((run) => run.evidence?.path), true);
  const task = createRunnerTask(suite, first, first.runOrder[0].runId, { baseDirectory: 'C:/benchmark' });
  assert.deepEqual(Object.keys(task.run).sort(), ['evidence', 'problem', 'runId', 'workspace']);
  assert.doesNotMatch(JSON.stringify(task), /caseId|repositoryId|do-not-leak|secret-source|secret-target/);
});

test('returns go only when gate sample, actual usage and all thresholds pass', () => {
  const suite = gateSuite();
  const plan = createRunPlan(suite, { baseDirectory: 'C:/benchmark' });
  const report = evaluateResults(suite, plan, completeResults(suite, plan), evaluationOptions(suite, plan));
  assert.equal(report.decision, 'go');
  assert.equal(report.sampleEligibility.eligible, true);
  assert.equal(report.dataCompleteness.complete, true);
  assert.equal(report.armMetrics.assisted.top3HitRate, 0.9);
  assert.equal(report.armMetrics.baseline.top3HitRate, 0.6);
  assert.equal(report.comparison.p75InputTokenReduction, 0.5);
  assert.equal(Object.values(report.thresholdChecks).every(Boolean), true);
});

test('requires pre-frozen stable relation ids for gate suites', () => {
  const suite = suiteFixture({
    mode: 'gate',
    cases: [
      bugCase({
        truth: {
          rootCauseFiles: ['src/root.ts'],
          criticalRelations: [
            {
              source: 'symbol:src/root.ts:source',
              target: 'capability:root-guard',
              kind: 'guard',
              observation: 'absent',
            },
          ],
        },
      }),
    ],
  });
  assert.throws(() => validateSuite(suite), /relationId.*required for mode=gate/);
});

test('uses a pre-frozen relation id for semantic variants without relaxing legacy exact scoring', () => {
  const suite = gateSuite();
  const plan = createRunPlan(suite, { baseDirectory: 'C:/benchmark' });
  const results = completeResults(suite, plan);
  const assisted = results.runs.find((run) => run.runId.includes('bug-0:assisted:'));
  assisted.relations[0] = {
    ...assisted.relations[0],
    source: 'symbol:src/alternate.ts:equivalentGuard',
    target: 'capability:alternate-wording',
  };
  const report = evaluateResults(suite, plan, results, evaluationOptions(suite, plan));
  assert.equal(report.armMetrics.assisted.relationRecall, 1);

  const legacySuite = suiteFixture({
    cases: [
      bugCase({
        truth: {
          rootCauseFiles: ['src/case-1-root.ts'],
          criticalRelations: [
            {
              source: 'symbol:case-1:source',
              target: 'capability:case-1:guard',
              kind: 'guard',
              observation: 'absent',
            },
          ],
        },
      }),
    ],
  });
  const legacyPlan = createRunPlan(legacySuite, { baseDirectory: 'C:/benchmark' });
  const legacyResults = completeResults(legacySuite, legacyPlan);
  for (const legacyBaseline of legacyResults.runs.filter((run) => run.runId.includes(':baseline:'))) {
    legacyBaseline.relations[0] = {
      ...legacyBaseline.relations[0],
      source: 'symbol:src/alternate.ts:equivalentGuard',
    };
  }
  const legacyReport = evaluateResults(
    legacySuite,
    legacyPlan,
    legacyResults,
    evaluationOptions(legacySuite, legacyPlan),
  );
  assert.equal(legacyReport.armMetrics.baseline.relationRecall, 0);
});

test('does not count an exact relation without its stable id in gate assisted scoring', () => {
  const suite = gateSuite();
  const plan = createRunPlan(suite, { baseDirectory: 'C:/benchmark' });
  const results = completeResults(suite, plan);
  const assisted = results.runs.find((run) => run.runId.includes('bug-0:assisted:'));
  delete assisted.relations[0].relationId;
  const report = evaluateResults(suite, plan, results, evaluationOptions(suite, plan));
  assert.equal(report.armMetrics.assisted.relationRecall, 62 / 63);
});

test('builds a bounded global causal graph from multiple symptom seeds', () => {
  const analysis = buildGlobalCausalAnalysis(
    {
      snapshot: 'git:test-before',
      seeds: [
        { id: 'symptom:timeout', text: 'API timeout' },
        { id: 'symptom:disconnect', text: 'client disconnect' },
      ],
      nodes: [
        { id: 'symptom:timeout', type: 'symptom' },
        { id: 'symptom:disconnect', type: 'symptom' },
        { id: 'state:queue-full', type: 'state' },
        { id: 'state:pool-exhausted', type: 'state' },
        { id: 'component:api', type: 'component' },
      ],
      edges: [
        { id: 'e1', source: 'state:pool-exhausted', target: 'state:queue-full', kind: 'resource', strength: 0.95 },
        { id: 'e2', source: 'state:queue-full', target: 'symptom:timeout', kind: 'temporal', strength: 0.9 },
        { id: 'e3', source: 'state:pool-exhausted', target: 'symptom:disconnect', kind: 'event', strength: 0.8 },
        { id: 'e4', source: 'component:api', target: 'symptom:timeout', kind: 'call', strength: 0.2 },
      ],
      runtimeEvidence: [
        { nodeId: 'state:pool-exhausted', support: 0.9, temporal: 0.95, refs: ['log:42'] },
      ],
    },
    { maxDepth: 3, beamWidth: 8, maxHypotheses: 3 },
  );
  assert.match(analysis.analysisId, /^analysis:/);
  assert.equal(analysis.snapshot, 'git:test-before');
  assert.ok(analysis.graph.nodes.some((node) => node.id === 'state:pool-exhausted'));
  assert.ok(analysis.graph.edges.every((edge) => edge.evidenceLevel === 'potential'));
  assert.equal(analysis.hypotheses[0].root, 'state:pool-exhausted');
  assert.equal(analysis.hypotheses[0].counterfactual.support, 'medium');
  assert.equal(analysis.hypotheses[0].symptomCoverage, 1);
});

test('preserves competing root-cause hypotheses instead of expanding the whole graph', () => {
  const analysis = buildGlobalCausalAnalysis(
    {
      seeds: [{ id: 'symptom:error' }],
      nodes: [
        { id: 'symptom:error' },
        { id: 'root:db' },
        { id: 'root:cache' },
        { id: 'unrelated:node' },
      ],
      edges: [
        { source: 'root:db', target: 'symptom:error', kind: 'db', strength: 0.8 },
        { source: 'root:cache', target: 'symptom:error', kind: 'cache', strength: 0.75 },
        { source: 'unrelated:node', target: 'root:cache', kind: 'call', strength: 0.1 },
      ],
    },
    { maxDepth: 1, beamWidth: 2, maxHypotheses: 2 },
  );
  assert.deepEqual(analysis.hypotheses.map((item) => item.root), ['root:db', 'root:cache']);
  assert.ok(analysis.graph.nodes.every((node) => node.id !== 'unrelated:node'));
  assert.equal(analysis.coverage.maxCallDepth, 1);
});

test('compresses bounded runtime logs through RTK and preserves source provenance', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'causal-runtime-evidence-'));
  const logPath = path.join(directory, 'service.log');
  await writeFile(
    logPath,
    '2026-08-28T12:00:00Z service=api level=error trace_id=t-1 error_code=EPIPE token=secret-value\n' +
      '2026-08-28T12:00:01Z service=api level=error trace_id=t-1 error_code=EPIPE token=secret-value\n',
  );
  try {
    const evidence = await compressLogWithRtk({ filePath: logPath, rtkExecutable: 'rtk.exe' });
    assert.equal(evidence.status, 'compressed');
    assert.equal(evidence.sourceLines, 2);
    assert.equal(evidence.sourceTruncated, false);
    assert.match(evidence.sourceSha256, /^[a-f0-9]{64}$/);
    assert.doesNotMatch(evidence.content, /secret-value/);
    assert.ok(evidence.events.some((event) => event.traceId === 't-1'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('does not hide RTK failures as complete runtime evidence', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'causal-runtime-evidence-failed-'));
  const logPath = path.join(directory, 'service.log');
  await writeFile(logPath, 'level=error message=boom\n');
  try {
    const evidence = await compressLogWithRtk({ filePath: logPath, rtkExecutable: 'missing-rtk-for-test.exe' });
    assert.equal(evidence.status, 'failed');
    assert.match(evidence.error, /missing-rtk-for-test|ENOENT|spawn/i);
    assert.match(evidence.sourceSha256, /^[a-f0-9]{64}$/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('extracts stack locations and deterministically selects the narrowest CodeGraph node', () => {
  const locations = extractSourceLocations('panic at sdk/api/handlers/openai/codex_client_models.go:200:3');
  assert.deepEqual(locations, [{ filePath: 'sdk/api/handlers/openai/codex_client_models.go', line: 200, column: 3 }]);
  const nodes = selectNodesForSourceLocation([
    { id: 'file', filePath: 'sdk/api/handlers/openai/codex_client_models.go', startLine: 1, endLine: 300 },
    { id: 'function', filePath: 'sdk/api/handlers/openai/codex_client_models.go', startLine: 189, endLine: 213 },
  ], 'sdk/api/handlers/openai/codex_client_models.go', 200);
  assert.deepEqual(nodes.map((node) => node.id), ['function', 'file']);
});

test('missing provider token usage produces insufficient_data instead of an estimate', () => {
  const suite = gateSuite();
  const plan = createRunPlan(suite, { baseDirectory: 'C:/benchmark' });
  const results = completeResults(suite, plan);
  const assisted = results.runs.find((run) => run.runId.includes(':assisted:'));
  delete assisted.usage;
  const report = evaluateResults(suite, plan, results, evaluationOptions(suite, plan));
  assert.equal(report.decision, 'insufficient_data');
  assert.equal(report.dataCompleteness.checks.assistedMeasurementsComplete, false);
});

test('a repaired relation reported as missing by the model blocks the gate even when packet audit is clean', () => {
  const suite = gateSuite();
  const plan = createRunPlan(suite, { baseDirectory: 'C:/benchmark' });
  const results = completeResults(suite, plan, { fixedRegressionFalsePositive: true });
  const report = evaluateResults(
    suite,
    plan,
    results,
    evaluationOptions(suite, plan),
  );
  assert.equal(report.decision, 'no_go');
  assert.equal(report.thresholdChecks.noFixedRegressionFalsePositive, false);
  assert.equal(report.evidenceMetrics.fixedRegressionFalsePositives, 0);
  assert.ok(report.armMetrics.assisted.fixedRegressionFalsePositives > 0);
});

test('an evidence packet cannot satisfy the model relation-recall gate by itself', () => {
  const suite = gateSuite();
  const plan = createRunPlan(suite, { baseDirectory: 'C:/benchmark' });
  const report = evaluateResults(
    suite,
    plan,
    completeResults(suite, plan, { omitAssistedRelations: true }),
    evaluationOptions(suite, plan),
  );
  assert.equal(report.decision, 'no_go');
  assert.equal(report.evidenceMetrics.criticalRelationRecall, 1);
  assert.equal(report.armMetrics.assisted.relationRecall, 0);
  assert.equal(report.thresholdChecks.evidenceAuditCriticalRelationRecallAtLeastEightyFivePercent, true);
  assert.equal(report.thresholdChecks.assistedModelCriticalRelationRecallAtLeastEightyFivePercent, false);
});

test('rejects a tampered run plan and mixed usage sources', () => {
  const suite = gateSuite();
  const plan = createRunPlan(suite, { baseDirectory: 'C:/benchmark' });
  const tampered = structuredClone(plan);
  tampered.runOrder[0].problem.text = 'changed after randomization';
  assert.throws(
    () => evaluateResults(suite, tampered, completeResults(suite, plan), evaluationOptions(suite, plan)),
    /does not match the deterministic plan/,
  );

  const results = completeResults(suite, plan);
  const assisted = results.runs.find((run) => run.runId.includes(':assisted:'));
  assisted.usage.source = 'different-provider';
  const report = evaluateResults(suite, plan, results, evaluationOptions(suite, plan));
  assert.equal(report.decision, 'insufficient_data');
  assert.equal(report.dataCompleteness.checks.commonUsageSource, false);

  const overBudgetResults = completeResults(suite, plan);
  overBudgetResults.runs[0].usage.inputTokens = suite.executionProfile.tokenBudget + 1;
  const overBudget = evaluateResults(suite, plan, overBudgetResults, evaluationOptions(suite, plan));
  assert.equal(overBudget.decision, 'insufficient_data');
  assert.equal(overBudget.dataCompleteness.checks.everyRunWithinTokenBudget, false);
});

test('spike mode remains insufficient and CLI does not expose truth in the run plan', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'causal-benchmark-cli-'));
  try {
    const suite = suiteFixture();
    const suitePath = path.join(directory, 'suite.json');
    const planPath = path.join(directory, 'plan.json');
    const resultsPath = path.join(directory, 'results.json');
    const reportPath = path.join(directory, 'report.json');
    await writeFile(suitePath, JSON.stringify(suite));

    const validate = await runCli(['validate', '--suite', suitePath]);
    assert.equal(validate.code, 0, validate.stderr);
    assert.equal(JSON.parse(validate.stdout).valid, true);

    const planned = await runCli(['plan', '--suite', suitePath, '--out', planPath]);
    assert.equal(planned.code, 0, planned.stderr);
    const planText = await readFile(planPath, 'utf8');
    assert.doesNotMatch(planText, /case-1-root|truth/);
    const plan = JSON.parse(planText);
    const taskPath = path.join(directory, 'task.json');
    const task = await runCli([
      'task',
      '--suite',
      suitePath,
      '--plan',
      planPath,
      '--run-id',
      plan.runOrder[0].runId,
      '--out',
      taskPath,
    ]);
    assert.equal(task.code, 0, task.stderr);
    assert.doesNotMatch(await readFile(taskPath, 'utf8'), /caseId|repositoryId|case-1-root|truth/);
    await writeFile(resultsPath, JSON.stringify({ schemaVersion: 1, planId: plan.planId, runs: [] }));

    const evaluated = await runCli([
      'evaluate',
      '--suite',
      suitePath,
      '--plan',
      planPath,
      '--results',
      resultsPath,
      '--out',
      reportPath,
      '--allow-non-go',
    ]);
    assert.equal(evaluated.code, 0, evaluated.stderr);
    const report = JSON.parse(await readFile(reportPath, 'utf8'));
    assert.equal(report.decision, 'insufficient_data');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('CLI rejects unknown options instead of silently ignoring them', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'causal-benchmark-cli-options-'));
  try {
    const suitePath = path.join(directory, 'suite.json');
    await writeFile(suitePath, JSON.stringify(suiteFixture()));
    const result = await runCli(['validate', '--suite', suitePath, '--force']);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Unknown option --force for validate/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('collects only a complete set of known runner results', () => {
  const suite = suiteFixture({ repetitions: 1 });
  const plan = createRunPlan(suite, { baseDirectory: 'C:/benchmark' });
  const runResults = plan.runOrder.map((run) => resultForRun(run, suite));
  const collected = collectRunResults(suite, plan, runResults, { baseDirectory: 'C:/benchmark' });
  assert.equal(collected.planId, plan.planId);
  assert.equal(collected.runs.length, 2);
  assert.throws(
    () => collectRunResults(suite, plan, runResults.slice(0, 1), { baseDirectory: 'C:/benchmark' }),
    /missing planned runIds/,
  );
  assert.throws(
    () => collectRunResults(suite, plan, [...runResults, runResults[0]], { baseDirectory: 'C:/benchmark' }),
    /duplicate value/,
  );
  assert.throws(
    () => collectRunResults(
      suite,
      plan,
      [{ ...runResults[0], runId: 'unknown:baseline:1' }, runResults[1]],
      { baseDirectory: 'C:/benchmark' },
    ),
    /unknown runId/,
  );
});

test('Codex runner injects bounded evidence and records JSONL usage without token estimates', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'causal-benchmark-codex-runner-'));
  try {
    const workspace = path.join(directory, 'workspace');
    const evidencePath = path.join(directory, 'evidence.json');
    const fakeCodex = path.join(directory, 'fake-codex.mjs');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(workspace));
    const evidenceText = JSON.stringify({
      elapsedMs: 321,
      claims: [],
      generator: 'test-generator',
      query: 'test query',
      content: 'bounded-evidence-marker',
    });
    await writeFile(evidencePath, evidenceText);
    await writeFile(
      fakeCodex,
      [
        "const response = { rootCauseCandidates: [{ path: 'src/root.ts', confidence: 0.9 }], relations: [] };",
        "process.stderr.write(process.argv.join(' ') + '\\n');",
        "process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'command_execution' } }) + '\\n');",
        "process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(response) } }) + '\\n');",
        "process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1000, cached_input_tokens: 100, cache_write_input_tokens: 0, output_tokens: 100 } }) + '\\n');",
      ].join('\n'),
    );
    const task = {
      schemaVersion: 1,
      planId: 'plan-1',
      executionProfile: {
        model: 'test-model',
        reasoningEffort: 'high',
        promptVersion: 'v1',
        tokenBudget: 5000,
        timeoutMs: 10000,
        maxToolCalls: 12,
      },
      run: {
        runId: 'case-1:assisted:1',
        workspace: { path: workspace, snapshot: 'git:before' },
        problem: { text: 'Find the root cause' },
        evidence: {
          path: evidencePath,
          sha256: createHash('sha256').update(evidenceText).digest('hex'),
        },
      },
    };
    const execution = await runCodexTask(task, {
      executable: fakeCodex,
      outputSchemaPath: path.join(experimentRoot, 'codex-output.schema.json'),
    });
    assert.equal(execution.result.status, 'completed');
    assert.equal(execution.result.usage.source, 'codex.turn.completed');
    assert.equal(execution.result.usage.inputTokens, 1000);
    assert.equal(execution.result.metrics.evidencePreparationMs, 321);
    assert.equal(execution.result.metrics.toolCalls, 1);
    assert.equal(execution.result.metrics.filesRead, null);
    assert.equal(execution.result.candidateEvents[0].source, 'final_response');
    assert.equal(execution.result.candidateEvents[0].rootCauseFiles[0], 'src/root.ts');
    assert.match(execution.diagnostics, /bounded-evidence-marker/);
    assert.match(execution.diagnostics, /--ignore-rules/);
    assert.match(execution.diagnostics, /bounded candidate relations/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Codex runner preserves malformed output as a failed run', () => {
  const malformed = parseCodexOutput([
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'not-json' } }),
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1 } }),
  ].join('\n'));
  assert.equal(malformed.ok, false);
  assert.match(malformed.error, /not valid JSON/);
});

test('benchmark normalizes model file candidates that include line locations', () => {
  const suite = suiteFixture({ repetitions: 1 });
  const plan = createRunPlan(suite, { baseDirectory: 'C:/benchmark' });
  const run = plan.runOrder.find((item) => item.armId === 'assisted');
  const makeResult = (runId) => ({
    runId,
    status: 'completed',
    rootCauseCandidates: [{ path: 'src/case-1-root.ts:42:7', confidence: 0.91 }],
    relations: [{ ...suite.cases[0].truth.criticalRelations[0], confidence: 0.9 }],
    candidateEvents: [{ elapsedMs: 100, rootCauseFiles: ['src/case-1-root.ts:42:7'] }],
    usage: { source: 'provider', inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
    metrics: { wallTimeMs: 100, evidencePreparationMs: 0, toolCalls: 1, filesRead: null, charactersRead: null },
  });
  const results = collectRunResults(suite, plan, plan.runOrder.map((item) => makeResult(item.runId)), { baseDirectory: 'C:/benchmark' });
  const assisted = results.runs.find((item) => item.runId === run.runId);
  assert.equal(assisted.rootCauseCandidates[0].path, 'src/case-1-root.ts');
  assert.equal(assisted.candidateEvents[0].rootCauseFiles[0], 'src/case-1-root.ts');
});

test('Codex runner terminates a run that exceeds its hard tool-call budget', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'causal-benchmark-tool-budget-'));
  try {
    const workspace = path.join(directory, 'workspace');
    const fakeCodex = path.join(directory, 'fake-codex.mjs');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(workspace));
    await writeFile(
      fakeCodex,
      [
        "process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'command_execution' } }) + '\\n');",
        "process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'file_search' } }) + '\\n');",
        "setTimeout(() => process.exit(0), 1000);",
      ].join('\n'),
    );
    const task = {
      schemaVersion: 1,
      planId: 'plan-1',
      executionProfile: {
        model: 'test-model',
        reasoningEffort: 'high',
        promptVersion: 'v1',
        tokenBudget: 5000,
        timeoutMs: 5000,
        maxToolCalls: 1,
      },
      run: {
        runId: 'case-1:baseline:1',
        workspace: { path: workspace, snapshot: 'git:before' },
        problem: { text: 'Find the root cause' },
        evidence: null,
      },
    };
    const execution = await runCodexTask(task, {
      executable: fakeCodex,
      outputSchemaPath: path.join(experimentRoot, 'codex-output.schema.json'),
    });
    assert.equal(execution.result.status, 'failed');
    assert.match(execution.result.error, /exceeded maxToolCalls=1 after 2 tool calls/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('batch runner keeps task outputs isolated', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'causal-benchmark-batch-'));
  try {
    const workspace = path.join(directory, 'workspace');
    const fakeCodex = path.join(directory, 'fake-codex.mjs');
    const resultDirectory = path.join(directory, 'results');
    const transcriptDirectory = path.join(directory, 'transcripts');
    const diagnosticsDirectory = path.join(directory, 'diagnostics');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(workspace));
    await writeFile(
      fakeCodex,
      [
        "const response = { rootCauseCandidates: [{ path: 'src/root.ts', confidence: 0.9 }], relations: [] };",
        "process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(response) } }) + '\\n');",
        "process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1000, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 100 } }) + '\\n');",
      ].join('\n'),
    );
    const createTask = (runId) => ({
      schemaVersion: 1,
      planId: 'plan-1',
      executionProfile: {
        model: 'test-model', reasoningEffort: 'high', promptVersion: 'v1',
        tokenBudget: 5000, timeoutMs: 10000, maxToolCalls: 2,
      },
      run: { runId, workspace: { path: workspace, snapshot: 'git:before' }, problem: { text: 'Find root' }, evidence: null },
    });
    await Promise.all([resultDirectory, transcriptDirectory, diagnosticsDirectory].map((directoryPath) => import('node:fs/promises').then(({ mkdir }) => mkdir(directoryPath))));
    const manifest = await runBatch([createTask('case-a:baseline:1'), createTask('case-b:assisted:1')], {
      concurrency: 2,
      executable: fakeCodex,
      outputSchemaPath: path.join(experimentRoot, 'codex-output.schema.json'),
      resultDirectory,
      transcriptDirectory,
      diagnosticsDirectory,
      force: false,
    });
    assert.equal(manifest.length, 2);
    assert.deepEqual(manifest.map((item) => item.status), ['completed', 'completed']);
    assert.notEqual(manifest[0].resultPath, manifest[1].resultPath);
    assert.match(await readFile(manifest[0].transcriptPath, 'utf8'), /agent_message/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Codex runner task validation rejects leaked coordinator fields', () => {
  const task = {
    schemaVersion: 1,
    planId: 'plan-1',
    executionProfile: {
      model: 'test-model',
      reasoningEffort: 'high',
      promptVersion: 'v1',
      tokenBudget: 5000,
      timeoutMs: 10000,
      maxToolCalls: 12,
    },
    run: {
      runId: 'case-1:baseline:1',
      caseId: 'must-not-leak',
      workspace: { path: 'C:/workspace', snapshot: 'git:before' },
      problem: { text: 'Find the root cause' },
      evidence: null,
    },
  };
  assert.throws(() => validateRunnerTask(task), /unknown field "caseId"/);
  const prompt = buildCodexPrompt({ ...task, run: { ...task.run, caseId: undefined } });
  assert.match(prompt, /Do not modify files/);
  assert.match(prompt, /or search for a fix commit/);
  assert.match(prompt, /observation must be exactly one of: present, absent, unknown/);
  assert.match(prompt, /do not invent alternatives/);
  assert.doesNotMatch(prompt, /must-not-leak/);
});
