import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import path from 'node:path';
import { buildGlobalCausalAnalysis } from './causal-engine.mjs';
import { selectEvidencePacket } from './evidence-selection.mjs';

const require = createRequire(import.meta.url);
const DEFAULT_SDK_PATH = null;

function edgeId(edge, index) {
  return `cg:${edge.kind}:${edge.source}:${edge.target}:${edge.line ?? ''}:${index}`;
}

function boundedStrength(value, fallback = 0.55) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0.05, Math.min(1, number)) : fallback;
}

function boundedEvidenceScore(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : 0;
}

function staticEdgeStrength(edge) {
  return boundedStrength(edge?.strength ?? edge?.confidence ?? edge?.staticResolutionScore);
}

function changedFileCount(changedFiles) {
  return ['added', 'modified', 'removed'].reduce((total, key) => total + (Array.isArray(changedFiles?.[key]) ? changedFiles[key].length : 0), 0);
}

function inspectGraphHealth(graph) {
  const state = graph.getIndexState?.() ?? null;
  const stale = graph.isIndexStale?.() ?? true;
  const pendingReferences = graph.getPendingReferenceCount?.() ?? null;
  const changedFiles = graph.getChangedFiles?.() ?? { added: [], modified: [], removed: [] };
  const pendingFiles = graph.getPendingFiles?.() ?? [];
  const buildInfo = graph.getIndexBuildInfo?.() ?? { version: null, extractionVersion: null };
  const watcherDegraded = graph.isWatcherDegraded?.() ?? false;
  const watcherDegradedReason = graph.getWatcherDegradedReason?.() ?? null;
  const reasons = [];
  if (state !== 'complete') reasons.push(`index_state:${state ?? 'unknown'}`);
  if (stale) reasons.push('index_stale');
  if (pendingReferences === null) reasons.push('pending_reference_count_unavailable');
  else if (pendingReferences > 0) reasons.push(`pending_references:${pendingReferences}`);
  if (changedFileCount(changedFiles) > 0) reasons.push('changed_files_pending');
  if (pendingFiles.length > 0) reasons.push('watcher_pending_files');
  if (watcherDegraded) reasons.push(`watcher_degraded:${watcherDegradedReason ?? 'unknown'}`);
  return {
    state,
    stale,
    pendingReferences,
    changedFiles,
    pendingFiles,
    buildInfo,
    lastIndexedAt: graph.getLastIndexedAt?.() ?? null,
    watcher: {
      active: graph.isWatching?.() ?? null,
      degraded: watcherDegraded,
      degradedReason: watcherDegradedReason,
    },
    healthy: reasons.length === 0,
    reasons,
  };
}

function normalizeRuntimeEvents(input) {
  if (Array.isArray(input)) return { events: input, status: 'provided', error: null };
  if (input && typeof input === 'object' && ['compressed', 'bounded_raw'].includes(input.status) && Array.isArray(input.events)) return { events: input.events, status: input.status, error: input.compressionError ?? null };
  if (input && typeof input === 'object' && input.status === 'failed') throw new Error(`Runtime evidence is unavailable: ${input.error ?? 'unknown RTK failure'}`);
  if (input === undefined || input === null) return { events: [], status: 'none', error: null };
  throw new TypeError('runtimeEvidence must be an event array or a compressLogWithRtk result');
}

function projectRelativePath(projectRoot, filePath) {
  const normalized = String(filePath).replaceAll('\\', '/');
  const candidate = path.isAbsolute(normalized) ? normalized : path.resolve(projectRoot, normalized);
  const relative = path.relative(projectRoot, candidate).replaceAll('\\', '/');
  return relative.startsWith('../') || relative === '..' ? null : relative;
}

export function selectNodesForSourceLocation(nodes, filePath, line) {
  if (!Array.isArray(nodes) || typeof filePath !== 'string' || !Number.isInteger(line) || line < 1) return [];
  return nodes
    .filter((node) => node.filePath === filePath && node.startLine <= line && node.endLine >= line)
    .sort((left, right) => (left.endLine - left.startLine) - (right.endLine - right.startLine) || left.id.localeCompare(right.id));
}

function runtimeSupport(event) {
  if (['fatal', 'panic'].includes(event.level)) return 0.95;
  if (event.level === 'error') return 0.8;
  if (event.level === 'warn' || event.level === 'warning') return 0.45;
  return 0.2;
}

function mapRuntimeEvents(graph, projectRoot, events) {
  const mapped = [];
  const unknown = [];
  for (const event of events) {
    if (!event || typeof event.id !== 'string' || !Array.isArray(event.sourceLocations)) {
      unknown.push({ eventId: event?.id ?? null, reason: 'missing_source_location' });
      continue;
    }
    let matched = false;
    for (const location of event.sourceLocations) {
      const filePath = projectRelativePath(projectRoot, location.filePath);
      if (!filePath) {
        unknown.push({ eventId: event.id, reason: 'source_location_outside_project', location });
        continue;
      }
      const candidates = selectNodesForSourceLocation(graph.getNodesInFile(filePath), filePath, location.line);
      if (candidates.length === 0) {
        unknown.push({ eventId: event.id, reason: 'no_indexed_node_at_source_location', location: { ...location, filePath } });
        continue;
      }
      const node = candidates[0];
      mapped.push({
        event,
        nodeId: node.id,
        location: { ...location, filePath },
        support: runtimeSupport(event),
        contradiction: typeof event.contradiction === 'number' ? event.contradiction : 0,
        temporal: 0,
        interventionLift: boundedEvidenceScore(event.interventionLift),
        refs: [event.id],
      });
      matched = true;
    }
    if (!matched && event.sourceLocations.length === 0) unknown.push({ eventId: event.id, reason: 'missing_source_location' });
  }
  return { mapped, unknown };
}

function normalizeSourceLocations(locations) {
  return Array.isArray(locations)
    ? locations.filter((location) => location && typeof location.filePath === 'string' && Number.isInteger(location.line) && location.line > 0)
    : [];
}

function runtimeCorrelationKey(event) {
  if (typeof event?.traceId === 'string' && event.traceId !== '') return `trace:${event.traceId}`;
  if (typeof event?.requestId === 'string' && event.requestId !== '') return `request:${event.requestId}`;
  return null;
}

function buildRuntimeSequenceEdges(mapped) {
  const groups = new Map();
  for (const item of mapped) {
    const key = runtimeCorrelationKey(item.event);
    const timestamp = item.event?.timestamp ? Date.parse(item.event.timestamp) : Number.NaN;
    if (!key || !Number.isFinite(timestamp)) continue;
    const list = groups.get(key) ?? [];
    list.push({ ...item, timestamp });
    groups.set(key, list);
  }
  const correlations = [];
  const temporallyObserved = new Set();
  for (const [key, items] of groups.entries()) {
    const uniqueEvents = [...new Map(items.map((item) => [item.event.id, item])).values()]
      .sort((left, right) => left.timestamp - right.timestamp || left.event.id.localeCompare(right.event.id));
    for (let index = 0; index < uniqueEvents.length - 1; index += 1) {
      const source = uniqueEvents[index];
      const target = uniqueEvents[index + 1];
      if (source.timestamp > target.timestamp) continue;
      temporallyObserved.add(source.event.id);
      temporallyObserved.add(target.event.id);
      correlations.push({
        id: `runtime-sequence:${key}:${source.event.id}:${target.event.id}`,
        source: `observation:${source.event.id}`,
        target: `observation:${target.event.id}`,
        kind: 'runtime_sequence',
        evidenceLevel: 'observed',
        strength: 0.65,
        refs: [source.event.id, target.event.id],
      });
    }
  }
  for (const item of mapped) if (temporallyObserved.has(item.event.id)) item.temporal = 0.7;
  return correlations;
}

function buildRecommendedProbes(runtime, bounds) {
  const probes = [];
  if (runtime.unknown.some((item) => item.reason === 'missing_source_location')) {
    probes.push('提供包含 workspace 相对路径和行号的完整 stack trace 或失败测试位置。');
  }
  if (runtime.unknown.some((item) => item.reason === 'source_location_outside_project')) {
    probes.push('确认堆栈路径属于当前 workspace，并补充服务名、进程名和 trace/request ID。');
  }
  if (bounds.truncated) probes.push('缩小查询范围或提供明确 seedIds，再展开被截断的关系邻域。');
  if (runtime.mapped.length === 0) probes.push('提供带 timestamp、service、requestId 或 traceId 的结构化日志。');
  return probes.slice(0, 2);
}

function expandSeedQueries(seedQueries) {
  const stopWords = new Set(['this', 'that', 'with', 'from', 'when', 'instead', 'error', 'failed', 'failure', 'keeps', 'keep', 'the', 'and', 'for', 'into', 'streaming', 'response']);
  const expanded = [];
  for (const query of seedQueries) {
    expanded.push(query);
    const tokens = query.match(/[A-Za-z_][A-Za-z0-9_:.#\\/-]{3,}/g) ?? [];
    for (const token of tokens) {
      const normalized = token.toLowerCase();
      if (!stopWords.has(normalized)) expanded.push(token);
    }
  }
  return [...new Set(expanded)];
}

function expandNeighborhood(graph, seedIds, maxDepth, limit) {
  const nodeMap = new Map();
  const edgeMap = new Map();
  const queue = seedIds.map((id) => ({ id, depth: 0 }));
  while (queue.length && nodeMap.size < limit) {
    const current = queue.shift();
    if (nodeMap.has(current.id)) continue;
    const node = graph.getNode(current.id);
    if (!node) continue;
    nodeMap.set(node.id, node);
    if (current.depth >= maxDepth) continue;
    const edges = [...(graph.getIncomingEdges?.(node.id) ?? []), ...(graph.getOutgoingEdges?.(node.id) ?? [])];
    for (const edge of edges) {
      const id = edgeId(edge, edgeMap.size);
      if (!edgeMap.has(id)) edgeMap.set(id, {
        ...edge,
        id,
        evidenceLevel: 'potential',
        strength: staticEdgeStrength(edge),
        staticResolutionScore: staticEdgeStrength(edge),
      });
      const neighbor = edge.source === node.id ? edge.target : edge.source;
      if (!nodeMap.has(neighbor)) queue.push({ id: neighbor, depth: current.depth + 1 });
    }
  }
  const truncated = queue.some((item) => !nodeMap.has(item.id));
  return {
    nodes: [...nodeMap.values()],
    edges: [...edgeMap.values()].filter((edge) => nodeMap.has(edge.source) && nodeMap.has(edge.target)),
    nodeIds: [...nodeMap.keys()],
    truncated,
  };
}

export async function loadCodeGraphSdk(sdkPath = DEFAULT_SDK_PATH) {
  const configuredPath = sdkPath ?? process.env.CAUSAL_DEBUGGER_CODEGRAPH_SDK ?? null;
  const module = configuredPath === null
    ? require('@colbymchenry/codegraph')
    : await import(pathToFileURL(configuredPath).href);
  const CodeGraph = module.default?.CodeGraph ?? module.CodeGraph ?? module.default;
  if (!CodeGraph || typeof CodeGraph.open !== 'function') {
    throw new Error(`CodeGraph public SDK did not export CodeGraph.open: ${sdkPath}`);
  }
  return { module, CodeGraph };
}

export async function readCodeGraphStatus(projectRoot, options = {}) {
  if (typeof projectRoot !== 'string' || projectRoot.trim() === '') throw new TypeError('projectRoot must be a non-empty string');
  const resolvedRoot = path.resolve(projectRoot);
  const { CodeGraph, module } = await loadCodeGraphSdk(options.sdkPath ?? DEFAULT_SDK_PATH);
  const graph = await CodeGraph.open(resolvedRoot, { readOnly: true, sync: false });
  try {
    const stats = graph.getStats();
    const health = inspectGraphHealth(graph);
    return {
      projectRoot: resolvedRoot,
      codegraph: { stats, ...health },
      supportedLanguages: module.getSupportedLanguages?.() ?? null,
    };
  } finally { graph.close(); }
}

/**
 * Read only a bounded structural slice through CodeGraph's public SDK.
 * This intentionally does not access .codegraph SQLite files directly.
 */
export async function readCodeGraphEvidence(options) {
  const projectRoot = options?.projectRoot;
  if (typeof projectRoot !== 'string' || projectRoot.trim() === '') throw new TypeError('projectRoot must be a non-empty string');
  const { CodeGraph } = await loadCodeGraphSdk(options?.sdkPath ?? DEFAULT_SDK_PATH);
  const graph = await CodeGraph.open(projectRoot, { readOnly: true, sync: false });
  try {
    const stats = graph.getStats();
    const health = inspectGraphHealth(graph);
    if (!health.healthy) throw new Error(`CodeGraph index is not healthy: ${health.reasons.join(', ')}`);
    const runtimeInput = normalizeRuntimeEvents(options?.runtimeEvidence);
    const locationEvents = normalizeSourceLocations(options?.sourceLocations).map((location, index) => ({
      id: `incident-location:${location.filePath}:${location.line}:${location.column ?? ''}:${index}`,
      type: 'incident_anchor',
      level: 'info',
      message: `user-provided source location ${location.filePath}:${location.line}`,
      sourceLocations: [location],
    }));
    const runtimeMapping = mapRuntimeEvents(graph, projectRoot, [...locationEvents, ...runtimeInput.events]);
    const explicitSeedIds = Array.isArray(options?.seedIds) ? options.seedIds.filter((id) => typeof id === 'string' && id) : [];
    const seedQueries = Array.isArray(options?.seedQueries) ? options.seedQueries.filter((query) => typeof query === 'string' && query.trim()) : [];
    const queryLimit = Number.isInteger(options?.queryLimit) && options.queryLimit > 0 ? Math.min(options.queryLimit, 50) : 8;
    const queryMatchesByNode = new Map();
    for (const query of expandSeedQueries(seedQueries)) {
      for (const match of graph.searchNodes(query, { limit: queryLimit })) {
        const normalized = { query, ...match };
        const nodeId = match.node?.id;
        if (!nodeId) continue;
        const existing = queryMatchesByNode.get(nodeId);
        if (!existing || Number(match.score ?? 0) > Number(existing.score ?? 0)) queryMatchesByNode.set(nodeId, normalized);
      }
    }
    const queryMatches = [...queryMatchesByNode.values()].sort((left, right) => Number(right.score ?? 0) - Number(left.score ?? 0) || left.node.id.localeCompare(right.node.id));
    const seedLimit = Number.isInteger(options?.seedLimit) && options.seedLimit > 0 ? Math.min(options.seedLimit, 64) : 24;
    const matchLimit = Math.min(seedLimit * 2, 128);
    const returnedQueryMatches = queryMatches.slice(0, matchLimit);
    const selectedQueryMatches = returnedQueryMatches.slice(0, seedLimit);
    const selectedQueryIds = new Set(selectedQueryMatches.map((match) => match.node?.id).filter(Boolean));
    const seedIds = [...new Set([...explicitSeedIds, ...selectedQueryMatches.map((match) => match.node?.id).filter(Boolean), ...runtimeMapping.mapped.map((item) => item.nodeId)])];
    const maxDepth = Number.isInteger(options?.maxDepth) && options.maxDepth >= 0 ? options.maxDepth : 3;
    const limit = Number.isInteger(options?.limit) && options.limit > 0 ? options.limit : 250;
    const neighborhood = expandNeighborhood(graph, seedIds, maxDepth, limit);
    const runtimeCorrelations = buildRuntimeSequenceEdges(runtimeMapping.mapped);
    const relationGaps = runtimeMapping.unknown.map((item, index) => ({
      id: `runtime-gap:${item.eventId ?? index}`,
      nodeId: null,
      kind: 'missing_relation',
      reason: item.reason,
      severity: 0.6,
      refs: item.eventId ? [item.eventId] : [],
    }));
    if (neighborhood.truncated) relationGaps.push({ id: 'graph-gap:truncated', nodeId: null, kind: 'missing_relation', reason: 'bounded_neighborhood_truncated', severity: 0.5, refs: [] });
    if (runtimeInput.status === 'bounded_raw') relationGaps.push({ id: 'runtime-gap:rtk', nodeId: null, kind: 'runtime_degraded', reason: runtimeInput.error ?? 'rtk compression failed; bounded raw log used', severity: 0.4, refs: [] });
    const bounds = { maxDepth, limit, truncated: neighborhood.truncated };
    return {
      source: 'codegraph-public-sdk',
      projectRoot,
      index: { stats, ...health },
      seeds: seedIds.map((id) => ({ id, text: graph.getNode(id)?.name ?? id })),
      seedMatches: returnedQueryMatches.map((match) => ({ query: match.query, id: match.node?.id ?? null, name: match.node?.name ?? null, score: match.score ?? null, selected: selectedQueryIds.has(match.node?.id) })),
      nodes: neighborhood.nodes,
      edges: neighborhood.edges,
      bounds,
      graphScope: { nodeIds: neighborhood.nodeIds, truncated: neighborhood.truncated },
      relationGaps,
      recommendedProbes: buildRecommendedProbes(runtimeMapping, bounds),
      runtime: { ...runtimeMapping, correlations: runtimeCorrelations, input: { status: runtimeInput.status, error: runtimeInput.error } },
    };
  } finally {
    graph.close();
  }
}

export async function buildAnalysisFromCodeGraph(options) {
  const evidence = await readCodeGraphEvidence(options);
  const observationNodes = new Map();
  const observationEdges = [];
  const observationSeeds = new Map();
  for (const mapping of evidence.runtime.mapped) {
    const eventId = `observation:${mapping.event.id}`;
    observationNodes.set(eventId, { id: eventId, type: 'event', label: mapping.event.errorCode ?? mapping.event.message ?? mapping.event.id });
    observationSeeds.set(eventId, { id: eventId, text: mapping.event.errorCode ?? mapping.event.message ?? mapping.event.id });
    observationEdges.push({
      id: `runtime:${mapping.nodeId}:${mapping.event.id}`,
      source: mapping.nodeId,
      target: eventId,
      kind: 'runtime_observation',
      evidenceLevel: 'observed',
      strength: mapping.support,
      refs: mapping.refs,
    });
  }
  const analysis = buildGlobalCausalAnalysis({
    snapshot: options?.snapshot ?? evidence.projectRoot,
    seeds: [...evidence.seeds, ...observationSeeds.values()],
    nodes: [...evidence.nodes.map((node) => ({
      id: node.id,
      type: node.kind,
      label: node.qualifiedName ?? node.name,
      filePath: node.filePath,
      language: node.language,
    })), ...observationNodes.values()],
    edges: [...evidence.edges, ...observationEdges, ...evidence.runtime.correlations],
    runtimeEvidence: evidence.runtime.mapped.map((item) => ({ nodeId: item.nodeId, support: item.support, contradiction: item.contradiction, temporal: item.temporal, interventionLift: item.interventionLift, refs: item.refs })),
    graphScope: evidence.graphScope,
    truncated: evidence.bounds.truncated,
    unknowns: [...evidence.runtime.unknown, ...(Array.isArray(options?.unknowns) ? options.unknowns : [])],
    relationGaps: evidence.relationGaps,
    recommendedProbes: evidence.recommendedProbes,
  }, options?.engineOptions ?? {});
  const packet = selectEvidencePacket({ evidence, analysis }, {
    nodeLimit: options?.packetNodeLimit,
    edgeLimit: options?.packetEdgeLimit,
    includeOmittedIds: options?.includeOmittedIds === true,
  });
  return { evidence, analysis, packet };
}

export { DEFAULT_SDK_PATH, buildRuntimeSequenceEdges, expandSeedQueries };
