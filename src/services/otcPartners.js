/**
 * Over-the-counter cash-in partners: where a customer can pay a PayPulse cash-in code in cash.
 * Each partner has a counter fee, paid by the customer on top of the amount and kept by the partner:
 *   FREE, FLAT (fixed pesos) or PERCENT (basis points of the amount, rounded to the centavo).
 * `logo` is self-hosted under public/img/otc (null: the initials badge is shown); badge colours
 * keep white initials at 4.5:1 or better.
 */
const CATEGORIES = {
  PAWNSHOP: 'Pawnshops & remittance',
  STORE: 'Convenience stores & kiosks',
  MALL: 'Malls & supermarkets',
  PHARMACY: 'Pharmacies',
};

const FREE = { type: 'FREE' };
const FLAT_15 = { type: 'FLAT', cents: 1500 };
const ONE_PERCENT = { type: 'PERCENT', bps: 100 };

const partner = (code, name, category, fee, logo, initials, color) =>
  ({ code, name, category, fee, logo: logo && `/img/otc/${logo}`, badge: { initials, color } });

const PARTNERS = [
  partner('CEBUANA', 'Cebuana Lhuillier', 'PAWNSHOP', ONE_PERCENT, 'cebuana.png', 'CL', '#1a4a8a'),
  partner('MLHUILLIER', 'M Lhuillier', 'PAWNSHOP', ONE_PERCENT, 'mlhuillier.png', 'ML', '#b3001b'),
  partner('PALAWAN', 'Palawan Express', 'PAWNSHOP', ONE_PERCENT, 'palawan.png', 'PE', '#8a5a00'),
  partner('BAYAD', 'Bayad Center', 'PAWNSHOP', FREE, 'bayad.png', 'BC', '#b34700'),
  partner('RDPAWNSHOP', 'RD Pawnshop', 'PAWNSHOP', ONE_PERCENT, null, 'RD', '#0b5d43'),
  partner('VILLARICA', 'Villarica Pawnshop', 'PAWNSHOP', ONE_PERCENT, null, 'VP', '#6d1f7a'),
  partner('TAMBUNTING', 'Tambunting', 'PAWNSHOP', ONE_PERCENT, null, 'TB', '#1d5c9c'),
  partner('7ELEVEN', '7-Eleven (CLiQQ)', 'STORE', FLAT_15, '7eleven.png', '7E', '#00704a'),
  partner('UNCLEJOHNS', "Uncle John's", 'STORE', FLAT_15, null, 'UJ', '#b3261e'),
  partner('ALFAMART', 'Alfamart', 'STORE', FLAT_15, 'alfamart.ico', 'AM', '#1a4fa0'),
  partner('PAYANDGO', 'Pay&Go / TouchPay', 'STORE', FLAT_15, null, 'PG', '#5b2a86'),
  partner('SM', 'SM Bills Payment', 'MALL', FLAT_15, 'sm.png', 'SM', '#0033a0'),
  partner('ROBINSONS', 'Robinsons Dept. Store', 'MALL', FREE, 'robinsons.jpg', 'RB', '#c8102e'),
  partner('PUREGOLD', 'Puregold', 'MALL', FLAT_15, 'puregold.png', 'PU', '#7a5c00'),
  partner('WALTERMART', 'Waltermart', 'MALL', FLAT_15, 'waltermart.webp', 'WM', '#b3003c'),
  partner('MERCURY', 'Mercury Drug', 'PHARMACY', FLAT_15, 'mercury.png', 'MD', '#c8102e'),
  partner('WATSONS', 'Watsons', 'PHARMACY', FLAT_15, 'watsons.png', 'WA', '#00707a'),
  partner('GENERIKA', 'Generika', 'PHARMACY', FLAT_15, 'generika.ico', 'GE', '#1a5c9c'),
  partner('SOUTHSTAR', 'Southstar Drug', 'PHARMACY', FLAT_15, 'southstar.png', 'SD', '#0b5fa5'),
];

/** The counter fee in centavos for this partner and amount. */
function feeCents(p, amountCents) {
  if (p.fee.type === 'FLAT') return p.fee.cents;
  if (p.fee.type === 'PERCENT') return Math.round((amountCents * p.fee.bps) / 10_000);
  return 0;
}

/** "Free", "₱15 fee", "1% fee": the short tag on a partner card. */
function feeLabel(p) {
  if (p.fee.type === 'FLAT') return `₱${p.fee.cents / 100} fee`;
  if (p.fee.type === 'PERCENT') return `${p.fee.bps / 100}% fee`;
  return 'Free';
}

const findPartner = (code) =>
  PARTNERS.find((p) => p.code === String(code ?? '').trim().toUpperCase());

module.exports = { CATEGORIES, PARTNERS, feeCents, feeLabel, findPartner };
