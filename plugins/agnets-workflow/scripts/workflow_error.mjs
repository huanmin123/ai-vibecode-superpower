const REQUIRED_FIELDS = ['code', 'provider', 'model', 'upstream_status', 'request_id', 'message'];

function errorMessage(value) {
  return value instanceof Error ? value.message : String(value);
}

/**
 * Validate a provider error without dropping provider-specific fields.
 * Unknown fields are intentionally preserved in the returned clone.
 */
export function validateProviderError(value, { fallbackModel = null } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('provider error must be an object');
  }
  for (const field of REQUIRED_FIELDS) {
    if (!(field in value)) throw new TypeError(`provider error requires ${field}`);
  }
  for (const field of ['code', 'provider', 'model', 'request_id', 'message']) {
    if (typeof value[field] !== 'string' || !value[field].trim()) throw new TypeError(`provider error ${field} must be a non-empty string`);
  }
  if (value.upstream_status !== null && (typeof value.upstream_status !== 'string' && (typeof value.upstream_status !== 'number' || !Number.isFinite(value.upstream_status)))) {
    throw new TypeError('provider error upstream_status must be a string, number, or null');
  }
  if (fallbackModel !== null && value.model !== fallbackModel) {
    throw new TypeError(`provider fallback error model must be ${fallbackModel}`);
  }
  return { ...value };
}

export function validateFallbackEvidence({ fallbackReason, fallbackError, fallbackModel = null } = {}) {
  if (fallbackReason !== undefined && fallbackReason !== null
    && (typeof fallbackReason !== 'string' || !fallbackReason.trim())) {
    throw new TypeError('fallback_reason must be a non-empty string');
  }
  if (fallbackError === undefined || fallbackError === null) return null;
  // fallback_reason is an operation summary persisted beside this raw payload;
  // never inject it into the provider's original error object.
  return validateProviderError(fallbackError, { fallbackModel });
}

export function serializeProviderError(value, options) {
  return JSON.stringify(validateProviderError(value, options));
}

export { REQUIRED_FIELDS };

if (process.argv[1] && new URL(import.meta.url).pathname.toLowerCase() === new URL(`file:///${process.argv[1].replaceAll('\\', '/')}`).pathname.toLowerCase()) {
  try {
    const input = JSON.parse(process.argv[2] ?? '');
    process.stdout.write(`${serializeProviderError(input)}\n`);
  } catch (error) {
    process.stderr.write(`workflow error invalid: ${errorMessage(error)}\n`);
    process.exitCode = 1;
  }
}
