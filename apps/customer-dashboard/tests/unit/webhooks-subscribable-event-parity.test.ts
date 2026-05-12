// W341.B — drift guard for the /webhooks page event-subscription
// checkboxes. The page renders TWO sets of `<input type="checkbox"
// name="event" value="…">` controls (one in the create form, one
// in the edit form). Both must:
//
//   1. enumerate exactly the SubscribableWebhookEventTypeSchema set
//      (no missing event, no fictional event), and
//   2. agree with each other — drift between create + edit forms
//      means a user can edit to a state they couldn't have created.
//
// Catches: V-NNN adding a new subscribable event without wiring the
// checkbox (silently invisible to the user); the inverse case of an
// event removed from the schema without removing the checkbox
// (server 422s on the unrecognised event name).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SubscribableWebhookEventTypeSchema } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/webhooks.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W341.B /webhooks event-checkbox parity', () => {
  const page = read(PAGE);
  const schemaEvents = new Set<string>(
    (SubscribableWebhookEventTypeSchema._def as { values: readonly string[] }).values,
  );

  // Every `<input type="checkbox" name="event" value="…">` on the
  // page, deduplicated by value. There are two form blocks (create
  // + edit) so the same value should appear twice; we collect the
  // set first to validate against the schema, then count occurrences
  // to validate parity between the two forms.
  const valueMatches = [
    ...page.matchAll(/<input\s+type="checkbox"\s+name="event"\s+value="([^"]+)"/g),
  ].map((m) => m[1]!);

  it('every checkbox value is in SubscribableWebhookEventTypeSchema', () => {
    const offenders = [...new Set(valueMatches)].filter((v) => !schemaEvents.has(v));
    expect(offenders).toEqual([]);
  });

  it('every schema event has at least one checkbox on the page', () => {
    const onPage = new Set(valueMatches);
    const missing = [...schemaEvents].filter((e) => !onPage.has(e));
    expect(missing).toEqual([]);
  });

  it('every event appears exactly twice (once in create form, once in edit form)', () => {
    const counts = new Map<string, number>();
    for (const v of valueMatches) counts.set(v, (counts.get(v) ?? 0) + 1);
    const offenders = [...counts.entries()].filter(([, n]) => n !== 2);
    expect(offenders).toEqual([]);
  });

  it('test.ping is NOT exposed as a subscribable checkbox (dispatch is always-on)', () => {
    // test.ping is in WebhookEventTypeSchema (broader set) but
    // intentionally NOT in SubscribableWebhookEventTypeSchema —
    // every endpoint receives test.ping when /test is hit
    // regardless of subscription. Pin that exclusion.
    expect(valueMatches).not.toContain('test.ping');
    expect(schemaEvents.has('test.ping')).toBe(false);
  });

  it('page pins the HMAC-SHA256 + 5-minute tolerance posture (signing baseline)', () => {
    expect(page).toMatch(/HMAC-SHA256-signed/);
    expect(page).toMatch(/5-minute timestamp tolerance/);
  });

  it('page cites verifyWebhookSignature SDK helper for verification', () => {
    expect(page).toContain('verifyWebhookSignature');
  });

  it('page pins the 10-second delivery timeout (matches server-side default)', () => {
    expect(page).toMatch(/2xx within 10s/);
  });
});
