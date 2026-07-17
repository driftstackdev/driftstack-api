// W489.B — drift guard for apps/admin-panel/src/pages/sessions.astro.
// V-192 cross-account live-session view. Drift here either drops
// the 5-state STATUS_BADGE vocabulary (a new session lifecycle
// state would render without styling — invisible badge) or
// breaks the force-destroy → POST endpoint contract (audit log
// dual-write happens via JSON body, not query params).
//
//   • V-192 framing pins force-destroy-only staff authority and no
//     fictional replay/cloud-recording administration.
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

  it('page-purpose framing pins force-destroy-only staff authority and local-only customer recordings', () => {
    expect(body).toMatch(
      /Inspect and filter live and recent customer sessions across all accounts\.\s*\n?\s*Force-destroy is the only mutation surfaced here and the only staff mutation\s*\n?\s*available\. Session replay is not available in admin, and customer desktop\s*\n?\s*recordings stay on their device and never enter the admin API\./,
    );
    expect(body).not.toContain('replay, view recording');
    expect(body).not.toMatch(/replay.*per-account detail surface/i);
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
    expect(body).toMatch(/destroysInFlight\.size > 0/);
    expect(body).toMatch(/uncertainDestroys\.has\(id\)/);
    expect(body).toMatch(/btn\.setAttribute\('aria-busy', 'true'\);/);
    expect(body).toMatch(/const capturedAccountId =/);
    expect(body).toMatch(/acceptDestroyResponse\(response\);/);
  });

  it('cursor pagination owns one deduped loaded window and pauses polling when expanded', () => {
    expect(body).toContain('data-action="load-more"');
    expect(body).toContain('Back to newest / Refresh');
    expect(body).toMatch(/let loadedSessions = \[\];/);
    expect(body).toMatch(/let listEpoch = 0;/);
    expect(body).toMatch(/let appendRequestId = 0;/);
    expect(body).toMatch(/const requestedCursors = new Set\(\);/);
    expect(body).toMatch(/function mergeUniqueSessions\(existing, incoming\)/);
    expect(body).toMatch(/if \(myReq !== inFlight \|\| epoch !== listEpoch\)/);
    expect(body).toMatch(
      /returnedCursor === requestedCursor \|\| requestedCursors\.has\(returnedCursor\)/,
    );
    expect(body).toContain('Existing rows and cursor are unchanged.');
    expect(body).toContain('Live refresh paused while viewing older sessions');
  });

  it('rejects malformed list and verification pages before authoritative inference', () => {
    expect(body).toMatch(/function isSessionListRow\(value\)/);
    expect(body).toMatch(
      /const requiredStrings = \['id', 'account_id', 'api_key_id', 'archetype'\]/,
    );
    expect(body).toMatch(/SESSION_STATUSES\.has\(value\.status\)/);
    expect(body).toMatch(/SESSION_PURPOSES\.has\(value\.purpose\)/);
    expect(body).toMatch(/function isEgressCapabilitiesOrNull\(value\)/);
    expect(body).toMatch(/isRecordOrNull\(value\.metadata\)/);
    expect(body).toMatch(/isRecordOrNull\(value\.egress_capability_report\)/);
    expect(body).toMatch(
      /isIsoTimestamp\(value\.created_at\)[\s\S]*?isIsoTimestamp\(value\.updated_at\)[\s\S]*?isIsoTimestampOrNull\(value\.last_state_at\)[\s\S]*?isIsoTimestampOrNull\(value\.destroyed_at\)/,
    );
    expect(body).toMatch(/function parseSessionListPage\(value\)/);
    expect(body).toMatch(
      /!Array\.isArray\(value\.data\) \|\| !value\.data\.every\(isSessionListRow\)/,
    );
    expect(body).toMatch(
      /const page = parseSessionListPage\(body\);\s*if \(page === null\) throw new Error\('invalid session-list response'\);\s*const incoming = page\.data;\s*const returnedCursor = page\.nextCursor;/,
    );
    expect(body).toMatch(
      /const parsedPage = parseSessionListPage\(body\);\s*if \(parsedPage === null\) \{\s*return \{\s*readSucceeded: false,\s*status: null,\s*stop: 'invalid verification response'/,
    );
    expect(body).toMatch(
      /const rows = parsedPage\.data;\s*const status = observedStatus\(rows, id\)/,
    );
    expect(body).not.toMatch(/Array\.isArray\(body\.data\) \? body\.data : \[\]/);
  });

  it('ambiguous timeout/5xx verification is captured-account scoped, unfiltered, bounded, and nonreplayable', () => {
    expect(body).toMatch(/const DESTROY_RECONCILE_MAX_PAGES = 20;/);
    expect(body).toMatch(/async function verifyDestroyOutcome\(id, capturedAccountId\)/);
    expect(body).toMatch(/params\.set\('account_id', capturedAccountId\);/);
    expect(body).toMatch(/for \(let page = 0; page < DESTROY_RECONCILE_MAX_PAGES; page \+= 1\)/);
    expect(body).toMatch(/returnedCursor === cursor \|\| seenCursors\.has\(returnedCursor\)/);
    expect(body).toContain('Only status destroyed proves completion');
    expect(body).toContain('Absence does not prove completion.');
    expect(body).toContain('The target remains disabled and unverified');
  });

  it('all accepted 2xx statuses commit before unused-body parsing while 5xx stays unknown', () => {
    expect(body).toMatch(/if \(response\.status >= 200 && response\.status < 300\) return;/);
    expect(body).toMatch(/if \(response\.status >= 500\) throw unknownDestroyError/);
    expect(body).toMatch(
      /acceptDestroyResponse\(response\);\s*committed = true;\s*uncertainDestroys\.delete\(id\);\s*patchSessionDestroyed\(id\);/,
    );
  });

  it("5-col table header (Session/Account/Status/Started/<empty actions col>) + colspan=5 empty-state — pinned so the 5-column layout's empty-after-filter row spans full width (drift to colspan=4 would visually misalign + drift to a 4-col header without the actions col would leave force-destroy buttons floating)", () => {
    expect(body).toMatch(/<th class="px-4 py-3">Session<\/th>/);
    expect(body).toMatch(/<th class="px-4 py-3">Account<\/th>/);
    expect(body).toMatch(/<th class="px-4 py-3">Status<\/th>/);
    expect(body).toMatch(/<th class="px-4 py-3">Started<\/th>/);
    expect(body).toMatch(
      /<tr><td colspan="5" class="px-4 py-8 text-center text-sm text-tk-ink-3">No sessions match the current filter in the loaded window\.<\/td><\/tr>/,
    );
  });

  it('footnote reports deduped loaded-window truth with singular/plural grammar and pagination state', () => {
    expect(body).toMatch(
      /footnote\.textContent =\s*\n?\s*'Showing ' \+\s*\n?\s*rows\.length \+\s*\n?\s*' session' \+\s*\n?\s*\(rows\.length === 1 \? '' : 's'\) \+\s*\n?\s*' in the loaded window' \+/,
    );
    expect(body).toContain(
      'Force-destroy fires POST /v1/admin/sessions/:id/destroy with audit log.',
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
    expect(body).toMatch(/if \(result\.loaded\) \{[\s\S]*?setLiveState\('ready'\);/);
    expect(body).toMatch(/if \(owner !== liveOwner\) return result;/);
    expect(body).toMatch(/setLiveState\('failed', 'Sign in for live data'\);/);
  });

  it('defers token authority until DOMContentLoaded so the AdminLayout SSO bridge lands first', () => {
    const protectedTokenRead =
      /function start\(\) \{\s*try \{\s*token = localStorage\.getItem\('ds_web_session_token'\);\s*\} catch \{\s*token = null;\s*\}\s*if \(!token\) \{/;

    expect(body).toMatch(/let token = null;/);
    expect(body).toMatch(protectedTokenRead);
    expect(
      body.replace(
        /try \{\s*token = localStorage\.getItem\('ds_web_session_token'\);\s*\} catch \{\s*token = null;\s*\}/,
        "token = localStorage.getItem('ds_web_session_token');",
      ),
    ).not.toMatch(protectedTokenRead);
    expect(body.slice(0, body.indexOf('function start()'))).not.toContain(
      "localStorage.getItem('ds_web_session_token')",
    );
    expect(body).toMatch(
      /if \(document\.readyState === 'loading'\) \{\s*\n?\s*document\.addEventListener\('DOMContentLoaded', start\);\s*\n?\s*\} else \{\s*\n?\s*start\(\);/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
