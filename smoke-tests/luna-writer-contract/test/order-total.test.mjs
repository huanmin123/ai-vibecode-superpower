import assert from 'node:assert/strict';
import { calculateOrderTotal } from '../src/order-total.mjs';

assert.equal(
  calculateOrderTotal([
    { unitPriceCents: 199, quantity: 2 },
    { unitPriceCents: 450, quantity: 1 }
  ]),
  848
);
assert.equal(calculateOrderTotal([]), 0);

for (const invalidLines of [
  [{ unitPriceCents: -1, quantity: 1 }],
  [{ unitPriceCents: 100, quantity: 0 }],
  [{ unitPriceCents: 100.5, quantity: 1 }],
  [{ unitPriceCents: 100 }],
  null
]) {
  assert.throws(() => calculateOrderTotal(invalidLines), TypeError);
}

console.log('order-total contract tests passed');
