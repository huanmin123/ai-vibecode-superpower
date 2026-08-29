import { extractSourceLocations } from './runtime-evidence.mjs';

const ERROR_CODE_PATTERN = /\b[A-Z][A-Z0-9]*(?:[_-][A-Z0-9]+){1,}\b/g;
const CONFIG_PATTERN = /\bprocess\.env\.[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*\b|\b[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9_-]+){2,}\b/g;
const ENDPOINT_PATTERN = /\b(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\/[^\s"'`),;]+)|(?<![A-Za-z0-9])\/(?:[A-Za-z0-9._~-]+\/)*[A-Za-z0-9._~:-]+(?:\?[A-Za-z0-9._~=&%-]+)?/g;
const SQL_PATTERN = /\b(?:from|join|into|update|insert\s+into|delete\s+from|table)\s+([A-Za-z_][A-Za-z0-9_.-]*)/gi;
const SYMBOL_PATTERN = /\b[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)?\b/g;
const STOP_SYMBOLS = new Set([
  'after', 'again', 'also', 'because', 'before', 'being', 'bug', 'caused', 'class', 'code', 'could', 'does', 'error',
  'failed', 'failure', 'file', 'fix', 'from', 'function', 'has', 'have', 'into', 'issue', 'line', 'method', 'only',
  'problem', 'request', 'response', 'should', 'stack', 'that', 'the', 'this', 'through', 'when', 'with', 'would',
  'get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'packages', 'core', 'traceid', 'table', 'process.env',
]);

function unique(values) {
  return [...new Set(values.filter((value) => typeof value === 'string' && value.trim() !== '').map((value) => value.trim()))];
}

function matches(text, pattern, selector = (match) => match[0]) {
  return unique([...text.matchAll(pattern)].map(selector));
}

function normalizeEndpoint(value) {
  return value.replace(/[)\]}>,.;:]+$/, '');
}

function normalizeSymbol(value) {
  const normalized = value.replace(/^[$.]+|[$.]+$/g, '');
  return STOP_SYMBOLS.has(normalized.toLowerCase()) ? null : normalized;
}

/**
 * Extract high-signal anchors from a human incident description without model calls.
 * The parser intentionally returns candidates and unknowns; CodeGraph remains the authority
 * for deciding whether a symbol or file exists in the current workspace.
 */
export function parseIncidentDescription(description, options = {}) {
  if (typeof description !== 'string' || description.trim() === '') {
    throw new TypeError('description must be a non-empty string');
  }
  const text = description.trim();
  const suppliedLocations = Array.isArray(options.sourceLocations)
    ? options.sourceLocations.filter((location) => location && typeof location.filePath === 'string' && Number.isInteger(location.line))
    : [];
  const sourceLocations = [...suppliedLocations, ...extractSourceLocations(text)]
    .filter((location, index, values) => values.findIndex((candidate) => candidate.filePath === location.filePath && candidate.line === location.line && candidate.column === location.column) === index);
  const files = unique([
    ...sourceLocations.map((location) => location.filePath),
    ...matches(text, /(?:[A-Za-z]:[\\/]|\.\.?[\\/]|[A-Za-z0-9_.-]+[\\/])[^\s:'"`),;]+\.[A-Za-z0-9]+/g),
  ]);
  const filePathParts = new Set(files.flatMap((file) => file.split(/[\\/]/).filter(Boolean)));
  const rawConfigKeys = matches(text, CONFIG_PATTERN);
  const configKeys = unique([...rawConfigKeys, ...rawConfigKeys.map((value) => value.replace(/^process\.env\./, ''))]);
  const errorCodes = matches(text, ERROR_CODE_PATTERN).filter((value) => !configKeys.includes(value));
  const endpoints = unique([
    ...[...text.matchAll(ENDPOINT_PATTERN)].map((match) => match[1] ?? match[0]),
  ]).map(normalizeEndpoint);
  const sqlIdentifiers = matches(text, SQL_PATTERN, (match) => match[1]);
  const symbols = matches(text, SYMBOL_PATTERN)
    .map(normalizeSymbol)
    .filter(Boolean)
    .filter((value) => value.length >= 4)
    .filter((value) => !errorCodes.includes(value) && !configKeys.includes(value) && !endpoints.includes(value) && !sqlIdentifiers.includes(value) && !filePathParts.has(value) && !files.includes(value));
  const traceIds = matches(text, /\b(?:trace[_ -]?id|traceid)\s*[:=]\s*([A-Za-z0-9._-]+)/gi, (match) => match[1]);
  const requestIds = matches(text, /\b(?:request[_ -]?id|requestid|req(?:uest)?)\s*[:=]\s*([A-Za-z0-9._-]+)/gi, (match) => match[1]);
  const serviceNames = matches(text, /\b(?:service|component|module)\s*[:=]\s*([A-Za-z0-9._/-]+)/gi, (match) => match[1]);
  const anchors = unique([
    ...sourceLocations.map((location) => `${location.filePath}:${location.line}`),
    ...files,
    ...errorCodes,
    ...configKeys,
    ...endpoints,
    ...sqlIdentifiers,
    ...symbols,
    ...traceIds,
    ...requestIds,
    ...serviceNames,
  ]);
  const queries = unique([text, ...anchors]);
  const unknowns = [];
  if (sourceLocations.length === 0 && anchors.length === 0) unknowns.push({ reason: 'no_deterministic_anchor', detail: 'description contains no recognized file, symbol, error code, endpoint, SQL, config, trace or request anchor' });
  if (sourceLocations.length === 0) unknowns.push({ reason: 'missing_source_location', detail: 'no file:line location was present in the incident description' });
  return {
    description: text,
    sourceLocations,
    errorCodes,
    configKeys,
    endpoints,
    sqlIdentifiers,
    symbols,
    files,
    traceIds,
    requestIds,
    serviceNames,
    anchors,
    queries,
    unknowns,
  };
}
