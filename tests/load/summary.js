/**
 * Shared k6 handleSummary(): writes a self-contained HTML report + the raw JSON for a run, and
 * keeps the usual text summary on the console. handleSummary also runs when thresholds fail
 * (unlike the web-dashboard export), so a red run still gets its report.
 *
 *   export const handleSummary = summaryFor('k6-race', 'Race condition: 10 parallel transfers');
 *
 * Files go to REPORT_DIR (default "reports"; the Docker Compose k6 service mounts /reports).
 */
import { textSummary } from 'https://jslib.k6.io/k6-summary/0.1.0/index.js';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const fmt = (v) => (typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(2)) : String(v));

function metricValue(m) {
  const v = m.values;
  if (m.type === 'counter') return fmt(v.count);
  if (m.type === 'rate') return `${(v.rate * 100).toFixed(2)}%`;
  if (m.type === 'trend') return `avg ${fmt(v.avg)} · p95 ${fmt(v['p(95)'])} · max ${fmt(v.max)}`;
  return fmt(v.value ?? v.count ?? '');
}

function html(name, title, data) {
  const metrics = Object.entries(data.metrics);
  const thresholds = metrics.flatMap(([metric, m]) =>
    Object.entries(m.thresholds || {}).map(([rule, t]) => ({ metric, rule, ok: t.ok, value: metricValue(m) })),
  );
  const passed = thresholds.every((t) => t.ok);
  const checks = [];
  const walk = (group) => {
    (group.checks || []).forEach((c) => checks.push(c));
    (group.groups || []).forEach(walk);
  };
  walk(data.root_group);

  const rows = (items, cells) => items.map((i) => `<tr>${cells(i).map((c) => `<td>${c}</td>`).join('')}</tr>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · k6</title>
<style>
  body { margin: 0; font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; color: #1b1d2a; background: #f2f6f5; }
  main { max-width: 900px; margin: 0 auto; padding: 24px 16px 48px; }
  h1 { margin: 0 0 4px; font-size: 1.4rem; } h2 { font-size: 1rem; margin: 28px 0 8px; }
  .muted { color: #6b7086; } .badge { display: inline-block; padding: 4px 12px; border-radius: 999px; font-weight: 700; }
  .pass { background: #e3f8f0; color: #0b5d43; } .fail { background: #fde8ea; color: #b42335; }
  table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 12px; overflow: hidden; }
  th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid #e3e5ef; vertical-align: top; }
  th { background: #f7f8fc; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.04em; color: #6b7086; }
  td.num { font-variant-numeric: tabular-nums; }
</style></head><body><main>
<h1>${esc(title)}</h1>
<p class="muted">k6 run <code>${esc(name)}</code> · ${new Date().toISOString()} · ${esc(fmt(data.state.testRunDurationMs / 1000))} s</p>
<p><span class="badge ${passed ? 'pass' : 'fail'}">${passed ? '✓ All thresholds passed' : '✗ Thresholds failed'}</span></p>
<h2>Thresholds</h2>
<table><tr><th>Metric</th><th>Rule</th><th>Value</th><th>Result</th></tr>
${rows(thresholds, (t) => [esc(t.metric), `<code>${esc(t.rule)}</code>`, `<span class="num">${esc(t.value)}</span>`, t.ok ? '<span class="badge pass">pass</span>' : '<span class="badge fail">fail</span>'])}</table>
<h2>Checks</h2>
<table><tr><th>Check</th><th>Passed</th><th>Failed</th></tr>
${rows(checks, (c) => [esc(c.name), String(c.passes), String(c.fails)])}</table>
<h2>All metrics</h2>
<table><tr><th>Metric</th><th>Type</th><th>Value</th></tr>
${rows(metrics.sort(([a], [b]) => a.localeCompare(b)), ([n, m]) => [esc(n), m.type, `<span class="num">${esc(metricValue(m))}</span>`])}</table>
</main></body></html>`;
}

export function summaryFor(name, title) {
  const dir = __ENV.REPORT_DIR || 'reports';
  return (data) => ({
    stdout: textSummary(data, { indent: '  ', enableColors: false }),
    [`${dir}/${name}-report.html`]: html(name, title, data),
    [`${dir}/${name}-summary.json`]: JSON.stringify(data, null, 2),
  });
}
