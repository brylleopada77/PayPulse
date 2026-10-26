#!/usr/bin/env node
/**
 * Generates public/theme-dark.css from public/styles.css: the iOS dark-glass theme.
 *
 * Every rule in styles.css that uses a light colour gets a twin scoped to
 * :root[data-theme="dark"], with the colour translated by its ROLE:
 *   backgrounds  white / light tints  -> dark glass and translucent tints
 *   text         dark ink / dark greens -> light ink / glowing mint
 *   borders, shadows                  -> faint white lines, deeper shadows
 * so the dark theme can never fall behind the light one. Hand-designed details (glass tokens,
 * glow, purple / orange accents, the page backdrop) live in DESIGNED below.
 *
 * Run after changing styles.css:  npm run theme:dark   (CI fails if the output is stale)
 */
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'public', 'styles.css');
const OUT = path.join(__dirname, '..', 'public', 'theme-dark.css');
const SCOPE = ':root[data-theme="dark"]';

// ---------- colour translation, by role ----------
const BG = {
  '#fff': '#1c1f22', '#ffffff': '#1c1f22', white: '#1c1f22',
  '#f4f5fb': '#121417', '#f2f6f5': '#0e1012', '#f7f8fc': '#24282c', '#fafbff': '#202327', '#eef0f6': '#262a2f',
  '#f3fcf8': 'rgba(18, 184, 134, 0.10)', '#e3f8f0': 'rgba(18, 184, 134, 0.16)', '#e1f7ef': 'rgba(18, 184, 134, 0.16)',
  '#d4f5e4': 'rgba(18, 184, 134, 0.22)', '#e3fbef': 'rgba(18, 184, 134, 0.12)', '#cdf5e0': 'rgba(18, 184, 134, 0.20)',
  '#b9f0d3': 'rgba(18, 184, 134, 0.28)', '#bdebd4': 'rgba(18, 184, 134, 0.30)', '#a6ebc7': 'rgba(18, 184, 134, 0.38)',
  '#bff0d6': 'rgba(18, 184, 134, 0.30)', '#d6f7e6': 'rgba(18, 184, 134, 0.20)', '#e8f5ff': 'rgba(47, 107, 255, 0.14)',
  '#fff4d6': 'rgba(255, 159, 67, 0.16)', '#fde8ea': 'rgba(229, 72, 77, 0.18)', '#e8f1ff': 'rgba(47, 107, 255, 0.18)',
  '#d5d8e5': '#3a3f46', '#e3e5ef': '#2c3035', '#d6f7f1': 'rgba(25, 195, 166, 0.14)', '#e6e3ff': 'rgba(140, 100, 255, 0.14)',
};
const TEXT = {
  '#1b1d2a': '#eef2f1', '#6b7086': '#a7b0b6', '#0b5d43': '#7de8bf', '#0b7a57': '#6fe0b4', '#2f7a5d': '#8fd9b9',
  '#4f7f6b': '#9fb8ad', '#5f8576': '#9fb8ad', '#6b9e8a': '#7fae9a', '#8a5a00': '#ffb36b', '#a86a00': '#ffb36b',
  '#6b4600': '#ffc58f', '#b26a00': '#ffb36b', '#b42335': '#ff8f98', '#2459c9': '#9db8ff', '#3d4663': '#c9cfe2',
  '#064a35': '#7de8bf',
};
const LINE = {
  '#9fe3c3': 'rgba(18, 184, 134, 0.40)', '#bdebd4': 'rgba(18, 184, 134, 0.30)', '#e3e5ef': 'rgba(255, 255, 255, 0.10)',
  '#d5d8e5': 'rgba(255, 255, 255, 0.18)', '#fff': 'rgba(255, 255, 255, 0.12)', '#ffffff': 'rgba(255, 255, 255, 0.12)',
  '#c9cce0': 'rgba(255, 255, 255, 0.18)',
};

const HEX = /#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b|\bwhite\b/g;
const RGBA = /rgba\(\s*(\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\s*\)/g;
const round = (n) => Math.round(n * 100) / 100;

function translate(prop, value) {
  const role = /background/.test(prop) ? 'bg' : /^(color|caret-color|stroke|fill)$/.test(prop) ? 'text' : /border|outline|shadow/.test(prop) ? 'line' : null;
  if (!role) return value;
  const map = role === 'bg' ? BG : role === 'text' ? TEXT : LINE;
  let out = value.replace(HEX, (c) => map[c.toLowerCase()] ?? c);
  out = out.replace(RGBA, (whole, r, g, b, a) => {
    const [R, G, B, A] = [Number(r), Number(g), Number(b), Number(a)];
    if (R === 255 && G === 255 && B === 255) {
      if (role === 'bg') return `rgba(24, 26, 29, ${round(Math.min(0.92, A + 0.12))})`;
      return `rgba(255, 255, 255, ${round(Math.min(0.14, A * 0.15))})`;
    }
    if (role === 'bg' && R > 200 && G > 200 && B > 200) return `rgba(18, 184, 134, ${round(A * 0.22)})`; // light mint tints
    if (role === 'line' && ((R === 31 && G === 38) || (R === 27 && G === 29) || (R === 18 && G === 120) || (R === 0 && G === 0))) {
      return `rgba(0, 0, 0, ${round(Math.min(0.55, A * 4))})`; // shadows: deeper on dark
    }
    return whole;
  });
  return out;
}

// ---------- a small CSS parser (rules, nested @media / @supports; @keyframes skipped) ----------
function parse(css) {
  const nodes = [];
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf('{', i);
    if (open < 0) break;
    const prelude = css.slice(i, open).trim();
    let depth = 1;
    let j = open + 1;
    while (j < css.length && depth > 0) {
      if (css[j] === '{') depth++;
      else if (css[j] === '}') depth--;
      j++;
    }
    const body = css.slice(open + 1, j - 1);
    if (prelude.startsWith('@')) {
      if (!/^@keyframes/.test(prelude)) nodes.push({ at: prelude, children: parse(body) });
    } else {
      nodes.push({ selector: prelude, body });
    }
    i = j;
  }
  return nodes;
}

function declarations(body) {
  const out = [];
  let buf = '';
  let paren = 0;
  for (const ch of body) {
    if (ch === '(') paren++;
    if (ch === ')') paren--;
    if (ch === ';' && paren === 0) {
      out.push(buf);
      buf = '';
    } else buf += ch;
  }
  if (buf.trim()) out.push(buf);
  return out
    .map((d) => d.trim())
    .filter(Boolean)
    .map((d) => {
      const k = d.indexOf(':');
      return [d.slice(0, k).trim(), d.slice(k + 1).trim()];
    });
}

const scope = (selector) =>
  selector
    .split(',')
    .map((s) => s.trim())
    .map((s) => (s.startsWith(':root') ? s.replace(':root', SCOPE) : `${SCOPE} ${s}`))
    .join(',\n');

function emit(nodes, indent = '') {
  let out = '';
  for (const n of nodes) {
    if (n.at) {
      const inner = emit(n.children, indent + '  ');
      if (inner.trim()) out += `${indent}${n.at} {\n${inner}${indent}}\n`;
      continue;
    }
    const changed = declarations(n.body)
      .filter(([prop, value]) => !prop.startsWith('--') && !value.includes('url('))
      .map(([prop, value]) => [prop, translate(prop, value)])
      .filter(([prop, value]) => value !== declarations(n.body).find(([p]) => p === prop)?.[1]);
    if (changed.length) {
      out += `${indent}${scope(n.selector).replace(/\n/g, `\n${indent}`)} {\n`;
      out += changed.map(([p, v]) => `${indent}  ${p}: ${v};`).join('\n') + `\n${indent}}\n`;
    }
  }
  return out;
}

// ---------- hand-designed dark glass details (after the generated rules, so they win) ----------
const DESIGNED = `
/* ===== Designed: deep-navy dark glass with the brand accent. Brand colours are theme tokens (top of styles.css), never literals here. ===== */
${SCOPE} {
  color-scheme: dark;
  /* brand colours: see the dark tokens at the top of styles.css */
  --success: #3ddc97;
  --success-soft: rgba(14, 159, 110, 0.18);
  --bg: #0a0f1a;
  --surface: #131a28;
  --text: #ffffff;
  --muted: #94a3b8;
  --border: rgba(255, 255, 255, 0.10);
  --shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
  --accent-orange: #ff9f43;
  /* Dark glass: rgba(10, 15, 26, 0.75) + blur, hairline highlight, deep ambient shadow */
  --glass-bg: rgba(255, 255, 255, 0.05);
  --glass-border: 1px solid rgba(255, 255, 255, 0.08);
  --glass-shadow: 0 8px 32px 0 rgba(0, 0, 0, 0.45);
  --glass-ring: inset 0 1px 0 rgba(255, 255, 255, 0.06);
}
${SCOPE} body {
  color: var(--text);
  background:
    radial-gradient(circle at 15% 5%, rgba(var(--accent-rgb), 0.08), transparent 40%),
    radial-gradient(circle at 90% 90%, rgba(var(--accent-rgb), 0.05), transparent 40%),
    #0a0f1a;
  background-attachment: fixed;
}
/* Dialogs: a darker glass sheet */
${SCOPE} .sheet { background: #131a28; color: var(--text); border: 1px solid rgba(255, 255, 255, 0.08); }
${SCOPE} .sheet::backdrop { background: rgba(0, 0, 0, 0.6); }
/* White glowing text */
${SCOPE} .receipt-amount, ${SCOPE} .loan-owed strong, ${SCOPE} .assets-total,
${SCOPE} .who-name, ${SCOPE} .product-amount, ${SCOPE} .activity-head-btn {
  color: #fff; text-shadow: 0 0 18px rgba(255, 255, 255, 0.28);
}
${SCOPE} .sub-amount { color: #fff; text-shadow: 0 0 12px rgba(255, 255, 255, 0.2); }
/* The brand balance card keeps its gradient and white text on dark */
${SCOPE} .balance-card, ${SCOPE} .balance-card.glass-card {
  background: radial-gradient(circle at 105% -10%, rgba(255, 255, 255, 0.06) 0 30%, transparent 31%), var(--card-gradient);
  border: 1px solid rgba(var(--accent-rgb), 0.55);
  box-shadow: 0 0 0 1px rgba(var(--accent-rgb), 0.15), 0 0 28px rgba(var(--accent-rgb), 0.22), 0 18px 40px rgba(0, 0, 0, 0.6);
}
${SCOPE} .balance-card .balance { color: #fff; text-shadow: 0 0 20px rgba(255, 255, 255, 0.3); }
${SCOPE} .balance-card .sub-label, ${SCOPE} .balance-card .label { color: rgba(255, 255, 255, 0.85); }
${SCOPE} .assets-pill, ${SCOPE} .assets-pill.glass-btn { background: rgba(255, 255, 255, 0.18); color: #fff; border-color: rgba(255, 255, 255, 0.3); }
/* Primary action: luminous brand blue */
${SCOPE} .btn.primary {
  background: var(--accent); color: var(--on-accent); border: 1px solid var(--accent);
  box-shadow: 0 0 22px rgba(var(--accent-rgb), 0.35);
}
${SCOPE} .btn.primary:hover { background: var(--accent-hover); }
${SCOPE} .btn.primary:disabled { background: rgba(255, 255, 255, 0.06); color: #64748b; border-color: transparent; box-shadow: none; }
${SCOPE} .btn.secondary { background: var(--badge-neutral); color: var(--accent-ink); }
/* Accents: brand blue for links / selections / focus, cyan for rewards */
${SCOPE} .btn.link, ${SCOPE} .badge-action, ${SCOPE} .see-all { color: var(--accent-ink); }
${SCOPE} .notif-chip[aria-selected="true"], ${SCOPE} .term-picker input:checked + span, ${SCOPE} .segmented input:checked + span {
  border-color: var(--accent); background: rgba(var(--accent-rgb), 0.22); color: var(--accent-ink);
}
${SCOPE} :focus-visible { outline-color: var(--accent-secondary) !important; }
${SCOPE} #loan-amount { background: linear-gradient(to right, var(--accent) var(--fill), #1c2536 var(--fill)); }
${SCOPE} #loan-amount::-webkit-slider-thumb { background: #131a28; border-color: var(--accent); }
${SCOPE} .meter-fill, ${SCOPE} .slot.used { background: linear-gradient(90deg, var(--accent), var(--accent-secondary)); }
${SCOPE} .cashback-banner, ${SCOPE} .cashback-stamp, ${SCOPE} .cashback-hint {
  background: rgba(var(--accent-secondary-rgb), 0.12); color: #a5f0ff; border-color: rgba(var(--accent-secondary-rgb), 0.5);
}
${SCOPE} .live-toast.cashback .live-toast-icon, ${SCOPE} .tx.savings .tx-icon { background: rgba(var(--accent-secondary-rgb), 0.16); }
${SCOPE} .promo-text strong { color: #fff; text-shadow: 0 0 14px rgba(var(--accent-secondary-rgb), 0.45); }
${SCOPE} .bell-dot, ${SCOPE} .chip-count { border-color: #0a0f1a; }
/* Glass dock and Scan & Pay */
${SCOPE} .bottom-nav.glass-dock {
  background: linear-gradient(180deg, rgba(19, 26, 40, 0.88) 0%, rgba(10, 15, 26, 0.75) 100%);
  box-shadow: var(--glass-shadow), inset 0 1px 0 rgba(255, 255, 255, 0.08), inset 0 0 0 1px rgba(var(--accent-rgb), 0.22);
}
${SCOPE} .glass-dock .scan-bubble, ${SCOPE} .scan-bubble {
  background: var(--scan-gradient);
  border: 4px solid #0a0f1a;
  color: var(--on-accent);
  box-shadow: 0 0 0 1px rgba(var(--accent-rgb), 0.7), 0 10px 26px rgba(var(--accent-rgb), 0.30), 0 0 30px rgba(var(--accent-rgb), 0.35);
}
${SCOPE} .glass-dock .nav-item.active svg, ${SCOPE} .glass-dock .nav-item.active:hover svg {
  background: rgba(var(--accent-rgb), 0.28); box-shadow: inset 0 0 0 1px rgba(var(--accent-secondary-rgb), 0.45), 0 0 14px rgba(var(--accent-rgb), 0.45);
}
${SCOPE} .glass-dock .nav-item:not(.nav-scan):hover { background: rgba(255, 255, 255, 0.06); border-color: rgba(255, 255, 255, 0.10); }
/* Form fields */
${SCOPE} .form input, ${SCOPE} .form select, ${SCOPE} .form textarea, ${SCOPE} .chat-input input,
${SCOPE} .card-pay select, ${SCOPE} .card-pay input { background: #0f1522; color: var(--text); border-color: rgba(255, 255, 255, 0.12); }
${SCOPE} .form input::placeholder, ${SCOPE} .form textarea::placeholder { color: #64748b; }
/* Quick action icons: dark discs with a brand glyph and glow */
${SCOPE} .quick-icon { background: rgba(255, 255, 255, 0.06); color: var(--accent); box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.10); }
${SCOPE} .quick:hover .quick-icon { background: rgba(var(--accent-rgb), 0.12); box-shadow: inset 0 0 0 1px rgba(var(--accent-rgb), 0.45), 0 0 16px rgba(var(--accent-rgb), 0.35); }
${SCOPE} .quick:active .quick-icon { background: var(--accent); color: var(--on-accent); }
${SCOPE} #savings-add { background: var(--accent); color: var(--on-accent); border-color: var(--accent); }
${SCOPE} .rate-badge { background: var(--reward); color: var(--on-reward); }
${SCOPE} .tx-amount { color: #ffffff; }
${SCOPE} .tx.in .tx-amount { color: var(--success); text-shadow: 0 0 10px rgba(14, 159, 110, 0.35); }
`;

const header = `/* GENERATED by scripts/build-dark-theme.js from styles.css: do not edit by hand.
   Run "npm run theme:dark" after changing styles.css. */\n`;
const css = fs.readFileSync(SRC, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const generated = emit(parse(css));
fs.writeFileSync(OUT, header + '\n/* ===== Generated: light colours translated by role ===== */\n' + generated + DESIGNED);
console.log(`Wrote ${path.relative(process.cwd(), OUT)} (${generated.split('\n').filter((l) => l.trim().endsWith('{')).length} translated rules)`);
