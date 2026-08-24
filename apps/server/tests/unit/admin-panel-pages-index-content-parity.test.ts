// W487.C — drift guard for apps/admin-panel/src/pages/index.astro.
// V-190 admin overview page — progressive-enhancement against
// /v1/admin/overview + /v1/admin/audit-log?limit=5. Drift here
// either drops the D-025 audit-before-response framing (operators
// lose the contract that audit-log writes precede the action's
// HTTP response) or breaks the 4-tile layout (active / suspended
// / leads / DLQ depth — the at-a-glance fleet-health surface).
//
//   • V-190 framing pinned + 'Open-leads tile remains on mock'
//     comment.
//   • 4-tile grid: active-accounts / suspended-accounts /
//     open-leads (mock) / dlq-depth.
//   • Recent admin activity → /audit-log full-log link.
//   • D-025 'audit-before-response contract' framing.
//   • 403 forbidden branch: 'Access denied — admin scope required.'
//   • Token key: 'ds_web_session_token'.
//   • authedFetch: apiBaseUrl + path + Bearer + credentials:'include'.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/admin-panel/src/pages/index.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W487.C apps/admin-panel/src/pages/index.astro content parity', () => {
  const body = read(LIB);

  it('V-190 framing pins an inert unavailable shell that never presents sample data as operational truth', () => {
    expect(body).toMatch(
      /\/\/ V-190 — progressive-enhancement against \/v1\/admin\/overview \+\s*\/\/ \/v1\/admin\/audit-log\?limit=5\. SSG renders an inert unavailable shell;\s*\/\/ an inline <script> fetches both endpoints and replaces the tile values\s*\/\/ \+ recent-activity list\.[\s\S]*?without presenting sample data as operational truth\./,
    );
    expect(body).toMatch(
      /\/\/ 2026-06-03 — the 3rd health tile is now a REAL "Open incidents" count\s*\n?\s*\/\/ from \/v1\/admin\/incidents\?state=open&limit=1 \(SQL-before-limit \+ exact\s*\n?\s*\/\/ open_count\), replacing a prior mock tile so the grid carries no fabricated number\./,
    );
  });

  it('The four canonical health tiles render neutral placeholders until authoritative live values arrive', () => {
    expect(body).toMatch(
      /<p class="font-mono text-xs uppercase tracking-widest text-tk-ink-3">Active accounts<\/p>/,
    );
    expect(body).toMatch(/data-field="active-accounts"/);
    expect(body).toMatch(
      /<p class="font-mono text-xs uppercase tracking-widest text-tk-ink-3">Suspended<\/p>/,
    );
    expect(body).toMatch(/data-field="suspended-accounts"/);
    expect(body).toMatch(
      /<p class="font-mono text-xs uppercase tracking-widest text-tk-ink-3">Open incidents<\/p>/,
    );
    // Honest SSR placeholder (no fabricated number) — hydrates to the real count.
    expect(body).toMatch(/data-field="incidents-open">—<\/p>/);
    // The mock-leads tile + its "mock — leads endpoint TBD" caveat must be GONE.
    expect(body).not.toMatch(/Open leads/);
    expect(body).not.toMatch(/leads endpoint TBD/);
    expect(body).toMatch(
      /<p class="font-mono text-xs uppercase tracking-widest text-tk-ink-3">DLQ depth<\/p>/,
    );
    expect(body).toMatch(/data-field="dlq-depth">—<\/p>/);
  });

  it('Recent admin activity uses the canonical route, an unavailable static shell, and a distinct authoritative empty state', () => {
    expect(body).toMatch(
      /<a href="\/audit-log\/" class="text-tk-accent hover:underline">\s*See full log →\s*<\/a>/,
    );
    expect(body).toMatch(/Live admin activity unavailable until loaded\./);
    expect(body).toMatch(
      /if \(entries\.length === 0\) \{\s*list\.innerHTML =\s*'<li class="py-3 text-sm text-tk-ink-3">No admin actions recorded yet\.<\/li>';/,
    );
  });

  it("D-025 audit-before-response framing pinned: 'All actions on this panel are audit-logged with admin id + target id + input payload + ip address. Audit trail is append-only and cannot be mutated by admins (D-025 audit-before-response contract).' — pinned so the audit-trail integrity guarantee survives (drift to a softer phrasing weakens the immutability contract that operators rely on for compliance review)", () => {
    expect(body).toMatch(
      /All actions on this panel are audit-logged with admin id \+ target id \+\s*\n?\s*input payload \+ ip address\. Audit trail is append-only and cannot be\s*\n?\s*mutated by admins \(D-025 audit-before-response contract\)\./,
    );
  });

  it('Signed-out, forbidden, and failed overview states keep their distinct operator guidance', () => {
    expect(body).toMatch(/showBanner\('Sign in with a staff admin account to see live data\.'\);/);
    expect(body).toMatch(
      /showBanner\(\s*\n?\s*'Access denied — admin scope required\. You are signed in as a customer account\.',\s*\n?\s*\);/,
    );
    expect(body).toMatch(/showBanner\("Couldn't load overview \(" \+ msg \+ '\)\.'\);/);
  });

  it("Token storage key 'ds_web_session_token' + authedFetch helper: apiBaseUrl + path + 'authorization: Bearer ' + credentials:'include' — pinned so the customer-dashboard ↔ admin-panel token-storage key stays in sync and the credentials-include flag carries the session cookie (required for V-269 dual-cookie session model on cross-origin admin requests)", () => {
    expect(body).toMatch(
      /let token = '';\s*\n?\s*try \{\s*\n?\s*token = localStorage\.getItem\('ds_web_session_token'\) \|\| '';\s*\n?\s*\} catch \(_\) \{\s*\n?\s*token = '';/,
    );
    // 2026-06-05: authedFetch gained an optional `init` (so the owner pricing
    // PATCH can issue a non-GET) — it still injects the bearer + credentials.
    // Pinned as discrete facts rather than a brittle full-body regex.
    expect(body).toMatch(/function authedFetch\(path, init\) \{/);
    expect(body).toContain("authorization: 'Bearer ' + token");
    expect(body).toContain("credentials: 'include'");
    expect(body).toMatch(/\.driftstackFetchWithDeadline\(\s*apiBaseUrl \+ path,/);
    expect(body).toMatch(/15_000,/);
  });

  it('starts recent-activity freshness neutral and keeps manual refresh inert before staff identity is available', () => {
    expect(body).toContain('data-live-status>Waiting for live data</span>');
    expect(body).toMatch(/data-live-age class="hidden"/);
    expect(body).toMatch(
      /data-live-refresh\s*\n?\s*disabled\s*\n?\s*aria-disabled="true"\s*\n?\s*title="Available after staff sign-in\."/,
    );
    expect(body).not.toMatch(/data-live-dot[\s\S]{0,120}bg-emerald-500/);
    expect(body).not.toContain('Live · updated <span data-live-age>just now</span>');
  });

  it('waits for AdminLayout SSO handoff before acquiring token authority or starting overview reads', () => {
    expect(body).toMatch(
      /\(async function \(\) \{\s*\n?\s*if \(document\.readyState === 'loading'\) \{\s*\n?\s*await new Promise\(\(resolve\) => \{\s*\n?\s*document\.addEventListener\('DOMContentLoaded', resolve, \{ once: true \}\);/,
    );
    expect(body.indexOf("localStorage.getItem('ds_web_session_token')")).toBeGreaterThan(
      body.indexOf("document.addEventListener('DOMContentLoaded', resolve"),
    );
  });

  it('publishes activity freshness only after the audit read succeeds and visibly revokes it on failure', () => {
    expect(body).toMatch(
      /function fetchAudit\(\) \{\s*\n?\s*setAuditLiveState\('loading', 'Loading live activity…'\);/,
    );
    expect(body).toMatch(
      /renderAudits\(body\.data \|\| \[\]\);\s*\n?\s*lastAuditFetch = Date\.now\(\);\s*\n?\s*setAuditLiveState\('success', 'Live'\);/,
    );
    expect(body).toMatch(
      /\.catch\(\(err\) => \{\s*\n?\s*setAuditLiveState\('error', 'Live activity unavailable'\);\s*\n?\s*renderAuditsUnavailable\('Could not load recent admin activity\. Refresh to try again\.'\);/,
    );
    expect(body).toContain('let lastAuditFetch = null;');
  });

  it("Endpoint contract: GET /v1/admin/overview reads body.accounts.{active,suspended,total} + body.webhooks.dlq_depth into the live tiles + GET /v1/admin/audit-log?limit=5 reads body.data[] into the recent-activity list — pinned so the field names match the server response shape (drift to body.active_accounts or body.dlq would silently zero out the tile). Slice 136 added a 'of N total' annotation under the Active-accounts tile, surfacing the V-515 server-returned `body.accounts.total` field (with a defensive a+s+d fallback if total is missing)", () => {
    expect(body).toMatch(/authedFetch\('\/v1\/admin\/overview'\)/);
    expect(body).toMatch(/authedFetch\('\/v1\/admin\/audit-log\?limit=5'\)/);
    expect(body).toMatch(/setText\('active-accounts', String\(body\.accounts\.active\)\);/);
    expect(body).toMatch(/setText\('suspended-accounts', String\(body\.accounts\.suspended\)\);/);
    expect(body).toMatch(/setText\('dlq-depth', String\(body\.webhooks\.dlq_depth\)\);/);
    // Slice 136 — total-accounts annotation reads body.accounts.total
    // with a defensive a+s+d fallback so missing-field doesn't NaN.
    expect(body).toMatch(/body\.accounts\.total/);
    expect(body).toMatch(/setText\('total-accounts-annotation'/);
    expect(body).toMatch(/data-field="total-accounts-annotation"/);
  });

  it("Audit-log render: per-entry timestamp via fmtIso to 'YYYY-MM-DD HH:MM:SS UTC' (slice(0, 19) — not 16 like the leads page, because audit-log needs second-level precision) + admin identity + arrow + entry.action code + entry.result success/error badge. V-1514 — the email-primary half is a PLACEHOLDER and this title used to describe it as a rendering. `publicEntry` in routes/admin-audit-log.ts projects no email of any kind, so `entry.admin_email` is undefined on every entry the route has ever sent and the `||` always falls through to the id. The pattern is real on the Accounts list, whose AdminAccount payload does carry `email` — it was copied to a surface whose endpoint does not enrich. The operand stays, deliberately, and the assertion below anchors WHY it is inert so the day the route starts enriching, this arm has to be revisited rather than quietly becoming true.", () => {
    expect(body).toMatch(/\.slice\(0, 19\) \+ ' UTC';/);
    expect(body).toMatch(
      /entry\.result === 'success'\s*\n?\s*\? 'bg-emerald-50 text-emerald-700'\s*\n?\s*: 'bg-red-50 text-red-700';/,
    );
    // Actor is email-primary with the admin_account_id UUID as the fallback.
    expect(body).toMatch(/escapeHtml\(entry\.admin_email \|\| entry\.admin_account_id\)/);
    // The target row likewise prefers the email with the account-id UUID as fallback.
    expect(body).toMatch(/escapeHtml\(entry\.target_email \|\| entry\.target_account_id\)/);
    // V-1514 — the anchor. The admin audit projection carries no email of any
    // kind, which is what makes both operands above permanently short-circuited.
    const projection = readFileSync(
      resolve(REPO_ROOT, 'apps/server/src/routes/admin-audit-log.ts'),
      'utf8',
    );
    const publicEntry = projection.slice(
      projection.indexOf('function publicEntry('),
      projection.indexOf('\n}', projection.indexOf('function publicEntry(')),
    );
    expect(publicEntry, 'publicEntry is still the admin audit projection').toContain(
      'admin_account_id:',
    );
    expect(
      /(?:admin|target)_email\s*:/.test(publicEntry),
      'the route now enriches audit entries with an email — the placeholder above is live, so ' +
        'update this arm to describe a rendering rather than a fallback',
    ).toBe(false);
    expect(body).toMatch(/escapeHtml\(entry\.action\)/);
  });

  it("apiBaseUrl injection: resolveApiBaseUrl() call + define:vars (apiBaseUrl + tier order/labels) on the inline script tag — pinned so the API base URL + tier metadata are injected at SSG time (not at runtime via env-var lookup that wouldn't exist in the browser) and the inline script can prefix every authedFetch with the right host", () => {
    expect(body).toMatch(/import \{ resolveApiBaseUrl \} from '\.\.\/lib\/api-base-url';/);
    expect(body).toMatch(/const apiBaseUrl = resolveApiBaseUrl\(\);/);
    expect(body).toMatch(
      /<script is:inline define:vars=\{\{ apiBaseUrl, tierOrder: TIER_ORDER, tierLabels: TIER_LABELS \}\}>/,
    );
  });

  it('accounts-by-tier section starts unavailable and hydrates only from overview.accounts.by_tier', () => {
    // Canonical tier order + friendly labels are the single source shared by
    // SSR and hydration (passed via define:vars).
    expect(body).toMatch(/const TIER_ORDER = \[/);
    expect(body).toMatch(/'free',/);
    expect(body).toMatch(/'enterprise',/);
    expect(body).toMatch(/const TIER_LABELS: Record<string, string> = \{/);
    // Static section is unavailable, not fabricated zero/sample bars.
    expect(body).toMatch(/Accounts by tier/);
    expect(body).toMatch(/data-list="tier-distribution"/);
    expect(body).toMatch(/data-field="tier-total"/);
    expect(body).toMatch(/Live tier distribution unavailable until loaded\./);
    // Live hydration reads the server field + replaces the SSR bars.
    expect(body).toMatch(/if \(body\.accounts\.by_tier\) \{/);
    expect(body).toMatch(/renderTiers\(body\.accounts\.by_tier, total\);/);
    expect(body).toMatch(/function renderTiers\(byTier, total\) \{/);
  });

  it("new-signups section: today / 7d / 30d stat fields (SSR '—' placeholders) + live hydration from overview.accounts.signups — pinned so the growth stat keeps real-data wiring (drift would drop the signup metric or leave it on the dash placeholder)", () => {
    expect(body).toMatch(/New signups/);
    expect(body).toMatch(/data-field="signups-today"/);
    expect(body).toMatch(/data-field="signups-7d"/);
    expect(body).toMatch(/data-field="signups-30d"/);
    // Live hydration reads the server window fields.
    expect(body).toMatch(/if \(body\.accounts\.signups\) \{/);
    expect(body).toMatch(/setText\('signups-today', String\(body\.accounts\.signups\.today\)\);/);
    expect(body).toMatch(/setText\('signups-7d', String\(body\.accounts\.signups\.last_7d\)\);/);
    expect(body).toMatch(/setText\('signups-30d', String\(body\.accounts\.signups\.last_30d\)\);/);
  });

  it("live-sessions section: active / errored / total stat fields (SSR '—' placeholders) + live hydration from /v1/admin/sessions/stats — pinned so the session-usage KPI keeps its real-data wiring (drift would drop the stat or leave it on the dash placeholder)", () => {
    expect(body).toMatch(/Live sessions/);
    expect(body).toMatch(/data-field="sessions-active"/);
    expect(body).toMatch(/data-field="sessions-errored"/);
    expect(body).toMatch(/data-field="sessions-total"/);
    // Dedicated fetch + hydration from the sessions-stats endpoint.
    expect(body).toMatch(/authedFetch\('\/v1\/admin\/sessions\/stats'\)/);
    expect(body).toMatch(/setText\('sessions-active', String\(body\.active\)\);/);
    expect(body).toMatch(/setText\('sessions-total', String\(body\.total\)\);/);
    expect(body).toMatch(/setText\('sessions-errored', String\(body\.by_status\.errored\)\);/);
    // Wired into the boot Promise.all gate + all-settled 30s refresh timer.
    expect(body).toMatch(/Promise\.all\(\[overviewP, auditP, sessionsP, incidentsP\]\)/);
    expect(body).toMatch(
      /Promise\.allSettled\(\[\s*fetchAudit\(\),\s*fetchOverview\(\),\s*fetchSessionStats\(\),/,
    );
  });

  it('Signed-out and independently failed reads clear only their non-authoritative regions', () => {
    expect(body).not.toMatch(/MOCK_ACCOUNTS|MOCK_AUDIT_LOG/);
    expect(body).toMatch(
      /function renderOverviewUnavailable\(\) \{[\s\S]*?setText\('active-accounts', '—'\);[\s\S]*?setText\('dlq-depth', '—'\);[\s\S]*?Live tier distribution unavailable\./,
    );
    expect(body).toMatch(
      /if \(!token\) \{\s*renderOverviewUnavailable\(\);\s*renderSessionsUnavailable\(\);\s*renderIncidentsUnavailable\(\);\s*renderAuditsUnavailable\('Sign in to load recent admin activity\.'\);/,
    );
    expect(body).toMatch(
      /function fetchOverview\(\) \{[\s\S]*?\.catch\(\(err\) => \{\s*renderOverviewUnavailable\(\);\s*throw err;/,
    );
    expect(body).toMatch(
      /function fetchSessionStats\(\) \{[\s\S]*?\.catch\(\(err\) => \{\s*renderSessionsUnavailable\(\);\s*throw err;/,
    );
    expect(body).toMatch(
      /function fetchOpenIncidents\(\) \{[\s\S]*?\.catch\(\(err\) => \{\s*renderIncidentsUnavailable\(\);\s*throw err;/,
    );
    expect(body).toMatch(
      /function fetchAudit\(\) \{[\s\S]*?\.catch\(\(err\) => \{[\s\S]*?renderAuditsUnavailable\('Could not load recent admin activity\. Refresh to try again\.'\);\s*throw err;/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
