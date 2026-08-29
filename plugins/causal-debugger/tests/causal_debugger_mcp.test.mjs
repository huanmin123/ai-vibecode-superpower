import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildGlobalCausalAnalysis } from '../lib/causal-engine.mjs';
import { assessAnalysisResult, assessIncidentInput } from '../lib/clarification-policy.mjs';
import { buildRuntimeSequenceEdges, expandSeedQueries } from '../lib/codegraph-adapter.mjs';
import { expandEvidencePacket, selectEvidencePacket } from '../lib/evidence-selection.mjs';
import { parseIncidentDescription } from '../lib/incident-parser.mjs';
import { compressLogWithRtk, redactRuntimeText } from '../lib/runtime-evidence.mjs';

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverPath = path.join(pluginRoot, 'scripts', 'causal_debugger_mcp.mjs');

function callServer(requests) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [serverPath], { cwd: pluginRoot, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code !== 0) return reject(new Error(`MCP exited ${code}: ${stderr}`));
      resolve(stdout.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)));
    });
    child.stdin.end(`${requests.map((request) => JSON.stringify(request)).join('\n')}\n`);
  });
}

test('MCP server initializes and declares only read-only causal tools', async () => {
  const responses = await callServer([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  ]);
  assert.equal(responses[0].result.serverInfo.name, 'causal-debugger');
  assert.deepEqual(responses[1].result.tools.map((tool) => tool.name), ['causal_status', 'causal_analyze', 'causal_expand']);
});

test('MCP reports an unknown tool without falling back to source scanning', async () => {
  const [response] = await callServer([
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'causal_rebuild', arguments: {} } },
  ]);
  assert.equal(response.result.isError, true);
  assert.match(response.result.structuredContent.error, /Unknown tool/);
});

test('causal_expand refuses to invent a ledger when the analysis is not cached', async () => {
  const [response] = await callServer([
    { jsonrpc: '2.0', id: 31, method: 'tools/call', params: { name: 'causal_expand', arguments: { analysisId: 'analysis:missing' } } },
  ]);
  assert.equal(response.result.isError, true);
  assert.match(response.result.structuredContent.error, /analysis cache not found/);
});

test('causal analysis preserves beam width per seed and reports truncation', () => {
  const result = buildGlobalCausalAnalysis({
    snapshot: 'test',
    seeds: [{ id: 'symptom:a', text: 'a' }, { id: 'symptom:b', text: 'b' }],
    nodes: [
      { id: 'symptom:a', type: 'event', label: 'a' }, { id: 'symptom:b', type: 'event', label: 'b' },
      { id: 'root:a:1', type: 'function', label: 'a1' }, { id: 'root:a:2', type: 'function', label: 'a2' },
      { id: 'root:b:1', type: 'function', label: 'b1' }, { id: 'root:b:2', type: 'function', label: 'b2' },
    ],
    edges: [
      { id: 'a1', source: 'root:a:1', target: 'symptom:a', kind: 'calls', strength: 1 },
      { id: 'a2', source: 'root:a:2', target: 'symptom:a', kind: 'calls', strength: 0.9 },
      { id: 'b1', source: 'root:b:1', target: 'symptom:b', kind: 'calls', strength: 1 },
      { id: 'b2', source: 'root:b:2', target: 'symptom:b', kind: 'calls', strength: 0.9 },
    ],
  }, { maxDepth: 1, beamWidth: 1 });
  assert.deepEqual(result.hypotheses.map((item) => item.root).sort(), ['root:a:1', 'root:b:1']);
  assert.equal(result.coverage.truncated, true);
});

test('causal graph scope preserves bounded downstream relationships', () => {
  const result = buildGlobalCausalAnalysis({
    snapshot: 'scope-test',
    seeds: [{ id: 'symptom', text: 'symptom' }],
    nodes: [
      { id: 'root', type: 'function', label: 'root' },
      { id: 'symptom', type: 'event', label: 'symptom' },
      { id: 'downstream', type: 'function', label: 'downstream' },
    ],
    edges: [
      { id: 'upstream', source: 'root', target: 'symptom', kind: 'calls', strength: 0.9 },
      { id: 'downstream-edge', source: 'symptom', target: 'downstream', kind: 'calls', strength: 0.8 },
    ],
    graphScope: { nodeIds: ['root', 'symptom', 'downstream'], truncated: false },
  }, { maxDepth: 1, beamWidth: 2 });
  assert.deepEqual(result.graph.nodes.map((node) => node.id).sort(), ['downstream', 'root', 'symptom']);
  assert.equal(result.graph.edges.some((edge) => edge.id === 'downstream-edge'), true);
});

test('evidence packet keeps every hypothesis path before ranking optional graph content', () => {
  const analysis = buildGlobalCausalAnalysis({
    snapshot: 'packet-retention-test',
    seeds: [{ id: 'symptom', text: 'symptom' }],
    nodes: [
      { id: 'root', type: 'function', label: 'root' },
      { id: 'symptom', type: 'event', label: 'symptom' },
      { id: 'noise-a', type: 'function', label: 'noise-a' },
      { id: 'noise-b', type: 'function', label: 'noise-b' },
    ],
    edges: [
      { id: 'root-symptom', source: 'root', target: 'symptom', kind: 'guard', strength: 1 },
      { id: 'noise-a-symptom', source: 'noise-a', target: 'symptom', kind: 'calls', strength: 0.1 },
      { id: 'noise-b-symptom', source: 'noise-b', target: 'symptom', kind: 'calls', strength: 0.1 },
    ],
    graphScope: { nodeIds: ['root', 'symptom', 'noise-a', 'noise-b'], truncated: false },
  }, { maxDepth: 1, beamWidth: 1 });
  const packet = selectEvidencePacket({
    analysis,
    evidence: { runtime: { mapped: [] } },
  }, { nodeLimit: 2, edgeLimit: 1 });
  assert.equal(packet.coverage_manifest.budgetExceeded, false);
  assert.equal(packet.coverage_manifest.perSeed[0].covered, true);
  assert.deepEqual(packet.coverage_manifest.includedNodeIds.sort(), ['root', 'symptom']);
  assert.deepEqual(packet.coverage_manifest.includedEdgeIds, ['root-symptom']);
  assert.deepEqual(packet.coverage_manifest.omittedNodeIds, []);
  assert.match(packet.coverage_manifest.omittedIndex.nodeIdsSha256, /^[a-f0-9]{64}$/);
  const auditPacket = selectEvidencePacket({ analysis, evidence: { runtime: { mapped: [] } } }, { nodeLimit: 2, edgeLimit: 1, includeOmittedIds: true });
  assert.deepEqual(auditPacket.coverage_manifest.omittedNodeIds.sort(), ['noise-a', 'noise-b']);
  assert.equal(packet.coverage_manifest.endpointClosure, true);
});

test('evidence expansion is deterministic and reports unknown requested identifiers', () => {
  const analysis = buildGlobalCausalAnalysis({
    snapshot: 'packet-expand-test',
    seeds: [{ id: 'symptom', text: 'symptom' }],
    nodes: [{ id: 'root', type: 'function', label: 'root' }, { id: 'symptom', type: 'event', label: 'symptom' }],
    edges: [{ id: 'root-symptom', source: 'root', target: 'symptom', kind: 'calls', strength: 1 }],
  }, { maxDepth: 1, beamWidth: 1 });
  const first = expandEvidencePacket({ analysis }, { nodeIds: ['root'], nodeLimit: 4, edgeLimit: 4 });
  const second = expandEvidencePacket({ analysis }, { nodeIds: ['root'], nodeLimit: 4, edgeLimit: 4 });
  assert.equal(first.packetHash, second.packetHash);
  assert.equal(first.coverage_manifest.endpointClosure, true);
  assert.deepEqual(first.graph.edges.map((edge) => edge.id), ['root-symptom']);
  const missing = expandEvidencePacket({ analysis }, { seedIds: ['missing-seed'], nodeLimit: 4, edgeLimit: 4 });
  assert.deepEqual(missing.coverage_manifest.missingSeedIds, ['missing-seed']);
});

test('evidence packet reports mandatory overflow instead of dropping required paths', () => {
  const analysis = buildGlobalCausalAnalysis({
    snapshot: 'packet-overflow-test',
    seeds: [{ id: 'symptom-a', text: 'a' }, { id: 'symptom-b', text: 'b' }],
    nodes: [
      { id: 'root-a', type: 'function', label: 'root-a' },
      { id: 'root-b', type: 'function', label: 'root-b' },
      { id: 'symptom-a', type: 'event', label: 'a' },
      { id: 'symptom-b', type: 'event', label: 'b' },
    ],
    edges: [
      { id: 'root-a-symptom-a', source: 'root-a', target: 'symptom-a', kind: 'calls', strength: 1 },
      { id: 'root-b-symptom-b', source: 'root-b', target: 'symptom-b', kind: 'calls', strength: 1 },
    ],
  }, { maxDepth: 1, beamWidth: 1 });
  const packet = selectEvidencePacket({ analysis, evidence: { runtime: { mapped: [] } } }, { nodeLimit: 2, edgeLimit: 1 });
  assert.equal(packet.coverage_manifest.mandatoryOverflow, true);
  assert.equal(packet.coverage_manifest.budgetExceeded, true);
  assert.deepEqual(packet.coverage_manifest.omittedNodeIds, []);
  assert.deepEqual(packet.coverage_manifest.omittedEdgeIds, []);
  assert.equal(packet.coverage_manifest.perSeed.every((item) => item.covered), true);
});

test('counterfactual remains unknown without intervention or confirmed evidence', () => {
  const result = buildGlobalCausalAnalysis({
    snapshot: 'counterfactual-test',
    seeds: [{ id: 'symptom', text: 'symptom' }],
    nodes: [{ id: 'root', type: 'function', label: 'root' }, { id: 'symptom', type: 'event', label: 'symptom' }],
    edges: [{ id: 'edge', source: 'root', target: 'symptom', kind: 'calls', strength: 1 }],
  }, { maxDepth: 1, beamWidth: 2 });
  assert.equal(result.hypotheses[0].counterfactual.graphRemovalSupport, 'high');
  assert.equal(result.hypotheses[0].counterfactual.support, 'unknown');
});

test('intervention evidence is scored separately from runtime severity', () => {
  const result = buildGlobalCausalAnalysis({
    snapshot: 'intervention-test',
    seeds: [{ id: 'symptom', text: 'symptom' }],
    nodes: [{ id: 'root', type: 'function', label: 'root' }, { id: 'symptom', type: 'event', label: 'symptom' }],
    edges: [{ id: 'edge', source: 'root', target: 'symptom', kind: 'calls', strength: 1 }],
    runtimeEvidence: [{ nodeId: 'root', support: 0.8, temporal: 0.7, interventionLift: 1, refs: ['replay-1'] }],
  }, { maxDepth: 1, beamWidth: 2 });
  assert.equal(result.hypotheses[0].runtimeSupport, 0.8);
  assert.equal(result.hypotheses[0].interventionLift, 1);
  assert.equal(result.hypotheses[0].confidence, 'high');
  assert.deepEqual(result.hypotheses[0].supportingEvidence, ['replay-1']);
  assert.equal(result.hypotheses[0].paths[0].edges[0].id, 'edge');
  assert.equal(result.hypotheses[0].counterfactual.support, 'high');
});

test('unverified hypotheses expose low evidence confidence instead of a probability claim', () => {
  const result = buildGlobalCausalAnalysis({
    snapshot: 'confidence-test',
    seeds: [{ id: 'symptom', text: 'symptom' }],
    nodes: [{ id: 'root', type: 'function', label: 'root' }, { id: 'symptom', type: 'event', label: 'symptom' }],
    edges: [{ id: 'edge', source: 'root', target: 'symptom', kind: 'calls', strength: 1 }],
  }, { maxDepth: 1, beamWidth: 2 });
  assert.equal(result.hypotheses[0].confidence, 'low');
  assert.deepEqual(result.hypotheses[0].supportingEvidence, []);
  assert.deepEqual(result.hypotheses[0].conflicts, []);
  assert.deepEqual(result.hypotheses[0].missingEvidence, []);
});

test('hypothesis evidence references include observations on intermediate path nodes', () => {
  const result = buildGlobalCausalAnalysis({
    snapshot: 'path-evidence-test',
    seeds: [{ id: 'symptom', text: 'symptom' }],
    nodes: [
      { id: 'root', type: 'function', label: 'root' },
      { id: 'middle', type: 'function', label: 'middle' },
      { id: 'symptom', type: 'event', label: 'symptom' },
    ],
    edges: [
      { id: 'root-middle', source: 'root', target: 'middle', kind: 'calls', strength: 1 },
      { id: 'middle-symptom', source: 'middle', target: 'symptom', kind: 'calls', strength: 1 },
    ],
    runtimeEvidence: [{ nodeId: 'middle', support: 0.8, refs: ['middle-log'] }],
  }, { maxDepth: 2, beamWidth: 2 });
  const rootHypothesis = result.hypotheses.find((hypothesis) => hypothesis.root === 'root');
  assert.ok(rootHypothesis);
  assert.deepEqual(rootHypothesis.supportingEvidence, ['middle-log']);
  assert.equal(rootHypothesis.directRuntimeSupport, 0);
  assert.equal(rootHypothesis.propagatedRuntimeSupport, 0.6000000000000001);
});

test('unknowns, relation gaps, probes and graph truncation are preserved', () => {
  const result = buildGlobalCausalAnalysis({
    snapshot: 'coverage-test',
    seeds: [{ id: 'symptom', text: 'symptom' }],
    nodes: [{ id: 'root', type: 'function', label: 'root' }, { id: 'symptom', type: 'event', label: 'symptom' }],
    edges: [{ id: 'edge', source: 'root', target: 'symptom', kind: 'calls', strength: 1 }],
    graphScope: { nodeIds: ['root', 'symptom'], truncated: true },
    truncated: true,
    unknowns: [{ eventId: 'log-1', reason: 'missing_source_location', detail: 'stack omitted' }],
    relationGaps: [{ id: 'gap-1', nodeId: 'root', kind: 'missing_relation', reason: 'missing trace edge', severity: 0.7 }],
    recommendedProbes: ['provide stack trace', 'narrow seed'],
  }, { maxDepth: 1, beamWidth: 2 });
  assert.equal(result.coverage.truncated, true);
  assert.deepEqual(result.coverage.truncationReasons, ['neighborhood_bound']);
  assert.deepEqual(result.unknowns[0].reason, 'missing_source_location');
  assert.equal(result.hypotheses[0].unresolvedGap, 0.7);
  assert.deepEqual(result.recommendedProbes, ['provide stack trace', 'narrow seed']);
});

test('runtime sequence edges require a shared trace or request and valid timestamps', () => {
  const mapped = [
    { nodeId: 'node-a', event: { id: 'a', traceId: 'trace-1', timestamp: '2026-08-29T00:00:00Z' }, temporal: 0 },
    { nodeId: 'node-b', event: { id: 'b', traceId: 'trace-1', timestamp: '2026-08-29T00:00:01Z' }, temporal: 0 },
    { nodeId: 'node-c', event: { id: 'c', traceId: 'trace-2', timestamp: '2026-08-29T00:00:02Z' }, temporal: 0 },
  ];
  const edges = buildRuntimeSequenceEdges(mapped);
  assert.deepEqual(edges.map((edge) => [edge.source, edge.target]), [['observation:a', 'observation:b']]);
  assert.equal(mapped[0].temporal, 0.7);
  assert.equal(mapped[1].temporal, 0.7);
  assert.equal(mapped[2].temporal, 0);
});

test('natural-language seed expansion keeps the full query and useful identifiers', () => {
  const expanded = expandSeedQueries(['MODEL_CAPACITY_EXHAUSTED in googleQuotaErrors.ts']);
  assert.equal(expanded[0], 'MODEL_CAPACITY_EXHAUSTED in googleQuotaErrors.ts');
  assert.equal(expanded.includes('MODEL_CAPACITY_EXHAUSTED'), true);
  assert.equal(expanded.includes('googleQuotaErrors.ts'), true);
  assert.equal(expanded.includes('in'), false);
});

test('incident parser extracts deterministic anchors and preserves unknowns', () => {
  const parsed = parseIncidentDescription('POST /v1/chat failed with MODEL_CAPACITY_EXHAUSTED in packages/core/googleQuotaErrors.ts:333, traceId=abc-1, process.env.RETRY_LIMIT, table audit_log');
  assert.deepEqual(parsed.sourceLocations, [{ filePath: 'packages/core/googleQuotaErrors.ts', line: 333, column: null }]);
  assert.equal(parsed.errorCodes.includes('MODEL_CAPACITY_EXHAUSTED'), true);
  assert.equal(parsed.endpoints.includes('/v1/chat'), true);
  assert.equal(parsed.configKeys.includes('RETRY_LIMIT'), true);
  assert.equal(parsed.sqlIdentifiers.includes('audit_log'), true);
  assert.equal(parsed.files.includes('packages/core/googleQuotaErrors.ts'), true);
  assert.equal(parsed.symbols.includes('utils'), false);
  assert.equal(parsed.traceIds.includes('abc-1'), true);
  assert.equal(parsed.unknowns.some((item) => item.reason === 'missing_source_location'), false);
  assert.equal(parsed.queries[0].startsWith('POST /v1/chat'), true);
});

test('incident parser accepts explicit stack locations without guessing code nodes', () => {
  const parsed = parseIncidentDescription('timeout in the request handler', { sourceLocations: [{ filePath: 'src/server.ts', line: 42 }] });
  assert.deepEqual(parsed.sourceLocations, [{ filePath: 'src/server.ts', line: 42 }]);
  assert.equal(parsed.anchors.includes('src/server.ts:42'), true);
  assert.equal(parsed.unknowns.some((item) => item.reason === 'missing_source_location'), false);
});

test('clarification policy stops before broad search when the description has no anchor', () => {
  const incident = parseIncidentDescription('页面好像有点问题');
  const triage = assessIncidentInput({ incident });
  assert.equal(triage.action, 'clarify_first');
  assert.equal(triage.shouldAnalyze, false);
  assert.match(triage.question, /报错|复现步骤/);
});

test('clarification policy analyzes exact locations without interrupting the user', () => {
  const incident = parseIncidentDescription('src/server.ts:42 throws EPIPE');
  const triage = assessIncidentInput({ incident });
  assert.equal(triage.action, 'analyze');
  assert.equal(triage.question, null);
});

test('clarification policy keeps bounded candidates but asks once for ambiguous anchors', () => {
  const incident = parseIncidentDescription('MODEL_CAPACITY_EXHAUSTED happens during retry');
  const preflight = assessIncidentInput({ incident });
  assert.equal(preflight.action, 'analyze_and_clarify');
  const triage = assessAnalysisResult({
    incident,
    evidence: { seeds: [{ id: 'one' }], seedMatches: [{ id: 'one' }], runtime: { mapped: [] } },
    analysis: { hypotheses: [{ root: 'one' }], coverage: { truncated: false } },
    preflight,
  });
  assert.equal(triage.action, 'analyze_and_clarify');
  assert.equal(triage.blocking, false);
});

test('clarification policy asks before retrying when CodeGraph finds no usable node', () => {
  const incident = parseIncidentDescription('MODEL_CAPACITY_EXHAUSTED happens during retry');
  const triage = assessAnalysisResult({
    incident,
    evidence: { seeds: [], seedMatches: [], runtime: { mapped: [] } },
    analysis: { hypotheses: [], coverage: { truncated: false } },
    preflight: assessIncidentInput({ incident }),
  });
  assert.equal(triage.action, 'clarify_first');
  assert.equal(triage.blocking, true);
});

test('clarification policy respects explicit seed evidence without requiring text matches', () => {
  const triage = assessAnalysisResult({
    incident: null,
    evidence: { seeds: [{ id: 'explicit' }], seedMatches: [], runtime: { mapped: [] } },
    analysis: { hypotheses: [{ root: 'explicit' }], coverage: { truncated: false } },
    preflight: assessIncidentInput({ seedIds: ['explicit'] }),
  });
  assert.equal(triage.action, 'analyze');
});

test('clarification policy does not claim an exact location was usable when mapping failed', () => {
  const incident = parseIncidentDescription('src/server.ts:42 throws EPIPE');
  const triage = assessAnalysisResult({
    incident,
    evidence: { seeds: [{ id: 'nearby' }], seedMatches: [{ id: 'nearby' }], runtime: { mapped: [] } },
    analysis: { hypotheses: [{ root: 'nearby' }], coverage: { truncated: false } },
    preflight: assessIncidentInput({ incident }),
  });
  assert.equal(triage.action, 'analyze_and_clarify');
  assert.equal(triage.reasonCodes.includes('source_location_not_mapped'), true);
});

test('MCP returns one clarification question without invoking CodeGraph for a vague description', async () => {
  const [response] = await callServer([
    { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'causal_analyze', arguments: { projectRoot: '.', description: '页面好像有点问题' } } },
  ]);
  assert.equal(response.result.structuredContent.status, 'needs_clarification');
  assert.equal(response.result.structuredContent.triage.action, 'clarify_first');
  assert.equal(response.result.structuredContent.evidence, null);
  assert.match(response.result.structuredContent.triage.question, /报错|复现步骤/);
});

test('runtime evidence rejects arbitrary executables before reading a log', async () => {
  await assert.rejects(
    () => compressLogWithRtk({ filePath: 'missing.log', rtkExecutable: 'node.exe' }),
    /rtkExecutable must be one of/,
  );
});

test('runtime evidence redacts bearer and structured secret values', () => {
  const redacted = redactRuntimeText('Authorization: Bearer SECRET token="abc" password=letmein Cookie: sid=123');
  assert.doesNotMatch(redacted, /SECRET|abc|letmein|sid=123/);
  assert.match(redacted, /\[REDACTED\]/);
});

test('MCP rejects a log file outside projectRoot', async () => {
  const [response] = await callServer([
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'causal_analyze', arguments: { projectRoot: '.', logFile: '..\\outside.log' } } },
  ]);
  assert.equal(response.result.isError, true);
  assert.match(response.result.structuredContent.error, /logFile must be inside projectRoot/);
});
