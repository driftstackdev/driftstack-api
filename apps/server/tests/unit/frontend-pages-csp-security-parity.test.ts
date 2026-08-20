// Family-wide Cloudflare Pages CSP drift guard. The six frontends have
// different browser network needs, so a copied broad policy would either
// break a live flow or silently allow an unnecessary exfiltration origin.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

const COMMON_SCRIPT = ["'self'", "'unsafe-inline'"];
const COMMON_STYLE = ["'self'", "'unsafe-inline'"];

const SURFACES = [
  {
    name: 'marketing-site',
    path: 'apps/marketing-site/public/_headers',
    script: COMMON_SCRIPT,
    image: ["'self'", 'data:', 'blob:'],
    connect: [
      "'self'",
      'https://api.driftstack.dev',
      'https://*.ingest.de.sentry.io',
      'https://*.ingest.sentry.io',
    ],
  },
  {
    name: 'customer-dashboard',
    path: 'apps/customer-dashboard/public/_headers',
    script: COMMON_SCRIPT,
    image: ["'self'", 'data:', 'blob:', 'https:'],
    connect: [
      "'self'",
      'https://api.driftstack.dev',
      'https://*.ingest.de.sentry.io',
      'https://*.ingest.sentry.io',
    ],
  },
  {
    name: 'admin-panel',
    path: 'apps/admin-panel/public/_headers',
    script: COMMON_SCRIPT,
    image: ["'self'", 'data:', 'blob:', 'https:'],
    connect: ["'self'", 'https://api.driftstack.dev'],
  },
  {
    name: 'status-site',
    path: 'apps/status-site/public/_headers',
    script: COMMON_SCRIPT,
    image: ["'self'", 'data:', 'blob:'],
    connect: ["'self'", 'https://api.driftstack.dev', 'https://r2-public.driftstack.dev'],
  },
  {
    name: 'docs',
    path: 'apps/docs/public/_headers',
    // Pagefind compiles its same-origin WASM search index on first use.
    // wasm-unsafe-eval permits only WebAssembly compilation, not JS eval.
    script: ["'self'", "'unsafe-inline'", "'wasm-unsafe-eval'"],
    image: ["'self'", 'data:', 'blob:', 'https:'],
    connect: ["'self'"],
  },
] as const;

function parsePolicy(line: string): Map<string, string[]> {
  return new Map(
    line
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const [name, ...values] = part.split(/\s+/);
        return [name!, values];
      }),
  );
}

function policyFromHeaders(body: string): string {
  const lines = body.match(/^ {2}Content-Security-Policy: (.+)$/gm) ?? [];
  expect(lines, 'exactly one enforced CSP header').toHaveLength(1);
  return lines[0]!.replace(/^ {2}Content-Security-Policy: /, '');
}

function assertLockedBaseline(policy: Map<string, string[]>): void {
  expect(policy.get('default-src')).toEqual(["'self'"]);
  expect(policy.get('base-uri')).toEqual(["'self'"]);
  expect(policy.get('object-src')).toEqual(["'none'"]);
  expect(policy.get('frame-ancestors')).toEqual(["'none'"]);
  expect(policy.get('frame-src')).toEqual(["'none'"]);
  expect(policy.get('form-action')).toEqual(["'self'"]);
  expect(policy.get('style-src')).toEqual(COMMON_STYLE);
  expect(policy.get('font-src')).toEqual(["'self'", 'data:']);
  expect(policy.get('manifest-src')).toEqual(["'self'"]);
  expect(policy.get('upgrade-insecure-requests')).toEqual([]);
  expect(policy.has('report-uri')).toBe(false);
  expect(policy.has('report-to')).toBe(false);
}

describe('Cloudflare Pages CSP security parity', () => {
  for (const surface of SURFACES) {
    it(`${surface.name} enforces the exact audited runtime-origin contract`, () => {
      const body = readFileSync(resolve(REPO_ROOT, surface.path), 'utf8');
      const raw = policyFromHeaders(body);
      const policy = parsePolicy(raw);

      assertLockedBaseline(policy);
      expect(policy.get('script-src')).toEqual(surface.script);
      expect(policy.get('img-src')).toEqual(surface.image);
      expect(policy.get('connect-src')).toEqual(surface.connect);
      expect(raw).not.toMatch(/script-src[^;]*https?:/);
      expect(raw).not.toContain('http:');
    });
  }

  it('errors-site generator forbids all script and network execution', () => {
    const source = readFileSync(resolve(REPO_ROOT, 'apps/errors-site/build.mjs'), 'utf8');
    const block = source.match(/const SECURITY_HEADERS = `([\s\S]+?)`;/)?.[1] ?? '';
    const policy = parsePolicy(policyFromHeaders(block));

    assertLockedBaseline(policy);
    expect(policy.get('script-src')).toEqual(["'none'"]);
    expect(policy.get('style-src')).toEqual(COMMON_STYLE);
    expect(policy.get('img-src')).toEqual(["'self'", 'data:']);
    expect(policy.get('connect-src')).toEqual(["'none'"]);
  });
  it('CRITICAL V-1107 every frontend the pipeline deploys has a CSP file and a row in SURFACES. The table is hand-written and is also the population every arm above iterates, so a deployed app missing from it is not reported — it is never looked at. Both halves of that matter: an app with a `_headers` file and no row ships an unaudited policy, and an app with no `_headers` file at all ships no policy while looking exactly like an app this guard has approved.', () => {
    const wf = resolve(REPO_ROOT, '.github/workflows');
    const deployed = new Set<string>();
    for (const f of readdirSync(wf).filter((n) => /^deploy-.*\.ya?ml$/.test(n))) {
      const src = readFileSync(resolve(wf, f), 'utf8');
      for (const m of src.matchAll(/apps\/([a-z][a-z0-9-]*)/g)) {
        const app = m[1] as string;
        // The server has its own deploy path and is not a Pages frontend.
        if (app !== 'server') deployed.add(app);
      }
    }
    expect(deployed.size, 'frontend apps discovered from deploy workflows').toBeGreaterThanOrEqual(
      5,
    );

    const rostered = new Set(SURFACES.map((s) => s.path.split('/')[1] as string));
    const unaudited = [...deployed].filter((a) => !rostered.has(a)).sort();
    expect(
      unaudited,
      'these apps are deployed to Cloudflare Pages but have no row in SURFACES, so whatever CSP ' +
        'they ship (or do not ship) is unaudited:',
    ).toEqual([]);

    // …and each must actually carry the file the row points at. A row whose
    // `_headers` had been deleted would fail the arms above by throwing on the
    // read, but an app deployed without one from the start never gets a row.
    const missingFile = [...deployed]
      .filter((a) => !existsSync(resolve(REPO_ROOT, `apps/${a}/public/_headers`)))
      .sort();
    expect(
      missingFile,
      'these deployed frontends ship no public/_headers, so they carry no CSP at all:',
    ).toEqual([]);

    const stale = [...rostered].filter((a) => !deployed.has(a)).sort();
    expect(
      stale,
      'SURFACES rows for apps no deploy workflow publishes — the row audits nothing while making ' +
        'the coverage look wider than it is:',
    ).toEqual([]);
  });
});
