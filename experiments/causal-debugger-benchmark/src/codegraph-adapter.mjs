import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { buildGlobalCausalAnalysis } from './causal-engine.mjs';

const DEFAULT_SDK_PATH = 'C:\\Users\\Administrator\\AppData\\Local\\agent-toolchain\\npm\\node_modules\\@colbymchenry\\codegraph\\npm-sdk.js';

function edgeId(edge, index) {
  return `cg:${edge.kind}:${edge.source}:${edge.target}:${edge.line ?? ''}:${index}`;
}

function normalizeRuntimeEvents(input) {
  if (Array.isArray(input)) return input;
  if (input && typeof input === 'object' && input.status === 'compressed' && Array.isArray(input.events)) return input.events;
  if (input && typeof input === 'object' && input.status === 'failed') throw new Error(`Runtime evidence is unavailable: ${input.error ?? 'unknown RTK failure'}`);
  if (input === undefined || input === null) return [];
  throw new TypeError('runtimeEvidence must be an event array or a successful compressLogWithRtk result');
}

function projectRelativePath(projectRoot, filePath) {
  const normalized = String(filePath).replaceAll('\\', '/');
  if (!path.isAbsolute(normalized)) return normalized.replace(/^\.\//, '');
  const relative = path.relative(projectRoot, normalized).replaceAll('\\', '/');
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
        temporal: event.timestamp ? 0.7 : 0.35,
        refs: [event.id],
      });
      matched = true;
    }
    if (!matched && event.sourceLocations.length === 0) unknown.push({ eventId: event.id, reason: 'missing_source_location' });
  }
  return { mapped, unknown };
}

export async function loadCodeGraphSdk(sdkPath = DEFAULT_SDK_PATH) {
  if (typeof sdkPath !== 'string' || sdkPath.trim() === '') throw new TypeError('sdkPath must be a non-empty string');
  const module = await import(pathToFileURL(sdkPath).href);
  const CodeGraph = module.default?.CodeGraph ?? module.CodeGraph ?? module.default;
  if (!CodeGraph || typeof CodeGraph.open !== 'function') {
    throw new Error(`CodeGraph public SDK did not export CodeGraph.open: ${sdkPath}`);
  }
  return { module, CodeGraph };
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
    const indexState = graph.getIndexState();
    const stale = graph.isIndexStale();
    const pendingReferences = graph.getPendingReferenceCount();
    if (indexState !== 'complete' || stale || pendingReferences > 0) {
      throw new Error(`CodeGraph index is not healthy: state=${indexState ?? 'unknown'}, stale=${stale}, pendingReferences=${pendingReferences}`);
    }
    const runtimeEvents = normalizeRuntimeEvents(options?.runtimeEvidence);
    const runtimeMapping = mapRuntimeEvents(graph, projectRoot, runtimeEvents);
    const explicitSeedIds = Array.isArray(options?.seedIds) ? options.seedIds.filter((id) => typeof id === 'string' && id) : [];
    const seedQueries = Array.isArray(options?.seedQueries) ? options.seedQueries.filter((query) => typeof query === 'string' && query.trim()) : [];
    const queryMatches = seedQueries.flatMap((query) => graph.searchNodes(query, { limit: options?.queryLimit ?? 3 }).map((match) => ({ query, ...match })));
    const seedIds = [...new Set([...explicitSeedIds, ...queryMatches.map((match) => match.node?.id).filter(Boolean), ...runtimeMapping.mapped.map((item) => item.nodeId)])];
    const maxDepth = Number.isInteger(options?.maxDepth) && options.maxDepth >= 0 ? options.maxDepth : 3;
    const limit = Number.isInteger(options?.limit) && options.limit > 0 ? options.limit : 250;
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
      for (const edge of graph.getIncomingEdges(node.id)) {
        const id = edgeId(edge, edgeMap.size);
        edgeMap.set(id, { ...edge, id, evidenceLevel: 'potential', strength: 0.55 });
        if (!nodeMap.has(edge.source)) queue.push({ id: edge.source, depth: current.depth + 1 });
      }
    }
    return {
      source: 'codegraph-public-sdk',
      projectRoot,
      index: { stats, state: indexState, stale, pendingReferences },
      seeds: seedIds.map((id) => ({ id, text: graph.getNode(id)?.name ?? id })),
      seedMatches: queryMatches.map((match) => ({ query: match.query, id: match.node?.id ?? null, name: match.node?.name ?? null, score: match.score ?? null })),
      nodes: [...nodeMap.values()],
      edges: [...edgeMap.values()].filter((edge) => nodeMap.has(edge.source) && nodeMap.has(edge.target)),
      bounds: { maxDepth, limit, truncated: queue.length > 0 },
      runtime: runtimeMapping,
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
    nodes: [...evidence.nodes.map((node) => ({ id: node.id, type: node.kind, label: node.qualifiedName ?? node.name })), ...observationNodes.values()],
    edges: [...evidence.edges, ...observationEdges],
    runtimeEvidence: evidence.runtime.mapped.map((item) => ({ nodeId: item.nodeId, support: item.support, temporal: item.temporal, refs: item.refs })),
  }, options?.engineOptions ?? {});
  return { evidence, analysis };
}

export { DEFAULT_SDK_PATH };
