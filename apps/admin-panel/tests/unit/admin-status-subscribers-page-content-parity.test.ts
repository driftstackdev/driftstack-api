// W380.B — drift guard for admin-panel /status-subscribers.astro
// page content. Existing admin-status-subscribers-page-parity +
// status-subscribers-route-parity cover route shape; this guard
// pins the load-bearing V-312 admin-surface claims:
//
//   • V-312 framing (admin view of status-page email subscribers).
//   • V-295c3 fan-out + V-295c3-tombstone purge cron framing.
//   • V-281 audit-log dual-write framing.
//   • GET /v1/admin/status-subscribers?limit=200 inline.
//   • POST /v1/admin/status-subscribers/{id}/force-unsubscribe.
//   • 3 row states: confirmed (emerald) / pending (amber) /
//     unsubscribed (slate).
//   • Tombstoned-row display: "(purged — V-295c3-tombstone)".
//   • localStorage driftstack_admin_token convention.
//   • window.confirm() force-unsubscribe gate with V-281 explanation.
//   • 50-default + ?limit=&offset= pagination framing in footer.
//   • 90d tombstone purge cron framing.
//   • Banner pattern: role="status" + error-state coloring.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/admin-panel/src/pages/status-subscribers.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W380.B admin-panel /status-subscribers.astro page content parity', () => {
  const body = read(PAGE);

  it('uses AdminLayout title="Status-page subscribers"', () => {
    expect(body).toMatch(/import AdminLayout from '\.\.\/layouts\/AdminLayout\.astro';/);
    expect(body).toMatch(/<AdminLayout title="Status-page subscribers">/);
  });

  it('V-312 + V-295c3 + V-295c3-tombstone framing pinned in page comment', () => {
    expect(body).toMatch(/V-312 — admin view of status-page email subscribers/);
    expect(body).toMatch(/V-295c3 \+\s*\n?\s*\/\/\s*V-295c3-tombstone/);
    expect(body).toMatch(/V-281 pattern/);
  });

  it('hero subtitle pins V-295c3-followup fan-out + V-281 dual-write framing (customer-facing)', () => {
    expect(body).toMatch(
      /Confirmed\s+subscribers receive emails when public incidents are posted or resolved \(V-295c3-followup\s+fan-out\)/,
    );
    expect(body).toMatch(/Force-unsubscribe writes admin_audit_log via V-281 dual-write/);
  });

  it('GET /v1/admin/status-subscribers?limit=200 endpoint pinned. 2026-05-21 — fetch URL prefixed by apiBaseUrl (admin.driftstack.dev is a static Pages origin; relative paths 404).', () => {
    expect(body).toMatch(
      /boundedFetch\(\s*apiBaseUrl \+ '\/v1\/admin\/status-subscribers\?limit=200'/,
    );
    expect(body).toMatch(/authorization: 'Bearer ' \+ token/);
  });

  it('POST /v1/admin/status-subscribers/{id}/force-unsubscribe endpoint pinned. 2026-05-21 — fetch URL prefixed by apiBaseUrl.', () => {
    expect(body).toMatch(
      /boundedFetch\(\s*apiBaseUrl \+ '\/v1\/admin\/status-subscribers\/' \+ encodeURIComponent\(id\) \+ '\/force-unsubscribe'/,
    );
    expect(body).toMatch(/method: 'POST'/);
  });

  it('localStorage ds_web_session_token convention. 2026-05-21 — switched from the legacy `driftstack_admin_token` key (never populated) to the canonical staff bearer the SSO bridge writes.', () => {
    expect(body).toMatch(/localStorage\.getItem\('ds_web_session_token'\)/);
  });

  it('3 subscriber row states pinned (confirmed=emerald / pending=amber / unsubscribed=slate)', () => {
    expect(body).toMatch(
      /<span class="rounded-full bg-emerald-50 px-2 py-0\.5 text-xs font-medium uppercase tracking-wide text-emerald-700">confirmed<\/span>/,
    );
    expect(body).toMatch(
      /<span class="rounded-full bg-amber-50 px-2 py-0\.5 text-xs font-medium uppercase tracking-wide text-amber-700">pending<\/span>/,
    );
    expect(body).toMatch(
      /'<span class="rounded-full bg-tk-hover px-2 py-0\.5 text-xs font-medium uppercase tracking-wide text-tk-ink-2">unsubscribed '/,
    );
  });

  it('tombstoned-row display: "(purged — V-295c3-tombstone)"', () => {
    expect(body).toMatch(/\(purged — V-295c3-tombstone\)/);
    expect(body).toMatch(/sub\.email\s*\?\s*escapeHtml\(sub\.email\)/);
  });

  it('window.confirm force-unsubscribe gate with V-281 audit-log explanation', () => {
    expect(body).toMatch(
      /Force-unsubscribe ' \+\s*\n?\s*email \+\s*\n?\s*'\? Writes admin_audit_log\. Customer can re-subscribe via the public form/,
    );
  });

  it('50-default + ?limit=&offset= server-side pagination framing', () => {
    expect(body).toMatch(
      /Subscribers list paginated server-side \(default 50 per page; <code>\?limit=&amp;offset=<\/code>/,
    );
  });

  it('90d tombstone purge cron framing pinned in footer', () => {
    expect(body).toMatch(
      /Tombstoned rows \(90d post-unsubscribe via\s+V-295c3-tombstone purge cron\) appear with email = <code>null<\/code>/,
    );
  });

  it('banner pattern: data-banner + role="status" + error-state class swap', () => {
    expect(body).toMatch(/data-banner/);
    expect(body).toMatch(/role="status"/);
    expect(body).toMatch(/banner\.classList\.add\('border-red-200', 'bg-red-50', 'text-red-700'\)/);
  });

  it('no-token + empty states: structured (headline + helper copy), matching the admin empty-state pattern', () => {
    // No-token guard: structured empty state guiding the operator to SSO.
    expect(body).toMatch(/Sign in to view subscribers/);
    expect(body).toMatch(/Sign in with a staff admin key via the dashboard SSO bridge/);
    // Empty list: headline + helper copy (not a bare one-line <li>).
    expect(body).toMatch(/No subscribers yet/);
    expect(body).toMatch(
      /When visitors subscribe to incident notifications on status\.driftstack\.dev, they appear here/,
    );
  });

  it('escapeHtml + fmtIso helpers (XSS-safe inline rendering, ISO normalization)', () => {
    expect(body).toMatch(/function escapeHtml\(s\)/);
    expect(body).toMatch(/function fmtIso\(iso\)/);
    expect(body).toMatch(
      /new Date\(iso\)\.toISOString\(\)\.replace\('T', ' '\)\.slice\(0, 16\) \+ ' UTC'/,
    );
  });

  it('inline script is:inline (Astro convention for admin-panel pages). 2026-05-21 — define:vars={{ apiBaseUrl }} added so the inline script can prefix fetch() with the API origin.', () => {
    expect(body).toMatch(/<script is:inline define:vars=\{\{ apiBaseUrl \}\}>/);
  });
});
