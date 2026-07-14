// W489.B — drift guard for apps/admin-panel/src/pages/sessions.astro.
// V-192 cross-account live-session view. Drift here either drops
// the 5-state STATUS_BADGE vocabulary (a new session lifecycle
// state would render without styling — invisible badge) or
// breaks the force-destroy → POST endpoint contract (audit log
// dual-write happens via JSON body, not query params).
//
//   • V-192 framing pinned + 'Force-destroy is the only mutation
//     surfaced here; everything else (replay, view recording)
//     flows through the per-account detail surface.'
//   • Inert first paint with no sample session or destructive control.
//   • STATUS_BADGE 5-tone in the live renderer:
//     creating (amber) / ready (emerald) / busy (blue) /
//     destroyed (slate) / errored (red).
//   • Force-destroy button hidden when status === 'destroyed'.
//   • POST /v1/admin/sessions/:id/destroy + optional reason via
//     window.prompt → JSON body.
//   • Status select 5-option dropdown + account-id text input
//     filter.
//   • 5-col table (Session/Account/Status/Started/<actions>).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/admin-panel/src/pages/sessions.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W489.B apps/admin-panel/src/pages/sessions.astro content parity', () => {
  const body = read(LIB);

  it('V-192 framing pins an inert SSG shell replaced only after authenticated live loading', () => {
    expect(body).toMatch(
      /\/\/ V-192 — progressive-enhancement against \/v1\/admin\/sessions \(new in\s*\n?\s*\/\/ V-192\)\. SSG renders an inert shell; an inline <script> reads\s*\n?\s*\/\/ ds_web_session_token from localStorage, fetches with bearer auth, and\s*\n?\s*\/\/ replaces the table\./,
    );
  });

  it("Page-purpose framing pinned: 'Live and recent customer sessions across all accounts. Force-destroy is the only mutation surfaced here; everything else (replay, view recording) flows through the per-account detail surface.' — pinned so the deferred-actions framing (this page does only destroy; per-account page does replay/recording) stays explicit", () => {
    expect(body).toMatch(
      /Live and recent customer sessions across all accounts\. Force-destroy is\s*\n?\s*the only mutation surfaced here; everything else \(replay, view recording\)\s*\n?\s*flows through the per-account detail surface\./,
    );
  });

  it('STATUS_BADGE 5-tone remains in the authoritative live-row renderer only', () => {
    expect(body).toMatch(
      /const STATUS_BADGE = \{\s*\n?\s*creating: 'bg-amber-50 text-amber-700',\s*\n?\s*ready: 'bg-emerald-50 text-emerald-700',\s*\n?\s*busy: 'bg-blue-50 text-blue-700',\s*\n?\s*destroyed: 'bg-tk-hover text-tk-ink-2',\s*\n?\s*errored: 'bg-red-50 text-red-700',\s*\n?\s*\};/,
    );
    expect(body).not.toContain('const STATUS_BADGE: Record<string, string>');
  });

  it('ships no sample session identity, count, destructive control, or green live claim', () => {
    expect(body).not.toContain('MOCK_SESSIONS');
    expect(body).toContain('Live sessions are unavailable until loaded.');
    expect(body).toMatch(/data-live-dot\s*\n?\s*class="[^"]*bg-amber-500"/);
    expect(body).toContain('<span data-live-status>Waiting for live data</span>');
    expect(body).toMatch(/data-live-refresh\s*\n?\s*disabled\s*\n?\s*aria-disabled="true"/);
    expect(body).not.toMatch(/data-action="destroy"\s*\n?\s*data-id=\{session\.id\}/);
    expect(body).not.toMatch(/Showing \{MOCK_SESSIONS\.length\} sessions/);
  });

  it('Status filter 5-option dropdown matches lifecycle states: All statuses / creating / ready / busy / destroyed / errored — pinned so every state in the type union has a filter option (drift to dropping a state would hide sessions in that state from operators filtering by status)', () => {
    expect(body).toMatch(/<option value="">All statuses<\/option>/);
    expect(body).toMatch(/<option value="creating">creating<\/option>/);
    expect(body).toMatch(/<option value="ready">ready<\/option>/);
    expect(body).toMatch(/<option value="busy">busy<\/option>/);
    expect(body).toMatch(/<option value="destroyed">destroyed<\/option>/);
    expect(body).toMatch(/<option value="errored">errored<\/option>/);
  });

  it("Force-destroy is emitted only by live rowHtml and stays hidden when status === 'destroyed'", () => {
    expect(body).toMatch(
      /const destroyBtn =\s*\n?\s*s\.status !== 'destroyed'\s*\n?\s*\? '<button type="button" data-action="destroy" data-id="' \+/,
    );
  });

  it('POST /v1/admin/sessions/{encodeURIComponent(id)}/destroy stays confirmed, bounded, latched, and audited — pinned so an optional trimmed reason reaches the audit row without allowing an accidental or duplicate force-destroy', () => {
    expect(body).toMatch(
      /const confirmed = await window\.driftstackConfirm\(\s*\n?\s*'Force-destroy session ' \+ id \+ "\? This ends the customer's live browser session immediately\.",/,
    );
    expect(body).toMatch(
      /await window\.driftstackPrompt\('Reason for force-destroying ' \+ id \+ ' \(optional\):', \{/,
    );
    expect(body).toMatch(
      /const body = \{\};\s*\n?\s*if \(reason\.trim\(\)\) body\.reason = reason\.trim\(\);/,
    );
    expect(body).toMatch(
      /const response = await boundedFetch\(\s*\n?\s*apiBaseUrl \+ '\/v1\/admin\/sessions\/' \+ encodeURIComponent\(id\) \+ '\/destroy',\s*\n?\s*\{\s*\n?\s*method: 'POST',\s*\n?\s*headers: \{\s*\n?\s*authorization: 'Bearer ' \+ token,\s*\n?\s*'content-type': 'application\/json',\s*\n?\s*\},\s*\n?\s*credentials: 'include',\s*\n?\s*body: JSON\.stringify\(body\),\s*\n?\s*\},\s*\n?\s*\);/,
    );
    expect(body).toMatch(/const SESSION_TIMEOUT_MS = 15_000;/);
    expect(body).toMatch(/if \(!token \|\| destroysInFlight\.has\(id\)\) return;/);
    expect(body).toMatch(/btn\.setAttribute\('aria-busy', 'true'\);/);
    expect(body).toMatch(/if \(err && err\.name === 'AbortError'\) \{/);
    expect(body).toMatch(/const refreshed = await load\(\);/);
  });

  it("5-col table header (Session/Account/Status/Started/<empty actions col>) + colspan=5 empty-state — pinned so the 5-column layout's empty-after-filter row spans full width (drift to colspan=4 would visually misalign + drift to a 4-col header without the actions col would leave force-destroy buttons floating)", () => {
    expect(body).toMatch(/<th class="px-4 py-3">Session<\/th>/);
    expect(body).toMatch(/<th class="px-4 py-3">Account<\/th>/);
    expect(body).toMatch(/<th class="px-4 py-3">Status<\/th>/);
    expect(body).toMatch(/<th class="px-4 py-3">Started<\/th>/);
    expect(body).toMatch(
      /<tr><td colspan="5" class="px-4 py-8 text-center text-sm text-tk-ink-3">No sessions match the current filter\.<\/td><\/tr>/,
    );
  });

  it("Footnote dynamic copy: 'Showing N session(s). Force-destroy fires POST /v1/admin/sessions/:id/destroy with audit log.' (singular when length===1) — pinned so the audit-log mention stays adjacent to the count + the singular/plural grammar works for length=1 (drift to always-plural would render 'Showing 1 sessions')", () => {
    expect(body).toMatch(
      /footnote\.textContent =\s*\n?\s*'Showing ' \+\s*\n?\s*rows\.length \+\s*\n?\s*' session' \+\s*\n?\s*\(rows\.length === 1 \? '' : 's'\) \+\s*\n?\s*'\. Force-destroy fires POST \/v1\/admin\/sessions\/:id\/destroy with audit log\.';/,
    );
  });

  it("Action-result banner taxonomy: 'Destroying N…' → 'Destroyed N. Refreshing…' → stable mapped failure copy", () => {
    expect(body).toMatch(/showBanner\('Destroying ' \+ id \+ '…'\);/);
    expect(body).toMatch(/showBanner\('Destroyed ' \+ id \+ '\. Refreshing…'\);/);
    expect(body).toMatch(
      /showBanner\("Couldn't destroy \(" \+ requestErrorMessage\(err, 'network error'\) \+ '\)\.'\);/,
    );
  });

  it('signed-out/failed reads reapply unavailable state, while success alone turns live state green', () => {
    expect(body).toContain('function renderSessionsUnavailable(message)');
    expect(body).toContain(
      "renderSessionsUnavailable('Sign in with a staff admin account to see live sessions.')",
    );
    expect(body).toContain(
      "'Could not load live sessions — nothing to act on. Resolve the error above and retry.'",
    );
    expect(body).toMatch(/if \(loaded\) \{[\s\S]*?setLiveState\('ready'\);/);
    expect(body).toMatch(/if \(expectedReq !== inFlight\) return loaded;/);
    expect(body).toMatch(/setLiveState\('failed', 'Sign in for live data'\);/);
  });

  it('defers token authority until DOMContentLoaded so the AdminLayout SSO bridge lands first', () => {
    expect(body).toMatch(/let token = null;/);
    expect(body).toMatch(
      /function start\(\) \{\s*\n?\s*token = localStorage\.getItem\('ds_web_session_token'\);/,
    );
    expect(body).toMatch(
      /if \(document\.readyState === 'loading'\) \{\s*\n?\s*document\.addEventListener\('DOMContentLoaded', start\);\s*\n?\s*\} else \{\s*\n?\s*start\(\);/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
