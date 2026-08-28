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
      import(pathToFileURL(path.join(sourceDirectory, 'runtime-evidence.mjs')).href),
    ]).then(([adapter, runtime]) => ({ adapter, runtime }));
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
        seedIds: { type: 'array', items: { type: 'string' } },
        runtimeEvidence: { type: ['array', 'object'] },
        logFile: { type: 'string' },
        rtkExecutable: { type: 'string' },
        maxDepth: { type: 'integer', minimum: 0, maximum: 8 },
        limit: { type: 'integer', minimum: 1, maximum: 2000 },
        beamWidth: { type: 'integer', minimum: 1, maximum: 256 },
        queryLimit: { type: 'integer', minimum: 1, maximum: 50 },
        seedLimit: { type: 'integer', minimum: 1, maximum: 64 },
      },
    },
  },
];

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
    const { adapter, runtime } = await loadModules();
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
      const queries = [...(Array.isArray(args.queries) ? args.queries : []), ...(typeof args.query === 'string' && args.query ? [args.query] : [])];
      const result = await adapter.buildAnalysisFromCodeGraph({
        projectRoot,
        seedQueries: queries,
        seedIds: Array.isArray(args.seedIds) ? args.seedIds : [],
        runtimeEvidence,
        queryLimit: Number.isInteger(args.queryLimit) ? args.queryLimit : 8,
        seedLimit: Number.isInteger(args.seedLimit) ? args.seedLimit : 24,
        maxDepth: Number.isInteger(args.maxDepth) ? args.maxDepth : 3,
        limit: Number.isInteger(args.limit) ? args.limit : 250,
        engineOptions: { maxDepth: Number.isInteger(args.maxDepth) ? args.maxDepth : 3, beamWidth: Number.isInteger(args.beamWidth) ? args.beamWidth : 24 },
      });
      return success(id, result);
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
