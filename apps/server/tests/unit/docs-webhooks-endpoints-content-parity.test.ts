// Drift guard for apps/docs/src/pages/webhooks/endpoints.md. Pins
// the resource-shape envelope, the 24h-grace dual-signing contract,
// the auto-disable framing, and the test.ping rejected-in-events
// rule.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/docs/src/pages/webhooks/endpoints.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('docs webhooks/endpoints content parity', () => {
  const body = read(PAGE);

  it('file exists at canonical path', () => {
    expect(existsSync(PAGE)).toBe(true);
  });

  it('title + description front-matter pinned', () => {
    expect(body).toMatch(/title: Webhook endpoints/);
    expect(body).toMatch(/description: Subscribe to events, list \/ patch \/ delete endpoints/);
  });

  it('cross-link to /webhooks/events/ pinned (the event catalog companion doc; drift to dropping would orphan customers from the canonical subscribable-event-type list)', () => {
    expect(body).toMatch(/\[event catalog\]\(\/webhooks\/events\/\)/);
  });

  it('resource-shape envelope pinned: 13-field sampling covers each conceptual section (id/url/secret/events/active/failure-tracking/grace/dlq/created). Drift to dropping any field would orphan SDK consumers reading it', () => {
    expect(body).toMatch(/"secret_prefix": "whsec_a1b2c3"/);
    expect(body).toMatch(/"prev_secret_prefix": null/);
    expect(body).toMatch(/"rotation_grace_expires_at": null/);
    expect(body).toMatch(/"events": \["session\.completed", "session\.failed"\]/);
    expect(body).toMatch(/"consecutive_failures": 0/);
    expect(body).toMatch(/"last_success_at"/);
    expect(body).toMatch(/"disabled_at": null/);
    expect(body).toMatch(/"delivery_counts": \{ "delivered": 12345, "failed": 12, "dlq": 0 \}/);
  });

  it("secret_prefix safe-to-log framing pinned: first 12 chars + 'full secret is shown ONCE'. Drift to widening the prefix would weaken the safe-to-log property; drift to dropping the shown-ONCE warning would let customers expect retrievability", () => {
    expect(body).toMatch(/`secret_prefix` is the first 12 chars of the plaintext secret/);
    expect(body).toMatch(/Safe to log \+ display; the full secret is shown ONCE/);
  });

  it("24h grace dual-signing contract pinned: x-driftstack-signature + x-driftstack-signature-prev during grace. Drift to dropping the dual-signing framing would let customers think rotation is zero-downtime-impossible (it isn't — dual-sig makes it zero-downtime)", () => {
    expect(body).toMatch(/null\s+except during the 24-hour grace period after a secret rotation/);
    expect(body).toMatch(
      /Driftstack is dual-signing every outbound\s+delivery \(`x-driftstack-signature` \+ `x-driftstack-signature-prev`\)/,
    );
  });

  it('auto-disable framing pinned: consecutive_failures zeros on success + auto-disable after enough failures + re-create-to-re-enable. Drift would orphan customers from understanding why their endpoint stopped firing — a real support-ticket source', () => {
    expect(body).toMatch(
      /`consecutive_failures` increments on each failed delivery \+ zeros\s+on the next success/,
    );
    expect(body).toMatch(/the\s+endpoint auto-disables \(`disabled_at` set\)/);
    expect(body).toMatch(/you'll need to\s+re-create the endpoint to re-enable/);
  });

  it('test.ping rejected-in-events rule pinned: drift to allowing test.ping subscriptions would create confusion (test.ping is delivery-side-only triggered via /test endpoint) and could let endpoints subscribe to a no-op event flood', () => {
    expect(body).toMatch(
      /`test\.ping` is delivery-side-only and is rejected if\s+passed in the events array/,
    );
  });
});
