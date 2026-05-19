// Drift guard for apps/server/src/db/incident-update-notifications-repo.ts.
// Pins V-545.B Phase 2 throttle marker table. Tiny surface — one read
// + one upsert (idempotent on subscriber_id + incident_id) — enforces
// the "max 1 per subscriber per incident per hour" cap on incident-
// updated status emails.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/db/incident-update-notifications-repo.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('db/incident-update-notifications-repo content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });

  it('V-545.B Phase 2 module-level framing pinned: \'repo for incident_update_notifications (the throttle marker table). IncidentNotificationsService consults it before dispatching a status-incident-updated email to enforce the "max 1 per subscriber per incident per hour" cap.\' — pinned so the V-545.B-Phase-2 anchor + throttle-marker purpose + 1-per-hour cap + IncidentNotificationsService consumer contract all stay documented', () => {
    expect(body).toMatch(
      /\/\/ V-545\.B Phase 2 — repo for `incident_update_notifications` \(the\s*\n?\s*\/\/ throttle marker table\)\. IncidentNotificationsService consults it\s*\n?\s*\/\/ before dispatching a `status-incident-updated` email to enforce\s*\n?\s*\/\/ the "max 1 per subscriber per incident per hour" cap\./,
    );
  });

  it("Tiny-surface + InMemory-test-seam framing pinned: 'Tiny surface — one read + one upsert. Drizzle implementation + InMemory test seam.' — pinned so the 2-method-surface + test-double-pattern contract stays documented", () => {
    expect(body).toMatch(
      /\/\/ Tiny surface — one read \+ one upsert\. Drizzle implementation \+\s*\n?\s*\/\/ InMemory test seam\./,
    );
  });

  it('IncidentUpdateNotificationsRepo 2-method interface pinned: findLastSentAt (returns most-recent last_sent_at for (subscriber, incident) pair, or null) + markSent (upserts row with last_sent_at = at; idempotent on (subscriber_id, incident_id)). Drift to dropping idempotency would let the throttle marker explode under concurrent dispatch races', () => {
    expect(body).toMatch(
      /export interface IncidentUpdateNotificationsRepo \{\s*\n?\s*\/\*\* Returns the most-recent `last_sent_at` for the \(subscriber,\s*\n?\s*\*\s+incident\) pair, or null if no row exists yet\. \*\/\s*\n?\s*findLastSentAt\(subscriberId: string, incidentId: string\): Promise<Date \| null>;\s*\n?\s*\/\*\* Upserts the row with last_sent_at = `at`\. Idempotent on\s*\n?\s*\*\s+\(subscriber_id, incident_id\)\. \*\/\s*\n?\s*markSent\(subscriberId: string, incidentId: string, at: Date\): Promise<void>;\s*\n?\s*\}/,
    );
  });

  it("findLastSentAt and-eq-(subscriberId+incidentId) + lastSentAt ?? null framing pinned: composite WHERE on both keys + .limit(1) + row?.lastSentAt ?? null. Drift to dropping the limit(1) would scan the whole table on every cache miss; drift to dropping the ?? null fallback would surface undefined to the caller's null-check", () => {
    expect(body).toMatch(
      /\.where\(\s*\n?\s*and\(\s*\n?\s*eq\(incidentUpdateNotifications\.subscriberId, subscriberId\),\s*\n?\s*eq\(incidentUpdateNotifications\.incidentId, incidentId\),\s*\n?\s*\),\s*\n?\s*\)\s*\n?\s*\.limit\(1\);\s*\n?\s*return row\?\.lastSentAt \?\? null;/,
    );
  });

  it('markSent onConflictDoUpdate target composite + sql`excluded.last_sent_at` framing pinned: target: [subscriberId, incidentId] composite + set: { lastSentAt: sql`excluded.last_sent_at` }. Drift to ON CONFLICT DO NOTHING would leave a stale lastSentAt across multiple throttle ticks; drift to a non-composite conflict target would crash with multi-key conflict errors', () => {
    expect(body).toMatch(
      /\.insert\(incidentUpdateNotifications\)\s*\n?\s*\.values\(\{ subscriberId, incidentId, lastSentAt: at \}\)\s*\n?\s*\.onConflictDoUpdate\(\{\s*\n?\s*target: \[incidentUpdateNotifications\.subscriberId, incidentUpdateNotifications\.incidentId\],\s*\n?\s*set: \{ lastSentAt: sql`excluded\.last_sent_at` \},\s*\n?\s*\}\);/,
    );
  });
});
