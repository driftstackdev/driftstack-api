// W356.A — drift guard for /docs/crypto-orders-polling-vs-webhooks.
// V-666.BV practitioner guide. As of 2026-05-22 migration 0064 +
// bootstrap emitter sink, crypto.order.paid + crypto.order.failed
// ARE in SubscribableWebhookEventTypeSchema, so the page documents
//
// S47 2026-07-07 (founder-approved: mirror deprecation) — SUPERSEDED.
// The legacy marketing mirror page /docs/crypto-orders-polling-vs-webhooks is DELETED and
// 301-redirects (apps/marketing-site/public/_redirects) to its
// verified docs successor:
//   https://docs.driftstack.io/webhooks/crypto-events/
//   (source: apps/docs/src/pages/webhooks/crypto-events.md; S29/S37 content batches — every claim
//   re-verified against server source before carry-over. Ongoing
//   content-parity guarding for this topic lives with the docs
//   page's own pin lattice.)
// This file stays as a redirect tombstone so the original guard
// history above remains greppable and the deprecation cannot
// silently regress (page resurrection would shadow the 301 —
// CF Pages serves static assets before _redirects).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(
  REPO_ROOT,
  'apps/marketing-site/src/pages/docs/crypto-orders-polling-vs-webhooks.astro',
);
const REDIRECTS = resolve(REPO_ROOT, 'apps/marketing-site/public/_redirects');
const DOCS_SUCCESSOR_SRC = resolve(REPO_ROOT, 'apps/docs/src/pages/webhooks/crypto-events.md');

describe('S47 redirect tombstone — /docs/crypto-orders-polling-vs-webhooks → https://docs.driftstack.io/webhooks/crypto-events/', () => {
  it('mirror page stays deleted; both _redirects rules (bare + trailing slash) 301 to the live docs successor', () => {
    expect(
      existsSync(PAGE),
      'crypto-orders-polling-vs-webhooks.astro must stay deleted — a restored page file would shadow the 301',
    ).toBe(false);

    const rules = readFileSync(REDIRECTS, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'))
      .map((l) => l.split(/\s+/));
    const rule = (from: string) => rules.find((t) => t[0] === from);

    expect(rule('/docs/crypto-orders-polling-vs-webhooks'), 'bare-path rule missing').toEqual([
      '/docs/crypto-orders-polling-vs-webhooks',
      'https://docs.driftstack.io/webhooks/crypto-events/',
      '301',
    ]);
    expect(
      rule('/docs/crypto-orders-polling-vs-webhooks/'),
      'trailing-slash rule missing (matching is exact-path)',
    ).toEqual([
      '/docs/crypto-orders-polling-vs-webhooks/',
      'https://docs.driftstack.io/webhooks/crypto-events/',
      '301',
    ]);
  });

  it('the docs successor source page still exists (a docs-side rename/move must update the redirect target)', () => {
    expect(existsSync(DOCS_SUCCESSOR_SRC)).toBe(true);
  });
});
