// Philippine mobile networks, brands, prefixes and load products for Buy Load (mock: no load is
// really sent to the telco). Prices and inclusions are illustrative for the demo.
//
// A prefix identifies the NETWORK, not the brand: Globe and TM share Globe's prefixes, Smart and TNT
// share Smart's. So detection returns the network and its brands, and the customer picks the brand.
// Numbers can also be ported between networks, so the customer can override the detected network.

const NETWORKS = {
  GLOBE: {
    code: 'GLOBE',
    name: 'Globe network',
    brands: ['GLOBE', 'TM'],
    prefixes: ['0817', '0905', '0906', '0915', '0916', '0917', '0926', '0927', '0935', '0936', '0937', '0945',
      '0953', '0954', '0955', '0956', '0965', '0966', '0967', '0975', '0978', '0979', '0995', '0996', '0997'],
  },
  SMART: {
    code: 'SMART',
    name: 'Smart network',
    brands: ['SMART', 'TNT'],
    prefixes: ['0813', '0907', '0908', '0909', '0910', '0911', '0912', '0913', '0914', '0918', '0919', '0920',
      '0921', '0928', '0929', '0930', '0938', '0939', '0946', '0947', '0948', '0949', '0950', '0951', '0961',
      '0963', '0968', '0969', '0970', '0981', '0989', '0998', '0999'],
  },
  DITO: { code: 'DITO', name: 'DITO', brands: ['DITO'], prefixes: ['0895', '0896', '0897', '0898', '0991', '0992', '0993', '0994'] },
  GOMO: { code: 'GOMO', name: 'GOMO', brands: ['GOMO'], prefixes: ['0976', '0977'] },
};

const BRANDS = {
  GLOBE: { code: 'GLOBE', name: 'Globe', network: 'GLOBE' },
  TM: { code: 'TM', name: 'TM', network: 'GLOBE' },
  SMART: { code: 'SMART', name: 'Smart', network: 'SMART' },
  TNT: { code: 'TNT', name: 'TNT', network: 'SMART' },
  DITO: { code: 'DITO', name: 'DITO', network: 'DITO' },
  GOMO: { code: 'GOMO', name: 'GOMO', network: 'GOMO' },
};

const REGULAR_AMOUNTS = [20, 50, 100, 200, 500, 1000];
const CUSTOM_MIN = 10;
const CUSTOM_MAX = 1000;

const promo = (code, brand, name, price, description, validity) => ({ code, brand, name, price, description, validity });
const PROMOS = [
  promo('GOPLUS99', 'GLOBE', 'Go+99', 99, '8GB All Access data + 8GB for apps', '7 days'),
  promo('GOEXTRA99', 'GLOBE', 'GoEXTRA99', 99, '8GB data + unli calls and texts to all networks', '7 days'),
  promo('GOPLUS149', 'GLOBE', 'Go+149', 149, '12GB All Access data + 12GB for apps', '7 days'),
  promo('EASYSURF50', 'TM', 'EasySURF 50', 50, '3GB data + unli texts to all networks', '3 days'),
  promo('POWERALL99', 'SMART', 'Power All 99', 99, '8GB data + unli TikTok', '7 days'),
  promo('GIGAVIDEO99', 'SMART', 'GIGA VIDEO 99', 99, '2GB data + 1GB/day for video apps', '7 days'),
  promo('TNTGIGA50', 'TNT', 'GIGA Surf 50', 50, '3GB data + 1GB/day for video apps', '3 days'),
  promo('DITO99', 'DITO', 'DITO 99', 99, '7GB data with no expiry + unli all-net calls and texts', '30 days for calls/texts'),
  promo('GOMO30GB', 'GOMO', '30GB No Expiry', 399, '30GB data that never expires', 'No expiry'),
];

/** "09171234567", "+639171234567", "639171234567", "0917 123 4567" -> "09171234567" (or null). */
function normalizeMobile(input) {
  const digits = String(input ?? '').replace(/[\s()-]/g, '').replace(/^\+?63/, '0');
  return /^09\d{9}$/.test(digits) ? digits : null;
}

/** The network for a number's 4-digit prefix, or null when unknown. */
function detectNetwork(mobile) {
  const number = normalizeMobile(mobile);
  if (!number) return null;
  const prefix = number.slice(0, 4);
  return Object.values(NETWORKS).find((n) => n.prefixes.includes(prefix)) ?? null;
}

function catalog() {
  return {
    // prefixes are sent so the app can detect the network as you type (the server checks again)
    networks: Object.values(NETWORKS).map(({ code, name, brands, prefixes }) => ({ code, name, brands, prefixes })),
    brands: Object.values(BRANDS),
    regularAmounts: REGULAR_AMOUNTS,
    customMin: CUSTOM_MIN,
    customMax: CUSTOM_MAX,
    promos: PROMOS,
  };
}

const findBrand = (code) => BRANDS[String(code ?? '').toUpperCase()] ?? null;
const findPromo = (code) => PROMOS.find((p) => p.code === String(code ?? '').toUpperCase()) ?? null;

module.exports = { NETWORKS, BRANDS, PROMOS, REGULAR_AMOUNTS, CUSTOM_MIN, CUSTOM_MAX, normalizeMobile, detectNetwork, catalog, findBrand, findPromo };
