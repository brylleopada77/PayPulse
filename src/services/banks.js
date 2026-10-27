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
  BANK: 'Banks',
};
const INSTAPAY_ONLY = ['INSTAPAY'];
const BOTH_RAILS = ['INSTAPAY', 'PESONET'];

const ewallet = (code, name, accountType, bic) => ({ code, name, category: 'EWALLET', accountType, rails: INSTAPAY_ONLY, bic });
const bank = (code, name, bic) => ({ code, name, category: 'BANK', accountType: 'BANK', rails: BOTH_RAILS, bic });

const BANKS = [
  ewallet('GCASH', 'GCash', 'MOBILE', 'GXCHPHM2XXX'),
  ewallet('MAYA', 'Maya', 'MOBILE', 'PAPHPHM1XXX'),
  ewallet('GOTYME', 'GoTyme', 'BANK', 'GOTYPHM2XXX'),
  ewallet('SEABANK', 'SeaBank', 'BANK', 'SEAPPHM2XXX'),
  ewallet('CIMB', 'CIMB', 'BANK', 'CIPHPHMMXXX'),
  ewallet('TONIK', 'Tonik', 'BANK', 'TODIPHM2XXX'),
  ewallet('UNIONDIGITAL', 'UnionDigital', 'BANK', 'UDBIPHM2XXX'),
  ewallet('KOMO', 'Komo', 'BANK', 'EWRBPHM2XXX'),
  bank('BDO', 'BDO', 'BNORPHMMXXX'),
  bank('BPI', 'BPI', 'BOPIPHMMXXX'),
  bank('METROBANK', 'Metrobank', 'MBTCPHMMXXX'),
  bank('UNIONBANK', 'UnionBank', 'UBPHPHMMXXX'),
  bank('SECURITYBANK', 'Security Bank', 'SETCPHMMXXX'),
  bank('RCBC', 'RCBC', 'RCBCPHMMXXX'),
  bank('CHINABANK', 'China Bank', 'CHBKPHMMXXX'),
  bank('PNB', 'PNB', 'PNBMPHMMXXX'),
  bank('EASTWEST', 'EastWest', 'EWBCPHMMXXX'),
  bank('AUB', 'AUB', 'AUBKPHMMXXX'),
  bank('LANDBANK', 'Landbank', 'TLBPPHMMXXX'),
];

// Bank account numbers: digits only, 10 to 16 long (dashes/spaces are removed first).
const BANK_ACCOUNT_PATTERN = /^\d{10,16}$/;

function findBank(code) {
  return BANKS.find((bank) => bank.code === code) || null;
}

module.exports = { BANKS, CATEGORIES, RAILS, BANK_TRANSFER_FEE_CENTS, BANK_ACCOUNT_PATTERN, PAYPULSE_BIC, findBank };
