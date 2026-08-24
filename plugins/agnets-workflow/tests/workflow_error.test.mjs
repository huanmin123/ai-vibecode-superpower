import assert from 'node:assert/strict';
import test from 'node:test';
import { serializeProviderError, validateFallbackEvidence, validateProviderError } from '../scripts/workflow_error.mjs';

const raw = { code: 'UPSTREAM_TIMEOUT', provider: 'hu', model: 'gpt-5.6-luna', upstream_status: '504', request_id: 'req-123', message: 'upstream timed out', vendor_field: 'preserve-me' };

test('accepts Luna fallback error and preserves raw fields', () => {
  const result = validateFallbackEvidence({ fallbackReason: 'configured Luna unavailable', fallbackError: raw, fallbackModel: 'gpt-5.6-luna' });
  assert.deepEqual(result, raw);
  assert.equal(Object.hasOwn(result, 'fallback_reason'), false);
  assert.equal(result.request_id, 'req-123'); assert.equal(result.message, 'upstream timed out'); assert.equal(result.vendor_field, 'preserve-me');
  assert.equal(JSON.parse(serializeProviderError(raw, { fallbackModel: 'gpt-5.6-luna' })).model, 'gpt-5.6-luna');
});

test('rejects a wrong Luna fallback model', () => {
  assert.throws(() => validateFallbackEvidence({ fallbackReason: 'unavailable', fallbackError: { ...raw, model: 'gpt-5.6-terra' }, fallbackModel: 'gpt-5.6-luna' }), /model must be gpt-5.6-luna/);
});

test('keeps legacy string fallback_reason compatible', () => {
  assert.equal(validateFallbackEvidence({ fallbackReason: 'legacy reason' }), null);
  assert.throws(() => validateProviderError({ ...raw, message: '' }), /message must be a non-empty string/);
});
