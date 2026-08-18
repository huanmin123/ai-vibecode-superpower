import { createHash, randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  deleteGlobalTaskState as deleteTaskState,
  globalTaskStateExists as taskStateExists,
  globalWorkflowArtifactPath,
  globalWorkflowArtifactRoot,
  globalWorkflowArtifactTaskPath,
  globalWorkflowStorePath,
  createGlobalWorkspaceControl as createWorkspaceControl,
  globalWorkspaceControlExists as workspaceControlExists,
  ensureGlobalNamespaceIdentity,
  listGlobalTaskStatesForWorkspace,
  listGlobalTaskPruneCandidates,
  claimGlobalTaskPruneJobs,
  failGlobalTaskPruneJob,
  finalizeGlobalTaskPruneJob,
  readGlobalTaskState as readTaskState,
  readGlobalWorkspaceControl as readWorkspaceControl,
  taskStoreKey,
  withGlobalTaskStateTransaction as withTaskStateTransaction,
  withGlobalWorkspaceControlTransaction as withWorkspaceControlTransaction,
  writeGlobalTaskState as writeTaskState,
} from './global_workflow_store.mjs';

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
const ASSURANCE_LEVELS = new Set(['terra', 'sol']);
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
]);
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
const WORKSPACE_CONTROL_FILENAME = 'workflow.sqlite';
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
const MAX_REVIEW_FINDINGS = 64;
const PROTOCOL_MAX_CLOSURE_ATTEMPTS = 1;
const REVIEW_ENTRY_STAGES = new Set(['terra_single', 'terra_cohort', 'sol_high', 'sol_xhigh']);
const REVIEW_PROTOCOL_STAGES = new Set([...REVIEW_ENTRY_STAGES, 'sol_max_initial', 'sol_max_closure']);
const COHORT_SLOTS = ['coverage', 'adversarial'];
const COHORT_PHASES = new Set(['blind', 'cross_questioning', 'passed', 'failed']);
const MAX_CHECKPOINT_BYTES = 32 * 1024;
const MAX_RECOVERY_RESULT_BYTES = 8 * 1024;
const DEFAULT_TASK_RETENTION_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_PRUNE_REPORT_ENTRIES = 128;
const SQLITE_STATE_SUFFIX = '.sqlite';
export class ControllerError extends Error {}

function asControllerError(error) {
  if (error instanceof ControllerError) return error;
  const wrapped = new ControllerError(error?.message ?? String(error));
  wrapped.cause = error;
  return wrapped;
}

const utcNow = () => new Date().toISOString();
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const pathIsWithin = (root, candidate) => {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
};
const DEFAULT_LEASE_SEC = 1800;
const DEFAULT_ACTIVATION_TIMEOUT_SEC = 600;
const WORKSPACE_LEASE_VERSION = 3;
const WORKSPACE_CLAIM_MODES = new Set(['read', 'write']);
const MAX_WORKSPACE_CLAIMS = 128;
const MAX_WORKSPACE_CLAIM_PREFIX_LENGTH = 1024;
const MAX_GLOBAL_WRITE_JUSTIFICATION_LENGTH = 2_048;
const MAX_WORKSPACE_ACTIVE_TASKS = 64;
const MAX_WORKSPACE_ACTIVE_WRITE_LOCKS = 512;
const MAX_WRITE_LOCK_PREFIXES_PER_REQUEST = 64;
const ROOT_RESCUE_ROLE = 'main/root';
const NATIVE_AGENT_FINISHED = 'native_agent_finished';
const ROOT_RESCUE_SELF_COMPLETION = 'root_rescue_self_completion';
const NATIVE_AGENT_EXIT_CONFIRMED = 'native_agent_exit_confirmed';
const NATIVE_AGENT_START_FAILED = 'native_agent_start_failed';
const taskStateTransactionContext = new AsyncLocalStorage();

function isWorkspaceControlFile(name) {
  return workspacePathKey(name) === workspacePathKey(WORKSPACE_CONTROL_FILENAME);
}

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
  if (!name.endsWith(SQLITE_STATE_SUFFIX) || name === SQLITE_STATE_SUFFIX) throw new ControllerError(`${label} must name a SQLite state file`);
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
  trueValue(parameters.previous_agent_stopped, 'previous_agent_stopped');
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

function assuranceAssessment(value, label = 'assurance_assessment') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ControllerError(`${label} must be an object`);
  const keys = Object.keys(value).sort();
  const expected = [...ASSURANCE_ASSESSMENT_FIELDS].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new ControllerError(`${label} must contain exactly: ${ASSURANCE_ASSESSMENT_FIELDS.join(', ')}`);
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
  const statuses = ASSURANCE_DIMENSION_FIELDS.map(field => assessment[field].status);
  if (statuses.includes('unknown')) return 'sol';
  if (statuses.includes('partial')) return 'terra';
  return null;
}

function requireAssuranceLevelMatches(level, assessment, label = 'assurance_level') {
  const expectedLevel = assuranceLevelForAssessment(assessment);
  if (expectedLevel === null) throw new ControllerError(`${label} cannot initialize a persistent workflow when every assurance dimension is controlled`);
  if (level !== expectedLevel) throw new ControllerError(`${label} must be ${expectedLevel} for the supplied assurance_assessment`);
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
  if (charter.schema_version !== 2 || !['initial_repair_required', 'closure_ready', 'closure_reviewing', 'repair_required', 'scope_decision_required', 'closure_passed'].includes(charter.status)) return false;
  if (typeof charter.created_at !== 'string' || !Number.isFinite(Date.parse(charter.created_at)) || typeof charter.source_review_claim_id !== 'string') return false;
  if (!charter.workflow_snapshot || typeof charter.workflow_snapshot !== 'object' || !charter.workspace_fingerprint || typeof charter.workspace_fingerprint !== 'object') return false;
  if (!sameJson(charter.requirements, state.requirements) || !sameJson(charter.workspace_claims, state.workspace_claims)) return false;
  if (!Array.isArray(charter.blocking_finding_ids) || !charter.blocking_finding_ids.length || !Array.isArray(charter.blocking_findings) || !Array.isArray(charter.out_of_charter_findings)) return false;
  if (new Set(charter.blocking_finding_ids).size !== charter.blocking_finding_ids.length || charter.blocking_findings.some(finding => !finding || typeof finding.id !== 'string') || !sameJson([...charter.blocking_finding_ids].sort(), charter.blocking_findings.map(finding => finding.id).sort())) return false;
  const closureLimit = PROTOCOL_MAX_CLOSURE_ATTEMPTS;
  if (!Number.isSafeInteger(charter.repair_count) || charter.repair_count < 0 || !Number.isSafeInteger(charter.closure_attempt_count) || charter.closure_attempt_count < 0 || charter.closure_attempt_limit !== closureLimit || charter.closure_attempt_count > charter.closure_attempt_limit || typeof charter.scope_decision_required !== 'boolean') return false;
  if (charter.source_max_initial !== true || !isReviewProtocolState(state)) return false;
  return (charter.pending_repair_source_claim_id === null || typeof charter.pending_repair_source_claim_id === 'string')
    && (charter.active_closure_claim_id === undefined || charter.active_closure_claim_id === null || typeof charter.active_closure_claim_id === 'string');
}

function isMaxClosureNode(state, node) {
  return isMaxReviewNode(node) && protocolStageForNode(node) === 'sol_max_closure';
}

function maxReviewCharterMissing(state, node) {
  return isMaxClosureNode(state, node) && !validMaxReviewCharter(state, state.max_review_charter);
}

function requireMaxReviewCharter(state, node) {
  if (maxReviewCharterMissing(state, node)) {
    throw new ControllerError('A max total_review requires a complete frozen max_review_charter');
  }
  return state.max_review_charter;
}

async function freezeProtocolMaxReviewCharter(state, node, sourceReview, fingerprintPreflight) {
  const blockingFindings = sourceReview.findings.filter(finding => finding.severity === 'blocking');
  if (!blockingFindings.length) throw new ControllerError('A max closure charter requires blocking findings from the finalized max initial review');
  state.max_review_charter = {
    schema_version: 2,
    status: 'initial_repair_required',
    created_at: utcNow(),
    source_review_claim_id: sourceReview.claim_id,
    pending_repair_source_claim_id: sourceReview.claim_id,
    workflow_snapshot: workflowSnapshot(state),
    workspace_fingerprint: workspaceFingerprintFromPreflight(state, fingerprintPreflight, 'Max review charter'),
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
  return path.join(path.resolve(stateDir), `${taskId}${SQLITE_STATE_SUFFIX}`);
}

// Workflow payloads are normally passed inline through the MCP request.  A
// file path remains an explicit external-input escape hatch for manifests and
// other non-workflow inputs, but a path inside the target workspace is never a
// valid source of controller state.  This prevents agents from turning the
// logical state_dir into a result/review JSON spool.
async function physicalParentPath(value) {
  const requested = path.resolve(value);
  const missing = [];
  let cursor = requested;
  for (;;) {
    try {
      const physical = await fs.realpath(cursor);
      return path.join(physical, ...missing.reverse());
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) return requested;
      missing.push(path.basename(cursor));
      cursor = parent;
    }
  }
}

async function rejectWorkspaceLocalJsonPath(value, workspace, label) {
  if (typeof value !== 'string' || !workspace) return;
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith('{') || trimmed.startsWith('[')) return;
  const candidate = path.resolve(trimmed);
  const workspacePhysical = await physicalParentPath(workspace);
  // Compare a canonicalized parent plus the requested basename so an existing
  // file symlink cannot bypass the workspace boundary, while Windows 8.3
  // aliases still resolve to the same physical workspace.
  const candidatePhysicalParent = await physicalParentPath(path.dirname(candidate));
  const candidateForBoundary = path.join(candidatePhysicalParent, path.basename(candidate));
  if (pathIsWithinPhysicalRoot(workspacePhysical, candidateForBoundary)) {
    throw new ControllerError(`${label} must be an inline JSON value; workspace-local JSON files are not workflow state: ${candidate}`);
  }
}

async function readWorkflowJson(value, { label = 'JSON input', maxBytes = MAX_MANIFEST_BYTES, workspace = null, objectOnly = false } = {}) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    let serialized;
    try { serialized = JSON.stringify(value); }
    catch (error) { throw new ControllerError(`${label} is not valid JSON: ${error.message}`); }
    if (Buffer.byteLength(serialized, 'utf8') > maxBytes) throw new ControllerError(`${label} exceeds the ${maxBytes}-byte limit`);
    return structuredClone(value);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) throw new ControllerError(`${label} must be a non-empty inline JSON value`);
    if (Buffer.byteLength(trimmed, 'utf8') <= maxBytes) {
      try {
        const parsed = JSON.parse(trimmed);
        if (typeof parsed === 'string') await rejectWorkspaceLocalJsonPath(parsed, workspace, label);
        if (objectOnly && (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))) throw new ControllerError(`${label} must be a JSON object`);
        return parsed;
      } catch (error) {
        if (trimmed.startsWith('{') || trimmed.startsWith('[') || error instanceof ControllerError) {
          if (error instanceof ControllerError) throw error;
          throw new ControllerError(`Invalid inline JSON in ${label}: ${error.message}`);
        }
      }
    } else if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      throw new ControllerError(`${label} exceeds the ${maxBytes}-byte limit`);
    }
    await rejectWorkspaceLocalJsonPath(trimmed, workspace, label);
    const parsed = await readJson(trimmed, { label, maxBytes });
    if (objectOnly && (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))) throw new ControllerError(`${label} must be a JSON object`);
    return parsed;
  }
  if (value === undefined || value === null) throw new ControllerError(`${label} must be provided as an inline JSON value`);
  if (objectOnly) throw new ControllerError(`${label} must be a JSON object`);
  throw new ControllerError(`${label} must be an inline JSON value`);
}

// `statePath()` is an internal logical key. It is never a project-local
// SQLite database in v3. Public results identify the single physical store.
function publicTaskKey(filePath) {
  return {
    namespace: path.dirname(path.resolve(filePath)),
    task_id: path.basename(filePath, SQLITE_STATE_SUFFIX),
  };
}

function publicTaskStoreReference(filePath) {
  const databasePath = globalWorkflowStorePath();
  return {
    // `state_path` identifies the one physical global database, never the
    // internal logical task key.
    state_path: databasePath,
    database_path: databasePath,
    task_key: publicTaskKey(filePath),
  };
}

function publicWorkspaceLease(state) {
  const lease = state.workspace_lease;
  if (!lease) return null;
  const reference = typeof lease.state_path === 'string'
    ? publicTaskStoreReference(lease.state_path)
    : { state_path: globalWorkflowStorePath(), database_path: globalWorkflowStorePath(), task_key: { namespace: null, task_id: state.task_id } };
  return {
    status: lease.status,
    acquired_at: lease.acquired_at,
    ...(lease.released_at ? { released_at: lease.released_at } : {}),
    workspace_claims: lease.workspace_claims ?? state.workspace_claims,
    ...reference,
  };
}

function publicReleasedWorkspaceLease(filePath, { alreadyReleased = false, selfHealed = false } = {}) {
  return {
    released: true,
    ...(alreadyReleased ? { already_released: true } : {}),
    ...(selfHealed ? { self_healed: true } : {}),
    ...publicTaskStoreReference(filePath),
  };
}

function rollbackMaxClosureAttempt(state, node, claimId, reason) {
  if (!isMaxClosureNode(state, node)) return;
  // A closure node may be opened before its first claim is assigned. A null
  // claim cannot own or roll back that attempt.
  if (typeof claimId !== 'string' || !claimId) return;
  const charter = requireMaxReviewCharter(state, node);
  if (charter.active_closure_claim_id !== claimId) return;
  charter.status = 'closure_ready';
  charter.scope_decision_required = false;
  charter.pending_repair_source_claim_id = null;
  charter.active_closure_claim_id = null;
  charter.closure_attempt_count = Math.max(0, charter.closure_attempt_count - 1);
  delete charter.pending_closure_verdict;
  delete charter.pending_closure_claim_id;
  addEvent(state, 'max_review_closure_attempt_rolled_back', { node_id: node.id, claim_id: claimId, reason });
}

function taskKey(filePath) {
  return taskStoreKey(filePath);
}

async function readManifest(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    let serialized;
    try { serialized = JSON.stringify(value); }
    catch (error) { throw new ControllerError(`Manifest is not valid JSON: ${error.message}`); }
    if (Buffer.byteLength(serialized, 'utf8') > MAX_MANIFEST_BYTES) throw new ControllerError(`Manifest exceeds the ${MAX_MANIFEST_BYTES}-byte limit`);
    return value;
  }
  if (typeof value !== 'string' || !value.trim()) throw new ControllerError('Manifest must be a non-empty JSON object, inline JSON string, or file path');
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return readJson(value, { label: 'Manifest', maxBytes: MAX_MANIFEST_BYTES });
  let parsed;
  try { parsed = JSON.parse(trimmed); }
  catch (error) { throw new ControllerError(`Invalid inline Manifest JSON: ${error.message}`); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new ControllerError('Inline Manifest JSON must be an object');
  if (Buffer.byteLength(trimmed, 'utf8') > MAX_MANIFEST_BYTES) throw new ControllerError(`Manifest exceeds the ${MAX_MANIFEST_BYTES}-byte limit`);
  return parsed;
}

function databasePath(filePath) {
  if (!filePath.endsWith(SQLITE_STATE_SUFFIX)) throw new ControllerError(`Invalid SQLite task state path: ${filePath}`);
  return filePath;
}

async function stateExists(filePath) {
  return taskStateExists(databasePath(filePath));
}

async function writeState(filePath, state, { parentAuthority = null } = {}) {
  const transaction = taskStateTransactionContext.getStore();
  if (transaction?.filePath && sameStatePath(transaction.filePath, filePath)) {
    const authority = parentAuthority ?? transaction.parentAuthority;
    await verifyRegularDirectorySnapshot(authority, 'Controller state parent');
    transaction.state = state;
    return;
  }
  const authority = parentAuthority ?? await stateParentAuthorityForState(state, filePath);
  await verifyRegularDirectorySnapshot(authority, 'Controller state parent');
  await writeTaskState(databasePath(filePath), state, { parentAuthority: authority });
}

async function deleteState(filePath, { parentAuthority } = {}) {
  if (!parentAuthority) throw new ControllerError(`Controller state deletion requires a caller-verified parent authority: ${filePath}`);
  await verifyRegularDirectorySnapshot(parentAuthority, 'Controller state parent');
  const taskId = path.basename(filePath, SQLITE_STATE_SUFFIX);
  if (/^[A-Za-z][A-Za-z0-9._-]{0,79}$/.test(taskId)) {
    // Remove review evidence from the user-level artifact store first; if this
    // fails, keep the task indexable for a later sweep.
    await fs.rm(globalWorkflowArtifactTaskPath(path.dirname(filePath), taskId), { recursive: true, force: true });
  }
  await deleteTaskState(databasePath(filePath), { parentAuthority });
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

async function snapshotRegularDirectory(directory, label) {
  const metadata = await fs.lstat(directory, { bigint: true });
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new ControllerError(`${label} is not a regular directory: ${directory}`);
  return { path: directory, real_path: await fs.realpath(directory), identity: workspaceDirectoryIdentity(metadata) };
}

async function verifyRegularDirectorySnapshot(snapshot, label) {
  // A controller namespace is logical.  Its anchor is the already-existing
  // workspace directory, so verifying it must never materialize or inspect
  // the logical state_dir itself.
  const anchorPath = typeof snapshot?.real_path === 'string' ? snapshot.real_path : snapshot?.path;
  const current = await snapshotRegularDirectory(anchorPath, label);
  if (!sameStatePath(current.real_path, snapshot.real_path) || !sameWorkspaceDirectoryIdentity(current.identity, snapshot.identity)) {
    throw new ControllerError(`${label} changed: ${snapshot.path}`);
  }
}

async function snapshotLogicalStateNamespace(stateDirectory, workspace) {
  const workspaceAnchor = await snapshotRegularDirectory(workspace, 'Controller namespace workspace anchor');
  return {
    // `path` remains the stable logical namespace key consumed by the global
    // store. `real_path` deliberately anchors that key to the workspace,
    // rather than to a directory created under the workspace.
    path: stateDirectory,
    real_path: workspaceAnchor.real_path,
    identity: workspaceAnchor.identity,
  };
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
  if (!sameStatePath(stored.real_path, state.workspace)) throw new ControllerError(`Controller namespace anchor does not match its workspace: ${filePath}`);
  await verifyRegularDirectorySnapshot(stored, 'Controller namespace workspace anchor');
  await ensureGlobalNamespaceIdentity(path.dirname(filePath), stored);
  return stored;
}

async function attachStateParentAuthority(state, filePath, parentAuthority = null) {
  const authority = parentAuthority ?? await stateParentAuthorityForState(state, filePath);
  if (!validStateParentAuthority(authority, filePath)) throw new ControllerError(`Invalid task state parent authority: ${filePath}`);
  const stored = await stateParentAuthorityForState(state, filePath);
  if (!sameStateParentAuthority(stored, authority)) throw new ControllerError(`Task state parent authority changed: ${filePath}`);
  return authority;
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

async function normalizeWorkspaceClaims(rawClaims, workspace) {
  const input = rawClaims;
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
    if (first && (isIgnoredFingerprintDirectory(first) || isWorkspaceControlFile(first))) throw new ControllerError(`workspace_claims cannot include ignored or controller directory: ${prefix}`);
    await assertClaimDoesNotTraverseLink(workspace, prefix);
    const key = workspacePathKey(prefix);
    const existing = byPrefix.get(key);
    if (!existing || claim.mode === 'write') byPrefix.set(key, { mode: claim.mode, prefix });
  }
  const ordered = [...byPrefix.values()].sort((left, right) => workspacePathKey(left.prefix).localeCompare(workspacePathKey(right.prefix)) || left.mode.localeCompare(right.mode));
  return ordered.filter((claim, index) => !ordered.some((other, otherIndex) => otherIndex !== index && other.mode === claim.mode && isClaimAncestor(other.prefix, claim.prefix)));
}

function normalizeStoredWorkspaceClaims(rawClaims) {
  const input = rawClaims;
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
    if (first && (isIgnoredFingerprintDirectory(first) || isWorkspaceControlFile(first))) throw new ControllerError(`Stored workspace_claim targets ignored or controller directory: ${prefix}`);
    const key = workspacePathKey(prefix); const existing = byPrefix.get(key);
    if (!existing || claim.mode === 'write') byPrefix.set(key, { mode: claim.mode, prefix });
  }
  const ordered = [...byPrefix.values()].sort((left, right) => workspacePathKey(left.prefix).localeCompare(workspacePathKey(right.prefix)) || left.mode.localeCompare(right.mode));
  const normalized = ordered.filter((claim, index) => !ordered.some((other, otherIndex) => otherIndex !== index && other.mode === claim.mode && isClaimAncestor(other.prefix, claim.prefix)));
  if (!sameJson(input, normalized)) throw new ControllerError('Stored workspace_claims are not normalized');
  return normalized;
}

function sameFileIdentity(expected, metadata) {
  const expectedIdentity = typeof expected?.mtimeNs === 'bigint' && typeof expected?.ctimeNs === 'bigint' ? fileIdentity(expected) : expected;
  const current = fileIdentity(metadata);
  return expectedIdentity?.dev === current.dev && expectedIdentity?.ino === current.ino
    && expectedIdentity?.size === current.size && expectedIdentity?.mtimeNs === current.mtimeNs && expectedIdentity?.ctimeNs === current.ctimeNs;
}

// Verify the task-state parent identity before a filesystem side effect. This
// does not acquire a lock; SQLite transactions protect the state databases.
async function withVerifiedStateParent(filePath, callback, { createParent = true, parentAuthority = null } = {}) {
  if (parentAuthority) {
    if (!validStateParentAuthority(parentAuthority, filePath)) throw new ControllerError(`Invalid task state parent authority: ${filePath}`);
    await verifyRegularDirectorySnapshot(parentAuthority, 'Controller state parent');
  } else if (createParent) {
    throw new ControllerError(`Controller namespace authority is required; state_dir is never materialized: ${path.dirname(filePath)}`);
  } else {
    throw new ControllerError(`Controller namespace authority is required: ${path.dirname(filePath)}`);
  }
  return callback();
}

async function loadState(filePath) {
  const transaction = taskStateTransactionContext.getStore();
  if (transaction?.filePath && sameStatePath(transaction.filePath, filePath)) return transaction.state;
  const state = await readTaskState(databasePath(filePath));
  if (state === null) {
    throw new ControllerError(`Current global controller state does not exist: ${taskKey(filePath)}`);
  }
  if (!state || typeof state !== 'object' || state.version !== VERSION) throw new ControllerError(`Unsupported controller state: ${filePath}`);
  if (state.workspace_lease?.state_path !== undefined) {
    const leasePath = await canonicalStatePath(state.workspace_lease.state_path, 'workspace_lease.state_path');
    if (!sameStatePath(leasePath, filePath)) throw new ControllerError(`workspace_lease.state_path does not identify this state: ${filePath}`);
    state.workspace_lease.state_path = leasePath;
    if (state.workspace_lease.task_key !== undefined && state.workspace_lease.task_key !== taskKey(filePath)) throw new ControllerError(`workspace_lease.task_key does not identify this state: ${filePath}`);
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
  const claims = await normalizeWorkspaceClaims(rawClaims, workspace);
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
  return routingSchemaVersion === REVIEW_PROTOCOL_VERSION && (node?.kind === 'total_review' || node?.kind === QUALITY_REVIEW_KIND);
}

// Filesystem traversal is deliberately outside the global task transaction.
// The later short transaction checks this material snapshot before consuming
// the result, so a concurrent task/claim change is surfaced as an explicit
// retry rather than extending a BEGIN IMMEDIATE lock over workspace I/O.
async function prepareWorkspaceFingerprint(filePath) {
  const state = normalizeState(await loadState(filePath));
  const parentAuthority = await stateParentAuthorityForState(state, filePath);
  await verifyRegularDirectorySnapshot(parentAuthority, 'Controller state parent');
  const snapshot = workflowSnapshot(state);
  const fingerprint = await workspaceFingerprint(state.workspace, state.workspace_claims);
  await verifyRegularDirectorySnapshot(parentAuthority, 'Controller state parent');
  return {
    workspace: state.workspace,
    workspace_claims: structuredClone(state.workspace_claims),
    workflow_snapshot: snapshot,
    fingerprint,
  };
}

function workspaceFingerprintFromPreflight(state, preflight, label) {
  if (!preflight || !sameJson(preflight.workspace_claims, state.workspace_claims)
    || preflight.workspace !== state.workspace
    || !sameJson(preflight.workflow_snapshot, workflowSnapshot(state))) {
    throw new ControllerError(`${label} task state changed while its workspace fingerprint was calculated; retry the operation`);
  }
  return preflight.fingerprint;
}

function globalWriteJustification(manifest, workspaceClaims) {
  if (!workspaceClaims.some(claim => claim.mode === 'write' && claim.prefix === '.')) return null;
  if (!hasOwn(manifest, 'global_write_justification')) throw new ControllerError('global_write_justification is required for a workspace-wide write claim');
  const justification = requiredString(manifest.global_write_justification, 'global_write_justification');
  if (justification.length > MAX_GLOBAL_WRITE_JUSTIFICATION_LENGTH) throw new ControllerError('global_write_justification must be no longer than 2048 characters');
  return justification;
}

function reviewNodes(nodes, routingSchemaVersion = null) {
  return Object.values(nodes).filter(node => isReviewNode(node, routingSchemaVersion));
}

function reviewNodesForState(state) {
  return reviewNodes(state.nodes, state.routing_schema_version);
}

function effectiveAssuranceLevel(state) {
  if (state.routing_schema_version !== REVIEW_PROTOCOL_VERSION) return null;
  const reviewNode = reviewNodesForState(state)[0];
  return state.assurance_level === 'terra' && reviewNode?.review_stage === 'sol' ? 'sol' : state.assurance_level;
}

function validateReviewTopology(nodes, assuranceLevel = null, routingSchemaVersion = null, reviewEntryStage = null) {
  const allNodes = Object.values(nodes);
  const schemaVersion = routingSchemaVersion;
  const reviews = reviewNodes(nodes, schemaVersion);
  if (schemaVersion !== REVIEW_PROTOCOL_VERSION) throw new ControllerError('Task topology requires routing_schema_version=3');
  if (assuranceLevel === 'terra') {
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
  {
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
    const missingDependencies = expectedDependencies.filter(id => !actualDependencies.includes(id));
    const unexpectedDependencies = actualDependencies.filter(id => !expectedDependencies.includes(id));
    const details = [
      missingDependencies.length ? `missing direct dependencies: ${missingDependencies.join(', ')}` : null,
      unexpectedDependencies.length ? `unexpected dependencies: ${unexpectedDependencies.join(', ')}` : null,
    ].filter(Boolean);
    throw new ControllerError(`Review node ${review.id} must directly depend on every non-review node${details.length ? `; ${details.join('; ')}` : ''}`);
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
  if (includeClaims) material.workspace_claims = state.workspace_claims;
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
  return recorded.digest_algorithm === 'sha256-stable-json-v2' && sameJson(recorded, workflowSnapshot(state));
}

function completeReviewDirectDependencies(nodes, routingSchemaVersion) {
  const reviews = reviewNodes(nodes, routingSchemaVersion);
  if (reviews.length !== 1) return [];
  const review = reviews[0];
  const expected = Object.values(nodes).filter(node => !isReviewNode(node, routingSchemaVersion)).map(node => node.id);
  const missing = expected.filter(id => !review.depends_on.includes(id)).sort();
  if (missing.length) review.depends_on = [...new Set([...review.depends_on, ...missing])].sort();
  return missing;
}

export function sameJson(left, right) { return stableJson(left) === stableJson(right); }

function bumpWorkflowRevision(state, eventType, details = {}) {
  state.workflow_revision = (state.workflow_revision ?? 0) + 1;
  addEvent(state, eventType, { ...details, workflow_revision: state.workflow_revision });
}

function nodeRouting(raw, routingRequired) {
  const supplied = ROUTING_FIELDS.filter(field => hasOwn(raw, field));
  if (supplied.length !== ROUTING_FIELDS.length) throw new ControllerError(`node routing fields must be complete: ${ROUTING_FIELDS.join(', ')}`);
  const executionRisk = requiredString(raw.execution_risk, 'node.execution_risk');
  if (!['read_only', 'delegable', 'protected'].includes(executionRisk)) throw new ControllerError('node.execution_risk must be read_only, delegable, or protected');
  return {
    execution_risk: executionRisk,
    routing_reason: requiredString(raw.routing_reason, 'node.routing_reason'),
    execution_owner: requiredString(raw.execution_owner, 'node.execution_owner'),
    integration_owner: requiredString(raw.integration_owner, 'node.integration_owner'),
    quality_guard: requiredString(raw.quality_guard, 'node.quality_guard'),
  };
}

function validateAgentType(kind, executionRisk, agentType) {
  if (kind === 'total_review') {
    if (executionRisk !== 'read_only' || !SOL_ROLES.has(agentType)) throw new ControllerError('A total_review node requires a read_only Sol agent_type');
    return;
  }
  if (agentType == null) return;
  if (kind === QUALITY_REVIEW_KIND) {
    if (executionRisk !== 'read_only') throw new ControllerError('A quality_review node must be read_only');
    if (agentType !== TERRA_REVIEW_ROLE) throw new ControllerError('A quality_review node requires avsp_terra_xhigh');
    return;
  }
  if (executionRisk === 'protected' && agentType !== PROTECTED_EXECUTOR_ROLE) throw new ControllerError('A protected node agent_type must be avsp_terra_high or omitted');
  if (executionRisk === 'delegable' && !LUNA_EXECUTOR_ROLES.has(agentType) && agentType !== PROTECTED_EXECUTOR_ROLE) throw new ControllerError('A delegable node agent_type must be a Luna executor or avsp_terra_high');
  if (executionRisk === 'read_only' && (!READ_ONLY_ROLES.has(agentType) || READ_ONLY_FALLBACK_ROLE_SET.has(agentType))) throw new ControllerError('A read_only node agent_type cannot configure a Terra fallback role or other non-primary role');
}

function nodeRecord(raw, options = {}) {
  if (!raw || typeof raw !== 'object') throw new ControllerError('Each node must be an object');
  const id = requiredIdentifier(raw.id, 'node.id'); const kind = requiredString(raw.kind, 'node.kind');
  if (raw.agent_type !== undefined && raw.agent_type !== null) requiredString(raw.agent_type, 'node.agent_type');
  const dependencies = raw.depends_on ?? [];
  if (!Array.isArray(dependencies) || dependencies.some(dependency => typeof dependency !== 'string' || !dependency.trim())) throw new ControllerError('node.depends_on must contain non-empty string identifiers');
  const routing = nodeRouting(raw, options.routingRequired === true);
  const isQualityReview = kind === QUALITY_REVIEW_KIND;
  const defaultAgentType = raw.agent_type == null
    ? (kind === 'total_review' ? 'avsp_sol_high' : (isQualityReview ? TERRA_REVIEW_ROLE : ({ read_only: 'avsp_luna_high', delegable: 'avsp_luna_high_executor', protected: PROTECTED_EXECUTOR_ROLE }[routing.execution_risk] ?? null)))
    : null;
  const agentType = raw.agent_type ?? defaultAgentType;
  validateAgentType(kind, routing.execution_risk, agentType);
  return { id, kind, review_stage: isQualityReview ? 'terra' : kind === 'total_review' ? 'sol' : null, agent_type: agentType, depends_on: dependencies, ...routing, rescue_role: null, rescue_reason: null, rescued_at: null, rescue_count: 0, status: PENDING, agent_task_path: null, agent_thread_id: null, agent_role: null, claim_id: null, claimed_at: null, activation_at: null, activation_deadline_at: null, heartbeat_at: null, heartbeat_count: 0, lease_duration_sec: null, attempt: 0, attempt_budget_used: 0, unavailable_attempts: 0, result: null, checkpoint: null, checkpoint_at: null, workflow_completion_intent: null, recovery_history: [], review_gate: null };
}

function normalizeState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new ControllerError('Task state must be an object');
  if (!state.nodes || typeof state.nodes !== 'object' || Array.isArray(state.nodes) || !Object.keys(state.nodes).length) throw new ControllerError('Task state must contain nodes');
  if (state.workspace_claims === undefined || state.workspace_claims === null) throw new ControllerError('Current task state requires workspace_claims');
  state.workspace_claims = normalizeStoredWorkspaceClaims(state.workspace_claims);
  state.workflow_revision ??= 0;
  state.closed_revision ??= null;
  state.closed_at ??= null;
  state.assurance_assessment ??= null;
  state.repair_records ??= [];
  if (!Array.isArray(state.repair_records)) throw new ControllerError('Task repair_records must be an array');
  if (state.routing_schema_version !== REVIEW_PROTOCOL_VERSION) throw new ControllerError('Task state must use routing_schema_version=3');
  if (!ASSURANCE_LEVELS.has(state.assurance_level)) throw new ControllerError('A v3 task state requires assurance_level terra or sol');
  if (state.assurance_assessment !== null) state.assurance_assessment = assuranceAssessment(state.assurance_assessment, 'assurance_assessment');
  {
    if (state.review_protocol_version !== REVIEW_PROTOCOL_VERSION || !REVIEW_ENTRY_STAGES.has(state.review_entry_stage)) {
      throw new ControllerError('A v3 task state requires complete review protocol metadata');
    }
    state.review_context = reviewContextValue(state.review_context);
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
    node.review_stage ??= node.kind === QUALITY_REVIEW_KIND ? 'terra' : node.kind === 'total_review' ? 'sol' : null;
    node.review_gate ??= null;
    if (isReviewNode(node, state.routing_schema_version)) {
      if (!node.review_gate || typeof node.review_gate !== 'object' || !REVIEW_PROTOCOL_STAGES.has(node.review_gate.stage)) throw new ControllerError('A v3 review node requires an explicit review_gate');
      if (node.kind !== protocolNodeKind(node.review_gate.stage) || node.agent_type !== protocolNodeRole(node.review_gate.stage)) throw new ControllerError('A v3 review node does not match its review_gate stage');
      if (node.review_gate.stage === 'terra_cohort') {
        const cohort = node.review_gate.cohort;
        if (!cohort || typeof cohort !== 'object' || !COHORT_PHASES.has(cohort.phase) || !cohort.lanes || typeof cohort.lanes !== 'object' || COHORT_SLOTS.some(slot => !cohort.lanes[slot])) throw new ControllerError('A v3 Terra cohort requires two explicit lanes');
      }
    }
    if (!hasOwn(node, 'execution_risk')) throw new ControllerError(`Task node lacks current routing fields: ${nodeId}`);
  }
  validateNodes(state.nodes);
  validateReviewTopology(state.nodes, state.assurance_level, state.routing_schema_version, state.review_entry_stage);
  return state;
}

async function makeState(manifest) {
  const required = ['task_id', 'workspace', 'goal', 'requirements'];
  if (!manifest || typeof manifest !== 'object' || required.some(key => !hasOwn(manifest, key))) throw new ControllerError('Manifest requires task_id, workspace, goal, and requirements');
  const taskId = requiredIdentifier(manifest.task_id, 'task_id');
  const routingSchemaVersion = manifest.routing_schema_version;
  if (routingSchemaVersion !== REVIEW_PROTOCOL_VERSION) throw new ControllerError('routing_schema_version must be 3');
  const assuranceLevel = requiredString(manifest.assurance_level, 'assurance_level');
  if (!ASSURANCE_LEVELS.has(assuranceLevel)) throw new ControllerError('assurance_level must be terra or sol');
  const assuranceAssessmentValue = assuranceAssessment(manifest.assurance_assessment);
  requireAssuranceLevelMatches(assuranceLevel, assuranceAssessmentValue);
  if (!hasOwn(manifest, 'workspace_claims')) throw new ControllerError('Current v3 manifests require workspace_claims');
  const workspace = await canonicalWorkspace(manifest.workspace);
  const workspaceClaims = await normalizeWorkspaceClaims(manifest.workspace_claims, workspace);
  const globalWriteReason = globalWriteJustification(manifest, workspaceClaims);
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
    const node = nodeRecord(rawNode, { routingRequired: true, routingSchemaVersion, expectedTaskId: taskId });
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
  if (routingSchemaVersion === REVIEW_PROTOCOL_VERSION) {
    const review = reviewNodes(nodes, routingSchemaVersion)[0];
    if (review) applyProtocolStage(review, reviewEntryStage);
  }
  validateNodes(nodes);
  const normalizedReviewDependencies = completeReviewDirectDependencies(nodes, routingSchemaVersion);
  validateReviewTopology(nodes, assuranceLevel, routingSchemaVersion, reviewEntryStage);
  if (hasOwn(manifest, 'workspace_claims') && Object.values(nodes).some(node => !isReviewNode(node, routingSchemaVersion) && node.execution_risk !== 'read_only') && !workspaceClaims.some(claim => claim.mode === 'write')) {
    throw new ControllerError('workspace_claims requires at least one write claim for non-read-only work');
  }
  const created = utcNow();
  const events = [{ at: created, type: 'task_initialized', workflow_revision: 0 }];
  if (normalizedReviewDependencies.length) events.push({ at: created, type: 'review_direct_dependencies_completed', node_id: reviewNodes(nodes, routingSchemaVersion)[0].id, added_dependencies: normalizedReviewDependencies, workflow_revision: 0 });
  const state = { version: VERSION, routing_schema_version: REVIEW_PROTOCOL_VERSION, assurance_level: assuranceLevel, assurance_assessment: assuranceAssessmentValue, review_protocol_version: REVIEW_PROTOCOL_VERSION, review_entry_stage: reviewEntryStage, review_context: reviewContext, task_id: taskId, workspace, workspace_claims: workspaceClaims, ...(globalWriteReason === null ? {} : { global_write_justification: globalWriteReason }), goal, requirements, scope: manifest.scope ?? [], non_goals: manifest.non_goals ?? [], nodes, participants: [], reviews: [], repair_records: [], max_review_charter: null, events, workflow_revision: 0, closed_revision: null, closed_at: null, created_at: created, updated_at: created };
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
  const workspaceLease = publicWorkspaceLease(state);
  return { task_id: state.task_id, ...(workspaceLease ? { state_path: workspaceLease.state_path, database_path: workspaceLease.database_path, task_key: workspaceLease.task_key } : {}), workspace: state.workspace, workspace_claims: state.workspace_claims, workspace_lease: workspaceLease, assurance_level: state.assurance_level, effective_assurance_level: effectiveAssuranceLevel(state), assurance_assessment: state.assurance_assessment, review_protocol_version: state.review_protocol_version, review_entry_stage: state.review_entry_stage, review_context: state.review_context, goal: state.goal, nodes: Object.values(state.nodes), ready_nodes: readyNodes(state), stale_nodes: staleNodes(state), participants: state.participants, reviews: externallyVisibleReviews(state), repair_records: state.repair_records, workflow_revision: state.workflow_revision, updated_at: state.updated_at };
}

function doctorCheck(id, status, detail) { return { id, status, detail }; }

async function unreadableDoctor(parameters, filePath, error) {
  const database = globalWorkflowStorePath();
  const reference = publicTaskStoreReference(filePath);
  let databaseDetail = { ...reference, error: error.message };
  try {
    const metadata = await fs.stat(database);
    databaseDetail = { ...reference, bytes: metadata.size, modified_at: metadata.mtime.toISOString(), error: error.message };
  } catch (statError) {
    if (statError.code !== 'ENOENT') databaseDetail = { ...reference, error: `${error.message}; ${statError.message}` };
  }
  return {
    task_id: requiredString(parameters.task_id, 'task_id'),
    workspace: null,
    health: 'blocked',
    checks: [
      doctorCheck('state_database', 'fail', databaseDetail),
      doctorCheck('task_state', 'fail', { ...reference, error: error.message }),
    ],
    recovery_candidates: [],
    close_status: { close_allowed: false, reasons: [`task state is unreadable: ${error.message}`] },
  };
}

async function doctorTask(parameters) {
  if (parameters.task_id === undefined || parameters.task_id === null) throw new ControllerError('workflow_doctor requires task_id');
  const filePath = await configuredStatePath(parameters, requiredString(parameters.task_id, 'task_id'));
  let state;
  try { state = normalizeState(await loadState(filePath)); }
  catch (error) { return unreadableDoctor(parameters, filePath, error); }
  const checks = [];
  const database = globalWorkflowStorePath();
  const reference = publicTaskStoreReference(filePath);
  try {
    const metadata = await fs.stat(database);
    checks.push(doctorCheck('state_database', 'pass', { ...reference, bytes: metadata.size, modified_at: metadata.mtime.toISOString() }));
  } catch (error) {
    if (error.code === 'ENOENT') checks.push(doctorCheck('state_database', 'fail', { ...reference, reason: 'SQLite state database is missing' }));
    else checks.push(doctorCheck('state_database', 'fail', { ...reference, error: error.message }));
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
    checks.push(doctorCheck('workspace_lease', 'fail', { reason: 'current task has no workspace lease' }));
  } else {
    try {
      const lease = await loadWorkspaceLease(state.workspace_lease.registry_path, state.workspace);
      const active = state.workspace_lease.status === 'active';
      const released = state.workspace_lease.status === 'released';
      const matches = active ? workspaceLeaseMatches(lease, state, filePath) : released && workspaceLeaseStatePathOwners(lease, filePath).length === 0;
      checks.push(doctorCheck('workspace_lease', matches ? 'pass' : 'fail', {
        ...reference,
        task_status: state.workspace_lease.status,
        registry_active_tasks: lease.active_tasks.map(entry => ({ task_id: entry.task_id, task_key: publicTaskKey(entry.state_path), phase: entry.phase, workspace_claims: entry.workspace_claims })),
        active_write_locks: lease.active_locks.map(lock => ({ lock_id: lock.lock_id, task_id: lock.task_id, node_id: lock.node_id, prefix: lock.prefix, acquired_at: lock.acquired_at })),
        reason: matches ? null : 'workspace lease does not match task state',
      }));
    } catch (error) {
      checks.push(doctorCheck('workspace_lease', 'fail', { ...reference, error: error.message }));
    }
  }

  const stale = staleNodes(state);
  checks.push(doctorCheck('running_nodes', stale.length ? 'attention' : 'pass', {
    running: Object.values(state.nodes).filter(node => node.status === RUNNING).map(node => node.id),
    stale: stale.map(node => ({ id: node.id, reason: node.reason, claim_id: node.claim_id })),
  }));
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

async function validateWorkspaceLeaseEntry(entry, leasePath) {
  const fields = new Set(['task_id', 'state_path', 'state_dir', 'acquired_at', 'phase', 'workspace_claims']);
  const authorityFields = new Set([...fields, 'state_parent_authority']);
  const keyedFields = new Set([...fields, 'task_key']);
  const keyedAuthorityFields = new Set([...authorityFields, 'task_key']);
  if ((!hasExactFields(entry, fields) && !hasExactFields(entry, authorityFields) && !hasExactFields(entry, keyedFields) && !hasExactFields(entry, keyedAuthorityFields)) || !validTimestamp(entry.acquired_at) || !['initializing', 'active'].includes(entry.phase)) throw new ControllerError(`Unsupported workspace lease entry: ${leasePath}`);
  requiredIdentifier(entry.task_id, 'workspace lease task_id');
  if (typeof entry.state_path !== 'string' || typeof entry.state_dir !== 'string') throw new ControllerError(`Invalid workspace lease entry path: ${leasePath}`);
  const statePath = await canonicalStatePath(entry.state_path, 'workspace lease state_path');
  const stateDir = await canonicalStateDirectory(entry.state_dir, 'workspace lease state_dir');
  if (!sameStatePath(path.dirname(statePath), stateDir)) throw new ControllerError(`Invalid workspace lease entry path: ${leasePath}`);
  entry.state_path = statePath;
  entry.state_dir = stateDir;
  entry.task_key ??= taskKey(statePath);
  if (entry.task_key !== taskKey(statePath)) throw new ControllerError(`Invalid workspace lease task key: ${leasePath}`);
  if (entry.state_parent_authority !== undefined && !validStateParentAuthority(entry.state_parent_authority, statePath)) throw new ControllerError(`Invalid workspace lease state parent authority: ${leasePath}`);
  entry.workspace_claims = normalizeStoredWorkspaceClaims(entry.workspace_claims);
}

function normalizeWorkspaceLeaseLocks(lease, leasePath) {
  if (!hasExactFields(lease, new Set(['version', 'workspace', 'active_tasks', 'active_locks', 'updated_at'])) || !Array.isArray(lease.active_locks) || lease.active_locks.length > MAX_WORKSPACE_ACTIVE_WRITE_LOCKS) {
    throw new ControllerError(`Unsupported workspace lease: ${leasePath}`);
  }
}

function workspaceWriteLockMatchesEntry(lock, entry) {
  return lock.task_id === entry.task_id && lock.task_key === entry.task_key;
}

function workspaceWriteLockMatchesOwner(lock, state, filePath, nodeId, claimId) {
  return lock.task_id === state.task_id
    && lock.task_key === taskKey(filePath)
    && lock.node_id === nodeId
    && lock.claim_id === claimId;
}

function sameWorkspaceWriteLockOwner(left, right) {
  return left.task_id === right.task_id
    && left.task_key === right.task_key
    && left.node_id === right.node_id
    && left.claim_id === right.claim_id;
}

function writeLocksConflict(left, right) {
  return isClaimAncestor(left.prefix, right.prefix) || isClaimAncestor(right.prefix, left.prefix);
}

function validateWorkspaceWriteLock(lock, lease, leasePath) {
  const fields = new Set(['lock_id', 'task_id', 'state_path', 'node_id', 'claim_id', 'prefix', 'purpose', 'acquired_at']);
  const keyedFields = new Set([...fields, 'task_key']);
  if ((!hasExactFields(lock, fields) && !hasExactFields(lock, keyedFields)) || !validTimestamp(lock.acquired_at)) throw new ControllerError(`Unsupported workspace write lock: ${leasePath}`);
  requiredString(lock.lock_id, 'workspace write lock lock_id');
  requiredIdentifier(lock.task_id, 'workspace write lock task_id');
  requiredIdentifier(lock.node_id, 'workspace write lock node_id');
  requiredString(lock.claim_id, 'workspace write lock claim_id');
  requiredWriteLockPurpose(lock.purpose);
  if (typeof lock.state_path !== 'string') throw new ControllerError(`Invalid workspace write lock state path: ${leasePath}`);
  lock.state_path = path.resolve(lock.state_path);
  lock.task_key ??= taskKey(lock.state_path);
  if (lock.task_key !== taskKey(lock.state_path)) throw new ControllerError(`Invalid workspace write lock task key: ${leasePath}`);
  const normalized = normalizeStoredWorkspaceClaims([{ mode: 'write', prefix: lock.prefix }]);
  if (normalized.length !== 1 || normalized[0].prefix !== lock.prefix) throw new ControllerError(`Invalid workspace write lock prefix: ${leasePath}`);
  const owner = lease.active_tasks.find(entry => entry.phase === 'active' && workspaceWriteLockMatchesEntry(lock, entry));
  if (!owner) throw new ControllerError(`Workspace write lock has no active task owner: ${leasePath}`);
  if (!owner.workspace_claims.some(claim => claim.mode === 'write' && isClaimAncestor(claim.prefix, lock.prefix))) {
    throw new ControllerError(`Workspace write lock exceeds its task write claims: ${leasePath}`);
  }
}

async function validateWorkspaceLease(lease, leasePath) {
  normalizeWorkspaceLeaseLocks(lease, leasePath);
  if (lease.version !== WORKSPACE_LEASE_VERSION || !Array.isArray(lease.active_tasks) || lease.active_tasks.length > MAX_WORKSPACE_ACTIVE_TASKS || !validTimestamp(lease.updated_at)) throw new ControllerError(`Unsupported workspace lease: ${leasePath}`);
  const identities = new Set();
  for (const entry of lease.active_tasks) {
    await validateWorkspaceLeaseEntry(entry, leasePath);
    const identity = `${entry.task_id}\u0000${statePathKey(entry.state_path)}\u0000${entry.acquired_at}`;
    if (identities.has(identity)) throw new ControllerError(`Duplicate workspace lease entry: ${leasePath}`);
    identities.add(identity);
  }
  for (let index = 0; index < lease.active_tasks.length; index++) {
    for (let other = index + 1; other < lease.active_tasks.length; other++) {
      if (lease.active_tasks[index].task_key === lease.active_tasks[other].task_key) throw new ControllerError(`Conflicting workspace lease entries: ${leasePath}`);
    }
  }
  const lockIds = new Set();
  for (const lock of lease.active_locks) {
    validateWorkspaceWriteLock(lock, lease, leasePath);
    if (lockIds.has(lock.lock_id)) throw new ControllerError(`Duplicate workspace write lock: ${leasePath}`);
    lockIds.add(lock.lock_id);
  }
  for (let index = 0; index < lease.active_locks.length; index++) {
    for (let other = index + 1; other < lease.active_locks.length; other++) {
      const left = lease.active_locks[index]; const right = lease.active_locks[other];
      if (!sameWorkspaceWriteLockOwner(left, right) && writeLocksConflict(left, right)) {
        throw new ControllerError(`Conflicting active workspace write locks: ${leasePath}`);
      }
    }
  }
}

// This is an internal logical locator for the workspace-control row in the
// single user-level global store; it is not a workspace-local SQLite file.
function workspaceLeasePath(workspace) {
  return path.join(workspace, '.codex', 'workflow-controller', WORKSPACE_CONTROL_FILENAME);
}

async function assertWorkspaceControlCreationIsSafe(workspace, stateDirectory) {
  assertStateDirectoryBoundary(workspace, stateDirectory);
  const globalStates = await listGlobalTaskStatesForWorkspace(workspace);
  if (globalStates.length) {
    const uniqueStatePaths = [...new Set(globalStates.map(entry => entry.state.workspace_lease?.state_path ?? path.join(entry.namespace_key, `${entry.task_id}${SQLITE_STATE_SUFFIX}`)))];
    throw new ControllerError(`Workspace control database is missing while current v3 task state exists; explicit destructive recovery is required: ${uniqueStatePaths.join(', ')}`);
  }
}

function assertStateDirectoryBoundary(workspace, stateDirectory) {
  if (!stateDirectory) return;
  const resolvedWorkspace = path.resolve(workspace);
  const resolvedStateDirectory = path.resolve(stateDirectory);
  if (!pathIsWithinPhysicalRoot(resolvedWorkspace, resolvedStateDirectory)) {
    throw new ControllerError(`workflow_init state_dir must be inside its workspace: ${stateDirectory}`);
  }
  const canonicalControlDirectory = path.resolve(resolvedWorkspace, '.codex', 'workflow-controller');
  if (pathIsWithinPhysicalRoot(canonicalControlDirectory, resolvedStateDirectory)) return;
  const relative = path.relative(resolvedWorkspace, resolvedStateDirectory);
  const segments = relative && relative !== '.' ? relative.split(path.sep) : [];
  if (segments.some(segment => isIgnoredFingerprintDirectory(segment))) {
    throw new ControllerError(`workflow_init state_dir cannot be inside an ignored workspace directory: ${stateDirectory}`);
  }
}

async function ensureWorkspaceControl(workspace, { allowCreate = false, stateDirectory = null } = {}) {
  const databasePath = workspaceLeasePath(workspace);
  if (await workspaceControlExists(databasePath)) return databasePath;
  if (!allowCreate) throw new ControllerError(`Workspace control database does not exist: ${databasePath}`);
  await assertWorkspaceControlCreationIsSafe(workspace, stateDirectory);
  if (await workspaceControlExists(databasePath)) return databasePath;
  const lease = { version: WORKSPACE_LEASE_VERSION, workspace, active_tasks: [], active_locks: [], updated_at: utcNow() };
  try {
    await createWorkspaceControl(databasePath, workspace, lease);
  } catch (error) {
    if (await workspaceControlExists(databasePath)) return databasePath;
    throw new ControllerError(`Cannot create workspace control database: ${databasePath}: ${error.message}`);
  }
  return databasePath;
}

async function withWorkspaceLeaseLock(workspace, callback, { allowAuthorityCreation = false, stateDirectory = null } = {}) {
  let leasePath;
  try { leasePath = await ensureWorkspaceControl(workspace, { allowCreate: allowAuthorityCreation, stateDirectory }); }
  catch (error) { throw asControllerError(error); }
  let result;
  await withWorkspaceControlTransaction(leasePath, workspace, async (storedLease, save) => {
    const lease = storedLease && typeof storedLease === 'object' && !Array.isArray(storedLease)
      ? storedLease
      : { version: WORKSPACE_LEASE_VERSION, workspace, active_tasks: [], active_locks: [], updated_at: utcNow() };
    await validateWorkspaceLease(lease, leasePath);
    const context = {
      lease,
      save,
      authority: { record: { version: WORKSPACE_LEASE_VERSION, workspace, registry_path: leasePath, control_directory: path.dirname(leasePath) } },
      recovery: null,
      parent_authorities: null,
    };
    result = await callback(leasePath, context);
    await validateWorkspaceLease(context.lease, leasePath);
    save(context.lease);
  }).catch(error => { throw asControllerError(error); });
  return result;
}

async function loadWorkspaceLease(leasePath, workspace, { authorityContext = null } = {}) {
  if (leasePath !== workspaceLeasePath(workspace)) throw new ControllerError(`Workspace control path does not match its canonical workspace: ${leasePath}`);
  let lease;
  try { lease = authorityContext?.lease ?? (await readWorkspaceControl(leasePath, workspace)).payload; }
  catch (error) { throw asControllerError(error); }
  if (!lease || typeof lease !== 'object' || Array.isArray(lease)) throw new ControllerError(`Unsupported workspace control lease: ${leasePath}`);
  await validateWorkspaceLease(lease, leasePath);
  return lease;
}

function compactWorkspaceWriteLock(lock) {
  return {
    lock_id: lock.lock_id,
    task_id: lock.task_id,
    node_id: lock.node_id,
    prefix: lock.prefix,
    purpose: lock.purpose,
    acquired_at: lock.acquired_at,
  };
}

async function activeWorkspaceWriteLocks(state) {
  if (!state.workspace_lease || state.workspace_lease.status !== 'active') return [];
  const lease = await loadWorkspaceLease(state.workspace_lease.registry_path, state.workspace);
  return lease.active_locks.map(compactWorkspaceWriteLock);
}

async function compactStateWithActiveWriteLocks(state) {
  return { ...compactState(state), active_write_locks: await activeWorkspaceWriteLocks(state) };
}

async function writeWorkspaceLeaseRegistry(context, leasePath, lease) {
  if (!context || typeof context !== 'object' || typeof context.save !== 'function') throw new ControllerError(`Workspace control transaction is required: ${leasePath}`);
  await validateWorkspaceLease(lease, leasePath);
  context.lease = lease;
}

function stateWorkspaceClaims(state) { return state.workspace_lease?.workspace_claims ?? state.workspace_claims; }

function workspaceLeaseEntryMatches(entry, state, filePath, { activeOnly = true } = {}) {
  return entry.task_id === state.task_id
    && entry.task_key === taskKey(filePath)
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
  return lease.active_tasks.filter(entry => entry.task_key === taskKey(filePath));
}

function workspaceLeasePeerOwners(lease, state, filePath) {
  return workspaceLeaseStatePathOwners(lease, filePath)
    .filter(entry => !workspaceLeaseEntryMatches(entry, state, filePath, { activeOnly: false }));
}

async function normalizeRequestedWriteLockPrefixes(rawPrefixes, workspace) {
  if (!Array.isArray(rawPrefixes) || !rawPrefixes.length) throw new ControllerError('write_prefixes must be a non-empty array of workspace-relative POSIX prefixes');
  if (rawPrefixes.length > MAX_WRITE_LOCK_PREFIXES_PER_REQUEST) throw new ControllerError(`write_prefixes exceeds the ${MAX_WRITE_LOCK_PREFIXES_PER_REQUEST}-prefix limit`);
  if (rawPrefixes.some(prefix => typeof prefix !== 'string')) throw new ControllerError('write_prefixes must contain only strings');
  if (new Set(rawPrefixes).size !== rawPrefixes.length) throw new ControllerError('write_prefixes must not contain duplicates');
  const normalized = await normalizeWorkspaceClaims(rawPrefixes.map(prefix => ({ mode: 'write', prefix })), workspace);
  if (normalized.length !== rawPrefixes.length) {
    throw new ControllerError('write_prefixes must not contain ancestor/descendant overlaps; acquire the smallest actual prefix once');
  }
  return normalized.map(claim => claim.prefix);
}

function requiredWriteLockPurpose(value) {
  const purpose = requiredString(value, 'purpose');
  if (purpose.length > MAX_GLOBAL_WRITE_JUSTIFICATION_LENGTH) throw new ControllerError(`purpose must be no longer than ${MAX_GLOBAL_WRITE_JUSTIFICATION_LENGTH} characters`);
  return purpose;
}

function requestedWriteLockIds(value) {
  if (!Array.isArray(value) || !value.length) throw new ControllerError('lock_ids must be a non-empty array');
  if (value.length > MAX_WRITE_LOCK_PREFIXES_PER_REQUEST) throw new ControllerError(`lock_ids exceeds the ${MAX_WRITE_LOCK_PREFIXES_PER_REQUEST}-lock limit`);
  const ids = value.map(lockId => requiredString(lockId, 'lock_ids item'));
  if (new Set(ids).size !== ids.length) throw new ControllerError('lock_ids must not contain duplicates');
  return ids;
}

function writeClaimCoversPrefix(claims, prefix) {
  return claims.some(claim => claim.mode === 'write' && isClaimAncestor(claim.prefix, prefix));
}

function activeOrTerminalClaimForWriteLock(state, node, parameters) {
  if (isCohortReviewNode(state, node)) {
    const claimId = requiredString(parameters.claim_id, 'claim_id');
    const lane = cohortLaneForClaim(node, claimId);
    if (!lane || (lane.status !== RUNNING && !TERMINAL.has(lane.status))) throw new ControllerError(`Claim does not own an active or terminal Terra cohort lane: ${parameters.node_id}`);
    return lane;
  }
  const claimId = requiredString(parameters.claim_id, 'claim_id');
  if (!node || (node.status !== RUNNING && !TERMINAL.has(node.status)) || node.claim_id !== claimId) throw new ControllerError(`Claim does not own an active or terminal node: ${parameters.node_id}`);
  return node;
}

async function currentWriteLockOwner(filePath, nodeId, parameters, { allowTerminal = false } = {}) {
  const state = normalizeState(await loadState(filePath));
  const node = state.nodes[nodeId];
  const activeClaim = allowTerminal
    ? activeOrTerminalClaimForWriteLock(state, node, parameters)
    : activeClaimForOperation(state, node, parameters);
  return { state, node, activeClaim };
}

async function acquireWorkspaceWriteLock(parameters) {
  const [filePath, initialState] = await readTask(parameters);
  const nodeId = requiredIdentifier(parameters.node_id, 'node_id');
  const claimId = requiredString(parameters.claim_id, 'claim_id');
  const writePrefixes = await normalizeRequestedWriteLockPrefixes(parameters.write_prefixes, initialState.workspace);
  const purpose = requiredWriteLockPurpose(parameters.purpose);
  if (writePrefixes.includes('.') && !initialState.workspace_claims.some(claim => claim.mode === 'write' && claim.prefix === '.')) {
    throw new ControllerError('A workspace-wide write lock requires a declared workspace-wide write claim');
  }
  return withWorkspaceLeaseLock(initialState.workspace, async (leasePath, authorityContext) => {
    const { state, node, activeClaim } = await currentWriteLockOwner(filePath, nodeId, parameters);
    if (activeClaim.claim_id !== claimId) throw new ControllerError(`Claim does not own node: ${nodeId}`);
    if (node.execution_risk === 'read_only') throw new ControllerError(`A read_only node cannot acquire a workspace write lock: ${nodeId}`);
    if (state.workspace !== initialState.workspace || state.workspace_lease?.registry_path !== leasePath) throw new ControllerError('Task workspace lease authority changed while acquiring a write lock');
    await requireActiveWorkspaceLease(state, filePath, authorityContext);
    const entry = workspaceLeaseMatches(authorityContext.lease, state, filePath);
    if (!entry) throw new ControllerError(`Workspace lease does not belong to this active task: ${leasePath}`);
    const acquired = [];
    const reused = [];
    for (const prefix of writePrefixes) {
      if (!writeClaimCoversPrefix(entry.workspace_claims, prefix)) {
        throw new ControllerError(`Requested write lock is outside this task's declared write claims: ${prefix}`);
      }
      const owned = authorityContext.lease.active_locks.filter(lock => workspaceWriteLockMatchesOwner(lock, state, filePath, nodeId, claimId));
      const covering = owned.find(lock => isClaimAncestor(lock.prefix, prefix));
      if (covering) {
        reused.push({ lock_id: covering.lock_id, prefix: covering.prefix });
        continue;
      }
      const narrower = owned.find(lock => isClaimAncestor(prefix, lock.prefix));
      if (narrower) throw new ControllerError(`Cannot widen write lock ${narrower.prefix} to ${prefix}; release ${narrower.lock_id} first`);
      const conflict = authorityContext.lease.active_locks.find(lock => !workspaceWriteLockMatchesOwner(lock, state, filePath, nodeId, claimId) && writeLocksConflict(lock, { prefix }));
      if (conflict) {
        throw new ControllerError(`Requested write lock conflicts with active task ${conflict.task_id} node ${conflict.node_id} at ${conflict.prefix}`);
      }
      if (authorityContext.lease.active_locks.length >= MAX_WORKSPACE_ACTIVE_WRITE_LOCKS) {
        throw new ControllerError(`Workspace write locks exceed the ${MAX_WORKSPACE_ACTIVE_WRITE_LOCKS}-lock limit`);
      }
      const lock = { lock_id: randomUUID(), task_id: state.task_id, task_key: taskKey(filePath), state_path: filePath, node_id: nodeId, claim_id: claimId, prefix, purpose, acquired_at: utcNow() };
      authorityContext.lease.active_locks.push(lock);
      acquired.push({ lock_id: lock.lock_id, prefix: lock.prefix });
    }
    authorityContext.lease.updated_at = utcNow();
    return { task_id: state.task_id, node_id: nodeId, claim_id: claimId, acquired, reused, active_lock_count: authorityContext.lease.active_locks.length };
  }, { allowAuthorityCreation: false });
}

async function releaseWorkspaceWriteLock(parameters) {
  const [filePath, initialState] = await readTask(parameters);
  const nodeId = requiredIdentifier(parameters.node_id, 'node_id');
  const claimId = requiredString(parameters.claim_id, 'claim_id');
  const lockIds = requestedWriteLockIds(parameters.lock_ids);
  return withWorkspaceLeaseLock(initialState.workspace, async (leasePath, authorityContext) => {
    const { state, activeClaim } = await currentWriteLockOwner(filePath, nodeId, parameters, { allowTerminal: true });
    if (activeClaim.claim_id !== claimId) throw new ControllerError(`Claim does not own node: ${nodeId}`);
    if (state.workspace !== initialState.workspace || state.workspace_lease?.registry_path !== leasePath) throw new ControllerError('Task workspace lease authority changed while releasing a write lock');
    await requireActiveWorkspaceLease(state, filePath, authorityContext);
    const owned = authorityContext.lease.active_locks.filter(lock => workspaceWriteLockMatchesOwner(lock, state, filePath, nodeId, claimId));
    const byId = new Map(owned.map(lock => [lock.lock_id, lock]));
    const missing = lockIds.filter(lockId => !byId.has(lockId));
    if (missing.length) throw new ControllerError(`Write lock is not owned by this claim: ${missing.join(', ')}`);
    authorityContext.lease.active_locks = authorityContext.lease.active_locks.filter(lock => !lockIds.includes(lock.lock_id));
    authorityContext.lease.updated_at = utcNow();
    return { task_id: state.task_id, node_id: nodeId, claim_id: claimId, released: lockIds.map(lockId => ({ lock_id: lockId, prefix: byId.get(lockId).prefix })), active_lock_count: authorityContext.lease.active_locks.length };
  }, { allowAuthorityCreation: false });
}

async function releaseWorkspaceWriteLocksForClaim(filePath, nodeId, claimId, reason) {
  const state = normalizeState(await loadState(filePath));
  if (!state.workspace_lease || state.workspace_lease.status !== 'active') return { released: [] };
  return withWorkspaceLeaseLock(state.workspace, (leasePath, authorityContext) => {
    if (leasePath !== state.workspace_lease.registry_path) throw new ControllerError('Task workspace lease authority changed while releasing write locks');
    const released = authorityContext.lease.active_locks
      .filter(lock => workspaceWriteLockMatchesOwner(lock, state, filePath, nodeId, claimId))
      .map(lock => ({ lock_id: lock.lock_id, prefix: lock.prefix }));
    if (released.length) {
      authorityContext.lease.active_locks = authorityContext.lease.active_locks.filter(lock => !workspaceWriteLockMatchesOwner(lock, state, filePath, nodeId, claimId));
      authorityContext.lease.updated_at = utcNow();
    }
    return { released, reason };
  }, { allowAuthorityCreation: false });
}

async function releaseWriteLocksAfterNodeLifecycle(parameters, reason) {
  const [filePath] = await readTask(parameters);
  return releaseWorkspaceWriteLocksForClaim(
    filePath,
    requiredIdentifier(parameters.node_id, 'node_id'),
    requiredString(parameters.claim_id, 'claim_id'),
    reason,
  );
}

async function requireActiveWorkspaceLease(state, filePath, authorityContext = null) {
  if (!state.workspace_lease) throw new ControllerError('Current task has no workspace lease and cannot change state');
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

async function withActiveWorkspaceStateLock(filePath, callback, { cursorRelevant = true } = {}) {
  const initialState = normalizeState(await loadState(filePath));
  if (!initialState.workspace_lease) throw new ControllerError('Current task has no workspace lease and cannot change state');
  const parentAuthority = await stateParentAuthorityForState(initialState, filePath);
  await verifyRegularDirectorySnapshot(parentAuthority, 'Controller state parent');
  const expectedLeasePath = initialState.workspace_lease.registry_path;
  const leasePath = expectedLeasePath;
  return withTaskStateTransaction(databasePath(filePath), { parentAuthority, cursor_relevant: cursorRelevant }, async (storedState, save) => {
    if (storedState === null) throw new ControllerError(`Current SQLite controller state does not exist: ${filePath}`);
    const state = normalizeState(storedState);
    return taskStateTransactionContext.run({ filePath, state, parentAuthority }, async () => {
      await verifyRegularDirectorySnapshot(parentAuthority, 'Controller state parent');
      if (state.workspace !== initialState.workspace || state.workspace_lease?.registry_path !== leasePath) throw new ControllerError('Task workspace lease authority changed while acquiring locks');
      const currentParentAuthority = await stateParentAuthorityForState(state, filePath);
      if (!sameStateParentAuthority(currentParentAuthority, parentAuthority)) throw new ControllerError(`Controller state parent authority changed: ${filePath}`);
      await attachStateParentAuthority(state, filePath, parentAuthority);
      const authorityContext = { authority: { record: { version: WORKSPACE_LEASE_VERSION, workspace: state.workspace, registry_path: expectedLeasePath, control_directory: path.dirname(expectedLeasePath) } }, recovery: null, parent_authorities: null };
      const lease = await requireActiveWorkspaceLease(state, filePath, authorityContext);
      await bindStateParentAuthorityToWorkspaceLease(lease, state, filePath, authorityContext);
      const result = await callback(state, lease, authorityContext);
      await verifyRegularDirectorySnapshot(parentAuthority, 'Controller state parent');
      save(taskStateTransactionContext.getStore().state);
      return result;
    });
  });
}

function assertReleaseStateCanBeReleased(state, { closeAllowed, parameters }) {
  state.workspace_claims = normalizeStoredWorkspaceClaims(state.workspace_claims);
  if (state.workspace_lease) state.workspace_lease.workspace_claims = normalizeStoredWorkspaceClaims(state.workspace_lease.workspace_claims ?? state.workspace_claims);
  if (!state.nodes || typeof state.nodes !== 'object' || Array.isArray(state.nodes) || !Object.keys(state.nodes).length) throw new ControllerError('Cannot release workspace lease: task nodes are unreadable or empty');
  const unknownNodes = Object.values(state.nodes).filter(node => !node || typeof node !== 'object' || ![PENDING, RUNNING, ...TERMINAL].includes(node.status));
  if (unknownNodes.length) throw new ControllerError('Cannot release workspace lease while node statuses are unknown');
  const running = Object.values(state.nodes).filter(node => node.status === RUNNING).map(node => node.id);
  if (running.length) throw new ControllerError(`Cannot release workspace lease while nodes are running: ${running.join(', ')}`);
  if (!closeAllowed) trueValue(parameters.previous_agent_stopped, 'previous_agent_stopped');
}

async function removeReleasedWorkspaceLeaseEntry(state, filePath) {
  const leasePath = state.workspace_lease?.registry_path;
  if (typeof leasePath !== 'string') throw new ControllerError('Cannot remove workspace lease entry without a registry path');
  return withWorkspaceLeaseLock(state.workspace, (lockedLeasePath, authorityContext) => {
    if (lockedLeasePath !== leasePath) throw new ControllerError('Workspace lease authority path changed while removing a released entry');
    const lease = authorityContext.lease;
    const peerOwners = workspaceLeasePeerOwners(lease, state, filePath);
    if (peerOwners.length) throw new ControllerError(`Cannot release workspace lease: state path belongs to another active task identity: ${peerOwners[0].task_id} (${peerOwners[0].state_path})`);
    const matchingEntries = workspaceLeaseStatePathOwners(lease, filePath)
      .filter(entry => workspaceLeaseEntryMatches(entry, state, filePath, { activeOnly: false }));
    if (!matchingEntries.length) return { removed: false, lease_path: leasePath };
    authorityContext.lease.active_tasks = authorityContext.lease.active_tasks.filter(entry => !workspaceLeaseEntryMatches(entry, state, filePath, { activeOnly: false }));
    authorityContext.lease.active_locks = authorityContext.lease.active_locks.filter(lock => !sameStatePath(lock.state_path, filePath));
    authorityContext.lease.updated_at = utcNow();
    return { removed: true, lease_path: leasePath };
  }, { allowAuthorityCreation: false });
}

async function releaseWorkspaceLease(parameters, { closeAllowed = false } = {}) {
  const filePath = await configuredStatePath(parameters, requiredString(parameters.task_id, 'task_id'));
  const initialState = normalizeState(await loadState(filePath));
  const stateLease = initialState.workspace_lease;
  if (!stateLease) return { released: false, reason: 'current task has no workspace lease' };
  if (!stateLease || typeof stateLease !== 'object' || typeof initialState.workspace !== 'string' || !path.isAbsolute(initialState.workspace)
    || typeof stateLease.registry_path !== 'string' || !path.isAbsolute(stateLease.registry_path)
    || path.resolve(stateLease.registry_path) !== workspaceLeasePath(initialState.workspace)
    || !sameStatePath(stateLease.state_path, filePath)) throw new ControllerError('Cannot release workspace lease: lease metadata is not a complete matching registry');
  assertReleaseStateCanBeReleased(initialState, { closeAllowed, parameters });
  const alreadyReleased = initialState.workspace_lease.status === 'released';
  if (!alreadyReleased) {
    await withActiveWorkspaceStateLock(filePath, async state => {
      assertReleaseStateCanBeReleased(state, { closeAllowed, parameters });
      state.workflow_revision ??= 0;
      state.events ??= [];
      state.updated_at = utcNow();
      state.workspace_lease.workspace_claims ??= state.workspace_claims;
      state.workspace_lease.status = 'released';
      state.workspace_lease.released_at = utcNow();
      addEvent(state, 'workspace_lease_released', { close_allowed: closeAllowed });
    });
  }
  const releasedState = normalizeState(await loadState(filePath));
  if (releasedState.workspace_lease?.status !== 'released') throw new ControllerError(`Cannot release workspace lease with unsupported task status: ${releasedState.workspace_lease?.status}`);
  const removal = await removeReleasedWorkspaceLeaseEntry(releasedState, filePath);
  return publicReleasedWorkspaceLease(filePath, {
    alreadyReleased,
    selfHealed: alreadyReleased && removal.removed,
  });
}

async function initTask(parameters) {
  const manifest = await readManifest(parameters.manifest);
  const state = await makeState(manifest);
  const filePath = await configuredStatePath(parameters, state.task_id);
  assertStateDirectoryBoundary(state.workspace, path.dirname(filePath));
  const leasePath = workspaceLeasePath(state.workspace);
  const parentAuthority = await snapshotLogicalStateNamespace(path.dirname(filePath), state.workspace);
  await verifyRegularDirectorySnapshot(parentAuthority, 'Controller state parent');
  if (await stateExists(filePath)) throw new ControllerError(`Task already exists: ${state.task_id}`);
  await ensureGlobalNamespaceIdentity(path.dirname(filePath), parentAuthority);
  state.workspace_lease = { registry_path: leasePath, state_path: filePath, task_key: taskKey(filePath), state_parent_authority: parentAuthority, status: 'active', acquired_at: utcNow(), workspace_claims: state.workspace_claims };
  const entry = { task_id: state.task_id, task_key: taskKey(filePath), state_path: filePath, state_dir: path.dirname(filePath), state_parent_authority: parentAuthority, acquired_at: state.workspace_lease.acquired_at, phase: 'initializing', workspace_claims: state.workspace_claims };

  await withWorkspaceLeaseLock(state.workspace, async (lockedLeasePath, authorityContext) => {
    if (lockedLeasePath !== leasePath) throw new ControllerError('Workspace lease authority path changed during initialization');
    const lease = authorityContext.lease;
    if (lease.active_tasks.length >= MAX_WORKSPACE_ACTIVE_TASKS) throw new ControllerError(`Workspace lease exceeds the ${MAX_WORKSPACE_ACTIVE_TASKS}-active-task limit`);
    const existingStatePath = lease.active_tasks.find(entry => entry.task_key === taskKey(filePath));
    if (existingStatePath) throw new ControllerError(`Workspace state path already has an active lease entry: ${filePath}; reconcile this exact workspace/task/state_dir entry before initializing again`);
    lease.active_tasks.push(entry);
    lease.updated_at = utcNow();
  }, { allowAuthorityCreation: true, stateDirectory: path.dirname(filePath) });

  try {
    await writeState(filePath, state, { parentAuthority });
  } catch (writeError) {
    try {
      await withWorkspaceLeaseLock(state.workspace, async (lockedLeasePath, authorityContext) => {
        if (lockedLeasePath !== leasePath) throw new ControllerError('Workspace lease authority path changed while rolling back initialization');
        authorityContext.lease.active_tasks = authorityContext.lease.active_tasks.filter(candidate => !workspaceLeaseEntryMatches(candidate, state, filePath, { activeOnly: false }));
        authorityContext.lease.active_locks = authorityContext.lease.active_locks.filter(lock => !workspaceWriteLockMatchesEntry(lock, entry));
        authorityContext.lease.updated_at = utcNow();
      }, { allowAuthorityCreation: false });
    } catch (cleanupError) {
      const wrapped = new ControllerError(`Task state initialization failed and its initializing workspace entry could not be removed; run workflow_reconcile: ${writeError.message}; cleanup failed: ${cleanupError.message}`);
      wrapped.cause = writeError;
      throw wrapped;
    }
    throw writeError;
  }

  try {
    await withWorkspaceLeaseLock(state.workspace, async (lockedLeasePath, authorityContext) => {
      if (lockedLeasePath !== leasePath) throw new ControllerError('Workspace lease authority path changed while activating initialization');
      const reservedEntry = authorityContext.lease.active_tasks.find(candidate => workspaceLeaseEntryMatches(candidate, state, filePath, { activeOnly: false }));
      if (!reservedEntry) throw new ControllerError(`Initializing workspace lease disappeared: ${leasePath}`);
      if (reservedEntry.phase !== 'initializing' && reservedEntry.phase !== 'active') throw new ControllerError(`Initializing workspace lease has an unsupported phase: ${reservedEntry.phase}`);
      reservedEntry.phase = 'active';
      authorityContext.lease.updated_at = utcNow();
    }, { allowAuthorityCreation: false });
  } catch (activationError) {
    const wrapped = new ControllerError(`Task state was written but workspace activation did not commit; run workflow_reconcile: ${activationError.message}`);
    wrapped.cause = activationError;
    throw wrapped;
  }
  const storage = publicTaskStoreReference(filePath);
  return { ...storage, task: compactState(state) };
}

async function reconcileWorkspace(parameters) {
  const workspace = await canonicalWorkspace(parameters.workspace);
  const leasePath = workspaceLeasePath(workspace);
  return withWorkspaceLeaseLock(workspace, async (lockedLeasePath, authorityContext) => {
    if (lockedLeasePath !== leasePath) throw new ControllerError('Workspace lease authority path changed during reconciliation');
    const lease = await loadWorkspaceLease(leasePath, workspace, { authorityContext });
    let candidates = lease.active_tasks.filter(entry => entry.phase === 'initializing');
    let requestedReference = null;
    if (parameters.task_id !== undefined || parameters.state_dir !== undefined) {
      const taskId = requiredString(parameters.task_id, 'task_id'); const stateDir = await canonicalStateDirectory(parameters.state_dir);
      requestedReference = publicTaskStoreReference(statePath(stateDir, taskId));
      candidates = candidates.filter(entry => entry.task_id === taskId && sameStatePath(entry.state_dir, stateDir));
      if (!candidates.length) return { workspace, ...requestedReference, reconciled: false, reason: 'target initializing task is absent' };
    }
    if (!candidates.length) {
      const databasePath = globalWorkflowStorePath();
      return { workspace, state_path: databasePath, database_path: databasePath, reconciled: false, reason: 'no initializing task' };
    }
    if (candidates.length !== 1) throw new ControllerError('reconcile-workspace requires workspace, task_id, and state_dir when multiple initializing tasks exist');
    const entry = candidates[0];
    const entryReference = publicTaskStoreReference(entry.state_path);
    const parentAuthority = entry.state_parent_authority;
    if (parentAuthority === undefined) throw new ControllerError(`Initializing workspace lease parent authority is missing; controlled recovery is required: ${leasePath}`);
    if (!validStateParentAuthority(parentAuthority, entry.state_path)) throw new ControllerError(`Invalid workspace lease state parent authority: ${leasePath}`);
    await verifyRegularDirectorySnapshot(parentAuthority, 'Controller state parent');
    return withVerifiedStateParent(entry.state_path, async () => {
      let state;
      try { state = normalizeState(await loadState(entry.state_path)); }
      catch (error) {
        if (error instanceof ControllerError && error.message.startsWith('Current SQLite controller state does not exist:')) {
          lease.active_tasks = lease.active_tasks.filter(candidate => candidate !== entry); lease.updated_at = utcNow(); await writeWorkspaceLeaseRegistry(authorityContext, leasePath, lease);
          return { workspace, ...entryReference, reconciled: true, action: 'cleared_missing_initialization', task_id: entry.task_id, state_dir: entry.state_dir };
        }
        throw error;
      }
      if (state.task_id !== entry.task_id || state.workspace !== workspace || state.workspace_lease?.registry_path !== leasePath || !sameStatePath(state.workspace_lease?.state_path, entry.state_path) || state.workspace_lease?.acquired_at !== entry.acquired_at || !sameJson(stateWorkspaceClaims(state), entry.workspace_claims)) throw new ControllerError(`Initializing workspace lease does not match its task state: ${leasePath}`);
      const stateParentAuthority = await stateParentAuthorityForState(state, entry.state_path);
      if (!sameStateParentAuthority(stateParentAuthority, parentAuthority)) throw new ControllerError(`Initializing task state parent authority changed: ${entry.state_path}`);
      await attachStateParentAuthority(state, entry.state_path, parentAuthority);
      if (state.workspace_lease.status === 'released') {
        lease.active_tasks = lease.active_tasks.filter(candidate => candidate !== entry); lease.updated_at = utcNow(); await writeWorkspaceLeaseRegistry(authorityContext, leasePath, lease);
        return { workspace, ...entryReference, reconciled: true, action: 'cleared_released_initialization', task_id: entry.task_id, state_dir: entry.state_dir };
      }
      if (state.workspace_lease.status !== 'active') throw new ControllerError(`Initializing task state has unsupported lease status: ${state.workspace_lease.status}`);
      entry.phase = 'active'; lease.updated_at = utcNow(); await writeWorkspaceLeaseRegistry(authorityContext, leasePath, lease);
      return { workspace, ...entryReference, reconciled: true, action: 'activated_existing_initialization', active_task: { task_id: entry.task_id, task_key: publicTaskKey(entry.state_path), phase: entry.phase, workspace_claims: entry.workspace_claims } };
    }, { parentAuthority });
  }, { allowAuthorityCreation: false });
}

async function addNode(parameters) {
  void parameters;
  throw new ControllerError('Task DAG is immutable after workflow_init; create a replacement workflow task for additional work');
}

async function raiseAssurance(parameters) {
  const [filePath, currentState] = await readTask(parameters);
  const rawAssessment = await readWorkflowJson(parameters.assurance_assessment, { label: 'Assurance assessment', maxBytes: MAX_REVIEW_BYTES, workspace: currentState.workspace, objectOnly: true });
  const nextAssessment = assuranceAssessment(rawAssessment);
  const targetLevel = requiredString(parameters.target_assurance_level, 'target_assurance_level');
  const reason = requiredString(parameters.reason, 'reason');
  const replacement = requiredString(parameters.replacement_agent_task_path, 'replacement_agent_task_path');
  const integrationOwner = requiredString(parameters.integration_owner, 'integration_owner');
  return withActiveWorkspaceStateLock(filePath, async state => {
    if (state.routing_schema_version !== REVIEW_PROTOCOL_VERSION) throw new ControllerError('Only a v3 task can raise assurance_level');
    if (state.assurance_level !== 'terra' || targetLevel !== 'sol') throw new ControllerError('A v3 assurance level can only be raised from terra to sol');
    requireAssuranceLevelMatches(targetLevel, nextAssessment, 'target_assurance_level');
    if (state.reviews.length || state.repair_records.length) {
      throw new ControllerError('assurance_level can only be raised before the terminal assurance gate starts');
    }
    if (participantPaths(state).has(replacement)) throw new ControllerError('The raised assurance gate reviewer must not be a prior participant');
    if (Object.values(state.nodes).some(node => node.execution_owner === replacement)) {
      throw new ControllerError(`replacement_agent_task_path is already reserved by another node: ${replacement}`);
    }

    const priorLevel = state.assurance_level;
    const priorAssessment = state.assurance_assessment;
    const reviewNode = reviewNodesForState(state)[0];
    if (!reviewNode || reviewNode.kind !== QUALITY_REVIEW_KIND || reviewNode.status !== PENDING || reviewNode.claim_id || reviewNode.attempt !== 0) {
      throw new ControllerError('Terra assurance can only be raised before its terminal review gate is claimed');
    }
    applyProtocolStage(reviewNode, 'sol_high');
    state.review_entry_stage = 'sol_high';
    reviewNode.execution_owner = replacement;
    reviewNode.integration_owner = integrationOwner;
    reviewNode.routing_reason = reason;

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
  const fingerprintPreflight = await prepareWorkspaceFingerprint(filePath);
  return withActiveWorkspaceStateLock(filePath, async state => {
    const fingerprint = workspaceFingerprintFromPreflight(state, fingerprintPreflight, 'Review gate invalidation');
    const invalidationReasons = gateInvalidationReasons(await closeReasons(state, { workspaceFingerprint: fingerprint }));
    if (!invalidationReasons.length) throw new ControllerError('The terminal assurance gate is not invalidated by a task or workspace change');
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
    if (node.execution_risk === 'delegable' && !LUNA_EXECUTOR_ROLES.has(role) && role !== PROTECTED_EXECUTOR_ROLE && !(node.rescue_role === ROOT_RESCUE_ROLE && role === ROOT_RESCUE_ROLE)) throw new ControllerError('A delegable node requires a Luna executor, avsp_terra_high, or an explicit main/root rescue');
    if (LUNA_EXECUTOR_ROLES.has(role)) {
      if (node.execution_risk !== 'delegable') throw new ControllerError('A Luna executor requires delegable routing metadata');
      if (node.execution_owner !== taskPath) throw new ControllerError('Luna executor claim must match node execution_owner');
    }
    if (!cohortNode && node.execution_owner !== taskPath) throw new ControllerError('Node claim must match execution_owner');
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
  const completionEvent = [...state.events].reverse().find(event => (event.type === 'node_completed' || event.type === 'terra_cohort_lane_completed') && event.node_id === review.node_id && event.claim_id === review.claim_id);
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
  return globalWorkflowArtifactPath(path.resolve(parameters.state_dir), parameters.task_id, parameters.claim_id, 'outcome.json');
}

async function prepareWorkflowArtifactAuthority(parameters) {
  const stateDir = await canonicalStateDirectory(parameters.state_dir, 'workflow artifact state_dir');
  const targetDirectory = path.dirname(workflowArtifactResultPath({ ...parameters, state_dir: stateDir }));
  const root = path.resolve(globalWorkflowArtifactRoot());
  await fs.mkdir(root, { recursive: true });
  const rootMetadata = await fs.lstat(root, { bigint: true });
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) throw new ControllerError(`Global workflow artifact root is unsafe: ${root}`);
  const rootRealPath = await fs.realpath(root);
  const relative = path.relative(root, targetDirectory);
  const segments = relative.split(path.sep).filter(Boolean);
  if (!segments.length || segments.some(segment => segment === '.' || segment === '..' || segment.includes('\0'))) throw new ControllerError(`Global workflow artifact path escapes its root: ${targetDirectory}`);
  const directories = [{ path: root, real_path: rootRealPath, identity: workspaceDirectoryIdentity(rootMetadata) }];
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    try { await fs.mkdir(current); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const metadata = await fs.lstat(current, { bigint: true });
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new ControllerError(`Workflow artifact directory must not contain a symbolic link or reparse point: ${current}`);
    const realPath = await fs.realpath(current);
    if (!pathIsWithinPhysicalRoot(rootRealPath, realPath)) throw new ControllerError(`Workflow artifact directory escapes the global artifact root: ${current}`);
    directories.push({ path: current, real_path: realPath, identity: workspaceDirectoryIdentity(metadata) });
  }
  return { version: 1, platform: process.platform, root_real_path: rootRealPath, target_directory: targetDirectory, target_real_path: directories.at(-1).real_path, directories };
}

async function validateWorkflowArtifactAuthority(authority, parameters, { resultMustExist = true, resultSnapshot = null } = {}) {
  const fields = new Set(['version', 'platform', 'root_real_path', 'target_directory', 'target_real_path', 'directories']);
  if (!hasExactFields(authority, fields) || authority.version !== 1 || authority.platform !== process.platform || !Array.isArray(authority.directories) || authority.directories.length !== 4) throw new ControllerError('Workflow artifact authority is missing or unsupported');
  const stateDir = await canonicalStateDirectory(parameters.state_dir, 'workflow artifact state_dir');
  const resultPath = workflowArtifactResultPath({ ...parameters, state_dir: stateDir });
  const root = path.resolve(globalWorkflowArtifactRoot());
  const targetDirectory = path.dirname(resultPath);
  const relative = path.relative(root, targetDirectory);
  const segments = relative.split(path.sep).filter(Boolean);
  const expectedDirectories = [root];
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    expectedDirectories.push(current);
  }
  if (segments.length !== 3) throw new ControllerError('Workflow artifact authority does not match the active global artifact directory');
  const rootRealPath = await fs.realpath(root);
  const targetRealPath = await fs.realpath(targetDirectory);
  if (!sameStatePath(authority.root_real_path, rootRealPath) || !sameStatePath(authority.target_directory, targetDirectory) || !sameStatePath(authority.target_real_path, targetRealPath)) throw new ControllerError('Workflow artifact authority does not match the active global artifact directory');
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
  throw new ControllerError('A total_review completion intent is missing the current result_digest');
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
  const resultPath = workflowArtifactResultPath(parameters);
  await atomicWrite(resultPath, finalized, MAX_NODE_RESULT_BYTES, { parentAuthority: await workflowArtifactTargetAuthority(finalized.workflow_artifact_authority, parameters) });
  const finalizedSnapshot = await readJsonSnapshot(resultPath, { label: 'Workflow outcome', maxBytes: MAX_NODE_RESULT_BYTES });
  if (!sameJson(finalizedSnapshot.value, finalized)) throw new ControllerError(`Workflow outcome changed after finalization: ${resultPath}`);
  await validateWorkflowArtifactAuthority(finalized.workflow_artifact_authority, parameters, { resultSnapshot: finalizedSnapshot });
  Object.assign(result, finalized);
  return workflowCompletion;
}

function workflowCompletionIntentMatches(intent, parameters, status, completionAttestation) {
  return Boolean(
    intent && typeof intent === 'object' && !Array.isArray(intent)
    && intent.claim_id === parameters.claim_id && intent.task_id === parameters.task_id && intent.node_id === parameters.node_id
    && intent.status === status && intent.completion_attestation === completionAttestation
    && typeof intent.result_path === 'string' && path.resolve(intent.result_path) === path.resolve(workflowArtifactResultPath(parameters)),
  );
}

function expectedCompletionAttestation(node, activeClaim, status, supplied) {
  return node.rescue_role === ROOT_RESCUE_ROLE && activeClaim.agent_role === ROOT_RESCUE_ROLE
    ? ROOT_RESCUE_SELF_COMPLETION
    : node.kind === 'total_review' && status === 'unavailable' && [NATIVE_AGENT_EXIT_CONFIRMED, NATIVE_AGENT_START_FAILED].includes(supplied)
      ? supplied
      : NATIVE_AGENT_FINISHED;
}

async function completeNode(parameters) {
  const status = String(parameters.status); if (!COMPLETABLE.has(status)) throw new ControllerError(`Completion status must be one of: ${[...COMPLETABLE].sort().join(', ')}`);
  const [filePath, initialState] = await readTask(parameters);
  const resultInput = parameters.result;
  const resultIsPath = typeof resultInput === 'string' && !resultInput.trim().startsWith('{') && !resultInput.trim().startsWith('[')
    && (() => { try { JSON.parse(resultInput.trim()); return false; } catch { return true; } })();
  let resultSnapshot = null;
  let result;
  if (resultIsPath) {
    await rejectWorkspaceLocalJsonPath(resultInput, initialState.workspace, 'Node result');
    resultSnapshot = await readJsonSnapshot(resultInput, { label: 'Node result', maxBytes: MAX_NODE_RESULT_BYTES });
    await verifyJsonSnapshot(resultInput, resultSnapshot, 'Node result');
    result = resultSnapshot.value;
  } else {
    result = await readWorkflowJson(resultInput, { label: 'Node result', maxBytes: MAX_NODE_RESULT_BYTES, workspace: initialState.workspace });
  }
  let activeResultSnapshot = resultSnapshot;
  const nodeId = requiredIdentifier(parameters.node_id, 'node_id');
  const fingerprintPreflight = initialState.nodes[nodeId] && isCohortReviewNode(initialState, initialState.nodes[nodeId])
    ? await prepareWorkspaceFingerprint(filePath)
    : null;
  let totalReviewPreparation = null;
  if (initialState.nodes[nodeId]?.kind === 'total_review') {
    const initialNode = initialState.nodes[nodeId];
    const initialActiveClaim = initialNode.claim_id === parameters.claim_id ? initialNode : null;
    if (!initialActiveClaim) throw new ControllerError('Node claim is no longer active');
    const expectedAttestation = expectedCompletionAttestation(initialNode, initialActiveClaim, status, parameters.completion_attestation);
    const canonicalResultPath = workflowArtifactResultPath(parameters);
    if (hasWorkflowOutcomeMarker(result)) {
      if (resultIsPath && !sameStatePath(parameters.result, canonicalResultPath)) throw new ControllerError(`A workflow-bound total_review result must be exactly ${canonicalResultPath}`);
      const artifactSnapshot = resultIsPath
        ? resultSnapshot
        : await readJsonSnapshot(canonicalResultPath, { label: 'Workflow outcome', maxBytes: MAX_NODE_RESULT_BYTES });
      if (!sameJson(artifactSnapshot.value, result)) throw new ControllerError(`Workflow outcome does not match the supplied result: ${canonicalResultPath}`);
      await validateWorkflowArtifactAuthority(result.workflow_artifact_authority, parameters, { resultSnapshot: artifactSnapshot });
      activeResultSnapshot = artifactSnapshot;
      parameters = { ...parameters, result: canonicalResultPath };
    } else {
      const artifactAuthority = await prepareWorkflowArtifactAuthority(parameters);
      parameters = { ...parameters, result: canonicalResultPath };
      result = addWorkflowOutcomeEnvelope(result, parameters, artifactAuthority);
      await atomicWrite(parameters.result, result, MAX_NODE_RESULT_BYTES, { parentAuthority: await workflowArtifactTargetAuthority(artifactAuthority, parameters) });
      activeResultSnapshot = await readJsonSnapshot(parameters.result, { label: 'Workflow outcome', maxBytes: MAX_NODE_RESULT_BYTES });
      if (!sameJson(activeResultSnapshot.value, result)) throw new ControllerError(`Workflow outcome changed after normalization: ${parameters.result}`);
      await validateWorkflowArtifactAuthority(artifactAuthority, parameters, { resultSnapshot: activeResultSnapshot });
    }
    const pending = await isPendingWorkflowOutcome(result, parameters, initialNode, activeResultSnapshot);
    const finalized = !pending && await isFinalizedWorkflowOutcome(result, parameters, initialNode, status, expectedAttestation, activeResultSnapshot);
    totalReviewPreparation = { parameters, result, activeResultSnapshot, pending, finalized, expectedAttestation, initialNode };
  }
  const completed = await withActiveWorkspaceStateLock(filePath, async state => {
    const node = state.nodes[nodeId]; const activeClaim = activeClaimForOperation(state, node, parameters); const cohortNode = isCohortReviewNode(state, node);
    if (!activeClaim.activation_at || activeClaim.heartbeat_count < 1) throw new ControllerError('An unactivated node cannot be completed; the claiming agent must first call workflow_heartbeat or workflow_start');
    const expectedAttestation = expectedCompletionAttestation(node, activeClaim, status, parameters.completion_attestation);
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
          cohort.aggregate = { source_review_claim_id: `cohort:${cohort.round_id}`, verdict, findings, review_claim_ids: finalReviews.map(review => review.claim_id), workspace_fingerprint: workspaceFingerprintFromPreflight(state, fingerprintPreflight, 'Terra cohort completion'), completed_at: utcNow(), history_digest: protocolReviewHistoryDigest(state) };
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
    if (reviewNode) {
      const recordedReview = state.reviews.find(review => review.node_id === node.id && review.claim_id === node.claim_id);
      if (!recordedReview) throw new ControllerError('A non-cohort review node requires a recorded review for its active claim');
      if (recordedReview) {
        const expectedStatus = recordedReview.verdict === 'pass' ? SUCCEEDED : recordedReview.verdict === 'fail' ? 'failed' : recordedReview.verdict === 'unavailable' ? 'unavailable' : null;
        if (status !== expectedStatus) throw new ControllerError('Non-cohort review completion status must match the recorded review verdict');
      }
    }
    let workflowOutcomeCompletion = null;
    if (node.kind === 'total_review') {
      if (!totalReviewPreparation) throw new ControllerError('Total review completion preparation is missing');
      ({ result, activeResultSnapshot } = totalReviewPreparation);
      if (node.workflow_completion_intent && !workflowCompletionIntentMatches(node.workflow_completion_intent, parameters, status, expectedAttestation)) {
        throw new ControllerError('A total_review completion is already pending for a different result, claim, or status');
      }
      if (totalReviewPreparation.pending) {
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
        return { __workflow_finalize: true };
      } else if (totalReviewPreparation.finalized) {
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
      if (reviewNode && isMaxClosureNode(state, node)) rollbackMaxClosureAttempt(state, node, node.claim_id, 'unavailable');
    }
    // A max closure failure is terminal for its reviewer but deliberately
    // blocked for the task until the chartered protected repair is recorded.
    if (reviewNode && isMaxClosureNode(state, node) && status === SUCCEEDED) {
      state.max_review_charter.status = 'closure_passed';
      state.max_review_charter.pending_repair_source_claim_id = null;
      state.max_review_charter.active_closure_claim_id = null;
      delete state.max_review_charter.pending_closure_verdict;
      delete state.max_review_charter.pending_closure_claim_id;
      addEvent(state, 'max_review_closure_passed', { node_id: node.id, claim_id: node.claim_id });
    }
    if (reviewNode && isMaxClosureNode(state, node) && status === 'failed') {
      state.max_review_charter.status = 'scope_decision_required';
      state.max_review_charter.scope_decision_required = true;
      state.max_review_charter.pending_repair_source_claim_id = null;
      state.max_review_charter.active_closure_claim_id = null;
      delete state.max_review_charter.pending_closure_verdict;
      delete state.max_review_charter.pending_closure_claim_id;
      addEvent(state, 'max_review_terminal_failure', { node_id: node.id, claim_id: node.claim_id });
    }
    const maxClosureFailure = reviewNode && isMaxClosureNode(state, node) && status === 'failed';
    const maxScopeDecision = maxClosureFailure;
    node.status = maxClosureFailure || maxScopeDecision ? 'blocked' : status; node.result = result;
    if (reviewNode) addEvent(state, 'node_completed', { node_id: nodeId, claim_id: node.claim_id, status, completion_attestation: expectedAttestation });
    else bumpWorkflowRevision(state, 'node_completed', { node_id: nodeId, status, completion_attestation: expectedAttestation });
    await writeState(filePath, state);
    return { task_id: state.task_id, assurance_level: state.assurance_level, effective_assurance_level: effectiveAssuranceLevel(state), node, ready_nodes: readyNodes(state), workflow_outcome_completion: workflowOutcomeCompletion };
  });
  if (completed?.__workflow_finalize) {
    await finalizeWorkflowOutcome(totalReviewPreparation.result, totalReviewPreparation.parameters, totalReviewPreparation.initialNode, status, totalReviewPreparation.expectedAttestation, totalReviewPreparation.activeResultSnapshot);
    return completeNode(totalReviewPreparation.parameters);
  }
  return completed;
}

async function heartbeatNode(parameters) {
  const [filePath] = await readTask(parameters); const nodeId = requiredIdentifier(parameters.node_id, 'node_id');
  return withActiveWorkspaceStateLock(filePath, async state => {
    const node = state.nodes[nodeId]; const active = activeClaimForOperation(state, node, parameters);
    const now = utcNow(); active.activation_at ??= now; active.activation_deadline_at = null; active.heartbeat_at = now; active.heartbeat_count += 1; state.updated_at = now; await writeState(filePath, state);
    return { task_id: state.task_id, node };
  }, { cursorRelevant: false });
}

async function checkpointNode(parameters) {
  const [filePath, currentState] = await readTask(parameters);
  const checkpoint = await readWorkflowJson(parameters.checkpoint, { label: 'Node checkpoint', maxBytes: MAX_CHECKPOINT_BYTES, workspace: currentState.workspace, objectOnly: true });
  const nodeId = requiredIdentifier(parameters.node_id, 'node_id');
  return withActiveWorkspaceStateLock(filePath, async state => {
    const node = state.nodes[nodeId]; const active = activeClaimForOperation(state, node, parameters);
    active.checkpoint = checkpoint; active.checkpoint_at = utcNow(); active.activation_at ??= active.checkpoint_at; active.activation_deadline_at = null; active.heartbeat_at = active.checkpoint_at; active.heartbeat_count += 1; state.updated_at = active.checkpoint_at; await writeState(filePath, state);
    return { task_id: state.task_id, node_id: nodeId, checkpoint_at: active.checkpoint_at };
  }, { cursorRelevant: false });
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
  if (Object.values(state.nodes).some(candidate => candidate.id !== node.id && candidate.execution_owner === replacement)) throw new ControllerError(`replacement_agent_task_path is already reserved by another node: ${replacement}`);
  return replacement;
}

function rebindExecutionOwner(node, replacement) {
  const priorExecutionOwner = node.execution_owner;
  node.execution_owner = replacement;
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
    rollbackMaxClosureAttempt(state, node, claimId, 'stale_requeue');
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
    if (!LUNA_EXECUTOR_ROLES.has(node.agent_role)) throw new ControllerError('Only a Luna executor attempt can be rescued by main/root');
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
    rollbackMaxClosureAttempt(state, node, node.claim_id, 'abandoned');
    node.status = 'abandoned'; node.workflow_completion_intent = null; node.result = { summary: 'Node abandoned after explicit reconciliation.', reason, abandoned_at: utcNow(), claim_id: node.claim_id };
    if (node.kind === 'total_review') addEvent(state, 'node_abandoned', { node_id: nodeId, claim_id: node.claim_id, reason, previous_agent_stopped: true });
    else bumpWorkflowRevision(state, 'node_abandoned', { node_id: nodeId, claim_id: node.claim_id, reason, previous_agent_stopped: true });
    await writeState(filePath, state);
    return { task_id: state.task_id, node };
  });
}

async function retryNode(parameters) {
  const [filePath, initialState] = await readTask(parameters); const nodeId = requiredIdentifier(parameters.node_id, 'node_id'); const reason = requiredString(parameters.reason, 'reason'); retryConfirmation(parameters);
  const initialNode = initialState.nodes[nodeId];
  const initialNextRoute = initialNode && isReviewNode(initialNode, initialState.routing_schema_version) ? nextReviewRoute(initialState, initialNode) : null;
  const fingerprintPreflight = initialNode && isReviewNode(initialNode, initialState.routing_schema_version)
    && (protocolStageForNode(initialNode) === 'sol_max_initial' || initialNextRoute?.agent_type === 'avsp_sol_max')
    ? await prepareWorkspaceFingerprint(filePath)
    : null;
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
    if (reviewNode && !hasOwn(parameters, 'replacement_agent_task_path')) throw new ControllerError('A retried review node requires replacement_agent_task_path for an independent reviewer');
    const replacement = replacementExecutionOwner(state, node, parameters); const priorExecutionOwner = rebindExecutionOwner(node, replacement);
    const priorClaimId = node.claim_id; const wasTotalReview = node.kind === 'total_review'; const priorReviewRole = reviewNode ? node.agent_type : null;
    if (protocolNode) {
      const stage = protocolStageForNode(node);
      if (node.review_gate.scope_decision_required) throw new ControllerError('The final Sol/max closure requires a user scope decision; automatic retry is forbidden');
      if (node.status === 'unavailable') {
        rollbackMaxClosureAttempt(state, node, priorClaimId, 'unavailable_retry');
        clearRescueRouting(node); clearAttemptForRetry(node);
        addEvent(state, 'review_protocol_unavailable_retried', { node_id: nodeId, stage, reason, previous_agent_stopped: true });
        await writeState(filePath, state);
        return { task_id: state.task_id, assurance_level: state.assurance_level, effective_assurance_level: effectiveAssuranceLevel(state), node, ready_nodes: readyNodes(state) };
      }
      // An abandoned ordinary protocol reviewer is not an effective failed
      // review. Re-open the same stage for the already-validated independent
      // replacement; do not require a repair or escalate the gate.
      if (node.status === 'abandoned') {
        rollbackMaxClosureAttempt(state, node, priorClaimId, 'abandoned_retry');
        clearRescueRouting(node); clearAttemptForRetry(node);
        addEvent(state, 'review_protocol_abandoned_retried', { node_id: nodeId, stage, reason, previous_agent_stopped: true, replacement_agent_task_path: replacement });
        await writeState(filePath, state);
        return { task_id: state.task_id, assurance_level: state.assurance_level, effective_assurance_level: effectiveAssuranceLevel(state), node, ready_nodes: readyNodes(state) };
      }
      if (stage === 'sol_max_closure') {
        const charter = requireMaxReviewCharter(state, node);
        if (charter.scope_decision_required || charter.status === 'scope_decision_required') throw new ControllerError('The final Sol/max closure requires a user scope decision; automatic retry is forbidden');
        if (charter.status !== 'closure_ready') throw new ControllerError(`The max review charter is not ready for its only closure review: ${charter.status}`);
        rollbackMaxClosureAttempt(state, node, priorClaimId, 'retry');
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
        await freezeProtocolMaxReviewCharter(state, node, sourceReview, fingerprintPreflight);
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
      await freezeProtocolMaxReviewCharter(state, node, sourceReview, fingerprintPreflight);
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

function hasExactFields(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === fields.size && keys.every(key => fields.has(key));
}
function validTimestamp(value) { return typeof value === 'string' && Number.isFinite(Date.parse(value)); }

async function releasedLeaseEligibility(leasePath, state, filePath, authorityContext = null) {
  let lease;
  try { lease = await loadWorkspaceLease(leasePath, state.workspace, { authorityContext }); }
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
  const sourcePaths = [filePath];
  const activeOwner = await activeLeaseOwnerForSources(lease, sourcePaths, reviewSource);
  if (activeOwner) return { eligible: false, reason: `cleanup source overlaps an active workspace lease entry: ${activeOwner.task_id} (${activeOwner.state_path})` };
  return { eligible: true };
}

function reviewArtifactTaskPath(stateDir, taskId) { return globalWorkflowArtifactTaskPath(path.resolve(stateDir), taskId); }
function logicalTaskIdFromStatePath(filePath) {
  const taskId = path.basename(filePath, SQLITE_STATE_SUFFIX);
  requiredIdentifier(taskId, 'task_id');
  return taskId;
}

async function activeLeaseEntryOwnsSources(entry, sourcePaths, reviewArtifactSource) {
  const protectedPaths = [entry.state_path];
  protectedPaths.push(reviewArtifactTaskPath(entry.state_dir, entry.task_id));
  const candidates = [...sourcePaths];
  if (reviewArtifactSource !== null) candidates.push(reviewArtifactSource);
  return candidates.some(candidate => protectedPaths.some(protectedPath => statePathsOverlap(candidate, protectedPath)));
}

async function activeLeaseOwnerForSources(lease, sourcePaths, reviewArtifactSource) {
  for (const entry of lease.active_tasks) {
    if (await activeLeaseEntryOwnsSources(entry, sourcePaths, reviewArtifactSource)) return entry;
  }
  return null;
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

function authorityFromPruneClaim(claim) {
  const identity = claim?.namespace_identity;
  if (!identity || typeof identity !== 'object') throw new ControllerError('Prune claim has no namespace identity');
  return {
    path: identity.canonical_path,
    real_path: identity.real_path,
    identity: { dev: identity.dev, ino: identity.ino },
  };
}

async function pruneArtifactPath(stateDir, taskId) {
  const root = path.resolve(globalWorkflowArtifactRoot());
  const artifactPath = reviewArtifactTaskPath(stateDir, taskId);
  if (!pathIsWithinPhysicalRoot(root, artifactPath)) throw new ControllerError(`Global workflow artifact path escapes its root: ${artifactPath}`);
  try {
    const rootMetadata = await fs.lstat(root);
    if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) throw new ControllerError(`Global workflow artifact root is not a regular directory: ${root}`);
    const artifactMetadata = await fs.lstat(artifactPath);
    if (artifactMetadata.isSymbolicLink() || !artifactMetadata.isDirectory()) throw new ControllerError(`Global workflow artifact task path is not a regular directory: ${artifactPath}`);
    if (!pathIsWithinPhysicalRoot(await fs.realpath(root), await fs.realpath(artifactPath))) throw new ControllerError(`Global workflow artifact task path escapes its root: ${artifactPath}`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    return;
  }
  await fs.rm(artifactPath, { recursive: true, force: true });
}

async function processGlobalPruneClaim(claim, now = Date.now()) {
  try {
    if (claim.parse_error) {
      await failGlobalTaskPruneJob(claim, new ControllerError(`corrupt or unreadable global state is retained: ${claim.parse_error}`));
      return { task_id: claim.task_id, deleted: false, retained: true, reason: `corrupt or unreadable global state is retained: ${claim.parse_error}` };
    }
    const parentAuthority = authorityFromPruneClaim(claim);
    await verifyRegularDirectorySnapshot(parentAuthority, 'Controller state parent');
    const logicalPath = statePath(parentAuthority.path, claim.task_id);
    const state = normalizeState(claim.state);
    const storedAuthority = await stateParentAuthorityForState(state, logicalPath);
    if (!sameStateParentAuthority(storedAuthority, parentAuthority)) throw new ControllerError(`STATE_NAMESPACE_IDENTITY_CHANGED: ${parentAuthority.path}`);
    const nodesClosed = Object.values(state.nodes).every(node => [SUCCEEDED, 'skipped'].includes(node.status));
    const closedAt = Date.parse(state.closed_at ?? '');
    const fullyClosed = state.task_id === claim.task_id
      && state.workspace_lease?.status === 'released'
      && sameStatePath(state.workspace_lease?.state_path, logicalPath)
      && state.closed_revision === state.workflow_revision
      && nodesClosed
      && Number.isFinite(closedAt)
      && now - closedAt >= DEFAULT_TASK_RETENTION_DAYS * DAY_MS;
    if (!fullyClosed) {
      await failGlobalTaskPruneJob(claim, new ControllerError('task is not a fully closed released workflow revision'));
      return { task_id: claim.task_id, deleted: false, retained: true, reason: 'task is not a fully closed released workflow revision' };
    }
    const leaseEligibility = await releasedLeaseEligibility(state.workspace_lease.registry_path, state, logicalPath);
    if (!leaseEligibility.eligible) {
      await failGlobalTaskPruneJob(claim, new ControllerError(`artifact cleanup cannot be verified: ${leaseEligibility.reason}`));
      return { task_id: claim.task_id, deleted: false, retained: true, reason: `artifact cleanup cannot be verified: ${leaseEligibility.reason}` };
    }
    await pruneArtifactPath(parentAuthority.path, claim.task_id);
    await finalizeGlobalTaskPruneJob(claim);
    return { task_id: claim.task_id, deleted: true, retained: false };
  } catch (error) {
    try { await failGlobalTaskPruneJob(claim, error); }
    catch (jobError) {
      return { task_id: claim.task_id, deleted: false, retained: true, reason: `prune artifact cleanup failed: ${error.message}; retry job update failed: ${jobError.message}` };
    }
    return { task_id: claim.task_id, deleted: false, retained: true, reason: `prune artifact cleanup failed: ${error.message}` };
  }
}

async function runGlobalPruneSweep({ namespace = null, limit = 32 } = {}) {
  const claims = await claimGlobalTaskPruneJobs(new Date().toISOString(), { limit, ...(namespace ? { namespace_key: namespace } : {}) });
  const deleted = [];
  const retained = [];
  for (const claim of claims) {
    const outcome = await processGlobalPruneClaim(claim);
    if (outcome.deleted) deleted.push({ task_id: outcome.task_id });
    else retained.push({ task_id: outcome.task_id, reason: outcome.reason });
  }
  return { candidate_count: claims.length, deleted, retained };
}

async function pruneExpiredTasks(parameters) {
  const stateDir = await canonicalStateDirectory(parameters.state_dir);
  const sweep = await runGlobalPruneSweep({ namespace: stateDir });
  return {
    state_dir: stateDir,
    store_path: globalWorkflowStorePath(),
    retention_days: DEFAULT_TASK_RETENTION_DAYS,
    deleted_count: sweep.deleted.length,
    retained_count: sweep.retained.length,
    deleted: sweep.deleted,
    retained: sweep.retained,
  };
}

async function bindDueNamespaceIdentities(pruneDueBefore) {
  const candidates = await listGlobalTaskPruneCandidates(pruneDueBefore);
  const errors = [];
  const seen = new Set();
  for (const candidate of candidates) {
    if (seen.has(candidate.namespace_key)) continue;
    seen.add(candidate.namespace_key);
    const logicalPath = statePath(candidate.namespace_key, candidate.task_id);
    try {
      const state = normalizeState(await readTaskState(logicalPath));
      const authority = await stateParentAuthorityForState(state, logicalPath);
      await verifyRegularDirectorySnapshot(authority, 'Controller state parent');
      await ensureGlobalNamespaceIdentity(path.dirname(logicalPath), authority);
    } catch (error) {
      if (errors.length < MAX_PRUNE_REPORT_ENTRIES) errors.push({ namespace: candidate.namespace_key, error: error.message });
    }
  }
  return { candidate_count: candidates.length, namespace_count: seen.size, errors };
}

// MCP starts serving first. A separate worker invokes this sweep so recursive
// artifact deletion and synchronous node:sqlite calls cannot block stdio.
export async function pruneExpiredTasksAtMcpStartup({ max_batches = 8 } = {}) {
  if (!Number.isSafeInteger(max_batches) || max_batches < 1 || max_batches > 8) throw new ControllerError('max_batches must be an integer between 1 and 8');
  const pruneDueBefore = new Date().toISOString();
  const bound = await bindDueNamespaceIdentities(pruneDueBefore);
  const deleted = [];
  const retained = [];
  let processedCandidates = 0;
  for (let batch = 0; batch < max_batches; batch++) {
    const sweep = await runGlobalPruneSweep({ limit: 32 });
    processedCandidates += sweep.candidate_count;
    deleted.push(...sweep.deleted);
    retained.push(...sweep.retained);
    if (sweep.candidate_count < 32) break;
  }
  return {
    namespace_count: bound.namespace_count,
    candidate_count: Math.max(bound.candidate_count, processedCandidates),
    deleted_count: deleted.length,
    retained_count: retained.length,
    namespace_error_count: bound.errors.length,
    namespace_errors: bound.errors,
  };
}

async function auditContext(parameters) {
  const [, state] = await readTask(parameters);
  return { task_id: state.task_id, workspace_claims: state.workspace_claims, assurance_level: state.assurance_level, effective_assurance_level: effectiveAssuranceLevel(state), assurance_assessment: state.assurance_assessment, review_protocol_version: state.review_protocol_version, review_entry_stage: state.review_entry_stage, review_context: state.review_context, review_history_digest: protocolReviewHistoryDigest(state, { excludeActiveCohortPhase: true }), goal: state.goal, requirements: state.requirements, scope: state.scope, non_goals: state.non_goals, nodes: Object.values(state.nodes), participants: state.participants, reviews: externallyVisibleReviews(state), repair_records: state.repair_records, max_review_charter: state.max_review_charter ?? null, workflow_snapshot: workflowSnapshot(state), workspace_fingerprint: await workspaceFingerprint(state.workspace, state.workspace_claims) };
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

async function recordRepair(parameters) {
  const [filePath, currentState] = await readTask(parameters);
  const repair = await readWorkflowJson(parameters.repair, { label: 'Terra repair record', maxBytes: MAX_REVIEW_BYTES, workspace: currentState.workspace, objectOnly: true });
  const fingerprintPreflight = await prepareWorkspaceFingerprint(filePath);
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
      const fingerprint = workspaceFingerprintFromPreflight(state, fingerprintPreflight, 'Terra cohort repair');
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
      const fingerprint = workspaceFingerprintFromPreflight(state, fingerprintPreflight, 'Terra repair');
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
      const fingerprint = workspaceFingerprintFromPreflight(state, fingerprintPreflight, 'Sol repair');
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
      const fingerprint = workspaceFingerprintFromPreflight(state, fingerprintPreflight, 'Max repair');
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
    throw new ControllerError('A repair record requires a failed current-protocol review');
  }, { cursorRelevant: false });
}

async function recordReview(parameters) {
  const [filePath, currentState] = await readTask(parameters);
  const review = await readWorkflowJson(parameters.review, { label: 'Review', maxBytes: MAX_REVIEW_BYTES, workspace: currentState.workspace, objectOnly: true });
  const fingerprintPreflight = await prepareWorkspaceFingerprint(filePath);
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
    const fingerprint = workspaceFingerprintFromPreflight(state, fingerprintPreflight, 'Review');
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
      // Recording evidence is not the terminal action. The matching
      // workflow_complete call commits pass/fail/unavailable to the charter.
      charter.pending_closure_verdict = verdict;
      charter.pending_closure_claim_id = reviewNode.claim_id;
      if (outOfCharter.length) charter.pending_out_of_charter_findings = outOfCharter.map(finding => ({ ...finding, review_claim_id: reviewNode.claim_id, recorded_at: utcNow() }));
      else if (verdict === 'fail') charter.pending_out_of_charter_findings = blocking.map(finding => ({ ...finding, review_claim_id: reviewNode.claim_id, recorded_at: utcNow(), terminal_max_failure: true }));
      else delete charter.pending_out_of_charter_findings;
      addEvent(state, 'max_review_closure_recorded_pending_completion', { node_id: reviewNode.id, claim_id: reviewNode.claim_id, verdict });
    }
    state.reviews.push(stored); addEvent(state, reviewNode.kind === 'total_review' ? 'total_review_recorded' : 'quality_review_recorded', { auditor_task: auditor, verdict }); await writeState(filePath, state);
    return { task_id: state.task_id, assurance_level: state.assurance_level, effective_assurance_level: effectiveAssuranceLevel(state), review: stored };
  });
}

async function closeReasons(state, { workspaceFingerprint: precomputedFingerprint = null } = {}) {
  const incomplete = Object.entries(state.nodes).filter(([, node]) => ![SUCCEEDED, 'skipped'].includes(node.status)).map(([id]) => id);
  const reasons = incomplete.length ? [`incomplete nodes: ${incomplete.join(', ')}`] : [];
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
    const currentFingerprint = precomputedFingerprint ?? await workspaceFingerprint(state.workspace, state.workspace_claims);
    if (aggregate && !sameJson(aggregate.workspace_fingerprint, currentFingerprint)) reasons.push('workspace changed after Terra cohort cross-review');
    for (const review of finalReviews) {
      if (!workflowSnapshotMatchesState(review.workflow_snapshot, state)) reasons.push('task state changed after Terra cohort cross-review');
      if (!sameJson(review.workspace_fingerprint, currentFingerprint)) reasons.push('workspace changed after Terra cohort cross-review');
    }
    return reasons;
  }
  const review = state.reviews.at(-1);
  if (!review) reasons.push(reviewNode?.kind === QUALITY_REVIEW_KIND ? 'no quality_review' : 'no total review'); else {
    if (review.verdict !== 'pass') reasons.push(`latest review verdict is ${review.verdict}`);
    if (!reviewNode || review.node_id !== reviewNode.id || review.claim_id !== reviewNode.claim_id || review.auditor_task !== reviewNode.agent_task_path || review.auditor_role !== reviewNode.agent_role) reasons.push(`latest review does not belong to the succeeded ${reviewDescription} node`);
    if (!workflowSnapshotMatchesState(review.workflow_snapshot, state)) reasons.push(`task state changed after ${reviewDescription}`);
    const currentFingerprint = precomputedFingerprint ?? await workspaceFingerprint(state.workspace, state.workspace_claims);
    if (!sameJson(review.workspace_fingerprint, currentFingerprint)) reasons.push(`workspace changed after ${reviewDescription}`);
  }
  return reasons;
}

async function closeCheck(parameters) {
  const [filePath, initialState] = await readTask(parameters);
  const fingerprintPreflight = await prepareWorkspaceFingerprint(filePath);
  const storage = publicTaskStoreReference(filePath);
  if (!initialState.workspace_lease) throw new ControllerError('Current task state requires a workspace lease');
  const parentAuthority = await stateParentAuthorityForState(initialState, filePath);
  await verifyRegularDirectorySnapshot(parentAuthority, 'Controller state parent');
  const leasePath = initialState.workspace_lease.registry_path;
  if (initialState.workspace_lease.status === 'released') {
    const removal = await removeReleasedWorkspaceLeaseEntry(initialState, filePath);
    const fingerprint = workspaceFingerprintFromPreflight(initialState, fingerprintPreflight, 'Close check');
    const reasons = await closeReasons(initialState, { workspaceFingerprint: fingerprint });
    return [{
      ...storage,
      task_id: initialState.task_id,
      assurance_level: initialState.assurance_level,
      effective_assurance_level: effectiveAssuranceLevel(initialState),
      close_allowed: !reasons.length,
      reasons,
      workspace_lease: publicReleasedWorkspaceLease(filePath, { alreadyReleased: true, selfHealed: removal.removed }),
    }, reasons.length ? 2 : 0];
  }
  if (initialState.workspace_lease.status !== 'active') throw new ControllerError(`Current task has an unsupported workspace lease status: ${initialState.workspace_lease.status}`);
  let result;
  await withActiveWorkspaceStateLock(filePath, async state => {
    const fingerprint = workspaceFingerprintFromPreflight(state, fingerprintPreflight, 'Close check');
    const reasons = await closeReasons(state, { workspaceFingerprint: fingerprint });
    result = {
      ...storage,
      task_id: state.task_id,
      assurance_level: state.assurance_level,
      effective_assurance_level: effectiveAssuranceLevel(state),
      close_allowed: !reasons.length,
      reasons,
    };
    if (reasons.length) return;
    state.workspace_lease.workspace_claims ??= state.workspace_claims;
    state.workspace_lease.status = 'released';
    state.workspace_lease.released_at = utcNow();
    state.closed_revision = state.workflow_revision;
    state.closed_at = utcNow();
    addEvent(state, 'workspace_lease_released', { close_allowed: true });
  });
  if (!result.close_allowed) return [result, 2];
  const releasedState = normalizeState(await loadState(filePath));
  if (releasedState.workspace_lease?.registry_path !== leasePath || releasedState.workspace_lease.status !== 'released') throw new ControllerError('Task workspace lease changed before close release');
  await removeReleasedWorkspaceLeaseEntry(releasedState, filePath);
  result.workspace_lease = publicReleasedWorkspaceLease(filePath);
  return [result, 0];
}

export async function dispatch(command, parameters) {
  if (parameters && hasOwn(parameters, 'state_dir')) {
    parameters = { ...parameters, state_dir: await canonicalStateDirectory(parameters.state_dir) };
  }
  if (command === 'prune-expired') return [await pruneExpiredTasks(parameters), 0];
  switch (command) {
    case 'init': return [await initTask(parameters), 0]; case 'reconcile-workspace': return [await reconcileWorkspace(parameters), 0]; case 'add-node': return [await addNode(parameters), 0]; case 'raise-assurance': return [await raiseAssurance(parameters), 0]; case 'rebind-pending': return [await rebindPendingOwner(parameters), 0]; case 'invalidate-gate': return [await invalidateGate(parameters), 0];
    case 'ready': return [{ ready_nodes: readyNodes((await readTask(parameters))[1]) }, 0]; case 'claim': return [await claimNode(parameters), 0]; case 'start': return [await claimNode(parameters, true), 0];
    case 'acquire-write-lock': return [await acquireWorkspaceWriteLock(parameters), 0]; case 'release-write-lock': return [await releaseWorkspaceWriteLock(parameters), 0];
    case 'complete': {
      const result = await completeNode(parameters);
      await releaseWriteLocksAfterNodeLifecycle(parameters, 'node_completed');
      return [result, 0];
    }
    case 'heartbeat': return [await heartbeatNode(parameters), 0]; case 'checkpoint': return [await checkpointNode(parameters), 0];
    case 'abandon': {
      const result = await abandonNode(parameters);
      await releaseWriteLocksAfterNodeLifecycle(parameters, 'node_abandoned');
      return [result, 0];
    }
    case 'retry': return [await retryNode(parameters), 0];
    case 'requeue-stale': {
      const result = await requeueStaleNode(parameters);
      await releaseWriteLocksAfterNodeLifecycle(parameters, 'stale_node_requeued');
      return [result, 0];
    }
    case 'rescue': {
      const result = await rescueNode(parameters);
      await releaseWriteLocksAfterNodeLifecycle(parameters, 'root_rescue');
      return [result, 0];
    }
    case 'audit-context': return [await auditContext(parameters), 0];
    case 'record-review': return [await recordReview(parameters), 0]; case 'record-repair': return [await recordRepair(parameters), 0]; case 'close-check': return closeCheck(parameters);
    case 'release-workspace': return [await releaseWorkspaceLease(parameters), 0];
    case 'stale': {
      const [, state] = await readTask(parameters);
      return [{ task_id: state.task_id, stale_nodes: staleNodes(state), active_write_locks: await activeWorkspaceWriteLocks(state) }, 0];
    }
    case 'status': {
      const [, state] = await readTask(parameters);
      return [await compactStateWithActiveWriteLocks(state), 0];
    }
    case 'doctor': return [await doctorTask(parameters), 0]; case 'fingerprint': return [{ workspace_fingerprint: await workspaceFingerprint(parameters.workspace, parameters.workspace_claims) }, 0];
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
