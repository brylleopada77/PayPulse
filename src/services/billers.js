// Billers PayPulse customers can pay (mock: nothing is really sent to the biller). The list mirrors
// what Philippine e-wallets and payment centers (GCash, Maya, Bayad Center) commonly offer.
// Account formats are simplified for the demo: most billers take 6-20 letters/digits.

const CATEGORIES = [
  { code: 'UTILITIES', name: 'Utilities', description: 'Electricity and water' },
  { code: 'TELECOMS', name: 'Telecoms & Internet', description: 'Postpaid, fiber and broadband' },
  { code: 'GOVERNMENT', name: 'Government', description: 'Clearances, contributions and fees' },
  { code: 'LOANS', name: 'Credit Cards & Loans', description: 'Card bills and loan installments' },
  { code: 'CABLE', name: 'Cable & TV', description: 'Cable and satellite TV' },
];

const GENERIC = { pattern: /^[A-Z0-9-]{6,20}$/, hint: '6 to 20 letters or digits' };
const CARD = { pattern: /^\d{16}$/, hint: '16-digit card number', sensitive: true };

const biller = (code, name, category, accountLabel, format = GENERIC) => ({ code, name, category, accountLabel, ...format });

const BILLERS = [
  biller('MERALCO', 'Meralco', 'UTILITIES', 'Customer Account Number (CAN)', { pattern: /^\d{10}$/, hint: '10-digit CAN on your bill' }),
  biller('MANILA_WATER', 'Manila Water', 'UTILITIES', 'Contract Account Number'),
  biller('MAYNILAD', 'Maynilad', 'UTILITIES', 'Contract Account Number'),
  biller('VECO', 'Visayan Electric (VECO)', 'UTILITIES', 'Account Number'),
  biller('DAVAO_LIGHT', 'Davao Light', 'UTILITIES', 'Account Number'),

  biller('PLDT', 'PLDT Home', 'TELECOMS', 'Account Number'),
  biller('GLOBE_POSTPAID', 'Globe Postpaid', 'TELECOMS', 'Account Number'),
  biller('SMART_POSTPAID', 'Smart Postpaid', 'TELECOMS', 'Account Number'),
  biller('CONVERGE', 'Converge ICT', 'TELECOMS', 'Account Number'),
  biller('DITO', 'DITO Telecommunity', 'TELECOMS', 'Account Number'),

  biller('NBI', 'NBI Clearance', 'GOVERNMENT', 'Reference Number'),
  biller('SSS', 'SSS (PRN)', 'GOVERNMENT', 'Payment Reference Number (PRN)'),
  biller('PAGIBIG', 'Pag-IBIG Fund', 'GOVERNMENT', 'Pag-IBIG MID / Loan Number'),
  biller('LTO', 'LTO', 'GOVERNMENT', 'Transaction Reference Number'),
  biller('BIR', 'BIR', 'GOVERNMENT', 'TIN / Payment Reference'),

  biller('HOME_CREDIT', 'Home Credit', 'LOANS', 'Contract Number'),
  biller('MAYA_CREDIT', 'Maya Credit', 'LOANS', 'Account Number'),
  biller('BDO_CC', 'BDO Credit Card', 'LOANS', 'Card Number', CARD),
  biller('BPI_CC', 'BPI Credit Card', 'LOANS', 'Card Number', CARD),
  biller('UNIONBANK_CC', 'UnionBank Credit Card', 'LOANS', 'Card Number', CARD),

  biller('CIGNAL', 'Cignal TV', 'CABLE', 'Account Number'),
  biller('SKY_CABLE', 'Sky Cable', 'CABLE', 'Account Number'),
  biller('CABLELINK', 'Cablelink', 'CABLE', 'Account Number'),
];

function findBiller(code) {
  return BILLERS.find((b) => b.code === code) || null;
}

/** Public catalog (no regexes), for the Pay Bills screen. */
function catalog() {
  return {
    categories: CATEGORIES,
    billers: BILLERS.map(({ code, name, category, accountLabel, hint, sensitive }) => ({
      code,
      name,
      category,
      accountLabel,
      accountHint: hint,
      sensitive: Boolean(sensitive),
    })),
  };
}

module.exports = { BILLERS, CATEGORIES, findBiller, catalog };
