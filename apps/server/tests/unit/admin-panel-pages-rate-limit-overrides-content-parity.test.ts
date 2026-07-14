// W489.A — drift guard for apps/admin-panel/src/pages/rate-limit-overrides.astro.
// V-194 per-account bucket override page. Drift here either drops
// the 14-day-default TTL framing (operators land permanent
// overrides accidentally without the audit-review flag) or breaks
// the DELETE endpoint with bucket_key query param (Clear-now would
// 404 silently if path changes).
//
//   • V-194 framing pinned + 'time-boxed capacity bumps' use-case.
//   • Permanent overrides 'flagged in the weekly audit-log review'.
//   • Bucket-key 3-value catalog framing: global / session_create /
//     capture.
//   • BUCKET_LABEL duplicated frontmatter + inline (only global +
//     sessions:create today; framing comment mentions 3-value
//     forward catalog).
//   • DELETE /v1/admin/accounts/{id}/quota-override?bucket_key=
//     contract.
//   • fmtIso null → 'permanent' (distinctive from other pages where
//     null → '—').

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/admin-panel/src/pages/rate-limit-overrides.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W489.A apps/admin-panel/src/pages/rate-limit-overrides.astro content parity', () => {
  const body = read(LIB);

  it('V-194 framing pins an inert SSG shell and the per-account mutation contract', () => {
    expect(body).toMatch(
      /\/\/ V-194 — progressive-enhancement against \/v1\/admin\/rate-limit-\s*\n?\s*\/\/ overrides \(new in V-194\)\. SSG renders an inert shell; an inline\s*\n?\s*\/\/ <script> fetches with bearer auth, replaces the list, and wires/,
    );
  });

  it('ships no sample override, Clear control, or green live claim before authority', () => {
    expect(body).not.toContain('MOCK_OVERRIDES');
    expect(body).toContain('Live rate-limit overrides are unavailable until loaded.');
    expect(body).toMatch(/data-live-dot\s*\n?\s*class="[^"]*bg-amber-500"/);
    expect(body).toContain('<span data-live-status>Waiting for live data</span>');
    expect(body).toMatch(/data-live-refresh\s*\n?\s*disabled\s*\n?\s*aria-disabled="true"/);
    expect(body).not.toMatch(/data-action="clear"\s*\n?\s*data-account-id=\{override\.accountId\}/);
  });

  it("Page-purpose framing pinned: 'Per-account bucket overrides that supersede the tier defaults. Used for time-boxed capacity bumps during migrations + production incidents. All overrides are auditable + auto-expire if a TTL is set. To set a new override, open the per-account page (Accounts → select account).' — pinned so the use-case framing (migration cutover + incident response) + per-account-page redirect stays explicit", () => {
    expect(body).toMatch(
      /Per-account bucket overrides that supersede the tier defaults\. Used\s*\n?\s*for time-boxed capacity bumps during migrations \+ production\s*\n?\s*incidents\. All overrides are auditable \+ auto-expire if a TTL is\s*\n?\s*set\. To set a new override, open the per-account page \(Accounts →\s*\n?\s*select account\)\./,
    );
  });

  it("Bucket-key 3-value catalog framing pinned to the canonical SetQuotaOverrideRequestSchema enum: 'global (whole API), sessions:create (session creation only), agent_sessions:message (agent-session messages only)' — pinned so operators see the bucket-key strings the endpoint actually accepts (the prior session_create/capture values were rejected by the server enum, so the footnote documented buckets that always 400'd)", () => {
    expect(body).toMatch(
      /Bucket keys: <code class="font-mono">global<\/code>\s*\n?\s*\(whole API\), <code class="font-mono">sessions:create<\/code> \(session creation\s*\n?\s*only\), <code class="font-mono">agent_sessions:message<\/code> \(agent-session\s*\n?\s*messages only\)\./,
    );
  });

  it("14-day TTL default framing pinned: 'New overrides default to 14-day TTL. Permanent overrides allowed but flagged in the weekly audit-log review.' — pinned so the audit-review trigger for permanent overrides (no TTL) stays explicit (drift to dropping the 'flagged in weekly review' clause would weaken the governance posture around indefinite capacity grants)", () => {
    expect(body).toMatch(
      /New overrides default to 14-day TTL\. Permanent overrides allowed but\s*\n?\s*flagged in the weekly audit-log review\./,
    );
    expect(body).toMatch(
      /No active overrides match the current filter\. New overrides default\s*\n?\s*to a 14-day TTL via the per-account page\./,
    );
  });

  it('BUCKET_LABEL live catalog covers every canonical override bucket', () => {
    expect(body).toMatch(
      /const BUCKET_LABEL = \{\s*\n?\s*global: 'Global',\s*\n?\s*'sessions:create': 'Sessions: create',\s*\n?\s*'agent_sessions:message': 'Agent sessions: message',\s*\n?\s*\};/,
    );
    expect(body).not.toContain('const BUCKET_LABEL: Record<string, string>');
  });

  it("Clear-now DELETE endpoint contract: /v1/admin/accounts/{encodeURIComponent(id)}/quota-override?bucket_key={encodeURIComponent(bucketKey)} + method:'DELETE' + Bearer auth + credentials:'include' + window.confirm pre-prompt — pinned so the destructive action requires explicit confirmation + URL encoding handles the colon in bucket-keys like 'sessions:create' (raw colon would break path parsing)", () => {
    expect(body).toMatch(
      /await window\.driftstackConfirm\(\s*\n?\s*'Clear the ' \+ bucketKey \+ ' override for ' \+ prefixedAccountId \+ '\?',/,
    );
    expect(body).toMatch(
      /apiBaseUrl \+\s*\n?\s*'\/v1\/admin\/accounts\/' \+\s*\n?\s*encodeURIComponent\(prefixedAccountId\) \+\s*\n?\s*'\/quota-override\?bucket_key=' \+\s*\n?\s*encodeURIComponent\(bucketKey\),\s*\n?\s*\{\s*\n?\s*method: 'DELETE',/,
    );
  });

  it("live fmtIso renders a null expiry as 'permanent'", () => {
    expect(body).toMatch(
      /function fmtIso\(iso\) \{\s*\n?\s*if \(!iso\) return 'permanent';\s*\n?\s*return new Date\(iso\)\.toISOString\(\)\.replace\('T', ' '\)\.slice\(0, 16\) \+ ' UTC';\s*\n?\s*\}/,
    );
  });

  it("Filter bar: account-id text input + include-expired checkbox + 'No overrides' empty-state region (data-region='empty' hidden initially) + 200ms debounce on input/change — pinned so the include-expired toggle re-fetches via include_expired=true query param (drift would silently disable the toggle)", () => {
    expect(body).toMatch(/data-field="include-expired"/);
    expect(body).toMatch(/Include expired/);
    expect(body).toMatch(/<div data-region="empty" class="hidden">/);
    expect(body).toMatch(
      /if \(includeExpiredEl && includeExpiredEl\.checked\)\s*\n?\s*params\.set\('include_expired', 'true'\);/,
    );
    expect(body).toMatch(/setTimeout\(loadWithLive, 200\)/);
  });

  it('Live Clear controls retain account-id and bucket-key event-delegation attributes', () => {
    expect(body).toMatch(
      /'<button type="button" data-action="clear" data-account-id="' \+[\s\S]*?'" data-bucket-key="' \+/,
    );
    expect(body).toMatch(
      /const btn = target\.closest\('\[data-action="clear"\]'\);\s*\n?\s*if \(!btn\) return;\s*\n?\s*ev\.preventDefault\(\);\s*\n?\s*const accountId = btn\.getAttribute\('data-account-id'\);\s*\n?\s*const bucketKey = btn\.getAttribute\('data-bucket-key'\);\s*\n?\s*if \(accountId && bucketKey\) clear\(accountId, bucketKey, btn\);/,
    );
  });

  it('Live capacity rendering escapes the authoritative numeric value', () => {
    expect(body).toMatch(/escapeHtml\(String\(o\.capacity\)\)/);
  });

  it("Banner state taxonomy: no-token / 403 forbidden / fetch-error on load + 'Clearing override…' / 'Override cleared. Refreshing…' / 'Couldn't clear (mapped error).' on action — pinned so the 6-state banner vocabulary matches the rest of the admin pages + the 204-No-Content success path on DELETE is handled correctly", () => {
    expect(body).toMatch(/showBanner\('Clearing override…'\);/);
    expect(body).toMatch(/showBanner\('Override cleared\. Refreshing…'\);/);
    expect(body).toMatch(
      /const msg = requestErrorMessage\(err, 'network error'\);\s*showBanner\("Couldn't clear \(" \+ msg \+ '\)\.'\);/,
    );
    expect(body).toMatch(
      /if \(response\.status !== 204 && !response\.ok\) \{\s*throw new Error\('HTTP ' \+ response\.status\);\s*\}/,
    );
  });

  it('Clear operations are deadline-bounded, serialized per account/bucket, accessible while pending, and reconcile an unknown timeout outcome before suggesting a retry', () => {
    expect(body).toMatch(/const OVERRIDE_TIMEOUT_MS = 15_000;/);
    expect(body).toMatch(
      /window\.driftstackFetchWithDeadline\(url, init, OVERRIDE_TIMEOUT_MS, controller\)/,
    );
    expect(body).toMatch(/const clearsInFlight = new Set\(\);/);
    expect(body).toMatch(
      /if \(clearsInFlight\.has\(operationKey\)\) return;\s*clearsInFlight\.add\(operationKey\);/,
    );
    expect(body).toMatch(
      /btn\.disabled = true;\s*btn\.setAttribute\('aria-busy', 'true'\);\s*btn\.textContent = 'Confirming…';/,
    );
    expect(body).toMatch(
      /if \(err && err\.name === 'AbortError'\) \{\s*const refreshed = await load\(\);[\s\S]*?const stillActionable = Array\.from\(/,
    );
    expect(body).toMatch(
      /clearsInFlight\.delete\(operationKey\);\s*syncClearControls\(prefixedAccountId, bucketKey\);/,
    );
  });

  it('Signed-out and failed loads replace overrides with a non-actionable row and never present the empty-live state as authoritative', () => {
    expect(body).toMatch(
      /function renderUnavailable\(message\) \{[\s\S]*?list\.classList\.remove\('hidden'\);[\s\S]*?list\.innerHTML =[\s\S]*?escapeHtml\(message\) \+[\s\S]*?'[^']*<\/li>';[\s\S]*?if \(emptyRegion\) emptyRegion\.classList\.add\('hidden'\);[\s\S]*?\}/,
    );
    expect(body).toMatch(
      /\.catch\(\(err\) => \{[\s\S]*?renderUnavailable\(\s*'Could not load live overrides — nothing to act on\. Resolve the error above and retry\.',\s*\);/,
    );
    expect(body).toMatch(
      /if \(!token\) \{\s*renderUnavailable\('Sign in with a staff admin account to see rate-limit overrides\.'\);[\s\S]*?showBanner\('Sign in with a staff admin account to see live data\.'\);/,
    );
    expect(body).toMatch(/if \(loaded\) \{[\s\S]*?setLiveState\('ready'\);/);
    expect(body).toMatch(/if \(expectedReq !== inFlight\) return loaded;/);
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
    expect(body).toMatch(/document\.addEventListener\('DOMContentLoaded', start\);/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
