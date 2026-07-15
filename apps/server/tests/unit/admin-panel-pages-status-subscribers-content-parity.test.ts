// W487.B — drift guard for apps/admin-panel/src/pages/status-subscribers.astro.
// V-312 admin view of status-page email subscribers (V-295c3 +
// V-295c3-tombstone). Drift here either drops the V-281 dual-write
// framing (force-unsubscribe could land without admin_audit_log
// write — silent admin action) or breaks the V-295c3-tombstone
// 'email = null after 90d purge' handling (tombstoned rows would
// crash the row renderer instead of showing the '(purged)' span).
//
//   • V-312 + V-295c3 + V-281 framing pinned.
//   • Status-badge 3-tone: unsubscribed (slate-100) / confirmed
//     (emerald-50) / pending (amber-50 fallback).
//   • Force-unsubscribe button gated by !sub.unsubscribed_at &&
//     sub.email (tombstoned rows show 'no action').
//   • Tombstoned-row span: '(purged — V-295c3-tombstone)'.
//   • escapeHtml 5-char map (& < > " ').
//   • localStorage token key 'ds_web_session_token'.
//   • POST /v1/admin/status-subscribers/{id}/force-unsubscribe
//     endpoint contract.
//   • Pagination framing: 'default 50 per page; ?limit=&offset='.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/admin-panel/src/pages/status-subscribers.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W487.B apps/admin-panel/src/pages/status-subscribers.astro content parity', () => {
  const body = read(LIB);

  it("V-312 + V-295c3 + V-281 framing pinned: 'admin view of status-page email subscribers (V-295c3 + V-295c3-tombstone). Read /v1/admin/status-subscribers; expose a force-unsubscribe button per row. Audit log dual-write happens server-side (V-281 pattern).' — pinned so the dual-write contract + read endpoint stay documented inline", () => {
    expect(body).toMatch(
      /\/\/ V-312 — admin view of status-page email subscribers \(V-295c3 \+\s*\n?\s*\/\/ V-295c3-tombstone\)\. Read \/v1\/admin\/status-subscribers; expose a\s*\n?\s*\/\/ force-unsubscribe button per row\. Audit log dual-write happens\s*\n?\s*\/\/ server-side \(V-281 pattern\)\./,
    );
  });

  it('Page framing pins incident email fan-out and forced-unsubscribe audit behavior', () => {
    expect(body).toMatch(
      /Email addresses subscribed to status\.driftstack\.dev incident notifications\. Confirmed\s*\n?\s*subscribers receive emails when public incidents are posted or resolved\. A forced\s*\n?\s*unsubscribe is also written to the admin audit log\./,
    );
  });

  it("Status-badge 3-tone: unsubscribed_at present → slate-100 'unsubscribed {ts}' / confirmed_at present → emerald-50 'confirmed' / fallback → amber-50 'pending' — pinned so the badge taxonomy mirrors the canonical lifecycle (pending → confirmed → unsubscribed) + tombstoned rows don't double-classify (unsubscribed_at takes precedence over confirmed_at)", () => {
    expect(body).toMatch(
      /if \(sub\.unsubscribed_at\) \{\s*\n?\s*return '<span class="rounded-full bg-tk-hover px-2 py-0\.5 text-xs font-medium uppercase tracking-wide text-tk-ink-2">unsubscribed '/,
    );
    expect(body).toMatch(
      /if \(sub\.confirmed_at\) \{\s*\n?\s*return '<span class="rounded-full bg-emerald-50 px-2 py-0\.5 text-xs font-medium uppercase tracking-wide text-emerald-700">confirmed<\/span>';\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /return '<span class="rounded-full bg-amber-50 px-2 py-0\.5 text-xs font-medium uppercase tracking-wide text-amber-700">pending<\/span>';/,
    );
  });

  it("Force-unsubscribe gate: canForceUnsub = !sub.unsubscribed_at && sub.email — both required (already-unsubscribed rows + tombstoned rows with email=null both show 'no action' instead) — pinned so the button doesn't appear on rows where it would be a no-op or would crash on missing email", () => {
    expect(body).toMatch(/const canForceUnsub = !sub\.unsubscribed_at && sub\.email;/);
    expect(body).toMatch(/<span class="text-xs text-tk-ink-3">no action<\/span>/);
  });

  it('Tombstoned-row email display renders the completed retention purge instead of a blank cell', () => {
    expect(body).toMatch(
      /const emailDisplay = sub\.email\s*\n?\s*\? escapeHtml\(sub\.email\)\s*\n?\s*: '<span class="font-mono text-xs text-tk-ink-3">\(purged after retention period\)<\/span>';/,
    );
  });

  it('escapeHtml 5-char map: & → &amp; / < → &lt; / > → &gt; / " → &quot; / \' → &#39; — pinned so the inline-DOM construction stays XSS-safe (drift to a 4-char map or wrong entity codes would expose a cross-site-scripting hole through customer-controlled email addresses)', () => {
    expect(body).toMatch(
      /\.replace\(\/\[&<>"'\]\/g, function \(c\) \{\s*\n?\s*if \(c === '&'\) return '&amp;';\s*\n?\s*if \(c === '<'\) return '&lt;';\s*\n?\s*if \(c === '>'\) return '&gt;';\s*\n?\s*if \(c === '"'\) return '&quot;';\s*\n?\s*return '&#39;';\s*\n?\s*\}\);/,
    );
  });

  it("Auth pattern: localStorage.getItem('driftstack_admin_token') + Bearer header on /v1/admin/status-subscribers?limit=200 — pinned so the admin-token key stays in sync with the auth bootstrap (drift to a different key would silently sign every admin out). 2026-05-21 — fetch URL prefixed by apiBaseUrl (admin.driftstack.dev is a static Pages origin; relative paths 404).", () => {
    // 2026-05-21 — staff token now lives in `ds_web_session_token`
    // (canonical key the SSO bridge populates from app.driftstack.dev).
    // The legacy `driftstack_admin_token` key was a paper trail and
    // never populated anywhere.
    expect(body).toMatch(/localStorage\.getItem\('ds_web_session_token'\) \|\| ''/);
    expect(body).toMatch(
      /boundedFetch\(\s*\n?\s*apiBaseUrl \+ '\/v1\/admin\/status-subscribers\?limit=200',\s*\n?\s*\{ headers: \{ authorization: 'Bearer ' \+ token \} \},\s*\n?\s*controller,\s*\n?\s*\)/,
    );
  });

  it("Force-unsubscribe contract: POST /v1/admin/status-subscribers/{encodeURIComponent(id)}/force-unsubscribe with empty {} body + Bearer auth + content-type:application/json + window.confirm prompt referencing admin_audit_log — pinned so the destructive action requires explicit confirmation and the URL encoding doesn't break on subscriber-IDs with special chars. 2026-05-21 — fetch URL prefixed by apiBaseUrl (same fix as the GET above).", () => {
    expect(body).toMatch(
      /await window\.driftstackConfirm\(\s*\n?\s*'Force-unsubscribe ' \+\s*\n?\s*email \+\s*\n?\s*'\? Writes admin_audit_log\. Customer can re-subscribe via the public form\.',/,
    );
    expect(body).toMatch(
      /boundedFetch\(\s*\n?\s*apiBaseUrl \+ '\/v1\/admin\/status-subscribers\/' \+ encodeURIComponent\(id\) \+ '\/force-unsubscribe',\s*\n?\s*\{\s*\n?\s*method: 'POST',\s*\n?\s*headers: \{\s*\n?\s*authorization: 'Bearer ' \+ getToken\(\),\s*\n?\s*'content-type': 'application\/json',\s*\n?\s*\},\s*\n?\s*body: '\{\}',\s*\n?\s*\},\s*\n?\s*\)/,
    );
  });

  it('starts neutral and keeps refresh plus force-add inert until staff identity and a current subscriber read establish authority', () => {
    expect(body).toContain('data-live-status>Waiting for live data</span>');
    expect(body).toMatch(/data-live-refresh\s*\n?\s*disabled\s*\n?\s*aria-disabled="true"/);
    expect(body).toMatch(
      /id="add-email"[\s\S]*?required\s*\n?\s*disabled\s*\n?\s*aria-disabled="true"/,
    );
    expect(body).toMatch(
      /type="submit"\s*\n?\s*disabled\s*\n?\s*aria-disabled="true"[\s\S]*?>Add subscriber<\/button/,
    );
    expect(body).toContain('Live subscribers are unavailable until loaded.');
    expect(body).toContain('let subscriberDataAvailable = false;');
    expect(body).toContain(
      'if (!subscriberDataAvailable || addInFlight || addOutcomeUnknown) return;',
    );
  });

  it('publishes list and mutation authority only after a successful current read, while stale or failed reads cannot preserve destructive controls', () => {
    expect(body).toMatch(
      /if \(generation !== refreshGeneration\) return null;\s*\n?\s*const subs = body\.data \|\| \[\];\s*\n?\s*setAddAuthority\(true\);/,
    );
    expect(body).toMatch(
      /\.catch\(function \(err\) \{[\s\S]*?if \(generation !== refreshGeneration\) return null;\s*\n?\s*renderUnavailable\('Could not load the current subscriber list\. Refresh to try again\.'\);/,
    );
    expect(body).toMatch(
      /function renderUnavailable\(message\) \{\s*\n?\s*setAddAuthority\(false, message\);/,
    );
  });

  it('reports live freshness only for a successful current read and leaves signed-out or failed reads visibly unavailable', () => {
    expect(body).toMatch(
      /if \(generation !== refreshGeneration \|\| loaded === null\) return;\s*\n?\s*if \(loaded === true\) \{\s*\n?\s*lastFetch = Date\.now\(\);\s*\n?\s*setLiveState\('success', 'Live'\);/,
    );
    expect(body).toContain(
      "setLiveState('error', getToken() ? 'Live data unavailable' : 'Staff sign-in required');",
    );
    expect(body).toContain("setLiveState('error', 'Live data unavailable');");
  });

  it('defers the first read until the AdminLayout SSO bridge has had its DOMContentLoaded turn', () => {
    expect(body).toMatch(
      /if \(document\.readyState === 'loading'\) \{\s*\n?\s*document\.addEventListener\('DOMContentLoaded', start, \{ once: true \}\);\s*\n?\s*\} else \{\s*\n?\s*start\(\);/,
    );
    expect(body).not.toMatch(/\n\s*refresh\(\);\s*\n\s*\}\)\(\);/);
  });

  it('keeps subscriber reads and mutations on the shared 15-second bounded transport', () => {
    expect(body).toContain('const SUBSCRIBER_TIMEOUT_MS = 15_000;');
    expect(body).toContain(
      'window.driftstackFetchWithDeadline(url, init, SUBSCRIBER_TIMEOUT_MS, controller)',
    );
    expect(body).not.toMatch(/\bfetch\(/);
  });

  it('Pagination framing pins fan-out and the scheduled 90-day tombstone purge', () => {
    expect(body).toMatch(
      /Subscribers list paginated server-side \(default 50 per page; <code>\?limit=&amp;offset=<\/code>\s*\n?\s*query params for paging\)\. Confirmed-and-still-subscribed rows trigger fan-out emails on\s*\n?\s*public incident state changes\. Tombstoned rows appear with email = <code>null<\/code> after\s*\n?\s*the scheduled 90-day post-unsubscribe purge\./,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
