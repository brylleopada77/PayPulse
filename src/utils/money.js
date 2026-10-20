const { badRequest } = require('./errors');

const MAX_AMOUNT_CENTS = 100_000_000; // 1,000,000.00 per single operation

/**
 * Convert a user-supplied amount like 25 or "25.50" into integer cents.
 * Rejects zero, negatives, more than 2 decimal places and non-numbers.
 */
function toCents(amount) {
  const text = typeof amount === 'number' ? String(amount) : amount;

  if (typeof text !== 'string' || !/^\d+(\.\d{1,2})?$/.test(text.trim())) {
    throw badRequest('INVALID_AMOUNT', 'Amount must be a positive number with at most 2 decimals');
  }

  const [whole, fraction = ''] = text.trim().split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));

  if (cents <= 0) {
    throw badRequest('INVALID_AMOUNT', 'Amount must be greater than zero');
  }
  if (cents > MAX_AMOUNT_CENTS) {
    throw badRequest('INVALID_AMOUNT', 'Amount exceeds the maximum allowed per operation');
  }
  return cents;
}

/** Format cents as a decimal string, e.g. 2550 -> "25.50". */
function fromCents(cents) {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

module.exports = { toCents, fromCents };
