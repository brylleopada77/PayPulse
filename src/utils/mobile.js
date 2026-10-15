const { badRequest } = require('./errors');

const MOBILE_PATTERN = /^09\d{9}$/;

/**
 * Normalise a Philippine mobile number to 09XXXXXXXXX.
 * Accepts 09171234567, +639171234567, 639171234567 and spaces/dashes in between.
 * Returns null if it is not a valid mobile number.
 */
function normalizeMobile(value) {
  if (typeof value !== 'string') return null;
  let digits = value.replace(/[\s-]/g, '');
  if (digits.startsWith('+63')) digits = `0${digits.slice(3)}`;
  else if (digits.startsWith('63') && digits.length === 12) digits = `0${digits.slice(2)}`;
  return MOBILE_PATTERN.test(digits) ? digits : null;
}

/** Like normalizeMobile, but throws INVALID_MOBILE_NUMBER (400) for a bad number. */
function requireMobile(value) {
  const mobile = normalizeMobile(value);
  if (!mobile) {
    throw badRequest('INVALID_MOBILE_NUMBER', 'Enter a valid mobile number, e.g. 09171234567');
  }
  return mobile;
}

module.exports = { normalizeMobile, requireMobile };
