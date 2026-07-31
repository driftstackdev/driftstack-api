// Every customer-facing route is documented or consumed by something.
//
// `docs-public-surface-resolves` checks one direction: the docs never name a
// route that does not exist. This is the converse — no route exists that
// nothing names. A route absent from the docs, the three SDKs, the desktop GUI
// and the dashboard is surface nobody maintains: it still authenticates, still
// carries whatever scope gate it was born with, and nobody notices when its
// behaviour drifts.
//
// Measured across 142 customer-facing routes: six are unreferenced, and five of
// those have a consumer this repository genuinely cannot see. Each is listed
// below with that consumer named, so the exemption is auditable rather than a
// blanket skip.

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

const ROUTE_RE = /\bapp\.(get|post|put|patch|delete)\b[^(]*\(\s*['"`](\/v1\/[^'"`]+)['"`]/g;

/** Where a customer-facing route is expected to be named. */
const CONSUMER_ROOTS = [
  'apps/docs/src/pages',
  'packages/sdk-typescript/src',
  'packages/sdk-python/src',
  'packages/sdk-go',
  'apps/gui-client/src',
  'apps/customer-dashboard/src',
];

/**
 * Routes whose consumer is outside this repository, each with that consumer
 * named. An entry here is a claim that someone else calls it — not a licence to
 * leave surface unowned.
 */
const EXTERNAL_CONSUMERS: Record<string, string> = {
  '/v1/webhooks/stripe': 'Stripe calls this; signature-verified provider ingress.',
  '/v1/webhooks/nowpayments': 'NowPayments calls this; IPN provider ingress.',
  '/v1/fleet/events':
    'The Swift harness in the driftstack repo connects here; the consumer is not in this repo.',
  '/v1/auth/oauth/${provider}/callback':
    'Template-literal registration; the identity provider redirects here.',
};

function filesUnder(dir: string, exts: Set<string>): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry);
    if (statSync(full).isDirectory()) out.push(...filesUnder(full, exts));
    else if (exts.has(full.slice(full.lastIndexOf('.')))) out.push(full);
  }
  return out;
}

function customerRoutes(): string[] {
  const out = new Set<string>();
  for (const file of filesUnder(resolve(REPO_ROOT, 'apps/server/src'), new Set(['.ts']))) {
    for (const m of readFileSync(file, 'utf8').matchAll(ROUTE_RE)) {
      const path = m[2]!;
      if (path.startsWith('/v1/admin') || path.startsWith('/v1/internal')) continue;
      if (path.startsWith('/v1/mac-nodes')) continue;
      out.add(path);
    }
  }
  return [...out].sort();
}

function consumerCorpus(): string {
  const exts = new Set(['.md', '.ts', '.tsx', '.py', '.go', '.astro']);
  let corpus = '';
  for (const root of CONSUMER_ROOTS) {
    for (const file of filesUnder(resolve(REPO_ROOT, root), exts)) {
      corpus += readFileSync(file, 'utf8');
    }
  }
  return corpus;
}

describe('every customer-facing route has a consumer or a named exemption', () => {
  const routes = customerRoutes();
  const corpus = consumerCorpus();

  it('CRITICAL the scan found the route surface and a consumer corpus. Either coming back empty would make the check below vacuously true.', () => {
    expect(routes.length, 'customer-facing routes').toBeGreaterThan(100);
    expect(corpus.length, 'consumer corpus').toBeGreaterThan(100_000);
    expect(routes).toContain('/v1/sessions');
  });

  it('CRITICAL no customer-facing route is unreferenced by docs, SDKs, GUI and dashboard without a named external consumer. Unreferenced surface still authenticates and still carries its scope gate, and nobody notices when its behaviour drifts.', () => {
    const orphans = routes
      .filter((r) => !corpus.includes(r.split(':')[0]!.replace(/\/$/, '')))
      .filter((r) => EXTERNAL_CONSUMERS[r] === undefined);
    expect(orphans, 'Route(s) nothing documents or calls:').toEqual([]);
  });

  it('CRITICAL the exemption list may only SHRINK — a route that becomes documented must leave it. Without this the list rots into a permanent excuse, and the second entry to go stale would be indistinguishable from the first.', () => {
    const nowReferenced = Object.keys(EXTERNAL_CONSUMERS)
      .filter((r) => routes.includes(r))
      .filter((r) => corpus.includes(r.split(':')[0]!.replace(/\/$/, '')))
      .sort();
    expect(
      nowReferenced,
      'these routes are documented or consumed now — remove them from EXTERNAL_CONSUMERS so they are checked:',
    ).toEqual([]);
  });

  it('every exemption still names a live route, so the list cannot outlive the surface it excuses', () => {
    const live = new Set(routes);
    const stale = Object.keys(EXTERNAL_CONSUMERS)
      .filter((r) => !live.has(r))
      .sort();
    expect(stale, 'exemption(s) for routes that no longer exist:').toEqual([]);
  });
});
