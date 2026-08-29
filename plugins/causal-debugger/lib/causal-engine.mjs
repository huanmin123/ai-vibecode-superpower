import { createHash } from 'node:crypto';

const DEFAULT_WEIGHTS = Object.freeze({
  prior: 0.15,
  symptomCoverage: 0.2,
  temporalSupport: 0.15,
  structuralSupport: 0.15,
  runtimeSupport: 0.2,
  interventionLift: 0.1,
  contradiction: 0.2,
  unresolvedGap: 0.15,
});

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireArray(value, name) {
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array`);
  return value;
}

function requireString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${name} must be a non-empty string`);
  return value;
}

function clamp(value) {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (!isObject(value)) return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function digest(value) {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function normalizeNode(node, index) {
  if (!isObject(node)) throw new TypeError(`nodes[${index}] must be an object`);
  const filePath = typeof node.filePath === 'string' && node.filePath !== '' ? node.filePath : null;
  const label = typeof node.label === 'string' ? node.label : node.id;
  return {
    id: requireString(node.id, `nodes[${index}].id`),
    type: typeof node.type === 'string' && node.type !== '' ? node.type : 'unknown',
    label,
    filePath,
    language: typeof node.language === 'string' && node.language !== '' ? node.language : null,
    isTest: node.isTest === true || /(?:^|[\\/])(?:test|tests|__tests__)(?:[\\/]|$)|(?:\.test|_test)\.[^.]+$/i.test(filePath ?? label),
  };
}

function normalizeEdge(edge, index) {
  if (!isObject(edge)) throw new TypeError(`edges[${index}] must be an object`);
  const source = requireString(edge.source, `edges[${index}].source`);
  const target = requireString(edge.target, `edges[${index}].target`);
  return {
    id: typeof edge.id === 'string' && edge.id !== '' ? edge.id : `edge:${source}->${target}:${index}`,
    source,
    target,
    kind: typeof edge.kind === 'string' && edge.kind !== '' ? edge.kind : 'unknown',
    evidenceLevel: typeof edge.evidenceLevel === 'string' ? edge.evidenceLevel : 'potential',
    strength: clamp(edge.strength ?? 0.5),
    staticResolutionScore: clamp(edge.staticResolutionScore ?? edge.strength ?? 0.5),
    provenance: typeof edge.provenance === 'string' && edge.provenance !== '' ? edge.provenance : null,
    refs: Array.isArray(edge.refs) ? edge.refs.filter((ref) => typeof ref === 'string') : [],
  };
}

function normalizeSeed(seed, index) {
  if (!isObject(seed)) throw new TypeError(`seeds[${index}] must be an object`);
  return {
    id: requireString(seed.id, `seeds[${index}].id`),
    text: typeof seed.text === 'string' ? seed.text : seed.id,
  };
}

function normalizeRuntimeEvidence(evidence, index) {
  if (!isObject(evidence)) throw new TypeError(`runtimeEvidence[${index}] must be an object`);
  return {
    nodeId: requireString(evidence.nodeId, `runtimeEvidence[${index}].nodeId`),
    support: clamp(evidence.support ?? 0),
    contradiction: clamp(evidence.contradiction ?? 0),
    temporal: clamp(evidence.temporal ?? 0),
    refs: Array.isArray(evidence.refs) ? evidence.refs.filter((ref) => typeof ref === 'string') : [],
    interventionLift: clamp(evidence.interventionLift ?? 0),
  };
}

function normalizeUnknown(unknown, index) {
  if (!isObject(unknown)) throw new TypeError(`unknowns[${index}] must be an object`);
  return {
    eventId: typeof unknown.eventId === 'string' ? unknown.eventId : null,
    reason: typeof unknown.reason === 'string' && unknown.reason !== '' ? unknown.reason : 'unknown',
    detail: typeof unknown.detail === 'string' ? unknown.detail : null,
    location: isObject(unknown.location) ? unknown.location : null,
  };
}

function normalizeRelationGap(gap, index) {
  if (!isObject(gap)) throw new TypeError(`relationGaps[${index}] must be an object`);
  return {
    id: typeof gap.id === 'string' && gap.id !== '' ? gap.id : `gap:${index}`,
    nodeId: typeof gap.nodeId === 'string' && gap.nodeId !== '' ? gap.nodeId : null,
    kind: typeof gap.kind === 'string' && gap.kind !== '' ? gap.kind : 'missing_relation',
    reason: typeof gap.reason === 'string' && gap.reason !== '' ? gap.reason : 'unresolved relation',
    severity: clamp(gap.severity ?? 0.5),
    refs: Array.isArray(gap.refs) ? gap.refs.filter((ref) => typeof ref === 'string') : [],
  };
}

function pathKey(path) {
  return path.join('\u0000');
}

function sortByScore(items) {
  return [...items].sort((left, right) => right.score - left.score || left.nodeId.localeCompare(right.nodeId));
}

function evidenceConfidence({ runtimeSupport, temporalSupport, interventionLift, contradiction, unresolvedGap }) {
  if (interventionLift >= 0.7 && contradiction <= 0.1 && unresolvedGap <= 0.2) return 'high';
  if ((runtimeSupport >= 0.7 && temporalSupport >= 0.5 || interventionLift >= 0.3) && contradiction <= 0.25 && unresolvedGap <= 0.4) return 'medium';
  return 'low';
}

function propagatedMetric(rootPaths, evidenceByNode, field) {
  let best = 0;
  for (const path of rootPaths) {
    for (const [distance, nodeId] of path.path.entries()) {
      const evidence = evidenceByNode.get(nodeId) ?? [];
      if (evidence.length === 0) continue;
      const average = evidence.reduce((sum, item) => sum + item[field], 0) / evidence.length;
      best = Math.max(best, average * (0.75 ** distance));
    }
  }
  return best;
}

function buildReverseBeam(seeds, incoming, nodeMap, maxDepth, beamWidth) {
  const paths = [];
  let truncated = false;
  let frontier = seeds.map((seed) => ({ seedId: seed.id, nodeId: seed.id, path: [seed.id], score: 1 }));
  for (let depth = 0; depth <= maxDepth; depth += 1) {
    paths.push(...frontier);
    if (depth === maxDepth) break;
    const next = [];
    for (const item of frontier) {
      for (const edge of incoming.get(item.nodeId) ?? []) {
        if (!nodeMap.has(edge.source) || item.path.includes(edge.source)) continue;
        next.push({
          seedId: item.seedId,
          nodeId: edge.source,
          path: [edge.source, ...item.path],
          score: item.score * Math.max(0.05, edge.strength),
        });
      }
    }
    const bestByNode = new Map();
    for (const candidate of sortByScore(next)) {
      const existing = bestByNode.get(`${candidate.seedId}\u0000${candidate.nodeId}`);
      if (!existing || candidate.score > existing.score) bestByNode.set(`${candidate.seedId}\u0000${candidate.nodeId}`, candidate);
    }
    const grouped = new Map();
    for (const candidate of sortByScore([...bestByNode.values()])) {
      const list = grouped.get(candidate.seedId) ?? [];
      if (list.length >= beamWidth) truncated = true;
      if (list.length < beamWidth) list.push(candidate);
      grouped.set(candidate.seedId, list);
    }
    frontier = [...grouped.values()].flat();
  }
  return { paths, truncated };
}

function scoreHypothesis(root, rootPaths, seedCount, evidenceByNode, gapsByNode, nodeMap, priorByNode, weights, edges) {
  const coveredSeeds = new Set(rootPaths.map((path) => path.seedId));
  const evidence = evidenceByNode.get(root) ?? [];
  const directTemporalSupport = evidence.reduce((sum, item) => sum + item.temporal, 0) / Math.max(1, evidence.length);
  const directRuntimeSupport = evidence.reduce((sum, item) => sum + item.support, 0) / Math.max(1, evidence.length);
  const directInterventionLift = evidence.reduce((sum, item) => sum + item.interventionLift, 0) / Math.max(1, evidence.length);
  const directContradiction = evidence.reduce((sum, item) => sum + item.contradiction, 0) / Math.max(1, evidence.length);
  const propagatedTemporalSupport = propagatedMetric(rootPaths, evidenceByNode, 'temporal');
  const propagatedRuntimeSupport = propagatedMetric(rootPaths, evidenceByNode, 'support');
  const propagatedInterventionLift = propagatedMetric(rootPaths, evidenceByNode, 'interventionLift');
  const propagatedContradiction = propagatedMetric(rootPaths, evidenceByNode, 'contradiction');
  const temporalSupport = Math.max(directTemporalSupport, propagatedTemporalSupport);
  const runtimeSupport = Math.max(directRuntimeSupport, propagatedRuntimeSupport);
  const interventionLift = Math.max(directInterventionLift, propagatedInterventionLift);
  const contradiction = Math.max(directContradiction, propagatedContradiction);
  const structuralSupport = rootPaths.reduce((sum, path) => sum + path.score, 0) / Math.max(1, rootPaths.length);
  const symptomCoverage = coveredSeeds.size / Math.max(1, seedCount);
  const prior = clamp(priorByNode.get(root) ?? 0);
  const gaps = gapsByNode.get(root) ?? [];
  const unresolvedGap = gaps.reduce((sum, gap) => sum + gap.severity, 0) / Math.max(1, gaps.length);
  const testPenalty = nodeMap.get(root)?.isTest && evidence.length === 0 ? 0.1 : 0;
  const pathEdges = rootPaths.map((path) => path.path.slice(0, -1).map((source, index) => {
    const target = path.path[index + 1];
    return edges
      .filter((edge) => edge.source === source && edge.target === target)
      .sort((left, right) => right.strength - left.strength || left.id.localeCompare(right.id))[0] ?? null;
  }));
  const pathNodeIds = new Set(rootPaths.flatMap((path) => path.path));
  const pathEvidence = [...pathNodeIds].flatMap((nodeId) => evidenceByNode.get(nodeId) ?? []);
  const pathGaps = [...pathNodeIds].flatMap((nodeId) => gapsByNode.get(nodeId) ?? []);
  const supportingEvidence = [...new Set(pathEvidence.filter((item) => item.support > 0 || item.temporal > 0 || item.interventionLift > 0).flatMap((item) => item.refs))];
  const conflicts = [...new Set(pathEvidence.filter((item) => item.contradiction > 0).flatMap((item) => item.refs))];
  const missingEvidence = [...new Set(pathGaps.flatMap((gap) => gap.refs))];
  const score = clamp(
    weights.prior * prior +
    weights.symptomCoverage * symptomCoverage +
    weights.temporalSupport * temporalSupport +
    weights.structuralSupport * structuralSupport +
    weights.runtimeSupport * runtimeSupport +
    weights.interventionLift * interventionLift -
    weights.contradiction * contradiction -
    weights.unresolvedGap * unresolvedGap -
    testPenalty,
  );
  return {
    root,
    score,
    confidence: evidenceConfidence({ runtimeSupport, temporalSupport, interventionLift, contradiction, unresolvedGap }),
    prior,
    symptomCoverage,
    temporalSupport,
    directTemporalSupport,
    propagatedTemporalSupport,
    structuralSupport,
    runtimeSupport,
    directRuntimeSupport,
    propagatedRuntimeSupport,
    interventionLift,
    directInterventionLift,
    propagatedInterventionLift,
    contradiction,
    directContradiction,
    propagatedContradiction,
    unresolvedGap,
    testPenalty,
    supportingEvidence,
    conflicts,
    missingEvidence,
    paths: rootPaths.map((path, pathIndex) => ({
      seedId: path.seedId,
      nodes: path.path,
      edges: pathEdges[pathIndex].filter(Boolean).map((edge) => ({ id: edge.id, kind: edge.kind, evidenceLevel: edge.evidenceLevel, strength: edge.strength })),
      score: path.score,
    })),
  };
}

function evaluateCounterfactual(hypothesis, allPaths, edges, evidenceByNode) {
  const remaining = allPaths.filter((path) => path.path.includes(hypothesis.root) === false);
  const remainingSeeds = new Set(remaining.map((path) => path.seedId));
  const originalSeeds = new Set(hypothesis.paths.map((path) => path.seedId));
  const independentCoverage = originalSeeds.size === 0 ? 0 : remainingSeeds.size / originalSeeds.size;
  const graphRemovalSupport = independentCoverage === 0 ? 'high' : independentCoverage < 1 ? 'medium' : 'low';
  const hasConfirmedPath = hypothesis.paths.some((candidate) => candidate.nodes.slice(0, -1).every((source, index) => {
    const target = candidate.nodes[index + 1];
    return edges.some((edge) => edge.source === source && edge.target === target && edge.evidenceLevel === 'confirmed');
  }));
  const hasInterventionEvidence = (evidenceByNode.get(hypothesis.root) ?? []).some((item) => item.interventionLift > 0);
  return {
    removedRoot: hypothesis.root,
    independentCoverage,
    graphRemovalSupport,
    support: hasConfirmedPath || hasInterventionEvidence ? graphRemovalSupport : 'unknown',
  };
}

export function buildGlobalCausalAnalysis(input, options = {}) {
  if (!isObject(input)) throw new TypeError('input must be an object');
  const seeds = requireArray(input.seeds, 'seeds').map(normalizeSeed);
  const nodes = requireArray(input.nodes, 'nodes').map(normalizeNode);
  const edges = requireArray(input.edges, 'edges').map(normalizeEdge);
  const runtimeEvidence = requireArray(input.runtimeEvidence ?? [], 'runtimeEvidence').map(normalizeRuntimeEvidence);
  const unknowns = requireArray(input.unknowns ?? [], 'unknowns').map(normalizeUnknown);
  const relationGaps = requireArray(input.relationGaps ?? [], 'relationGaps').map(normalizeRelationGap);
  const maxDepth = Number.isInteger(options.maxDepth) && options.maxDepth >= 0 ? options.maxDepth : 3;
  const beamWidth = Number.isInteger(options.beamWidth) && options.beamWidth > 0 ? options.beamWidth : 24;
  const weights = { ...DEFAULT_WEIGHTS, ...(isObject(options.weights) ? options.weights : {}) };
  const nodeMap = new Map(nodes.map((node) => [node.id, node]));
  const priorByNode = new Map(Object.entries(isObject(input.priors) ? input.priors : {}).map(([id, value]) => [id, clamp(value)]));
  const incoming = new Map();
  for (const edge of edges) {
    const list = incoming.get(edge.target) ?? [];
    list.push(edge);
    incoming.set(edge.target, list);
  }
  const beam = buildReverseBeam(seeds, incoming, nodeMap, maxDepth, beamWidth);
  const allPaths = beam.paths;
  const causalPaths = allPaths.filter((path) => path.path.length > 1);
  const selectedNodeIds = new Set(allPaths.flatMap((path) => path.path));
  const evidenceByNode = new Map();
  for (const evidence of runtimeEvidence) {
    const list = evidenceByNode.get(evidence.nodeId) ?? [];
    list.push(evidence);
    evidenceByNode.set(evidence.nodeId, list);
  }
  const gapsByNode = new Map();
  for (const gap of relationGaps) {
    if (gap.nodeId === null) continue;
    const list = gapsByNode.get(gap.nodeId) ?? [];
    list.push(gap);
    gapsByNode.set(gap.nodeId, list);
  }
  const pathsByRoot = new Map();
  for (const path of causalPaths) {
    const root = path.path[0];
    const list = pathsByRoot.get(root) ?? [];
    list.push(path);
    pathsByRoot.set(root, list);
  }
  const hypotheses = [...pathsByRoot.entries()]
    .map(([root, rootPaths]) => scoreHypothesis(root, rootPaths, seeds.length, evidenceByNode, gapsByNode, nodeMap, priorByNode, weights, edges))
    .sort((left, right) => right.score - left.score || left.root.localeCompare(right.root))
    .slice(0, Number.isInteger(options.maxHypotheses) && options.maxHypotheses > 0 ? options.maxHypotheses : 5)
    .map((hypothesis) => ({ ...hypothesis, counterfactual: evaluateCounterfactual(hypothesis, causalPaths, edges, evidenceByNode) }));
  const scopeNodeIds = Array.isArray(input.graphScope?.nodeIds) ? input.graphScope.nodeIds.filter((id) => nodeMap.has(id)) : [];
  if (scopeNodeIds.length > 0) for (const id of scopeNodeIds) selectedNodeIds.add(id);
  const selectedEdges = edges.filter((edge) => selectedNodeIds.has(edge.source) && selectedNodeIds.has(edge.target));
  const graphNodes = [...selectedNodeIds].sort().map((id) => nodeMap.get(id)).filter(Boolean);
  const graphEdges = selectedEdges.sort((left, right) => left.id.localeCompare(right.id));
  const snapshot = typeof input.snapshot === 'string' && input.snapshot !== '' ? input.snapshot : 'unknown';
  const uncoveredSeeds = seeds.filter((seed) => !causalPaths.some((path) => path.seedId === seed.id)).map((seed) => seed.id);
  const recommendedProbes = Array.isArray(input.recommendedProbes)
    ? input.recommendedProbes.filter((probe) => typeof probe === 'string' && probe !== '').slice(0, 2)
    : [];
  const analysis = {
    analysisId: `analysis:${digest({ snapshot, seeds, graphNodes, graphEdges, runtimeEvidence })}`,
    snapshot,
    symptomSeeds: seeds,
    hypotheses,
    graph: { nodes: graphNodes, edges: graphEdges },
    unknowns,
    relationGaps,
    recommendedProbes,
    coverage: {
      seedCount: seeds.length,
      analyzedNodes: graphNodes.length,
      analyzedEdges: graphEdges.length,
      maxCallDepth: maxDepth,
      beamWidth,
      truncated: Boolean(input.graphScope?.truncated || input.truncated || beam.truncated),
      truncationReasons: [
        ...(input.graphScope?.truncated ? ['neighborhood_bound'] : []),
        ...(beam.truncated ? ['beam_bound'] : []),
      ],
      uncoveredSeeds,
      unknownFindings: unknowns.length + runtimeEvidence.filter((item) => !selectedNodeIds.has(item.nodeId)).length,
    },
  };
  return analysis;
}

export { DEFAULT_WEIGHTS };
