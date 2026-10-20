// Outside banks and e-wallets PayPulse can send money to (mock: nothing is really sent).
// E-wallets are reached by the recipient's mobile number, banks by an account number.
// BICs are used as the creditor agent in ISO 20022 pacs.008 messages (illustrative values).

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

const BANKS = [
  { code: 'GCASH', name: 'GCash', accountType: 'MOBILE', bic: 'GXCHPHM2XXX' },
  { code: 'MAYA', name: 'Maya', accountType: 'MOBILE', bic: 'PAPHPHM1XXX' },
  { code: 'BDO', name: 'BDO', accountType: 'BANK', bic: 'BNORPHMMXXX' },
  { code: 'BPI', name: 'BPI', accountType: 'BANK', bic: 'BOPIPHMMXXX' },
  { code: 'METROBANK', name: 'Metrobank', accountType: 'BANK', bic: 'MBTCPHMMXXX' },
];

// Bank account numbers: digits only, 10 to 16 long (dashes/spaces are removed first).
const BANK_ACCOUNT_PATTERN = /^\d{10,16}$/;

function findBank(code) {
  return BANKS.find((bank) => bank.code === code) || null;
}

module.exports = { BANKS, RAILS, BANK_TRANSFER_FEE_CENTS, BANK_ACCOUNT_PATTERN, PAYPULSE_BIC, findBank };
