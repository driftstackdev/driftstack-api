// W356.C — drift guard for /status-subscribers admin page. V-312
// admin view of status-page email subscribers. This complements
// W319.A's route-registration parity by pinning the page-content
// claims that an ops engineer relies on when reading the screen.
//
// Pinned:
//   • GET /v1/admin/status-subscribers + POST
//     /v1/admin/status-subscribers/:id/force-unsubscribe both
//     registered server-side.
//   • Force-unsubscribe writes admin_audit_log via V-281 dual-write
//     ↔ status_subscriber.force_unsubscribed action string.
//   • 90-day tombstone purge claim ↔ retentionMs default in the
//     status-subscribers service (V-295c3-tombstone).
//   • Tombstoned row → email = null shape pinned (server returns
//     null; the page displays "(purged — V-295c3-tombstone)").
//   • limit=200 page-side fetch ↔ Zod max(200) on the route's
//     ListQuerySchema (so a tighter clamp here would 400).
//   • V-295c3-followup fan-out framing (confirmed-and-still-
//     subscribed rows trigger fan-out on incident state changes)
//     stays pinned — this is the load-bearing copy.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/admin-panel/src/pages/status-subscribers.astro');
const ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/admin-status-subscribers.ts');
const SERVICE = resolve(REPO_ROOT, 'apps/server/src/services/status-subscribers.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W356.C /status-subscribers admin page parity', () => {
  const body = read(PAGE);
  const route = read(ROUTE);
  const service = read(SERVICE);

  it('GET /v1/admin/status-subscribers + force-unsubscribe both registered server-side', () => {
    expect(route).toContain("'/v1/admin/status-subscribers'");
    expect(route).toContain("'/v1/admin/status-subscribers/:id/force-unsubscribe'");
    // Both endpoints are also wired into the page.
    expect(body).toContain('/v1/admin/status-subscribers?limit=200');
    expect(body).toMatch(
      /\/v1\/admin\/status-subscribers\/'\s*\+\s*encodeURIComponent\(id\)\s*\+\s*'\/force-unsubscribe/,
    );
  });

  it('force-unsubscribe writes admin_audit_log via V-281 dual-write', () => {
    expect(body).toMatch(/Force-unsubscribe writes admin_audit_log/);
    expect(body).toMatch(/V-281 dual-write/);
    expect(route).toContain("'status_subscriber.force_unsubscribed'");
  });

  it('90-day tombstone purge claim matches retentionMs default in the service', () => {
    expect(body).toMatch(/90d post-unsubscribe via\s*V-295c3-tombstone purge cron/);
    // The service's retentionMs default is the 90d constant.
    expect(service).toMatch(
      /retentionMs:\s*number\s*=\s*90\s*\*\s*24\s*\*\s*60\s*\*\s*60\s*\*\s*1000/,
    );
  });

  it('tombstoned-row shape: email = null + "(purged — V-295c3-tombstone)" UI placeholder', () => {
    expect(body).toMatch(/Tombstoned rows.*email\s*=\s*<code>null<\/code>/s);
    expect(body).toContain('(purged — V-295c3-tombstone)');
  });

  it('page-side fetch limit=200 stays within the route Zod max', () => {
    expect(body).toContain('?limit=200');
    // ListQuerySchema enforces max(200) — page would 400 if it
    // asked for more.
    expect(route).toMatch(/limit:\s*z\.coerce\.number\(\)\.int\(\)\.min\(1\)\.max\(200\)/);
  });

  it('V-295c3-followup fan-out framing pinned (the load-bearing copy)', () => {
    expect(body).toMatch(/Confirmed\s+subscribers receive emails when public incidents/);
    expect(body).toMatch(/V-295c3-followup\s+fan-out/);
    // Re-stated near the bottom as well.
    expect(body).toMatch(
      /Confirmed-and-still-subscribed rows trigger fan-out emails on\s+public incident state changes/,
    );
  });

  it('confirm-modal copy on force-unsubscribe pinned (admin-action transparency)', () => {
    // The browser confirm() is the only barrier between an admin
    // click and a row mutation; the copy must continue to spell out
    // that admin_audit_log is written + that the customer can
    // re-subscribe via the public form.
    expect(body).toMatch(/Force-unsubscribe '\s*\+\s*\n?\s*email/);
    expect(body).toMatch(/Writes admin_audit_log/);
    expect(body).toMatch(/Customer can re-subscribe via the public form/);
  });

  it('admin token read from localStorage under driftstack_admin_token key (admin-panel convention)', () => {
    // Same key the rest of admin-panel uses — a rename here
    // without a coordinated migration would silently lock every
    // admin out of the page.
    expect(body).toContain("'driftstack_admin_token'");
  });

  it('three status-badge slots cover the schema row states (pending / confirmed / unsubscribed)', () => {
    // V-295c3 row state machine: unconfirmed → confirmed → unsubscribed.
    // The page renders all three; if a server-side enum flip drops
    // one of these the rendered set silently shrinks.
    expect(body).toMatch(/>pending</);
    expect(body).toMatch(/>confirmed</);
    expect(body).toMatch(/unsubscribed '\s*\+/);
  });
});
