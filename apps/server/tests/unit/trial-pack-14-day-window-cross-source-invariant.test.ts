// Cross-source invariant: trial-pack 14-day window appears in 4+
// places — services/stripe-webhooks DEFAULT_TRIAL_PACK_WINDOW_MS
// constant + customer-facing email body + email-preferences enum
// description + billing docs + webhooks/events.md.
// Drift would either expire trial packs too early ("I was promised
// 14 days!") or hold them past intent.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const STRIPE = resolve(REPO_ROOT, 'apps/server/src/services/stripe-webhooks.ts');
const EMAIL = resolve(REPO_ROOT, 'apps/server/src/services/email.ts');
const EMAIL_PREFS = resolve(REPO_ROOT, 'apps/docs/src/pages/api/email-preferences.md');
const BILLING_DOCS = resolve(REPO_ROOT, 'apps/docs/src/pages/api/billing.md');
const WEBHOOKS_EVENTS = resolve(REPO_ROOT, 'apps/docs/src/pages/webhooks/events.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('trial-pack 14-day-window cross-source invariant', () => {
  const stripe = read(STRIPE);
  const email = read(EMAIL);
  const emailPrefs = read(EMAIL_PREFS);
  const billingDocs = read(BILLING_DOCS);
  const webhookEvents = read(WEBHOOKS_EVENTS);

  it('services/stripe-webhooks DEFAULT_TRIAL_PACK_WINDOW_MS = 14 * 24 * 60 * 60 * 1000 + ADR-003 cross-reference', () => {
    expect(stripe).toMatch(/const DEFAULT_TRIAL_PACK_WINDOW_MS = 14 \* 24 \* 60 \* 60 \* 1000;/);
    expect(stripe).toMatch(/Provision a trial-pack purchase per ADR-003: 299¢ credit, 14-day/);
  });

  it("services/email.ts trial-pack-purchased body claims '14 days' window + trial-pack-expired body claims '14-day window closed'", () => {
    expect(email).toMatch(/\(UTC, 14 days\)/);
    expect(email).toMatch(/Your Driftstack trial pack has expired \(14-day window closed\)/);
  });

  it("docs/api/email-preferences.md trial-pack-expired row description: '14-day window closed'", () => {
    expect(emailPrefs).toMatch(
      /\|\s*`trial-pack-expired`\s+\|\s+14-day window closed\s+\|\s+opt-in/,
    );
  });

  it("docs/api/billing.md customer copy references the 14-day window: 'credit and the 14-day window hasn't elapsed.'", () => {
    expect(billingDocs).toMatch(/credit and the 14-day window hasn't elapsed\./);
  });

  it("docs/webhooks/events.md trial_pack.expired entry description: 'Trial pack expired (14-day window closed)'", () => {
    expect(webhookEvents).toMatch(
      /\|\s*`trial_pack\.expired`\s+\|\s+\[PLANNED\]\s+\|\s+Trial pack expired \(14-day window closed\)/,
    );
  });
});
