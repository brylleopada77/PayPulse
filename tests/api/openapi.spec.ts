import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { authHeader, createAdmin } from '../helpers/api';

// The OpenAPI document (src/docs/openapi.js) is the contract shown at /api-docs. These tests keep it
// honest: every Express route is documented and every documented operation exists, every $ref
// resolves, and the documented GET endpoints answer with a status the document lists.

const ROOT = path.join(__dirname, '..', '..');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const spec = require(path.join(ROOT, 'src', 'docs', 'openapi.js'));
const METHODS = ['get', 'post', 'put', 'patch', 'delete'];

/** "METHOD /path/{param}" for every route registered in src/app.js and src/routes (static scan). */
function routesInCode(): string[] {
  const appSource = fs.readFileSync(path.join(ROOT, 'src', 'app.js'), 'utf8');
  const files = Object.fromEntries(
    [...appSource.matchAll(/const (\w+) = require\('\.\/routes\/([\w/]+)'\)/g)].map(([, name, file]) => [name, file]),
  );
  const routes: string[] = [];
  const add = (method: string, full: string) =>
    routes.push(`${method.toUpperCase()} ${full.replace(/\/$/, '').replace(/:(\w+)/g, '{$1}') || '/'}`);

  for (const [, prefix, name] of appSource.matchAll(/app\.use\('([^']+)', (\w+)\)/g)) {
    if (!files[name]) continue;
    const source = fs.readFileSync(path.join(ROOT, 'src', 'routes', `${files[name]}.js`), 'utf8');
    for (const [, method, sub] of source.matchAll(/router\.(get|post|put|patch|delete)\(\s*'([^']*)'/g)) add(method, prefix + sub);
  }
  for (const [, method, route] of appSource.matchAll(/app\.(get|post|put|patch|delete)\('([^']+)'/g)) {
    if (route.startsWith('/api') || route === '/health') add(method, route);
  }
  return routes.filter((r) => !r.includes('/api-docs')).sort();
}

const documented = () =>
  Object.entries(spec.paths as Record<string, Record<string, unknown>>)
    .flatMap(([p, ops]) => Object.keys(ops).filter((m) => METHODS.includes(m)).map((m) => `${m.toUpperCase()} ${p}`))
    .sort();

test.describe('OpenAPI contract (/api-docs)', () => {
  test('every Express route is documented, and every documented operation exists', () => {
    const code = routesInCode();
    expect(code.length).toBeGreaterThan(50);
    expect(code.filter((r) => !documented().includes(r)), 'routes missing from src/docs/openapi.js').toEqual([]);
    expect(documented().filter((r) => !code.includes(r)), 'documented operations with no route').toEqual([]);
  });

  test('valid OpenAPI 3 structure: every $ref resolves, every operation has a tag, summary and responses', () => {
    expect(spec.openapi).toMatch(/^3\.0\.\d$/);
    const tags = new Set(spec.tags.map((t: { name: string }) => t.name));
    const refs = [...JSON.stringify(spec).matchAll(/"\$ref":"#\/([^"]+)"/g)].map(([, r]) => r);
    for (const r of refs) {
      const target = r.split('/').reduce((node: Record<string, unknown> | undefined, key) => node?.[key] as Record<string, unknown>, spec);
      expect(target, `#/${r}`).toBeDefined();
    }
    for (const [p, ops] of Object.entries(spec.paths as Record<string, Record<string, any>>)) {
      for (const [method, op] of Object.entries(ops)) {
        const where = `${method.toUpperCase()} ${p}`;
        expect(op.tags?.every((t: string) => tags.has(t)), `${where}: tag`).toBe(true);
        expect(op.summary, `${where}: summary`).toBeTruthy();
        expect(Object.keys(op.responses).some((code) => /^2\d\d$/.test(code)), `${where}: success response`).toBe(true);
        // every {param} in the path is declared as a path parameter
        for (const [, name] of p.matchAll(/\{(\w+)\}/g)) {
          expect(op.parameters.some((x: { in: string; name: string }) => x.in === 'path' && x.name === name), `${where}: {${name}}`).toBe(true);
        }
      }
    }
  });

  test('/api-docs serves Swagger UI and /api-docs/openapi.json the document', async ({ request }) => {
    const ui = await request.get('/api-docs/');
    expect(ui.status()).toBe(200);
    expect(ui.headers()['content-type']).toContain('text/html');
    expect(await ui.text()).toContain('swagger-ui');

    const doc = await request.get('/api-docs/openapi.json');
    expect(doc.status()).toBe(200);
    expect(await doc.json()).toEqual(JSON.parse(JSON.stringify(spec)));
  });

  test('every documented GET without path parameters answers with a documented status', async ({ request }) => {
    const admin = await createAdmin(request); // admin: the QA sandbox and top-up limits are documented too
    const gets = Object.entries(spec.paths as Record<string, Record<string, any>>).filter(([p, ops]) => ops.get && !p.includes('{'));
    expect(gets.length).toBeGreaterThan(15);
    for (const [p, ops] of gets) {
      const response = await request.get(p, { headers: authHeader(admin.token) });
      expect(Object.keys(ops.get.responses), `GET ${p} answered ${response.status()}`).toContain(String(response.status()));
    }
  });
});
