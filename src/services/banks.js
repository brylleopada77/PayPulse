// Outside banks and e-wallets PayPulse can send money to (mock: nothing is really sent).
// GCash and Maya are reached by the recipient's mobile number; banks and digital banks by an
// account number. BICs are used as the creditor agent in ISO 20022 pacs.008 messages
// (illustrative values, not a directory).

const BANK_TRANSFER_FEE_CENTS = 1500; // ₱15.00 convenience fee per bank transfer

// PayPulse's own (mock) BIC: the debtor agent in outbound messages.
const PAYPULSE_BIC = 'PAYPPHM2XXX';

// Clearing rails (Philippine payment system):
//   INSTAPAY - real-time, up to ₱50,000 per transfer, settled immediately
//   PESONET  - batch, no per-transfer cap, settled at the next batch cut-off
const RAILS = {
  INSTAPAY: { code: 'INSTAPAY', name: 'InstaPay', maxCents: 5_000_000, description: 'Instant, up to ₱50,000' },
  PESONET: { code: 'PESONET', name: 'PESONet', maxCents: null, description: 'Batch, settles at the next cut-off' },
};

// Destinations, grouped for the Bank Transfer dropdown. `rails` = the clearing networks the
// destination accepts (mock routing table): every one is on InstaPay; PESONet (batch) goes to the
// major banks only, so a PESONet transfer to an e-wallet / digital bank is refused (400
// RAIL_NOT_SUPPORTED) instead of silently rerouted.
const CATEGORIES = {
  EWALLET: 'E-wallets & digital banks',
  BANK: 'Universal & commercial banks',
};
const INSTAPAY_ONLY = ['INSTAPAY'];
const BOTH_RAILS = ['INSTAPAY', 'PESONET'];

// Avatars in the Bank Transfer picker: `logo`, the institution's icon (self-hosted in
// public/img/banks/, taken from its website favicon; trademarks of their owners, shown only to
// identify the destination), and `badge`, the fallback when there is no logo or it fails to load
// (initials on a brand-tinted colour, at least 4.5:1 against the white initials).
const LOGO_FILES = {
  GCASH: 'gcash.png', MAYA: 'maya.png', GOTYME: 'gotyme.png', MARIBANK: 'maribank.png', CIMB: 'cimb.png',
  TONIK: 'tonik.png', UNIONDIGITAL: 'uniondigital.png', KOMO: 'komo.jpg', BDO: 'bdo.png', BPI: 'bpi.png',
  METROBANK: 'metrobank.png', UNIONBANK: 'unionbank.png', SECURITYBANK: 'securitybank.png', RCBC: 'rcbc.png',
  CHINABANK: 'chinabank.ico', EASTWEST: 'eastwest.png', AUB: 'aub.png', LANDBANK: 'landbank.png',
  // PNB: no icon available (its site blocks downloads), so it shows the badge
};
const logo = (code) => (LOGO_FILES[code] ? { logo: `/img/banks/${LOGO_FILES[code]}` } : {});

const ewallet = (code, name, accountType, bic, initials, color) =>
  ({ code, name, category: 'EWALLET', accountType, rails: INSTAPAY_ONLY, bic, ...logo(code), badge: { initials, color } });
const bank = (code, name, bic, initials, color) =>
  ({ code, name, category: 'BANK', accountType: 'BANK', rails: BOTH_RAILS, bic, ...logo(code), badge: { initials, color } });

const BANKS = [
  ewallet('GCASH', 'GCash', 'MOBILE', 'GXCHPHM2XXX', 'GC', '#0057d9'),
  ewallet('MAYA', 'Maya', 'MOBILE', 'PAPHPHM1XXX', 'MY', '#007a45'),
  ewallet('GOTYME', 'GoTyme', 'BANK', 'GOTYPHM2XXX', 'GT', '#00736b'),
  ewallet('MARIBANK', 'MariBank', 'BANK', 'SEAPPHM2XXX', 'MA', '#c2410c'), // formerly SeaBank (same bank, renamed)
  ewallet('CIMB', 'CIMB', 'BANK', 'CIPHPHMMXXX', 'CI', '#c8102e'),
  ewallet('TONIK', 'Tonik', 'BANK', 'TODIPHM2XXX', 'TK', '#5b3fd6'),
  ewallet('UNIONDIGITAL', 'UnionDigital', 'BANK', 'UDBIPHM2XXX', 'UD', '#b45309'),
  ewallet('KOMO', 'Komo', 'BANK', 'EWRBPHM2XXX', 'KO', '#be185d'),
  bank('BDO', 'BDO', 'BNORPHMMXXX', 'BDO', '#0033a0'),
  bank('BPI', 'BPI', 'BOPIPHMMXXX', 'BPI', '#b11116'),
  bank('METROBANK', 'Metrobank', 'MBTCPHMMXXX', 'MB', '#003da5'),
  bank('UNIONBANK', 'UnionBank', 'UBPHPHMMXXX', 'UB', '#9a3412'),
  bank('SECURITYBANK', 'Security Bank', 'SETCPHMMXXX', 'SB', '#00649b'),
  bank('RCBC', 'RCBC', 'RCBCPHMMXXX', 'RC', '#1d3f8f'),
  bank('CHINABANK', 'China Bank', 'CHBKPHMMXXX', 'CB', '#a6192e'),
  bank('PNB', 'PNB', 'PNBMPHMMXXX', 'PNB', '#003087'),
  bank('EASTWEST', 'EastWest', 'EWBCPHMMXXX', 'EW', '#5c2d91'),
  bank('AUB', 'AUB', 'AUBKPHMMXXX', 'AUB', '#003a70'),
  bank('LANDBANK', 'Landbank', 'TLBPPHMMXXX', 'LB', '#00703c'),
];

// Bank account numbers: digits only, 10 to 16 long (dashes/spaces are removed first).
const BANK_ACCOUNT_PATTERN = /^\d{10,16}$/;

// Old codes of renamed destinations: transfers saved under them still show the current name, and
// API clients that send the old code keep working.
const RENAMED_CODES = { SEABANK: 'MARIBANK' };

function findBank(code) {
  const current = RENAMED_CODES[code] ?? code;
  return BANKS.find((bank) => bank.code === current) || null;
}

module.exports = { BANKS, CATEGORIES, RAILS, BANK_TRANSFER_FEE_CENTS, BANK_ACCOUNT_PATTERN, PAYPULSE_BIC, findBank };
