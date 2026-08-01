export function calculateOrderTotal(lines) {
  if (!Array.isArray(lines)) {
    throw new TypeError('lines must be an array');
  }

  let total = 0;
  for (const line of lines) {
    if (line === null || typeof line !== 'object') {
      throw new TypeError('each line must be a non-null object');
    }
    if (!Number.isSafeInteger(line.unitPriceCents) || line.unitPriceCents < 0) {
      throw new TypeError('unitPriceCents must be a non-negative safe integer');
    }
    if (!Number.isSafeInteger(line.quantity) || line.quantity <= 0) {
      throw new TypeError('quantity must be a positive safe integer');
    }

    total += line.unitPriceCents * line.quantity;
  }

  return total;
}
