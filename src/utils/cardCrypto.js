// Card data protection (PCI-DSS style). Mock issuer: these cards are not on the Visa network.
//   - PAN encrypted at rest with AES-256-GCM (random IV, auth tag): iv.tag.ciphertext (base64url)
//   - PAN fingerprint: HMAC-SHA256, to find duplicates without decrypting
//   - CVV never stored: derived on demand from PAN + expiry with a separate key (as an HSM does)
//   - masking helpers + Luhn check
const crypto = require('crypto');
const config = require('../config');

// Separate keys for encryption, fingerprinting and CVV, all derived from one master secret.
// Set CARD_ENCRYPTION_KEY in real deployments; dev falls back to a key derived from JWT_SECRET.
const master = process.env.CARD_ENCRYPTION_KEY || `${config.jwtSecret}:paypulse-card-dev-key`;
const derive = (label) => Buffer.from(crypto.hkdfSync('sha256', master, 'paypulse-cards', label, 32));
const ENCRYPTION_KEY = derive('pan-encryption');
const FINGERPRINT_KEY = derive('pan-fingerprint');
const CVV_KEY = derive('cvv-derivation');

function encryptPan(pan) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(pan, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), ciphertext].map((b) => b.toString('base64url')).join('.');
}

function decryptPan(stored) {
  const [iv, tag, ciphertext] = stored.split('.').map((part) => Buffer.from(part, 'base64url'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

const fingerprint = (pan) => crypto.createHmac('sha256', FINGERPRINT_KEY).update(pan).digest('hex');

/** 3-digit CVV derived from PAN + expiry; never stored, recomputed when the cardholder reveals it. */
function deriveCvv(pan, expiryMonth, expiryYear) {
  const mac = crypto.createHmac('sha256', CVV_KEY).update(`${pan}|${expiryMonth}|${expiryYear}`).digest();
  return String(mac.readUInt32BE(0) % 1000).padStart(3, '0');
}

/** Luhn (mod 10) check digit for the digits given. */
function luhnCheckDigit(digits) {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 0) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return String((10 - (sum % 10)) % 10);
}

function isLuhnValid(number) {
  return /^\d{12,19}$/.test(number) && luhnCheckDigit(number.slice(0, -1)) === number.slice(-1);
}

/** "4847351234567890" -> "4847 35•• •••• 7890" (first 6 + last 4, the PCI-DSS display maximum) */
function maskPan(bin, last4) {
  return `${bin.slice(0, 4)} ${bin.slice(4, 6)}•• •••• ${last4}`;
}

module.exports = { encryptPan, decryptPan, fingerprint, deriveCvv, luhnCheckDigit, isLuhnValid, maskPan };
