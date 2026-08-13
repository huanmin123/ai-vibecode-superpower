import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { deleteTaskState, readTaskState, taskStateExists, writeTaskState } from './sqlite_task_store.mjs';

export const VERSION = 1;
const REVIEW_PROTOCOL_VERSION = 3;
const PENDING = 'pending';
const RUNNING = 'running';
const SUCCEEDED = 'succeeded';
const TERMINAL = new Set([SUCCEEDED, 'failed', 'blocked', 'skipped', 'unavailable', 'abandoned']);
const COMPLETABLE = new Set([SUCCEEDED, 'failed', 'blocked', 'skipped', 'unavailable']);
const SOL_ROLES = new Set(['avsp_sol_high', 'avsp_sol_xhigh', 'avsp_sol_max']);
const SOL_ESCALATION_ORDER = ['avsp_sol_high', 'avsp_sol_xhigh', 'avsp_sol_max'];
const TERRA_REVIEW_ROLE = 'avsp_terra_xhigh';
const QUALITY_REVIEW_KIND = 'quality_review';
const ASSURANCE_LEVELS = new Set(['verification', 'terra', 'sol']);
const ASSURANCE_ASSESSMENT_FIELDS = ['impact', 'recoverability', 'uncertainty', 'verifiability', 'coupling', 'selection_reason'];
const ASSURANCE_DIMENSION_FIELDS = ASSURANCE_ASSESSMENT_FIELDS.filter(field => field !== 'selection_reason');
const ASSURANCE_DIMENSION_STATUSES = new Set(['controlled', 'partial', 'unknown']);
const ASSURANCE_DIMENSION_VALUE_FIELDS = ['status', 'evidence', 'rationale'];
const REVIEW_FINDING_FIELDS = ['id', 'severity', 'requirement_id', 'summary', 'evidence'];
const REVIEW_FINDING_SEVERITIES = new Set(['blocking', 'advisory']);
const REPAIR_FINDING_FIELDS = ['finding_id', 'resolution', 'verification_evidence'];
const FALLBACK_ROLE = 'avsp_terra_xhigh_readonly';
const LUNA_EXECUTOR_ROLES = new Set([
  'avsp_luna_high_executor',
  'avsp_luna_xhigh_executor',
  // Writers are retained for existing tasks; new tasks use the executor roles.
  'avsp_luna_high_writer',
  'avsp_luna_xhigh_writer',
]);
const LEGACY_LUNA_WRITER_ROLES = new Set(['avsp_luna_high_writer', 'avsp_luna_xhigh_writer']);
const READ_ONLY_ROLES = new Set([
  'avsp_luna_high',
  'avsp_luna_xhigh',
  'avsp_sol_high',
  'avsp_sol_xhigh',
  'avsp_sol_max',
  'avsp_terra_low_readonly',
  'avsp_terra_medium_readonly',
  'avsp_terra_xhigh',
  'avsp_terra_xhigh_readonly',
]);
const READ_ONLY_FALLBACK_ROLES = new Map([
  ['avsp_luna_high', 'avsp_terra_low_readonly'],
  ['avsp_luna_xhigh', 'avsp_terra_medium_readonly'],
]);
const READ_ONLY_FALLBACK_ROLE_SET = new Set([...READ_ONLY_FALLBACK_ROLES.values(), FALLBACK_ROLE]);
const PROTECTED_EXECUTOR_ROLE = 'avsp_terra_high';
const ROUTING_FIELDS = ['execution_risk', 'routing_reason', 'execution_owner', 'integration_owner', 'quality_guard'];
const IGNORED_DIRECTORIES = new Set(['.git', '.codex', 'node_modules', '.venv']);
const WORKSPACE_LEASE_AUTHORITY_FILENAME = '.codex-workflow-controller-authority.json';
const WORKSPACE_LEASE_PUBLICATION_SUFFIX = '.publication.json';
const WORKSPACE_LEASE_AUTHORITY_VERSION = 2;
const LEGACY_WORKSPACE_LEASE_AUTHORITY_VERSION = 1;
const MAX_MANIFEST_BYTES = 1 * 1024 * 1024;
const MAX_NODE_RESULT_BYTES = 64 * 1024;
const MAX_REVIEW_BYTES = 128 * 1024;
const MAX_STATE_BYTES = 8 * 1024 * 1024;
const MAX_FINGERPRINT_FILES = 100_000;
const MAX_FINGERPRINT_FILE_BYTES = 512 * 1024 * 1024;
const MAX_FINGERPRINT_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;
const FINGERPRINT_ATTEMPTS = 3;
const MAX_NODES = 64;
const MAX_REQUIREMENTS = 64;
const MAX_NODE_ATTEMPTS = 8;
const MAX_UNAVAILABLE_ATTEMPTS = 8;
const MAX_TOTAL_NODE_ATTEMPTS = MAX_NODE_ATTEMPTS + MAX_UNAVAILABLE_ATTEMPTS;
const MAX_REVIEWS = 16;
const MAX_REPAIR_RECORDS = MAX_REVIEWS;
const MAX_VERIFICATION_HISTORY = MAX_REVIEWS;
const MAX_REVIEW_FINDINGS = 64;
const MAX_MAX_CLOSURE_ATTEMPTS = 2;
const PROTOCOL_MAX_CLOSURE_ATTEMPTS = 1;
const REVIEW_ENTRY_STAGES = new Set(['terra_single', 'terra_cohort', 'sol_high', 'sol_xhigh']);
const REVIEW_PROTOCOL_STAGES = new Set([...REVIEW_ENTRY_STAGES, 'sol_max_initial', 'sol_max_closure']);
const COHORT_SLOTS = ['coverage', 'adversarial'];
const COHORT_PHASES = new Set(['blind', 'cross_questioning', 'passed', 'failed']);
const MAX_CHECKPOINT_BYTES = 32 * 1024;
const MAX_RECOVERY_RESULT_BYTES = 8 * 1024;
const DEFAULT_TASK_RETENTION_DAYS = 7;
const QUARANTINE_AFTER_DAYS = 30;
const ERROR_STATE_RETENTION_DAYS = 365;
const DAY_MS = 24 * 60 * 60 * 1000;
const PRUNE_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const MAX_PRUNE_REPORT_ENTRIES = 128;
const PRUNE_SWEEP_FILENAME = '.workflow-prune-sweep.json';
const SQLITE_STATE_SUFFIX = '.sqlite';
const ERROR_STATE_DIRECTORY = '.workflow-errors';
const ERROR_QUARANTINE_FILENAME = 'quarantine.json';
const QUARANTINE_EXPIRY_FILENAME = '.quarantine-expiry.json';
const REVIEW_ARTIFACT_DIRECTORY = '.workflow-review-results';
const QUARANTINE_REVIEW_DIRECTORY = 'review-results';
const MAX_QUARANTINE_BYTES = 32 * 1024;
const MAX_WINDOWS_PATH_LENGTH = 260;
const READ_ONLY_COMMANDS = new Set(['audit-context', 'doctor', 'fingerprint', 'ready', 'stale', 'status']);

export class ControllerError extends Error {}

const utcNow = () => new Date().toISOString();
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const DEFAULT_STALE_LOCK_SEC = 30;
const DEFAULT_LEASE_SEC = 1800;
const DEFAULT_ACTIVATION_TIMEOUT_SEC = 600;
const WORKSPACE_LEASE_VERSION = 2;
const LEGACY_WORKSPACE_LEASE_VERSION = 1;
const WORKSPACE_CLAIM_MODES = new Set(['read', 'write']);
const MAX_WORKSPACE_CLAIMS = 128;
const MAX_WORKSPACE_CLAIM_PREFIX_LENGTH = 1024;
const MAX_WORKSPACE_ACTIVE_TASKS = 64;
const ROOT_RESCUE_ROLE = 'main/root';
const NATIVE_AGENT_FINISHED = 'native_agent_finished';
const ROOT_RESCUE_SELF_COMPLETION = 'root_rescue_self_completion';
const NATIVE_AGENT_EXIT_CONFIRMED = 'native_agent_exit_confirmed';
const NATIVE_AGENT_START_FAILED = 'native_agent_start_failed';

function requiredString(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new ControllerError(`${name} must be a non-empty string`);
  return value.trim();
}

function requiredIdentifier(value, name) {
  const identifier = requiredString(value, name);
  if (!/^[A-Za-z][A-Za-z0-9._-]{0,79}$/.test(identifier)) throw new ControllerError(`${name} must use letters, digits, dot, underscore, or hyphen and start with a letter`);
  return identifier;
}

function optionalString(value, name) {
  if (value === undefined || value === null) return null;
  return requiredString(value, name);
}

function requiredStateDirectory(value) {
  const stateDir = requiredString(value, 'state_dir');
  if (!path.isAbsolute(stateDir)) throw new ControllerError('state_dir must be an absolute path');
  return path.resolve(stateDir);
}

// State directories are security identities, not display strings. Resolve the
// existing physical prefix, then append only the as-yet-missing tail so a
// junction, symlink, or Windows case alias cannot obtain a second lock.
export async function canonicalStateDirectory(value, label = 'state_dir') {
  const requested = requiredStateDirectory(value);
  const missing = [];
  let cursor = requested;
  for (;;) {
    try {
      const physical = await fs.realpath(cursor);
      const metadata = await fs.stat(physical);
      if (!metadata.isDirectory()) throw new ControllerError(`${label} must name a directory: ${requested}`);
      return path.normalize(path.join(physical, ...missing));
    } catch (error) {
      if (error instanceof ControllerError) throw error;
      if (error.code !== 'ENOENT') throw new ControllerError(`Cannot resolve ${label} physical identity: ${requested}: ${error.message}`);
      const parent = path.dirname(cursor);
      if (parent === cursor) throw new ControllerError(`Cannot resolve ${label} physical identity: ${requested}`);
      const segment = path.basename(cursor);
      if (!segment || segment === '.' || segment === '..') throw new ControllerError(`Cannot resolve ${label} physical identity: ${requested}`);
      missing.unshift(segment);
      cursor = parent;
    }
  }
}

async function canonicalStatePath(value, label = 'state_path') {
  const rawPath = requiredString(value, label);
  if (!path.isAbsolute(rawPath)) throw new ControllerError(`${label} must be an absolute path`);
  const resolved = path.resolve(rawPath);
  const name = path.basename(resolved);
  if (!name.endsWith('.json') || name === '.json') throw new ControllerError(`${label} must name a .json state file`);
  return path.join(await canonicalStateDirectory(path.dirname(resolved), `${label} directory`), name);
}

export function statePathKey(value) {
  const normalized = path.normalize(value).normalize('NFC');
  return process.platform === 'win32' ? normalized.toLocaleLowerCase('und') : normalized;
}

export function sameStatePath(left, right) {
  return typeof left === 'string' && typeof right === 'string' && statePathKey(left) === statePathKey(right);
}

function statePathsOverlap(left, right) {
  const leftKey = statePathKey(path.resolve(left));
  const rightKey = statePathKey(path.resolve(right));
  return leftKey === rightKey || leftKey.startsWith(`${rightKey}${path.sep}`) || rightKey.startsWith(`${leftKey}${path.sep}`);
}

function positiveInteger(value, name, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new ControllerError(`${name} must be a positive integer`);
  return parsed;
}

function trueValue(value, name) {
  if (value !== true && value !== 'true') throw new ControllerError(`${name} must be true`);
}

function retryConfirmation(parameters) {
  const hasCanonical = hasOwn(parameters, 'previous_agent_stopped');
  const hasLegacyAlias = hasOwn(parameters, 'previous_agents_stopped');
  if (!hasCanonical && !hasLegacyAlias) throw new ControllerError('previous_agent_stopped or previous_agents_stopped is required');
  const canonicalValue = hasCanonical && (parameters.previous_agent_stopped === true || parameters.previous_agent_stopped === 'true');
  const legacyValue = hasLegacyAlias && (parameters.previous_agents_stopped === true || parameters.previous_agents_stopped === 'true');
  if (hasCanonical && hasLegacyAlias && canonicalValue !== legacyValue) throw new ControllerError('previous_agent_stopped and previous_agents_stopped must not conflict');
  if (hasCanonical) trueValue(parameters.previous_agent_stopped, 'previous_agent_stopped');
  if (hasLegacyAlias) trueValue(parameters.previous_agents_stopped, 'previous_agents_stopped');
}

function nonEmptyReviewValue(value) {
  if (typeof value === 'string') return Boolean(value.trim());
  if (Array.isArray(value)) return value.length > 0;
  return Boolean(value) && typeof value === 'object' && Object.keys(value).length > 0;
}

function requiredReviewValue(value, name) {
  if (!nonEmptyReviewValue(value)) throw new ControllerError(`${name} must be a non-empty string, array, or object`);
  return value;
}

function assuranceAssessment(value, label = 'assurance_assessment', { allowLegacy = false } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ControllerError(`${label} must be an object`);
  const keys = Object.keys(value).sort();
  const expected = [...ASSURANCE_ASSESSMENT_FIELDS].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new ControllerError(`${label} must contain exactly: ${ASSURANCE_ASSESSMENT_FIELDS.join(', ')}`);
  }
  const legacy = ASSURANCE_ASSESSMENT_FIELDS.every(field => typeof value[field] === 'string');
  if (legacy) {
    if (!allowLegacy) throw new ControllerError(`${label} dimensions must use structured status, evidence, and rationale values`);
    return Object.fromEntries(ASSURANCE_ASSESSMENT_FIELDS.map(field => [field, requiredString(value[field], `${label}.${field}`)]));
  }
  const assessment = Object.create(null);
  for (const field of ASSURANCE_DIMENSION_FIELDS) {
    const dimension = value[field];
    if (!dimension || typeof dimension !== 'object' || Array.isArray(dimension)) throw new ControllerError(`${label}.${field} must be an object`);
    const dimensionKeys = Object.keys(dimension).sort();
    const expectedDimensionKeys = [...ASSURANCE_DIMENSION_VALUE_FIELDS].sort();
    if (dimensionKeys.length !== expectedDimensionKeys.length || dimensionKeys.some((key, index) => key !== expectedDimensionKeys[index])) {
      throw new ControllerError(`${label}.${field} must contain exactly: ${ASSURANCE_DIMENSION_VALUE_FIELDS.join(', ')}`);
    }
    const status = requiredString(dimension.status, `${label}.${field}.status`);
    if (!ASSURANCE_DIMENSION_STATUSES.has(status)) throw new ControllerError(`${label}.${field}.status must be controlled, partial, or unknown`);
    if (!Array.isArray(dimension.evidence) || !dimension.evidence.length) throw new ControllerError(`${label}.${field}.evidence must be a non-empty array`);
    assessment[field] = {
      status,
      evidence: dimension.evidence.map((item, index) => requiredString(item, `${label}.${field}.evidence[${index}]`)),
      rationale: requiredString(dimension.rationale, `${label}.${field}.rationale`),
    };
  }
  assessment.selection_reason = requiredString(value.selection_reason, `${label}.selection_reason`);
  return assessment;
}

function assuranceLevelForAssessment(assessment) {
  if (typeof assessment?.impact === 'string') return null;
  const statuses = ASSURANCE_DIMENSION_FIELDS.map(field => assessment[field].status);
  if (statuses.includes('unknown')) return 'sol';
  if (statuses.includes('partial')) return 'terra';
  return 'verification';
}

function requireAssuranceLevelMatches(level, assessment, label = 'assurance_level') {
  const expectedLevel = assuranceLevelForAssessment(assessment);
  if (expectedLevel && level !== expectedLevel) throw new ControllerError(`${label} must be ${expectedLevel} for the supplied assurance_assessment`);
}

function reviewContextValue(value, label = 'review_context') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ControllerError(`${label} must be an object`);
  const expected = ['boundaries', 'environment', 'scenarios'];
  const keys = Object.keys(value).sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) throw new ControllerError(`${label} must contain exactly: ${expected.join(', ')}`);
  if (!nonEmptyReviewValue(value.environment)) throw new ControllerError(`${label}.environment must be non-empty`);
  if (!Array.isArray(value.scenarios) || !value.scenarios.length || value.scenarios.some(item => !nonEmptyReviewValue(item))) throw new ControllerError(`${label}.scenarios must be a non-empty array of non-empty values`);
  if (!nonEmptyReviewValue(value.boundaries)) throw new ControllerError(`${label}.boundaries must be non-empty`);
  return structuredClone(value);
}

function reviewFindings(state, value, verdict) {
  const rawFindings = value ?? [];
  if (!Array.isArray(rawFindings)) throw new ControllerError('Review findings must be an array');
  if (rawFindings.length > MAX_REVIEW_FINDINGS) throw new ControllerError(`Review findings exceed the ${MAX_REVIEW_FINDINGS}-finding limit`);
  const requirementIds = new Set(state.requirements.map(requirement => requirement.id));
  const findings = rawFindings.map((finding, index) => {
    if (!finding || typeof finding !== 'object' || Array.isArray(finding)) throw new ControllerError(`Review findings[${index}] must be an object`);
    const keys = Object.keys(finding).sort();
    const expectedFields = [...REVIEW_FINDING_FIELDS].sort();
    if (keys.length !== expectedFields.length || keys.some((key, keyIndex) => key !== expectedFields[keyIndex])) {
      throw new ControllerError(`Review findings[${index}] must contain exactly: ${REVIEW_FINDING_FIELDS.join(', ')}`);
    }
    const id = requiredIdentifier(finding.id, `Review findings[${index}].id`);
    const severity = requiredString(finding.severity, `Review findings[${index}].severity`);
    if (!REVIEW_FINDING_SEVERITIES.has(severity)) throw new ControllerError(`Review findings[${index}].severity must be blocking or advisory`);
    const requirementId = finding.requirement_id === null ? null : requiredIdentifier(finding.requirement_id, `Review findings[${index}].requirement_id`);
    if (requirementId !== null && !requirementIds.has(requirementId)) throw new ControllerError(`Review finding references an unknown requirement: ${requirementId}`);
    return { id, severity, requirement_id: requirementId, summary: requiredString(finding.summary, `Review findings[${index}].summary`), evidence: requiredReviewValue(finding.evidence, `Review findings[${index}].evidence`) };
  });
  if (new Set(findings.map(finding => finding.id)).size !== findings.length) throw new ControllerError('Review finding ids must be unique');
  if (verdict === 'fail' && !findings.some(finding => finding.severity === 'blocking')) throw new ControllerError('A fail review requires at least one blocking finding');
  if (verdict === 'pass' && findings.some(finding => finding.severity === 'blocking')) throw new ControllerError('A pass review cannot contain a blocking finding');
  if (verdict === 'unavailable' && findings.length) throw new ControllerError('An unavailable review cannot contain findings');
  return findings;
}

function maxClosureRepairRegressions(state, review, findings) {
  const raw = review.repair_regressions ?? [];
  if (!Array.isArray(raw)) throw new ControllerError('max closure repair_regressions must be an array');
  const findingsById = new Map(findings.map(finding => [finding.id, finding]));
  const regressions = raw.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).sort().join(',') !== 'evidence,finding_id') throw new ControllerError(`repair_regressions[${index}] must contain exactly finding_id and evidence`);
    const findingId = requiredIdentifier(item.finding_id, `repair_regressions[${index}].finding_id`);
    const finding = findingsById.get(findingId);
    if (!finding || finding.severity !== 'blocking' || finding.requirement_id === null) throw new ControllerError(`repair_regressions[${index}] must identify a blocking finding linked to an original requirement`);
    return { finding_id: findingId, evidence: requiredReviewValue(item.evidence, `repair_regressions[${index}].evidence`) };
  });
  if (new Set(regressions.map(item => item.finding_id)).size !== regressions.length) throw new ControllerError('repair_regressions finding_id values must be unique');
  return regressions;
}

function addressedReviewFindings(sourceReview, value) {
  if (!hasOwn(sourceReview, 'findings')) return requiredReviewValue(value, 'addressed_findings');
  if (!Array.isArray(value)) throw new ControllerError('addressed_findings must be an array for a structured review');
  const sourceById = new Map(sourceReview.findings.map(finding => [finding.id, finding]));
  const addressed = value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new ControllerError(`addressed_findings[${index}] must be an object`);
    const keys = Object.keys(item).sort();
    const expectedFields = [...REPAIR_FINDING_FIELDS].sort();
    if (keys.length !== expectedFields.length || keys.some((key, keyIndex) => key !== expectedFields[keyIndex])) {
      throw new ControllerError(`addressed_findings[${index}] must contain exactly: ${REPAIR_FINDING_FIELDS.join(', ')}`);
    }
    const findingId = requiredString(item.finding_id, `addressed_findings[${index}].finding_id`);
    if (!sourceById.has(findingId)) throw new ControllerError(`addressed_findings references an unknown finding: ${findingId}`);
    return { finding_id: findingId, resolution: requiredReviewValue(item.resolution, `addressed_findings[${index}].resolution`), verification_evidence: requiredReviewValue(item.verification_evidence, `addressed_findings[${index}].verification_evidence`) };
  });
  if (new Set(addressed.map(item => item.finding_id)).size !== addressed.length) throw new ControllerError('addressed_findings finding_id values must be unique');
  const addressedIds = new Set(addressed.map(item => item.finding_id));
  const missingBlocking = sourceReview.findings.filter(finding => finding.severity === 'blocking' && !addressedIds.has(finding.id)).map(finding => finding.id);
  if (missingBlocking.length) throw new ControllerError(`addressed_findings must resolve every blocking finding: ${missingBlocking.join(', ')}`);
  return addressed;
}

function isMaxReviewNode(node) {
  return node?.kind === 'total_review' && node.agent_type === 'avsp_sol_max';
}

function isReviewProtocolState(state) {
  return state?.routing_schema_version === REVIEW_PROTOCOL_VERSION && state?.review_protocol_version === REVIEW_PROTOCOL_VERSION;
}

function protocolReviewNode(state) {
  return isReviewProtocolState(state) ? reviewNodesForState(state)[0] ?? null : null;
}

function isCohortReviewNode(state, node) {
  return isReviewProtocolState(state) && node?.review_gate?.stage === 'terra_cohort' && node.review_gate.cohort !== null;
}

function createCohortLane(slot) {
  return {
    slot,
    status: PENDING,
    reserved_agent_task_path: null,
    agent_task_path: null,
    agent_thread_id: null,
    agent_role: null,
    claim_id: null,
    claimed_at: null,
    activation_at: null,
    activation_deadline_at: null,
    heartbeat_at: null,
    heartbeat_count: 0,
    lease_duration_sec: null,
    checkpoint: null,
    checkpoint_at: null,
    attempt: 0,
    attempt_budget_used: 0,
    unavailable_attempts: 0,
    review_claim_id: null,
    blind_review_claim_id: null,
    cross_review_claim_id: null,
    result: null,
  };
}

function createTerraCohort(roundId = randomUUID()) {
  return {
    round_id: roundId,
    phase: 'blind',
    exchange: null,
    aggregate: null,
    lanes: Object.fromEntries(COHORT_SLOTS.map(slot => [slot, createCohortLane(slot)])),
  };
}

function createReviewGate(stage) {
  if (!REVIEW_PROTOCOL_STAGES.has(stage)) throw new ControllerError(`Unsupported review protocol stage: ${stage}`);
  return {
    stage,
    phase: 'ready',
    round_id: randomUUID(),
    pending_source_review_claim_id: null,
    scope_decision_required: false,
    cohort: stage === 'terra_cohort' ? createTerraCohort() : null,
  };
}

function protocolStageForNode(node) {
  return node?.review_gate?.stage ?? null;
}

function protocolNodeRole(stage) {
  if (stage === 'terra_single' || stage === 'terra_cohort') return TERRA_REVIEW_ROLE;
  if (stage === 'sol_high') return 'avsp_sol_high';
  if (stage === 'sol_xhigh') return 'avsp_sol_xhigh';
  if (stage === 'sol_max_initial' || stage === 'sol_max_closure') return 'avsp_sol_max';
  throw new ControllerError(`Unsupported review protocol stage: ${stage}`);
}

function protocolNodeKind(stage) {
  return stage === 'terra_single' || stage === 'terra_cohort' ? QUALITY_REVIEW_KIND : 'total_review';
}

function protocolNextStage(stage) {
  if (stage === 'terra_single') return 'terra_cohort';
  if (stage === 'terra_cohort') return 'sol_high';
  if (stage === 'sol_high') return 'sol_xhigh';
  if (stage === 'sol_xhigh') return 'sol_max_initial';
  if (stage === 'sol_max_initial') return 'sol_max_closure';
  return null;
}

function applyProtocolStage(node, stage) {
  node.kind = protocolNodeKind(stage);
  node.review_stage = stage.startsWith('terra') ? 'terra' : 'sol';
  node.agent_type = protocolNodeRole(stage);
  node.review_gate = createReviewGate(stage);
}

function cohortLaneForClaim(node, claimId) {
  if (!node?.review_gate?.cohort || typeof claimId !== 'string') return null;
  return Object.values(node.review_gate.cohort.lanes).find(lane => lane.claim_id === claimId) ?? null;
}

function activeCohortLaneForTask(node, taskPath) {
  if (!node?.review_gate?.cohort || typeof taskPath !== 'string') return null;
  return Object.values(node.review_gate.cohort.lanes).find(lane => lane.status === RUNNING && lane.agent_task_path === taskPath) ?? null;
}

function cohortLanes(node) {
  return Object.values(node?.review_gate?.cohort?.lanes ?? {});
}

function isCohortRoundComplete(node) {
  return cohortLanes(node).length === COHORT_SLOTS.length && cohortLanes(node).every(lane => ['succeeded', 'failed', 'unavailable'].includes(lane.status));
}

function resetCohortLanes(node) {
  for (const slot of COHORT_SLOTS) {
    const prior = node.review_gate.cohort.lanes[slot] ?? {};
    const lane = createCohortLane(slot);
    lane.attempt = prior.attempt ?? 0;
    lane.attempt_budget_used = prior.attempt_budget_used ?? 0;
    lane.unavailable_attempts = prior.unavailable_attempts ?? 0;
    lane.blind_review_claim_id = prior.blind_review_claim_id ?? null;
    node.review_gate.cohort.lanes[slot] = lane;
  }
}

function resetCohortLaneForRetry(lane, reservedAgentTaskPath, preserveBlindClaim) {
  const next = createCohortLane(lane.slot);
  next.attempt = lane.attempt;
  next.attempt_budget_used = lane.attempt_budget_used;
  next.unavailable_attempts = lane.unavailable_attempts;
  next.blind_review_claim_id = preserveBlindClaim ? lane.blind_review_claim_id ?? null : null;
  next.reserved_agent_task_path = reservedAgentTaskPath;
  return next;
}

function resetCohortRound(node, reservedSlot, reservedAgentTaskPath) {
  const prior = node.review_gate.cohort;
  const next = createTerraCohort();
  for (const slot of COHORT_SLOTS) {
    const priorLane = prior.lanes[slot] ?? {};
    const lane = next.lanes[slot];
    lane.attempt = priorLane.attempt ?? 0;
    lane.attempt_budget_used = priorLane.attempt_budget_used ?? 0;
    lane.unavailable_attempts = priorLane.unavailable_attempts ?? 0;
  }
  next.lanes[reservedSlot].reserved_agent_task_path = reservedAgentTaskPath;
  node.review_gate.cohort = next;
}

function currentCohortReviews(state, node, phase) {
  const claimIds = new Set(cohortLanes(node).map(lane => phase === 'blind' ? lane.blind_review_claim_id : lane.cross_review_claim_id).filter(Boolean));
  return state.reviews.filter(review => review.node_id === node.id && review.review_phase === phase && claimIds.has(review.claim_id));
}

function externallyVisibleReviews(state) {
  const cohortNode = protocolReviewNode(state);
  const activePhase = cohortNode?.review_gate?.cohort?.phase;
  if (activePhase !== 'blind' && activePhase !== 'cross_questioning') return state.reviews;
  return state.reviews.filter(review => !(review.node_id === cohortNode.id && review.review_phase === activePhase));
}

function protocolReviewHistoryDigest(state, { excludeActiveCohortPhase = false } = {}) {
  const reviews = excludeActiveCohortPhase ? externallyVisibleReviews(state) : state.reviews;
  return createHash('sha256').update(stableJson({
    goal: state.goal,
    requirements: state.requirements,
    scope: state.scope,
    non_goals: state.non_goals,
    reviews,
    repair_records: state.repair_records,
  })).digest('hex');
}

function validMaxReviewCharter(state, charter) {
  if (!charter || typeof charter !== 'object' || Array.isArray(charter)) return false;
  const protocolCharter = charter.schema_version === 2;
  if (![1, 2].includes(charter.schema_version) || !['initial_repair_required', 'closure_ready', 'closure_reviewing', 'repair_required', 'scope_decision_required', 'closure_passed'].includes(charter.status)) return false;
  if (typeof charter.created_at !== 'string' || !Number.isFinite(Date.parse(charter.created_at)) || typeof charter.source_review_claim_id !== 'string') return false;
  if (!charter.workflow_snapshot || typeof charter.workflow_snapshot !== 'object' || !charter.workspace_fingerprint || typeof charter.workspace_fingerprint !== 'object') return false;
  if (!sameJson(charter.requirements, state.requirements) || !sameJson(charter.workspace_claims, state.workspace_claims)) return false;
  if (!Array.isArray(charter.blocking_finding_ids) || !charter.blocking_finding_ids.length || !Array.isArray(charter.blocking_findings) || !Array.isArray(charter.out_of_charter_findings)) return false;
  if (new Set(charter.blocking_finding_ids).size !== charter.blocking_finding_ids.length || charter.blocking_findings.some(finding => !finding || typeof finding.id !== 'string') || !sameJson([...charter.blocking_finding_ids].sort(), charter.blocking_findings.map(finding => finding.id).sort())) return false;
  const closureLimit = protocolCharter ? PROTOCOL_MAX_CLOSURE_ATTEMPTS : MAX_MAX_CLOSURE_ATTEMPTS;
  if (!Number.isSafeInteger(charter.repair_count) || charter.repair_count < 0 || !Number.isSafeInteger(charter.closure_attempt_count) || charter.closure_attempt_count < 0 || charter.closure_attempt_limit !== closureLimit || charter.closure_attempt_count > charter.closure_attempt_limit || typeof charter.scope_decision_required !== 'boolean') return false;
  if (protocolCharter && (charter.source_max_initial !== true || !isReviewProtocolState(state))) return false;
  return (charter.pending_repair_source_claim_id === null || typeof charter.pending_repair_source_claim_id === 'string')
    && (charter.active_closure_claim_id === undefined || charter.active_closure_claim_id === null || typeof charter.active_closure_claim_id === 'string');
}

function isMaxClosureNode(state, node) {
  return isMaxReviewNode(node) && (!isReviewProtocolState(state) || protocolStageForNode(node) === 'sol_max_closure');
}

function maxReviewCharterMissing(state, node) {
  return isMaxClosureNode(state, node) && !validMaxReviewCharter(state, state.max_review_charter);
}

function requireMaxReviewCharter(state, node) {
  if (maxReviewCharterMissing(state, node)) {
    throw new ControllerError('A max total_review requires a frozen max_review_charter; legacy or incomplete max state requires explicit migration or a replacement task');
  }
  return state.max_review_charter;
}

async function freezeMaxReviewCharter(state, node, sourceReview) {
  const blockingFindings = sourceReview.findings.filter(finding => finding.severity === 'blocking');
  if (!blockingFindings.length) throw new ControllerError('A max review charter requires blocking findings from the finalized xhigh review');
  state.max_review_charter = {
    schema_version: 1,
    status: 'initial_repair_required',
    created_at: utcNow(),
    source_review_claim_id: sourceReview.claim_id,
    pending_repair_source_claim_id: sourceReview.claim_id,
    workflow_snapshot: workflowSnapshot(state),
    workspace_fingerprint: await workspaceFingerprint(state.workspace, state.workspace_claims),
    requirements: structuredClone(state.requirements),
    workspace_claims: structuredClone(state.workspace_claims),
    blocking_finding_ids: blockingFindings.map(finding => finding.id),
    blocking_findings: structuredClone(blockingFindings),
    repair_count: 0,
    closure_attempt_count: 0,
    closure_attempt_limit: MAX_MAX_CLOSURE_ATTEMPTS,
    out_of_charter_findings: [],
    scope_decision_required: false,
  };
  addEvent(state, 'max_review_charter_frozen', {
    node_id: node.id,
    source_review_claim_id: sourceReview.claim_id,
    blocking_finding_ids: state.max_review_charter.blocking_finding_ids,
    closure_attempt_limit: MAX_MAX_CLOSURE_ATTEMPTS,
  });
  return state.max_review_charter;
}

async function freezeProtocolMaxReviewCharter(state, node, sourceReview) {
  const blockingFindings = sourceReview.findings.filter(finding => finding.severity === 'blocking');
  if (!blockingFindings.length) throw new ControllerError('A max closure charter requires blocking findings from the finalized max initial review');
  state.max_review_charter = {
    schema_version: 2,
    status: 'initial_repair_required',
    created_at: utcNow(),
    source_review_claim_id: sourceReview.claim_id,
    pending_repair_source_claim_id: sourceReview.claim_id,
    workflow_snapshot: workflowSnapshot(state),
    workspace_fingerprint: await workspaceFingerprint(state.workspace, state.workspace_claims),
    requirements: structuredClone(state.requirements),
    workspace_claims: structuredClone(state.workspace_claims),
    blocking_finding_ids: blockingFindings.map(finding => finding.id),
    blocking_findings: structuredClone(blockingFindings),
    repair_count: 0,
    closure_attempt_count: 0,
    closure_attempt_limit: PROTOCOL_MAX_CLOSURE_ATTEMPTS,
    out_of_charter_findings: [],
    scope_decision_required: false,
    source_max_initial: true,
  };
  addEvent(state, 'max_initial_review_charter_frozen', { node_id: node.id, source_review_claim_id: sourceReview.claim_id, blocking_finding_ids: state.max_review_charter.blocking_finding_ids, closure_attempt_limit: PROTOCOL_MAX_CLOSURE_ATTEMPTS });
  return state.max_review_charter;
}

function maxClosureReview(state, node) {
  if (!isMaxClosureNode(state, node)) return false;
  const charter = requireMaxReviewCharter(state, node);
  return charter.status === 'closure_reviewing';
}

function nodeAttemptAvailability(node, nodeId) {
  if (node.attempt_budget_used >= MAX_NODE_ATTEMPTS) throw new ControllerError(`Node exceeded the ${MAX_NODE_ATTEMPTS}-attempt execution budget: ${nodeId}`);
  if (node.unavailable_attempts >= MAX_UNAVAILABLE_ATTEMPTS) throw new ControllerError(`Node exceeded the ${MAX_UNAVAILABLE_ATTEMPTS}-attempt unavailable budget: ${nodeId}`);
}

async function readJson(filePath, { label = 'JSON input', maxBytes = MAX_MANIFEST_BYTES } = {}) {
  try {
    const metadata = await fs.stat(filePath);
    if (!metadata.isFile()) throw new ControllerError(`${label} is not a regular file: ${filePath}`);
    if (metadata.size > maxBytes) throw new ControllerError(`${label} exceeds the ${maxBytes}-byte limit: ${filePath}`);
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') throw new ControllerError(`${label} does not exist: ${filePath}`);
    if (error instanceof SyntaxError) throw new ControllerError(`Invalid JSON in ${label}: ${error.message}`);
    throw error;
  }
}

// A short random suffix leaves room for durable quarantine names on Windows;
// `wx` keeps an improbable collision explicit rather than overwriting data.
function atomicTemporaryPath(filePath, nonce = randomUUID()) { return `${filePath}.${nonce.replaceAll('-', '').slice(0, 8)}.tmp`; }

async function atomicWrite(filePath, value, maxBytes = MAX_STATE_BYTES, { parentAuthority } = {}) {
  if (!parentAuthority) throw new ControllerError(`Atomic write requires a caller-verified parent authority: ${filePath}`);
  if (!sameStatePath(parentAuthority.path, path.dirname(filePath))) throw new ControllerError(`Atomic write parent authority does not match target: ${filePath}`);
  const parent = parentAuthority;
  const temporary = atomicTemporaryPath(filePath);
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(serialized, 'utf8') > maxBytes) throw new ControllerError(`State exceeds the ${maxBytes}-byte limit: ${filePath}`);
  let handle; let temporaryIdentity = null;
  try {
    handle = await fs.open(temporary, 'wx');
    temporaryIdentity = persistentFileObjectIdentity(await handle.stat({ bigint: true }));
    await verifyRegularDirectorySnapshot(parent, 'Atomic write parent');
    await handle.writeFile(serialized, 'utf8');
    await handle.sync();
    await handle.close(); handle = null;
    await verifyRegularDirectorySnapshot(parent, 'Atomic write parent');
    await verifyOwnedFile(temporary, temporaryIdentity, 'Atomic write temporary');
    await fs.rename(temporary, filePath);
    await verifyRegularDirectorySnapshot(parent, 'Atomic write parent');
    await verifyOwnedFile(filePath, temporaryIdentity, 'Atomic write target');
    handle = await fs.open(filePath, 'r+');
    await handle.sync();
    if (process.platform !== 'win32') {
      const directoryHandle = await fs.open(path.dirname(filePath), 'r');
      try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
    }
  } catch (error) {
    await handle?.close(); handle = null;
    await unlinkOwnedFile(temporary, temporaryIdentity);
    throw error;
  } finally {
    await handle?.close();
  }
}

function statePath(stateDir, taskId) {
  requiredIdentifier(taskId, 'task_id');
  return path.join(path.resolve(stateDir), `${taskId}.json`);
}

function databasePath(filePath) {
  if (!filePath.endsWith('.json')) throw new ControllerError(`Invalid logical task state path: ${filePath}`);
  return `${filePath.slice(0, -'.json'.length)}${SQLITE_STATE_SUFFIX}`;
}

async function stateExists(filePath) {
  if (await taskStateExists(databasePath(filePath))) return true;
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function writeState(filePath, state, { parentAuthority = null } = {}) {
  const authority = parentAuthority ?? await stateParentAuthorityForState(state, filePath);
  await verifyRegularDirectorySnapshot(authority, 'Controller state parent');
  let legacyStateExists = false;
  try {
    const legacyState = await fs.stat(filePath);
    if (!legacyState.isFile()) throw new ControllerError(`Legacy controller state is not a regular file: ${filePath}`);
    legacyStateExists = true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (legacyStateExists) {
    try {
      const archive = await fs.stat(`${filePath}.legacy`);
      if (!archive.isFile()) throw new ControllerError(`Legacy controller archive is not a regular file: ${filePath}.legacy`);
      throw new ControllerError(`Both legacy controller state and archive exist; resolve migration manually: ${filePath}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  await writeTaskState(databasePath(filePath), state, { parentAuthority: authority });
  // A legacy file is retained as an immutable recovery copy after the SQLite commit succeeds.
  if (legacyStateExists) {
    try { await fs.rename(filePath, `${filePath}.legacy`); }
    catch (error) {
      if (error.code !== 'ENOENT') throw new ControllerError(`SQLite state committed but legacy state could not be archived: ${filePath}: ${error.message}`);
    }
  }
}

async function deleteState(filePath, { parentAuthority } = {}) {
  if (!parentAuthority) throw new ControllerError(`Controller state deletion requires a caller-verified parent authority: ${filePath}`);
  await verifyRegularDirectorySnapshot(parentAuthority, 'Controller state parent');
  const taskId = path.basename(filePath, '.json');
  if (/^[A-Za-z][A-Za-z0-9._-]{0,79}$/.test(taskId)) {
    // Remove review evidence first; if this fails, keep the task indexable for a later sweep.
    await fs.rm(path.join(path.dirname(filePath), REVIEW_ARTIFACT_DIRECTORY, taskId), { recursive: true, force: true });
  }
  await deleteTaskState(databasePath(filePath), { parentAuthority });
  for (const suffix of ['', '.legacy']) {
    await fs.unlink(`${filePath}${suffix}`).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}


async function canonicalWorkspace(workspaceValue) {
  const requested = path.resolve(requiredString(workspaceValue, 'workspace'));
  let workspace;
  try { workspace = await fs.realpath(requested); } catch { throw new ControllerError(`Workspace is not a directory: ${requested}`); }
  let metadata;
  try { metadata = await fs.stat(workspace); } catch { throw new ControllerError(`Workspace is not a directory: ${workspace}`); }
  if (!metadata.isDirectory()) throw new ControllerError(`Workspace is not a directory: ${workspace}`);
  return workspace;
}

function workspaceLeasePath(workspace) {
  return path.join(workspace, '.codex', 'workflow-controller', 'workspace-lease.json');
}

async function readJsonSnapshot(filePath, { label = 'JSON input', maxBytes = MAX_MANIFEST_BYTES } = {}) {
  let handle;
  let verificationHandle;
  try {
    const pathMetadataBefore = await fs.lstat(filePath, { bigint: true });
    if (pathMetadataBefore.isSymbolicLink() || !pathMetadataBefore.isFile()) throw new ControllerError(`${label} is not a regular file: ${filePath}`);
    handle = await fs.open(filePath, 'r');
    const handleMetadataBefore = await handle.stat({ bigint: true });
    const handleObjectBefore = persistentFileObjectIdentity(handleMetadataBefore);
    const pathObjectBefore = persistentFileObjectIdentity(pathMetadataBefore);
    if (!handleMetadataBefore.isFile() || !sameFileObjectIdentity(pathObjectBefore, handleObjectBefore)) throw new ControllerError(`${label} changed while it was opened: ${filePath}`);
    if (handleMetadataBefore.size > maxBytes) throw new ControllerError(`${label} exceeds the ${maxBytes}-byte limit: ${filePath}`);
    const text = await handle.readFile('utf8');
    const handleMetadataAfter = await handle.stat({ bigint: true });
    const handleObjectAfter = persistentFileObjectIdentity(handleMetadataAfter);
    const pathMetadataAfter = await fs.lstat(filePath, { bigint: true });
    const pathObjectAfter = persistentFileObjectIdentity(pathMetadataAfter);
    if (pathMetadataAfter.isSymbolicLink() || !pathMetadataAfter.isFile()
      || !sameFileObjectIdentity(handleObjectBefore, handleObjectAfter)
      || !sameFileObjectIdentity(handleObjectAfter, pathObjectAfter)
      || handleMetadataBefore.size !== handleMetadataAfter.size
      || handleMetadataAfter.size !== pathMetadataAfter.size) throw new ControllerError(`${label} changed while it was read: ${filePath}`);

    verificationHandle = await fs.open(filePath, 'r');
    const verificationMetadataBefore = await verificationHandle.stat({ bigint: true });
    const verificationObjectBefore = persistentFileObjectIdentity(verificationMetadataBefore);
    if (!verificationMetadataBefore.isFile() || !sameFileObjectIdentity(handleObjectAfter, verificationObjectBefore)) throw new ControllerError(`${label} changed while it was verified: ${filePath}`);
    const verificationText = await verificationHandle.readFile('utf8');
    const verificationMetadataAfter = await verificationHandle.stat({ bigint: true });
    const verificationObjectAfter = persistentFileObjectIdentity(verificationMetadataAfter);
    const pathMetadataFinal = await fs.lstat(filePath, { bigint: true });
    const pathObjectFinal = persistentFileObjectIdentity(pathMetadataFinal);
    if (pathMetadataFinal.isSymbolicLink() || !pathMetadataFinal.isFile()
      || !sameFileObjectIdentity(verificationObjectBefore, verificationObjectAfter)
      || !sameFileObjectIdentity(verificationObjectAfter, pathObjectFinal)
      || verificationMetadataBefore.size !== verificationMetadataAfter.size
      || verificationMetadataAfter.size !== pathMetadataFinal.size
      || verificationText !== text) throw new ControllerError(`${label} changed while it was verified: ${filePath}`);
    return { value: JSON.parse(text), identity: fileIdentity(pathMetadataFinal), object_identity: pathObjectFinal };
  } catch (error) {
    if (error.code === 'ENOENT') throw new ControllerError(`${label} does not exist: ${filePath}`);
    if (error instanceof SyntaxError) throw new ControllerError(`Invalid JSON in ${label}: ${error.message}`);
    throw error;
  } finally {
    await verificationHandle?.close();
    await handle?.close();
  }
}

async function verifyJsonSnapshot(filePath, snapshot, label = 'JSON input') {
  const metadata = await fs.lstat(filePath, { bigint: true });
  if (metadata.isSymbolicLink() || !metadata.isFile() || !sameFileIdentity(snapshot.identity, metadata)) throw new ControllerError(`${label} changed after it was read: ${filePath}`);
}

function workspaceLeaseAuthorityPath(workspace) { return path.join(workspace, WORKSPACE_LEASE_AUTHORITY_FILENAME); }
function workspaceLeasePublicationIntentPath(workspace) { return `${workspaceLeaseAuthorityPath(workspace)}${WORKSPACE_LEASE_PUBLICATION_SUFFIX}`; }

function isControllerWorkspaceRootFile(name) {
  const key = workspacePathKey(name);
  const authority = workspacePathKey(WORKSPACE_LEASE_AUTHORITY_FILENAME);
  return key === authority || key.startsWith(`${authority}.`);
}

function exactFilesystemIdentity(metadata) {
  const dev = metadata?.dev;
  const ino = metadata?.ino;
  return {
    dev: typeof dev === 'bigint' ? dev.toString() : BigInt(dev).toString(),
    ino: typeof ino === 'bigint' ? ino.toString() : BigInt(ino).toString(),
  };
}
function workspaceDirectoryIdentity(metadata) { return exactFilesystemIdentity(metadata); }
function sameWorkspaceDirectoryIdentity(left, right) { return sameFileObjectIdentity(left, right); }
function validPersistentFileObjectIdentity(identity) {
  return identity && typeof identity === 'object' && !Array.isArray(identity)
    && hasExactFields(identity, new Set(['dev', 'ino']))
    && typeof identity.dev === 'string' && /^-?\d+$/u.test(identity.dev)
    && typeof identity.ino === 'string' && /^-?\d+$/u.test(identity.ino);
}

async function safeWorkspaceLeaseControlDirectory(workspace, { create = false } = {}) {
  const workspaceRealPath = await fs.realpath(workspace);
  const workspaceMetadata = await fs.lstat(workspaceRealPath, { bigint: true });
  if (workspaceMetadata.isSymbolicLink() || !workspaceMetadata.isDirectory()) throw new ControllerError(`Workspace authority root is not a regular directory: ${workspace}`);
  let current = workspaceRealPath;
  let createdControlDirectory = false;
  for (const segment of ['.codex', 'workflow-controller']) {
    current = path.join(current, segment);
    let metadata;
    try { metadata = await fs.lstat(current, { bigint: true }); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (!create) throw new ControllerError(`Workspace lease control directory does not exist: ${current}`);
      await fs.mkdir(current);
      if (segment === 'workflow-controller') createdControlDirectory = true;
      metadata = await fs.lstat(current, { bigint: true });
    }
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new ControllerError(`Workspace lease control path must not contain a symbolic link or reparse point: ${current}`);
    const realPath = await fs.realpath(current);
    if (!pathIsWithinPhysicalRoot(workspaceRealPath, realPath)) throw new ControllerError(`Workspace lease control path escapes the workspace: ${current}`);
  }
  const metadata = await fs.lstat(current, { bigint: true });
  return { workspace_real_path: workspaceRealPath, workspace_identity: workspaceDirectoryIdentity(workspaceMetadata), control_directory: current, control_real_path: await fs.realpath(current), control_identity: workspaceDirectoryIdentity(metadata), created_control_directory: createdControlDirectory };
}

async function snapshotRegularDirectory(directory, label) {
  const metadata = await fs.lstat(directory, { bigint: true });
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new ControllerError(`${label} is not a regular directory: ${directory}`);
  return { path: directory, real_path: await fs.realpath(directory), identity: workspaceDirectoryIdentity(metadata) };
}

async function verifyRegularDirectorySnapshot(snapshot, label) {
  const current = await snapshotRegularDirectory(snapshot.path, label);
  if (!sameStatePath(current.real_path, snapshot.real_path) || !sameWorkspaceDirectoryIdentity(current.identity, snapshot.identity)) {
    throw new ControllerError(`${label} changed: ${snapshot.path}`);
  }
}

function validStateParentAuthority(value, filePath) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && hasExactFields(value, new Set(['path', 'real_path', 'identity']))
    && typeof value.path === 'string' && path.isAbsolute(value.path)
    && typeof value.real_path === 'string' && path.isAbsolute(value.real_path)
    && validPersistentFileObjectIdentity(value.identity)
    && sameStatePath(value.path, path.dirname(filePath));
}

function sameStateParentAuthority(left, right) {
  return validPersistentFileObjectIdentity(left?.identity)
    && validPersistentFileObjectIdentity(right?.identity)
    && sameStatePath(left.path, right.path)
    && sameStatePath(left.real_path, right.real_path)
    && sameWorkspaceDirectoryIdentity(left.identity, right.identity);
}

async function stateParentAuthorityForState(state, filePath) {
  if (!state?.workspace_lease) throw new ControllerError(`Task state has no workspace lease parent authority; controlled recovery is required: ${filePath}`);
  const stored = state.workspace_lease?.state_parent_authority;
  if (stored === undefined) throw new ControllerError(`Task state parent authority is missing; controlled recovery is required: ${filePath}`);
  if (!validStateParentAuthority(stored, filePath)) throw new ControllerError(`Invalid task state parent authority: ${filePath}`);
  return stored;
}

async function attachStateParentAuthority(state, filePath, parentAuthority = null) {
  const authority = parentAuthority ?? await stateParentAuthorityForState(state, filePath);
  if (!validStateParentAuthority(authority, filePath)) throw new ControllerError(`Invalid task state parent authority: ${filePath}`);
  const stored = await stateParentAuthorityForState(state, filePath);
  if (!sameStateParentAuthority(stored, authority)) throw new ControllerError(`Task state parent authority changed: ${filePath}`);
  return authority;
}

function workspaceLeaseAuthorityRecord(workspace, control, { registryIdentity = null, createdAt = utcNow(), registryBoundAt = null } = {}) {
  return {
    version: WORKSPACE_LEASE_AUTHORITY_VERSION,
    workspace,
    workspace_identity: control.workspace_identity,
    control_directory: control.control_directory,
    control_real_path: control.control_real_path,
    control_identity: control.control_identity,
    registry_path: workspaceLeasePath(workspace),
    registry_initialized: registryIdentity !== null,
    registry_identity: registryIdentity,
    registry_bound_at: registryIdentity === null ? null : registryBoundAt ?? utcNow(),
    created_at: createdAt,
  };
}

function workspaceLeaseControlMatches(record, control) {
  return sameWorkspaceDirectoryIdentity(record.workspace_identity, control.workspace_identity)
    && sameWorkspaceDirectoryIdentity(record.control_identity, control.control_identity)
    && sameStatePath(record.control_directory, control.control_directory)
    && sameStatePath(record.control_real_path, control.control_real_path);
}

function workspaceLeaseControlFromRecord(record) {
  return {
    workspace_identity: record.workspace_identity,
    control_directory: record.control_directory,
    control_real_path: record.control_real_path,
    control_identity: record.control_identity,
  };
}

function validateWorkspaceLeaseAuthorityRecord(record, workspace, authorityPath) {
  const baseFields = ['version', 'workspace', 'workspace_identity', 'control_directory', 'control_real_path', 'control_identity', 'registry_path', 'created_at'];
  const fields = record?.version === LEGACY_WORKSPACE_LEASE_AUTHORITY_VERSION
    ? new Set(baseFields)
    : new Set([...baseFields, 'registry_initialized', 'registry_identity', 'registry_bound_at']);
  const supportedVersion = record?.version === LEGACY_WORKSPACE_LEASE_AUTHORITY_VERSION || record?.version === WORKSPACE_LEASE_AUTHORITY_VERSION;
  const validRegistryBinding = record?.version === LEGACY_WORKSPACE_LEASE_AUTHORITY_VERSION || (
    typeof record.registry_initialized === 'boolean'
    && (record.registry_initialized
      ? validPersistentFileObjectIdentity(record.registry_identity) && validTimestamp(record.registry_bound_at)
      : record.registry_identity === null && record.registry_bound_at === null)
  );
  if (!hasExactFields(record, fields) || !supportedVersion || !validRegistryBinding || record.workspace !== workspace || record.registry_path !== workspaceLeasePath(workspace)
    || record.control_directory !== path.dirname(record.registry_path) || typeof record.control_real_path !== 'string' || !path.isAbsolute(record.control_real_path)
    || !sameStatePath(record.control_real_path, record.control_directory) || !validTimestamp(record.created_at)
    || !validPersistentFileObjectIdentity(record.workspace_identity)
    || !validPersistentFileObjectIdentity(record.control_identity)) {
    throw new ControllerError(`Unsupported workspace lease authority: ${authorityPath}`);
  }
}

async function readWorkspaceLeaseAuthority(workspace) {
  const authorityPath = workspaceLeaseAuthorityPath(workspace);
  const snapshot = await readJsonSnapshot(authorityPath, { label: 'Workspace lease authority', maxBytes: MAX_MANIFEST_BYTES });
  const record = snapshot.value;
  validateWorkspaceLeaseAuthorityRecord(record, workspace, authorityPath);
  const control = await safeWorkspaceLeaseControlDirectory(workspace);
  if (!workspaceLeaseControlMatches(record, control)) throw new ControllerError(`Workspace lease control directory identity changed: ${record.control_directory}`);
  return { authority_path: authorityPath, authority_identity: snapshot.identity, record };
}

async function verifyWorkspaceLeaseAuthoritySnapshot(snapshot) {
  const metadata = await fs.lstat(snapshot.authority_path, { bigint: true });
  if (metadata.isSymbolicLink() || !metadata.isFile() || !sameFileIdentity(snapshot.authority_identity, metadata)) throw new ControllerError(`Workspace lease authority changed: ${snapshot.authority_path}`);
  const current = await readWorkspaceLeaseAuthority(snapshot.record.workspace);
  if (!sameJson(current.record, snapshot.record)) throw new ControllerError(`Workspace lease authority changed: ${snapshot.authority_path}`);
}

function validateWorkspaceLeasePublicationIntent(intent, workspace) {
  const authorityPath = workspaceLeaseAuthorityPath(workspace);
  const fields = new Set(['version', 'workspace', 'authority_path', 'registry_path', 'prior_authority', 'lease']);
  if (!hasExactFields(intent, fields) || intent.version !== 1 || intent.workspace !== workspace || intent.authority_path !== authorityPath
    || intent.registry_path !== workspaceLeasePath(workspace)) throw new ControllerError(`Unsupported workspace lease publication intent: ${workspaceLeasePublicationIntentPath(workspace)}`);
  validateWorkspaceLeaseAuthorityRecord(intent.prior_authority, workspace, authorityPath);
  if (intent.prior_authority.version !== WORKSPACE_LEASE_AUTHORITY_VERSION || !intent.lease || typeof intent.lease !== 'object' || Array.isArray(intent.lease)) {
    throw new ControllerError(`Unsupported workspace lease publication intent: ${workspaceLeasePublicationIntentPath(workspace)}`);
  }
}

async function unlinkOwnedFile(filePath, identity) {
  try {
    const metadata = await fs.lstat(filePath, { bigint: true });
    if (metadata.isSymbolicLink() || !metadata.isFile() || (identity && !sameFileObjectIdentity(identity, persistentFileObjectIdentity(metadata)))) return false;
    await fs.unlink(filePath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function verifyOwnedFile(filePath, identity, label) {
  const metadata = await fs.lstat(filePath, { bigint: true });
  if (metadata.isSymbolicLink() || !metadata.isFile() || !sameFileObjectIdentity(identity, persistentFileObjectIdentity(metadata))) {
    throw new ControllerError(`${label} changed: ${filePath}`);
  }
}

async function recoverWorkspaceLeasePublication(workspace, { authorityParent } = {}) {
  if (!authorityParent) throw new ControllerError(`Workspace lease publication recovery requires a caller-verified authority parent: ${workspace}`);
  await verifyRegularDirectorySnapshot(authorityParent, 'Workspace authority parent');
  const intentPath = workspaceLeasePublicationIntentPath(workspace);
  let snapshot;
  try { snapshot = await readJsonSnapshot(intentPath, { label: 'Workspace lease publication intent', maxBytes: MAX_MANIFEST_BYTES }); }
  catch (error) { if (error instanceof ControllerError && error.message.startsWith('Workspace lease publication intent does not exist:')) return; throw error; }
  const intent = snapshot.value;
  validateWorkspaceLeasePublicationIntent(intent, workspace);
  const current = await readWorkspaceLeaseAuthority(workspace);
  let registrySnapshot;
  try { registrySnapshot = await readJsonSnapshot(intent.registry_path, { label: 'Workspace lease', maxBytes: MAX_MANIFEST_BYTES }); }
  catch (error) {
    if (error instanceof ControllerError && error.message.startsWith('Workspace lease does not exist:')) return;
    throw error;
  }
  await validateWorkspaceLease(registrySnapshot.value, intent.registry_path);
  if (!sameJson(registrySnapshot.value, intent.lease)) {
    // An interruption before registry publication leaves a harmless intent.
    // A substituted registry remains fail-closed.
    if (sameJson(current.record, intent.prior_authority) && current.record.registry_initialized
      && sameFileObjectIdentity(current.record.registry_identity, registrySnapshot.object_identity)) {
      await unlinkOwnedFile(intentPath, snapshot.object_identity);
      return;
    }
    throw new ControllerError(`Workspace lease publication intent does not match the current registry: ${intentPath}`);
  }
  if (sameJson(current.record, intent.prior_authority)) {
    const record = workspaceLeaseAuthorityRecord(workspace, workspaceLeaseControlFromRecord(current.record), {
      registryIdentity: registrySnapshot.object_identity,
      createdAt: current.record.created_at,
      registryBoundAt: utcNow(),
    });
    await verifyWorkspaceLeaseAuthoritySnapshot(current);
    await atomicWrite(intent.authority_path, record, MAX_MANIFEST_BYTES, { parentAuthority: authorityParent });
  } else if (!current.record.registry_initialized || !sameFileObjectIdentity(current.record.registry_identity, registrySnapshot.object_identity)) {
    throw new ControllerError(`Workspace lease publication intent does not match the current authority or registry: ${intentPath}`);
  }
  await unlinkOwnedFile(intentPath, snapshot.object_identity);
}

async function workspaceLeaseRegistryIdentity(leasePath) {
  const metadata = await fs.lstat(leasePath, { bigint: true });
  if (metadata.isSymbolicLink() || !metadata.isFile()) throw new ControllerError(`Workspace lease is not a regular registry file: ${leasePath}`);
  const identity = persistentFileObjectIdentity(metadata);
  if (!validPersistentFileObjectIdentity(identity)) throw new ControllerError(`Workspace lease registry has no stable file identity: ${leasePath}`);
  return identity;
}

async function verifyWorkspaceLeaseRegistryBinding(snapshot, { allowUninitializedMissing = false } = {}) {
  const record = snapshot.record;
  if (record.version !== WORKSPACE_LEASE_AUTHORITY_VERSION) throw new ControllerError(`Workspace lease authority requires explicit migration: ${snapshot.authority_path}`);
  let identity;
  try { identity = await workspaceLeaseRegistryIdentity(record.registry_path); }
  catch (error) {
    if (error.code === 'ENOENT' && !record.registry_initialized && allowUninitializedMissing) return;
    if (error.code === 'ENOENT') throw new ControllerError(`Workspace lease registry is missing after initialization: ${record.registry_path}`);
    throw error;
  }
  if (!record.registry_initialized) throw new ControllerError(`Workspace lease registry exists without an initialized authority binding: ${record.registry_path}`);
  if (!sameFileObjectIdentity(record.registry_identity, identity)) throw new ControllerError(`Workspace lease registry identity changed: ${record.registry_path}`);
}

async function migrateWorkspaceLeaseAuthority(snapshot, { authorityParent } = {}) {
  if (!authorityParent) throw new ControllerError(`Workspace lease authority migration requires a caller-verified authority parent: ${snapshot.authority_path}`);
  await verifyRegularDirectorySnapshot(authorityParent, 'Workspace authority parent');
  await verifyWorkspaceLeaseAuthoritySnapshot(snapshot);
  const control = await safeWorkspaceLeaseControlDirectory(snapshot.record.workspace);
  if (!workspaceLeaseControlMatches(snapshot.record, control)) throw new ControllerError(`Workspace lease control directory identity changed during authority migration: ${snapshot.record.control_directory}`);
  const registryIdentity = await workspaceLeaseRegistryIdentity(snapshot.record.registry_path);
  const record = workspaceLeaseAuthorityRecord(snapshot.record.workspace, workspaceLeaseControlFromRecord(snapshot.record), {
    registryIdentity,
    createdAt: snapshot.record.created_at,
    registryBoundAt: utcNow(),
  });
  await verifyWorkspaceLeaseAuthoritySnapshot(snapshot);
  await atomicWrite(snapshot.authority_path, record, MAX_MANIFEST_BYTES, { parentAuthority: authorityParent });
  return readWorkspaceLeaseAuthority(snapshot.record.workspace);
}

async function ensureWorkspaceLeaseAuthority(workspace, { allowCreate = false, allowMigration = false, authorityParent = null } = {}) {
  try {
    const current = await readWorkspaceLeaseAuthority(workspace);
    if (current.record.version === LEGACY_WORKSPACE_LEASE_AUTHORITY_VERSION) {
      if (!allowMigration) throw new ControllerError(`Workspace lease authority requires explicit migration: ${current.authority_path}`);
      return migrateWorkspaceLeaseAuthority(current, { authorityParent });
    }
    return current;
  }
  catch (error) {
    if (!(error instanceof ControllerError && (error.message.startsWith('JSON input does not exist:') || error.message.startsWith('Workspace lease authority does not exist:'))) && error.code !== 'ENOENT') throw error;
    if (!allowCreate) throw new ControllerError(`Workspace lease authority does not exist: ${workspaceLeaseAuthorityPath(workspace)}`);
  }
  if (!authorityParent) throw new ControllerError(`Workspace lease authority creation requires a caller-verified authority parent: ${workspaceLeaseAuthorityPath(workspace)}`);
  await verifyRegularDirectorySnapshot(authorityParent, 'Workspace authority parent');
  const control = await safeWorkspaceLeaseControlDirectory(workspace, { create: true });
  const leasePath = workspaceLeasePath(workspace);
  let registryExists = false;
  try {
    const metadata = await fs.lstat(leasePath);
    if (metadata.isSymbolicLink() || !metadata.isFile()) throw new ControllerError(`Workspace lease is not a regular registry file: ${leasePath}`);
    registryExists = true;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (registryExists) {
    const existingRegistry = await readJsonSnapshot(leasePath, { label: 'Workspace lease', maxBytes: MAX_MANIFEST_BYTES });
    if (existingRegistry.value?.version !== 1) {
      throw new ControllerError(`Cannot create workspace lease authority for an existing non-legacy registry: ${leasePath}`);
    }
    await validateLegacyWorkspaceLeaseForAuthority(existingRegistry.value, workspace, leasePath);
  }
  if (!control.created_control_directory && !registryExists) throw new ControllerError(`Cannot create workspace lease authority for an existing control directory without a registry: ${control.control_directory}`);
  const registryIdentity = registryExists ? await workspaceLeaseRegistryIdentity(leasePath) : null;
  await atomicWrite(workspaceLeaseAuthorityPath(workspace), workspaceLeaseAuthorityRecord(workspace, control, { registryIdentity }), MAX_MANIFEST_BYTES, { parentAuthority: authorityParent });
  return readWorkspaceLeaseAuthority(workspace);
}

async function withWorkspaceLeaseLock(workspace, callback, { allowAuthorityMigration = false } = {}) {
  const authorityPath = workspaceLeaseAuthorityPath(workspace);
  const authorityParent = await snapshotRegularDirectory(path.dirname(authorityPath), 'Workspace authority parent');
  return withStateLock(authorityPath, async () => {
    await verifyRegularDirectorySnapshot(authorityParent, 'Workspace authority parent');
    await recoverWorkspaceLeasePublication(workspace, { authorityParent });
    const authority = await ensureWorkspaceLeaseAuthority(workspace, { allowCreate: allowAuthorityMigration, allowMigration: allowAuthorityMigration, authorityParent });
    const control = await safeWorkspaceLeaseControlDirectory(workspace);
    const context = {
      authority,
      parent_authorities: {
        authority: authorityParent,
        registry: { path: control.control_directory, real_path: control.control_real_path, identity: control.control_identity },
      },
    };
    const leasePath = workspaceLeasePath(workspace);
    return withStateLock(leasePath, async () => {
      await verifyWorkspaceLeaseAuthoritySnapshot(context.authority);
      await verifyWorkspaceLeaseRegistryBinding(context.authority, { allowUninitializedMissing: true });
      const result = await callback(leasePath, context);
      await verifyWorkspaceLeaseAuthoritySnapshot(context.authority);
      await verifyWorkspaceLeaseRegistryBinding(context.authority, { allowUninitializedMissing: true });
      return result;
    }, { createParent: false });
  }, { createParent: false });
}

async function writeWorkspaceLeaseRegistry(context, leasePath, lease) {
  await verifyWorkspaceLeaseAuthoritySnapshot(context.authority);
  await verifyWorkspaceLeaseRegistryBinding(context.authority, { allowUninitializedMissing: true });
  const prior = context.authority.record;
  const control = await safeWorkspaceLeaseControlDirectory(prior.workspace);
  if (!workspaceLeaseControlMatches(prior, control)) throw new ControllerError(`Workspace lease control directory identity changed during registry publication: ${prior.control_directory}`);
  await verifyRegularDirectorySnapshot(context.parent_authorities.authority, 'Workspace authority parent');
  await verifyRegularDirectorySnapshot(context.parent_authorities.registry, 'Workspace lease parent');
  await verifyWorkspaceLeaseAuthoritySnapshot(context.authority);
  const intentPath = workspaceLeasePublicationIntentPath(prior.workspace);
  const publicationIntent = {
    version: 1, workspace: prior.workspace, authority_path: context.authority.authority_path, registry_path: leasePath,
    prior_authority: prior,
    lease,
  };
  // The durable intent contains the exact registry payload. After a crash we
  // can bind the newly published file object to the still-authoritative record.
  await atomicWrite(intentPath, publicationIntent, MAX_MANIFEST_BYTES, { parentAuthority: context.parent_authorities.authority });
  await atomicWrite(leasePath, lease, MAX_MANIFEST_BYTES, { parentAuthority: context.parent_authorities.registry });
  const snapshot = await readJsonSnapshot(leasePath, { label: 'Workspace lease', maxBytes: MAX_MANIFEST_BYTES });
  await validateWorkspaceLease(snapshot.value, leasePath);
  if (!sameJson(snapshot.value, lease)) throw new ControllerError(`Workspace lease changed after write: ${leasePath}`);
  const record = workspaceLeaseAuthorityRecord(prior.workspace, workspaceLeaseControlFromRecord(prior), {
    registryIdentity: snapshot.object_identity,
    createdAt: prior.created_at,
    registryBoundAt: utcNow(),
  });
  await atomicWrite(context.authority.authority_path, record, MAX_MANIFEST_BYTES, { parentAuthority: context.parent_authorities.authority });
  context.authority = await readWorkspaceLeaseAuthority(prior.workspace);
  await verifyWorkspaceLeaseAuthoritySnapshot(context.authority);
  await verifyWorkspaceLeaseRegistryBinding(context.authority);
  const intentSnapshot = await readJsonSnapshot(intentPath, { label: 'Workspace lease publication intent', maxBytes: MAX_MANIFEST_BYTES });
  await unlinkOwnedFile(intentPath, intentSnapshot.object_identity);
}

function workspacePathKey(value) {
  // Windows and the default macOS volumes are case-insensitive.  Treating
  // those platforms conservatively also avoids Unicode-normalization aliases.
  const normalized = value.normalize('NFC');
  return process.platform === 'linux' ? normalized : normalized.toLocaleLowerCase('und');
}

function claimSegments(prefix) { return prefix === '.' ? [] : prefix.split('/'); }

function isWindowsReservedClaimSegment(segment) {
  if (process.platform !== 'win32') return false;
  if (/[\u0000-\u001f\u007f<>:"|?*]/u.test(segment) || /[. ]$/u.test(segment)) return true;
  const base = segment.split('.', 1)[0].toLocaleLowerCase('und').replace(/[¹²³]/gu, digit => ({ '¹': '1', '²': '2', '³': '3' })[digit]);
  return /^(con|prn|aux|nul|conin\$|conout\$|com[1-9]|lpt[1-9])$/u.test(base);
}

function isUnsafeWorkspaceClaimPrefix(prefix) {
  return process.platform === 'win32' && claimSegments(prefix).some(isWindowsReservedClaimSegment);
}

function isClaimAncestor(ancestor, descendant) {
  if (ancestor === '.') return true;
  const left = claimSegments(ancestor); const right = claimSegments(descendant);
  return left.length <= right.length && left.every((segment, index) => workspacePathKey(segment) === workspacePathKey(right[index]));
}

async function assertClaimDoesNotTraverseLink(workspace, prefix) {
  let current = workspace;
  for (const segment of claimSegments(prefix)) {
    current = path.join(current, segment);
    let metadata;
    try { metadata = await fs.lstat(current); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (metadata.isSymbolicLink()) throw new ControllerError(`workspace_claims cannot traverse a symbolic link or reparse point: ${prefix}`);
  }
}

async function normalizeWorkspaceClaims(rawClaims, workspace, { legacy = false } = {}) {
  const input = rawClaims === undefined || rawClaims === null
    ? (legacy ? [{ mode: 'write', prefix: '.' }] : null)
    : rawClaims;
  if (!Array.isArray(input) || !input.length) throw new ControllerError('workspace_claims must be a non-empty array');
  if (input.length > MAX_WORKSPACE_CLAIMS) throw new ControllerError(`workspace_claims exceeds the ${MAX_WORKSPACE_CLAIMS}-claim limit`);
  const byPrefix = new Map();
  for (const claim of input) {
    if (!claim || typeof claim !== 'object' || Array.isArray(claim) || Object.keys(claim).length !== 2 || !WORKSPACE_CLAIM_MODES.has(claim.mode) || typeof claim.prefix !== 'string') {
      throw new ControllerError('Each workspace_claim must be exactly {mode:"read"|"write",prefix:"workspace-relative POSIX segment prefix"}');
    }
    const prefix = claim.prefix;
    if (prefix.length > MAX_WORKSPACE_CLAIM_PREFIX_LENGTH) throw new ControllerError(`workspace_claim prefix exceeds the ${MAX_WORKSPACE_CLAIM_PREFIX_LENGTH}-character limit`);
    if (!prefix || prefix.includes('\0') || prefix.includes('\\') || path.posix.isAbsolute(prefix) || path.win32.isAbsolute(prefix) || prefix.endsWith('/') || prefix.split('/').some(segment => !segment || segment === '.' || segment === '..')) {
      if (prefix !== '.') throw new ControllerError(`Invalid workspace_claim prefix: ${prefix}`);
    }
    if (prefix !== '.' && (prefix === '.' || prefix.includes('/./') || prefix.startsWith('./') || prefix.endsWith('/.'))) throw new ControllerError(`Invalid workspace_claim prefix: ${prefix}`);
    if (isUnsafeWorkspaceClaimPrefix(prefix)) throw new ControllerError(`workspace_claim prefix has an unsafe Windows path alias: ${prefix}`);
    const first = claimSegments(prefix)[0];
    if (first && (isIgnoredFingerprintDirectory(first) || isControllerWorkspaceRootFile(first))) throw new ControllerError(`workspace_claims cannot include ignored or controller directory: ${prefix}`);
    await assertClaimDoesNotTraverseLink(workspace, prefix);
    const key = workspacePathKey(prefix);
    const existing = byPrefix.get(key);
    if (!existing || claim.mode === 'write') byPrefix.set(key, { mode: claim.mode, prefix });
  }
  const ordered = [...byPrefix.values()].sort((left, right) => workspacePathKey(left.prefix).localeCompare(workspacePathKey(right.prefix)) || left.mode.localeCompare(right.mode));
  return ordered.filter((claim, index) => !ordered.some((other, otherIndex) => otherIndex !== index && other.mode === claim.mode && isClaimAncestor(other.prefix, claim.prefix)));
}

function legacyWorkspaceClaims() { return [{ mode: 'write', prefix: '.' }]; }

function normalizeStoredWorkspaceClaims(rawClaims, { legacy = false } = {}) {
  const input = rawClaims === undefined || rawClaims === null ? (legacy ? legacyWorkspaceClaims() : null) : rawClaims;
  if (!Array.isArray(input) || !input.length) throw new ControllerError('workspace_claims must be a non-empty array');
  if (input.length > MAX_WORKSPACE_CLAIMS) throw new ControllerError(`workspace_claims exceeds the ${MAX_WORKSPACE_CLAIMS}-claim limit`);
  const byPrefix = new Map();
  for (const claim of input) {
    if (!claim || typeof claim !== 'object' || Array.isArray(claim) || Object.keys(claim).length !== 2 || !WORKSPACE_CLAIM_MODES.has(claim.mode) || typeof claim.prefix !== 'string') throw new ControllerError('Invalid stored workspace_claims');
    const prefix = claim.prefix;
    if (prefix.length > MAX_WORKSPACE_CLAIM_PREFIX_LENGTH) throw new ControllerError(`workspace_claim prefix exceeds the ${MAX_WORKSPACE_CLAIM_PREFIX_LENGTH}-character limit`);
    if (!prefix || prefix.includes('\0') || prefix.includes('\\') || path.posix.isAbsolute(prefix) || path.win32.isAbsolute(prefix) || (prefix !== '.' && (prefix.endsWith('/') || prefix.split('/').some(segment => !segment || segment === '.' || segment === '..')))) throw new ControllerError(`Invalid stored workspace_claim prefix: ${prefix}`);
    if (isUnsafeWorkspaceClaimPrefix(prefix)) throw new ControllerError(`Stored workspace_claim prefix has an unsafe Windows path alias: ${prefix}`);
    const first = claimSegments(prefix)[0];
    if (first && (isIgnoredFingerprintDirectory(first) || isControllerWorkspaceRootFile(first))) throw new ControllerError(`Stored workspace_claim targets ignored or controller directory: ${prefix}`);
    const key = workspacePathKey(prefix); const existing = byPrefix.get(key);
    if (!existing || claim.mode === 'write') byPrefix.set(key, { mode: claim.mode, prefix });
  }
  const ordered = [...byPrefix.values()].sort((left, right) => workspacePathKey(left.prefix).localeCompare(workspacePathKey(right.prefix)) || left.mode.localeCompare(right.mode));
  const normalized = ordered.filter((claim, index) => !ordered.some((other, otherIndex) => otherIndex !== index && other.mode === claim.mode && isClaimAncestor(other.prefix, claim.prefix)));
  if (!sameJson(input, normalized)) throw new ControllerError('Stored workspace_claims are not normalized');
  return normalized;
}

async function sleep(milliseconds) { await new Promise(resolve => setTimeout(resolve, milliseconds)); }

async function lockDetails(lockPath) {
  const [text, metadata] = await Promise.all([fs.readFile(lockPath, 'utf8'), fs.stat(lockPath, { bigint: true })]);
  const values = Object.fromEntries(text.trim().split(/\s+/).map(part => part.split('=', 2)).filter(([key, value]) => key && value));
  return {
    lockPath,
    pid: Number(values.pid),
    hostname: values.hostname,
    created: values.created,
    createdMs: Date.parse(values.created),
    ageMs: Date.now() - Number(metadata.mtimeMs),
    identity: fileIdentity(metadata),
  };
}

function sameFileIdentity(expected, metadata) {
  const expectedIdentity = typeof expected?.mtimeNs === 'bigint' && typeof expected?.ctimeNs === 'bigint' ? fileIdentity(expected) : expected;
  const current = fileIdentity(metadata);
  return expectedIdentity?.dev === current.dev && expectedIdentity?.ino === current.ino
    && expectedIdentity?.size === current.size && expectedIdentity?.mtimeNs === current.mtimeNs && expectedIdentity?.ctimeNs === current.ctimeNs;
}

async function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

async function recoveryGuardExists(lockPath) {
  try { await fs.access(`${lockPath}.recover`); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function tryReclaimStaleCoordinationFile(intentPath, staleAfterSec = DEFAULT_STALE_LOCK_SEC) {
  let details;
  try { details = await lockDetails(intentPath); } catch (error) { if (error.code === 'ENOENT') return { reclaimed: false, reason: 'does not exist' }; throw error; }
  const staleAfterMs = positiveInteger(staleAfterSec, 'stale_after_sec', DEFAULT_STALE_LOCK_SEC) * 1000;
  if (!details.hostname || !Number.isSafeInteger(details.pid) || details.pid <= 0 || !Number.isFinite(details.createdMs) || Math.abs(Number(BigInt(details.identity.mtimeNs) / 1_000_000n) - details.createdMs) > 5_000) return { reclaimed: false, reason: 'untrusted metadata', details };
  if (details.hostname !== os.hostname()) return { reclaimed: false, reason: 'another host', details };
  if (details.ageMs < staleAfterMs) return { reclaimed: false, reason: 'younger than stale threshold', details };
  if (await processIsAlive(details.pid)) return { reclaimed: false, reason: 'owner is alive', details };
  let latestMetadata;
  try { latestMetadata = await fs.stat(intentPath, { bigint: true }); } catch (error) { if (error.code === 'ENOENT') return { reclaimed: false, reason: 'already removed' }; throw error; }
  if (!sameFileIdentity(details.identity, latestMetadata)) return { reclaimed: false, reason: 'changed while recovering', details };
  const recoveredPath = `${intentPath}.stale-${utcNow().replace(/[:.]/g, '-')}-${randomUUID()}`;
  try { await fs.rename(intentPath, recoveredPath); }
  catch (error) { if (error.code === 'ENOENT') return { reclaimed: false, reason: 'already removed' }; throw error; }
  return { reclaimed: true, recovered_path: recoveredPath, prior_lock: details };
}

async function acquireReclaimGuard(intentPath) {
  const guardPath = `${intentPath}.reclaim`;
  try {
    const handle = await fs.open(guardPath, 'wx');
    await handle.writeFile(`pid=${process.pid} hostname=${os.hostname()} created=${utcNow()}\n`);
    return { handle, guardPath };
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const recovered = await tryReclaimStaleCoordinationFile(guardPath);
    if (recovered.reclaimed) return acquireReclaimGuard(intentPath);
    return null;
  }
}

async function reclaimStaleCoordinationFile(intentPath, staleAfterSec = DEFAULT_STALE_LOCK_SEC) {
  const guard = await acquireReclaimGuard(intentPath);
  if (!guard) return { reclaimed: false, reason: 'recovery in progress' };
  try { return await tryReclaimStaleCoordinationFile(intentPath, staleAfterSec); }
  finally { await releaseIntent(guard.handle, guard.guardPath); }
}

async function ensureNoRecoveryGuard(lockPath) {
  if (!await recoveryGuardExists(lockPath)) return;
  const result = await reclaimStaleCoordinationFile(`${lockPath}.recover`);
  if (result.reclaimed || !await recoveryGuardExists(lockPath)) return;
  throw new ControllerError(`Task recovery is in progress: ${lockPath}`);
}

async function coordinationIntentExists(lockPath) {
  for (const suffix of ['.writer', '.release']) {
    try { await fs.access(`${lockPath}${suffix}`); return true; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return false;
}

async function waitForRecoveryGuardRelease(lockPath, deadline) {
  while (await recoveryGuardExists(lockPath)) {
    const reclaimed = await reclaimStaleCoordinationFile(`${lockPath}.recover`);
    if (reclaimed.reclaimed) continue;
    if (Date.now() >= deadline) throw new ControllerError(`Task recovery is still in progress: ${lockPath}`);
    await sleep(25);
  }
}

async function waitForCoordinationIntents(lockPath, deadline) {
  while (await coordinationIntentExists(lockPath)) {
    for (const suffix of ['.writer', '.release']) await reclaimStaleCoordinationFile(`${lockPath}${suffix}`);
    if (!await coordinationIntentExists(lockPath)) return;
    if (Date.now() >= deadline) throw new ControllerError(`Lock turnover is still in progress: ${lockPath}`);
    await sleep(25);
  }
}

async function acquireIntent(intentPath, deadline) {
  let handle;
  while (!handle) {
    try { handle = await fs.open(intentPath, 'wx'); await handle.writeFile(`pid=${process.pid} hostname=${os.hostname()} created=${utcNow()}\n`); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const reclaimed = await reclaimStaleCoordinationFile(intentPath);
      if (reclaimed.reclaimed) continue;
      if (Date.now() >= deadline) throw new ControllerError(`Lock turnover is busy: ${intentPath}`);
      await sleep(25);
    }
  }
  return handle;
}

async function openHandleOwnsPath(handle, filePath) {
  try {
    const [handleMetadata, pathMetadata] = await Promise.all([handle.stat({ bigint: true }), fs.lstat(filePath, { bigint: true })]);
    return !pathMetadata.isSymbolicLink() && pathMetadata.isFile()
      && sameFileObjectIdentity(persistentFileObjectIdentity(handleMetadata), persistentFileObjectIdentity(pathMetadata));
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function closeAndUnlinkOwnedPath(handle, filePath) {
  const identity = persistentFileObjectIdentity(await handle.stat({ bigint: true }));
  const ownedBeforeClose = await openHandleOwnsPath(handle, filePath);
  await handle.close();
  if (!ownedBeforeClose) return false;
  let current;
  try { current = await fs.lstat(filePath, { bigint: true }); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  if (current.isSymbolicLink() || !current.isFile() || !sameFileObjectIdentity(identity, persistentFileObjectIdentity(current))) return false;
  await fs.unlink(filePath).catch(error => { if (error.code !== 'ENOENT') throw error; });
  return true;
}

async function releaseIntent(handle, intentPath) {
  await closeAndUnlinkOwnedPath(handle, intentPath);
}

async function acquireRecoveryGuard(lockPath) {
  const recoveryGuardPath = `${lockPath}.recover`;
  try {
    const handle = await fs.open(recoveryGuardPath, 'wx');
    await handle.writeFile(`pid=${process.pid} hostname=${os.hostname()} created=${utcNow()}\n`);
    return { handle, recoveryGuardPath };
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const reclaimed = await reclaimStaleCoordinationFile(recoveryGuardPath);
    if (reclaimed.reclaimed) return acquireRecoveryGuard(lockPath);
    throw new ControllerError(`Stale-lock recovery is already in progress: ${lockPath}`);
  }
}

async function recoverStaleLock(filePath, staleAfterSec, { parentAuthority = null } = {}) {
  if (parentAuthority) await verifyRegularDirectorySnapshot(parentAuthority, 'Controller state parent');
  const lockPath = `${filePath}.lock`;
  const { handle: recoveryGuard, recoveryGuardPath } = await acquireRecoveryGuard(lockPath);
  try {
    if (parentAuthority) await verifyRegularDirectorySnapshot(parentAuthority, 'Controller state parent');
    await waitForCoordinationIntents(lockPath, Date.now() + 10_000);
    let details;
    try { details = await lockDetails(lockPath); } catch (error) { if (error.code === 'ENOENT') return { recovered: false, reason: 'no lock exists' }; throw error; }
    const recovered = await reclaimStaleCoordinationFile(lockPath, staleAfterSec);
    if (!recovered.reclaimed) {
      if (recovered.reason === 'another host') throw new ControllerError(`Cannot prove a lock from another host is stale: ${lockPath}`);
      if (recovered.reason === 'younger than stale threshold') throw new ControllerError(`Lock is younger than stale_after_sec: ${lockPath}`);
      if (recovered.reason === 'owner is alive') throw new ControllerError(`Lock owner is still alive: ${lockPath}`);
      throw new ControllerError(`Cannot safely recover lock: ${lockPath} (${recovered.reason})`);
    }
    return { recovered: true, recovered_lock_path: recovered.recovered_path, prior_lock: details };
  } finally {
    await releaseIntent(recoveryGuard, recoveryGuardPath);
  }
}

async function withStateLock(filePath, callback, { createParent = true, parentAuthority = null } = {}) {
  if (parentAuthority) {
    if (!validStateParentAuthority(parentAuthority, filePath)) throw new ControllerError(`Invalid task state parent authority: ${filePath}`);
    await verifyRegularDirectorySnapshot(parentAuthority, 'Controller state parent');
  } else if (createParent) await fs.mkdir(path.dirname(filePath), { recursive: true });
  else {
    const parent = await fs.lstat(path.dirname(filePath));
    if (parent.isSymbolicLink() || !parent.isDirectory()) throw new ControllerError(`Lock parent is not a regular directory: ${path.dirname(filePath)}`);
  }
  const lockPath = `${filePath}.lock`;
  const deadline = Date.now() + 10_000;
  let handle;
  const writerIntentPath = `${lockPath}.writer`;
  const writerIntent = await acquireIntent(writerIntentPath, deadline);
  try {
    await ensureNoRecoveryGuard(lockPath);
    while (!handle) {
      try {
      handle = await fs.open(lockPath, 'wx');
      await handle.writeFile(`pid=${process.pid} hostname=${os.hostname()} created=${utcNow()}\n`);
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        await ensureNoRecoveryGuard(lockPath);
        if (Date.now() >= deadline) throw new ControllerError(`Task state is busy: ${filePath}`);
        await sleep(100);
      }
    }
  } finally {
    await releaseIntent(writerIntent, writerIntentPath);
  }
  try {
    if (parentAuthority) await verifyRegularDirectorySnapshot(parentAuthority, 'Controller state parent');
    return await callback();
  } finally {
    if (!await openHandleOwnsPath(handle, lockPath)) {
      await handle.close();
    } else {
      const releaseIntentPath = `${lockPath}.release`;
      let releaseHandle = await acquireIntent(releaseIntentPath, Date.now() + 10_000);
      try {
        while (await recoveryGuardExists(lockPath)) {
          await releaseIntent(releaseHandle, releaseIntentPath);
          releaseHandle = null;
          await waitForRecoveryGuardRelease(lockPath, Date.now() + 10_000);
          releaseHandle = await acquireIntent(releaseIntentPath, Date.now() + 10_000);
        }
        await closeAndUnlinkOwnedPath(handle, lockPath);
      } finally {
        if (releaseHandle) await releaseIntent(releaseHandle, releaseIntentPath);
      }
    }
  }
}

async function loadState(filePath) {
  let state = await readTaskState(databasePath(filePath));
  if (state === null) state = await readJson(filePath, { label: 'Controller state', maxBytes: MAX_STATE_BYTES });
  if (!state || typeof state !== 'object' || state.version !== VERSION) throw new ControllerError(`Unsupported controller state: ${filePath}`);
  if (state.workspace_lease?.state_path !== undefined) {
    const leasePath = await canonicalStatePath(state.workspace_lease.state_path, 'workspace_lease.state_path');
    if (!sameStatePath(leasePath, filePath)) throw new ControllerError(`workspace_lease.state_path does not identify this state: ${filePath}`);
    state.workspace_lease.state_path = leasePath;
  }
  return state;
}

function fileIdentity(metadata) {
  if (typeof metadata?.mtimeNs !== 'bigint' || typeof metadata?.ctimeNs !== 'bigint') {
    throw new ControllerError('File identity must be read with bigint filesystem metadata');
  }
  return {
    dev: metadata.dev.toString(),
    ino: metadata.ino.toString(),
    size: metadata.size.toString(),
    mtimeNs: metadata.mtimeNs.toString(),
    ctimeNs: metadata.ctimeNs.toString(),
  };
}

function persistentFileObjectIdentity(metadata) { return { dev: metadata.dev.toString(), ino: metadata.ino.toString() }; }
function normalizedFilesystemIdentityPart(value) {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string' && /^-?\d+$/u.test(value)) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value).toString();
  return null;
}
function sameFileObjectIdentity(left, right) {
  const leftDev = normalizedFilesystemIdentityPart(left?.dev); const rightDev = normalizedFilesystemIdentityPart(right?.dev);
  const leftIno = normalizedFilesystemIdentityPart(left?.ino); const rightIno = normalizedFilesystemIdentityPart(right?.ino);
  return leftDev !== null && rightDev !== null && leftIno !== null && rightIno !== null && leftDev === rightDev && leftIno === rightIno;
}

function addEvent(state, type, details = {}) {
  state.events ??= [];
  state.events.push({ at: utcNow(), type, ...details });
  state.updated_at = utcNow();
}

async function walkFiles(root, directory = root, files = []) {
  let entries;
  try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch (error) { throw new ControllerError(`Workspace is not a directory: ${root}`); }
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!isIgnoredFingerprintDirectory(entry.name)) await walkFiles(root, path.join(directory, entry.name), files);
    } else if (entry.isSymbolicLink()) {
      throw new ControllerError(`Workspace contains a symbolic link that cannot be fingerprinted safely: ${entryPath}`);
    } else if (entry.isFile()) {
      const relative = path.relative(root, path.join(directory, entry.name));
      if (path.dirname(relative) === '.' && isControllerWorkspaceRootFile(entry.name)) continue;
      files.push(relative);
      if (files.length > MAX_FINGERPRINT_FILES) throw new ControllerError(`Workspace exceeds the ${MAX_FINGERPRINT_FILES}-file fingerprint limit`);
    }
  }
  return files;
}

function isIgnoredFingerprintDirectory(name) {
  // Package-manager caches are derived download artifacts, like node_modules.
  // They may be populated while verification runs and must not invalidate a
  // source review or make the fingerprint traverse a large transient cache.
  const key = workspacePathKey(name);
  return [...IGNORED_DIRECTORIES].some(directory => workspacePathKey(directory) === key)
    || key === workspacePathKey('.yarn')
    || key.startsWith(workspacePathKey('.yarn-cache'));
}

class WorkspaceChangedDuringFingerprint extends Error {}

function fixedLength(value) {
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(value));
  return length;
}

function framedString(hash, value) {
  const bytes = Buffer.from(value, 'utf8');
  hash.update(fixedLength(bytes.length));
  hash.update(bytes);
}

function sameFingerprintMetadata(left, right) {
  return left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

async function fingerprintItem(root, relativePath) {
  const filePath = path.join(root, relativePath);
  const before = await fs.stat(filePath);
  if (!before.isFile()) throw new WorkspaceChangedDuringFingerprint(`File changed type while fingerprinting: ${filePath}`);
  if (before.size > MAX_FINGERPRINT_FILE_BYTES) throw new ControllerError(`Workspace file exceeds the ${MAX_FINGERPRINT_FILE_BYTES}-byte fingerprint limit: ${filePath}`);
  const item = createHash('sha256');
  framedString(item, 'file');
  framedString(item, relativePath.split(path.sep).join('/'));
  item.update(fixedLength(before.size));
  for await (const chunk of createReadStream(filePath)) item.update(chunk);
  const after = await fs.stat(filePath);
  if (!sameFingerprintMetadata(before, after)) throw new WorkspaceChangedDuringFingerprint(`File changed while fingerprinting: ${filePath}`);
  return { digest: item.digest(), bytes: before.size };
}

async function filesForWorkspaceClaims(workspace, claims) {
  const files = new Set();
  const missing = [];
  for (const claim of claims) {
    // Claims are persistent input and directory topology can change after init.
    await assertClaimDoesNotTraverseLink(workspace, claim.prefix);
    const relative = claim.prefix === '.' ? '' : claim.prefix.split('/').join(path.sep);
    const claimedPath = path.join(workspace, relative);
    let metadata;
    try { metadata = await fs.lstat(claimedPath); }
    catch (error) {
      if (error.code === 'ENOENT') { missing.push(claim.prefix); continue; }
      throw error;
    }
    if (metadata.isSymbolicLink()) throw new ControllerError(`Workspace claim became a symbolic link while fingerprinting: ${claim.prefix}`);
    if (metadata.isDirectory()) {
      for (const file of await walkFiles(workspace, claimedPath)) files.add(file);
    } else if (metadata.isFile()) {
      files.add(path.relative(workspace, claimedPath));
    } else {
      throw new ControllerError(`Workspace claim is not a regular file or directory: ${claim.prefix}`);
    }
  }
  return { files: [...files].sort((left, right) => left < right ? -1 : left > right ? 1 : 0), missing: [...new Set(missing)].sort((left, right) => workspacePathKey(left).localeCompare(workspacePathKey(right))) };
}

async function fingerprintAttempt(workspace, claims) {
  const before = await filesForWorkspaceClaims(workspace, claims);
  const files = before.files;
  const digest = createHash('sha256');
  framedString(digest, 'workspace-claims-v2');
  for (const claim of claims) { framedString(digest, claim.mode); framedString(digest, claim.prefix); }
  for (const prefix of before.missing) { framedString(digest, 'missing'); framedString(digest, prefix); }
  let totalBytes = 0;
  for (const relative of files) {
    const item = await fingerprintItem(workspace, relative);
    totalBytes += item.bytes;
    if (totalBytes > MAX_FINGERPRINT_TOTAL_BYTES) throw new ControllerError(`Workspace exceeds the ${MAX_FINGERPRINT_TOTAL_BYTES}-byte fingerprint limit`);
    digest.update(item.digest);
  }
  const after = await filesForWorkspaceClaims(workspace, claims);
  if (files.length !== after.files.length || files.some((entry, index) => entry !== after.files[index]) || before.missing.length !== after.missing.length || before.missing.some((entry, index) => entry !== after.missing[index])) throw new WorkspaceChangedDuringFingerprint('Workspace file set changed while fingerprinting');
  return { algorithm: 'sha256-item-claims-v2', value: digest.digest('hex'), file_count: files.length, total_bytes: totalBytes, workspace_claims: claims };
}

export async function workspaceFingerprint(workspaceValue, rawClaims = undefined) {
  const workspace = await canonicalWorkspace(workspaceValue);
  const claims = await normalizeWorkspaceClaims(rawClaims, workspace, { legacy: rawClaims === undefined || rawClaims === null });
  for (let attempt = 1; attempt <= FINGERPRINT_ATTEMPTS; attempt++) {
    try { return await fingerprintAttempt(workspace, claims); }
    catch (error) {
      if (!(error instanceof WorkspaceChangedDuringFingerprint) || attempt === FINGERPRINT_ATTEMPTS) {
        if (error instanceof WorkspaceChangedDuringFingerprint) throw new ControllerError(`Workspace did not stabilize after ${FINGERPRINT_ATTEMPTS} fingerprint attempts: ${error.message}`);
        throw error;
      }
    }
  }
  throw new ControllerError('Workspace fingerprint did not complete');
}

function validateNodes(nodes) {
  const visiting = new Set();
  const visited = new Set();
  const visit = nodeId => {
    if (visited.has(nodeId)) return;
    if (visiting.has(nodeId)) throw new ControllerError(`Task DAG contains a cycle at node ${nodeId}`);
    const dependencies = nodes[nodeId].depends_on ?? [];
    if (!Array.isArray(dependencies) || dependencies.some(dependency => !hasOwn(nodes, dependency))) throw new ControllerError(`Node ${nodeId} has an unknown dependency`);
    visiting.add(nodeId);
    dependencies.forEach(visit);
    visiting.delete(nodeId);
    visited.add(nodeId);
  };
  Object.keys(nodes).forEach(visit);
  const delegableOwners = new Set();
  for (const node of Object.values(nodes)) {
    if (node.execution_risk !== 'delegable') continue;
    if (delegableOwners.has(node.execution_owner)) throw new ControllerError(`Delegable nodes must have distinct execution_owner values: ${node.execution_owner}`);
    delegableOwners.add(node.execution_owner);
  }
}

function isReviewNode(node, routingSchemaVersion = null) {
  return node?.kind === 'total_review' || (routingSchemaVersion >= 2 && node?.kind === QUALITY_REVIEW_KIND);
}

function reviewNodes(nodes, routingSchemaVersion = null) {
  return Object.values(nodes).filter(node => isReviewNode(node, routingSchemaVersion));
}

function reviewNodesForState(state) {
  return reviewNodes(state.nodes, state.routing_schema_version);
}

function effectiveAssuranceLevel(state) {
  if (state.routing_schema_version < 2) return null;
  const reviewNode = reviewNodesForState(state)[0];
  return state.assurance_level === 'terra' && reviewNode?.review_stage === 'sol' ? 'sol' : state.assurance_level;
}

function validateReviewTopology(nodes, assuranceLevel = null, routingSchemaVersion = null, reviewEntryStage = null) {
  const allNodes = Object.values(nodes);
  const schemaVersion = routingSchemaVersion ?? (assuranceLevel === null ? 1 : 2);
  const reviews = reviewNodes(nodes, schemaVersion);
  if (!assuranceLevel) {
    if (reviews.length !== 1 || reviews[0].kind !== 'total_review') throw new ControllerError('A new task manifest must contain exactly one total_review node');
  } else if (assuranceLevel === 'verification') {
    if (reviews.length) throw new ControllerError('A verification assurance task cannot contain a review node');
    return;
  } else if (assuranceLevel === 'terra') {
    if (reviews.length !== 1) throw new ControllerError('A terra assurance task must contain exactly one review node');
    const review = reviews[0];
    const initialTerraGate = review.kind === QUALITY_REVIEW_KIND && review.review_stage === 'terra' && review.agent_type === TERRA_REVIEW_ROLE;
    const escalatedSolGate = review.kind === 'total_review' && review.review_stage === 'sol' && SOL_ROLES.has(review.agent_type);
    if (!initialTerraGate && !escalatedSolGate) throw new ControllerError('A terra assurance review node must be an initial Terra gate or an escalated Sol total_review');
    if (review.execution_risk !== 'read_only') throw new ControllerError('A terra assurance review node must be read_only');
  } else if (assuranceLevel === 'sol') {
    if (reviews.length !== 1 || reviews[0].kind !== 'total_review' || reviews[0].review_stage !== 'sol' || !SOL_ROLES.has(reviews[0].agent_type)) {
      throw new ControllerError('A sol assurance task must contain exactly one Sol total_review node');
    }
  } else {
    throw new ControllerError(`Unsupported assurance_level: ${assuranceLevel}`);
  }
  const review = reviews[0];
  if (schemaVersion === REVIEW_PROTOCOL_VERSION) {
    if (!REVIEW_ENTRY_STAGES.has(reviewEntryStage)) throw new ControllerError('A v3 task requires a supported review_entry_stage');
    const expectedStage = reviewEntryStage;
    if (assuranceLevel === 'terra' && !expectedStage.startsWith('terra')) throw new ControllerError('A terra v3 task must start at a Terra review stage');
    if (assuranceLevel === 'sol' && !expectedStage.startsWith('sol_')) throw new ControllerError('A sol v3 task must start at a Sol review stage');
    if (!review || !review.review_gate || !REVIEW_PROTOCOL_STAGES.has(review.review_gate.stage)) throw new ControllerError('A v3 review node requires an explicit review_gate');
    if (review.kind !== protocolNodeKind(review.review_gate.stage) || review.agent_type !== protocolNodeRole(review.review_gate.stage)) throw new ControllerError('A v3 review node does not match its review_gate stage');
    if (review.review_gate.stage === 'terra_cohort') {
      const cohort = review.review_gate.cohort;
      if (!cohort || !COHORT_PHASES.has(cohort.phase) || !cohort.lanes || COHORT_SLOTS.some(slot => !cohort.lanes[slot])) throw new ControllerError('A v3 Terra cohort requires two explicit lanes');
    }
  }
  const expectedDependencies = allNodes.filter(node => !isReviewNode(node, schemaVersion)).map(node => node.id).sort();
  const actualDependencies = [...new Set(review.depends_on)].sort();
  if (expectedDependencies.length !== actualDependencies.length || expectedDependencies.some((id, index) => id !== actualDependencies[index])) {
    throw new ControllerError('The review node must directly depend on every non-review node');
  }
  if (allNodes.some(node => !isReviewNode(node, schemaVersion) && node.depends_on.includes(review.id))) {
    throw new ControllerError('No node may depend on a review node');
  }
}

export function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function workflowSnapshotMaterial(state, { includeAssurance = true, excludeAllReviews = true, includeClaims = true } = {}) {
  const materialNodes = Object.values(state.nodes)
    .filter(node => excludeAllReviews ? !isReviewNode(node, state.routing_schema_version) : node.kind !== 'total_review')
    .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
    .map(node => ({
      id: node.id,
      kind: node.kind,
      agent_type: node.agent_type,
      depends_on: [...node.depends_on].sort(),
      execution_risk: node.execution_risk,
      routing_reason: node.routing_reason,
      execution_owner: node.execution_owner,
      integration_owner: node.integration_owner,
      quality_guard: node.quality_guard,
      status: node.status,
      result: node.result,
    }));
  const material = {
    task_id: state.task_id,
    goal: state.goal,
    requirements: [...state.requirements].sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
    scope: state.scope,
    non_goals: state.non_goals,
    nodes: materialNodes,
  };
  if (includeClaims) material.workspace_claims = state.workspace_claims ?? legacyWorkspaceClaims();
  if (includeAssurance) {
    material.assurance_level = state.assurance_level;
    material.assurance_assessment = state.assurance_assessment;
    if (isReviewProtocolState(state)) {
      material.review_protocol_version = state.review_protocol_version;
      material.review_entry_stage = state.review_entry_stage;
      material.review_context = state.review_context;
    }
  }
  return material;
}

function workflowSnapshotFor(state, { digestAlgorithm, includeAssurance, excludeAllReviews, includeClaims = true }) {
  return {
    workflow_revision: state.workflow_revision ?? 0,
    digest_algorithm: digestAlgorithm,
    digest: createHash('sha256').update(stableJson(workflowSnapshotMaterial(state, { includeAssurance, excludeAllReviews, includeClaims }))).digest('hex'),
  };
}

function workflowSnapshot(state) {
  return workflowSnapshotFor(state, { digestAlgorithm: 'sha256-stable-json-v2', includeAssurance: true, excludeAllReviews: true });
}

function workflowSnapshotMatchesState(recorded, state) {
  if (!recorded || typeof recorded !== 'object' || Array.isArray(recorded)) return false;
  if (recorded.digest_algorithm === 'sha256-stable-json-v2') return sameJson(recorded, workflowSnapshot(state));
  if (recorded.digest_algorithm !== 'sha256-stable-json-v1') return false;
  const legacyCandidates = [
    // Original v1 tasks excluded only total_review and had no assurance fields.
    workflowSnapshotFor(state, { digestAlgorithm: 'sha256-stable-json-v1', includeAssurance: false, excludeAllReviews: false, includeClaims: false }),
    // Early v2 assurance tasks excluded every review node but still emitted a v1 digest.
    workflowSnapshotFor(state, { digestAlgorithm: 'sha256-stable-json-v1', includeAssurance: false, excludeAllReviews: true, includeClaims: false }),
    // Accept records emitted by the short-lived assurance-aware v1 implementation.
    workflowSnapshotFor(state, { digestAlgorithm: 'sha256-stable-json-v1', includeAssurance: true, excludeAllReviews: true, includeClaims: false }),
  ];
  return legacyCandidates.some(candidate => sameJson(recorded, candidate));
}

export function sameJson(left, right) { return stableJson(left) === stableJson(right); }

function bumpWorkflowRevision(state, eventType, details = {}) {
  state.workflow_revision = (state.workflow_revision ?? 0) + 1;
  addEvent(state, eventType, { ...details, workflow_revision: state.workflow_revision });
}

function nodeRouting(raw, routingRequired) {
  const supplied = ROUTING_FIELDS.filter(field => hasOwn(raw, field));
  if (!supplied.length) {
    if (routingRequired) throw new ControllerError(`node requires routing fields: ${ROUTING_FIELDS.join(', ')}`);
    // Legacy manifests remain runnable only as protected work; they cannot authorize a Luna executor.
    return {
      execution_risk: 'protected',
      routing_reason: 'legacy manifest omitted routing audit fields; Luna executor delegation is prohibited',
      execution_owner: null,
      integration_owner: null,
      quality_guard: 'legacy routing metadata unavailable',
      routing_legacy: true,
    };
  }
  if (supplied.length !== ROUTING_FIELDS.length) throw new ControllerError(`node routing fields must be complete: ${ROUTING_FIELDS.join(', ')}`);
  const executionRisk = requiredString(raw.execution_risk, 'node.execution_risk');
  if (!['read_only', 'delegable', 'protected'].includes(executionRisk)) throw new ControllerError('node.execution_risk must be read_only, delegable, or protected');
  return {
    execution_risk: executionRisk,
    routing_reason: requiredString(raw.routing_reason, 'node.routing_reason'),
    execution_owner: requiredString(raw.execution_owner, 'node.execution_owner'),
    integration_owner: requiredString(raw.integration_owner, 'node.integration_owner'),
    quality_guard: requiredString(raw.quality_guard, 'node.quality_guard'),
    routing_legacy: false,
  };
}

function validateV1AgentType(kind, executionRisk, agentType) {
  if (kind === 'total_review') {
    if (executionRisk === 'delegable') throw new ControllerError('A v1 total_review node cannot be delegable');
    if (!SOL_ROLES.has(agentType)) throw new ControllerError('A v1 total_review node requires a Sol agent_type; Terra is fallback-only');
    return;
  }
  if (agentType == null) return;
  if (executionRisk === 'protected' && agentType !== PROTECTED_EXECUTOR_ROLE) throw new ControllerError('A v1 protected node agent_type must be avsp_terra_high or omitted');
  if (executionRisk === 'delegable' && !LUNA_EXECUTOR_ROLES.has(agentType) && agentType !== PROTECTED_EXECUTOR_ROLE) throw new ControllerError('A v1 delegable node agent_type must be a Luna executor, legacy writer, or avsp_terra_high');
  if (executionRisk === 'read_only' && (!READ_ONLY_ROLES.has(agentType) || READ_ONLY_FALLBACK_ROLE_SET.has(agentType))) throw new ControllerError('A v1 read_only node agent_type cannot configure a Terra fallback role or other non-primary role');
}

function validateV2AgentType(kind, executionRisk, agentType) {
  if (kind === QUALITY_REVIEW_KIND) {
    if (executionRisk !== 'read_only') throw new ControllerError('A v2 quality_review node must be read_only');
    if (agentType !== TERRA_REVIEW_ROLE) throw new ControllerError('A v2 quality_review node requires avsp_terra_xhigh');
    return;
  }
  validateV1AgentType(kind, executionRisk, agentType);
}

function nodeRecord(raw, options = {}) {
  if (!raw || typeof raw !== 'object') throw new ControllerError('Each node must be an object');
  const id = requiredIdentifier(raw.id, 'node.id'); const kind = requiredString(raw.kind, 'node.kind');
  if (raw.agent_type !== undefined && raw.agent_type !== null) requiredString(raw.agent_type, 'node.agent_type');
  const dependencies = raw.depends_on ?? [];
  if (!Array.isArray(dependencies) || dependencies.some(dependency => typeof dependency !== 'string' || !dependency.trim())) throw new ControllerError('node.depends_on must contain non-empty string identifiers');
  const routing = nodeRouting(raw, options.routingRequired === true);
  const isV2QualityReview = options.routingSchemaVersion >= 2 && kind === QUALITY_REVIEW_KIND;
  const defaultAgentType = options.routingSchemaVersion >= 1 && !routing.routing_legacy && raw.agent_type == null
    ? (kind === 'total_review' ? 'avsp_sol_high' : (isV2QualityReview ? TERRA_REVIEW_ROLE : ({ read_only: 'avsp_luna_high', delegable: 'avsp_luna_high_executor' }[routing.execution_risk] ?? null)))
    : null;
  const agentType = raw.agent_type ?? defaultAgentType;
  if (options.routingSchemaVersion === 1) validateV1AgentType(kind, routing.execution_risk, agentType);
  if (options.routingSchemaVersion >= 2) validateV2AgentType(kind, routing.execution_risk, agentType);
  return { id, kind, review_stage: isV2QualityReview ? 'terra' : kind === 'total_review' ? 'sol' : null, agent_type: agentType, depends_on: dependencies, ...routing, rescue_role: null, rescue_reason: null, rescued_at: null, rescue_count: 0, status: PENDING, agent_task_path: null, agent_thread_id: null, agent_role: null, claim_id: null, claimed_at: null, activation_at: null, activation_deadline_at: null, heartbeat_at: null, heartbeat_count: 0, lease_duration_sec: null, attempt: 0, attempt_budget_used: 0, unavailable_attempts: 0, result: null, checkpoint: null, checkpoint_at: null, workflow_completion_intent: null, recovery_history: [], review_gate: null };
}

function normalizeState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new ControllerError('Task state must be an object');
  if (!state.nodes || typeof state.nodes !== 'object' || Array.isArray(state.nodes) || !Object.keys(state.nodes).length) throw new ControllerError('Task state must contain nodes');
  if (state.workspace_claims === undefined || state.workspace_claims === null) state.workspace_claims = legacyWorkspaceClaims();
  state.workspace_claims = normalizeStoredWorkspaceClaims(state.workspace_claims);
  state.workflow_revision ??= 0;
  state.closed_revision ??= null;
  state.closed_at ??= null;
  state.verification_record ??= null;
  state.verification_history ??= [];
  if (!Array.isArray(state.verification_history)) throw new ControllerError('Task verification_history must be an array');
  state.assurance_assessment ??= null;
  state.repair_records ??= [];
  if (!Array.isArray(state.repair_records)) throw new ControllerError('Task repair_records must be an array');
  if (state.routing_schema_version === 2 || state.routing_schema_version === REVIEW_PROTOCOL_VERSION) {
    if (!ASSURANCE_LEVELS.has(state.assurance_level)) throw new ControllerError('A v2 task state requires assurance_level verification, terra, or sol');
    if (state.assurance_assessment !== null) state.assurance_assessment = assuranceAssessment(state.assurance_assessment, 'assurance_assessment', { allowLegacy: true });
  } else {
    state.assurance_level ??= null;
    state.assurance_assessment = null;
  }
  if (state.routing_schema_version === REVIEW_PROTOCOL_VERSION) {
    if (state.assurance_level === 'verification') throw new ControllerError('A v3 review protocol task must select terra or sol assurance');
    if (state.review_protocol_version !== REVIEW_PROTOCOL_VERSION || !REVIEW_ENTRY_STAGES.has(state.review_entry_stage)) {
      throw new ControllerError('A v3 task state requires complete review protocol metadata; explicit migration is required');
    }
    state.review_context = reviewContextValue(state.review_context);
  } else {
    state.review_protocol_version ??= null;
    state.review_entry_stage ??= null;
    state.review_context ??= null;
  }
  for (const [nodeId, node] of Object.entries(state.nodes)) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) throw new ControllerError(`Task node must be an object: ${nodeId}`);
    if (node.id !== nodeId) throw new ControllerError(`Task node key and id must match: ${nodeId}`);
    node.agent_thread_id ??= null; node.agent_role ??= null; node.claim_id ??= null; node.claimed_at ??= null; node.activation_at ??= null; node.activation_deadline_at ??= null; node.heartbeat_at ??= null;
    node.lease_duration_sec ??= null; node.heartbeat_count ??= 0; node.attempt ??= node.agent_task_path ? 1 : 0;
    node.attempt_budget_used ??= Math.min(node.attempt, MAX_NODE_ATTEMPTS); node.unavailable_attempts ??= 0;
    if (!Number.isSafeInteger(node.attempt) || node.attempt < 0 || !Number.isSafeInteger(node.attempt_budget_used) || node.attempt_budget_used < 0 || node.attempt_budget_used > MAX_NODE_ATTEMPTS || !Number.isSafeInteger(node.unavailable_attempts) || node.unavailable_attempts < 0 || node.unavailable_attempts > MAX_UNAVAILABLE_ATTEMPTS || node.attempt_budget_used + node.unavailable_attempts > node.attempt) {
      throw new ControllerError(`Task node has invalid attempt accounting: ${nodeId}`);
    }
    node.checkpoint ??= null; node.checkpoint_at ??= null; node.recovery_history ??= []; node.workflow_completion_intent ??= null;
    node.rescue_role ??= null; node.rescue_reason ??= null; node.rescued_at ??= null; node.rescue_count ??= 0;
    node.review_stage ??= state.routing_schema_version >= 2 && node.kind === QUALITY_REVIEW_KIND ? 'terra' : node.kind === 'total_review' ? 'sol' : null;
    node.review_gate ??= null;
    if (state.routing_schema_version === REVIEW_PROTOCOL_VERSION && isReviewNode(node, state.routing_schema_version)) {
      if (!node.review_gate || typeof node.review_gate !== 'object' || !REVIEW_PROTOCOL_STAGES.has(node.review_gate.stage)) throw new ControllerError('A v3 review node requires an explicit review_gate; explicit migration is required');
      if (node.kind !== protocolNodeKind(node.review_gate.stage) || node.agent_type !== protocolNodeRole(node.review_gate.stage)) throw new ControllerError('A v3 review node does not match its review_gate stage');
      if (node.review_gate.stage === 'terra_cohort') {
        const cohort = node.review_gate.cohort;
        if (!cohort || typeof cohort !== 'object' || !COHORT_PHASES.has(cohort.phase) || !cohort.lanes || typeof cohort.lanes !== 'object' || COHORT_SLOTS.some(slot => !cohort.lanes[slot])) throw new ControllerError('A v3 Terra cohort requires two explicit lanes');
      }
    }
    if (!hasOwn(node, 'execution_risk')) Object.assign(node, nodeRouting(node, false));
  }
  validateNodes(state.nodes);
  validateReviewTopology(state.nodes, state.assurance_level, state.routing_schema_version, state.review_entry_stage);
  return state;
}

async function makeState(manifest) {
  const required = ['task_id', 'workspace', 'goal', 'requirements'];
  if (!manifest || typeof manifest !== 'object' || required.some(key => !hasOwn(manifest, key))) throw new ControllerError('Manifest requires task_id, workspace, goal, and requirements');
  const taskId = requiredIdentifier(manifest.task_id, 'task_id');
  const routingSchemaVersion = manifest.routing_schema_version ?? 0;
  if (![0, 1, 2, REVIEW_PROTOCOL_VERSION].includes(routingSchemaVersion)) throw new ControllerError('routing_schema_version must be 1, 2, or 3 when provided');
  const assuranceLevel = routingSchemaVersion >= 2 ? requiredString(manifest.assurance_level, 'assurance_level') : null;
  if (assuranceLevel !== null && !ASSURANCE_LEVELS.has(assuranceLevel)) throw new ControllerError('assurance_level must be verification, terra, or sol');
  const assuranceAssessmentValue = routingSchemaVersion >= 2 ? assuranceAssessment(manifest.assurance_assessment) : null;
  if (assuranceAssessmentValue !== null) requireAssuranceLevelMatches(assuranceLevel, assuranceAssessmentValue);
  const workspace = await canonicalWorkspace(manifest.workspace);
  const workspaceClaims = await normalizeWorkspaceClaims(manifest.workspace_claims, workspace, { legacy: !hasOwn(manifest, 'workspace_claims') });
  const goal = requiredString(manifest.goal, 'goal');
  await workspaceFingerprint(workspace, workspaceClaims);
  if (!Array.isArray(manifest.requirements) || !manifest.requirements.length || manifest.requirements.length > MAX_REQUIREMENTS) throw new ControllerError(`Manifest requires between 1 and ${MAX_REQUIREMENTS} requirements`);
  const requirements = manifest.requirements.map(item => {
    if (!item || typeof item !== 'object') throw new ControllerError('Each requirement must be an object');
    return { ...item, id: requiredIdentifier(item.id, 'requirement.id'), text: requiredString(item.text, 'requirement.text') };
  });
  const ids = requirements.map(item => item.id);
  if (new Set(ids).size !== ids.length) throw new ControllerError('Each requirement needs a unique id and non-empty text');
  if (!Array.isArray(manifest.nodes) || !manifest.nodes.length || manifest.nodes.length > MAX_NODES) throw new ControllerError(`Manifest requires between 1 and ${MAX_NODES} nodes`);
  const nodes = Object.create(null);
  for (const rawNode of manifest.nodes ?? []) {
    const node = nodeRecord(rawNode, { routingRequired: routingSchemaVersion >= 1, routingSchemaVersion, expectedTaskId: taskId });
    if (hasOwn(nodes, node.id)) throw new ControllerError(`Duplicate node id: ${node.id}`);
    nodes[node.id] = node;
  }
  const reviewEntryStage = routingSchemaVersion === REVIEW_PROTOCOL_VERSION
    ? requiredString(manifest.review_entry_stage ?? (assuranceLevel === 'terra' ? 'terra_single' : 'sol_high'), 'review_entry_stage')
    : null;
  if (routingSchemaVersion === REVIEW_PROTOCOL_VERSION && !REVIEW_ENTRY_STAGES.has(reviewEntryStage)) {
    throw new ControllerError('review_entry_stage must be terra_single, terra_cohort, sol_high, or sol_xhigh');
  }
  const reviewContext = routingSchemaVersion === REVIEW_PROTOCOL_VERSION ? reviewContextValue(manifest.review_context) : null;
  if (routingSchemaVersion === REVIEW_PROTOCOL_VERSION && assuranceLevel === 'verification') throw new ControllerError('A v3 review protocol task must select terra or sol assurance');
  if (routingSchemaVersion === REVIEW_PROTOCOL_VERSION) {
    const review = reviewNodes(nodes, routingSchemaVersion)[0];
    if (review) applyProtocolStage(review, reviewEntryStage);
  }
  if (routingSchemaVersion === 2 && assuranceLevel === 'sol' && reviewNodes(nodes, routingSchemaVersion)[0]?.agent_type === 'avsp_sol_max') {
    throw new ControllerError('A v2 task cannot start at avsp_sol_max; begin at high or xhigh, or use the v3 review protocol');
  }
  validateNodes(nodes);
  validateReviewTopology(nodes, assuranceLevel, routingSchemaVersion, reviewEntryStage);
  if (hasOwn(manifest, 'workspace_claims') && Object.values(nodes).some(node => !isReviewNode(node, routingSchemaVersion) && node.execution_risk !== 'read_only') && !workspaceClaims.some(claim => claim.mode === 'write')) {
    throw new ControllerError('workspace_claims requires at least one write claim for non-read-only work');
  }
  const created = utcNow();
  const state = { version: VERSION, routing_schema_version: routingSchemaVersion || null, assurance_level: assuranceLevel, assurance_assessment: assuranceAssessmentValue, review_protocol_version: routingSchemaVersion === REVIEW_PROTOCOL_VERSION ? REVIEW_PROTOCOL_VERSION : null, review_entry_stage: reviewEntryStage, review_context: reviewContext, task_id: taskId, workspace, workspace_claims: workspaceClaims, goal, requirements, scope: manifest.scope ?? [], non_goals: manifest.non_goals ?? [], nodes, participants: [], reviews: [], repair_records: [], max_review_charter: null, verification_record: null, verification_history: [], events: [{ at: created, type: 'task_initialized', workflow_revision: 0 }], workflow_revision: 0, closed_revision: null, closed_at: null, created_at: created, updated_at: created };
  return state;
}

function readyNodes(state) {
  return Object.values(state.nodes).filter(node => {
    const dependenciesReady = node.depends_on.every(dependency => [SUCCEEDED, 'skipped'].includes(state.nodes[dependency].status));
    if (!dependenciesReady) return false;
    if (node.status === PENDING) return true;
    return isCohortReviewNode(state, node) && node.status === RUNNING && cohortLanes(node).some(lane => lane.status === PENDING);
  });
}

function participantPaths(state) { return new Set(state.participants.map(item => item.agent_task_path)); }
function runningParticipantPaths(state) {
  const paths = new Set(Object.values(state.nodes).filter(node => node.status === RUNNING && node.agent_task_path).map(node => node.agent_task_path));
  for (const node of Object.values(state.nodes)) for (const lane of cohortLanes(node)) if (lane.status === RUNNING && lane.agent_task_path) paths.add(lane.agent_task_path);
  return paths;
}
async function configuredStatePath(parameters, taskId) { return statePath(await canonicalStateDirectory(parameters.state_dir), taskId); }
async function readTask(parameters) { const filePath = await configuredStatePath(parameters, requiredString(parameters.task_id, 'task_id')); return [filePath, normalizeState(await loadState(filePath))]; }

function activationDeadline(node) {
  const stored = Date.parse(node.activation_deadline_at);
  if (Number.isFinite(stored)) return stored;
  const claimed = Date.parse(node.claimed_at);
  if (!Number.isFinite(claimed)) return null;
  return claimed + Math.min(DEFAULT_ACTIVATION_TIMEOUT_SEC, node.lease_duration_sec ?? DEFAULT_LEASE_SEC) * 1000;
}

function staleNodes(state, now = Date.now()) {
  return Object.values(state.nodes).flatMap(node => {
    if (isCohortReviewNode(state, node)) {
      return cohortLanes(node).flatMap(lane => {
        if (lane.status !== RUNNING || !lane.lease_duration_sec) return [];
        const deadline = Date.parse(lane.activation_deadline_at);
        if (!lane.activation_at || lane.heartbeat_count === 0) {
          if (!Number.isFinite(deadline) || deadline >= now) return [];
          return [{ id: node.id, reviewer_slot: lane.slot, agent_task_path: lane.agent_task_path, agent_thread_id: lane.agent_thread_id, claim_id: lane.claim_id, reason: 'never_activated', claimed_at: lane.claimed_at, activation_deadline_at: lane.activation_deadline_at, lease_duration_sec: lane.lease_duration_sec }];
        }
        const heartbeat = Date.parse(lane.heartbeat_at);
        if (!Number.isFinite(heartbeat) || heartbeat + lane.lease_duration_sec * 1000 >= now) return [];
        return [{ id: node.id, reviewer_slot: lane.slot, agent_task_path: lane.agent_task_path, agent_thread_id: lane.agent_thread_id, claim_id: lane.claim_id, reason: 'heartbeat_expired', heartbeat_at: lane.heartbeat_at, lease_duration_sec: lane.lease_duration_sec }];
      });
    }
    if (node.status !== RUNNING || !node.lease_duration_sec) return [];
    if (!node.activation_at || node.heartbeat_count === 0) {
      const deadline = activationDeadline(node);
      if (deadline === null || deadline >= now) return [];
      return [{ id: node.id, agent_task_path: node.agent_task_path, agent_thread_id: node.agent_thread_id, claim_id: node.claim_id, reason: 'never_activated', claimed_at: node.claimed_at, activation_deadline_at: new Date(deadline).toISOString(), lease_duration_sec: node.lease_duration_sec }];
    }
    const heartbeat = Date.parse(node.heartbeat_at);
    if (!Number.isFinite(heartbeat) || heartbeat + node.lease_duration_sec * 1000 >= now) return [];
    return [{ id: node.id, agent_task_path: node.agent_task_path, agent_thread_id: node.agent_thread_id, claim_id: node.claim_id, reason: 'heartbeat_expired', heartbeat_at: node.heartbeat_at, lease_duration_sec: node.lease_duration_sec }];
  });
}

function compactState(state) {
  return { task_id: state.task_id, workspace: state.workspace, workspace_claims: state.workspace_claims, workspace_lease: state.workspace_lease ?? null, assurance_level: state.assurance_level, effective_assurance_level: effectiveAssuranceLevel(state), assurance_assessment: state.assurance_assessment, review_protocol_version: state.review_protocol_version, review_entry_stage: state.review_entry_stage, review_context: state.review_context, goal: state.goal, nodes: Object.values(state.nodes), ready_nodes: readyNodes(state), stale_nodes: staleNodes(state), participants: state.participants, reviews: externallyVisibleReviews(state), repair_records: state.repair_records, verification_record: state.verification_record, verification_history: state.verification_history, workflow_revision: state.workflow_revision, updated_at: state.updated_at };
}

async function coordinationStatus(lockPath) {
  const files = [];
  for (const suffix of ['', '.writer', '.release', '.recover']) {
    const candidate = `${lockPath}${suffix}`;
    try {
      const details = await lockDetails(candidate);
      let owner_alive = null;
      if (details.hostname === os.hostname()) {
        try { owner_alive = await processIsAlive(details.pid); }
        catch { owner_alive = null; }
      }
      files.push({ path: candidate, kind: suffix || '.lock', present: true, hostname: details.hostname || null, pid: Number.isSafeInteger(details.pid) ? details.pid : null, created_at: details.created || null, age_ms: details.ageMs, owner_alive });
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      files.push({ path: candidate, kind: suffix || '.lock', present: true, readable: false, error: error.message });
    }
  }
  return files;
}

function doctorCheck(id, status, detail) { return { id, status, detail }; }

async function unreadableDoctor(parameters, filePath, error) {
  const database = databasePath(filePath);
  let databaseDetail = { path: database, error: error.message };
  try {
    const metadata = await fs.stat(database);
    databaseDetail = { path: database, bytes: metadata.size, modified_at: metadata.mtime.toISOString(), error: error.message };
  } catch (statError) {
    if (statError.code !== 'ENOENT') databaseDetail = { path: database, error: `${error.message}; ${statError.message}` };
  }
  const coordinationFiles = await coordinationStatus(`${filePath}.lock`);
  return {
    task_id: requiredString(parameters.task_id, 'task_id'),
    workspace: null,
    health: 'blocked',
    checks: [
      doctorCheck('state_database', 'fail', databaseDetail),
      doctorCheck('task_state', 'fail', { path: filePath, error: error.message }),
      doctorCheck('coordination', coordinationFiles.length ? 'attention' : 'pass', { files: coordinationFiles }),
    ],
    recovery_candidates: [],
    close_status: { close_allowed: false, reasons: [`task state is unreadable: ${error.message}`] },
  };
}

async function quarantinedDoctor(parameters, filePath, metadata) {
  const coordinationFiles = await coordinationStatus(`${filePath}.lock`);
  return {
    task_id: requiredString(parameters.task_id, 'task_id'),
    workspace: null,
    health: 'blocked',
    checks: [
      doctorCheck('quarantined_state', 'fail', {
        state_path: filePath,
        error_path: metadata.error_path,
        reason: metadata.reason,
        status: metadata.status,
        quarantined_at: metadata.quarantined_at,
        delete_after: metadata.delete_after,
        files: metadata.files,
        move_error: metadata.move_error,
      }),
      doctorCheck('coordination', coordinationFiles.length ? 'attention' : 'pass', { files: coordinationFiles }),
    ],
    recovery_candidates: [],
    close_status: { close_allowed: false, reasons: [`task state is quarantined until ${metadata.delete_after}`] },
  };
}

async function doctorTask(parameters) {
  if (parameters.task_id === undefined || parameters.task_id === null) return doctorStateDirectory(parameters);
  const filePath = await configuredStatePath(parameters, requiredString(parameters.task_id, 'task_id'));
  let state;
  try { state = normalizeState(await loadState(filePath)); }
  catch (error) {
    const metadata = await findQuarantinedState(path.dirname(filePath), filePath);
    if (metadata) return quarantinedDoctor(parameters, filePath, metadata);
    return unreadableDoctor(parameters, filePath, error);
  }
  const checks = [];
  const database = databasePath(filePath);
  try {
    const metadata = await fs.stat(database);
    checks.push(doctorCheck('state_database', 'pass', { path: database, bytes: metadata.size, modified_at: metadata.mtime.toISOString() }));
  } catch (error) {
    if (error.code === 'ENOENT') checks.push(doctorCheck('state_database', 'attention', { path: database, reason: 'legacy JSON state is in use' }));
    else checks.push(doctorCheck('state_database', 'fail', { path: database, error: error.message }));
  }

  if (state.workspace_lease) {
    try {
      const parentAuthority = await stateParentAuthorityForState(state, filePath);
      await verifyRegularDirectorySnapshot(parentAuthority, 'Controller state parent');
      checks.push(doctorCheck('state_parent_authority', 'pass', { path: parentAuthority.path }));
    } catch (error) {
      checks.push(doctorCheck('state_parent_authority', 'fail', { error: error.message }));
    }
  }

  if (!state.workspace_lease) {
    checks.push(doctorCheck('workspace_lease', 'attention', { reason: 'legacy task has no workspace lease' }));
  } else {
    try {
      const lease = await loadWorkspaceLease(state.workspace_lease.registry_path, state.workspace);
      const active = state.workspace_lease.status === 'active';
      const released = state.workspace_lease.status === 'released';
      const matches = active ? workspaceLeaseMatches(lease, state, filePath) : released && workspaceLeaseStatePathOwners(lease, filePath).length === 0;
      checks.push(doctorCheck('workspace_lease', matches ? 'pass' : 'fail', {
        path: state.workspace_lease.registry_path,
        task_status: state.workspace_lease.status,
        registry_active_tasks: lease.active_tasks.map(entry => ({ task_id: entry.task_id, state_path: entry.state_path, phase: entry.phase, workspace_claims: entry.workspace_claims })),
        reason: matches ? null : 'workspace lease does not match task state',
      }));
    } catch (error) {
      checks.push(doctorCheck('workspace_lease', 'fail', { path: state.workspace_lease.registry_path, error: error.message }));
    }
  }

  const stale = staleNodes(state);
  checks.push(doctorCheck('running_nodes', stale.length ? 'attention' : 'pass', {
    running: Object.values(state.nodes).filter(node => node.status === RUNNING).map(node => node.id),
    stale: stale.map(node => ({ id: node.id, reason: node.reason, claim_id: node.claim_id })),
  }));
  const coordination_files = await coordinationStatus(`${filePath}.lock`);
  checks.push(doctorCheck('coordination', coordination_files.length ? 'attention' : 'pass', { files: coordination_files }));

  let closeStatus;
  try {
    const closeReasonsList = await closeReasons(state);
    closeStatus = { close_allowed: closeReasonsList.length === 0, reasons: closeReasonsList };
  } catch (error) {
    checks.push(doctorCheck('close_gate', 'fail', { error: error.message }));
    closeStatus = { close_allowed: false, reasons: [`close check unavailable: ${error.message}`] };
  }
  const failed = checks.some(check => check.status === 'fail');
  const attention = checks.some(check => check.status === 'attention');
  return {
    task_id: state.task_id,
    workspace: state.workspace,
    health: failed ? 'blocked' : attention ? 'attention' : 'healthy',
    checks,
    recovery_candidates: stale.map(node => ({
      node_id: node.id,
      claim_id: node.claim_id,
      reason: node.reason,
      required_actions: ['确认旧原生代理已停止且不再写入工作区', '创建新的替代代理实例', '使用 replacement_agent_task_path 和 previous_agent_stopped=true 调用 workflow_requeue_stale'],
      automatic_requeue: 'controller cannot prove native agent termination or create a Codex agent; the coordinator must perform these actions before requeueing',
    })),
    close_status: closeStatus,
  };
}

async function loadWorkspaceLease(leasePath, workspace, { allowMissing = false, authorityContext = null } = {}) {
  if (leasePath !== workspaceLeasePath(workspace)) throw new ControllerError(`Workspace lease path does not match its canonical workspace authority: ${leasePath}`);
  const authority = authorityContext?.authority ?? await ensureWorkspaceLeaseAuthority(workspace);
  await verifyWorkspaceLeaseAuthoritySnapshot(authority);
  try {
    await verifyWorkspaceLeaseRegistryBinding(authority, { allowUninitializedMissing: allowMissing });
    const snapshot = await readJsonSnapshot(leasePath, { label: 'Workspace lease', maxBytes: MAX_MANIFEST_BYTES });
    if (!sameFileObjectIdentity(authority.record.registry_identity, snapshot.object_identity)) throw new ControllerError(`Workspace lease registry identity changed: ${leasePath}`);
    const lease = snapshot.value;
    if (!lease || typeof lease !== 'object' || Array.isArray(lease) || lease.workspace !== workspace || !validTimestamp(lease.updated_at)) throw new ControllerError(`Unsupported workspace lease: ${leasePath}`);
    if (lease.version === LEGACY_WORKSPACE_LEASE_VERSION && hasExactFields(lease, new Set(['version', 'workspace', 'active_task', 'updated_at']))) {
      let activeTasks = [];
      if (lease.active_task !== null) {
        await validateLegacyWorkspaceLeaseForAuthority(lease, workspace, leasePath);
        const legacyTask = lease.active_task;
        const legacyStatePath = await canonicalStatePath(legacyTask.state_path, 'legacy workspace lease state_path');
        const legacyState = await loadState(legacyStatePath);
        const parentAuthority = await stateParentAuthorityForState(legacyState, legacyStatePath);
        await verifyRegularDirectorySnapshot(parentAuthority, 'Controller state parent');
        if (legacyState.task_id !== legacyTask.task_id || legacyState.workspace !== workspace || legacyState.workspace_lease?.acquired_at !== legacyTask.acquired_at) {
          throw new ControllerError(`Legacy workspace lease does not match its task state; controlled recovery is required: ${leasePath}`);
        }
        activeTasks = [{ ...legacyTask, phase: legacyTask.phase ?? 'active', state_dir: legacyTask.state_dir ?? path.dirname(legacyStatePath), state_parent_authority: parentAuthority, workspace_claims: legacyWorkspaceClaims() }];
      }
      const migrated = { version: WORKSPACE_LEASE_VERSION, workspace, active_tasks: activeTasks, updated_at: lease.updated_at };
      await validateWorkspaceLease(migrated, leasePath);
      await verifyWorkspaceLeaseAuthoritySnapshot(authority);
      Object.defineProperty(migrated, 'migrated_from_v1', { value: true, enumerable: false });
      return migrated;
    }
    await validateWorkspaceLease(lease, leasePath);
    await verifyWorkspaceLeaseAuthoritySnapshot(authority);
    await verifyWorkspaceLeaseRegistryBinding(authority);
    return lease;
  } catch (error) {
    if (allowMissing && authority.record.version === WORKSPACE_LEASE_AUTHORITY_VERSION && !authority.record.registry_initialized
      && error instanceof ControllerError && (error.message.startsWith('Workspace lease does not exist:') || error.message.startsWith('Workspace lease registry is missing'))) {
      await verifyWorkspaceLeaseAuthoritySnapshot(authority);
      return { version: WORKSPACE_LEASE_VERSION, workspace, active_tasks: [], updated_at: utcNow() };
    }
    throw error;
  }
}

async function validateWorkspaceLeaseEntry(entry, leasePath) {
  const fields = new Set(['task_id', 'state_path', 'state_dir', 'acquired_at', 'phase', 'workspace_claims']);
  const authorityFields = new Set([...fields, 'state_parent_authority']);
  if ((!hasExactFields(entry, fields) && !hasExactFields(entry, authorityFields)) || !validTimestamp(entry.acquired_at) || !['initializing', 'active'].includes(entry.phase)) throw new ControllerError(`Unsupported workspace lease entry: ${leasePath}`);
  requiredIdentifier(entry.task_id, 'workspace lease task_id');
  if (typeof entry.state_path !== 'string' || typeof entry.state_dir !== 'string') throw new ControllerError(`Invalid workspace lease entry path: ${leasePath}`);
  const statePath = await canonicalStatePath(entry.state_path, 'workspace lease state_path');
  const stateDir = await canonicalStateDirectory(entry.state_dir, 'workspace lease state_dir');
  if (!sameStatePath(path.dirname(statePath), stateDir)) throw new ControllerError(`Invalid workspace lease entry path: ${leasePath}`);
  entry.state_path = statePath;
  entry.state_dir = stateDir;
  if (entry.state_parent_authority !== undefined && !validStateParentAuthority(entry.state_parent_authority, statePath)) throw new ControllerError(`Invalid workspace lease state parent authority: ${leasePath}`);
  entry.workspace_claims = normalizeStoredWorkspaceClaims(entry.workspace_claims);
}

async function validateWorkspaceLease(lease, leasePath) {
  if (!hasExactFields(lease, new Set(['version', 'workspace', 'active_tasks', 'updated_at'])) || lease.version !== WORKSPACE_LEASE_VERSION || !Array.isArray(lease.active_tasks) || lease.active_tasks.length > MAX_WORKSPACE_ACTIVE_TASKS || !validTimestamp(lease.updated_at)) throw new ControllerError(`Unsupported workspace lease: ${leasePath}`);
  const identities = new Set();
  for (const entry of lease.active_tasks) {
    await validateWorkspaceLeaseEntry(entry, leasePath);
    const identity = `${entry.task_id}\u0000${statePathKey(entry.state_path)}\u0000${entry.acquired_at}`;
    if (identities.has(identity)) throw new ControllerError(`Duplicate workspace lease entry: ${leasePath}`);
    identities.add(identity);
  }
  for (let index = 0; index < lease.active_tasks.length; index++) {
    for (let other = index + 1; other < lease.active_tasks.length; other++) {
      if (sameStatePath(lease.active_tasks[index].state_path, lease.active_tasks[other].state_path) || claimsConflict(lease.active_tasks[index].workspace_claims, lease.active_tasks[other].workspace_claims)) throw new ControllerError(`Conflicting workspace lease entries: ${leasePath}`);
    }
  }
}

async function validateLegacyWorkspaceLeaseForAuthority(lease, workspace, leasePath) {
  if (!hasExactFields(lease, new Set(['version', 'workspace', 'active_task', 'updated_at']))
    || lease.version !== LEGACY_WORKSPACE_LEASE_VERSION || lease.workspace !== workspace || !validTimestamp(lease.updated_at)
    || (lease.active_task !== null && (!lease.active_task || typeof lease.active_task !== 'object' || Array.isArray(lease.active_task)))) {
    throw new ControllerError(`Cannot create workspace lease authority for an invalid legacy registry: ${leasePath}`);
  }
  if (lease.active_task === null) return;
  const task = lease.active_task;
  const fields = new Set(Object.keys(task));
  const allowed = [new Set(['task_id', 'state_path', 'acquired_at']), new Set(['task_id', 'state_path', 'state_dir', 'acquired_at']), new Set(['task_id', 'state_path', 'state_dir', 'acquired_at', 'phase'])];
  if (!allowed.some(candidate => hasExactFields(task, candidate)) || !validTimestamp(task.acquired_at) || typeof task.state_path !== 'string' || !path.isAbsolute(task.state_path)) {
    throw new ControllerError(`Cannot create workspace lease authority for an invalid legacy registry: ${leasePath}`);
  }
  requiredIdentifier(task.task_id, 'legacy workspace lease task_id');
  const statePath = await canonicalStatePath(task.state_path, 'legacy workspace lease state_path');
  if (task.state_dir !== undefined) {
    if (typeof task.state_dir !== 'string' || !path.isAbsolute(task.state_dir) || !sameStatePath(await canonicalStateDirectory(task.state_dir, 'legacy workspace lease state_dir'), path.dirname(statePath))) {
      throw new ControllerError(`Cannot create workspace lease authority for an invalid legacy registry: ${leasePath}`);
    }
  }
  if (task.phase !== undefined && !['initializing', 'active'].includes(task.phase)) throw new ControllerError(`Cannot create workspace lease authority for an invalid legacy registry: ${leasePath}`);
}

function stateWorkspaceClaims(state) { return state.workspace_lease?.workspace_claims ?? state.workspace_claims ?? legacyWorkspaceClaims(); }

function workspaceLeaseEntryMatches(entry, state, filePath, { activeOnly = true } = {}) {
  return entry.task_id === state.task_id
    && sameStatePath(entry.state_path, filePath)
    && sameStatePath(entry.state_dir, path.dirname(filePath))
    && entry.acquired_at === state.workspace_lease?.acquired_at
    && sameJson(entry.workspace_claims, stateWorkspaceClaims(state))
    && sameJson(entry.state_parent_authority, state.workspace_lease?.state_parent_authority)
    && (!activeOnly || entry.phase === 'active');
}

function workspaceLeaseMatches(lease, state, filePath) {
  return lease.active_tasks.find(entry => workspaceLeaseEntryMatches(entry, state, filePath)) ?? null;
}

function workspaceLeaseStatePathOwners(lease, filePath) {
  return lease.active_tasks.filter(entry => sameStatePath(entry.state_path, filePath));
}

function workspaceLeasePeerOwners(lease, state, filePath) {
  return workspaceLeaseStatePathOwners(lease, filePath)
    .filter(entry => !workspaceLeaseEntryMatches(entry, state, filePath, { activeOnly: false }));
}

function claimsConflict(leftClaims, rightClaims) {
  return leftClaims.some(left => rightClaims.some(right => (left.mode === 'write' || right.mode === 'write') && (isClaimAncestor(left.prefix, right.prefix) || isClaimAncestor(right.prefix, left.prefix))));
}

async function requireActiveWorkspaceLease(state, filePath, authorityContext = null) {
  if (!state.workspace_lease) throw new ControllerError('Legacy task has no workspace lease and cannot change state; create a new workflow task');
  if (state.workspace_lease.status !== 'active') throw new ControllerError(`Workspace lease is not active for this task: ${state.workspace_lease.registry_path}`);
  const lease = await loadWorkspaceLease(state.workspace_lease.registry_path, state.workspace, { authorityContext });
  const entry = workspaceLeaseMatches(lease, state, filePath);
  if (!entry) throw new ControllerError(`Workspace lease does not belong to this active task: ${state.workspace_lease.registry_path}`);
  if (entry.state_parent_authority === undefined) throw new ControllerError(`Workspace lease entry parent authority is missing; controlled recovery is required: ${state.workspace_lease.registry_path}`);
  if (!sameJson(entry.state_parent_authority, state.workspace_lease?.state_parent_authority)) throw new ControllerError(`Task state parent authority does not match workspace lease: ${filePath}`);
  await verifyRegularDirectorySnapshot(entry.state_parent_authority, 'Controller state parent');
  return lease;
}

async function bindStateParentAuthorityToWorkspaceLease(lease, state, filePath, authorityContext) {
  const entry = workspaceLeaseMatches(lease, state, filePath);
  if (!entry) return;
  if (entry.state_parent_authority === undefined) throw new ControllerError(`Workspace lease entry parent authority is missing; controlled recovery is required: ${state.workspace_lease.registry_path}`);
  if (!sameJson(entry.state_parent_authority, state.workspace_lease.state_parent_authority)) throw new ControllerError(`Task state parent authority does not match workspace lease: ${filePath}`);
  void authorityContext;
}

async function withActiveWorkspaceStateLock(filePath, callback) {
  const initialState = normalizeState(await loadState(filePath));
  if (!initialState.workspace_lease) throw new ControllerError('Legacy task has no workspace lease and cannot change state; create a new workflow task');
  const parentAuthority = await stateParentAuthorityForState(initialState, filePath);
  await verifyRegularDirectorySnapshot(parentAuthority, 'Controller state parent');
  const expectedLeasePath = initialState.workspace_lease.registry_path;
  return withWorkspaceLeaseLock(initialState.workspace, async (leasePath, authorityContext) => {
    if (leasePath !== expectedLeasePath) throw new ControllerError('Workspace lease authority path changed before task-state mutation');
    return withStateLock(filePath, async () => {
      await verifyRegularDirectorySnapshot(parentAuthority, 'Controller state parent');
      const state = normalizeState(await loadState(filePath));
      if (state.workspace !== initialState.workspace || state.workspace_lease?.registry_path !== leasePath) throw new ControllerError('Task workspace lease authority changed while acquiring locks');
      const currentParentAuthority = await stateParentAuthorityForState(state, filePath);
      if (!sameStateParentAuthority(currentParentAuthority, parentAuthority)) throw new ControllerError(`Controller state parent authority changed: ${filePath}`);
      await attachStateParentAuthority(state, filePath, parentAuthority);
      const lease = await requireActiveWorkspaceLease(state, filePath, authorityContext);
      await bindStateParentAuthorityToWorkspaceLease(lease, state, filePath, authorityContext);
      return callback(state, lease, authorityContext);
    }, { parentAuthority });
  }, { allowAuthorityMigration: true });
}

async function releaseWorkspaceLease(parameters, { closeAllowed = false } = {}) {
  const filePath = await configuredStatePath(parameters, requiredString(parameters.task_id, 'task_id'));
  const initialState = await loadState(filePath);
  const stateLease = initialState.workspace_lease;
  if (!stateLease) return { released: false, reason: 'legacy task has no workspace lease' };
  if (!stateLease || typeof stateLease !== 'object' || typeof initialState.workspace !== 'string' || !path.isAbsolute(initialState.workspace)
    || typeof stateLease.registry_path !== 'string' || !path.isAbsolute(stateLease.registry_path)
    || path.resolve(stateLease.registry_path) !== workspaceLeasePath(initialState.workspace)
    || !sameStatePath(stateLease.state_path, filePath)) throw new ControllerError('Cannot release workspace lease: lease metadata is not a complete matching registry');
  const parentAuthority = await stateParentAuthorityForState(initialState, filePath);
  await verifyRegularDirectorySnapshot(parentAuthority, 'Controller state parent');
  const leasePath = stateLease.registry_path;
  return withWorkspaceLeaseLock(initialState.workspace, async (lockedLeasePath, authorityContext) => {
    if (lockedLeasePath !== leasePath) throw new ControllerError('Cannot release workspace lease: registry authority path changed');
    return withStateLock(filePath, async () => {
    await verifyRegularDirectorySnapshot(parentAuthority, 'Controller state parent');
    const state = await loadState(filePath);
    const currentParentAuthority = await stateParentAuthorityForState(state, filePath);
    if (!sameStateParentAuthority(currentParentAuthority, parentAuthority)) throw new ControllerError(`Controller state parent authority changed: ${filePath}`);
    await attachStateParentAuthority(state, filePath, parentAuthority);
    state.workspace_claims = normalizeStoredWorkspaceClaims(state.workspace_claims, { legacy: state.workspace_claims === undefined || state.workspace_claims === null });
    if (state.workspace_lease) state.workspace_lease.workspace_claims = normalizeStoredWorkspaceClaims(state.workspace_lease.workspace_claims ?? state.workspace_claims, { legacy: state.workspace_lease.workspace_claims === undefined || state.workspace_lease.workspace_claims === null });
    if (!state.nodes || typeof state.nodes !== 'object' || Array.isArray(state.nodes) || !Object.keys(state.nodes).length) throw new ControllerError('Cannot release workspace lease: task nodes are unreadable or empty');
    const unknownNodes = Object.values(state.nodes).filter(node => !node || typeof node !== 'object' || ![PENDING, RUNNING, ...TERMINAL].includes(node.status));
    if (unknownNodes.length) throw new ControllerError('Cannot release workspace lease while node statuses are unknown');
    const running = Object.values(state.nodes).filter(node => node.status === RUNNING).map(node => node.id);
    if (running.length) throw new ControllerError(`Cannot release workspace lease while nodes are running: ${running.join(', ')}`);
    if (!closeAllowed) trueValue(parameters.previous_agents_stopped, 'previous_agents_stopped');
    const lease = await loadWorkspaceLease(leasePath, state.workspace, { authorityContext });
    await bindStateParentAuthorityToWorkspaceLease(lease, state, filePath, authorityContext);
    const peerOwners = workspaceLeasePeerOwners(lease, state, filePath);
    if (peerOwners.length) throw new ControllerError(`Cannot release workspace lease: state path belongs to another active task identity: ${peerOwners[0].task_id} (${peerOwners[0].state_path})`);
    const matchingEntries = workspaceLeaseStatePathOwners(lease, filePath)
      .filter(entry => workspaceLeaseEntryMatches(entry, state, filePath, { activeOnly: false }));
    const matchingEntry = matchingEntries.find(entry => entry.phase === 'active') ?? null;
    if (state.workspace_lease.status === 'released' && !matchingEntries.length) return { released: true, already_released: true, lease_path: leasePath };
    if (state.workspace_lease.status === 'released') {
      lease.active_tasks = lease.active_tasks.filter(entry => !workspaceLeaseEntryMatches(entry, state, filePath, { activeOnly: false })); lease.updated_at = utcNow(); await writeWorkspaceLeaseRegistry(authorityContext, leasePath, lease);
      return { released: true, already_released: true, self_healed: true, lease_path: leasePath };
    }
    if (!matchingEntry) throw new ControllerError(`Workspace lease does not belong to this active task: ${leasePath}`);
    if (state.workspace_lease.status !== 'released') {
      state.workflow_revision ??= 0; state.events ??= []; state.updated_at = utcNow();
      state.workspace_lease.workspace_claims ??= state.workspace_claims;
      state.workspace_lease.status = 'released'; state.workspace_lease.released_at = utcNow();
      addEvent(state, 'workspace_lease_released', { close_allowed: closeAllowed }); await writeState(filePath, state);
    }
    lease.active_tasks = lease.active_tasks.filter(entry => !workspaceLeaseEntryMatches(entry, state, filePath, { activeOnly: false })); lease.updated_at = utcNow(); await writeWorkspaceLeaseRegistry(authorityContext, leasePath, lease);
      return { released: true, lease_path: leasePath };
    }, { parentAuthority });
  }, { allowAuthorityMigration: true });
}

async function initTask(parameters) {
  const manifest = await readJson(parameters.manifest, { label: 'Manifest', maxBytes: MAX_MANIFEST_BYTES });
  const state = await makeState(manifest);
  const filePath = await configuredStatePath(parameters, state.task_id);
  const leasePath = workspaceLeasePath(state.workspace);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const parentAuthority = await snapshotRegularDirectory(path.dirname(filePath), 'Controller state parent');
  state.workspace_lease = { registry_path: leasePath, state_path: filePath, state_parent_authority: parentAuthority, status: 'active', acquired_at: utcNow(), workspace_claims: state.workspace_claims };
  await withWorkspaceLeaseLock(state.workspace, async (lockedLeasePath, authorityContext) => {
    if (lockedLeasePath !== leasePath) throw new ControllerError('Workspace lease authority path changed during initialization');
    const lease = await loadWorkspaceLease(leasePath, state.workspace, { allowMissing: true, authorityContext });
    if (lease.active_tasks.length >= MAX_WORKSPACE_ACTIVE_TASKS) throw new ControllerError(`Workspace lease exceeds the ${MAX_WORKSPACE_ACTIVE_TASKS}-active-task limit`);
    const existingStatePath = lease.active_tasks.find(entry => sameStatePath(entry.state_path, filePath));
    if (existingStatePath) throw new ControllerError(`Workspace state path already has an active lease entry: ${filePath}; reconcile this exact workspace/task/state_dir entry before initializing again`);
    const conflict = lease.active_tasks.find(entry => claimsConflict(entry.workspace_claims, state.workspace_claims));
    if (conflict) throw new ControllerError(`Workspace claim conflicts with active workflow task: ${conflict.task_id} (${conflict.state_path})`);
    await withStateLock(filePath, async () => {
      if (await stateExists(filePath)) throw new ControllerError(`Task already exists: ${state.task_id}`);
      const entry = { task_id: state.task_id, state_path: filePath, state_dir: path.dirname(filePath), state_parent_authority: parentAuthority, acquired_at: state.workspace_lease.acquired_at, phase: 'initializing', workspace_claims: state.workspace_claims };
      lease.active_tasks.push(entry);
      await validateWorkspaceLease(lease, leasePath);
      lease.updated_at = utcNow(); await writeWorkspaceLeaseRegistry(authorityContext, leasePath, lease);
      try { await writeState(filePath, state, { parentAuthority }); }
      catch (error) {
        lease.active_tasks = lease.active_tasks.filter(candidate => candidate !== entry); lease.updated_at = utcNow(); await writeWorkspaceLeaseRegistry(authorityContext, leasePath, lease);
        throw error;
      }
    }, { parentAuthority });
    const entry = lease.active_tasks.find(candidate => workspaceLeaseEntryMatches(candidate, state, filePath, { activeOnly: false }));
    if (!entry) throw new ControllerError(`Initializing workspace lease disappeared: ${leasePath}`);
    entry.phase = 'active'; lease.updated_at = utcNow();
    try { await writeWorkspaceLeaseRegistry(authorityContext, leasePath, lease); }
    catch (error) {
      await deleteState(filePath, { parentAuthority });
      lease.active_tasks = lease.active_tasks.filter(candidate => candidate !== entry); lease.updated_at = utcNow(); await writeWorkspaceLeaseRegistry(authorityContext, leasePath, lease);
      throw error;
    }
  }, { allowAuthorityMigration: true });
  return { state_path: filePath, task: compactState(state) };
}

async function reconcileWorkspace(parameters) {
  const workspace = await canonicalWorkspace(parameters.workspace);
  const leasePath = workspaceLeasePath(workspace);
  return withWorkspaceLeaseLock(workspace, async (lockedLeasePath, authorityContext) => {
    if (lockedLeasePath !== leasePath) throw new ControllerError('Workspace lease authority path changed during reconciliation');
    const lease = await loadWorkspaceLease(leasePath, workspace, { authorityContext });
    let candidates = lease.active_tasks.filter(entry => entry.phase === 'initializing');
    if (parameters.task_id !== undefined || parameters.state_dir !== undefined) {
      const taskId = requiredString(parameters.task_id, 'task_id'); const stateDir = await canonicalStateDirectory(parameters.state_dir);
      candidates = candidates.filter(entry => entry.task_id === taskId && sameStatePath(entry.state_dir, stateDir));
      if (!candidates.length) return { workspace, lease_path: leasePath, reconciled: false, reason: 'target initializing task is absent' };
    }
    if (!candidates.length) return { workspace, lease_path: leasePath, reconciled: false, reason: 'no initializing task' };
    if (candidates.length !== 1) throw new ControllerError('reconcile-workspace requires workspace, task_id, and state_dir when multiple initializing tasks exist');
    const entry = candidates[0];
    const parentAuthority = entry.state_parent_authority;
    if (parentAuthority === undefined) throw new ControllerError(`Initializing workspace lease parent authority is missing; controlled recovery is required: ${leasePath}`);
    if (!validStateParentAuthority(parentAuthority, entry.state_path)) throw new ControllerError(`Invalid workspace lease state parent authority: ${leasePath}`);
    await verifyRegularDirectorySnapshot(parentAuthority, 'Controller state parent');
    return withStateLock(entry.state_path, async () => {
      let state;
      try { state = normalizeState(await loadState(entry.state_path)); }
      catch (error) {
        if (error instanceof ControllerError && (error.message.startsWith('JSON input does not exist:') || error.message.startsWith('Controller state does not exist:'))) {
          lease.active_tasks = lease.active_tasks.filter(candidate => candidate !== entry); lease.updated_at = utcNow(); await writeWorkspaceLeaseRegistry(authorityContext, leasePath, lease);
          return { workspace, lease_path: leasePath, reconciled: true, action: 'cleared_missing_initialization', task_id: entry.task_id, state_dir: entry.state_dir };
        }
        throw error;
      }
      if (state.task_id !== entry.task_id || state.workspace !== workspace || state.workspace_lease?.registry_path !== leasePath || !sameStatePath(state.workspace_lease?.state_path, entry.state_path) || state.workspace_lease?.acquired_at !== entry.acquired_at || !sameJson(stateWorkspaceClaims(state), entry.workspace_claims)) throw new ControllerError(`Initializing workspace lease does not match its task state: ${leasePath}`);
      const stateParentAuthority = await stateParentAuthorityForState(state, entry.state_path);
      if (!sameStateParentAuthority(stateParentAuthority, parentAuthority)) throw new ControllerError(`Initializing task state parent authority changed: ${entry.state_path}`);
      await attachStateParentAuthority(state, entry.state_path, parentAuthority);
      if (state.workspace_lease.status === 'released') {
        lease.active_tasks = lease.active_tasks.filter(candidate => candidate !== entry); lease.updated_at = utcNow(); await writeWorkspaceLeaseRegistry(authorityContext, leasePath, lease);
        return { workspace, lease_path: leasePath, reconciled: true, action: 'cleared_released_initialization', task_id: entry.task_id, state_dir: entry.state_dir };
      }
      if (state.workspace_lease.status !== 'active') throw new ControllerError(`Initializing task state has unsupported lease status: ${state.workspace_lease.status}`);
      entry.phase = 'active'; lease.updated_at = utcNow(); await writeWorkspaceLeaseRegistry(authorityContext, leasePath, lease);
      return { workspace, lease_path: leasePath, reconciled: true, action: 'activated_existing_initialization', active_task: entry };
    }, { parentAuthority });
  }, { allowAuthorityMigration: true });
}

async function addNode(parameters) {
  void parameters;
  throw new ControllerError('Task DAG is immutable after workflow_init; create a replacement workflow task for additional work');
}

async function raiseAssurance(parameters) {
  const rawAssessment = await readJson(parameters.assurance_assessment, { label: 'Assurance assessment', maxBytes: MAX_REVIEW_BYTES });
  const nextAssessment = assuranceAssessment(rawAssessment);
  const [filePath] = await readTask(parameters);
  const targetLevel = requiredString(parameters.target_assurance_level, 'target_assurance_level');
  const reason = requiredString(parameters.reason, 'reason');
  const replacement = requiredString(parameters.replacement_agent_task_path, 'replacement_agent_task_path');
  const integrationOwner = requiredString(parameters.integration_owner, 'integration_owner');
  return withActiveWorkspaceStateLock(filePath, async state => {
    if (![2, REVIEW_PROTOCOL_VERSION].includes(state.routing_schema_version)) throw new ControllerError('Only a v2 or v3 task can raise assurance_level');
    const rank = { verification: 0, terra: 1, sol: 2 };
    if (!hasOwn(rank, targetLevel) || rank[targetLevel] <= rank[state.assurance_level]) {
      throw new ControllerError('target_assurance_level must be higher than the current assurance_level');
    }
    requireAssuranceLevelMatches(targetLevel, nextAssessment, 'target_assurance_level');
    if (state.reviews.length || state.repair_records.length || state.verification_record) {
      throw new ControllerError('assurance_level can only be raised before the terminal assurance gate starts');
    }
    if (participantPaths(state).has(replacement)) throw new ControllerError('The raised assurance gate reviewer must not be a prior participant');
    if (Object.values(state.nodes).some(node => node.execution_owner === replacement)) {
      throw new ControllerError(`replacement_agent_task_path is already reserved by another node: ${replacement}`);
    }

    const priorLevel = state.assurance_level;
    const priorAssessment = state.assurance_assessment;
    let reviewNode;
    if (priorLevel === 'verification') {
      if (isReviewProtocolState(state)) throw new ControllerError('A v3 task cannot start from verification assurance');
      if (Object.keys(state.nodes).length >= MAX_NODES) throw new ControllerError(`Task already has the ${MAX_NODES}-node limit`);
      const reviewNodeId = requiredIdentifier(parameters.review_node_id, 'review_node_id');
      if (hasOwn(state.nodes, reviewNodeId)) throw new ControllerError(`Duplicate node id: ${reviewNodeId}`);
      reviewNode = nodeRecord({
        id: reviewNodeId,
        kind: targetLevel === 'terra' ? QUALITY_REVIEW_KIND : 'total_review',
        depends_on: Object.keys(state.nodes),
        execution_risk: 'read_only',
        routing_reason: reason,
        execution_owner: replacement,
        integration_owner: integrationOwner,
        quality_guard: 'Review the complete task requirements, implementation evidence, verification evidence, scope, regressions, gaps, and residual risk.',
      }, { routingRequired: true, routingSchemaVersion: 2, expectedTaskId: state.task_id });
      state.nodes[reviewNodeId] = reviewNode;
    } else {
      if (targetLevel !== 'sol') throw new ControllerError('A terra assurance task can only be raised to sol');
      if (hasOwn(parameters, 'review_node_id')) throw new ControllerError('review_node_id is only valid when raising a verification task');
      reviewNode = reviewNodesForState(state)[0];
      if (!reviewNode || reviewNode.kind !== QUALITY_REVIEW_KIND || reviewNode.status !== PENDING || reviewNode.claim_id || reviewNode.attempt !== 0) {
        throw new ControllerError('Terra assurance can only be raised before its terminal review gate is claimed');
      }
      if (isReviewProtocolState(state)) {
        applyProtocolStage(reviewNode, 'sol_high');
        state.review_entry_stage = 'sol_high';
      } else {
        reviewNode.kind = 'total_review';
        reviewNode.review_stage = 'sol';
        reviewNode.agent_type = 'avsp_sol_high';
      }
      reviewNode.execution_owner = replacement;
      reviewNode.integration_owner = integrationOwner;
      reviewNode.routing_reason = reason;
    }

    state.assurance_level = targetLevel;
    state.assurance_assessment = nextAssessment;
    validateNodes(state.nodes);
    validateReviewTopology(state.nodes, state.assurance_level, state.routing_schema_version, state.review_entry_stage);
    bumpWorkflowRevision(state, 'assurance_level_raised', {
      from: priorLevel,
      to: targetLevel,
      reason,
      review_node_id: reviewNode.id,
      prior_assurance_assessment: priorAssessment,
      assurance_assessment: nextAssessment,
    });
    await writeState(filePath, state);
    return { task_id: state.task_id, prior_assurance_level: priorLevel, assurance_level: targetLevel, effective_assurance_level: effectiveAssuranceLevel(state), assurance_assessment: nextAssessment, node: reviewNode, ready_nodes: readyNodes(state) };
  });
}

async function rebindPendingOwner(parameters) {
  const [filePath] = await readTask(parameters);
  const nodeId = requiredIdentifier(parameters.node_id, 'node_id');
  const reason = requiredString(parameters.reason, 'reason');
  retryConfirmation(parameters);
  return withActiveWorkspaceStateLock(filePath, async state => {
    const node = state.nodes[nodeId];
    if (!node || node.status !== PENDING || node.claim_id || node.agent_task_path) throw new ControllerError(`Only an unclaimed pending node can rebind execution_owner: ${nodeId}`);
    if (node.routing_legacy) throw new ControllerError('A legacy node does not support execution_owner rebinding');
    nodeAttemptAvailability(node, nodeId);
    const replacement = replacementExecutionOwner(state, node, parameters);
    if (replacement === node.execution_owner) throw new ControllerError('replacement_agent_task_path must differ from the current execution_owner');
    const priorExecutionOwner = rebindExecutionOwner(node, replacement);
    bumpWorkflowRevision(state, 'pending_owner_rebound', { node_id: nodeId, prior_execution_owner: priorExecutionOwner, replacement_execution_owner: replacement, reason, previous_agent_stopped: true });
    await writeState(filePath, state);
    return { task_id: state.task_id, node, ready_nodes: readyNodes(state) };
  });
}

function gateInvalidationReasons(reasons) {
  return reasons.filter(reason => reason.startsWith('task state changed after ') || reason.startsWith('workspace changed after '));
}

async function invalidateGate(parameters) {
  const [filePath] = await readTask(parameters);
  const reason = requiredString(parameters.reason, 'reason');
  return withActiveWorkspaceStateLock(filePath, async state => {
    const invalidationReasons = gateInvalidationReasons(await closeReasons(state));
    if (!invalidationReasons.length) throw new ControllerError('The terminal assurance gate is not invalidated by a task or workspace change');
    if (state.assurance_level === 'verification') {
      if (!state.verification_record) throw new ControllerError('No verification record exists to invalidate');
      const priorRecord = state.verification_record;
      const invalidatedAt = utcNow();
      const historyEntry = { verification_record: priorRecord, invalidated_at: invalidatedAt, invalidation_reason: reason, invalidation_reasons: invalidationReasons };
      const retainedHistory = [...state.verification_history, historyEntry];
      const discardedHistoryCount = Math.max(0, retainedHistory.length - MAX_VERIFICATION_HISTORY);
      state.verification_history = retainedHistory.slice(-MAX_VERIFICATION_HISTORY);
      state.verification_record = null;
      bumpWorkflowRevision(state, 'verification_invalidated', { reason, invalidation_reasons: invalidationReasons, prior_recorded_at: priorRecord.recorded_at, invalidated_at: invalidatedAt, verification_history_discarded: discardedHistoryCount });
      await writeState(filePath, state);
      return { task_id: state.task_id, assurance_level: state.assurance_level, effective_assurance_level: effectiveAssuranceLevel(state), gate_kind: 'verification', invalidation_reasons: invalidationReasons, node: null, ready_nodes: readyNodes(state) };
    }
    const node = reviewNodesForState(state)[0];
    if (!node || node.status !== SUCCEEDED) {
      throw new ControllerError('Only a succeeded terminal review with a recorded pass can be invalidated');
    }
    const cohortNode = isCohortReviewNode(state, node);
    const closureNode = isMaxClosureNode(state, node);
    const latestReview = state.reviews.at(-1);
    if (cohortNode) {
      const cohort = node.review_gate.cohort;
      const finalReviews = currentCohortReviews(state, node, 'cross_questioning').filter(review => review.verdict === 'pass' && reviewCompletion(state, review).status === SUCCEEDED);
      if (cohort.phase !== 'passed' || cohort.aggregate?.verdict !== 'pass' || finalReviews.length !== COHORT_SLOTS.length) throw new ControllerError('Only a passed Terra cohort can be invalidated');
    } else if (!latestReview || latestReview.verdict !== 'pass' || latestReview.node_id !== node.id || latestReview.claim_id !== node.claim_id) {
      throw new ControllerError('Only a succeeded terminal review with a recorded pass can be invalidated');
    }
    if (closureNode) {
      const charter = requireMaxReviewCharter(state, node);
      if (charter.status !== 'closure_passed' || charter.scope_decision_required) throw new ControllerError('Only a passed max closure can be invalidated');
    }
    const reviewerSlot = cohortNode ? optionalString(parameters.reviewer_slot, 'reviewer_slot') ?? 'coverage' : null;
    if (reviewerSlot && !COHORT_SLOTS.includes(reviewerSlot)) throw new ControllerError(`reviewer_slot must be one of: ${COHORT_SLOTS.join(', ')}`);
    if (cohortNode) nodeAttemptAvailability(node.review_gate.cohort.lanes[reviewerSlot], node.id);
    else nodeAttemptAvailability(node, node.id);
    const replacement = replacementExecutionOwner(state, node, parameters);
    const priorExecutionOwner = rebindExecutionOwner(node, replacement);
    const priorClaimId = cohortNode ? `cohort:${node.review_gate.cohort.round_id}` : node.claim_id;
    clearRescueRouting(node);
    if (cohortNode) {
      resetCohortRound(node, reviewerSlot, replacement);
      clearAttemptForRetry(node);
    } else {
      if (closureNode) {
        const charter = requireMaxReviewCharter(state, node);
        charter.status = 'closure_ready';
        charter.scope_decision_required = false;
        charter.pending_repair_source_claim_id = null;
        charter.active_closure_claim_id = null;
        charter.closure_attempt_count = Math.max(0, charter.closure_attempt_count - 1);
      }
      clearAttemptForRetry(node);
    }
    bumpWorkflowRevision(state, 'review_gate_invalidated', { node_id: node.id, reviewer_slot: reviewerSlot, prior_claim_id: priorClaimId, prior_execution_owner: priorExecutionOwner, replacement_execution_owner: replacement, reason, invalidation_reasons: invalidationReasons });
    await writeState(filePath, state);
    return { task_id: state.task_id, assurance_level: state.assurance_level, effective_assurance_level: effectiveAssuranceLevel(state), gate_kind: node.kind, invalidation_reasons: invalidationReasons, node, ready_nodes: readyNodes(state) };
  });
}

async function claimNode(parameters, activateImmediately = false) {
  const [filePath] = await readTask(parameters); const nodeId = requiredIdentifier(parameters.node_id, 'node_id'); const taskPath = requiredString(parameters.agent_task_path, 'agent_task_path'); const threadId = optionalString(parameters.agent_thread_id, 'agent_thread_id'); const role = requiredString(parameters.agent_role, 'agent_role'); const leaseDurationSec = positiveInteger(parameters.lease_duration_sec, 'lease_duration_sec', DEFAULT_LEASE_SEC); const activationTimeoutSec = positiveInteger(parameters.activation_timeout_sec, 'activation_timeout_sec', Math.min(DEFAULT_ACTIVATION_TIMEOUT_SEC, leaseDurationSec));
  if (activateImmediately) trueValue(parameters.native_agent_started, 'native_agent_started');
  return withActiveWorkspaceStateLock(filePath, async state => {
    const node = state.nodes[nodeId];
    const cohortNode = isCohortReviewNode(state, node);
    if (!node || (!cohortNode && !readyNodes(state).some(candidate => candidate.id === nodeId))) throw new ControllerError(`Node is not ready: ${nodeId}`);
    let cohortLane = null;
    if (cohortNode) {
      const slot = requiredString(parameters.reviewer_slot, 'reviewer_slot');
      if (!COHORT_SLOTS.includes(slot)) throw new ControllerError(`reviewer_slot must be one of: ${COHORT_SLOTS.join(', ')}`);
      const cohort = node.review_gate.cohort;
      if (!['blind', 'cross_questioning'].includes(cohort.phase)) throw new ControllerError(`The Terra cohort cannot accept claims in phase: ${cohort.phase}`);
      cohortLane = cohort.lanes[slot];
      if (!cohortLane || cohortLane.status !== PENDING) throw new ControllerError(`The Terra cohort lane is not ready: ${slot}`);
      if (cohortLane.reserved_agent_task_path && cohortLane.reserved_agent_task_path !== taskPath) throw new ControllerError(`The Terra cohort lane is reserved for a replacement reviewer: ${slot}`);
      if (!node.depends_on.every(dependency => [SUCCEEDED, 'skipped'].includes(state.nodes[dependency].status))) throw new ControllerError(`Node is not ready: ${nodeId}`);
    }
    if (runningParticipantPaths(state).has(taskPath)) throw new ControllerError('Agent already has a running node in this task');
    const reviewNode = isReviewNode(node, state.routing_schema_version);
    if (reviewNode && participantPaths(state).has(taskPath)) {
      throw new ControllerError(node.kind === 'total_review' ? 'A prior participant cannot claim the total review' : 'A prior participant cannot claim a review gate');
    }
    const expectedAgentType = node.rescue_role ?? node.agent_type;
    const lunaFallback = node.kind !== 'total_review' && node.execution_risk === 'read_only' && READ_ONLY_FALLBACK_ROLES.get(node.agent_type) === role;
    const solFallback = SOL_ROLES.has(node.agent_type) && role === FALLBACK_ROLE && node.rescue_role === null && (node.kind === 'total_review' || node.execution_risk === 'read_only');
    const fallbackRole = lunaFallback || solFallback;
    const fallbackReason = optionalString(parameters.fallback_reason, 'fallback_reason');
    if (node.kind === 'total_review' && !SOL_ROLES.has(role) && role !== FALLBACK_ROLE) throw new ControllerError('A total_review node requires a Sol role or the configured Terra fallback');
    if (node.kind === 'total_review' && role === FALLBACK_ROLE && !solFallback) throw new ControllerError('The total-review Terra role is fallback-only for a configured Sol reviewer');
    if (reviewNode && node.kind === QUALITY_REVIEW_KIND && role !== TERRA_REVIEW_ROLE) throw new ControllerError('A quality_review node requires avsp_terra_xhigh');
    if (node.kind !== 'total_review' && READ_ONLY_FALLBACK_ROLE_SET.has(role) && !fallbackRole) throw new ControllerError('The Terra read-only role is fallback-only for its configured Luna or Sol reviewer');
    if (expectedAgentType && expectedAgentType !== role && !fallbackRole) throw new ControllerError(`Node agent_type must match claimed role: ${expectedAgentType}`);
    if (fallbackRole && !fallbackReason) throw new ControllerError('Terra fallback requires fallback_reason');
    // Total reviews are read-only guards, not protected execution work.
    if (node.execution_risk === 'protected' && node.kind !== 'total_review' && role !== PROTECTED_EXECUTOR_ROLE) throw new ControllerError('Only avsp_terra_high can claim protected work');
    if (node.execution_risk === 'read_only' && node.kind !== 'total_review' && !READ_ONLY_ROLES.has(role)) throw new ControllerError('A read_only node requires a configured read-only role');
    if (node.execution_risk === 'delegable' && !LUNA_EXECUTOR_ROLES.has(role) && role !== PROTECTED_EXECUTOR_ROLE && !(node.rescue_role === ROOT_RESCUE_ROLE && role === ROOT_RESCUE_ROLE)) throw new ControllerError('A delegable node requires a Luna executor or legacy writer, avsp_terra_high, or an explicit main/root rescue');
    if (node.execution_risk === 'delegable' && LEGACY_LUNA_WRITER_ROLES.has(role) && node.agent_type !== role) throw new ControllerError('A legacy Luna writer requires an explicitly matching node agent_type');
    if (LUNA_EXECUTOR_ROLES.has(role)) {
      if (node.routing_legacy || node.execution_risk !== 'delegable') throw new ControllerError('A Luna executor requires complete delegable routing metadata');
      if (node.execution_owner !== taskPath) throw new ControllerError('Luna executor claim must match node execution_owner');
    }
    if (!cohortNode && !node.routing_legacy && node.execution_owner !== taskPath) throw new ControllerError('Node claim must match execution_owner');
    if (isMaxClosureNode(state, node)) {
      const charter = requireMaxReviewCharter(state, node);
      if (charter.status !== 'closure_ready' || charter.scope_decision_required) throw new ControllerError(`The max review charter cannot be claimed for closure: ${charter.status}`);
      if (charter.closure_attempt_count >= charter.closure_attempt_limit) throw new ControllerError('The max review charter exhausted its controlled closure attempts');
      charter.status = 'closure_reviewing';
      charter.closure_attempt_count += 1;
      charter.active_closure_claim_id = null;
    }
    nodeAttemptAvailability(cohortLane ?? node, nodeId);
    const now = utcNow();
    if (cohortLane) {
      cohortLane.status = RUNNING; cohortLane.reserved_agent_task_path = null; cohortLane.agent_task_path = taskPath; cohortLane.agent_thread_id = threadId; cohortLane.agent_role = role; cohortLane.claim_id = randomUUID(); if (node.review_gate.cohort.phase === 'blind') cohortLane.blind_review_claim_id = cohortLane.claim_id; else cohortLane.cross_review_claim_id = cohortLane.claim_id; cohortLane.claimed_at = now; cohortLane.activation_at = activateImmediately ? now : null; cohortLane.activation_deadline_at = activateImmediately ? null : new Date(Date.now() + activationTimeoutSec * 1000).toISOString(); cohortLane.heartbeat_at = now; cohortLane.heartbeat_count = activateImmediately ? 1 : 0; cohortLane.lease_duration_sec = leaseDurationSec; cohortLane.attempt += 1; cohortLane.attempt_budget_used += 1;
      node.status = RUNNING;
    } else {
      node.status = RUNNING; node.agent_task_path = taskPath; node.agent_thread_id = threadId; node.agent_role = role; node.claim_id = randomUUID(); node.claimed_at = now; node.activation_at = activateImmediately ? now : null; node.activation_deadline_at = activateImmediately ? null : new Date(Date.now() + activationTimeoutSec * 1000).toISOString(); node.heartbeat_at = now; node.heartbeat_count = activateImmediately ? 1 : 0; node.lease_duration_sec = leaseDurationSec; node.attempt += 1; node.attempt_budget_used += 1;
    }
    if (isMaxClosureNode(state, node)) state.max_review_charter.active_closure_claim_id = node.claim_id;
    const activeClaim = cohortLane ?? node;
    state.participants.push({ agent_task_path: taskPath, agent_thread_id: threadId, agent_role: role, node_id: nodeId, claim_id: activeClaim.claim_id, attempt: activeClaim.attempt, reviewer_slot: cohortLane?.slot ?? null, fallback_reason: fallbackReason });
    addEvent(state, 'node_claimed', { node_id: nodeId, agent_task_path: taskPath, agent_thread_id: threadId, agent_role: role, claim_id: activeClaim.claim_id, reviewer_slot: cohortLane?.slot ?? null, attempt: activeClaim.attempt, fallback_reason: fallbackReason });
    if (activateImmediately) addEvent(state, 'node_started', { node_id: nodeId, agent_task_path: taskPath, agent_thread_id: threadId, agent_role: role, claim_id: activeClaim.claim_id, reviewer_slot: cohortLane?.slot ?? null, native_agent_started: true });
    await writeState(filePath, state);
    return { task_id: state.task_id, node, reviewer_slot: cohortLane?.slot ?? null, claim_id: activeClaim.claim_id };
  });
}

function requireActiveClaim(node, parameters) {
  const claimId = requiredString(parameters.claim_id, 'claim_id');
  if (!node || node.status !== RUNNING) throw new ControllerError(`Only a running node accepts this operation: ${parameters.node_id}`);
  if (!node.claim_id || node.claim_id !== claimId) throw new ControllerError(`Claim does not own node: ${parameters.node_id}`);
  return claimId;
}

function activeClaimForOperation(state, node, parameters) {
  if (isCohortReviewNode(state, node)) {
    const claimId = requiredString(parameters.claim_id, 'claim_id');
    const lane = cohortLaneForClaim(node, claimId);
    if (!lane || lane.status !== RUNNING) throw new ControllerError(`Claim does not own an active Terra cohort lane: ${parameters.node_id}`);
    return lane;
  }
  requireActiveClaim(node, parameters);
  return node;
}

function hasRecordedReview(state, node) {
  return state.reviews.some(review => review.auditor_task === node.agent_task_path && review.claim_id === node.claim_id);
}

function hasRecordedPassingReview(state, node) {
  if (isCohortReviewNode(state, node)) return node.review_gate.cohort?.aggregate?.verdict === 'pass';
  return state.reviews.some(review => review.auditor_task === node.agent_task_path && review.claim_id === node.claim_id && review.verdict === 'pass');
}

function reviewCompletion(state, review) {
  const completionEvent = [...state.events].reverse().find(event => (event.type === 'node_completed' || event.type === 'terra_cohort_lane_completed') && event.node_id === review.node_id && event.claim_id === review.claim_id) ?? (() => {
    const reviews = state.reviews.filter(candidate => candidate.node_id === review.node_id && !state.events.some(event => event.type === 'node_completed' && event.node_id === candidate.node_id && event.claim_id === candidate.claim_id)).sort((left, right) => Date.parse(left.recorded_at) - Date.parse(right.recorded_at));
    const legacyEvents = state.events.filter(event => event.type === 'node_completed' && event.node_id === review.node_id && !hasOwn(event, 'claim_id')).sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
    const used = new Set();
    for (const candidate of reviews) {
      const recordedAt = Date.parse(candidate.recorded_at);
      const eventIndex = legacyEvents.findIndex((event, index) => !used.has(index) && (!Number.isFinite(recordedAt) || !Number.isFinite(Date.parse(event.at)) || Date.parse(event.at) >= recordedAt));
      if (eventIndex >= 0) {
        used.add(eventIndex);
        if (candidate === review) return legacyEvents[eventIndex];
      }
    }
    return null;
  })();
  return {
    status: review.completion_status ?? completionEvent?.status ?? null,
    completion_attestation: review.completion_attestation ?? completionEvent?.completion_attestation ?? null,
  };
}

function isFinalFailedReview(state, review) {
  return review.verdict === 'fail' && reviewCompletion(state, review).status === 'failed';
}

function finalFailedTerraReviews(state, node) {
  return state.reviews.filter(review => review.node_id === node.id && review.auditor_role === TERRA_REVIEW_ROLE && isFinalFailedReview(state, review));
}

function requireRecordedTerraRepair(state, node) {
  const failedReviews = finalFailedTerraReviews(state, node);
  if (failedReviews.length !== 1) return null;
  const sourceReview = failedReviews[0];
  const repair = [...state.repair_records].reverse().find(record => record.source_review_claim_id === sourceReview.claim_id);
  if (!repair) throw new ControllerError('The first Terra fail requires a recorded repair before the second Terra review');
  return repair;
}

function nextTotalReviewRole(state, node) {
  if (!node || node.kind !== 'total_review') return null;
  const reviews = state.reviews.filter(review => review.node_id === node.id);
  const latest = reviews.at(-1);
  const currentRole = SOL_ESCALATION_ORDER.includes(node.agent_type) ? node.agent_type : 'avsp_sol_high';
  if (!latest || latest.auditor_role !== currentRole || !isFinalFailedReview(state, latest)) return currentRole;
  const latestIndex = SOL_ESCALATION_ORDER.indexOf(currentRole);
  if (latestIndex < 0) return currentRole;
  if (currentRole === 'avsp_sol_high') {
    let consecutiveHighFailures = 0;
    for (let index = reviews.length - 1; index >= 0; index -= 1) {
      const review = reviews[index];
      if (review.auditor_role !== 'avsp_sol_high' || !isFinalFailedReview(state, review)) break;
      consecutiveHighFailures += 1;
    }
    if (consecutiveHighFailures >= 2) return 'avsp_sol_xhigh';
  } else if (currentRole === 'avsp_sol_xhigh') {
    return 'avsp_sol_max';
  }
  return SOL_ESCALATION_ORDER[Math.min(latestIndex, SOL_ESCALATION_ORDER.length - 1)];
}

function requireRecordedProtocolRepair(state, sourceReview) {
  if (!sourceReview || !isFinalFailedReview(state, sourceReview)) throw new ControllerError('A protocol stage can advance only from a finalized failed review');
  const repair = [...state.repair_records].reverse().find(record => record.source_review_claim_id === sourceReview.claim_id);
  if (!repair) throw new ControllerError(`The failed ${sourceReview.auditor_role} review requires a recorded repair before the next review stage`);
  return repair;
}

function protocolLatestFailedReview(state, node) {
  return [...state.reviews].reverse().find(review => review.node_id === node.id && isFinalFailedReview(state, review)) ?? null;
}

function finalizedLatestReview(state, node) {
  const latest = state.reviews.filter(review => review.node_id === node.id).at(-1);
  return latest && isFinalFailedReview(state, latest) ? latest : null;
}

function nextReviewRoute(state, node) {
  if (node.kind === QUALITY_REVIEW_KIND) {
    const failedTerraReviews = finalFailedTerraReviews(state, node);
    if (failedTerraReviews.length >= 2) {
      return { kind: 'total_review', review_stage: 'sol', agent_type: 'avsp_sol_high', escalated: true };
    }
    return { kind: QUALITY_REVIEW_KIND, review_stage: 'terra', agent_type: TERRA_REVIEW_ROLE, escalated: false };
  }
  if (node.kind === 'total_review') {
    return { kind: 'total_review', review_stage: 'sol', agent_type: nextTotalReviewRole(state, node), escalated: false };
  }
  return null;
}

function hasWorkflowOutcomeMarker(result) {
  return Boolean(result && typeof result === 'object' && !Array.isArray(result) && result.workflow !== null && result.workflow !== undefined);
}

function validWorkflowArtifactSegment(value) {
  return typeof value === 'string' && value.length > 0 && path.basename(value) === value && value !== '.' && value !== '..';
}

function workflowArtifactResultPath(parameters) {
  if (!validWorkflowArtifactSegment(parameters.task_id) || !validWorkflowArtifactSegment(parameters.claim_id)) throw new ControllerError('Workflow artifact task_id and claim_id must be path-safe identifiers');
  return path.join(path.resolve(parameters.state_dir), REVIEW_ARTIFACT_DIRECTORY, parameters.task_id, parameters.claim_id, 'outcome.json');
}

async function prepareWorkflowArtifactAuthority(parameters) {
  const stateDir = await canonicalStateDirectory(parameters.state_dir, 'workflow artifact state_dir');
  const targetDirectory = path.dirname(workflowArtifactResultPath({ ...parameters, state_dir: stateDir }));
  const rootMetadata = await fs.lstat(stateDir, { bigint: true });
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) throw new ControllerError(`Workflow artifact state directory is unsafe: ${stateDir}`);
  const rootRealPath = await fs.realpath(stateDir);
  const directories = [{ path: stateDir, real_path: rootRealPath, identity: workspaceDirectoryIdentity(rootMetadata) }];
  let current = stateDir;
  for (const segment of [REVIEW_ARTIFACT_DIRECTORY, parameters.task_id, parameters.claim_id]) {
    current = path.join(current, segment);
    try { await fs.mkdir(current); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const metadata = await fs.lstat(current, { bigint: true });
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new ControllerError(`Workflow artifact directory must not contain a symbolic link or reparse point: ${current}`);
    const realPath = await fs.realpath(current);
    if (!pathIsWithinPhysicalRoot(rootRealPath, realPath)) throw new ControllerError(`Workflow artifact directory escapes the canonical state directory: ${current}`);
    directories.push({ path: current, real_path: realPath, identity: workspaceDirectoryIdentity(metadata) });
  }
  return { version: 1, platform: process.platform, root_real_path: rootRealPath, target_directory: targetDirectory, target_real_path: directories.at(-1).real_path, directories };
}

async function validateWorkflowArtifactAuthority(authority, parameters, { resultMustExist = true, resultSnapshot = null } = {}) {
  const fields = new Set(['version', 'platform', 'root_real_path', 'target_directory', 'target_real_path', 'directories']);
  if (!hasExactFields(authority, fields) || authority.version !== 1 || authority.platform !== process.platform || !Array.isArray(authority.directories) || authority.directories.length !== 4) throw new ControllerError('Workflow artifact authority is missing or unsupported');
  const stateDir = await canonicalStateDirectory(parameters.state_dir, 'workflow artifact state_dir');
  const resultPath = workflowArtifactResultPath({ ...parameters, state_dir: stateDir });
  const expectedDirectories = [stateDir, path.join(stateDir, REVIEW_ARTIFACT_DIRECTORY), path.join(stateDir, REVIEW_ARTIFACT_DIRECTORY, parameters.task_id), path.dirname(resultPath)];
  if (!sameStatePath(authority.root_real_path, stateDir) || !sameStatePath(authority.target_directory, expectedDirectories.at(-1)) || !sameStatePath(authority.target_real_path, expectedDirectories.at(-1))) throw new ControllerError('Workflow artifact authority does not match the active claim directory');
  for (let index = 0; index < expectedDirectories.length; index++) {
    const expected = authority.directories[index];
    if (!hasExactFields(expected, new Set(['path', 'real_path', 'identity'])) || !hasExactFields(expected.identity, new Set(['dev', 'ino'])) || !sameStatePath(expected.path, expectedDirectories[index])) throw new ControllerError('Workflow artifact authority directory chain is invalid');
    const metadata = await fs.lstat(expected.path, { bigint: true });
    if (metadata.isSymbolicLink() || !metadata.isDirectory() || !sameWorkspaceDirectoryIdentity(expected.identity, workspaceDirectoryIdentity(metadata)) || !sameStatePath(expected.real_path, await fs.realpath(expected.path))) throw new ControllerError(`Workflow artifact directory identity changed: ${expected.path}`);
  }
  try {
    const resultMetadata = await fs.lstat(resultPath, { bigint: true });
    if (resultMetadata.isSymbolicLink() || !resultMetadata.isFile() || !pathIsWithinPhysicalRoot(authority.target_real_path, await fs.realpath(resultPath))) throw new ControllerError(`Workflow outcome artifact is unsafe: ${resultPath}`);
    if (resultSnapshot && !sameFileIdentity(resultSnapshot.identity, resultMetadata)) throw new ControllerError(`Workflow outcome artifact changed after it was read: ${resultPath}`);
  } catch (error) {
    if (!(error.code === 'ENOENT' && !resultMustExist)) throw error;
  }
  return { result_path: resultPath, authority };
}

async function workflowArtifactTargetAuthority(authority, parameters) {
  await validateWorkflowArtifactAuthority(authority, parameters, { resultMustExist: false });
  const target = authority.directories.at(-1);
  return { path: target.path, real_path: target.real_path, identity: target.identity };
}

async function hasMatchingWorkflowBinding(workflow, parameters, node) {
  if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow) || typeof workflow.state_dir !== 'string'
    || workflow.task_id !== parameters.task_id || workflow.node_id !== parameters.node_id || workflow.claim_id !== parameters.claim_id
    || node.id !== parameters.node_id) return false;
  try {
    const workflowStateDir = await canonicalStateDirectory(workflow.state_dir, 'workflow.state_dir');
    return sameStatePath(workflowStateDir, parameters.state_dir);
  } catch {
    return false;
  }
}

async function isPendingWorkflowOutcome(result, parameters, node, resultSnapshot = null) {
  if (!hasWorkflowOutcomeMarker(result)) return false;
  const workflow = result?.workflow;
  if (!await hasMatchingWorkflowBinding(workflow, parameters, node) || result.workflow_completion?.state !== 'pending') return false;
  try { await validateWorkflowArtifactAuthority(result.workflow_artifact_authority, parameters, { resultSnapshot }); return true; } catch { return false; }
}

async function isFinalizedWorkflowOutcome(result, parameters, node, status, completionAttestation, resultSnapshot = null) {
  if (!hasWorkflowOutcomeMarker(result) || !await hasMatchingWorkflowBinding(result.workflow, parameters, node)) return false;
  try { await validateWorkflowArtifactAuthority(result.workflow_artifact_authority, parameters, { resultSnapshot }); } catch { return false; }
  const completion = result.workflow_completion;
  return Boolean(
    completion && typeof completion === 'object' && !Array.isArray(completion)
    && completion.completed === true && typeof completion.completed_at === 'string' && completion.completed_at.length > 0
    && completion.task_id === parameters.task_id && completion.node_id === parameters.node_id && completion.claim_id === parameters.claim_id
    && completion.status === status && completion.completion_attestation === completionAttestation,
  );
}

function workflowOutcomePayload(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
  const { workflow_completion: _workflowCompletion, ...payload } = result;
  return payload;
}

function workflowOutcomeDigest(result) {
  return createHash('sha256').update(stableJson(workflowOutcomePayload(result))).digest('hex');
}

function workflowCompletionIntentResultDigest(intent) {
  if (typeof intent?.result_digest === 'string' && /^[a-f0-9]{64}$/.test(intent.result_digest)) return intent.result_digest;
  // Older persisted intents predate result_digest but retain the pending result.
  return intent?.result && typeof intent.result === 'object' ? workflowOutcomeDigest(intent.result) : null;
}

function isCompletedWorkflowOutcome(result, state, node) {
  if (!hasWorkflowOutcomeMarker(result)) return false;
  const workflow = result.workflow;
  const completion = result.workflow_completion;
  return Boolean(
    workflow && typeof workflow === 'object' && !Array.isArray(workflow)
    && workflow.task_id === state.task_id && workflow.node_id === node.id && workflow.claim_id === node.claim_id
    && completion && typeof completion === 'object' && !Array.isArray(completion)
    && completion.completed === true && typeof completion.completed_at === 'string' && completion.completed_at.length > 0
    && completion.task_id === state.task_id && completion.node_id === node.id && completion.claim_id === node.claim_id
    && completion.status === node.status && typeof completion.completion_attestation === 'string' && completion.completion_attestation.length > 0,
  );
}

function addWorkflowOutcomeEnvelope(result, parameters, artifactAuthority) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new ControllerError('A total_review result must be a JSON object');
  if (hasWorkflowOutcomeMarker(result)) return result;
  return {
    ...result,
    workflow: {
      state_dir: path.resolve(parameters.state_dir),
      task_id: parameters.task_id,
      node_id: parameters.node_id,
      claim_id: parameters.claim_id,
    },
    workflow_artifact_authority: artifactAuthority,
    workflow_completion: { state: 'pending' },
  };
}

async function finalizeWorkflowOutcome(result, parameters, node, status, completionAttestation, resultSnapshot) {
  if (!await isPendingWorkflowOutcome(result, parameters, node, resultSnapshot)) return null;
  await validateWorkflowArtifactAuthority(result.workflow_artifact_authority, parameters, { resultSnapshot });
  const workflowCompletion = {
    completed: true,
    completed_at: utcNow(),
    task_id: parameters.task_id,
    node_id: parameters.node_id,
    claim_id: parameters.claim_id,
    status,
    completion_attestation: completionAttestation,
  };
  const finalized = { ...result, workflow_completion: workflowCompletion };
  await atomicWrite(parameters.result, finalized, MAX_NODE_RESULT_BYTES, { parentAuthority: await workflowArtifactTargetAuthority(finalized.workflow_artifact_authority, parameters) });
  const finalizedSnapshot = await readJsonSnapshot(parameters.result, { label: 'Workflow outcome', maxBytes: MAX_NODE_RESULT_BYTES });
  if (!sameJson(finalizedSnapshot.value, finalized)) throw new ControllerError(`Workflow outcome changed after finalization: ${parameters.result}`);
  await validateWorkflowArtifactAuthority(finalized.workflow_artifact_authority, parameters, { resultSnapshot: finalizedSnapshot });
  Object.assign(result, finalized);
  return workflowCompletion;
}

function workflowCompletionIntentMatches(intent, parameters, status, completionAttestation) {
  return Boolean(
    intent && typeof intent === 'object' && !Array.isArray(intent)
    && intent.claim_id === parameters.claim_id && intent.task_id === parameters.task_id && intent.node_id === parameters.node_id
    && intent.status === status && intent.completion_attestation === completionAttestation
    && typeof intent.result_path === 'string' && path.resolve(intent.result_path) === path.resolve(parameters.result),
  );
}

async function completeNode(parameters) {
  const status = String(parameters.status); if (!COMPLETABLE.has(status)) throw new ControllerError(`Completion status must be one of: ${[...COMPLETABLE].sort().join(', ')}`);
  const resultSnapshot = await readJsonSnapshot(parameters.result, { label: 'Node result', maxBytes: MAX_NODE_RESULT_BYTES });
  let activeResultSnapshot = resultSnapshot;
  let result = resultSnapshot.value; const [filePath] = await readTask(parameters); const nodeId = requiredIdentifier(parameters.node_id, 'node_id');
  return withActiveWorkspaceStateLock(filePath, async state => {
    const node = state.nodes[nodeId]; const activeClaim = activeClaimForOperation(state, node, parameters); const cohortNode = isCohortReviewNode(state, node);
    await verifyJsonSnapshot(parameters.result, resultSnapshot, 'Node result');
    if (!activeClaim.activation_at || activeClaim.heartbeat_count < 1) throw new ControllerError('An unactivated node cannot be completed; the claiming agent must first call workflow_heartbeat or workflow_start');
    const expectedAttestation = node.rescue_role === ROOT_RESCUE_ROLE && activeClaim.agent_role === ROOT_RESCUE_ROLE
      ? ROOT_RESCUE_SELF_COMPLETION
      : node.kind === 'total_review' && status === 'unavailable' && [NATIVE_AGENT_EXIT_CONFIRMED, NATIVE_AGENT_START_FAILED].includes(parameters.completion_attestation)
        ? parameters.completion_attestation
        : NATIVE_AGENT_FINISHED;
    if (parameters.completion_attestation !== expectedAttestation) throw new ControllerError(`workflow_complete requires completion_attestation=${expectedAttestation}`);
    const reviewNode = isReviewNode(node, state.routing_schema_version);
    if (cohortNode) {
      if (status === 'skipped' || status === 'blocked') throw new ControllerError('A Terra cohort lane can only succeed, fail, or be unavailable');
      const recordedReview = state.reviews.find(review => review.node_id === node.id && review.claim_id === activeClaim.claim_id);
      if (!recordedReview) throw new ControllerError('A Terra cohort lane requires a recorded review for its active claim');
      if ((status === SUCCEEDED && recordedReview.verdict !== 'pass') || (status === 'failed' && recordedReview.verdict !== 'fail') || (status === 'unavailable' && recordedReview.verdict !== 'unavailable')) {
        throw new ControllerError('Terra cohort completion status must match the recorded review verdict');
      }
      recordedReview.completion_status = status;
      recordedReview.completion_attestation = expectedAttestation;
      recordedReview.completed_at = utcNow();
      activeClaim.status = status;
      activeClaim.result = result;
      if (status === 'unavailable') {
        activeClaim.attempt_budget_used = Math.max(0, activeClaim.attempt_budget_used - 1);
        activeClaim.unavailable_attempts += 1;
      }
      addEvent(state, 'terra_cohort_lane_completed', { node_id: node.id, reviewer_slot: activeClaim.slot, claim_id: activeClaim.claim_id, status, completion_attestation: expectedAttestation });
      if (isCohortRoundComplete(node)) {
        const cohort = node.review_gate.cohort;
        if (cohortLanes(node).some(lane => lane.status === 'unavailable')) {
          node.status = 'unavailable';
          cohort.phase = cohort.phase;
        } else if (cohort.phase === 'blind') {
          cohort.phase = 'cross_questioning';
          resetCohortLanes(node);
          node.status = PENDING;
          addEvent(state, 'terra_cohort_blind_round_completed', { node_id: node.id, round_id: cohort.round_id });
        } else {
        const finalReviews = currentCohortReviews(state, node, 'cross_questioning').filter(review => reviewCompletion(state, review).status === (review.verdict === 'pass' ? SUCCEEDED : 'failed'));
          if (finalReviews.length !== COHORT_SLOTS.length || new Set(finalReviews.map(review => review.reviewer_slot)).size !== COHORT_SLOTS.length) throw new ControllerError('A Terra cohort requires one completed cross-questioning review from each lane');
          const failed = finalReviews.filter(review => review.verdict === 'fail');
          const nonconverged = new Set(finalReviews.map(review => review.verdict)).size > 1;
          const verdict = failed.length || nonconverged ? 'fail' : 'pass';
          const findings = failed.flatMap(review => review.findings.filter(finding => finding.severity === 'blocking').map(finding => ({ ...finding, source_finding_id: finding.id, finding_ref: `C${createHash('sha256').update(`${review.claim_id}:${finding.id}`).digest('hex').slice(0, 24)}` })));
          if (nonconverged) {
            findings.push({ id: 'cohort_nonconvergence', source_finding_id: 'cohort_nonconvergence', finding_ref: `C${createHash('sha256').update(`${cohort.round_id}:nonconvergence`).digest('hex').slice(0, 24)}`, severity: 'blocking', requirement_id: null, summary: 'The two Terra cross-review lanes reached different final verdicts.', evidence: 'The bounded cross-questioning round did not converge on a shared final position.' });
          }
          cohort.aggregate = { source_review_claim_id: `cohort:${cohort.round_id}`, verdict, findings, review_claim_ids: finalReviews.map(review => review.claim_id), workspace_fingerprint: await workspaceFingerprint(state.workspace, state.workspace_claims), completed_at: utcNow(), history_digest: protocolReviewHistoryDigest(state) };
          cohort.phase = verdict === 'pass' ? 'passed' : 'failed';
          node.status = verdict === 'pass' ? SUCCEEDED : 'failed';
          node.result = { summary: 'Terra cross-review cohort completed.', verdict, findings };
          addEvent(state, verdict === 'pass' ? 'terra_cohort_passed' : 'terra_cohort_failed', { node_id: node.id, round_id: cohort.round_id, finding_refs: findings.map(finding => finding.finding_ref) });
        }
      }
      await writeState(filePath, state);
      return { task_id: state.task_id, assurance_level: state.assurance_level, effective_assurance_level: effectiveAssuranceLevel(state), node, ready_nodes: readyNodes(state) };
    }
    if (reviewNode && status === 'skipped') throw new ControllerError('A review node cannot be skipped');
    if (reviewNode && status === SUCCEEDED && !hasRecordedPassingReview(state, node)) throw new ControllerError('A successful review node requires a recorded review with verdict pass for its active claim');
    let workflowOutcomeCompletion = null;
    if (node.kind === 'total_review') {
      const canonicalResultPath = workflowArtifactResultPath(parameters);
      if (hasWorkflowOutcomeMarker(result)) {
        if (!sameStatePath(parameters.result, canonicalResultPath)) throw new ControllerError(`A workflow-bound total_review result must be exactly ${canonicalResultPath}`);
        await verifyJsonSnapshot(canonicalResultPath, resultSnapshot, 'Workflow outcome');
        await validateWorkflowArtifactAuthority(result.workflow_artifact_authority, parameters, { resultSnapshot: activeResultSnapshot });
      } else {
        const artifactAuthority = await prepareWorkflowArtifactAuthority(parameters);
        parameters = { ...parameters, result: canonicalResultPath };
        result = addWorkflowOutcomeEnvelope(result, parameters, artifactAuthority);
        await atomicWrite(parameters.result, result, MAX_NODE_RESULT_BYTES, { parentAuthority: await workflowArtifactTargetAuthority(artifactAuthority, parameters) });
        activeResultSnapshot = await readJsonSnapshot(parameters.result, { label: 'Workflow outcome', maxBytes: MAX_NODE_RESULT_BYTES });
        if (!sameJson(activeResultSnapshot.value, result)) throw new ControllerError(`Workflow outcome changed after normalization: ${parameters.result}`);
        await validateWorkflowArtifactAuthority(artifactAuthority, parameters, { resultSnapshot: activeResultSnapshot });
      }
      if (node.workflow_completion_intent && !workflowCompletionIntentMatches(node.workflow_completion_intent, parameters, status, expectedAttestation)) {
        throw new ControllerError('A total_review completion is already pending for a different result, claim, or status');
      }
      if (await isPendingWorkflowOutcome(result, parameters, node, activeResultSnapshot)) {
        if (node.workflow_completion_intent && !sameJson(node.workflow_completion_intent.result, result)) throw new ControllerError('A total_review pending result does not match its persisted completion intent');
        if (!node.workflow_completion_intent) {
          node.workflow_completion_intent = {
            task_id: parameters.task_id,
            node_id: parameters.node_id,
            claim_id: parameters.claim_id,
            status,
            completion_attestation: expectedAttestation,
            result_path: path.resolve(parameters.result),
            result_digest: workflowOutcomeDigest(result),
            result,
            created_at: utcNow(),
          };
          await writeState(filePath, state);
        }
        workflowOutcomeCompletion = await finalizeWorkflowOutcome(result, parameters, node, status, expectedAttestation, activeResultSnapshot);
      } else if (await isFinalizedWorkflowOutcome(result, parameters, node, status, expectedAttestation, activeResultSnapshot)) {
        if (!node.workflow_completion_intent) {
          throw new ControllerError('A finalized total_review result requires a persisted completion intent');
        }
        const intentResultDigest = workflowCompletionIntentResultDigest(node.workflow_completion_intent);
        if (node.workflow_completion_intent && intentResultDigest !== workflowOutcomeDigest(result)) {
          throw new ControllerError('A total_review finalized result does not match its persisted completion intent');
        }
        workflowOutcomeCompletion = result.workflow_completion;
      } else {
        throw new ControllerError('A workflow-bound total_review requires a matching workflow_completion.state=pending outcome');
      }
    }
    if (reviewNode) {
      const recordedReview = state.reviews.find(review => review.node_id === node.id && review.claim_id === node.claim_id);
      if (recordedReview) {
        recordedReview.completion_status = status;
        recordedReview.completion_attestation = expectedAttestation;
        recordedReview.completed_at = utcNow();
      }
    }
    if (node.kind === 'total_review') node.workflow_completion_intent = null;
    if (status === 'unavailable') {
      node.attempt_budget_used = Math.max(0, node.attempt_budget_used - 1);
      node.unavailable_attempts += 1;
      if (reviewNode && isMaxClosureNode(state, node) && state.max_review_charter?.active_closure_claim_id === node.claim_id) {
        state.max_review_charter.status = 'closure_ready';
        state.max_review_charter.active_closure_claim_id = null;
        state.max_review_charter.closure_attempt_count = Math.max(0, state.max_review_charter.closure_attempt_count - 1);
        addEvent(state, 'max_review_closure_unavailable', { node_id: node.id, claim_id: node.claim_id });
      }
    }
    // A max closure failure is terminal for its reviewer but deliberately
    // blocked for the task until the chartered protected repair is recorded.
    const maxClosureFailure = reviewNode && isMaxClosureNode(state, node) && status === 'failed' && state.max_review_charter?.status === 'repair_required';
    const maxScopeDecision = reviewNode && isMaxClosureNode(state, node) && status === 'failed' && state.max_review_charter?.status === 'scope_decision_required';
    node.status = maxClosureFailure || maxScopeDecision ? 'blocked' : status; node.result = result;
    if (reviewNode) addEvent(state, 'node_completed', { node_id: nodeId, claim_id: node.claim_id, status, completion_attestation: expectedAttestation });
    else bumpWorkflowRevision(state, 'node_completed', { node_id: nodeId, status, completion_attestation: expectedAttestation });
    await writeState(filePath, state);
    return { task_id: state.task_id, assurance_level: state.assurance_level, effective_assurance_level: effectiveAssuranceLevel(state), node, ready_nodes: readyNodes(state), workflow_outcome_completion: workflowOutcomeCompletion };
  });
}

async function heartbeatNode(parameters) {
  const [filePath] = await readTask(parameters); const nodeId = requiredIdentifier(parameters.node_id, 'node_id');
  return withActiveWorkspaceStateLock(filePath, async state => {
    const node = state.nodes[nodeId]; const active = activeClaimForOperation(state, node, parameters);
    const now = utcNow(); active.activation_at ??= now; active.activation_deadline_at = null; active.heartbeat_at = now; active.heartbeat_count += 1; state.updated_at = now; await writeState(filePath, state);
    return { task_id: state.task_id, node };
  });
}

async function checkpointNode(parameters) {
  const checkpointPath = requiredString(parameters.checkpoint, 'checkpoint');
  const checkpoint = await readJson(checkpointPath, { label: 'Node checkpoint', maxBytes: MAX_CHECKPOINT_BYTES });
  if (!checkpoint || typeof checkpoint !== 'object' || Array.isArray(checkpoint)) throw new ControllerError('Node checkpoint must be a JSON object');
  const [filePath] = await readTask(parameters); const nodeId = requiredIdentifier(parameters.node_id, 'node_id');
  return withActiveWorkspaceStateLock(filePath, async state => {
    const node = state.nodes[nodeId]; const active = activeClaimForOperation(state, node, parameters);
    active.checkpoint = checkpoint; active.checkpoint_at = utcNow(); active.activation_at ??= active.checkpoint_at; active.activation_deadline_at = null; active.heartbeat_at = active.checkpoint_at; active.heartbeat_count += 1; state.updated_at = active.checkpoint_at; await writeState(filePath, state);
    return { task_id: state.task_id, node_id: nodeId, checkpoint_at: active.checkpoint_at };
  });
}

function compactRecoveryResult(result) {
  const serialized = stableJson(result) ?? 'null';
  const bytes = Buffer.byteLength(serialized, 'utf8');
  if (bytes <= MAX_RECOVERY_RESULT_BYTES) return { value: result, bytes, truncated: false };
  return { bytes, truncated: true, digest: createHash('sha256').update(serialized).digest('hex') };
}

function recoveryPacket(state, node, stale, reason, priorExecutionOwner = node.execution_owner) {
  const previousAttempt = {
    attempt: node.attempt,
    agent_task_path: node.agent_task_path,
    agent_thread_id: node.agent_thread_id,
    agent_role: node.agent_role,
    claim_id: node.claim_id,
    claimed_at: node.claimed_at,
    activation_at: node.activation_at,
    heartbeat_at: node.heartbeat_at,
    heartbeat_count: node.heartbeat_count,
    execution_owner: priorExecutionOwner,
    stale_reason: stale.reason,
    checkpoint: node.checkpoint,
    checkpoint_at: node.checkpoint_at,
    recovery_reason: reason,
  };
  return {
    version: 1,
    continuation: { kind: 'new_agent_required', prior_agent_thread_id: node.agent_thread_id, reason: 'This operation invalidated the old claim. Native session resumption, when available, must be attempted before workflow_requeue_stale.' },
    task: { task_id: state.task_id, workspace: state.workspace, goal: state.goal, requirements: state.requirements, scope: state.scope, non_goals: state.non_goals },
    node: { id: node.id, kind: node.kind, agent_type: node.agent_type, rescue_role: node.rescue_role, depends_on: node.depends_on, execution_risk: node.execution_risk, routing_reason: node.routing_reason, execution_owner: node.execution_owner, integration_owner: node.integration_owner, quality_guard: node.quality_guard },
    completed_dependencies: node.depends_on.map(id => ({ id, status: state.nodes[id].status, result: compactRecoveryResult(state.nodes[id].result) })),
    previous_attempt: previousAttempt,
    instructions: 'This is a replacement agent. Do not assume the previous agent session was restored. Inspect the current workspace and diff, validate the saved checkpoint and dependency evidence, then write a fresh checkpoint before material work.',
  };
}

function replacementExecutionOwner(state, node, parameters) {
  const replacement = requiredString(parameters.replacement_agent_task_path, 'replacement_agent_task_path');
  if (replacement === node.agent_task_path) throw new ControllerError('replacement_agent_task_path must differ from the stale or prior agent_task_path');
  if (node.kind === 'total_review' && participantPaths(state).has(replacement)) throw new ControllerError('A replacement total reviewer must not be a prior participant');
  if (isReviewNode(node, state.routing_schema_version) && node.kind === QUALITY_REVIEW_KIND && participantPaths(state).has(replacement)) throw new ControllerError('A replacement review gate reviewer must not be a prior participant');
  if (!node.routing_legacy && Object.values(state.nodes).some(candidate => candidate.id !== node.id && candidate.execution_owner === replacement)) throw new ControllerError(`replacement_agent_task_path is already reserved by another node: ${replacement}`);
  return replacement;
}

function rebindExecutionOwner(node, replacement) {
  const priorExecutionOwner = node.execution_owner;
  if (!node.routing_legacy) node.execution_owner = replacement;
  return priorExecutionOwner;
}

function clearAttemptForRetry(node) {
  node.status = PENDING; node.agent_task_path = null; node.agent_thread_id = null; node.agent_role = null; node.claim_id = null; node.claimed_at = null; node.activation_at = null; node.activation_deadline_at = null; node.heartbeat_at = null; node.heartbeat_count = 0; node.lease_duration_sec = null; node.result = null; node.checkpoint = null; node.checkpoint_at = null; node.workflow_completion_intent = null;
}

function clearRescueRouting(node) {
  node.rescue_role = null; node.rescue_reason = null; node.rescued_at = null;
}

async function requeueStaleNode(parameters) {
  const [filePath] = await readTask(parameters); const nodeId = requiredIdentifier(parameters.node_id, 'node_id'); const reason = requiredString(parameters.reason, 'reason'); retryConfirmation(parameters); const claimId = requiredString(parameters.claim_id, 'claim_id');
  return withActiveWorkspaceStateLock(filePath, async state => {
    const node = state.nodes[nodeId];
    if (isCohortReviewNode(state, node)) {
      const slot = requiredString(parameters.reviewer_slot, 'reviewer_slot');
      const lane = node.review_gate.cohort.lanes[slot];
      if (!lane || lane.status !== RUNNING || lane.claim_id !== claimId) throw new ControllerError(`Claim does not own an active Terra cohort lane: ${nodeId}`);
      const stale = staleNodes(state).find(candidate => candidate.id === nodeId && candidate.reviewer_slot === slot && candidate.claim_id === claimId);
      if (!stale) throw new ControllerError(`Terra cohort lane is not stale for its active claim: ${nodeId}/${slot}`);
      nodeAttemptAvailability(lane, nodeId);
      const replacement = requiredString(parameters.replacement_agent_task_path, 'replacement_agent_task_path');
      if (participantPaths(state).has(replacement)) throw new ControllerError('A replacement Terra cohort reviewer must not be a prior participant');
      const packet = recoveryPacket(state, { ...node, ...lane, execution_owner: replacement }, stale, reason, lane.agent_task_path);
      node.recovery_history.push({ at: utcNow(), reviewer_slot: slot, ...packet.previous_attempt });
      if (node.recovery_history.length > MAX_TOTAL_NODE_ATTEMPTS) node.recovery_history.splice(0, node.recovery_history.length - MAX_TOTAL_NODE_ATTEMPTS);
      const preserveBlindClaim = node.review_gate.cohort.phase === 'cross_questioning';
      node.review_gate.cohort.lanes[slot] = resetCohortLaneForRetry(lane, replacement, preserveBlindClaim);
      node.status = RUNNING;
      addEvent(state, 'stale_node_requeued', { node_id: nodeId, reviewer_slot: slot, prior_claim_id: claimId, replacement_execution_owner: replacement, reason, stale_reason: stale.reason, previous_agent_stopped: true, auto_requeue: true });
      await writeState(filePath, state);
      return { task_id: state.task_id, node, recovery_package: packet, ready_nodes: readyNodes(state) };
    }
    requireActiveClaim(node, parameters);
    const stale = staleNodes(state).find(candidate => candidate.id === nodeId && candidate.claim_id === claimId);
    if (!stale) throw new ControllerError(`Node is not stale for its active claim: ${nodeId}`);
    nodeAttemptAvailability(node, nodeId);
    const replacement = replacementExecutionOwner(state, node, parameters); const priorExecutionOwner = rebindExecutionOwner(node, replacement);
    const packet = recoveryPacket(state, node, stale, reason, priorExecutionOwner);
    node.recovery_history.push({ at: utcNow(), ...packet.previous_attempt });
    if (node.recovery_history.length > MAX_TOTAL_NODE_ATTEMPTS) node.recovery_history.splice(0, node.recovery_history.length - MAX_TOTAL_NODE_ATTEMPTS);
    clearRescueRouting(node); clearAttemptForRetry(node);
    const details = { node_id: nodeId, prior_claim_id: claimId, prior_execution_owner: priorExecutionOwner, replacement_execution_owner: replacement, reason, stale_reason: stale.reason, previous_agent_stopped: true, auto_requeue: true };
    if (node.kind === 'total_review') addEvent(state, 'stale_node_requeued', details); else bumpWorkflowRevision(state, 'stale_node_requeued', details);
    await writeState(filePath, state);
    return { task_id: state.task_id, node, recovery_package: packet, ready_nodes: readyNodes(state) };
  });
}

async function rescueNode(parameters) {
  const [filePath] = await readTask(parameters); const nodeId = requiredIdentifier(parameters.node_id, 'node_id'); const reason = requiredString(parameters.reason, 'reason'); retryConfirmation(parameters); const claimId = requiredString(parameters.claim_id, 'claim_id');
  return withActiveWorkspaceStateLock(filePath, async state => {
    const node = state.nodes[nodeId]; requireActiveClaim(node, parameters);
    if (node.kind === 'total_review') throw new ControllerError('A total_review node cannot be rescued by main/root');
    if (node.execution_risk !== 'delegable') throw new ControllerError('Only delegable Luna execution can be rescued by main/root');
    if (!LUNA_EXECUTOR_ROLES.has(node.agent_role)) throw new ControllerError('Only a Luna executor or explicitly matched legacy writer attempt can be rescued by main/root');
    if (node.rescue_role) throw new ControllerError(`Node already has an active rescue role: ${nodeId}`);
    nodeAttemptAvailability(node, nodeId);
    const replacement = replacementExecutionOwner(state, node, parameters);
    const priorExecutionOwner = rebindExecutionOwner(node, replacement);
    const now = utcNow();
    const stale = staleNodes(state).find(candidate => candidate.id === nodeId && candidate.claim_id === claimId) ?? { reason: 'explicit_root_rescue' };
    const packet = recoveryPacket(state, node, stale, reason, priorExecutionOwner);
    node.recovery_history.push({ at: now, ...packet.previous_attempt });
    if (node.recovery_history.length > MAX_TOTAL_NODE_ATTEMPTS) node.recovery_history.splice(0, node.recovery_history.length - MAX_TOTAL_NODE_ATTEMPTS);
    node.rescue_role = ROOT_RESCUE_ROLE; node.rescue_reason = reason; node.rescued_at = now; node.rescue_count += 1;
    clearAttemptForRetry(node);
    bumpWorkflowRevision(state, 'root_rescue', { node_id: nodeId, prior_claim_id: claimId, prior_execution_owner: priorExecutionOwner, replacement_execution_owner: replacement, reason, previous_agent_stopped: true, rescue_role: ROOT_RESCUE_ROLE });
    await writeState(filePath, state);
    return { task_id: state.task_id, node, recovery_package: packet, rescue_role: ROOT_RESCUE_ROLE, ready_nodes: readyNodes(state) };
  });
}

async function abandonNode(parameters) {
  const [filePath] = await readTask(parameters); const nodeId = requiredIdentifier(parameters.node_id, 'node_id'); const reason = requiredString(parameters.reason, 'reason'); trueValue(parameters.previous_agent_stopped, 'previous_agent_stopped');
  return withActiveWorkspaceStateLock(filePath, async state => {
    const node = state.nodes[nodeId];
    if (isCohortReviewNode(state, node)) {
      const slot = requiredString(parameters.reviewer_slot, 'reviewer_slot');
      const lane = node.review_gate.cohort.lanes[slot];
      const claimId = requiredString(parameters.claim_id, 'claim_id');
      if (!lane || lane.status !== RUNNING || lane.claim_id !== claimId) throw new ControllerError(`Claim does not own an active Terra cohort lane: ${nodeId}`);
      lane.status = 'abandoned';
      lane.result = { summary: 'Terra cohort lane abandoned after explicit reconciliation.', reason, abandoned_at: utcNow(), claim_id: lane.claim_id };
      node.status = 'abandoned';
      addEvent(state, 'node_abandoned', { node_id: nodeId, reviewer_slot: slot, claim_id, reason, previous_agent_stopped: true });
      await writeState(filePath, state);
      return { task_id: state.task_id, node };
    }
    requireActiveClaim(node, parameters);
    node.status = 'abandoned'; node.workflow_completion_intent = null; node.result = { summary: 'Node abandoned after explicit reconciliation.', reason, abandoned_at: utcNow(), claim_id: node.claim_id };
    if (node.kind === 'total_review') addEvent(state, 'node_abandoned', { node_id: nodeId, claim_id: node.claim_id, reason, previous_agent_stopped: true });
    else bumpWorkflowRevision(state, 'node_abandoned', { node_id: nodeId, claim_id: node.claim_id, reason, previous_agent_stopped: true });
    await writeState(filePath, state);
    return { task_id: state.task_id, node };
  });
}

async function retryNode(parameters) {
  const [filePath] = await readTask(parameters); const nodeId = requiredIdentifier(parameters.node_id, 'node_id'); const reason = requiredString(parameters.reason, 'reason'); retryConfirmation(parameters);
  return withActiveWorkspaceStateLock(filePath, async state => {
    const node = state.nodes[nodeId];
    const protocolNode = isReviewProtocolState(state) && protocolReviewNode(state) === node;
    const reviewNode = isReviewNode(node, state.routing_schema_version);
    if (protocolNode && isCohortReviewNode(state, node) && ['unavailable', 'abandoned'].includes(node.status)) {
      const slot = requiredString(parameters.reviewer_slot, 'reviewer_slot');
      const lane = node.review_gate.cohort.lanes[slot];
      if (!lane || lane.status !== node.status) throw new ControllerError('Only the matching unavailable or abandoned Terra cohort lane can be retried');
      retryConfirmation(parameters); nodeAttemptAvailability(lane, nodeId);
      const replacement = requiredString(parameters.replacement_agent_task_path, 'replacement_agent_task_path');
      if (participantPaths(state).has(replacement)) throw new ControllerError('A replacement Terra cohort reviewer must not be a prior participant');
      const preserveBlindClaim = node.review_gate.cohort.phase === 'cross_questioning';
      node.review_gate.cohort.lanes[slot] = resetCohortLaneForRetry(lane, replacement, preserveBlindClaim);
      node.status = RUNNING;
      addEvent(state, 'terra_cohort_lane_retried', { node_id: nodeId, reviewer_slot: slot, replacement_agent_task_path: replacement, prior_status: lane.status, reason, previous_agent_stopped: true });
      await writeState(filePath, state);
      return { task_id: state.task_id, node, ready_nodes: readyNodes(state) };
    }
    const orphanedReview = reviewNode && node.status === SUCCEEDED && !hasRecordedPassingReview(state, node);
    if (!node || (!['failed', 'blocked', 'unavailable', 'abandoned'].includes(node.status) && !orphanedReview)) {
      throw new ControllerError(`Only failed, blocked, unavailable, abandoned, or an unrecorded successful total_review can be retried: ${nodeId}`);
    }
    const downstreamStarted = Object.values(state.nodes).some(candidate => candidate.depends_on.includes(nodeId) && candidate.status !== PENDING);
    if (downstreamStarted) throw new ControllerError(`Cannot retry after a dependent node changed state: ${nodeId}`);
    nodeAttemptAvailability(node, nodeId);
    if (state.routing_schema_version >= 2 && reviewNode && !hasOwn(parameters, 'replacement_agent_task_path')) throw new ControllerError('A retried review node requires replacement_agent_task_path for an independent reviewer');
    const replacement = node.routing_legacy ? null : replacementExecutionOwner(state, node, parameters); const priorExecutionOwner = replacement ? rebindExecutionOwner(node, replacement) : node.execution_owner;
    const priorClaimId = node.claim_id; const wasTotalReview = node.kind === 'total_review'; const priorReviewRole = reviewNode ? node.agent_type : null;
    if (protocolNode) {
      const stage = protocolStageForNode(node);
      if (node.review_gate.scope_decision_required) throw new ControllerError('The final Sol/max closure requires a user scope decision; automatic retry is forbidden');
      if (node.status === 'unavailable') {
        clearRescueRouting(node); clearAttemptForRetry(node);
        addEvent(state, 'review_protocol_unavailable_retried', { node_id: nodeId, stage, reason, previous_agent_stopped: true });
        await writeState(filePath, state);
        return { task_id: state.task_id, assurance_level: state.assurance_level, effective_assurance_level: effectiveAssuranceLevel(state), node, ready_nodes: readyNodes(state) };
      }
      if (stage === 'sol_max_closure') {
        const charter = requireMaxReviewCharter(state, node);
        if (charter.scope_decision_required || charter.status === 'scope_decision_required') throw new ControllerError('The final Sol/max closure requires a user scope decision; automatic retry is forbidden');
        if (charter.status !== 'closure_ready') throw new ControllerError(`The max review charter is not ready for its only closure review: ${charter.status}`);
        clearRescueRouting(node); clearAttemptForRetry(node);
        addEvent(state, 'max_closure_review_ready', { node_id: nodeId, reason, previous_agent_stopped: true });
        await writeState(filePath, state);
        return { task_id: state.task_id, assurance_level: state.assurance_level, effective_assurance_level: effectiveAssuranceLevel(state), node, max_review_charter: state.max_review_charter, ready_nodes: readyNodes(state) };
      }
      if (stage === 'terra_cohort') {
        const aggregate = node.review_gate.cohort.aggregate;
        const sourceClaimId = aggregate?.source_review_claim_id ?? `cohort:${node.review_gate.cohort.round_id}`;
        if (!state.repair_records.some(record => record.source_review_claim_id === sourceClaimId)) throw new ControllerError('The failed Terra cohort requires a recorded repair before Sol escalation');
        clearRescueRouting(node); clearAttemptForRetry(node); applyProtocolStage(node, 'sol_high');
        addEvent(state, 'terra_cohort_escalated', { node_id: nodeId, role: node.agent_type, source_review_claim_id: sourceClaimId, reason, previous_agent_stopped: true });
        await writeState(filePath, state);
        return { task_id: state.task_id, assurance_level: state.assurance_level, effective_assurance_level: effectiveAssuranceLevel(state), node, ready_nodes: readyNodes(state) };
      }
      if (stage === 'sol_max_initial') {
        const sourceReview = protocolLatestFailedReview(state, node);
        if (!sourceReview) throw new ControllerError('Sol/max closure requires a finalized failed max initial review');
        await freezeProtocolMaxReviewCharter(state, node, sourceReview);
        clearRescueRouting(node); clearAttemptForRetry(node); applyProtocolStage(node, 'sol_max_closure');
        node.status = 'blocked';
        addEvent(state, 'max_initial_repair_required', { node_id: nodeId, source_review_claim_id: sourceReview.claim_id, reason, previous_agent_stopped: true });
        await writeState(filePath, state);
        return { task_id: state.task_id, assurance_level: state.assurance_level, effective_assurance_level: effectiveAssuranceLevel(state), node, max_review_charter: state.max_review_charter, ready_nodes: [] };
      }
      const sourceReview = protocolLatestFailedReview(state, node);
      requireRecordedProtocolRepair(state, sourceReview);
      const nextStage = protocolNextStage(stage);
      if (!nextStage) throw new ControllerError('The review protocol has no automatic stage after this failure');
      clearRescueRouting(node); clearAttemptForRetry(node); applyProtocolStage(node, nextStage);
      addEvent(state, 'review_protocol_stage_escalated', { node_id: nodeId, from_stage: stage, to_stage: nextStage, source_review_claim_id: sourceReview.claim_id, reason, previous_agent_stopped: true });
      await writeState(filePath, state);
      return { task_id: state.task_id, assurance_level: state.assurance_level, effective_assurance_level: effectiveAssuranceLevel(state), node, ready_nodes: readyNodes(state) };
    }
    const nextReview = reviewNode ? nextReviewRoute(state, node) : null;
    if (isMaxClosureNode(state, node)) {
      const charter = requireMaxReviewCharter(state, node);
      if (charter.scope_decision_required || charter.status === 'scope_decision_required') {
        throw new ControllerError('The max review charter requires a scope decision; create a replacement task or explicitly expand the charter before retrying');
      }
      if (charter.status !== 'closure_ready') {
        throw new ControllerError(`The max review charter is not ready for closure review: ${charter.status}`);
      }
      if (charter.closure_attempt_count >= charter.closure_attempt_limit) {
        throw new ControllerError('The max review charter exhausted its controlled closure attempts; create a replacement task or explicitly expand the charter');
      }
    }
    if (nextReview?.agent_type === 'avsp_sol_max' && !isMaxReviewNode(node)) {
      const sourceReview = finalizedLatestReview(state, node);
      if (!sourceReview) throw new ControllerError('Escalation to max requires a finalized xhigh failure');
      await freezeMaxReviewCharter(state, node, sourceReview);
      node.kind = nextReview.kind;
      node.review_stage = nextReview.review_stage;
      node.agent_type = nextReview.agent_type;
      node.status = 'blocked';
      const details = { node_id: nodeId, prior_claim_id: priorClaimId, prior_execution_owner: priorExecutionOwner, replacement_execution_owner: replacement, reason, previous_agent_stopped: true, max_review_charter: state.max_review_charter };
      addEvent(state, 'total_review_escalated', { node_id: nodeId, prior_role: priorReviewRole, role: nextReview.agent_type, reason, prior_claim_id: priorClaimId });
      addEvent(state, 'max_review_repair_required', details);
      await writeState(filePath, state);
      return { task_id: state.task_id, assurance_level: state.assurance_level, effective_assurance_level: effectiveAssuranceLevel(state), node, max_review_charter: state.max_review_charter, ready_nodes: [] };
    }
    if (node.kind === QUALITY_REVIEW_KIND && nextReview?.kind === QUALITY_REVIEW_KIND) requireRecordedTerraRepair(state, node);
    clearRescueRouting(node); clearAttemptForRetry(node);
    if (nextReview) {
      node.kind = nextReview.kind;
      node.review_stage = nextReview.review_stage;
      node.agent_type = nextReview.agent_type;
    }
    const details = { node_id: nodeId, prior_claim_id: priorClaimId, prior_execution_owner: priorExecutionOwner, replacement_execution_owner: replacement, reason, previous_agent_stopped: true, orphaned_review: orphanedReview, orphaned_total_review: wasTotalReview && orphanedReview, prior_review_role: priorReviewRole, review_role: nextReview?.agent_type ?? null };
    if (nextReview?.escalated) {
      details.review_escalated = true;
      addEvent(state, 'terra_review_escalated', { node_id: nodeId, prior_role: priorReviewRole, role: nextReview.agent_type, reason, prior_claim_id: priorClaimId });
    } else if (node.kind === 'total_review' && nextReview && nextReview.agent_type !== priorReviewRole) {
      details.review_escalated = true;
      addEvent(state, 'total_review_escalated', { node_id: nodeId, prior_role: priorReviewRole, role: nextReview.agent_type, reason, prior_claim_id: priorClaimId });
    }
    if (node.kind === 'total_review') addEvent(state, 'node_retried', details); else bumpWorkflowRevision(state, 'node_retried', details);
    await writeState(filePath, state);
    return { task_id: state.task_id, assurance_level: state.assurance_level, effective_assurance_level: effectiveAssuranceLevel(state), node, ready_nodes: readyNodes(state) };
  });
}

const PRUNABLE_STATE_FIELDS = new Set(['version', 'routing_schema_version', 'assurance_level', 'assurance_assessment', 'review_protocol_version', 'review_entry_stage', 'review_context', 'task_id', 'workspace', 'workspace_claims', 'goal', 'requirements', 'scope', 'non_goals', 'nodes', 'participants', 'reviews', 'repair_records', 'max_review_charter', 'verification_record', 'verification_history', 'events', 'workflow_revision', 'closed_revision', 'closed_at', 'created_at', 'updated_at', 'workspace_lease']);
const PRUNABLE_NODE_FIELDS = new Set(['id', 'kind', 'review_stage', 'agent_type', 'depends_on', 'execution_risk', 'routing_reason', 'execution_owner', 'integration_owner', 'quality_guard', 'routing_legacy', 'rescue_role', 'rescue_reason', 'rescued_at', 'rescue_count', 'status', 'agent_task_path', 'agent_thread_id', 'agent_role', 'claim_id', 'claimed_at', 'activation_at', 'activation_deadline_at', 'heartbeat_at', 'heartbeat_count', 'lease_duration_sec', 'attempt', 'attempt_budget_used', 'unavailable_attempts', 'result', 'checkpoint', 'checkpoint_at', 'workflow_completion_intent', 'recovery_history', 'review_gate']);
const LEGACY_V1_PRUNABLE_STATE_FIELDS = new Set([...PRUNABLE_STATE_FIELDS].filter(field => !['assurance_level', 'assurance_assessment', 'repair_records', 'max_review_charter', 'verification_record', 'verification_history'].includes(field)));
const LEGACY_V1_NULL_MAX_CHARTER_PRUNABLE_STATE_FIELDS = new Set([...LEGACY_V1_PRUNABLE_STATE_FIELDS, 'max_review_charter']);
const LEGACY_V2_PRUNABLE_STATE_FIELDS = new Set([...PRUNABLE_STATE_FIELDS].filter(field => !['assurance_assessment', 'repair_records', 'max_review_charter', 'verification_history'].includes(field)));
const LEGACY_PRE_VERIFICATION_HISTORY_PRUNABLE_STATE_FIELDS = new Set([...PRUNABLE_STATE_FIELDS].filter(field => !['max_review_charter', 'verification_history'].includes(field)));
const LEGACY_PRE_MAX_CHARTER_PRUNABLE_STATE_FIELDS = new Set([...PRUNABLE_STATE_FIELDS].filter(field => field !== 'max_review_charter'));
const LEGACY_CLAIMLESS_PRUNABLE_STATE_FIELDS = new Set([...PRUNABLE_STATE_FIELDS].filter(field => field !== 'workspace_claims'));
const LEGACY_V1_PRUNABLE_NODE_FIELDS = new Set([...PRUNABLE_NODE_FIELDS].filter(field => !['review_stage', 'attempt_budget_used', 'unavailable_attempts'].includes(field)));
const LEGACY_V2_PRUNABLE_NODE_FIELDS = new Set([...PRUNABLE_NODE_FIELDS].filter(field => !['attempt_budget_used', 'unavailable_attempts'].includes(field)));
const PRUNABLE_LEASE_FIELDS = new Set(['version', 'workspace', 'active_tasks', 'updated_at']);
const PRUNABLE_TASK_LEASE_FIELDS = new Set(['registry_path', 'state_path', 'status', 'acquired_at', 'released_at', 'workspace_claims']);
const LEGACY_CLAIMLESS_PRUNABLE_TASK_LEASE_FIELDS = new Set([...PRUNABLE_TASK_LEASE_FIELDS].filter(field => field !== 'workspace_claims'));
const PRUNABLE_TASK_LEASE_AUTHORITY_FIELDS = new Set([...PRUNABLE_TASK_LEASE_FIELDS, 'state_parent_authority']);
const LEGACY_CLAIMLESS_PRUNABLE_TASK_LEASE_AUTHORITY_FIELDS = new Set([...LEGACY_CLAIMLESS_PRUNABLE_TASK_LEASE_FIELDS, 'state_parent_authority']);
const PRUNE_SWEEP_FIELDS = new Set(['version', 'last_sweep_at', 'last_result']);
const QUARANTINE_FIELDS_V1 = new Set(['version', 'status', 'task_id', 'original_state_path', 'error_path', 'reason', 'quarantined_at', 'delete_after', 'files', 'move_error']);
const QUARANTINE_FIELDS_V2 = new Set([...QUARANTINE_FIELDS_V1, 'review_artifacts']);
const QUARANTINE_FIELDS_V3 = new Set([...QUARANTINE_FIELDS_V2, 'workspace', 'registry_path', 'binding']);
const QUARANTINE_FIELDS = new Set([...QUARANTINE_FIELDS_V3, 'authority_anchor']);
const QUARANTINE_EXPIRY_FIELDS_V1 = new Set(['version', 'task_id', 'original_state_path', 'quarantined_at', 'delete_after', 'files', 'review_artifacts']);
const QUARANTINE_EXPIRY_FIELDS_V2 = new Set([...QUARANTINE_EXPIRY_FIELDS_V1, 'workspace', 'registry_path', 'binding']);
const QUARANTINE_EXPIRY_FIELDS = new Set([...QUARANTINE_EXPIRY_FIELDS_V2, 'authority_anchor']);
const PRUNE_RESULT_FIELDS = new Set(['deleted_count', 'quarantined_count', 'retained_count', 'quarantine_deleted_count', 'quarantine_retained_count', 'report_truncated']);

function hasExactFields(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === fields.size && keys.every(key => fields.has(key));
}
function validTimestamp(value) { return typeof value === 'string' && Number.isFinite(Date.parse(value)); }

function taskPruneEligibility(state, filePath, now) {
  const isPreV2V1State = state?.routing_schema_version === 1 && !hasOwn(state, 'assurance_level') && !hasOwn(state, 'verification_record');
  const isPreRepairV2State = state?.routing_schema_version === 2 && !hasOwn(state, 'assurance_assessment') && !hasOwn(state, 'repair_records');
  const claimless = !hasOwn(state, 'workspace_claims');
  const baseStateFields = isPreV2V1State
    ? state.max_review_charter === null ? LEGACY_V1_NULL_MAX_CHARTER_PRUNABLE_STATE_FIELDS : LEGACY_V1_PRUNABLE_STATE_FIELDS
    : isPreRepairV2State ? LEGACY_V2_PRUNABLE_STATE_FIELDS : !hasOwn(state, 'verification_history') ? LEGACY_PRE_VERIFICATION_HISTORY_PRUNABLE_STATE_FIELDS : !hasOwn(state, 'max_review_charter') ? LEGACY_PRE_MAX_CHARTER_PRUNABLE_STATE_FIELDS : PRUNABLE_STATE_FIELDS;
  const stateFields = claimless ? new Set([...baseStateFields].filter(field => field !== 'workspace_claims')) : baseStateFields;
  const legacyNodeFields = isPreV2V1State ? LEGACY_V1_PRUNABLE_NODE_FIELDS : isPreRepairV2State ? LEGACY_V2_PRUNABLE_NODE_FIELDS : null;
  const nodeFields = legacyNodeFields ?? PRUNABLE_NODE_FIELDS;
  if (!hasExactFields(state, stateFields)) return { eligible: false, reason: 'incomplete or unknown state fields' };
  if (state.version !== VERSION || ![1, 2, REVIEW_PROTOCOL_VERSION].includes(state.routing_schema_version)) return { eligible: false, reason: 'legacy or unsupported state schema' };
  if (state.routing_schema_version === 1 && state.assurance_level !== undefined && state.assurance_level !== null) return { eligible: false, reason: 'invalid v1 assurance state' };
  if (state.routing_schema_version >= 2 && !ASSURANCE_LEVELS.has(state.assurance_level)) return { eligible: false, reason: 'invalid assurance state' };
  try { requiredIdentifier(state.task_id, 'task_id'); requiredString(state.workspace, 'workspace'); requiredString(state.goal, 'goal'); }
  catch (error) { return { eligible: false, reason: `invalid task identity: ${error.message}` }; }
  if (state.task_id !== path.basename(filePath, '.json')) return { eligible: false, reason: 'task_id does not match state path' };
  if (!path.isAbsolute(state.workspace) || path.resolve(state.workspace) !== state.workspace) return { eligible: false, reason: 'workspace is not canonical absolute path' };
  if (!Array.isArray(state.requirements) || !Array.isArray(state.scope) || !Array.isArray(state.non_goals) || !Array.isArray(state.participants) || !Array.isArray(state.reviews) || !Array.isArray(state.events) || (!isPreRepairV2State && !isPreV2V1State && !Array.isArray(state.repair_records)) || (hasOwn(state, 'verification_history') && !Array.isArray(state.verification_history))) return { eligible: false, reason: 'invalid state collection' };
  if (state.requirements.some(item => !item || typeof item !== 'object' || Array.isArray(item) || typeof item.id !== 'string' || !item.id.trim() || typeof item.text !== 'string' || !item.text.trim()) || state.participants.some(item => !item || typeof item !== 'object' || Array.isArray(item)) || state.reviews.some(item => !item || typeof item !== 'object' || Array.isArray(item)) || state.events.some(item => !item || typeof item !== 'object' || Array.isArray(item) || !validTimestamp(item.at) || typeof item.type !== 'string' || !item.type.trim())) return { eligible: false, reason: 'malformed state collection item' };
  if (!state.nodes || typeof state.nodes !== 'object' || Array.isArray(state.nodes) || !Object.keys(state.nodes).length) return { eligible: false, reason: 'invalid node collection' };
  for (const [id, node] of Object.entries(state.nodes)) {
    if (!hasExactFields(node, nodeFields) || node.id !== id || (node.status !== PENDING && !TERMINAL.has(node.status))) return { eligible: false, reason: 'incomplete, unknown, or active node state' };
    try { requiredIdentifier(node.id, 'node.id'); requiredString(node.kind, 'node.kind'); requiredString(node.execution_risk, 'node.execution_risk'); requiredString(node.routing_reason, 'node.routing_reason'); requiredString(node.execution_owner, 'node.execution_owner'); requiredString(node.integration_owner, 'node.integration_owner'); requiredString(node.quality_guard, 'node.quality_guard'); }
    catch (error) { return { eligible: false, reason: `invalid node state: ${error.message}` }; }
    const hasValidAttemptAccounting = isPreV2V1State || isPreRepairV2State
      ? true
      : Number.isSafeInteger(node.attempt_budget_used) && node.attempt_budget_used >= 0 && node.attempt_budget_used <= MAX_NODE_ATTEMPTS
        && Number.isSafeInteger(node.unavailable_attempts) && node.unavailable_attempts >= 0 && node.unavailable_attempts <= MAX_UNAVAILABLE_ATTEMPTS
        && node.attempt_budget_used + node.unavailable_attempts <= node.attempt;
    if (!['read_only', 'delegable', 'protected'].includes(node.execution_risk) || !Array.isArray(node.depends_on) || node.depends_on.some(dependency => typeof dependency !== 'string') || node.routing_legacy !== false || !Number.isSafeInteger(node.attempt) || node.attempt < 0 || node.attempt > MAX_TOTAL_NODE_ATTEMPTS || !hasValidAttemptAccounting || !Number.isSafeInteger(node.heartbeat_count) || node.heartbeat_count < 0 || !Array.isArray(node.recovery_history)) return { eligible: false, reason: 'legacy or invalid node routing' };
  }
  try { validateNodes(state.nodes); validateReviewTopology(state.nodes, state.assurance_level, state.routing_schema_version, state.review_entry_stage); }
  catch (error) { return { eligible: false, reason: `invalid task topology: ${error.message}` }; }
  if (!Number.isSafeInteger(state.workflow_revision) || state.workflow_revision < 0 || !validTimestamp(state.created_at) || !validTimestamp(state.updated_at)) return { eligible: false, reason: 'invalid task timestamps or revision' };
  const updatedAt = Date.parse(state.updated_at);
  if (!Number.isFinite(updatedAt)) return { eligible: false, reason: 'invalid updated_at' };
  if (now - updatedAt < DEFAULT_TASK_RETENTION_DAYS * DAY_MS) return { eligible: false, reason: 'younger than retention period' };
  if (!state.workspace_lease || state.workspace_lease.status !== 'released') return { eligible: false, reason: 'workspace lease is not released' };
  const claimlessLease = !hasOwn(state.workspace_lease, 'workspace_claims');
  const hasStateParentAuthority = hasOwn(state.workspace_lease, 'state_parent_authority');
  const expectedLeaseFields = claimlessLease ? LEGACY_CLAIMLESS_PRUNABLE_TASK_LEASE_AUTHORITY_FIELDS : PRUNABLE_TASK_LEASE_AUTHORITY_FIELDS;
  if (!hasExactFields(state.workspace_lease, expectedLeaseFields)) return { eligible: false, reason: 'workspace lease is not a complete released state' };
  if (Object.values(state.nodes).some(node => node.status === RUNNING)) return { eligible: false, reason: 'has running nodes' };
  if (typeof state.workspace_lease.registry_path !== 'string' || !path.isAbsolute(state.workspace_lease.registry_path) || path.resolve(state.workspace_lease.registry_path) !== workspaceLeasePath(state.workspace)) return { eligible: false, reason: 'invalid workspace lease path' };
  if (!sameStatePath(state.workspace_lease.state_path, filePath) || !validTimestamp(state.workspace_lease.acquired_at) || !validTimestamp(state.workspace_lease.released_at)) return { eligible: false, reason: 'invalid released workspace lease state' };
  if (!hasStateParentAuthority || !validStateParentAuthority(state.workspace_lease.state_parent_authority, filePath)) return { eligible: false, reason: 'invalid released workspace lease state parent authority' };
  try { normalizeStoredWorkspaceClaims(state.workspace_lease.workspace_claims ?? legacyWorkspaceClaims()); } catch (error) { return { eligible: false, reason: 'invalid released workspace lease claims' }; }
  if (path.resolve(state.workspace_lease.registry_path) === path.resolve(filePath)) return { eligible: false, reason: 'state path conflicts with workspace lease path' };
  return { eligible: true };
}

async function releasedLeaseEligibility(leasePath, state, filePath, authorityContext = null) {
  let lease;
  try { lease = authorityContext?.legacy_verified_lease ?? await loadWorkspaceLease(leasePath, state.workspace, { authorityContext }); }
  catch (error) { return { eligible: false, reason: `workspace lease is unreadable: ${error.message}` }; }
  if (lease.workspace !== state.workspace || !Array.isArray(lease.active_tasks) || !validTimestamp(lease.updated_at)) return { eligible: false, reason: 'workspace lease is not a verified released registry' };
  if (workspaceLeaseStatePathOwners(lease, state.workspace_lease.state_path).length) return { eligible: false, reason: 'workspace lease still has an active state-path owner' };
  const reviewSource = reviewArtifactTaskPath(path.dirname(filePath), logicalTaskIdFromStatePath(filePath));
  try {
    const reviewMetadata = await fs.lstat(reviewSource);
    if (reviewMetadata.isSymbolicLink() || !reviewMetadata.isDirectory() || !await reviewArtifactDirectoryIsSafe(reviewSource)) return { eligible: false, reason: 'review artifact tree is not safe for recursive cleanup' };
  } catch (error) {
    if (error.code !== 'ENOENT') return { eligible: false, reason: `review artifact tree cannot be verified: ${error.message}` };
  }
  const sourcePaths = [filePath, databasePath(filePath), `${filePath}.legacy`];
  const activeOwner = await activeLeaseOwnerForSources(lease, sourcePaths, reviewSource);
  if (activeOwner) return { eligible: false, reason: `cleanup source overlaps an active workspace lease entry: ${activeOwner.task_id} (${activeOwner.state_path})` };
  return { eligible: true };
}

async function withLegacyReleasedWorkspaceLeaseLock(workspace, callback) {
  const authorityPath = workspaceLeaseAuthorityPath(workspace);
  const leasePath = workspaceLeasePath(workspace);
  const control = await safeWorkspaceLeaseControlDirectory(workspace);
  const assertAuthorityAbsent = async () => {
    try {
      await fs.lstat(authorityPath);
      throw new ControllerError(`Workspace lease authority appeared during legacy cleanup: ${authorityPath}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  };
  await assertAuthorityAbsent();
  return withStateLock(leasePath, async () => {
    await assertAuthorityAbsent();
    const snapshot = await readJsonSnapshot(leasePath, { label: 'Legacy workspace lease', maxBytes: MAX_MANIFEST_BYTES });
    await validateLegacyWorkspaceLeaseForAuthority(snapshot.value, workspace, leasePath);
    if (snapshot.value.active_task !== null) throw new ControllerError(`Legacy workspace lease is still active: ${leasePath}`);
    const legacyVerifiedLease = { version: WORKSPACE_LEASE_VERSION, workspace, active_tasks: [], updated_at: snapshot.value.updated_at };
    await validateWorkspaceLease(legacyVerifiedLease, leasePath);
    const result = await callback(leasePath, {
      legacy_verified_lease: legacyVerifiedLease,
      parent_authorities: { registry: { path: control.control_directory, real_path: control.control_real_path, identity: control.control_identity } },
    });
    await verifyRegularDirectorySnapshot({ path: control.control_directory, real_path: control.control_real_path, identity: control.control_identity }, 'Legacy workspace lease parent');
    await verifyJsonSnapshot(leasePath, snapshot, 'Legacy workspace lease');
    await assertAuthorityAbsent();
    return result;
  }, { createParent: false });
}

async function quarantineEligibility(state, filePath, now) {
  let storageMetadata;
  try { storageMetadata = await fs.stat(databasePath(filePath)); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    try { storageMetadata = await fs.stat(filePath); }
    catch (legacyError) {
      if (legacyError.code !== 'ENOENT') throw legacyError;
      try { storageMetadata = await fs.stat(`${filePath}.legacy`); }
      catch (archiveError) {
        if (archiveError.code === 'ENOENT') return { eligible: false, reason: 'state disappeared before quarantine' };
        throw archiveError;
      }
    }
  }
  const updatedAt = state && validTimestamp(state.updated_at) ? Date.parse(state.updated_at) : storageMetadata.mtimeMs;
  if (now - updatedAt < QUARANTINE_AFTER_DAYS * DAY_MS) return { eligible: false, reason: 'younger than quarantine retention period' };
  if (!state || typeof state !== 'object' || Array.isArray(state)) return { eligible: false, reason: 'state is unreadable and its workspace lease cannot be verified; manual recovery is required' };
  if (state.workspace_lease && !validStateParentAuthority(state.workspace_lease.state_parent_authority, filePath)) return { eligible: false, reason: 'state parent authority is missing or invalid; controlled recovery is required' };
  if (!state.nodes || typeof state.nodes !== 'object' || Array.isArray(state.nodes) || !Object.keys(state.nodes).length) return { eligible: false, reason: 'node collection is missing, empty, or not verifiable; manual recovery is required' };
  if (state.nodes && Object.values(state.nodes).some(node => node?.status === RUNNING)) return { eligible: false, reason: 'has running nodes' };
  if (state.nodes && Object.values(state.nodes).some(node => !node || typeof node !== 'object' || ![PENDING, ...TERMINAL].includes(node.status))) return { eligible: false, reason: 'node states are unknown; manual recovery is required' };
  if (state.workspace_lease?.status === 'active') return { eligible: false, reason: 'state workspace lease is still active' };
  const leasePath = state?.workspace_lease?.registry_path;
  const canonicalLeasePath = typeof state.workspace === 'string' && path.isAbsolute(state.workspace) && path.resolve(state.workspace) === state.workspace
    ? workspaceLeasePath(state.workspace)
    : null;
  const lockableLeasePath = typeof leasePath === 'string' && path.isAbsolute(leasePath) && canonicalLeasePath && path.resolve(leasePath) === canonicalLeasePath ? leasePath : null;
  if (!lockableLeasePath) return { eligible: false, reason: 'state has no verifiable workspace lease; manual recovery is required' };
  try {
    const leaseMetadata = await fs.lstat(lockableLeasePath);
    if (leaseMetadata.isSymbolicLink() || !leaseMetadata.isFile()) return { eligible: false, reason: 'workspace lease is not a regular registry file; manual recovery is required' };
  } catch (error) {
    if (error.code === 'ENOENT') return { eligible: false, reason: 'workspace lease registry is missing; manual recovery is required' };
    return { eligible: false, reason: `workspace lease cannot be verified; manual recovery is required: ${error.message}` };
  }
  let lease;
  try { lease = await loadWorkspaceLease(lockableLeasePath, state.workspace); }
  catch (error) { return { eligible: false, reason: `workspace lease cannot be verified; manual recovery is required: ${error.message}` }; }
  if (lease.active_tasks.some(entry => sameStatePath(entry.state_path, filePath))) return { eligible: false, reason: 'workspace lease still has this active state path' };
  return { eligible: true, verified: true, lease_path: lockableLeasePath, reason: 'verified inactive workspace lease' };
}

function errorStateRoot(stateDir) { return path.join(path.resolve(stateDir), ERROR_STATE_DIRECTORY); }
function errorQuarantinePath(errorPath) { return path.join(errorPath, ERROR_QUARANTINE_FILENAME); }
function quarantineExpiryPath(errorPath) { return path.join(errorPath, QUARANTINE_EXPIRY_FILENAME); }
function reviewArtifactTaskPath(stateDir, taskId) { return path.join(path.resolve(stateDir), REVIEW_ARTIFACT_DIRECTORY, taskId); }
function quarantineReviewArtifactPath(errorPath) { return path.join(errorPath, QUARANTINE_REVIEW_DIRECTORY); }
function quarantineLegacyPathBinding(originalStatePath) { return createHash('sha256').update(path.resolve(originalStatePath), 'utf8').digest('hex').slice(0, 32); }
function quarantineLegacyEntryMatchesStatePath(errorPath, originalStatePath) {
  return new RegExp(`^${quarantineLegacyPathBinding(originalStatePath)}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`, 'u').test(path.basename(errorPath));
}
function quarantineAuthorityAnchor(record) {
  return createHash('sha256').update(stableJson({
    schema: 'workflow-quarantine-authority-v1',
    workspace: record.workspace,
    registry_path: record.registry_path,
    task_id: record.task_id,
    original_state_path: record.original_state_path,
    files: record.files,
    review_artifacts: record.review_artifacts ?? null,
  })).digest('hex');
}
function quarantineEntryMatchesAuthority(errorPath, record) {
  const prefix = `${record.task_id}-${record.authority_anchor}-`;
  const uuid = path.basename(errorPath).slice(prefix.length);
  return path.basename(errorPath).startsWith(prefix) && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(uuid);
}

function quarantineEntryMatchesTruncatedAuthority(errorPath, record) {
  const prefix = `${record.task_id}-${record.authority_anchor.slice(0, 32)}-`;
  const uuid = path.basename(errorPath).slice(prefix.length);
  return path.basename(errorPath).startsWith(prefix) && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(uuid);
}
function logicalTaskIdFromStatePath(filePath) {
  const taskId = path.basename(filePath, '.json');
  if (!validQuarantineTaskId(taskId)) throw new ControllerError(`State path does not contain a valid task identifier: ${filePath}`);
  return taskId;
}

function pathIsWithinPhysicalRoot(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function reviewArtifactDirectoryIsSafe(directoryPath, rootPhysical = null) {
  try {
    const directoryMetadata = await fs.lstat(directoryPath);
    if (directoryMetadata.isSymbolicLink() || !directoryMetadata.isDirectory()) return false;
    const physical = await fs.realpath(directoryPath);
    const boundary = rootPhysical ?? physical;
    if (!pathIsWithinPhysicalRoot(boundary, physical)) return false;
    const entries = await fs.readdir(directoryPath, { withFileTypes: true });
    for (const entry of entries) {
      const childPath = path.join(directoryPath, entry.name);
      const childMetadata = await fs.lstat(childPath);
      if (childMetadata.isSymbolicLink() || (!childMetadata.isFile() && !childMetadata.isDirectory())) return false;
      if (!pathIsWithinPhysicalRoot(boundary, await fs.realpath(childPath))) return false;
      if (childMetadata.isDirectory() && !await reviewArtifactDirectoryIsSafe(childPath, boundary)) return false;
    }
    return true;
  } catch { return false; }
}

function isDirectChild(parent, candidate) {
  return path.dirname(path.resolve(candidate)) === path.resolve(parent);
}

async function stateFilesForQuarantine(filePath) {
  const files = [];
  for (const sourcePath of [databasePath(filePath), filePath, `${filePath}.legacy`]) {
    try {
      const metadata = await fs.lstat(sourcePath);
      if (!metadata.isFile()) return { files: null, reason: `state component is not a regular file: ${sourcePath}` };
      files.push(sourcePath);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  if (!files.length) return { files: null, reason: 'state disappeared before quarantine' };
  return { files };
}

async function reviewArtifactRelativePaths(root, directory = root, paths = [], rootPhysical = null) {
  const boundary = rootPhysical ?? await fs.realpath(root);
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const current = path.join(directory, entry.name);
    const metadata = await fs.lstat(current);
    if (metadata.isSymbolicLink() || (!metadata.isFile() && !metadata.isDirectory()) || !pathIsWithinPhysicalRoot(boundary, await fs.realpath(current))) throw new ControllerError(`Quarantine review artifact source is unsafe: ${current}`);
    const relative = path.relative(root, current);
    paths.push(relative);
    if (metadata.isDirectory()) await reviewArtifactRelativePaths(root, current, paths, boundary);
  }
  return paths;
}

function assertWindowsQuarantinePathLimit(paths) {
  if (process.platform !== 'win32') return;
  const tooLong = paths.find(candidate => candidate.length >= MAX_WINDOWS_PATH_LENGTH);
  if (tooLong) throw new ControllerError(`Quarantine path exceeds the Windows path limit: ${tooLong}`);
}

async function assertQuarantineWritePaths(errorPath, components, artifactSource) {
  const metadataPath = errorQuarantinePath(errorPath);
  const expiryPath = quarantineExpiryPath(errorPath);
  const targets = [
    errorPath,
    metadataPath,
    expiryPath,
    atomicTemporaryPath(metadataPath),
    atomicTemporaryPath(expiryPath),
    ...components.files.map(component => path.join(errorPath, path.basename(component))),
  ];
  if (artifactSource) {
    const reviewRoot = quarantineReviewArtifactPath(errorPath);
    targets.push(reviewRoot);
    for (const relative of await reviewArtifactRelativePaths(artifactSource)) targets.push(path.join(reviewRoot, relative));
  }
  assertWindowsQuarantinePathLimit(targets);
}

function quarantineMetadataIsValid(metadata, stateDir, errorPath) {
  const currentMetadata = hasExactFields(metadata, QUARANTINE_FIELDS) && metadata.version === 4;
  const priorMetadata = hasExactFields(metadata, QUARANTINE_FIELDS_V3) && metadata.version === 3;
  const olderMetadata = hasExactFields(metadata, QUARANTINE_FIELDS_V2) && metadata.version === 2;
  const legacyMetadata = hasExactFields(metadata, QUARANTINE_FIELDS_V1) && metadata.version === 1;
  if ((!currentMetadata && !priorMetadata && !olderMetadata && !legacyMetadata) || !['quarantining', 'quarantined'].includes(metadata.status)) return false;
  if ((currentMetadata || priorMetadata || olderMetadata) && metadata.review_artifacts !== null && metadata.review_artifacts !== QUARANTINE_REVIEW_DIRECTORY) return false;
  if (typeof metadata.original_state_path !== 'string' || typeof metadata.error_path !== 'string' || typeof metadata.reason !== 'string' || !metadata.reason.trim()) return false;
  if (!validTimestamp(metadata.quarantined_at) || !validTimestamp(metadata.delete_after) || (metadata.move_error !== null && (typeof metadata.move_error !== 'string' || !metadata.move_error.trim()))) return false;
  if (!Array.isArray(metadata.files) || !metadata.files.length || metadata.files.some(name => typeof name !== 'string' || !name || path.basename(name) !== name) || new Set(metadata.files).size !== metadata.files.length) return false;
  const root = errorStateRoot(stateDir);
  if (!isDirectChild(root, errorPath) || path.resolve(metadata.error_path) !== path.resolve(errorPath)) return false;
  if (path.dirname(path.resolve(metadata.original_state_path)) !== path.resolve(stateDir) || !metadata.original_state_path.endsWith('.json')) return false;
  let logicalTaskId;
  try { logicalTaskId = logicalTaskIdFromStatePath(metadata.original_state_path); } catch { return false; }
  if (metadata.task_id !== logicalTaskId) return false;
  const logicalName = path.basename(metadata.original_state_path);
  const allowedNames = new Set([logicalName, databasePath(metadata.original_state_path), `${logicalName}.legacy`].map(candidate => path.basename(candidate)));
  if (metadata.files.some(name => !allowedNames.has(name))) return false;
  const expiry = Date.parse(metadata.quarantined_at) + ERROR_STATE_RETENTION_DAYS * DAY_MS;
  if (metadata.delete_after !== new Date(expiry).toISOString()) return false;
  if (olderMetadata || legacyMetadata) return true;
  if (priorMetadata && !quarantineLegacyEntryMatchesStatePath(errorPath, metadata.original_state_path)) return false;
  if ((metadata.workspace === null) !== (metadata.registry_path === null)) return false;
  if (metadata.workspace !== null && (typeof metadata.workspace !== 'string' || !path.isAbsolute(metadata.workspace) || path.resolve(metadata.workspace) !== metadata.workspace || typeof metadata.registry_path !== 'string' || path.resolve(metadata.registry_path) !== workspaceLeasePath(metadata.workspace))) return false;
  if (priorMetadata) return validQuarantineBinding(metadata.binding) && metadata.binding === quarantineBinding(metadata, errorPath);
  if (!validQuarantineAnchor(metadata.authority_anchor) || metadata.authority_anchor !== quarantineAuthorityAnchor(metadata) || (!quarantineEntryMatchesAuthority(errorPath, metadata) && !quarantineEntryMatchesTruncatedAuthority(errorPath, metadata))) return false;
  return validQuarantineBinding(metadata.binding) && metadata.binding === quarantineBinding(metadata, errorPath);
}

function validQuarantineBinding(binding) { return typeof binding === 'string' && /^[a-f0-9]{64}$/u.test(binding); }
function validQuarantineAnchor(anchor) { return typeof anchor === 'string' && /^[a-f0-9]{64}$/u.test(anchor); }

function quarantineBinding(record, errorPath) {
  const anchored = hasOwn(record, 'authority_anchor');
  return createHash('sha256').update(stableJson({
    schema: anchored ? 'workflow-quarantine-binding-v2' : 'workflow-quarantine-binding-v1',
    error_path: path.resolve(errorPath),
    task_id: record.task_id,
    original_state_path: record.original_state_path,
    files: record.files,
    review_artifacts: record.review_artifacts ?? null,
    workspace: record.workspace ?? null,
    registry_path: record.registry_path ?? null,
    ...(anchored ? { authority_anchor: record.authority_anchor } : {}),
  })).digest('hex');
}

function quarantineExpiryFromMetadata(metadata) {
  const current = metadata.version === 4;
  return {
    version: current ? 3 : 1,
    task_id: metadata.task_id,
    original_state_path: metadata.original_state_path,
    quarantined_at: metadata.quarantined_at,
    delete_after: metadata.delete_after,
    files: metadata.files,
    review_artifacts: metadata.review_artifacts ?? null,
    ...(current ? { workspace: metadata.workspace, registry_path: metadata.registry_path, binding: metadata.binding, authority_anchor: metadata.authority_anchor } : {}),
  };
}

function quarantineExpiryIsValid(expiry, stateDir, errorPath) {
  const currentExpiry = hasExactFields(expiry, QUARANTINE_EXPIRY_FIELDS) && expiry.version === 3;
  const priorExpiry = hasExactFields(expiry, QUARANTINE_EXPIRY_FIELDS_V2) && expiry.version === 2;
  const legacyExpiry = hasExactFields(expiry, QUARANTINE_EXPIRY_FIELDS_V1) && expiry.version === 1;
  if (!currentExpiry && !priorExpiry && !legacyExpiry) return false;
  if (typeof expiry.original_state_path !== 'string' || !validTimestamp(expiry.quarantined_at) || !validTimestamp(expiry.delete_after)) return false;
  if (!Array.isArray(expiry.files) || !expiry.files.length || expiry.files.some(name => typeof name !== 'string' || !name || path.basename(name) !== name) || new Set(expiry.files).size !== expiry.files.length) return false;
  if (expiry.review_artifacts !== null && expiry.review_artifacts !== QUARANTINE_REVIEW_DIRECTORY) return false;
  if (path.dirname(path.resolve(expiry.original_state_path)) !== path.resolve(stateDir) || !expiry.original_state_path.endsWith('.json')) return false;
  let logicalTaskId;
  try { logicalTaskId = logicalTaskIdFromStatePath(expiry.original_state_path); } catch { return false; }
  if (expiry.task_id !== logicalTaskId) return false;
  const logicalName = path.basename(expiry.original_state_path);
  const allowedNames = new Set([logicalName, databasePath(expiry.original_state_path), `${logicalName}.legacy`].map(candidate => path.basename(candidate)));
  if (expiry.files.some(name => !allowedNames.has(name))) return false;
  const expectedDeleteAfter = new Date(Date.parse(expiry.quarantined_at) + ERROR_STATE_RETENTION_DAYS * DAY_MS).toISOString();
  if (expiry.delete_after !== expectedDeleteAfter || !isDirectChild(errorStateRoot(stateDir), errorPath)) return false;
  if (legacyExpiry) return true;
  if (priorExpiry && !quarantineLegacyEntryMatchesStatePath(errorPath, expiry.original_state_path)) return false;
  if ((expiry.workspace === null) !== (expiry.registry_path === null)) return false;
  if (expiry.workspace !== null && (typeof expiry.workspace !== 'string' || !path.isAbsolute(expiry.workspace) || path.resolve(expiry.workspace) !== expiry.workspace || typeof expiry.registry_path !== 'string' || path.resolve(expiry.registry_path) !== workspaceLeasePath(expiry.workspace))) return false;
  if (priorExpiry) return validQuarantineBinding(expiry.binding) && expiry.binding === quarantineBinding(expiry, errorPath);
  if (!validQuarantineAnchor(expiry.authority_anchor) || expiry.authority_anchor !== quarantineAuthorityAnchor(expiry) || (!quarantineEntryMatchesAuthority(errorPath, expiry) && !quarantineEntryMatchesTruncatedAuthority(errorPath, expiry))) return false;
  return validQuarantineBinding(expiry.binding) && expiry.binding === quarantineBinding(expiry, errorPath);
}

function quarantineSidecarsMatch(metadata, expiry) {
  const fields = ['task_id', 'original_state_path', 'quarantined_at', 'delete_after', 'files'];
  if (!fields.every(field => sameJson(metadata[field], expiry[field])) || (metadata.review_artifacts ?? null) !== (expiry.review_artifacts ?? null)) return false;
  if (metadata.version === 4 && expiry.version === 3) {
    return metadata.workspace === expiry.workspace
      && metadata.registry_path === expiry.registry_path
      && metadata.binding === expiry.binding
      && metadata.authority_anchor === expiry.authority_anchor;
  }
  return metadata.version === 3 && expiry.version === 2
    ? metadata.workspace === expiry.workspace && metadata.registry_path === expiry.registry_path && metadata.binding === expiry.binding
    : (metadata.version === 1 || metadata.version === 2) && expiry.version === 1;
}

async function readQuarantineExpiry(stateDir, errorPath) {
  try {
    const expiry = await readJson(quarantineExpiryPath(errorPath), { label: 'Quarantined workflow expiry metadata', maxBytes: MAX_QUARANTINE_BYTES });
    if (!quarantineExpiryIsValid(expiry, stateDir, errorPath)) throw new ControllerError(`Quarantined workflow expiry metadata is invalid: ${quarantineExpiryPath(errorPath)}`);
    return expiry;
  } catch (error) {
    if (error instanceof ControllerError && error.message.includes('does not exist:')) return null;
    throw error;
  }
}

async function ensureQuarantineExpiry(stateDir, errorPath, metadata) {
  const existing = await readQuarantineExpiry(stateDir, errorPath);
  if (!existing) throw new ControllerError(`Quarantined workflow expiry metadata is missing: ${quarantineExpiryPath(errorPath)}`);
  if (!quarantineSidecarsMatch(metadata, existing)) throw new ControllerError(`Quarantine metadata and expiry binding do not match: ${errorPath}`);
  return existing;
}

async function readQuarantineMetadata(stateDir, errorPath) {
  const metadata = await readJson(errorQuarantinePath(errorPath), { label: 'Quarantined workflow state metadata', maxBytes: MAX_QUARANTINE_BYTES });
  if (!quarantineMetadataIsValid(metadata, stateDir, errorPath)) throw new ControllerError(`Quarantined workflow state metadata is invalid: ${errorQuarantinePath(errorPath)}`);
  return metadata;
}

async function quarantineIfEligible(filePath, initialState, now) {
  const initial = await quarantineEligibility(initialState, filePath, now);
  if (!initial.eligible) return { quarantined: false, reason: initial.reason, task_id: initialState?.task_id ?? null };
  try {
    const run = async (authorityContext = null) => withStateLock(filePath, async () => {
      let state;
      try { state = await loadState(filePath); } catch { state = null; }
      const current = await quarantineEligibility(state, filePath, now);
      if (!current.eligible) return { quarantined: false, reason: current.reason, task_id: state?.task_id ?? null };
      if (!current.verified || !current.lease_path) return { quarantined: false, reason: 'workspace lease was not verified for quarantine; manual recovery is required', task_id: state?.task_id ?? null };
      const components = await stateFilesForQuarantine(filePath);
      if (!components.files) return { quarantined: false, reason: components.reason, task_id: state?.task_id ?? null };
      const taskId = logicalTaskIdFromStatePath(filePath);
      const taskIdMismatch = state?.task_id !== undefined && state?.task_id !== taskId;
      let artifactSource = null;
      const candidate = reviewArtifactTaskPath(path.dirname(filePath), taskId);
      try {
        const artifactMetadata = await fs.lstat(candidate);
        if (artifactMetadata.isSymbolicLink() || !artifactMetadata.isDirectory()) return { quarantined: false, reason: `review artifact path is not a regular directory: ${candidate}`, task_id: taskId };
        artifactSource = candidate;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      if (current.verified) {
        const lease = await loadWorkspaceLease(current.lease_path, state.workspace, { authorityContext });
        const reviewSource = artifactSource ? path.resolve(candidate) : null;
        const activeEntry = await activeLeaseOwnerForSources(lease, components.files, reviewSource);
        if (activeEntry) return { quarantined: false, reason: `quarantine source belongs to an active workspace lease entry: ${activeEntry.state_path}`, task_id: taskId };
      }
      const errorRoot = errorStateRoot(path.dirname(filePath));
      const metadata = {
        version: 4,
        status: 'quarantining',
        task_id: taskId,
        original_state_path: filePath,
        error_path: '',
        reason: taskIdMismatch ? `state task_id does not match logical state path; ${current.verified ? 'verified inactive-lease quarantine gate' : current.reason}` : current.verified ? 'legacy or incomplete task state passed the verified inactive-lease quarantine gate' : current.reason,
        quarantined_at: new Date(now).toISOString(),
        delete_after: new Date(now + ERROR_STATE_RETENTION_DAYS * DAY_MS).toISOString(),
        files: components.files.map(component => path.basename(component)),
        move_error: null,
        review_artifacts: artifactSource ? QUARANTINE_REVIEW_DIRECTORY : null,
        workspace: current.verified ? state.workspace : null,
        registry_path: current.verified ? current.lease_path : null,
        binding: '',
        authority_anchor: '',
      };
      metadata.authority_anchor = quarantineAuthorityAnchor(metadata);
      const errorPath = path.join(errorRoot, `${taskId}-${metadata.authority_anchor}-${randomUUID()}`);
      metadata.error_path = errorPath;
      await assertQuarantineWritePaths(errorPath, components, artifactSource);
      await fs.mkdir(errorRoot, { recursive: true });
      await fs.mkdir(errorPath, { recursive: false });
      metadata.binding = quarantineBinding(metadata, errorPath);
      await atomicWrite(errorQuarantinePath(errorPath), metadata, MAX_QUARANTINE_BYTES, { parentAuthority: await snapshotRegularDirectory(errorPath, 'Quarantine parent') });
      await atomicWrite(quarantineExpiryPath(errorPath), quarantineExpiryFromMetadata(metadata), MAX_QUARANTINE_BYTES, { parentAuthority: await snapshotRegularDirectory(errorPath, 'Quarantine parent') });
      try {
        for (const sourcePath of components.files) await fs.rename(sourcePath, path.join(errorPath, path.basename(sourcePath)));
        if (artifactSource) await fs.rename(artifactSource, quarantineReviewArtifactPath(errorPath));
      } catch (error) {
        metadata.move_error = error.message;
        try { await atomicWrite(errorQuarantinePath(errorPath), metadata, MAX_QUARANTINE_BYTES, { parentAuthority: await snapshotRegularDirectory(errorPath, 'Quarantine parent') }); }
        catch (metadataError) { return { quarantined: false, reason: `quarantine move failed: ${error.message}; metadata update failed: ${metadataError.message}`, task_id: metadata.task_id, error_path: errorPath }; }
        return { quarantined: false, reason: `quarantine move failed: ${error.message}`, task_id: metadata.task_id, error_path: errorPath };
      }
      metadata.status = 'quarantined';
      await atomicWrite(errorQuarantinePath(errorPath), metadata, MAX_QUARANTINE_BYTES, { parentAuthority: await snapshotRegularDirectory(errorPath, 'Quarantine parent') });
      return { quarantined: true, task_id: metadata.task_id, error_path: errorPath, delete_after: metadata.delete_after };
    });
    return initial.lease_path ? await withWorkspaceLeaseLock(initialState.workspace, async (leasePath, authorityContext) => {
      if (leasePath !== initial.lease_path) throw new ControllerError('Workspace lease authority path changed before quarantine');
      return run(authorityContext);
    }, { allowAuthorityMigration: true }) : await run();
  } catch (error) {
    if (error instanceof ControllerError) throw error;
    return { quarantined: false, reason: `quarantine lock unavailable: ${error.message}`, task_id: initialState?.task_id ?? null };
  }
}

function validQuarantineTaskId(taskId) {
  return typeof taskId === 'string' && /^[A-Za-z][A-Za-z0-9._-]{0,79}$/.test(taskId);
}

async function quarantineContentsAreSafe(errorPath, record) {
  const contents = await fs.readdir(errorPath, { withFileTypes: true });
  const expectedFiles = new Set([...record.files, ERROR_QUARANTINE_FILENAME, QUARANTINE_EXPIRY_FILENAME]);
  if (record.review_artifacts) expectedFiles.add(record.review_artifacts);
  const unexpected = contents.filter(entry => !expectedFiles.has(entry.name) || (entry.name === record.review_artifacts ? !entry.isDirectory() : !entry.isFile()));
  if (contents.length !== expectedFiles.size || unexpected.length) return false;
  return !record.review_artifacts || await reviewArtifactDirectoryIsSafe(quarantineReviewArtifactPath(errorPath));
}

async function activeLeaseEntryOwnsSources(entry, sourcePaths, reviewArtifactSource) {
  const protectedPaths = [entry.state_path, databasePath(entry.state_path), `${entry.state_path}.legacy`];
  protectedPaths.push(await canonicalStateDirectory(reviewArtifactTaskPath(entry.state_dir, entry.task_id), 'active review artifact directory'));
  const candidates = [...sourcePaths];
  if (reviewArtifactSource !== null) candidates.push(await canonicalStateDirectory(reviewArtifactSource, 'candidate review artifact directory'));
  return candidates.some(candidate => protectedPaths.some(protectedPath => statePathsOverlap(candidate, protectedPath)));
}

async function activeLeaseOwnerForSources(lease, sourcePaths, reviewArtifactSource) {
  for (const entry of lease.active_tasks) {
    if (await activeLeaseEntryOwnsSources(entry, sourcePaths, reviewArtifactSource)) return entry;
  }
  return null;
}

function quarantineSourceAuthority(metadata, errorPath) {
  return stableJson({
    quarantine_entry: path.resolve(errorPath),
    binding: metadata.binding,
    workspace: metadata.workspace,
    registry_path: metadata.registry_path,
    original_state_path: metadata.original_state_path,
    files: metadata.files,
    review_artifacts: metadata.review_artifacts,
  });
}

async function withQuarantineSourceProtection(stateDir, errorPath, metadata, action) {
  if (metadata.version !== 4 || metadata.workspace === null || metadata.registry_path === null || !quarantineEntryMatchesAuthority(errorPath, metadata)) {
    throw new ControllerError('Quarantine source transfer lacks a trusted workspace registry binding');
  }
  const canonicalSourceStatePath = await canonicalStatePath(metadata.original_state_path, 'quarantine original_state_path');
  if (!sameStatePath(canonicalSourceStatePath, metadata.original_state_path) || canonicalSourceStatePath !== metadata.original_state_path) {
    throw new ControllerError('Quarantine source transfer has a non-canonical state-path authority');
  }
  const canonicalRegistryPath = path.resolve(metadata.registry_path);
  if (canonicalRegistryPath !== metadata.registry_path) throw new ControllerError('Quarantine source transfer has a non-canonical registry authority');
  const authority = quarantineSourceAuthority(metadata, errorPath);
  const registryPath = canonicalRegistryPath;
  const sourceStatePath = canonicalSourceStatePath;
  const sourceDirectory = path.dirname(sourceStatePath);
  const reviewArtifactSource = metadata.review_artifacts === QUARANTINE_REVIEW_DIRECTORY
    ? path.resolve(reviewArtifactTaskPath(sourceDirectory, logicalTaskIdFromStatePath(metadata.original_state_path)))
    : null;
  const inspectRegistry = async (candidate, authorityContext) => {
    if (quarantineSourceAuthority(candidate, errorPath) !== authority) throw new ControllerError('Quarantine source authority changed while acquiring locks');
    const registryMetadata = await fs.lstat(registryPath);
    if (registryMetadata.isSymbolicLink() || !registryMetadata.isFile()) throw new ControllerError(`Quarantine source registry is not a regular file: ${registryPath}`);
    const lease = await loadWorkspaceLease(registryPath, metadata.workspace, { authorityContext });
    const activeEntry = await activeLeaseOwnerForSources(lease, metadata.files.map(name => path.join(sourceDirectory, name)), reviewArtifactSource);
    if (activeEntry) throw new ControllerError(`Quarantine source belongs to an active workspace lease entry: ${activeEntry.state_path}`);
  };
  return withWorkspaceLeaseLock(metadata.workspace, async (lockedRegistryPath, authorityContext) => {
    if (lockedRegistryPath !== registryPath) throw new ControllerError('Quarantine source registry authority path changed');
    await inspectRegistry(metadata, authorityContext);
    return withStateLock(sourceStatePath, async () => {
      const current = await readQuarantineMetadata(stateDir, errorPath);
      await ensureQuarantineExpiry(stateDir, errorPath, current);
      await inspectRegistry(current, authorityContext);
      return action(current);
    });
  }, { allowAuthorityMigration: false });
}

async function upgradeLegacyQuarantine(stateDir, errorPath, metadata) {
  // An older sidecar never carried a registry-bound creation record.  It may
  // describe contents already present in errorPath, but cannot authorize a new
  // read from stateDir or the review-artifact root.
  return metadata;
}

async function reconcileQuarantineEntry(stateDir, errorPath, metadata) {
  let current = await upgradeLegacyQuarantine(stateDir, errorPath, metadata);
  await ensureQuarantineExpiry(stateDir, errorPath, current);
  if (current.status === 'quarantined' && current.move_error === null) return { complete: true, metadata: current };
  return withQuarantineSourceProtection(stateDir, errorPath, current, async lockedCurrent => {
    // This value was checked against the registry lock selection immediately
    // before the transfer. Never derive source paths from a later sidecar read.
    current = lockedCurrent;
    if (current.status === 'quarantined' && current.move_error === null) return { complete: true, metadata: current };
    const sourceDirectory = path.dirname(current.original_state_path);
    const missing = [];
    try {
      for (const name of current.files) {
        const destination = path.join(errorPath, name);
        try {
          const target = await fs.lstat(destination);
          if (target.isSymbolicLink() || !target.isFile()) throw new ControllerError(`Quarantine destination is not a regular file: ${destination}`);
          continue;
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
        const source = path.join(sourceDirectory, name);
        try {
          const sourceMetadata = await fs.lstat(source);
          if (sourceMetadata.isSymbolicLink() || !sourceMetadata.isFile()) throw new ControllerError(`Quarantine source is not a regular file: ${source}`);
          await fs.rename(source, destination);
        } catch (error) {
          if (error.code === 'ENOENT') missing.push(name);
          else throw error;
        }
      }
      if (current.review_artifacts) {
        const destination = quarantineReviewArtifactPath(errorPath);
        try {
          const target = await fs.lstat(destination);
          if (target.isSymbolicLink() || !target.isDirectory() || !await reviewArtifactDirectoryIsSafe(destination)) throw new ControllerError(`Quarantine review artifact destination is unsafe: ${destination}`);
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
          const taskId = logicalTaskIdFromStatePath(current.original_state_path);
          const source = reviewArtifactTaskPath(sourceDirectory, taskId);
          try {
            const sourceMetadata = await fs.lstat(source);
            if (sourceMetadata.isSymbolicLink() || !sourceMetadata.isDirectory() || !await reviewArtifactDirectoryIsSafe(source)) throw new ControllerError(`Quarantine review artifact source is unsafe: ${source}`);
            await fs.rename(source, destination);
          } catch (sourceError) {
            if (sourceError.code === 'ENOENT') missing.push(QUARANTINE_REVIEW_DIRECTORY);
            else throw sourceError;
          }
        }
      }
    } catch (error) {
      current = { ...current, status: 'quarantining', move_error: error.message };
      await atomicWrite(errorQuarantinePath(errorPath), current, MAX_QUARANTINE_BYTES, { parentAuthority: await snapshotRegularDirectory(errorPath, 'Quarantine parent') });
      return { complete: false, metadata: current };
    }
    if (missing.length) {
      current = { ...current, status: 'quarantining', move_error: `quarantine transfer is missing: ${missing.join(', ')}` };
      await atomicWrite(errorQuarantinePath(errorPath), current, MAX_QUARANTINE_BYTES, { parentAuthority: await snapshotRegularDirectory(errorPath, 'Quarantine parent') });
      return { complete: false, metadata: current };
    }
    current = { ...current, status: 'quarantined', move_error: null };
    await atomicWrite(errorQuarantinePath(errorPath), current, MAX_QUARANTINE_BYTES, { parentAuthority: await snapshotRegularDirectory(errorPath, 'Quarantine parent') });
    return { complete: true, metadata: current };
  });
}

async function deleteQuarantineEntry(stateDir, errorPath, { metadata = null, expiry }) {
  const authorityRecord = metadata ?? expiry;
  if (!authorityRecord || typeof authorityRecord.workspace !== 'string' || typeof authorityRecord.registry_path !== 'string'
    || typeof authorityRecord.authority_anchor !== 'string' || !quarantineEntryMatchesAuthority(errorPath, authorityRecord)) {
    throw new ControllerError('Quarantine deletion lacks a trusted workspace registry binding');
  }
  const workspace = await canonicalWorkspace(authorityRecord.workspace);
  if (!sameStatePath(workspace, authorityRecord.workspace) || authorityRecord.registry_path !== workspaceLeasePath(workspace)) {
    throw new ControllerError('Quarantine deletion has a non-canonical workspace registry binding');
  }
  return withWorkspaceLeaseLock(workspace, async (leasePath, authorityContext) => {
    if (leasePath !== authorityRecord.registry_path) throw new ControllerError('Quarantine deletion registry authority path changed');
    const currentExpiry = await readQuarantineExpiry(stateDir, errorPath);
    if (!currentExpiry || !sameJson(currentExpiry, expiry)) throw new ControllerError('Quarantine expiry authority changed while acquiring locks');
    let currentRecord = currentExpiry;
    if (metadata) {
      const currentMetadata = await readQuarantineMetadata(stateDir, errorPath);
      if (!sameJson(currentMetadata, metadata)) throw new ControllerError('Quarantine metadata authority changed while acquiring locks');
      await ensureQuarantineExpiry(stateDir, errorPath, currentMetadata);
      currentRecord = currentMetadata;
    }
    const lease = await loadWorkspaceLease(leasePath, workspace, { authorityContext });
    const activeEntry = await activeLeaseOwnerForSources(lease, [errorPath], null);
    if (activeEntry) throw new ControllerError(`Quarantine deletion overlaps an active workspace lease entry: ${activeEntry.task_id} (${activeEntry.state_path})`);
    if (!await quarantineContentsAreSafe(errorPath, currentRecord)) throw new ControllerError('Quarantine contains unexpected files and requires manual recovery');
    const before = await fs.lstat(errorPath, { bigint: true });
    if (before.isSymbolicLink() || !before.isDirectory()) throw new ControllerError(`Quarantine deletion target is not a regular directory: ${errorPath}`);
    const beforeIdentity = persistentFileObjectIdentity(before);
    const tombstone = `${errorPath}.delete-${randomUUID()}`;
    let isolated = false;
    try {
      await fs.rename(errorPath, tombstone); isolated = true;
      const moved = await fs.lstat(tombstone, { bigint: true });
      if (moved.isSymbolicLink() || !moved.isDirectory() || !sameFileObjectIdentity(beforeIdentity, persistentFileObjectIdentity(moved))) {
        throw new ControllerError(`Quarantine deletion target changed during atomic isolation: ${errorPath}`);
      }
      await fs.rm(tombstone, { recursive: true, force: false }); isolated = false;
    } catch (error) {
      if (isolated) {
        try { await fs.rename(tombstone, errorPath); }
        catch (restoreError) { throw new ControllerError(`Quarantine deletion failed: ${error.message}; restore failed: ${restoreError.message}`); }
      }
      throw error;
    }
  }, { allowAuthorityMigration: false });
}

async function pruneQuarantinedStates(stateDir, now) {
  const root = errorStateRoot(stateDir); const deleted = []; const retained = []; let deletedCount = 0; let retainedCount = 0;
  let entries;
  try { entries = await fs.readdir(root, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return { deleted, retained, deleted_count: deletedCount, retained_count: retainedCount }; throw error; }
  for (const entry of entries) {
    const errorPath = path.join(root, entry.name);
    if (!entry.isDirectory() || !isDirectChild(root, errorPath)) {
      retainedCount++; retained.push({ error_path: errorPath, reason: 'unknown quarantine entry is not a direct regular directory' });
      continue;
    }
    let metadata = null;
    try { metadata = await readQuarantineMetadata(stateDir, errorPath); }
    catch (metadataError) {
      let expiry;
      try { expiry = await readQuarantineExpiry(stateDir, errorPath); }
      catch (expiryError) { retainedCount++; retained.push({ error_path: errorPath, reason: `${metadataError.message}; ${expiryError.message}` }); continue; }
      if (!expiry) { retainedCount++; retained.push({ error_path: errorPath, reason: `${metadataError.message}; expiry metadata is unavailable` }); continue; }
      if (now < Date.parse(expiry.delete_after)) {
        retainedCount++; retained.push({ task_id: expiry.task_id, error_path: errorPath, delete_after: expiry.delete_after, reason: 'quarantine metadata is unreadable; expiry retention period has not elapsed' });
        continue;
      }
      try {
        await deleteQuarantineEntry(stateDir, errorPath, { expiry });
        deletedCount++; deleted.push({ task_id: expiry.task_id, error_path: errorPath, quarantined_at: expiry.quarantined_at, delete_after: expiry.delete_after, recovered_from_invalid_metadata: true });
      } catch (error) {
        retainedCount++; retained.push({ task_id: expiry.task_id, error_path: errorPath, reason: `quarantined state deletion failed: ${error.message}` });
      }
      continue;
    }
    try {
      const reconciled = await reconcileQuarantineEntry(stateDir, errorPath, metadata);
      metadata = reconciled.metadata;
      if (!reconciled.complete) {
        retainedCount++; retained.push({ task_id: metadata.task_id, error_path: errorPath, reason: 'quarantine transfer is incomplete and will be retried by a later cleanup' });
        continue;
      }
    } catch (error) {
      retainedCount++; retained.push({ task_id: metadata.task_id, error_path: errorPath, reason: `quarantine reconciliation failed: ${error.message}` });
      continue;
    }
    let expiry;
    try { expiry = await ensureQuarantineExpiry(stateDir, errorPath, metadata); }
    catch (error) { retainedCount++; retained.push({ task_id: metadata.task_id, error_path: errorPath, reason: `quarantine expiry metadata failed: ${error.message}` }); continue; }
    if (now < Date.parse(expiry.delete_after)) {
      retainedCount++; retained.push({ task_id: metadata.task_id, error_path: errorPath, delete_after: expiry.delete_after, reason: 'quarantined state retention period has not elapsed' });
      continue;
    }
    try {
      await deleteQuarantineEntry(stateDir, errorPath, { metadata, expiry });
      deletedCount++; deleted.push({ task_id: metadata.task_id, error_path: errorPath, quarantined_at: metadata.quarantined_at, delete_after: metadata.delete_after });
    } catch (error) {
      retainedCount++; retained.push({ task_id: metadata.task_id, error_path: errorPath, reason: `quarantined state deletion failed: ${error.message}` });
    }
  }
  return { deleted, retained, deleted_count: deletedCount, retained_count: retainedCount };
}

async function reconcileQuarantinedStates(parameters) {
  const stateDir = await canonicalStateDirectory(parameters.state_dir);
  const root = errorStateRoot(stateDir);
  const reconciled = []; const retained = [];
  let entries;
  try { entries = await fs.readdir(root, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return { state_dir: stateDir, reconciled, retained, reconciled_count: 0, retained_count: 0 }; throw error; }
  for (const entry of entries) {
    const errorPath = path.join(root, entry.name);
    if (!entry.isDirectory() || !isDirectChild(root, errorPath)) {
      retained.push({ error_path: errorPath, reason: 'unknown quarantine entry is not a direct regular directory' });
      continue;
    }
    let metadata;
    try { metadata = await readQuarantineMetadata(stateDir, errorPath); }
    catch (error) { retained.push({ error_path: errorPath, reason: error.message }); continue; }
    try {
      const outcome = await reconcileQuarantineEntry(stateDir, errorPath, metadata);
      if (outcome.complete) reconciled.push({ task_id: outcome.metadata.task_id, error_path: errorPath, status: outcome.metadata.status });
      else retained.push({ task_id: outcome.metadata.task_id, error_path: errorPath, reason: outcome.metadata.move_error ?? 'quarantine transfer is incomplete' });
    } catch (error) {
      retained.push({ task_id: metadata.task_id, error_path: errorPath, reason: error.message });
    }
  }
  return { state_dir: stateDir, reconciled, retained, reconciled_count: reconciled.length, retained_count: retained.length };
}

async function findQuarantinedState(stateDir, filePath) {
  const root = errorStateRoot(stateDir);
  let entries;
  try { entries = await fs.readdir(root, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const errorPath = path.join(root, entry.name);
    try {
      const metadata = await readQuarantineMetadata(stateDir, errorPath);
      if (sameStatePath(metadata.original_state_path, filePath)) return metadata;
    } catch {
      // Malformed entries are intentionally left in place and are not attributed to a task.
    }
  }
  return null;
}

async function listOrphanLegacyPaths(stateDir) {
  let entries;
  try { entries = await fs.readdir(stateDir, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const orphaned = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json.legacy')) continue;
    const logicalPath = path.join(stateDir, entry.name.slice(0, -'.legacy'.length));
    try {
      await fs.access(logicalPath);
      continue;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    try {
      await fs.access(databasePath(logicalPath));
    } catch (error) {
      if (error.code === 'ENOENT') orphaned.push(entry.name);
      else throw error;
    }
  }
  return orphaned.sort();
}

async function doctorStateDirectory(parameters) {
  const stateDir = await canonicalStateDirectory(parameters.state_dir);
  const root = errorStateRoot(stateDir);
  const quarantinedStates = [];
  const invalidEntries = [];
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      const errorPath = path.join(root, entry.name);
      if (!entry.isDirectory()) { invalidEntries.push({ path: errorPath, reason: 'entry is not a quarantine directory' }); continue; }
      try {
        const metadata = await readQuarantineMetadata(stateDir, errorPath);
        quarantinedStates.push({ task_id: metadata.task_id, state_path: metadata.original_state_path, error_path: errorPath, status: metadata.status, delete_after: metadata.delete_after, review_artifacts: metadata.review_artifacts ?? null });
      } catch (error) {
        invalidEntries.push({ path: errorPath, reason: error.message });
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const orphanLegacy = await listOrphanLegacyPaths(stateDir);
  const pruneSweep = await readPruneSweep(stateDir);
  const attention = quarantinedStates.length > 0 || orphanLegacy.length > 0 || Boolean(pruneSweep.error);
  return {
    task_id: null,
    state_dir: stateDir,
    health: invalidEntries.length ? 'blocked' : attention ? 'attention' : 'healthy',
    checks: [
      doctorCheck('quarantined_states', invalidEntries.length ? 'fail' : quarantinedStates.length ? 'attention' : 'pass', { entries: quarantinedStates, invalid_entries: invalidEntries }),
      doctorCheck('orphan_legacy', orphanLegacy.length ? 'attention' : 'pass', { paths: orphanLegacy }),
      doctorCheck('prune_sweep', pruneSweep.error ? 'attention' : 'pass', pruneSweep.error ? { error: pruneSweep.error } : pruneSweep.sweep ?? { last_sweep_at: null, last_result: null }),
    ],
    close_status: { close_allowed: false, reasons: ['directory-level diagnosis does not represent a task close gate'] },
  };
}

async function listTaskStatePaths(stateDir) {
  const entries = await fs.readdir(stateDir, { withFileTypes: true });
  const paths = new Set();
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (entry.name.endsWith(SQLITE_STATE_SUFFIX)) {
      paths.add(path.join(stateDir, `${entry.name.slice(0, -SQLITE_STATE_SUFFIX.length)}.json`));
      continue;
    }
    if (!entry.name.endsWith('.json') || entry.name === 'workspace-lease.json' || entry.name === PRUNE_SWEEP_FILENAME) continue;
    const logicalPath = path.join(stateDir, entry.name);
    try {
      await fs.access(databasePath(logicalPath));
    } catch (error) {
      if (error.code === 'ENOENT') paths.add(logicalPath);
      else throw error;
    }
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json.legacy')) continue;
    const logicalPath = path.join(stateDir, entry.name.slice(0, -'.legacy'.length));
    if (paths.has(logicalPath)) continue;
    try {
      await fs.access(databasePath(logicalPath));
    } catch (error) {
      if (error.code === 'ENOENT') paths.add(logicalPath);
      else throw error;
    }
  }
  return [...paths].sort();
}

function appendPruneReport(reports, target, value) {
  if (Object.values(reports).reduce((count, entries) => count + entries.length, 0) < MAX_PRUNE_REPORT_ENTRIES) target.push(value);
}

function compactPruneResult(result) {
  return {
    deleted_count: result.deleted_count,
    quarantined_count: result.quarantined_count,
    retained_count: result.retained_count,
    quarantine_deleted_count: result.quarantine_deleted_count,
    quarantine_retained_count: result.quarantine_retained_count,
    report_truncated: result.report_truncated,
  };
}

function pruneSweepIsValid(value) {
  return hasExactFields(value, PRUNE_SWEEP_FIELDS)
    && value.version === 1
    && validTimestamp(value.last_sweep_at)
    && hasExactFields(value.last_result, PRUNE_RESULT_FIELDS)
    && Object.values(value.last_result).every(item => typeof item === 'boolean' || (Number.isSafeInteger(item) && item >= 0));
}

async function readPruneSweep(stateDir) {
  try {
    const sweep = await readJson(path.join(stateDir, PRUNE_SWEEP_FILENAME), { label: 'Prune sweep state', maxBytes: 4096 });
    if (!pruneSweepIsValid(sweep)) throw new ControllerError('Prune sweep state is invalid');
    return { sweep, error: null };
  } catch (error) {
    if (error instanceof ControllerError && error.message.includes('does not exist:')) return { sweep: null, error: null };
    return { sweep: null, error: error.message };
  }
}

async function pruneExpiredTasks(parameters) {
  const stateDir = await canonicalStateDirectory(parameters.state_dir);
  const now = Date.now();
  const reports = { deleted: [], quarantined: [], retained: [], quarantine_deleted: [], quarantine_retained: [] };
  const quarantinedStateCleanup = await pruneQuarantinedStates(stateDir, now);
  for (const entry of quarantinedStateCleanup.deleted) appendPruneReport(reports, reports.quarantine_deleted, entry);
  for (const entry of quarantinedStateCleanup.retained) appendPruneReport(reports, reports.quarantine_retained, entry);
  let filePaths;
  try { filePaths = await listTaskStatePaths(stateDir); }
  catch (error) {
    if (error.code === 'ENOENT') return {
      state_dir: stateDir,
      retention_days: DEFAULT_TASK_RETENTION_DAYS,
      quarantine_after_days: QUARANTINE_AFTER_DAYS,
      error_retention_days: ERROR_STATE_RETENTION_DAYS,
      deleted_count: 0,
      quarantined_count: 0,
      retained_count: 0,
      quarantine_deleted_count: quarantinedStateCleanup.deleted_count,
      quarantine_retained_count: quarantinedStateCleanup.retained_count,
      report_truncated: quarantinedStateCleanup.deleted_count > reports.quarantine_deleted.length || quarantinedStateCleanup.retained_count > reports.quarantine_retained.length,
      ...reports,
    };
    throw error;
  }
  let deletedCount = 0; let quarantinedCount = 0; let retainedCount = 0;
  for (const filePath of filePaths) {
    let initial;
    try { initial = await loadState(filePath); }
    catch (error) {
      const quarantine = await quarantineIfEligible(filePath, null, now);
      if (quarantine.quarantined) { quarantinedCount++; appendPruneReport(reports, reports.quarantined, { task_id: quarantine.task_id, state_path: filePath, error_path: quarantine.error_path, delete_after: quarantine.delete_after }); }
      else { retainedCount++; appendPruneReport(reports, reports.retained, { state_path: filePath, reason: `unreadable state: ${error.message}; ${quarantine.reason}` }); }
      continue;
    }
    const initialEligibility = taskPruneEligibility(initial, filePath, now);
    if (!initialEligibility.eligible) {
      const quarantine = await quarantineIfEligible(filePath, initial, now);
      if (quarantine.quarantined) { quarantinedCount++; appendPruneReport(reports, reports.quarantined, { task_id: quarantine.task_id, state_path: filePath, error_path: quarantine.error_path, delete_after: quarantine.delete_after }); }
      else { retainedCount++; appendPruneReport(reports, reports.retained, { task_id: initial.task_id ?? null, state_path: filePath, reason: quarantine.reason === 'younger than quarantine retention period' ? initialEligibility.reason : `${initialEligibility.reason}; ${quarantine.reason}` }); }
      continue;
    }
    const leasePath = initial.workspace_lease.registry_path;
    let parentAuthority;
    try {
      parentAuthority = await stateParentAuthorityForState(initial, filePath);
      await verifyRegularDirectorySnapshot(parentAuthority, 'Controller state parent');
    } catch (error) {
      retainedCount++; appendPruneReport(reports, reports.retained, { task_id: initial.task_id, state_path: filePath, reason: `cleanup failed: ${error.message}` });
      continue;
    }
    try {
      const cleanup = async (lockedLeasePath, authorityContext) => {
        if (lockedLeasePath !== leasePath) throw new ControllerError('Workspace lease authority path changed before cleanup');
        return withStateLock(filePath, async () => {
        await verifyRegularDirectorySnapshot(parentAuthority, 'Controller state parent');
        let state;
        try { state = await loadState(filePath); }
        catch (error) { if (error instanceof ControllerError && error.message.startsWith('JSON input does not exist:')) return { deleted: false, reason: 'state disappeared before cleanup' }; throw error; }
        const currentParentAuthority = await stateParentAuthorityForState(state, filePath);
        if (!sameStateParentAuthority(currentParentAuthority, parentAuthority)) throw new ControllerError(`Controller state parent authority changed: ${filePath}`);
        await attachStateParentAuthority(state, filePath, parentAuthority);
        const eligibility = taskPruneEligibility(state, filePath, now);
        if (!eligibility.eligible) return { deleted: false, reason: eligibility.reason, task_id: state.task_id };
        const leaseEligibility = await releasedLeaseEligibility(leasePath, state, filePath, authorityContext);
        if (!leaseEligibility.eligible) return { deleted: false, reason: leaseEligibility.reason, task_id: state.task_id };
          await deleteState(filePath, { parentAuthority });
          return { deleted: true, task_id: state.task_id };
        }, { parentAuthority });
      };
      let outcome;
      try { outcome = await withWorkspaceLeaseLock(initial.workspace, cleanup, { allowAuthorityMigration: true }); }
      catch (error) {
        if (!(error instanceof ControllerError && error.message.startsWith('Workspace lease authority does not exist:'))) throw error;
        outcome = await withLegacyReleasedWorkspaceLeaseLock(initial.workspace, cleanup);
      }
      if (outcome.deleted) { deletedCount++; appendPruneReport(reports, reports.deleted, { task_id: outcome.task_id, state_path: filePath }); }
      else { retainedCount++; appendPruneReport(reports, reports.retained, { task_id: outcome.task_id ?? initial.task_id, state_path: filePath, reason: outcome.reason }); }
    } catch (error) {
      retainedCount++; appendPruneReport(reports, reports.retained, { task_id: initial.task_id, state_path: filePath, reason: `cleanup failed: ${error.message}` });
    }
  }
  return {
    state_dir: stateDir,
    retention_days: DEFAULT_TASK_RETENTION_DAYS,
    quarantine_after_days: QUARANTINE_AFTER_DAYS,
    error_retention_days: ERROR_STATE_RETENTION_DAYS,
    deleted_count: deletedCount,
    quarantined_count: quarantinedCount,
    retained_count: retainedCount,
    quarantine_deleted_count: quarantinedStateCleanup.deleted_count,
    quarantine_retained_count: quarantinedStateCleanup.retained_count,
    report_truncated: deletedCount > reports.deleted.length
      || quarantinedCount > reports.quarantined.length
      || retainedCount > reports.retained.length
      || quarantinedStateCleanup.deleted_count > reports.quarantine_deleted.length
      || quarantinedStateCleanup.retained_count > reports.quarantine_retained.length,
    ...reports,
  };
}

async function maybePruneExpiredTasks(parameters, { parentAuthority = null } = {}) {
  const stateDir = await canonicalStateDirectory(parameters.state_dir);
  let authority = parentAuthority;
  if (authority === null) {
    try { authority = await snapshotRegularDirectory(stateDir, 'Sweep parent'); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
  }
  if (!validStateParentAuthority(authority, path.join(stateDir, PRUNE_SWEEP_FILENAME))) {
    throw new ControllerError(`Invalid sweep parent authority: ${stateDir}`);
  }
  await verifyRegularDirectorySnapshot(authority, 'Sweep parent');
  const sweepPath = path.join(stateDir, PRUNE_SWEEP_FILENAME);
  await withStateLock(sweepPath, async () => {
    await verifyRegularDirectorySnapshot(authority, 'Sweep parent');
    const { sweep: prior } = await readPruneSweep(stateDir);
    if (prior && Date.now() - Date.parse(prior.last_sweep_at) < PRUNE_SWEEP_INTERVAL_MS) return;
    const result = await pruneExpiredTasks({ state_dir: stateDir });
    await atomicWrite(sweepPath, { version: 1, last_sweep_at: utcNow(), last_result: compactPruneResult(result) }, MAX_STATE_BYTES, { parentAuthority: authority });
  }, { parentAuthority: authority });
}

async function persistedStateParentAuthority(parameters) {
  if (parameters?.task_id === undefined) return null;
  const filePath = await configuredStatePath(parameters, requiredString(parameters.task_id, 'task_id'));
  let state;
  try { state = await loadState(filePath); }
  catch (error) {
    if (error instanceof ControllerError && (error.message.startsWith('JSON input does not exist:') || error.message.startsWith('Controller state does not exist:'))) return null;
    throw error;
  }
  if (!state.workspace_lease) return null;
  const authority = await stateParentAuthorityForState(state, filePath);
  await verifyRegularDirectorySnapshot(authority, 'Controller state parent');
  return authority;
}

async function recoverTaskLock(parameters) {
  const [filePath, state] = await readTask(parameters);
  if (!state.workspace_lease) throw new ControllerError('Legacy task has no workspace lease and cannot recover its lock; create a new workflow task');
  const parentAuthority = await stateParentAuthorityForState(state, filePath);
  await verifyRegularDirectorySnapshot(parentAuthority, 'Controller state parent');
  return withWorkspaceLeaseLock(state.workspace, async (leasePath, authorityContext) => {
    if (leasePath !== state.workspace_lease.registry_path) throw new ControllerError('Workspace lease authority path changed before lock recovery');
    await requireActiveWorkspaceLease(state, filePath, authorityContext);
    return recoverStaleLock(filePath, parameters.stale_after_sec, { parentAuthority });
  }, { allowAuthorityMigration: true });
}

async function auditContext(parameters) {
  const [, state] = await readTask(parameters);
  return { task_id: state.task_id, workspace_claims: state.workspace_claims, assurance_level: state.assurance_level, effective_assurance_level: effectiveAssuranceLevel(state), assurance_assessment: state.assurance_assessment, review_protocol_version: state.review_protocol_version, review_entry_stage: state.review_entry_stage, review_context: state.review_context, review_history_digest: protocolReviewHistoryDigest(state, { excludeActiveCohortPhase: true }), goal: state.goal, requirements: state.requirements, scope: state.scope, non_goals: state.non_goals, nodes: Object.values(state.nodes), participants: state.participants, reviews: externallyVisibleReviews(state), repair_records: state.repair_records, max_review_charter: state.max_review_charter ?? null, verification_record: state.verification_record, verification_history: state.verification_history, workflow_snapshot: workflowSnapshot(state), workspace_fingerprint: await workspaceFingerprint(state.workspace, state.workspace_claims) };
}

function requireRequirementCoverage(state, coverage, label) {
  const expectedIds = new Set(state.requirements.map(item => item.id));
  if (!coverage || typeof coverage !== 'object' || Array.isArray(coverage) || Object.keys(coverage).length !== expectedIds.size || [...expectedIds].some(id => !hasOwn(coverage, id) || !nonEmptyReviewValue(coverage[id]))) {
    throw new ControllerError(`${label} must provide non-empty coverage for every requirement`);
  }
  return coverage;
}

function unfinishedMaterialNodes(state) {
  return Object.values(state.nodes).filter(node => !isReviewNode(node, state.routing_schema_version) && ![SUCCEEDED, 'skipped'].includes(node.status));
}

async function recordVerification(parameters) {
  const verification = await readJson(parameters.verification, { label: 'Verification record', maxBytes: MAX_REVIEW_BYTES });
  if (!verification || typeof verification !== 'object') throw new ControllerError('Verification record must be a JSON object');
  const [filePath] = await readTask(parameters);
  return withActiveWorkspaceStateLock(filePath, async state => {
    if (state.routing_schema_version !== 2 || state.assurance_level !== 'verification') throw new ControllerError('A verification record is only valid for a v2 verification assurance task');
    const unfinished = unfinishedMaterialNodes(state);
    if (unfinished.length) throw new ControllerError(`Verification cannot be recorded before all work nodes finish: ${unfinished.map(node => node.id).join(', ')}`);
    const verifiedBy = requiredString(verification.verified_by, 'verified_by');
    const coverage = requireRequirementCoverage(state, verification.requirement_coverage, 'Verification record');
    const snapshot = workflowSnapshot(state);
    if (!sameJson(verification.workflow_snapshot, snapshot)) throw new ControllerError('Verification workflow_snapshot does not match the current task state');
    const fingerprint = await workspaceFingerprint(state.workspace, state.workspace_claims);
    if (!sameJson(verification.workspace_fingerprint, fingerprint)) throw new ControllerError('Verification fingerprint does not match the current workspace');
    const scopeAndRegression = requiredReviewValue(verification.scope_and_regression, 'scope_and_regression');
    const verificationGaps = requiredReviewValue(verification.verification_gaps, 'verification_gaps');
    const residualRisk = requiredReviewValue(verification.residual_risk, 'residual_risk');
    const record = { verified_by: verifiedBy, requirement_coverage: coverage, scope_and_regression: scopeAndRegression, verification_gaps: verificationGaps, residual_risk: residualRisk, workflow_snapshot: snapshot, workspace_fingerprint: fingerprint };
    if (state.verification_record) {
      const { recorded_at: ignoredRecordedAt, ...existingRecord } = state.verification_record;
      if (sameJson(existingRecord, record)) return { task_id: state.task_id, assurance_level: state.assurance_level, effective_assurance_level: effectiveAssuranceLevel(state), verification_record: state.verification_record, idempotent: true };
      throw new ControllerError('A different verification record already exists; call workflow_invalidate_gate before recording a replacement');
    }
    state.verification_record = { ...record, recorded_at: utcNow() };
    addEvent(state, 'verification_recorded', { verified_by: verifiedBy }); await writeState(filePath, state);
    return { task_id: state.task_id, assurance_level: state.assurance_level, effective_assurance_level: effectiveAssuranceLevel(state), verification_record: state.verification_record, idempotent: false };
  });
}

async function recordRepair(parameters) {
  const repair = await readJson(parameters.repair, { label: 'Terra repair record', maxBytes: MAX_REVIEW_BYTES });
  if (!repair || typeof repair !== 'object' || Array.isArray(repair)) throw new ControllerError('Terra repair record must be a JSON object');
  const [filePath] = await readTask(parameters);
  return withActiveWorkspaceStateLock(filePath, async state => {
    const reviewNode = reviewNodesForState(state)[0];
    if (isReviewProtocolState(state) && reviewNode && isCohortReviewNode(state, reviewNode) && reviewNode.status === 'failed') {
      const aggregate = reviewNode.review_gate.cohort.aggregate;
      const sourceClaimId = requiredString(repair.source_review_claim_id, 'source_review_claim_id');
      const syntheticSource = { claim_id: `cohort:${reviewNode.review_gate.cohort.round_id}`, findings: (aggregate?.findings ?? []).map(finding => ({ ...finding, id: finding.finding_ref })) };
      if (!aggregate || aggregate.verdict !== 'fail' || sourceClaimId !== syntheticSource.claim_id) throw new ControllerError('A Terra cohort repair must reference the failed cohort round');
      if (state.repair_records.some(record => record.source_review_claim_id === sourceClaimId)) throw new ControllerError('The failed Terra cohort already has a repair record');
      const repairedBy = requiredString(repair.repaired_by, 'repaired_by');
      const addressedFindings = addressedReviewFindings(syntheticSource, repair.addressed_findings);
      const verificationEvidence = requiredReviewValue(repair.verification_evidence, 'verification_evidence');
      const fingerprint = await workspaceFingerprint(state.workspace, state.workspace_claims);
      if (!sameJson(repair.workspace_fingerprint, fingerprint)) throw new ControllerError('Terra cohort repair fingerprint does not match the current workspace');
      const stored = { source_review_claim_id: sourceClaimId, source_review_auditor_task: 'terra_cohort', source_workspace_fingerprint: aggregate.workspace_fingerprint ?? fingerprint, repaired_by: repairedBy, addressed_findings: addressedFindings, verification_evidence: verificationEvidence, workflow_snapshot: workflowSnapshot(state), workspace_fingerprint: fingerprint, workspace_changed: true, recorded_at: utcNow(), terra_cohort: true };
      state.repair_records.push(stored);
      addEvent(state, 'terra_cohort_repair_recorded', { node_id: reviewNode.id, source_review_claim_id: sourceClaimId, repaired_by: repairedBy });
      await writeState(filePath, state);
      return { task_id: state.task_id, assurance_level: state.assurance_level, effective_assurance_level: effectiveAssuranceLevel(state), repair_record: stored };
    }
    if (isReviewProtocolState(state) && reviewNode && protocolStageForNode(reviewNode) === 'terra_single' && reviewNode.status === 'failed') {
      const sourceReview = protocolLatestFailedReview(state, reviewNode);
      const sourceClaimId = requiredString(repair.source_review_claim_id, 'source_review_claim_id');
      if (!sourceReview || sourceClaimId !== sourceReview.claim_id) throw new ControllerError('A Terra single-stage repair must reference the latest failed review claim');
      if (state.repair_records.some(record => record.source_review_claim_id === sourceClaimId)) throw new ControllerError('The failed Terra review already has a repair record');
      const repairedBy = requiredString(repair.repaired_by, 'repaired_by');
      const addressedFindings = addressedReviewFindings(sourceReview, repair.addressed_findings);
      const verificationEvidence = requiredReviewValue(repair.verification_evidence, 'verification_evidence');
      const fingerprint = await workspaceFingerprint(state.workspace, state.workspace_claims);
      if (!sameJson(repair.workspace_fingerprint, fingerprint)) throw new ControllerError('Terra repair fingerprint does not match the current workspace');
      const stored = { source_review_claim_id: sourceClaimId, source_review_auditor_task: sourceReview.auditor_task, source_workspace_fingerprint: sourceReview.workspace_fingerprint, repaired_by: repairedBy, addressed_findings: addressedFindings, verification_evidence: verificationEvidence, workflow_snapshot: workflowSnapshot(state), workspace_fingerprint: fingerprint, workspace_changed: !sameJson(fingerprint, sourceReview.workspace_fingerprint), recorded_at: utcNow(), terra_stage: 'terra_single' };
      state.repair_records.push(stored);
      addEvent(state, 'terra_single_repair_recorded', { node_id: reviewNode.id, source_review_claim_id: sourceClaimId, repaired_by: repairedBy });
      await writeState(filePath, state);
      return { task_id: state.task_id, assurance_level: state.assurance_level, effective_assurance_level: effectiveAssuranceLevel(state), repair_record: stored };
    }
    if (isReviewProtocolState(state) && reviewNode && reviewNode.kind === 'total_review' && !isMaxReviewNode(reviewNode) && reviewNode.status === 'failed') {
      const sourceReview = protocolLatestFailedReview(state, reviewNode);
      const sourceClaimId = requiredString(repair.source_review_claim_id, 'source_review_claim_id');
      if (!sourceReview || sourceClaimId !== sourceReview.claim_id) throw new ControllerError('A Sol repair record must reference the latest failed review claim');
      if (state.repair_records.some(record => record.source_review_claim_id === sourceClaimId)) throw new ControllerError('The failed Sol review already has a repair record');
      const repairedBy = requiredString(repair.repaired_by, 'repaired_by');
      const addressedFindings = addressedReviewFindings(sourceReview, repair.addressed_findings);
      const verificationEvidence = requiredReviewValue(repair.verification_evidence, 'verification_evidence');
      const fingerprint = await workspaceFingerprint(state.workspace, state.workspace_claims);
      if (!sameJson(repair.workspace_fingerprint, fingerprint)) throw new ControllerError('Sol repair fingerprint does not match the current workspace');
      const stored = { source_review_claim_id: sourceClaimId, source_review_auditor_task: sourceReview.auditor_task, source_workspace_fingerprint: sourceReview.workspace_fingerprint, repaired_by: repairedBy, addressed_findings: addressedFindings, verification_evidence: verificationEvidence, workflow_snapshot: workflowSnapshot(state), workspace_fingerprint: fingerprint, workspace_changed: !sameJson(fingerprint, sourceReview.workspace_fingerprint), recorded_at: utcNow(), sol_stage: protocolStageForNode(reviewNode) };
      state.repair_records.push(stored);
      addEvent(state, 'sol_review_repair_recorded', { node_id: reviewNode.id, source_review_claim_id: sourceClaimId, repaired_by: repairedBy, stage: protocolStageForNode(reviewNode) });
      await writeState(filePath, state);
      return { task_id: state.task_id, assurance_level: state.assurance_level, effective_assurance_level: effectiveAssuranceLevel(state), repair_record: stored };
    }
    if (isReviewProtocolState(state) && reviewNode && protocolStageForNode(reviewNode) === 'sol_max_initial' && reviewNode.status === 'failed') {
      throw new ControllerError('A Sol/max initial failure must first freeze its closure charter through workflow_retry');
    }
    if (reviewNode && isMaxClosureNode(state, reviewNode)) {
      const charter = requireMaxReviewCharter(state, reviewNode);
      if (!['initial_repair_required', 'repair_required'].includes(charter.status) || reviewNode.status !== 'blocked') throw new ControllerError('A max repair record requires a blocked max review charter awaiting protected repair');
      const sourceClaimId = requiredString(repair.source_review_claim_id, 'source_review_claim_id');
      if (sourceClaimId !== charter.pending_repair_source_claim_id) throw new ControllerError('Max repair record must reference the charter pending repair review claim');
      if (state.repair_records.some(record => record.source_review_claim_id === sourceClaimId)) throw new ControllerError('The max review source already has a repair record');
      const sourceReview = state.reviews.find(review => review.claim_id === sourceClaimId);
      if (!sourceReview || sourceReview.verdict !== 'fail') throw new ControllerError('Max repair record requires its recorded failed source review');
      const repairedBy = requiredString(repair.repaired_by, 'repaired_by');
      const addressedFindings = addressedReviewFindings({ findings: charter.blocking_findings }, repair.addressed_findings);
      const verificationEvidence = requiredReviewValue(repair.verification_evidence, 'verification_evidence');
      const fingerprint = await workspaceFingerprint(state.workspace, state.workspace_claims);
      if (!sameJson(repair.workspace_fingerprint, fingerprint)) throw new ControllerError('Max repair fingerprint does not match the current workspace');
      if (state.repair_records.length >= MAX_REPAIR_RECORDS) throw new ControllerError(`Task exceeded the ${MAX_REPAIR_RECORDS}-repair record limit; create a replacement workflow task`);
      const workspaceChanged = !sameJson(fingerprint, sourceReview.workspace_fingerprint);
      charter.repair_count += 1;
      charter.status = 'closure_ready';
      charter.pending_repair_source_claim_id = null;
      charter.active_closure_claim_id = null;
      const stored = { source_review_claim_id: sourceClaimId, source_review_auditor_task: sourceReview.auditor_task, source_workspace_fingerprint: sourceReview.workspace_fingerprint, repaired_by: repairedBy, addressed_findings: addressedFindings, verification_evidence: verificationEvidence, workflow_snapshot: workflowSnapshot(state), workspace_fingerprint: fingerprint, workspace_changed: workspaceChanged, max_review_charter: true, recorded_at: utcNow() };
      state.repair_records.push(stored);
      addEvent(state, 'max_review_repair_recorded', { source_review_claim_id: sourceClaimId, repaired_by: repairedBy, workspace_changed: workspaceChanged, blocking_finding_ids: charter.blocking_finding_ids });
      await writeState(filePath, state);
      return { task_id: state.task_id, assurance_level: state.assurance_level, effective_assurance_level: effectiveAssuranceLevel(state), repair_record: stored, max_review_charter: charter };
    }
    if (state.routing_schema_version !== 2 || state.assurance_level !== 'terra') throw new ControllerError('A repair record is only valid for a v2 terra assurance task');
    if (!reviewNode || reviewNode.kind !== QUALITY_REVIEW_KIND || reviewNode.status !== 'failed') throw new ControllerError('A Terra repair record requires a completed failed quality_review');
    const failedReviews = finalFailedTerraReviews(state, reviewNode);
    if (failedReviews.length !== 1) throw new ControllerError('A repair record is only valid after the first finalized Terra fail');
    const sourceReview = failedReviews[0];
    const sourceClaimId = requiredString(repair.source_review_claim_id, 'source_review_claim_id');
    if (sourceClaimId !== sourceReview.claim_id) throw new ControllerError('Terra repair record must reference the first failed Terra review claim');
    if (state.repair_records.some(record => record.source_review_claim_id === sourceClaimId)) throw new ControllerError('The first failed Terra review already has a repair record');
    const repairedBy = requiredString(repair.repaired_by, 'repaired_by');
    const addressedFindings = addressedReviewFindings(sourceReview, repair.addressed_findings);
    const verificationEvidence = requiredReviewValue(repair.verification_evidence, 'verification_evidence');
    const fingerprint = await workspaceFingerprint(state.workspace, state.workspace_claims);
    if (!sameJson(repair.workspace_fingerprint, fingerprint)) throw new ControllerError('Terra repair fingerprint does not match the current workspace');
    const workspaceChanged = !sameJson(fingerprint, sourceReview.workspace_fingerprint);
    if (state.repair_records.length >= MAX_REPAIR_RECORDS) throw new ControllerError(`Task exceeded the ${MAX_REPAIR_RECORDS}-repair record limit; create a replacement workflow task`);
    bumpWorkflowRevision(state, 'terra_repair_recorded', { source_review_claim_id: sourceClaimId, repaired_by: repairedBy, workspace_changed: workspaceChanged });
    const stored = {
      source_review_claim_id: sourceClaimId,
      source_review_auditor_task: sourceReview.auditor_task,
      source_workspace_fingerprint: sourceReview.workspace_fingerprint,
      repaired_by: repairedBy,
      addressed_findings: addressedFindings,
      verification_evidence: verificationEvidence,
      workflow_snapshot: workflowSnapshot(state),
      workspace_fingerprint: fingerprint,
      workspace_changed: workspaceChanged,
      recorded_at: utcNow(),
    };
    state.repair_records.push(stored); await writeState(filePath, state);
    return { task_id: state.task_id, assurance_level: state.assurance_level, effective_assurance_level: effectiveAssuranceLevel(state), repair_record: stored };
  });
}

async function recordReview(parameters) {
  const review = await readJson(parameters.review, { label: 'Review', maxBytes: MAX_REVIEW_BYTES }); if (!review || typeof review !== 'object') throw new ControllerError('Review must be a JSON object');
  const [filePath] = await readTask(parameters);
  return withActiveWorkspaceStateLock(filePath, async state => {
    const auditor = String(review.auditor_task ?? ''); const role = String(review.auditor_role ?? ''); const verdict = String(review.verdict ?? '');
    const reviewNode = Object.values(state.nodes).find(node => isReviewNode(node, state.routing_schema_version) && (node.status === RUNNING || isCohortReviewNode(state, node)) && (node.agent_task_path === auditor || activeCohortLaneForTask(node, auditor)));
    const cohortLane = reviewNode && isCohortReviewNode(state, reviewNode) ? activeCohortLaneForTask(reviewNode, auditor) : null;
    const priorReviewers = new Set(state.reviews.map(item => item.auditor_task));
    const participatedOutsideReview = reviewNode && state.participants.some(item => item.agent_task_path === auditor && item.node_id !== reviewNode.id);
    if (!auditor || !reviewNode || participatedOutsideReview || priorReviewers.has(auditor)) throw new ControllerError('Review gate reviewer must be a new agent that did not previously participate');
    const isTerraReview = reviewNode.kind === QUALITY_REVIEW_KIND;
    if (isTerraReview && role !== TERRA_REVIEW_ROLE) throw new ControllerError('A quality_review requires avsp_terra_xhigh');
    if (!isTerraReview && !SOL_ROLES.has(role) && role !== FALLBACK_ROLE) throw new ControllerError('Unsupported total reviewer role');
    if ((cohortLane?.agent_role ?? reviewNode.agent_role) !== role) throw new ControllerError('Reviewer role must match its claimed review node');
    const activeClaim = activeClaimForOperation(state, reviewNode, { node_id: reviewNode.id, claim_id: review.claim_id });
    if (!activeClaim.activation_at || activeClaim.heartbeat_count < 1) throw new ControllerError('Reviewer must activate its claim with workflow_heartbeat before recording a review');
    if (role === FALLBACK_ROLE && !review.fallback_reason) throw new ControllerError('Terra fallback review requires fallback_reason');
    if (!['pass', 'fail', 'unavailable'].includes(verdict)) throw new ControllerError('Review verdict must be pass, fail, or unavailable');
    const findings = reviewFindings(state, review.findings, verdict);
    const closureReview = isMaxClosureNode(state, reviewNode) && maxClosureReview(state, reviewNode);
    const repairRegressions = closureReview ? maxClosureRepairRegressions(state, review, findings) : [];
    if (!closureReview && hasOwn(review, 'repair_regressions')) throw new ControllerError('repair_regressions is only valid for a max closure review');
    const coverage = requireRequirementCoverage(state, review.requirement_coverage, 'Review');
    const snapshot = workflowSnapshot(state);
    if (!sameJson(review.workflow_snapshot, snapshot)) throw new ControllerError('Review workflow_snapshot does not match the current task state');
    const unfinished = unfinishedMaterialNodes(state);
    if (unfinished.length) throw new ControllerError(`Review cannot be recorded before all work nodes finish: ${unfinished.map(node => node.id).join(', ')}`);
    const fingerprint = await workspaceFingerprint(state.workspace, state.workspace_claims);
    if (!sameJson(review.workspace_fingerprint, fingerprint)) throw new ControllerError('Review fingerprint does not match the current workspace');
    const scopeAndRegression = requiredReviewValue(review.scope_and_regression, 'scope_and_regression');
    const verificationGaps = requiredReviewValue(review.verification_gaps, 'verification_gaps');
    const residualRisk = requiredReviewValue(review.residual_risk, 'residual_risk');
    const independentAssessment = isReviewProtocolState(state) ? requiredReviewValue(review.independent_assessment, 'independent_assessment') : review.independent_assessment ?? null;
    const historyReconciliation = isReviewProtocolState(state) ? requiredReviewValue(review.history_reconciliation, 'history_reconciliation') : review.history_reconciliation ?? null;
    const reviewHistoryDigest = isReviewProtocolState(state) ? requiredString(review.review_history_digest, 'review_history_digest') : review.review_history_digest ?? null;
    if (isReviewProtocolState(state) && reviewHistoryDigest !== protocolReviewHistoryDigest(state, { excludeActiveCohortPhase: Boolean(cohortLane) })) throw new ControllerError('review_history_digest does not match the complete current review and repair history');
    if (state.reviews.length >= MAX_REVIEWS) throw new ControllerError(`Task exceeded the ${MAX_REVIEWS}-review limit; create a replacement workflow task`);
    let reviewPhase = null; let reviewerSlot = null;
    if (cohortLane) {
      reviewPhase = reviewNode.review_gate.cohort.phase;
      reviewerSlot = cohortLane.slot;
      if (!['blind', 'cross_questioning'].includes(reviewPhase)) throw new ControllerError(`Terra cohort review cannot be recorded in phase: ${reviewPhase}`);
      if (reviewPhase === 'cross_questioning') {
        const targets = review.challenge_targets;
        const otherSlot = COHORT_SLOTS.find(slot => slot !== reviewerSlot);
        const blindClaimId = reviewNode.review_gate.cohort.lanes[otherSlot]?.blind_review_claim_id;
        const blindReview = state.reviews.find(item => item.node_id === reviewNode.id && item.review_phase === 'blind' && item.reviewer_slot === otherSlot && item.claim_id === blindClaimId);
        if (!Array.isArray(targets) || targets.length !== 1 || targets[0] !== blindReview?.claim_id) throw new ControllerError('A Terra cohort cross-questioning review must challenge the other lane blind review exactly once');
      } else if (hasOwn(review, 'challenge_targets')) {
        throw new ControllerError('challenge_targets is only valid during Terra cohort cross_questioning');
      }
    } else if (hasOwn(review, 'challenge_targets')) {
      throw new ControllerError('challenge_targets is only valid during Terra cohort cross_questioning');
    }
    const stored = { auditor_task: auditor, auditor_role: role, node_id: reviewNode.id, claim_id: activeClaim.claim_id, review_kind: reviewNode.kind, review_phase: reviewPhase, reviewer_slot: reviewerSlot, verdict, findings, repair_regressions: repairRegressions, requirement_coverage: coverage, scope_and_regression: scopeAndRegression, verification_gaps: verificationGaps, residual_risk: residualRisk, independent_assessment: independentAssessment, history_reconciliation: historyReconciliation, review_history_digest: reviewHistoryDigest, fallback_reason: review.fallback_reason ?? null, workflow_snapshot: snapshot, workspace_fingerprint: fingerprint, recorded_at: utcNow() };
    if (closureReview) {
      const charter = requireMaxReviewCharter(state, reviewNode);
      const blocking = findings.filter(finding => finding.severity === 'blocking');
      const charterFindingIds = new Set(charter.blocking_finding_ids);
      const allowedRegressionIds = new Set(repairRegressions.map(item => item.finding_id));
      const outOfCharter = blocking.filter(finding => !charterFindingIds.has(finding.id) && !allowedRegressionIds.has(finding.id));
      if (outOfCharter.length) {
        charter.status = 'scope_decision_required';
        charter.scope_decision_required = true;
        charter.pending_repair_source_claim_id = null;
        charter.out_of_charter_findings.push(...outOfCharter.map(finding => ({ ...finding, review_claim_id: reviewNode.claim_id, recorded_at: utcNow() })));
        addEvent(state, 'max_review_scope_decision_required', { node_id: reviewNode.id, claim_id: reviewNode.claim_id, out_of_charter_finding_ids: outOfCharter.map(finding => finding.id) });
      } else if (verdict === 'unavailable') {
        charter.status = 'closure_ready';
        charter.pending_repair_source_claim_id = null;
        addEvent(state, 'max_review_closure_unavailable_recorded', { node_id: reviewNode.id, claim_id: reviewNode.claim_id });
      } else if (verdict === 'pass') {
        charter.status = 'closure_passed';
        charter.pending_repair_source_claim_id = null;
        addEvent(state, 'max_review_closure_passed', { node_id: reviewNode.id, claim_id: reviewNode.claim_id });
      } else if (isReviewProtocolState(state)) {
        charter.status = 'scope_decision_required';
        charter.scope_decision_required = true;
        charter.pending_repair_source_claim_id = null;
        charter.out_of_charter_findings.push(...blocking.map(finding => ({ ...finding, review_claim_id: reviewNode.claim_id, recorded_at: utcNow(), terminal_max_failure: true })));
        addEvent(state, 'max_review_terminal_failure', { node_id: reviewNode.id, claim_id: reviewNode.claim_id, finding_ids: blocking.map(finding => finding.id) });
      } else {
        charter.status = 'repair_required';
        charter.pending_repair_source_claim_id = reviewNode.claim_id;
        const regressions = blocking.filter(finding => allowedRegressionIds.has(finding.id));
        for (const finding of regressions) if (!charter.blocking_finding_ids.includes(finding.id)) {
          charter.blocking_finding_ids.push(finding.id);
          charter.blocking_findings.push(finding);
        }
        addEvent(state, 'max_review_repair_regression_recorded', { node_id: reviewNode.id, claim_id: reviewNode.claim_id, finding_ids: regressions.map(finding => finding.id) });
      }
    }
    state.reviews.push(stored); addEvent(state, reviewNode.kind === 'total_review' ? 'total_review_recorded' : 'quality_review_recorded', { auditor_task: auditor, verdict }); await writeState(filePath, state);
    return { task_id: state.task_id, assurance_level: state.assurance_level, effective_assurance_level: effectiveAssuranceLevel(state), review: stored };
  });
}

async function closeReasons(state) {
  const incomplete = Object.entries(state.nodes).filter(([, node]) => ![SUCCEEDED, 'skipped'].includes(node.status)).map(([id]) => id);
  const reasons = incomplete.length ? [`incomplete nodes: ${incomplete.join(', ')}`] : [];
  if (state.assurance_level === 'verification') {
    const verification = state.verification_record;
    if (!verification) reasons.push('no verification record'); else {
      if (!workflowSnapshotMatchesState(verification.workflow_snapshot, state)) reasons.push('task state changed after verification');
      if (!sameJson(verification.workspace_fingerprint, await workspaceFingerprint(state.workspace, state.workspace_claims))) reasons.push('workspace changed after verification');
    }
    return reasons;
  }
  const reviewNode = reviewNodesForState(state)[0] ?? null;
  if (reviewNode && isMaxClosureNode(state, reviewNode)) {
    if (maxReviewCharterMissing(state, reviewNode)) reasons.push('max total_review is missing a frozen review charter');
    else if (state.max_review_charter.status !== 'closure_passed' || state.max_review_charter.scope_decision_required) reasons.push(`max review charter is ${state.max_review_charter.status}`);
  }
  const reviewName = reviewNode?.kind === QUALITY_REVIEW_KIND ? 'quality_review' : 'total_review';
  const reviewDescription = reviewNode?.kind === QUALITY_REVIEW_KIND ? 'quality_review' : 'total review';
  if (!reviewNode || reviewNode.status !== SUCCEEDED) reasons.push(`${reviewName} is not succeeded`);
  if (reviewNode?.kind === 'total_review' && !isCompletedWorkflowOutcome(reviewNode.result, state, reviewNode)) reasons.push('total_review workflow outcome completion is pending or invalid');
  if (reviewNode && isCohortReviewNode(state, reviewNode)) {
    const cohort = reviewNode.review_gate.cohort;
    const aggregate = cohort?.aggregate;
    if (cohort?.phase !== 'passed' || aggregate?.verdict !== 'pass') reasons.push('Terra cohort did not reach a passing cross-review conclusion');
    const finalReviews = currentCohortReviews(state, reviewNode, 'cross_questioning').filter(review => review.verdict === 'pass' && reviewCompletion(state, review).status === SUCCEEDED);
    if (finalReviews.length !== COHORT_SLOTS.length || new Set(finalReviews.map(review => review.reviewer_slot)).size !== COHORT_SLOTS.length) reasons.push('Terra cohort is missing a completed passing cross-questioning review from each lane');
    if (aggregate && !sameJson(aggregate.workspace_fingerprint, await workspaceFingerprint(state.workspace, state.workspace_claims))) reasons.push('workspace changed after Terra cohort cross-review');
    for (const review of finalReviews) {
      if (!workflowSnapshotMatchesState(review.workflow_snapshot, state)) reasons.push('task state changed after Terra cohort cross-review');
      if (!sameJson(review.workspace_fingerprint, await workspaceFingerprint(state.workspace, state.workspace_claims))) reasons.push('workspace changed after Terra cohort cross-review');
    }
    return reasons;
  }
  const review = state.reviews.at(-1);
  if (!review) reasons.push(reviewNode?.kind === QUALITY_REVIEW_KIND ? 'no quality_review' : 'no total review'); else {
    if (review.verdict !== 'pass') reasons.push(`latest review verdict is ${review.verdict}`);
    if (!reviewNode || review.node_id !== reviewNode.id || review.claim_id !== reviewNode.claim_id || review.auditor_task !== reviewNode.agent_task_path || review.auditor_role !== reviewNode.agent_role) reasons.push(`latest review does not belong to the succeeded ${reviewDescription} node`);
    if (!workflowSnapshotMatchesState(review.workflow_snapshot, state)) reasons.push(`task state changed after ${reviewDescription}`);
    if (!sameJson(review.workspace_fingerprint, await workspaceFingerprint(state.workspace, state.workspace_claims))) reasons.push(`workspace changed after ${reviewDescription}`);
  }
  return reasons;
}

async function closeCheck(parameters) {
  const [filePath, initialState] = await readTask(parameters);
  if (!initialState.workspace_lease) {
    const reasons = await closeReasons(initialState);
    return [{ task_id: initialState.task_id, assurance_level: initialState.assurance_level, effective_assurance_level: effectiveAssuranceLevel(initialState), close_allowed: !reasons.length, reasons, workspace_lease: { released: false, reason: 'legacy task has no workspace lease' } }, reasons.length ? 2 : 0];
  }
  const parentAuthority = await stateParentAuthorityForState(initialState, filePath);
  await verifyRegularDirectorySnapshot(parentAuthority, 'Controller state parent');
  const leasePath = initialState.workspace_lease.registry_path;
  return withWorkspaceLeaseLock(initialState.workspace, async (lockedLeasePath, authorityContext) => {
    if (lockedLeasePath !== leasePath) throw new ControllerError('Workspace lease authority path changed before close');
    return withStateLock(filePath, async () => {
    await verifyRegularDirectorySnapshot(parentAuthority, 'Controller state parent');
    const state = normalizeState(await loadState(filePath));
    const currentParentAuthority = await stateParentAuthorityForState(state, filePath);
    if (!sameStateParentAuthority(currentParentAuthority, parentAuthority)) throw new ControllerError(`Controller state parent authority changed: ${filePath}`);
    await attachStateParentAuthority(state, filePath, parentAuthority);
    if (state.workspace_lease.status === 'released') {
      const lease = await loadWorkspaceLease(leasePath, state.workspace, { authorityContext });
      let selfHealed = false;
      const peerOwners = workspaceLeasePeerOwners(lease, state, filePath);
      if (peerOwners.length) {
        const reasons = [...await closeReasons(state), `workspace lease has another active state-path owner: ${peerOwners[0].task_id}`];
        return [{ task_id: state.task_id, assurance_level: state.assurance_level, effective_assurance_level: effectiveAssuranceLevel(state), close_allowed: false, reasons, workspace_lease: { released: false, reason: 'state path belongs to another active task identity', lease_path: leasePath } }, 2];
      }
      if (workspaceLeaseStatePathOwners(lease, filePath).some(entry => workspaceLeaseEntryMatches(entry, state, filePath, { activeOnly: false }))) {
        lease.active_tasks = lease.active_tasks.filter(entry => !workspaceLeaseEntryMatches(entry, state, filePath, { activeOnly: false })); lease.updated_at = utcNow(); await writeWorkspaceLeaseRegistry(authorityContext, leasePath, lease); selfHealed = true;
      }
      const reasons = await closeReasons(state);
      return [{ task_id: state.task_id, assurance_level: state.assurance_level, effective_assurance_level: effectiveAssuranceLevel(state), close_allowed: !reasons.length, reasons, workspace_lease: { released: true, already_released: true, self_healed: selfHealed, lease_path: leasePath } }, reasons.length ? 2 : 0];
    }
    const lease = await requireActiveWorkspaceLease(state, filePath, authorityContext);
    const reasons = await closeReasons(state);
    if (reasons.length) return [{ task_id: state.task_id, assurance_level: state.assurance_level, effective_assurance_level: effectiveAssuranceLevel(state), close_allowed: false, reasons }, 2];
    state.workspace_lease.workspace_claims ??= state.workspace_claims; state.workspace_lease.status = 'released'; state.workspace_lease.released_at = utcNow(); state.closed_revision = state.workflow_revision; state.closed_at = utcNow();
    addEvent(state, 'workspace_lease_released', { close_allowed: true }); await writeState(filePath, state);
    lease.active_tasks = lease.active_tasks.filter(entry => !workspaceLeaseEntryMatches(entry, state, filePath, { activeOnly: false })); lease.updated_at = utcNow(); await writeWorkspaceLeaseRegistry(authorityContext, leasePath, lease);
      return [{ task_id: state.task_id, assurance_level: state.assurance_level, effective_assurance_level: effectiveAssuranceLevel(state), close_allowed: true, reasons: [], workspace_lease: { released: true, lease_path: leasePath } }, 0];
    }, { parentAuthority });
  }, { allowAuthorityMigration: true });
}

export async function dispatch(command, parameters) {
  if (parameters && hasOwn(parameters, 'state_dir')) {
    parameters = { ...parameters, state_dir: await canonicalStateDirectory(parameters.state_dir) };
  }
  if (command === 'prune-expired') return [await pruneExpiredTasks(parameters), 0];
  if (command === 'reconcile-quarantine') return [await reconcileQuarantinedStates(parameters), 0];
  // Diagnostic commands stay side-effect free; other operations lazily keep expired state bounded.
  if (parameters && hasOwn(parameters, 'state_dir') && !READ_ONLY_COMMANDS.has(command)) {
    const parentAuthority = await persistedStateParentAuthority(parameters);
    await maybePruneExpiredTasks(parameters, { parentAuthority });
  }
  switch (command) {
    case 'init': return [await initTask(parameters), 0]; case 'reconcile-workspace': return [await reconcileWorkspace(parameters), 0]; case 'add-node': return [await addNode(parameters), 0]; case 'raise-assurance': return [await raiseAssurance(parameters), 0]; case 'rebind-pending': return [await rebindPendingOwner(parameters), 0]; case 'invalidate-gate': return [await invalidateGate(parameters), 0];
    case 'ready': return [{ ready_nodes: readyNodes((await readTask(parameters))[1]) }, 0]; case 'claim': return [await claimNode(parameters), 0]; case 'start': return [await claimNode(parameters, true), 0];
    case 'complete': return [await completeNode(parameters), 0]; case 'heartbeat': return [await heartbeatNode(parameters), 0]; case 'checkpoint': return [await checkpointNode(parameters), 0];
    case 'abandon': return [await abandonNode(parameters), 0]; case 'retry': return [await retryNode(parameters), 0]; case 'requeue-stale': return [await requeueStaleNode(parameters), 0]; case 'rescue': return [await rescueNode(parameters), 0];
    case 'recover-lock': return [await recoverTaskLock(parameters), 0]; case 'audit-context': return [await auditContext(parameters), 0];
    case 'record-review': return [await recordReview(parameters), 0]; case 'record-verification': return [await recordVerification(parameters), 0]; case 'record-repair': return [await recordRepair(parameters), 0]; case 'close-check': return closeCheck(parameters);
    case 'release-workspace': return [await releaseWorkspaceLease(parameters), 0];
    case 'stale': {
      const [, state] = await readTask(parameters);
      return [{ task_id: state.task_id, stale_nodes: staleNodes(state) }, 0];
    }
    case 'status': return [compactState((await readTask(parameters))[1]), 0]; case 'doctor': return [await doctorTask(parameters), 0]; case 'fingerprint': return [{ workspace_fingerprint: await workspaceFingerprint(parameters.workspace, parameters.workspace_claims) }, 0];
    default: throw new ControllerError(`Unknown command: ${command}`);
  }
}

function parseCli(argumentsList) {
  const values = {}; let command = null;
  for (let index = 0; index < argumentsList.length; index++) {
    const value = argumentsList[index];
    if (!value.startsWith('--') && !command) { command = value; continue; }
    if (!value.startsWith('--')) throw new ControllerError(`Unexpected argument: ${value}`);
    values[value.slice(2).replaceAll('-', '_')] = argumentsList[++index];
  }
  if (!command) throw new ControllerError('A command is required');
  return { command, ...values };
}

export async function main() {
  try { const parameters = parseCli(process.argv.slice(2)); const { command, ...rest } = parameters; const [result, exitCode] = await dispatch(command, rest); process.stdout.write(`${JSON.stringify(result, null, 2)}\n`); process.exitCode = exitCode; }
  catch (error) { process.stderr.write(`${JSON.stringify({ error: error.message })}\n`); process.exitCode = 1; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
