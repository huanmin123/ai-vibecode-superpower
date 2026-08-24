import { promises as fs } from 'node:fs';
import path from 'node:path';

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const JSONL_PATTERN = /\.jsonl$/iu;

function fail(message) { throw new Error(message); }

export function parseDate(value, name) {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) fail(`${name} must be YYYY-MM-DD`);
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== value) fail(`${name} must be a valid calendar date`);
  return value;
}

function inRange(date, from, to) { return date >= from && date <= to; }

async function filesRecursive(root) {
  const result = [];
  let entries;
  try { entries = await fs.readdir(root, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return result; throw error; }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) result.push(...await filesRecursive(full));
    else if (entry.isFile() && JSONL_PATTERN.test(entry.name)) result.push(full);
  }
  return result.sort();
}

function firstRecord(text, file) {
  const line = text.split(/\r?\n/u)[0];
  if (!line.trim()) fail(`${file}: first record is empty`);
  let record;
  try { record = JSON.parse(line); }
  catch (error) { fail(`${file}: invalid JSON in first record: ${error.message}`); }
  if (record?.type !== 'session_meta') fail(`${file}: first record type must be session_meta`);
  const payload = record.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) fail(`${file}: session_meta payload must be an object`);
  if (typeof payload.id !== 'string' || !payload.id.trim()) fail(`${file}: session_meta payload.id is required`);
  return { record, payload };
}

function archiveDate(file, payload) {
  const nameDate = path.basename(file).match(/(\d{4}-\d{2}-\d{2})/u)?.[1];
  if (nameDate) return nameDate;
  const timestamp = payload.timestamp ?? payload.payload?.timestamp;
  if (typeof timestamp === 'string' && !Number.isNaN(Date.parse(timestamp))) return timestamp.slice(0, 10);
  return null;
}

function addCount(map, value) {
  if (value === undefined || value === null || value === '') return;
  map[value] = (map[value] ?? 0) + 1;
}

function summarize(entries) {
  const counts = { files: {}, threads: {}, sessions: {}, parent_threads: {}, roles: {}, cwd: {} };
  const records = [];
  const seen = new Set();
  for (const entry of entries) {
    if (seen.has(entry.payload.id)) continue;
    seen.add(entry.payload.id);
    const payload = entry.payload;
    const record = {
      source: entry.source,
      file: entry.file,
      id: payload.id,
      session_id: payload.session_id ?? null,
      parent_thread: payload.parent_thread_id ?? payload.parent_thread ?? null,
      role: payload.agent_role ?? payload.role ?? null,
      cwd: payload.cwd ?? null,
      timestamp: payload.timestamp ?? entry.record.timestamp ?? null,
    };
    records.push(record);
    addCount(counts.files, entry.file);
    addCount(counts.threads, payload.id);
    addCount(counts.sessions, payload.session_id);
    addCount(counts.parent_threads, record.parent_thread);
    addCount(counts.roles, record.role);
    addCount(counts.cwd, record.cwd);
  }
  return { counts, files: counts.files, threads: counts.threads, sessions: counts.sessions, parent_thread: counts.parent_threads, roles: counts.roles, cwd: counts.cwd, records, total: records.length };
}

export async function aggregateSessionMetadata({ codexHome, from, to, workspace, role } = {}) {
  if (typeof codexHome !== 'string' || !path.isAbsolute(codexHome)) fail('--codex-home must be an absolute path');
  from = parseDate(from, '--from');
  to = parseDate(to, '--to');
  if (from > to) fail('--from must be on or before --to');
  const activeEntries = [];
  const activeRoot = path.join(codexHome, 'sessions');
  for (const date of await dateDirectories(activeRoot, from, to)) {
    for (const file of await filesRecursive(path.join(activeRoot, ...date.split('-')))) {
      const { record, payload } = firstRecord(await fs.readFile(file, 'utf8'), file);
      if (matches(payload, workspace, role)) activeEntries.push({ source: 'active', file, record, payload });
    }
  }
  const archiveEntries = [];
  for (const file of await filesRecursive(path.join(codexHome, 'archived_sessions'))) {
    const filenameDate = path.basename(file).match(/(\d{4}-\d{2}-\d{2})/u)?.[1];
    if (filenameDate && !inRange(filenameDate, from, to)) continue;
    const { record, payload } = firstRecord(await fs.readFile(file, 'utf8'), file);
    const date = archiveDate(file, payload);
    if (date && inRange(date, from, to) && matches(payload, workspace, role)) archiveEntries.push({ source: 'archive', file, record, payload });
  }
  const active = summarize(activeEntries); const archive = summarize(archiveEntries);
  const combined = summarize([...activeEntries, ...archiveEntries]);
  return { from, to, filters: { workspace: workspace ?? null, role: role ?? null }, active, archive, ...combined };
}

function matches(payload, workspace, role) {
  if (workspace && payload.cwd !== workspace) return false;
  const actualRole = payload.agent_role ?? payload.role;
  return !role || actualRole === role;
}

async function dateDirectories(root, from, to) {
  const result = [];
  for (let date = from; date <= to;) {
    result.push(date);
    const next = new Date(`${date}T00:00:00.000Z`); next.setUTCDate(next.getUTCDate() + 1); date = next.toISOString().slice(0, 10);
  }
  return result;
}

function parseArgs(argv) {
  const optionKeys = new Map([
    ['--codex-home', 'codexHome'],
    ['--from', 'from'],
    ['--to', 'to'],
    ['--workspace', 'workspace'],
    ['--role', 'role'],
    ['--format', 'format'],
  ]);
  const values = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help') return { help: true };
    const key = optionKeys.get(arg);
    if (!key) fail(`unknown option: ${arg}`);
    const value = argv[++i]; if (!value || value.startsWith('--')) fail(`${arg} requires a value`);
    values[key] = value;
  }
  if (!values.codexHome || !values.from || !values.to) fail('usage requires --codex-home, --from and --to');
  if (values.format && values.format !== 'json') fail('--format must be json');
  return values;
}

export const HELP = 'Read active <codex-home>/sessions/YYYY/MM/DD and <codex-home>/archived_sessions. Active files are selected by date directories; archive files are selected by a YYYY-MM-DD filename date or first session timestamp date. Only the first JSONL record is parsed and it must be type=session_meta.';

if (process.argv[1] && new URL(import.meta.url).pathname.toLowerCase() === new URL(`file:///${process.argv[1].replaceAll('\\', '/')}`).pathname.toLowerCase()) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) { process.stdout.write(`${HELP}\n`); }
    else process.stdout.write(`${JSON.stringify(await aggregateSessionMetadata(args), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`session metadata aggregation failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
