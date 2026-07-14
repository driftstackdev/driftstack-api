// W243.A — drift-guard for /docs/incident-policy. The previous
// revision invented an `incident_subscriptions` field on
// GET /v1/account/me, framed `incident.*` as subscribable webhook
// events (they aren't), and documented a snake_case SLA response
// shape that doesn't match the live camelCase output. This guard
// pins the doc to the actual endpoints + payload shapes.

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
  'incident-policy.astro',
);
const SLA_SVC = join(REPO, 'apps', 'server', 'src', 'services', 'sla-reporting.ts');

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('W243.A incident-policy doc parity', () => {
  const doc = read(DOC_PATH);
  // Strip the Astro frontmatter comment block — design notes in there
  // legitimately mention removed/fictional terms.
  const body = doc.replace(/^---[\s\S]*?---/, '');
  const sla = read(SLA_SVC);

  it('does not invent an incident_subscriptions account field', () => {
    expect(body).not.toMatch(/incident_subscriptions/);
  });

  it('identifies incident.* as internal events rather than customer webhooks', () => {
    const live = new Set(
      (SubscribableWebhookEventTypeSchema._def.values as readonly string[]).map((v) => v),
    );
    if (!live.has('incident.created')) {
      expect(body).toMatch(
        /are admin-audit \/ internal SSE event types, not customer webhook\s+subscription values/,
      );
      expect(body).toMatch(/Email subscription is the customer-facing\s+notification path/);
      expect(body).not.toMatch(/Webhook event type is\s*<code>incident\.created<\/code>/i);
      expect(body).not.toMatch(/not yet|future webhook/i);
    }
  });

  it('SLA response uses camelCase keys matching SlaTargetReport', () => {
    // Confirm the service exports camelCase keys.
    expect(sla).toMatch(/uptimePct:/);
    expect(sla).toMatch(/totalProbes:/);
    expect(sla).toMatch(/lastFailureAt:/);
    expect(sla).toMatch(/windowStart:/);
    // Doc reflects them.
    expect(doc).toMatch(/uptimePct/);
    expect(doc).toMatch(/totalProbes/);
    expect(doc).toMatch(/lastFailureAt/);
    expect(doc).toMatch(/windowStart/);
    expect(doc).toMatch(/windowEnd/);
  });

  it('SLA response is wrapped in a `data` envelope, not `targets`', () => {
    expect(doc).toMatch(/"data":\s*\[/);
    expect(doc).not.toMatch(/"targets":\s*\[/);
  });

  it('does not document a fictional ?window_days query param on /v1/status/sla', () => {
    expect(doc).not.toMatch(/\?window_days=/);
  });

  it('points at /docs/sla-policy as the authoritative tier-target source', () => {
    expect(doc).toMatch(/\/docs\/sla-policy/);
  });

  it('uses the canonical status-subscription endpoint', () => {
    expect(doc).toMatch(/POST \/v1\/status\/subscribe/);
  });
});
