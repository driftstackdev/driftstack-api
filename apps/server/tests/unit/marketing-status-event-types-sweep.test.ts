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

  it('pages do not publish the retired quota webhook declarations', () => {
    const offenders: string[] = [];
    for (const p of pages) {
      const body = readFileSync(p, 'utf8');
      if (/quota\.warning_80pct|quota\.exceeded/.test(body)) {
        offenders.push(p.replace(REPO + '/', ''));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('SubscribableWebhookEventTypeSchema contains the 8 known live events', () => {
    for (const evt of [
      'session.completed',
      'session.failed',
      'api_key.revoked',
      'session.egress_capability_changed',
      'crypto.order.paid',
      'crypto.order.failed',
      'session.challenge_detected',
      'session.profile_save_failed',
    ]) {
      expect(live.has(evt)).toBe(true);
    }
    expect(live.has('quota.warning_80pct')).toBe(false);
    expect(live.has('quota.exceeded')).toBe(false);
  });
});
