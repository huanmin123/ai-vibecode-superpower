import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

const DEFAULT_MAX_BYTES = 2_000_000;
const DEFAULT_MAX_LINES = 20_000;
const DEFAULT_MAX_COMPRESSED_CHARS = 100_000;
const DEFAULT_RTK_EXECUTABLE = process.platform === 'win32' ? 'rtk.exe' : 'rtk';
const DEFAULT_RTK_TIMEOUT_MS = 30_000;

function redact(text) {
  return String(text)
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/(["']?(?:authorization|cookie|set-cookie|token|password|secret|api[_-]?key|connection[_-]?string)["']?\s*[:=]\s*)(?:Bearer\s+)?(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1[REDACTED]')
    .replace(/(?:https?:\/\/[^\s/@]+):[^\s/@]+@/gi, 'https://[REDACTED]@');
}

export function redactRuntimeText(text) {
  return redact(text);
}

function resolveRtkExecutable(value) {
  const executable = value === undefined ? DEFAULT_RTK_EXECUTABLE : value;
  if (typeof executable !== 'string' || executable.trim() === '') throw new TypeError('rtkExecutable must be a command basename');
  const normalized = executable.trim();
  const allowed = process.platform === 'win32' ? ['rtk', 'rtk.exe'] : ['rtk'];
  if (!allowed.includes(normalized.toLowerCase()) || normalized.includes('/') || normalized.includes('\\')) {
    throw new TypeError(`rtkExecutable must be one of: ${allowed.join(', ')}`);
  }
  return normalized;
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
  const stream = createReadStream(filePath);
  const decoder = new StringDecoder('utf8');
  let pending = '';
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    hash.update(buffer);
    if (bytes >= maxBytes || lines >= maxLines) {
      truncated = true;
      continue;
    }
    const remaining = maxBytes - bytes;
    const bounded = buffer.subarray(0, remaining);
    bytes += bounded.length;
    pending += decoder.write(bounded);
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
    if (bounded.length < buffer.length) truncated = true;
  }
  pending += decoder.end();
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
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      resolve({ ok: false, error: `rtk timed out after ${DEFAULT_RTK_TIMEOUT_MS}ms`, stderr });
    }, DEFAULT_RTK_TIMEOUT_MS);
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
    child.stderr.on('data', (chunk) => {
      if (stderr.length >= maxChars) return;
      stderr += String(chunk).slice(0, maxChars - stderr.length);
    });
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ ok: false, error: redact(error.message), stderr: redact(stderr) });
    });
    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ ok: code === 0, code, stdout, stderr: redact(stderr), truncated });
    });
    child.stdin.end(text);
  });
}

export async function compressLogWithRtk(options) {
  const filePath = options?.filePath;
  if (typeof filePath !== 'string' || filePath === '') throw new TypeError('filePath must be a non-empty string');
  const executable = resolveRtkExecutable(options.rtkExecutable);
  const maxBytes = Number.isInteger(options.maxBytes) && options.maxBytes > 0 ? options.maxBytes : DEFAULT_MAX_BYTES;
  const maxLines = Number.isInteger(options.maxLines) && options.maxLines > 0 ? options.maxLines : DEFAULT_MAX_LINES;
  const maxCompressedChars = Number.isInteger(options.maxCompressedChars) && options.maxCompressedChars > 0
    ? options.maxCompressedChars
    : DEFAULT_MAX_COMPRESSED_CHARS;
  const source = await readBoundedFile(filePath, maxBytes, maxLines);
  const compression = await runRtk(redact(source.text), executable, maxCompressedChars);
  if (!compression.ok) {
    return {
      status: 'bounded_raw',
      sourceSha256: source.sourceSha256,
      sourceBytes: source.bytes,
      sourceLines: source.lines,
      sourceTruncated: source.truncated,
      compressionError: compression.error ?? compression.stderr ?? `rtk exited with code ${compression.code}`,
      content: redact(source.text),
      events: source.text.split(/\r?\n/).filter(Boolean).map(parseLine),
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

export const runtimeEvidenceConstants = Object.freeze({ DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, DEFAULT_MAX_COMPRESSED_CHARS, DEFAULT_RTK_EXECUTABLE, DEFAULT_RTK_TIMEOUT_MS });
