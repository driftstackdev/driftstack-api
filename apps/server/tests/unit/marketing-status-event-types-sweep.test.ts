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
  // Vacuity arm. Every assertion below reports an ABSENCE, and an absence is
  // vacuously true over an empty scan — so a filter that stops matching (a
  // rename, a new extension, a moved page root) would make this guard report
  // clean forever while checking nothing. Measured, not hypothetical: pointing
  // the extension filter at a non-existent suffix left this file GREEN.
  it('CRITICAL the scan found real pages, so a clean result means checked rather than not looked.', () => {
    // V-939 — floor raised to just under the measured 61; it stood at 5, so this
    // scan could have lost 92% of its corpus and still called itself non-vacuous.
    expect(pages.length, 'marketing-site .astro pages scanned').toBeGreaterThan(55);

    // V-1458 — and that the pages still NAME webhook events, which is what makes
    // the absence below a checked absence.
    //
    // A page floor cannot carry this arm on its own. The retired-name check is
    // satisfied by a corpus that never mentions events at all, and that is not a
    // hypothetical shape here: `marketing-tier-caps-sweep` went silently vacuous
    // in exactly that way when its per-tier numbers moved out of markup into
    // `src/data/pricing.ts` while every page it walks stayed present and counted.
    // If the event names took the same route into a data module, this file would
    // keep reporting a clean absence over pages that no longer discuss events.
    //
    // Counted against the LIVE enum rather than a written list, so retiring an
    // event moves this number without anyone editing this arm. 46 mentions across
    // all 8 subscribable types today; floored well under so ordinary copy edits
    // do not red the build, while the corpus losing the subject does.
    const mentions = pages.reduce((total, p) => {
      const body = readFileSync(p, 'utf8');
      return total + [...live].filter((evt) => body.includes(evt)).length;
    }, 0);
    expect(
      mentions,
      'no marketing page names any live webhook event — the retired-name check below has nothing to look at',
    ).toBeGreaterThan(15);
  });

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
