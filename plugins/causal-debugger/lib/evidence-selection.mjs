import { createHash } from 'node:crypto';

const DEFAULT_LIMITS = Object.freeze({
  nodes: 64,
  edges: 128,
});

const NODE_TYPE_WEIGHTS = Object.freeze({
  config: 1,
  request: 0.95,
  event: 0.9,
  resource: 0.85,
  component: 0.75,
  function: 0.7,
  method: 0.7,
  class: 0.65,
  test: 0.6,
});

const EDGE_KIND_WEIGHTS = Object.freeze({
  guard: 1,
  config: 1,
  http: 0.95,
  message: 0.95,
  db: 0.9,
  data_flow: 0.85,
  event: 0.85,
  lifecycle: 0.8,
  temporal: 0.8,
  call: 0.7,
  calls: 0.7,
  test_coverage: 0.65,
  correlation: 0.25,
});

const EVIDENCE_LEVEL_WEIGHTS = Object.freeze({
  confirmed: 1,
  observed: 0.9,
  potential: 0.55,
  unknown: 0.2,
});

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (!isObject(value)) return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function digest(value) {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function boundedLimit(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function addReason(reasons, id, reason) {
  if (typeof id !== 'string' || id === '') return;
  const values = reasons.get(id) ?? new Set();
  values.add(reason);
  reasons.set(id, values);
}

function edgeScore(edge, mandatoryNodeIds) {
  const evidence = EVIDENCE_LEVEL_WEIGHTS[edge.evidenceLevel] ?? EVIDENCE_LEVEL_WEIGHTS.unknown;
  const kind = EDGE_KIND_WEIGHTS[edge.kind] ?? 0.5;
  const strength = Number.isFinite(Number(edge.strength)) ? Math.max(0, Math.min(1, Number(edge.strength))) : 0;
  const resolution = Number.isFinite(Number(edge.staticResolutionScore))
    ? Math.max(0, Math.min(1, Number(edge.staticResolutionScore)))
    : strength;
  const endpointLift = (mandatoryNodeIds.has(edge.source) ? 0.35 : 0) + (mandatoryNodeIds.has(edge.target) ? 0.35 : 0);
  const noisePenalty = edge.kind === 'correlation' ? 0.45 : 0;
  return evidence * 2 + kind + strength * 0.6 + resolution * 0.4 + endpointLift - noisePenalty;
}

function nodeScore(node, incidentByNode, mandatoryNodeIds, pathFrequency) {
  const incident = incidentByNode.get(node.id) ?? [];
  const bridgeEdges = incident.filter((edge) => {
    const other = edge.source === node.id ? edge.target : edge.source;
    return mandatoryNodeIds.has(other);
  });
  const weightedDegree = incident.reduce((sum, edge) => sum + edgeScore(edge, mandatoryNodeIds), 0);
  const base = NODE_TYPE_WEIGHTS[node.type] ?? 0.4;
  const testLift = node.isTest === true ? 0.15 : 0;
  return base + bridgeEdges.length * 1.5 + weightedDegree * 0.08 + (pathFrequency.get(node.id) ?? 0) * 0.75 + testLift;
}

function compareScored(left, right) {
  return right.score - left.score || left.id.localeCompare(right.id);
}

function addEdgeWithClosure(edge, mandatoryEdgeIds, mandatoryNodeIds, reasons, reason) {
  if (!edge || typeof edge.id !== 'string') return;
  mandatoryEdgeIds.add(edge.id);
  addReason(reasons, edge.id, reason);
  if (typeof edge.source === 'string') {
    mandatoryNodeIds.add(edge.source);
    addReason(reasons, edge.source, 'edge_endpoint');
  }
  if (typeof edge.target === 'string') {
    mandatoryNodeIds.add(edge.target);
    addReason(reasons, edge.target, 'edge_endpoint');
  }
}

function buildMandatorySelection(analysis, evidence, nodeById, edgeById) {
  const mandatoryNodeIds = new Set();
  const mandatoryEdgeIds = new Set();
  const reasons = new Map();
  const unresolvedMandatoryEdgeIds = new Set();

  const addNode = (id, reason) => {
    if (typeof id !== 'string' || id === '') return;
    mandatoryNodeIds.add(id);
    addReason(reasons, id, reason);
  };

  for (const seed of analysis.symptomSeeds ?? []) addNode(seed.id, 'symptom_seed');
  for (const item of evidence?.runtime?.mapped ?? []) addNode(item.nodeId, 'runtime_mapping');
  for (const gap of analysis.relationGaps ?? []) {
    if (gap.nodeId) addNode(gap.nodeId, 'relation_gap');
  }

  for (const hypothesis of analysis.hypotheses ?? []) {
    addNode(hypothesis.root, 'hypothesis_root');
    for (const path of hypothesis.paths ?? []) {
      for (const nodeId of path.nodes ?? []) addNode(nodeId, 'hypothesis_path');
      for (const pathEdge of path.edges ?? []) {
        const edge = edgeById.get(pathEdge.id);
        if (edge) addEdgeWithClosure(edge, mandatoryEdgeIds, mandatoryNodeIds, reasons, 'hypothesis_path');
        else if (typeof pathEdge.id === 'string') unresolvedMandatoryEdgeIds.add(pathEdge.id);
      }
    }
  }

  for (const edge of edgeById.values()) {
    if (edge.kind === 'runtime_observation') addEdgeWithClosure(edge, mandatoryEdgeIds, mandatoryNodeIds, reasons, 'runtime_observation');
  }

  const existingMandatoryNodeIds = new Set([...mandatoryNodeIds].filter((id) => nodeById.has(id)));
  const existingMandatoryEdgeIds = new Set([...mandatoryEdgeIds].filter((id) => edgeById.has(id)));
  return {
    mandatoryNodeIds: existingMandatoryNodeIds,
    mandatoryEdgeIds: existingMandatoryEdgeIds,
    reasons,
    missingMandatoryNodeIds: [...mandatoryNodeIds].filter((id) => !nodeById.has(id)).sort(),
    missingMandatoryEdgeIds: [...mandatoryEdgeIds].filter((id) => !edgeById.has(id)).sort(),
    unresolvedMandatoryEdgeIds: [...unresolvedMandatoryEdgeIds].sort(),
  };
}

function pathCoverage(analysis, includedNodeIds, includedEdgeIds) {
  return (analysis.symptomSeeds ?? []).map((seed) => {
    const paths = (analysis.hypotheses ?? []).flatMap((hypothesis) => (hypothesis.paths ?? [])
      .filter((path) => path.seedId === seed.id));
    const retainedPaths = paths.filter((path) =>
      (path.nodes ?? []).every((id) => includedNodeIds.has(id)) &&
      (path.edges ?? []).every((edge) => includedEdgeIds.has(edge.id)));
    return {
      seedId: seed.id,
      candidatePathCount: paths.length,
      retainedPathCount: retainedPaths.length,
      covered: retainedPaths.length > 0,
    };
  });
}

function hypothesisCoverage(analysis, includedNodeIds, includedEdgeIds) {
  return (analysis.hypotheses ?? []).map((hypothesis) => {
    const paths = hypothesis.paths ?? [];
    const retainedPaths = paths.filter((path) =>
      (path.nodes ?? []).every((id) => includedNodeIds.has(id)) &&
      (path.edges ?? []).every((edge) => includedEdgeIds.has(edge.id)));
    return {
      root: hypothesis.root,
      candidatePathCount: paths.length,
      retainedPathCount: retainedPaths.length,
      covered: retainedPaths.length > 0,
    };
  });
}

export function selectEvidencePacket(input, options = {}) {
  if (!isObject(input)) throw new TypeError('input must be an object');
  const analysis = isObject(input.analysis) ? input.analysis : null;
  if (!analysis) throw new TypeError('input.analysis must be an object');
  const allNodes = Array.isArray(analysis.graph?.nodes) ? analysis.graph.nodes.filter((node) => isObject(node) && typeof node.id === 'string') : [];
  const allEdges = Array.isArray(analysis.graph?.edges) ? analysis.graph.edges.filter((edge) => isObject(edge) && typeof edge.id === 'string') : [];
  const nodeById = new Map(allNodes.map((node) => [node.id, node]));
  const edgeById = new Map(allEdges.map((edge) => [edge.id, edge]));
  const incidentByNode = new Map();
  for (const edge of allEdges) {
    for (const nodeId of [edge.source, edge.target]) {
      const incident = incidentByNode.get(nodeId) ?? [];
      incident.push(edge);
      incidentByNode.set(nodeId, incident);
    }
  }
  const nodeLimit = boundedLimit(options.nodeLimit, DEFAULT_LIMITS.nodes);
  const edgeLimit = boundedLimit(options.edgeLimit, DEFAULT_LIMITS.edges);
  const includeOmittedIds = options.includeOmittedIds === true;
  const mandatory = buildMandatorySelection(analysis, input.evidence, nodeById, edgeById);
  const pathFrequency = new Map();
  for (const hypothesis of analysis.hypotheses ?? []) {
    for (const path of hypothesis.paths ?? []) {
      for (const nodeId of path.nodes ?? []) pathFrequency.set(nodeId, (pathFrequency.get(nodeId) ?? 0) + 1);
    }
  }

  const includedNodeIds = new Set(mandatory.mandatoryNodeIds);
  const includedEdgeIds = new Set(mandatory.mandatoryEdgeIds);
  const mandatoryOverflow = mandatory.mandatoryNodeIds.size > nodeLimit || mandatory.mandatoryEdgeIds.size > edgeLimit;
  const rankedNodes = allNodes
    .filter((node) => !includedNodeIds.has(node.id))
    .map((node) => ({ id: node.id, score: nodeScore(node, incidentByNode, mandatory.mandatoryNodeIds, pathFrequency) }))
    .sort(compareScored);

  if (!mandatoryOverflow) {
    for (const candidate of rankedNodes) {
      if (includedNodeIds.size >= nodeLimit) break;
      includedNodeIds.add(candidate.id);
      addReason(mandatory.reasons, candidate.id, 'ranked_optional');
    }
  }

  const rankedEdges = allEdges
    .filter((edge) => !includedEdgeIds.has(edge.id))
    .map((edge) => ({ id: edge.id, score: edgeScore(edge, mandatory.mandatoryNodeIds) }))
    .sort(compareScored);
  if (!mandatoryOverflow) {
    for (const candidate of rankedEdges) {
      if (includedEdgeIds.size >= edgeLimit) break;
      const edge = edgeById.get(candidate.id);
      if (!includedNodeIds.has(edge.source) || !includedNodeIds.has(edge.target)) continue;
      includedEdgeIds.add(candidate.id);
      addReason(mandatory.reasons, candidate.id, 'ranked_optional');
    }
  }

  const selectedNodes = [...includedNodeIds]
    .filter((id) => nodeById.has(id))
    .sort()
    .map((id) => ({
      ...nodeById.get(id),
      selectionScore: mandatory.mandatoryNodeIds.has(id) ? null : nodeScore(nodeById.get(id), incidentByNode, mandatory.mandatoryNodeIds, pathFrequency),
      selectionReason: [...(mandatory.reasons.get(id) ?? [])].sort(),
    }));
  const selectedEdges = [...includedEdgeIds]
    .filter((id) => edgeById.has(id))
    .filter((id) => includedNodeIds.has(edgeById.get(id).source) && includedNodeIds.has(edgeById.get(id).target))
    .sort()
    .map((id) => ({
      ...edgeById.get(id),
      selectionScore: mandatory.mandatoryEdgeIds.has(id) ? null : edgeScore(edgeById.get(id), mandatory.mandatoryNodeIds),
      selectionReason: [...(mandatory.reasons.get(id) ?? [])].sort(),
    }));
  const includedNodeIdSet = new Set(selectedNodes.map((node) => node.id));
  const includedEdgeIdSet = new Set(selectedEdges.map((edge) => edge.id));
  const perSeedCoverage = pathCoverage(analysis, includedNodeIdSet, includedEdgeIdSet);
  const perHypothesisCoverage = hypothesisCoverage(analysis, includedNodeIdSet, includedEdgeIdSet);
  const omittedNodeIds = allNodes.map((node) => node.id).filter((id) => !includedNodeIdSet.has(id)).sort();
  const omittedEdgeIds = allEdges.map((edge) => edge.id).filter((id) => !includedEdgeIdSet.has(id)).sort();
  const budgetExceeded = mandatoryOverflow || selectedNodes.length > nodeLimit || selectedEdges.length > edgeLimit;
  const sourceGraphIncomplete = analysis.coverage?.truncated === true || perSeedCoverage.some((item) => item.covered === false);
  const coverageManifest = {
    selectionVersion: '1',
    analysisId: analysis.analysisId ?? null,
    snapshot: analysis.snapshot ?? null,
    limits: { nodes: nodeLimit, edges: edgeLimit },
    candidateLedger: {
      nodes: allNodes.length,
      edges: allEdges.length,
      scope: 'analysis_graph',
      complete: analysis.coverage?.truncated !== true,
    },
    mandatory: { nodes: mandatory.mandatoryNodeIds.size, edges: mandatory.mandatoryEdgeIds.size },
    included: { nodes: selectedNodes.length, edges: selectedEdges.length },
    omitted: { nodes: omittedNodeIds.length, edges: omittedEdgeIds.length },
    includedNodeIds: selectedNodes.map((node) => node.id),
    includedEdgeIds: selectedEdges.map((edge) => edge.id),
    omittedNodeIds: includeOmittedIds ? omittedNodeIds : [],
    omittedEdgeIds: includeOmittedIds ? omittedEdgeIds : [],
    omittedIndex: {
      nodeIdsSha256: digest(omittedNodeIds),
      edgeIdsSha256: digest(omittedEdgeIds),
      retrievableBy: ['nodeIds', 'relationIds', 'seedIds'],
    },
    missingMandatoryNodeIds: mandatory.missingMandatoryNodeIds,
    missingMandatoryEdgeIds: mandatory.missingMandatoryEdgeIds,
    unresolvedMandatoryEdgeIds: mandatory.unresolvedMandatoryEdgeIds,
    perSeed: perSeedCoverage,
    perHypothesis: perHypothesisCoverage,
    mandatoryOverflow,
    budgetExceeded,
    incomplete: budgetExceeded || sourceGraphIncomplete || mandatory.missingMandatoryNodeIds.length > 0 || mandatory.missingMandatoryEdgeIds.length > 0 || mandatory.unresolvedMandatoryEdgeIds.length > 0,
    graphTruncatedBeforeSelection: analysis.coverage?.truncated === true,
    truncationReasons: analysis.coverage?.truncationReasons ?? [],
    endpointClosure: selectedEdges.every((edge) => includedNodeIdSet.has(edge.source) && includedNodeIdSet.has(edge.target)),
  };
  const packet = {
    schemaVersion: 'causal-evidence-packet/v1',
    analysisId: analysis.analysisId ?? null,
    snapshot: analysis.snapshot ?? null,
    symptomSeeds: analysis.symptomSeeds ?? [],
    graph: { nodes: selectedNodes, edges: selectedEdges },
    hypotheses: analysis.hypotheses ?? [],
    unknowns: analysis.unknowns ?? [],
    relationGaps: analysis.relationGaps ?? [],
    recommendedProbes: analysis.recommendedProbes ?? [],
    coverage_manifest: coverageManifest,
  };
  packet.packetHash = digest(packet);
  return packet;
}

export function expandEvidencePacket(input, options = {}) {
  if (!isObject(input)) throw new TypeError('input must be an object');
  const analysis = isObject(input.analysis) ? input.analysis : null;
  if (!analysis) throw new TypeError('input.analysis must be an object');
  const allNodes = Array.isArray(analysis.graph?.nodes) ? analysis.graph.nodes.filter((node) => isObject(node) && typeof node.id === 'string') : [];
  const allEdges = Array.isArray(analysis.graph?.edges) ? analysis.graph.edges.filter((edge) => isObject(edge) && typeof edge.id === 'string') : [];
  const nodeById = new Map(allNodes.map((node) => [node.id, node]));
  const edgeById = new Map(allEdges.map((edge) => [edge.id, edge]));
  const nodeLimit = boundedLimit(options.nodeLimit, 64);
  const edgeLimit = boundedLimit(options.edgeLimit, 128);
  const requestedNodeValues = (Array.isArray(options.nodeIds) ? options.nodeIds : []).filter((id) => typeof id === 'string' && id !== '');
  const requestedRelationValues = (Array.isArray(options.relationIds) ? options.relationIds : []).filter((id) => typeof id === 'string' && id !== '');
  const requestedSeedValues = (Array.isArray(options.seedIds) ? options.seedIds : []).filter((id) => typeof id === 'string' && id !== '');
  const requestedNodeIds = new Set(requestedNodeValues.filter((id) => nodeById.has(id)));
  const requestedRelationIds = new Set(requestedRelationValues.filter((id) => edgeById.has(id)));
  const requestedSeedIds = new Set(requestedSeedValues);
  const missingNodeIds = requestedNodeValues.filter((id) => !nodeById.has(id));
  const missingRelationIds = requestedRelationValues.filter((id) => !edgeById.has(id));
  const knownSeedIds = new Set((analysis.symptomSeeds ?? []).map((seed) => seed.id));
  const missingSeedIds = requestedSeedValues.filter((id) => !knownSeedIds.has(id));
  if (requestedNodeIds.size === 0 && requestedRelationIds.size === 0 && requestedSeedIds.size === 0) {
    throw new TypeError('at least one nodeId, relationId or seedId is required');
  }

  const selectedNodeIds = new Set(requestedNodeIds);
  const selectedEdgeIds = new Set(requestedRelationIds);
  const reasons = new Map();
  for (const id of requestedNodeIds) addReason(reasons, id, 'requested_node');
  for (const id of requestedRelationIds) addReason(reasons, id, 'requested_relation');
  for (const id of requestedSeedIds) addReason(reasons, id, 'requested_seed');
  const addEdge = (edge, reason) => {
    if (!edge) return;
    selectedEdgeIds.add(edge.id);
    addReason(reasons, edge.id, reason);
    selectedNodeIds.add(edge.source);
    selectedNodeIds.add(edge.target);
    addReason(reasons, edge.source, 'edge_endpoint');
    addReason(reasons, edge.target, 'edge_endpoint');
  };

  for (const relationId of requestedRelationIds) addEdge(edgeById.get(relationId), 'requested_relation');
  for (const seedId of requestedSeedIds) {
    for (const hypothesis of analysis.hypotheses ?? []) {
      for (const path of (hypothesis.paths ?? []).filter((candidate) => candidate.seedId === seedId)) {
        for (const nodeId of path.nodes ?? []) {
          selectedNodeIds.add(nodeId);
          addReason(reasons, nodeId, 'seed_path');
        }
        for (const pathEdge of path.edges ?? []) addEdge(edgeById.get(pathEdge.id), 'seed_path');
      }
    }
  }
  const requestedNodeEdgeCandidates = allEdges
    .filter((edge) => selectedNodeIds.has(edge.source) || selectedNodeIds.has(edge.target))
    .filter((edge) => !selectedEdgeIds.has(edge.id))
    .map((edge) => ({ edge, score: edgeScore(edge, selectedNodeIds) }))
    .sort((left, right) => right.score - left.score || left.edge.id.localeCompare(right.edge.id));
  const mandatoryOverflow = selectedNodeIds.size > nodeLimit || selectedEdgeIds.size > edgeLimit;
  if (!mandatoryOverflow) {
    for (const candidate of requestedNodeEdgeCandidates) {
      if (selectedEdgeIds.size >= edgeLimit) break;
      const edge = candidate.edge;
      if (selectedNodeIds.size + (selectedNodeIds.has(edge.source) ? 0 : 1) + (selectedNodeIds.has(edge.target) ? 0 : 1) > nodeLimit) continue;
      addEdge(edge, 'adjacent_relation');
    }
  }
  const selectedNodes = [...selectedNodeIds]
    .filter((id) => nodeById.has(id))
    .sort()
    .map((id) => ({ ...nodeById.get(id), selectionReason: [...(reasons.get(id) ?? [])].sort() }));
  const selectedEdges = [...selectedEdgeIds]
    .filter((id) => edgeById.has(id))
    .filter((id) => selectedNodeIds.has(edgeById.get(id).source) && selectedNodeIds.has(edgeById.get(id).target))
    .sort()
    .map((id) => ({ ...edgeById.get(id), selectionReason: [...(reasons.get(id) ?? [])].sort() }));
  const includedNodeIds = new Set(selectedNodes.map((node) => node.id));
  const includedEdgeIds = new Set(selectedEdges.map((edge) => edge.id));
  const omittedNodeIds = allNodes.map((node) => node.id).filter((id) => !includedNodeIds.has(id)).sort();
  const omittedEdgeIds = allEdges.map((edge) => edge.id).filter((id) => !includedEdgeIds.has(id)).sort();
  const packet = {
    schemaVersion: 'causal-evidence-expansion/v1',
    analysisId: analysis.analysisId ?? null,
    snapshot: analysis.snapshot ?? null,
    graph: { nodes: selectedNodes, edges: selectedEdges },
    coverage_manifest: {
      limits: { nodes: nodeLimit, edges: edgeLimit },
      requested: {
        nodeIds: [...requestedNodeIds].sort(),
        relationIds: [...requestedRelationIds].sort(),
        seedIds: [...requestedSeedIds].sort(),
      },
      included: { nodes: selectedNodes.length, edges: selectedEdges.length },
      omitted: { nodes: omittedNodeIds.length, edges: omittedEdgeIds.length },
      omittedNodeIds,
      omittedEdgeIds,
      missingNodeIds: [...new Set(missingNodeIds)].sort(),
      missingRelationIds: [...new Set(missingRelationIds)].sort(),
      missingSeedIds: [...new Set(missingSeedIds)].sort(),
      mandatoryOverflow,
      budgetExceeded: mandatoryOverflow || selectedNodes.length > nodeLimit || selectedEdges.length > edgeLimit,
      incomplete: mandatoryOverflow || selectedNodes.length > nodeLimit || selectedEdges.length > edgeLimit || missingNodeIds.length > 0 || missingRelationIds.length > 0 || missingSeedIds.length > 0,
      endpointClosure: selectedEdges.every((edge) => includedNodeIds.has(edge.source) && includedNodeIds.has(edge.target)),
    },
  };
  packet.packetHash = digest(packet);
  return packet;
}

export { DEFAULT_LIMITS };
