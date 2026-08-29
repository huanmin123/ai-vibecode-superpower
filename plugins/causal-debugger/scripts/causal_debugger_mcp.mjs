#!/usr/bin/env node

import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const sourceDirectory = path.resolve(scriptDirectory, '../lib');

let modulesPromise;
async function loadModules() {
  if (!modulesPromise) {
    modulesPromise = Promise.all([
      import(pathToFileURL(path.join(sourceDirectory, 'codegraph-adapter.mjs')).href),
      import(pathToFileURL(path.join(sourceDirectory, 'clarification-policy.mjs')).href),
      import(pathToFileURL(path.join(sourceDirectory, 'incident-parser.mjs')).href),
      import(pathToFileURL(path.join(sourceDirectory, 'runtime-evidence.mjs')).href),
      import(pathToFileURL(path.join(sourceDirectory, 'evidence-selection.mjs')).href),
    ]).then(([adapter, clarification, incident, runtime, selection]) => ({ adapter, clarification, incident, runtime, selection }));
  }
  return modulesPromise;
}

const TOOLS = [
  {
    name: 'causal_status',
    description: '只读检查 CodeGraph 索引健康度、规模、语言和待处理引用。',
    inputSchema: { type: 'object', required: ['projectRoot'], properties: { projectRoot: { type: 'string' } } },
  },
  {
    name: 'causal_analyze',
    description: '把 CodeGraph 结构、日志/堆栈观测和有界因果假设编译成一次性分析包。',
    inputSchema: {
      type: 'object', required: ['projectRoot'], properties: {
        projectRoot: { type: 'string' },
        queries: { type: 'array', items: { type: 'string' } },
        query: { type: 'string' },
        description: { type: 'string' },
        seedIds: { type: 'array', items: { type: 'string' } },
        runtimeEvidence: { type: ['array', 'object'] },
        logFile: { type: 'string' },
        rtkExecutable: { type: 'string' },
        maxDepth: { type: 'integer', minimum: 0, maximum: 8 },
        limit: { type: 'integer', minimum: 1, maximum: 2000 },
        beamWidth: { type: 'integer', minimum: 1, maximum: 256 },
        queryLimit: { type: 'integer', minimum: 1, maximum: 50 },
        seedLimit: { type: 'integer', minimum: 1, maximum: 64 },
        packetNodeLimit: { type: 'integer', minimum: 1, maximum: 2000 },
        packetEdgeLimit: { type: 'integer', minimum: 1, maximum: 4000 },
        includeLedger: { type: 'boolean' },
      },
    },
  },
  {
    name: 'causal_expand',
    description: '按上一次分析的 analysisId、节点、关系或症状 seed 定向展开证据。',
    inputSchema: {
      type: 'object',
      required: ['analysisId'],
      properties: {
        analysisId: { type: 'string' },
        nodeIds: { type: 'array', items: { type: 'string' } },
        relationIds: { type: 'array', items: { type: 'string' } },
        seedIds: { type: 'array', items: { type: 'string' } },
        nodeLimit: { type: 'integer', minimum: 1, maximum: 500 },
        edgeLimit: { type: 'integer', minimum: 1, maximum: 1000 },
      },
    },
  },
];

const analysisCache = new Map();
const MAX_ANALYSIS_CACHE = 8;

function rememberAnalysis(analysisId, value) {
  analysisCache.delete(analysisId);
  analysisCache.set(analysisId, value);
  while (analysisCache.size > MAX_ANALYSIS_CACHE) analysisCache.delete(analysisCache.keys().next().value);
}

function summarizeEvidence(evidence, analysis, includeLedger) {
  if (includeLedger === true) return evidence;
  return {
    source: evidence.source,
    projectRoot: evidence.projectRoot,
    index: evidence.index,
    seeds: evidence.seeds,
    seedMatches: evidence.seedMatches,
    bounds: evidence.bounds,
    relationGaps: evidence.relationGaps,
    runtime: {
      input: evidence.runtime?.input ?? null,
      mappedCount: evidence.runtime?.mapped?.length ?? 0,
      unknownCount: evidence.runtime?.unknown?.length ?? 0,
      correlationCount: evidence.runtime?.correlations?.length ?? 0,
    },
    ledger: {
      analysisId: analysis.analysisId,
      nodeCount: analysis.graph?.nodes?.length ?? 0,
      edgeCount: analysis.graph?.edges?.length ?? 0,
      scope: 'analysis_graph',
      complete: analysis.coverage?.truncated !== true,
      available: true,
      durability: 'process_cache',
      retrieval: 'causal_expand',
    },
  };
}

function success(id, value) {
  return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value } };
}

function failure(id, error) {
  const value = { error: error instanceof Error ? error.message : String(error), error_code: 'CAUSAL_DEBUGGER_ERROR' };
  return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: value.error }], structuredContent: value, isError: true } };
}

async function handle(request) {
  const { id, method } = request;
  if (method === 'notifications/initialized') return null;
  if (method === 'initialize') return { jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'causal-debugger', version: '0.1.0' } } };
  if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
  if (method !== 'tools/call') return { jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown method: ${method}` } };
  const name = request.params?.name;
  const args = request.params?.arguments ?? {};
  try {
    const { adapter, clarification, incident, runtime, selection } = await loadModules();
    if (name === 'causal_status') {
      return success(id, await adapter.readCodeGraphStatus(args.projectRoot));
    }
    if (name === 'causal_analyze') {
      const projectRoot = path.resolve(args.projectRoot);
      let runtimeEvidence = args.runtimeEvidence;
      if (args.logFile) {
        const logFile = path.resolve(args.logFile);
        const relativeLog = path.relative(projectRoot, logFile);
        if (relativeLog === '..' || relativeLog.startsWith(`..${path.sep}`) || path.isAbsolute(relativeLog)) {
          throw new Error('logFile must be inside projectRoot');
        }
        runtimeEvidence = await runtime.compressLogWithRtk({ filePath: logFile, rtkExecutable: args.rtkExecutable });
      }
      const descriptions = typeof args.description === 'string' && args.description.trim() ? incident.parseIncidentDescription(args.description) : null;
      const parsedQueries = descriptions?.anchors?.length ? descriptions.anchors : (descriptions?.queries ?? []);
      const explicitQueries = [...(Array.isArray(args.queries) ? args.queries : []), ...(typeof args.query === 'string' && args.query ? [args.query] : [])];
      const preflight = clarification.assessIncidentInput({
        incident: descriptions,
        explicitQueries,
        seedIds: Array.isArray(args.seedIds) ? args.seedIds : [],
        runtimeEvidence,
        logFile: args.logFile,
      });
      if (!preflight.shouldAnalyze) {
        return success(id, { status: 'needs_clarification', incident: descriptions, triage: preflight, evidence: null, analysis: null });
      }
      const queries = [...explicitQueries, ...parsedQueries];
      const result = await adapter.buildAnalysisFromCodeGraph({
        projectRoot,
        seedQueries: queries,
        seedIds: Array.isArray(args.seedIds) ? args.seedIds : [],
        sourceLocations: descriptions?.sourceLocations ?? [],
        unknowns: descriptions?.unknowns ?? [],
        runtimeEvidence,
        queryLimit: Number.isInteger(args.queryLimit) ? args.queryLimit : 8,
        seedLimit: Number.isInteger(args.seedLimit) ? args.seedLimit : 24,
        maxDepth: Number.isInteger(args.maxDepth) ? args.maxDepth : 3,
        limit: Number.isInteger(args.limit) ? args.limit : 250,
        packetNodeLimit: Number.isInteger(args.packetNodeLimit) ? args.packetNodeLimit : 64,
        packetEdgeLimit: Number.isInteger(args.packetEdgeLimit) ? args.packetEdgeLimit : 128,
        engineOptions: { maxDepth: Number.isInteger(args.maxDepth) ? args.maxDepth : 3, beamWidth: Number.isInteger(args.beamWidth) ? args.beamWidth : 24 },
      });
      const triage = clarification.assessAnalysisResult({ incident: descriptions, evidence: result.evidence, analysis: result.analysis, preflight });
      if (triage.question && result.analysis && !result.analysis.recommendedProbes.includes(triage.question)) {
        result.analysis.recommendedProbes = [triage.question, ...result.analysis.recommendedProbes].slice(0, 2);
      }
      rememberAnalysis(result.analysis.analysisId, result);
      const packetIncomplete = result.packet.coverage_manifest.incomplete === true;
      const status = packetIncomplete
        ? 'partial'
        : triage.action === 'analyze' ? 'ready' : triage.action === 'analyze_and_clarify' ? 'partial' : 'needs_clarification';
      const focusedAnalysis = {
        ...result.analysis,
        graph: result.packet.graph,
        coverage: {
          ...result.analysis.coverage,
          packet: result.packet.coverage_manifest,
        },
      };
      return success(id, {
        status,
        incident: descriptions,
        triage,
        analysis: focusedAnalysis,
        packet: result.packet,
        evidence: summarizeEvidence(result.evidence, result.analysis, args.includeLedger === true),
      });
    }
    if (name === 'causal_expand') {
      const entry = analysisCache.get(args.analysisId);
      if (!entry) throw new Error(`analysis cache not found for ${args.analysisId}; rerun causal_analyze`);
      const expansion = selection.expandEvidencePacket({ analysis: entry.analysis }, {
        nodeIds: args.nodeIds,
        relationIds: args.relationIds,
        seedIds: args.seedIds,
        nodeLimit: Number.isInteger(args.nodeLimit) ? args.nodeLimit : 64,
        edgeLimit: Number.isInteger(args.edgeLimit) ? args.edgeLimit : 128,
      });
      return success(id, {
        status: expansion.coverage_manifest.incomplete ? 'partial' : 'ready',
        expansion,
      });
    }
    return failure(id, `Unknown tool: ${name}`);
  } catch (error) { return failure(id, error); }
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  if (!line.trim()) continue;
  let request;
  try { request = JSON.parse(line); } catch (error) { process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: error.message } })}\n`); continue; }
  const response = await handle(request);
  if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
}
