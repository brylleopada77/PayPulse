// Outside banks and e-wallets PayPulse can send money to (mock: nothing is really sent).
// E-wallets are reached by the recipient's mobile number, banks by an account number.

const BANK_TRANSFER_FEE_CENTS = 1500; // ₱15.00 convenience fee per bank transfer

const BANKS = [
  { code: 'GCASH', name: 'GCash', accountType: 'MOBILE' },
  { code: 'MAYA', name: 'Maya', accountType: 'MOBILE' },
  { code: 'BDO', name: 'BDO', accountType: 'BANK' },
  { code: 'BPI', name: 'BPI', accountType: 'BANK' },
  { code: 'METROBANK', name: 'Metrobank', accountType: 'BANK' },
];

// Bank account numbers: digits only, 10 to 16 long (dashes/spaces are removed first).
const BANK_ACCOUNT_PATTERN = /^\d{10,16}$/;

function findBank(code) {
  return BANKS.find((bank) => bank.code === code) || null;
}

module.exports = { BANKS, BANK_TRANSFER_FEE_CENTS, BANK_ACCOUNT_PATTERN, findBank };
