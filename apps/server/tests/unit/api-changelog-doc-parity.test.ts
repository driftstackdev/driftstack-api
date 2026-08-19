// W245.A — drift-guard for /docs/api-changelog. The page is the
// public summary of API changes; previous revision asserted a
// 6-month deprecation window (contradicting api-versioning's 90 days)
// and framed crypto.order.paid / crypto.order.failed as live customer
// webhooks (they aren't — emitted server-side but gated behind
// SubscribableWebhookEventTypeSchema).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SubscribableWebhookEventTypeSchema } from '@driftstack/api-types';

const REPO = join(__dirname, '..', '..', '..', '..');
const DOC_PATH = join(
  REPO,
  'apps',
  'marketing-site',
  'src',
  'pages',
  'docs',
  'api-changelog.astro',
);
const VERSIONING = join(
  REPO,
  'apps',
  'marketing-site',
  'src',
  'pages',
  'docs',
  'api-versioning.astro',
);

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('W245.A api-changelog doc parity', () => {
  const doc = read(DOC_PATH);
  const versioning = read(VERSIONING);

  it('aligns deprecation window with /docs/api-versioning', () => {
    // versioning policy says "Day 90+" / 90-day window.
    expect(versioning).toMatch(/Day 90\+/);
    expect(versioning).toMatch(/90/);
    // changelog should not assert a contradicting 6-month window.
    expect(doc).not.toMatch(/6-month\s*sunset/i);
    // And should explicitly reference the 90-day window.
    expect(doc).toMatch(/90-day\s+deprecation/i);
  });

  const live = new Set(
    (SubscribableWebhookEventTypeSchema._def.values as readonly string[]).map((v) => v),
  );
  const cryptoIsLive = live.has('crypto.order.paid');

  it('CRITICAL the subscribability gate was computed and has RETIRED. V-666 added crypto.order.paid to the enum, so the arm below stopped asserting anything and kept reporting as a pass — and what it forbids is the very framing that became correct.', () => {
    expect(live.size, 'the enum was really read').toBeGreaterThan(3);
    expect(cryptoIsLive, 'crypto.order.paid is subscribable, so the framing gate has retired').toBe(
      true,
    );
  });

  it.skipIf(cryptoIsLive)(
    'framings for crypto.order.* events match SubscribableWebhookEventTypeSchema gating',
    () => {
      // Doc must NOT call these "fires" as customer webhooks.
      expect(doc).not.toMatch(/<strong>Webhooks — <code>crypto\.order\.(paid|failed)<\/code>/);
      // Doc must caveat customer subscription as roadmap somewhere
      // referencing the gating schema.
      expect(doc).toMatch(/SubscribableWebhookEventTypeSchema/);
    },
  );

  it('cross-links to api-versioning + webhooks-crypto-events', () => {
    expect(doc).toMatch(/\/docs\/api-versioning/);
    expect(doc).toMatch(/\/docs\/webhooks-crypto-events/);
  });

  it('preserves the chronological month-grouped structure', () => {
    expect(doc).toMatch(/<h2>2026-05<\/h2>/);
    expect(doc).toMatch(/<h2>2026-04<\/h2>/);
    expect(doc).toMatch(/<h2>2026-03<\/h2>/);
  });
});
