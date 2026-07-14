// W488.A — drift guard for apps/admin-panel/src/pages/audit-log.astro.
// V-188 admin audit-log page. Drift here either drops the D-025
// append-only framing (operators lose the contract that the audit
// trail can't be mutated) or breaks the client-side result-filter
// fallback (the endpoint doesn't accept a result filter today,
// so result-only filtering happens post-fetch — drift to a
// query-param result filter would silently no-op).
//
//   • V-188 framing pinned: 'progressive-enhancement against
//     /v1/admin/audit-log. SSG renders the mock; an inline
//     <script> reads ds_web_session_token from localStorage and
//     replaces the table body with live entries. Filter bar is
//     wired: action substring (server-side `action`), admin id
//     (`admin_id`), result-only filter is client-side post-fetch
//     since the endpoint doesn't accept a result filter today.'
//   • Filter bar 3-field: action / admin-id / result (3-option
//     select: any / success-only / errors-only).
//   • Inflight counter pattern: ++inFlight + myReq !== inFlight
//     stale-response guard.
//   • Debounce 200ms via setTimeout on input/change.
//   • Retention framing: '90 days hot in Postgres + R2 archive
//     thereafter (ADR-006)'.
//   • 'Showing N entr(y|ies)' singular/plural footnote.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/admin-panel/src/pages/audit-log.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W488.A apps/admin-panel/src/pages/audit-log.astro content parity', () => {
  const body = read(LIB);

  it('V-188 framing pins an inert SSG shell and the server/client filter split', () => {
    expect(body).toMatch(
      /\/\/ V-188 — progressive-enhancement against \/v1\/admin\/audit-log\. SSG\s*\n?\s*\/\/ renders an inert shell; an inline <script> reads ds_web_session_token\s*\n?\s*\/\/ from localStorage and replaces the table body with live entries\./,
    );
  });

  it('ships no sample security event or green live claim before authority', () => {
    expect(body).not.toContain('MOCK_AUDIT_LOG');
    expect(body).toContain('Live audit entries are unavailable until loaded.');
    expect(body).toMatch(/data-live-dot\s*\n?\s*class="[^"]*bg-amber-500"/);
    expect(body).toContain('<span data-live-status>Waiting for live data</span>');
    expect(body).toMatch(/data-live-refresh\s*\n?\s*disabled\s*\n?\s*aria-disabled="true"/);
  });

  it("D-025 framing pinned: 'Append-only record of every admin action. Cannot be mutated by admins (D-025). Filter by action, admin id, or target account.' — pinned so the immutability contract stays explicit on the page operators see (drift to softer phrasing weakens the compliance-review guarantee). The filter list names the REAL filters (action / admin id / target account) — it must NOT advertise a non-existent 'admin email' filter (the endpoint has no such param)", () => {
    expect(body).toMatch(
      /Append-only record of every admin action\. Cannot be mutated by admins\s*\n?\s*\(D-025\)\. Filter by action, admin id, or target account\./,
    );
    // The page must not promise an 'admin email' filter the endpoint can't honor.
    expect(body).not.toMatch(/Filter by action, target account, or admin email/);
  });

  it("Filter bar 3-field: data-field='action' (substring placeholder 'e.g. account.tier_changed') + data-field='admin-id' (placeholder 'acc_<uuid>') + data-field='result' 3-option select (Any result / Success only / Errors only) — pinned so the filter taxonomy stays in sync with the server endpoint's accepted params + the result-only client-side filter has all 3 states", () => {
    expect(body).toMatch(
      /data-field="action"[\s\S]*?aria-label="Filter audit log by action"[\s\S]*?placeholder="Filter by action \(e\.g\. account\.tier_changed\)…"/,
    );
    expect(body).toMatch(
      /data-field="admin-id"[\s\S]*?aria-label="Filter audit log by admin id"[\s\S]*?placeholder="Admin id \(acc_<uuid>\)"/,
    );
    expect(body).toMatch(/<option value="">Any result<\/option>/);
    expect(body).toMatch(/<option value="success">Success only<\/option>/);
    expect(body).toMatch(/<option value="error">Errors only<\/option>/);
  });

  it('In-flight stale-response guard returns false from superseded success/failure paths', () => {
    expect(body).toMatch(/let inFlight = 0;/);
    expect(body).toMatch(/const myReq = \+\+inFlight;/);
    expect(body).toMatch(/if \(myReq !== inFlight\) return false;/);
  });

  it('Debounce 200ms routes filter refreshes through the truthful live-state wrapper', () => {
    expect(body).toMatch(
      /function scheduleLoad\(\) \{\s*\n?\s*clearTimeout\(debounce\);\s*\n?\s*debounce = setTimeout\(loadWithLive, 200\);\s*\n?\s*\}/,
    );
    expect(body).toMatch(/actionEl\.addEventListener\('input', scheduleLoad\)/);
    expect(body).toMatch(/adminIdEl\.addEventListener\('input', scheduleLoad\)/);
    expect(body).toMatch(/resultEl\.addEventListener\('change', scheduleLoad\)/);
  });

  it('Client-side result-filter: entries.filter on a startsWith(resultFilter) PREFIX match (not exact ===) — failures are audited as `error: <code>`, so an exact "error" match never hit them; stays client-side until the server endpoint adds a result query param', () => {
    expect(body).toMatch(/const resultFilter = resultEl \? resultEl\.value : '';/);
    expect(body).toMatch(
      /entries = entries\.filter\(\(e\) => String\(e\.result\)\.startsWith\(resultFilter\)\);/,
    );
  });

  it("Retention framing pinned: '90 days hot in Postgres + R2 archive thereafter (ADR-006)' + footnote dynamic 'Showing N entr(y|ies)' (singular when length===1) — pinned so the retention contract + grammatical accuracy survive (drift to '90 days' without the R2-archive caveat would imply data is permanently lost, weakening the compliance posture)", () => {
    expect(body).toMatch(
      /'Showing ' \+\s*\n?\s*entries\.length \+\s*\n?\s*' entr' \+\s*\n?\s*\(entries\.length === 1 \? 'y' : 'ies'\) \+\s*\n?\s*\(filteredPage \? ' \(of the 50 most-recent — filter is client-side\)' : ''\) \+\s*\n?\s*'\. Retention 90 days hot in Postgres \+ R2 archive thereafter \(ADR-006\)\.';/,
    );
    expect(body).toMatch(
      /Retention 90 days hot in Postgres \+ R2 archive thereafter \(ADR-006\)\. The\s*\n?\s*read endpoint paginates by timestamp DESC; bulk export is not yet\s*\n?\s*exposed from <code class="font-mono">\/v1\/admin\/audit-log<\/code>/,
    );
  });

  it("Empty-filter-result branch: 'No audit entries match the current filter.' colspan=5 cell — pinned so the empty-after-filter state is visually distinct (centered + slate-500 muted) from the no-data-yet state and operators can tell their filter is the cause. The client-side result filter also qualifies its empty-state + count honestly (a filtered empty page over the 50-row window means 'none in the most-recent', NOT 'none exist').", () => {
    expect(body).toMatch(
      /class="px-4 py-8 text-center text-sm text-tk-ink-3">'\s*\+\s*\n?\s*\(filteredPage/,
    );
    expect(body).toMatch(/No audit entries match the current filter\./);
    expect(body).toMatch(
      /No ' \+\s*\n?\s*resultFilter \+\s*\n?\s*' entries in the 50 most-recent — older entries are not loaded on this view\.'/,
    );
  });

  it("Query construction: limit=50 + optional action + optional admin_id (server-side filter params only — result excluded since it's client-side) — pinned so the buildQuery helper matches the endpoint contract (drift to passing result as a query param would crowd the URL without effect)", () => {
    expect(body).toMatch(/params\.set\('limit', '50'\);/);
    expect(body).toMatch(
      /if \(actionEl && actionEl\.value\.trim\(\)\) params\.set\('action', actionEl\.value\.trim\(\)\);/,
    );
    expect(body).toMatch(
      /if \(adminIdEl && adminIdEl\.value\.trim\(\)\) params\.set\('admin_id', adminIdEl\.value\.trim\(\)\);/,
    );
  });

  it('Signed-out and failed loads render an explicit non-authoritative row and success alone turns freshness green', () => {
    expect(body).toMatch(
      /function renderUnavailable\(message\) \{[\s\S]*?tbody\.innerHTML =[\s\S]*?'<tr><td colspan="5"[\s\S]*?escapeHtml\(message\) \+[\s\S]*?'[^']*<\/td><\/tr>';[\s\S]*?if \(footnote\) footnote\.textContent = '';[\s\S]*?\}/,
    );
    expect(body).toMatch(
      /\.catch\(\(err\) => \{[\s\S]*?renderUnavailable\(\s*'Could not load live audit entries — nothing is shown as authoritative\. Resolve the error above and retry\.',\s*\);[\s\S]*?showBanner\("Couldn't load audit log \(" \+ msg \+ '\)\.'\);/,
    );
    expect(body).toMatch(
      /if \(!token\) \{\s*renderUnavailable\('Sign in with a staff admin account to see audit entries\.'\);[\s\S]*?showBanner\('Sign in with a staff admin account to see live data\.'\);/,
    );
    expect(body).toMatch(/if \(expectedReq !== inFlight\) return ok;/);
    expect(body).toMatch(/if \(ok\) \{[\s\S]*?setLiveState\('ready'\);/);
  });

  it('keeps the existing DOMContentLoaded token deferral for the AdminLayout SSO bridge', () => {
    expect(body).toMatch(/let token = null;/);
    expect(body).toMatch(
      /function start\(\) \{\s*\n?\s*token = localStorage\.getItem\('ds_web_session_token'\);/,
    );
    expect(body).toMatch(
      /document\.addEventListener\('DOMContentLoaded', start, \{ once: true \}\);/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
