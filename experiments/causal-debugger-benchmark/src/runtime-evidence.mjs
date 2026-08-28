import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { spawn } from 'node:child_process';

const DEFAULT_MAX_BYTES = 2_000_000;
const DEFAULT_MAX_LINES = 20_000;
const DEFAULT_MAX_COMPRESSED_CHARS = 100_000;

function redact(text) {
  return text
    .replace(/((?:authorization|cookie|token|password|secret|api[_-]?key|connection[_-]?string)\s*[:=]\s*)([^\s,;]+)/gi, '$1[REDACTED]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/(?:https?:\/\/[^\s/@]+):[^\s/@]+@/gi, 'https://[REDACTED]@');
}

function normalizeSourcePath(filePath) {
  return filePath.replaceAll('\\', '/').replace(/^\.\//, '');
}

export function extractSourceLocations(text) {
  if (typeof text !== 'string') return [];
  const locations = [];
  const pattern = /(?:^|[\s(])((?:[A-Za-z]:[\\/]|\/)?[A-Za-z0-9_./\\-]+\.(?:[cm]?[jt]sx?|go|rs|java|py|rb|php|cs|kt|swift|scala|vue|svelte|astro|c|cc|cpp|h|hpp)):(\d+)(?::(\d+))?/g;
  for (const match of text.matchAll(pattern)) {
    const line = Number.parseInt(match[2], 10);
    const column = match[3] === undefined ? null : Number.parseInt(match[3], 10);
    if (!Number.isInteger(line) || line < 1 || (column !== null && (!Number.isInteger(column) || column < 0))) continue;
    locations.push({ filePath: normalizeSourcePath(match[1]), line, column });
  }
  return locations.filter((item, index, values) => values.findIndex((candidate) => candidate.filePath === item.filePath && candidate.line === item.line && candidate.column === item.column) === index);
}

function parseLine(line, index) {
  const timestamp = line.match(/\b(\d{4}-\d\d-\d\d[T ][0-9:.+-]+Z?)\b/)?.[1] ?? null;
  const level = line.match(/\b(trace|debug|info|notice|warn(?:ing)?|error|fatal|panic)\b/i)?.[1]?.toLowerCase() ?? null;
  const traceId = line.match(/\b(?:trace[_ -]?id|traceid)\s*[:=]\s*([A-Za-z0-9._-]+)/i)?.[1] ?? null;
  const requestId = line.match(/\b(?:request[_ -]?id|requestid|req(?:uest)?)\s*[:=]\s*([A-Za-z0-9._-]+)/i)?.[1] ?? null;
  const errorCode = line.match(/\b(?:code|error[_ -]?code|status)\s*[:=]\s*([A-Za-z0-9._-]+)/i)?.[1] ?? null;
  const service = line.match(/\b(?:service|component|module)\s*[:=]\s*([A-Za-z0-9._/-]+)/i)?.[1] ?? null;
  return {
    id: `log:${index + 1}`,
    type: 'log',
    timestamp,
    level,
    traceId,
    requestId,
    errorCode,
    service,
    message: redact(line),
    sourceLocations: extractSourceLocations(line),
  };
}

async function readBoundedFile(filePath, maxBytes, maxLines) {
  const hash = createHash('sha256');
  const chunks = [];
  let bytes = 0;
  let lines = 0;
  let truncated = false;
  const stream = createReadStream(filePath, { encoding: 'utf8' });
  let pending = '';
  for await (const chunk of stream) {
    const text = String(chunk);
    hash.update(text);
    if (bytes >= maxBytes || lines >= maxLines) {
      truncated = true;
      continue;
    }
    const remaining = maxBytes - bytes;
    const bounded = text.slice(0, remaining);
    bytes += bounded.length;
    pending += bounded;
    const parts = pending.split(/\r?\n/);
    pending = parts.pop() ?? '';
    for (const line of parts) {
      if (lines >= maxLines) {
        truncated = true;
        break;
      }
      chunks.push(line);
      lines += 1;
    }
    if (bounded.length < text.length) truncated = true;
  }
  if (pending && lines < maxLines && bytes <= maxBytes) chunks.push(pending);
  else if (pending) truncated = true;
  return { text: chunks.join('\n'), sourceSha256: hash.digest('hex'), bytes, lines, truncated };
}

function runRtk(text, executable, maxChars) {
  return new Promise((resolve) => {
    const child = spawn(executable, ['log'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    let truncated = false;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (stdout.length >= maxChars) {
        truncated = true;
        return;
      }
      stdout += String(chunk).slice(0, maxChars - stdout.length);
      if (stdout.length >= maxChars) truncated = true;
    });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.once('error', (error) => resolve({ ok: false, error: error.message, stderr }));
    child.once('close', (code) => resolve({ ok: code === 0, code, stdout, stderr, truncated }));
    child.stdin.end(text);
  });
}

export async function compressLogWithRtk(options) {
  const filePath = options?.filePath;
  if (typeof filePath !== 'string' || filePath === '') throw new TypeError('filePath must be a non-empty string');
  const maxBytes = Number.isInteger(options.maxBytes) && options.maxBytes > 0 ? options.maxBytes : DEFAULT_MAX_BYTES;
  const maxLines = Number.isInteger(options.maxLines) && options.maxLines > 0 ? options.maxLines : DEFAULT_MAX_LINES;
  const maxCompressedChars = Number.isInteger(options.maxCompressedChars) && options.maxCompressedChars > 0
    ? options.maxCompressedChars
    : DEFAULT_MAX_COMPRESSED_CHARS;
  const source = await readBoundedFile(filePath, maxBytes, maxLines);
  const compression = await runRtk(source.text, options.rtkExecutable ?? 'rtk.exe', maxCompressedChars);
  if (!compression.ok) {
    return {
      status: 'failed',
      sourceSha256: source.sourceSha256,
      sourceBytes: source.bytes,
      sourceLines: source.lines,
      sourceTruncated: source.truncated,
      error: compression.error ?? compression.stderr ?? `rtk exited with code ${compression.code}`,
    };
  }
  const compressed = redact(compression.stdout);
  const events = compressed.split(/\r?\n/).filter(Boolean).map(parseLine);
  return {
    status: 'compressed',
    sourceSha256: source.sourceSha256,
    sourceBytes: source.bytes,
    sourceLines: source.lines,
    sourceTruncated: source.truncated,
    compressedChars: compressed.length,
    compressedTruncated: compression.truncated,
    content: compressed,
    events,
  };
}

export const runtimeEvidenceConstants = Object.freeze({ DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, DEFAULT_MAX_COMPRESSED_CHARS });
