import { createHash } from 'node:crypto';

const DEFAULT_WEIGHTS = Object.freeze({
  prior: 0.2,
  symptomCoverage: 0.25,
  temporalSupport: 0.2,
  structuralSupport: 0.15,
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
  return {
    id: requireString(node.id, `nodes[${index}].id`),
    type: typeof node.type === 'string' && node.type !== '' ? node.type : 'unknown',
    label: typeof node.label === 'string' ? node.label : node.id,
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
  };
}

function pathKey(path) {
  return path.join('\u0000');
}

function sortByScore(items) {
  return [...items].sort((left, right) => right.score - left.score || left.nodeId.localeCompare(right.nodeId));
}

function buildReverseBeam(seeds, incoming, nodeMap, maxDepth, beamWidth) {
  const paths = [];
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
    frontier = sortByScore([...bestByNode.values()]).slice(0, beamWidth);
  }
  return paths;
}

function scoreHypothesis(root, rootPaths, seedCount, evidenceByNode, weights) {
  const coveredSeeds = new Set(rootPaths.map((path) => path.seedId));
  const evidence = evidenceByNode.get(root) ?? [];
  const temporalSupport = evidence.reduce((sum, item) => sum + item.temporal, 0) / Math.max(1, evidence.length);
  const runtimeSupport = evidence.reduce((sum, item) => sum + item.support, 0) / Math.max(1, evidence.length);
  const contradiction = evidence.reduce((sum, item) => sum + item.contradiction, 0) / Math.max(1, evidence.length);
  const structuralSupport = rootPaths.reduce((sum, path) => sum + path.score, 0) / Math.max(1, rootPaths.length);
  const symptomCoverage = coveredSeeds.size / Math.max(1, seedCount);
  const prior = clamp((rootPaths.length > 1 ? 0.7 : 0.45) * (rootPaths[0]?.score ?? 0));
  const score = clamp(
    weights.prior * prior +
    weights.symptomCoverage * symptomCoverage +
    weights.temporalSupport * temporalSupport +
    weights.structuralSupport * structuralSupport +
    weights.interventionLift * runtimeSupport -
    weights.contradiction * contradiction,
  );
  return {
    root,
    score,
    prior,
    symptomCoverage,
    temporalSupport,
    structuralSupport,
    interventionLift: runtimeSupport,
    contradiction,
    unresolvedGap: 0,
    paths: rootPaths.map((path) => ({ seedId: path.seedId, nodes: path.path, score: path.score })),
  };
}

function evaluateCounterfactual(hypothesis, allPaths) {
  const remaining = allPaths.filter((path) => path.path.includes(hypothesis.root) === false);
  const remainingSeeds = new Set(remaining.map((path) => path.seedId));
  const originalSeeds = new Set(hypothesis.paths.map((path) => path.seedId));
  const independentCoverage = originalSeeds.size === 0 ? 0 : remainingSeeds.size / originalSeeds.size;
  return {
    removedRoot: hypothesis.root,
    independentCoverage,
    support: independentCoverage === 0 ? 'high' : independentCoverage < 1 ? 'medium' : 'low',
  };
}

export function buildGlobalCausalAnalysis(input, options = {}) {
  if (!isObject(input)) throw new TypeError('input must be an object');
  const seeds = requireArray(input.seeds, 'seeds').map(normalizeSeed);
  const nodes = requireArray(input.nodes, 'nodes').map(normalizeNode);
  const edges = requireArray(input.edges, 'edges').map(normalizeEdge);
  const runtimeEvidence = requireArray(input.runtimeEvidence ?? [], 'runtimeEvidence').map(normalizeRuntimeEvidence);
  const maxDepth = Number.isInteger(options.maxDepth) && options.maxDepth >= 0 ? options.maxDepth : 3;
  const beamWidth = Number.isInteger(options.beamWidth) && options.beamWidth > 0 ? options.beamWidth : 24;
  const weights = { ...DEFAULT_WEIGHTS, ...(isObject(options.weights) ? options.weights : {}) };
  const nodeMap = new Map(nodes.map((node) => [node.id, node]));
  const incoming = new Map();
  for (const edge of edges) {
    const list = incoming.get(edge.target) ?? [];
    list.push(edge);
    incoming.set(edge.target, list);
  }
  const allPaths = buildReverseBeam(seeds, incoming, nodeMap, maxDepth, beamWidth);
  const causalPaths = allPaths.filter((path) => path.path.length > 1);
  const selectedNodeIds = new Set(allPaths.flatMap((path) => path.path));
  const selectedEdges = edges.filter((edge) => selectedNodeIds.has(edge.source) && selectedNodeIds.has(edge.target));
  const evidenceByNode = new Map();
  for (const evidence of runtimeEvidence) {
    const list = evidenceByNode.get(evidence.nodeId) ?? [];
    list.push(evidence);
    evidenceByNode.set(evidence.nodeId, list);
  }
  const pathsByRoot = new Map();
  for (const path of causalPaths) {
    const root = path.path[0];
    const list = pathsByRoot.get(root) ?? [];
    list.push(path);
    pathsByRoot.set(root, list);
  }
  const hypotheses = [...pathsByRoot.entries()]
    .map(([root, rootPaths]) => scoreHypothesis(root, rootPaths, seeds.length, evidenceByNode, weights))
    .sort((left, right) => right.score - left.score || left.root.localeCompare(right.root))
    .slice(0, Number.isInteger(options.maxHypotheses) && options.maxHypotheses > 0 ? options.maxHypotheses : 5)
    .map((hypothesis) => ({ ...hypothesis, counterfactual: evaluateCounterfactual(hypothesis, causalPaths) }));
  const graphNodes = [...selectedNodeIds].sort().map((id) => nodeMap.get(id));
  const graphEdges = selectedEdges.sort((left, right) => left.id.localeCompare(right.id));
  const snapshot = typeof input.snapshot === 'string' && input.snapshot !== '' ? input.snapshot : 'unknown';
  const analysis = {
    analysisId: `analysis:${digest({ snapshot, seeds, graphNodes, graphEdges, runtimeEvidence })}`,
    snapshot,
    symptomSeeds: seeds,
    hypotheses,
    graph: { nodes: graphNodes, edges: graphEdges },
    coverage: {
      seedCount: seeds.length,
      analyzedNodes: graphNodes.length,
      analyzedEdges: graphEdges.length,
      maxCallDepth: maxDepth,
      beamWidth,
      truncated: allPaths.length > beamWidth * Math.max(1, seeds.length) * (maxDepth + 1),
      unknownFindings: runtimeEvidence.filter((item) => !selectedNodeIds.has(item.nodeId)).length,
    },
  };
  return analysis;
}

export { DEFAULT_WEIGHTS };
