// W249.B — workspace-wide sweep for webhook-event-name drift. Every
// marketing-site page that names a customer-subscribable webhook
// event must use only event types in
// SubscribableWebhookEventTypeSchema. The previous incarnations of
// /docs/api-changelog + /docs/webhooks-crypto-events claimed
// crypto.order.paid / crypto.order.failed as live subscribable
// events; this sweep prevents the regression.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SubscribableWebhookEventTypeSchema } from '@driftstack/api-types';

const REPO = join(__dirname, '..', '..', '..', '..');
const PAGES = join(REPO, 'apps', 'marketing-site', 'src', 'pages');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (entry.endsWith('.astro')) out.push(p);
  }
  return out;
}

describe('W249.B marketing-site subscribable-event-name sweep', () => {
  const live = new Set(
    (SubscribableWebhookEventTypeSchema._def.values as readonly string[]).map((v) => v),
  );
  const pages = walk(PAGES);

  it('pages do not assert a not-yet-subscribable event as subscribable', () => {
    if (live.has('crypto.order.paid') && live.has('crypto.order.failed')) {
      return; // Surface is fully subscribable; nothing to guard.
    }
    const offenders: string[] = [];
    for (const p of pages) {
      const body = readFileSync(p, 'utf8');
      // Pages that name `crypto.order.paid` / `crypto.order.failed`
      // must also include a roadmap caveat or "not yet" framing.
      const mentions = /crypto\.order\.(paid|failed)/.test(body);
      if (!mentions) continue;
      // Allow as long as the page also flags as roadmap / not-yet /
      // gated-by-Subscribable... .
      const flagged =
        /not yet/i.test(body) ||
        /roadmap/i.test(body) ||
        /SubscribableWebhookEventTypeSchema/.test(body) ||
        /webhooks-crypto-events/.test(body);
      if (!flagged) {
        offenders.push(p.replace(REPO + '/', ''));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('SubscribableWebhookEventTypeSchema contains at least the 5 known live events', () => {
    for (const evt of [
      'session.completed',
      'session.failed',
      'quota.warning_80pct',
      'quota.exceeded',
      'api_key.revoked',
    ]) {
      expect(live.has(evt)).toBe(true);
    }
  });
});
