const { isLuhnValid } = require('../utils/cardCrypto');

// Card numbers: 13-19 digits, possibly separated by spaces or dashes.
const PAN_CANDIDATE = /\b\d(?:[ -]?\d){12,18}\b/g;

/** Replace anything that looks like a real card number (passes Luhn) with a masked form. */
function maskText(text) {
  return text.replace(PAN_CANDIDATE, (match) => {
    const digits = match.replace(/[ -]/g, '');
    if (!isLuhnValid(digits)) return match;
    return `${digits.slice(0, 6)}${'•'.repeat(digits.length - 10)}${digits.slice(-4)}`;
  });
}

function maskDeep(value) {
  if (typeof value === 'string') return maskText(value);
  if (Array.isArray(value)) return value.map(maskDeep);
  if (value instanceof Date) return value; // dates are not card data (and Object.entries would empty them)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, k === 'cvv' ? '•••' : maskDeep(v)]));
  }
  return value;
}

/**
 * PCI-DSS safety net for card endpoints: every JSON response is scanned and any full card number
 * (and any `cvv` field) is masked before it leaves the server, even if a handler made a mistake.
 * The single exception is a route that sets `res.locals.allowCardData = true` (the MPIN-protected
 * reveal). Card responses are also marked `Cache-Control: no-store`.
 */
function pciMask(req, res, next) {
  res.set('Cache-Control', 'no-store');
  res.set('Pragma', 'no-cache');
  const json = res.json.bind(res);
  res.json = (body) => json(res.locals.allowCardData ? body : maskDeep(body));
  next();
}

module.exports = { pciMask, maskText };
