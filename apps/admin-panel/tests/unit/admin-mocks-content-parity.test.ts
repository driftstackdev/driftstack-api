// W383.C — drift guard for admin-panel src/data/mocks.ts. The
// admin scaffolding renders every page from this mocks file pre-
// wiring. Drift in mock shapes desyncs the rendered UI from the
// future live /v1/admin/* contracts. Pins the load-bearing fixture
// shapes:
//
//   • Pre-wiring framing pinned (real reads against /v1/admin/*
//     land when panel moves past scaffolding).
//   • AccountTier import from @driftstack/api-types.
//   • MockAdminAccount: 7 fields incl. status union active/
//     suspended/deleted.
//   • MOCK_ACCOUNTS: 3 fixtures (active/active/suspended) with
//     mixed tiers (api_builder / agency_manual / api_starter).
//   • MockAuditLogEntry result union: success/error. 3 fixtures
//     pinned: account.tier_changed / session.destroyed_by_admin /
//     webhook_delivery.requeued.
//   • MockLead source union: 4 literals (docs_signup / pricing_cta
//     / email_inbound / other).
//   • MOCK_LEADS: 2 fixtures (enterprise/pricing_cta + agency/
//     docs_signup).
//   • MockIncident severity union: minor / major / outage.
//   • MockIncident status union: investigating / identified /
//     monitoring / resolved.
//   • MOCK_INCIDENTS: 1 fixture (api 5xx eu-west-1, major,
//     monitoring) with 3 timeline updates.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const MOCKS = resolve(REPO_ROOT, 'apps/admin-panel/src/data/mocks.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W383.C admin-panel src/data/mocks.ts content parity', () => {
  const body = read(MOCKS);

  it('pre-wiring framing pinned (mock-data for scaffolding, swap to live /v1/admin/* later)', () => {
    expect(body).toMatch(
      /Mock data for admin-panel scaffolding\. Real reads against\s*\n?\s*\/\/\s*\/v1\/admin\/\* land when the panel moves past scaffolding/,
    );
  });

  it('AccountTier imported from @driftstack/api-types (canonical type source)', () => {
    expect(body).toMatch(/import type \{ AccountTier \} from '@driftstack\/api-types';/);
  });

  it('MockAdminAccount: 7 fields incl. status union active/suspended/deleted', () => {
    expect(body).toMatch(/export interface MockAdminAccount \{/);
    expect(body).toMatch(/tier: AccountTier;/);
    expect(body).toMatch(/status: 'active' \| 'suspended' \| 'deleted';/);
    expect(body).toMatch(/lastSeenAt: string \| null;/);
  });

  it('MOCK_ACCOUNTS: 3 fixtures (active/active/suspended) with mixed tiers', () => {
    expect(body).toMatch(
      /email: 'tester@driftstack\.local',[\s\S]+?tier: 'api_builder',[\s\S]+?status: 'active',/,
    );
    expect(body).toMatch(
      /email: 'agency@driftstack\.local',[\s\S]+?tier: 'agency_manual',[\s\S]+?status: 'active',/,
    );
    expect(body).toMatch(
      /email: 'suspended@driftstack\.local',[\s\S]+?tier: 'api_starter',[\s\S]+?status: 'suspended',/,
    );
  });

  it('MockAuditLogEntry result union: success/error', () => {
    expect(body).toMatch(/result: 'success' \| 'error';/);
  });

  it('MOCK_AUDIT_LOG: 3 fixtures with action canonical names', () => {
    expect(body).toMatch(/action: 'account\.tier_changed',/);
    expect(body).toMatch(/action: 'session\.destroyed_by_admin',/);
    expect(body).toMatch(/action: 'webhook_delivery\.requeued',/);
    expect(body).toMatch(/adminEmail: 'staff@driftstack\.dev',/);
  });

  it('MockLead source union: 4 literals (docs_signup / pricing_cta / email_inbound / other)', () => {
    expect(body).toMatch(/source: 'docs_signup' \| 'pricing_cta' \| 'email_inbound' \| 'other';/);
  });

  it('MOCK_LEADS: 2 fixtures (enterprise/pricing_cta + agency/docs_signup)', () => {
    expect(body).toMatch(/email: 'enterprise@example\.test',[\s\S]+?source: 'pricing_cta',/);
    expect(body).toMatch(/email: 'agency@example\.test',[\s\S]+?source: 'docs_signup',/);
    expect(body).toMatch(/Asked about self-hosted enterprise \+ custom archetype dev/);
  });

  it('MockIncidentSeverity union: minor / major / outage', () => {
    expect(body).toMatch(/export type MockIncidentSeverity = 'minor' \| 'major' \| 'outage';/);
  });

  it('MockIncidentStatus union: investigating / identified / monitoring / resolved (4 statuses)', () => {
    expect(body).toMatch(
      /export type MockIncidentStatus = 'investigating' \| 'identified' \| 'monitoring' \| 'resolved';/,
    );
  });

  it('MockIncident: full shape incl. affectedComponents string[] + public boolean + resolvedAt nullable + updates array', () => {
    expect(body).toMatch(/affectedComponents: string\[\];/);
    expect(body).toMatch(/public: boolean;/);
    expect(body).toMatch(/resolvedAt: string \| null;/);
    expect(body).toMatch(/updates: MockIncidentUpdate\[\];/);
  });

  it('MOCK_INCIDENTS: 1 fixture (api 5xx eu-west-1, major, monitoring) with affectedComponents = [api, sessions]', () => {
    expect(body).toMatch(/title: 'API server elevated 5xx — eu-west-1',/);
    expect(body).toMatch(/severity: 'major',/);
    expect(body).toMatch(/status: 'monitoring',/);
    expect(body).toMatch(/affectedComponents: \['api', 'sessions'\],/);
    expect(body).toMatch(/public: true,/);
  });

  it('MOCK_INCIDENTS update timeline: 3 entries (investigating → identified → monitoring)', () => {
    expect(body).toMatch(
      /Investigating elevated error rate on \/v1\/sessions\/create after 14:02 UTC deploy/,
    );
    expect(body).toMatch(
      /Cause identified — rate-limiter regression in deploy 0a3f\. Rolling back/,
    );
    expect(body).toMatch(/Rollback complete; error rate is back to baseline\. Monitoring/);
  });

  it('@driftstack/api-types package exists (canonical source)', () => {
    expect(existsSync(resolve(REPO_ROOT, 'packages/api-types/package.json'))).toBe(true);
  });
});
