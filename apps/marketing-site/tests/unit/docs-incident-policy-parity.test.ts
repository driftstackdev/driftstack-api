// W344.A — drift guard for /docs/incident-policy. The page makes
// concrete claims about:
//
//   • severity ladder (Outage / Major / Minor), matching the incident_severity enum.
//     Maintenance is listed but labelled NOT an incident severity (V-772).
//     with response-time + cadence commitments
//   • status-page endpoints — GET /v1/status, GET /v1/status/incidents,
//     POST /v1/status/subscribe, GET /v1/status/sla — all must be
//     registered server-side
//   • GET /v1/status/sla response shape uses camelCase + a `data:`
//     envelope (the page block previously claimed a snake_case shape
//     which the server doesn't emit)
//   • incident.created / .updated / .resolved are NOT in
//     SubscribableWebhookEventTypeSchema today (admin-audit only)
//   • cross-link to /docs/sla-policy as the authoritative SLA ref

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SubscribableWebhookEventTypeSchema } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/docs/incident-policy.astro');
const ROUTES_DIR = resolve(REPO_ROOT, 'apps/server/src/routes');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

function allRoutes(): string {
  return readdirSync(ROUTES_DIR)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => readFileSync(resolve(ROUTES_DIR, f), 'utf8'))
    .join('\n');
}

describe('W344.A /docs/incident-policy parity', () => {
  const body = read(PAGE);
  // The status surface is intentionally split across four route
  // files (status.ts, status-subscribe.ts, status-stream.ts,
  // admin-incidents.ts) — walk the whole dir.
  const routes = allRoutes();

  it('cites every status endpoint and the server registers each one', () => {
    for (const path of [
      '/v1/status',
      '/v1/status/incidents',
      '/v1/status/subscribe',
      '/v1/status/sla',
    ]) {
      expect(body).toContain(path);
      expect(routes).toContain(`'${path}'`);
    }
  });

  it('lists every severity tier (Outage / Major / Minor), plus Maintenance marked as not one — V-772: the top row said Critical, which no code path can file (enum is minor|major|outage)', () => {
    for (const sev of ['Outage', 'Major', 'Minor', 'Maintenance']) {
      expect(body).toMatch(new RegExp(`<strong>${sev}</strong>`));
    }
  });

  it('Outage commits to a ≤ 15-minute first-update SLO and 30-min cadence — the cadence is UNCHANGED by V-772, only the label now matches what is filed', () => {
    // The most customer-visible promise; if a comms revamp tones it
    // down, the test catches it.
    expect(body).toMatch(/Outage[\s\S]{0,400}≤ 15 min/);
    expect(body).toMatch(/Outage[\s\S]{0,400}Every 30 min/);
  });

  it('Maintenance is announced ≥ 48 hours in advance', () => {
    expect(body).toMatch(/Maintenance[\s\S]{0,200}≥48h in advance/);
  });

  it('SLA-data block uses camelCase keys + data envelope (matches server serialiser)', () => {
    // The /v1/status/sla response is the SLA report serialised
    // directly — camelCase, wrapped in a `data: [...]` envelope.
    // Pin all five canonical fields so a future snake_case rename
    // doesn't silently land in the doc.
    expect(body).toContain('"data":');
    for (const key of [
      'uptimePct',
      'totalProbes',
      'okCount',
      'failCount',
      'windowStart',
      'windowEnd',
    ]) {
      expect(body).toContain(`"${key}":`);
    }
  });

  it('SLA window is documented as a fixed rolling 30 days', () => {
    expect(body).toMatch(/fixed rolling\s+30 days/);
  });

  it('incident.* events are NOT in SubscribableWebhookEventTypeSchema (admin-audit only)', () => {
    // The page calls this out explicitly; pin the negative
    // assertion both in the doc and against the live schema.
    const schemaEvents = new Set<string>(
      (SubscribableWebhookEventTypeSchema._def as { values: readonly string[] }).values,
    );
    expect(schemaEvents.has('incident.created')).toBe(false);
    expect(schemaEvents.has('incident.updated')).toBe(false);
    expect(schemaEvents.has('incident.resolved')).toBe(false);
    expect(body).toMatch(/incident\.created[\s\S]{0,200}admin-audit/);
  });

  it('cites SLA policy + status-subscriptions docs as the authoritative cross-links', () => {
    expect(body).toContain('/docs/sla-policy');
    expect(body).toContain('/docs/status-subscriptions');
  });

  it('exposes urgent + support + security contact channels', () => {
    expect(body).toContain('urgent@driftstack.dev');
    expect(body).toContain('support@driftstack.dev');
    expect(body).toContain('security@driftstack.dev');
  });

  it('postmortem commitment for Outage/Major within 7 business days', () => {
    expect(body).toMatch(/Outage \/ Major incidents[\s\S]{0,200}within 7 business days/);
  });
});
