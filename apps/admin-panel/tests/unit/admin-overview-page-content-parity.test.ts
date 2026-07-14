// W358.C — drift guard for admin-panel /index (Overview) page
// content. V-190 progressive-enhancement against the admin overview
// + audit-log endpoints. Pinned:
//
//   • GET /v1/admin/overview + GET /v1/admin/audit-log?limit=5
//     both registered server-side.
//   • Tile data-fields (active-accounts / suspended-accounts /
//     dlq-depth) map to overview-response keys
//     (accounts.active / accounts.suspended / webhooks.dlq_depth).
//   • Open-leads tile is intentionally on mock (leads endpoint
//     deferred) — pinned so a future fake "live" wire-up doesn't
//     ship before the endpoint lands.
//   • "All actions on this panel are audit-logged" promise stays
//     pinned (D-025 audit-before-response contract) — this is the
//     staff-facing transparency commitment.
//   • 403 → "admin scope required" handling pinned (no silent
//     redirect; the message names the cause).
//   • localStorage key ds_web_session_token (admin-panel reads
//     from the same key as customer-dashboard; mismatch silently
//     locks staff out).
//   • Cross-link to /audit-log resolves.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/admin-panel/src/pages/index.astro');
const OVERVIEW_ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/admin-overview.ts');
const AUDIT_ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/admin-audit-log.ts');
const BILLING_ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/admin-billing.ts');
const OWNER_ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/admin-owner.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W358.C admin-panel /index overview page content parity', () => {
  const body = read(PAGE);

  it('GET /v1/admin/overview + GET /v1/admin/audit-log both registered server-side', () => {
    expect(body).toContain("authedFetch('/v1/admin/overview')");
    expect(body).toContain("authedFetch('/v1/admin/audit-log?limit=5')");
    expect(existsSync(OVERVIEW_ROUTE)).toBe(true);
    expect(read(OVERVIEW_ROUTE)).toContain("'/v1/admin/overview'");
    expect(existsSync(AUDIT_ROUTE)).toBe(true);
    expect(read(AUDIT_ROUTE)).toContain("'/v1/admin/audit-log'");
  });

  it('paying-subscriber card hits GET /v1/admin/billing/subscriptions/stats (best-effort) + server registers it', () => {
    expect(body).toContain("authedFetch('/v1/admin/billing/subscriptions/stats')");
    expect(body).toContain("setText('paying-total'");
    expect(body).toMatch(/data-list="paying-tier-distribution"/);
    expect(existsSync(BILLING_ROUTE)).toBe(true);
    expect(read(BILLING_ROUTE)).toContain("'/v1/admin/billing/subscriptions/stats'");
  });

  it('owner platform-status card hits GET /v1/admin/owner/platform-status (owner-gated, reveal-on-200) + server registers it', () => {
    expect(body).toContain("authedFetch('/v1/admin/owner/platform-status')");
    expect(body).toContain('renderPlatformStatus');
    expect(body).toMatch(/data-owner-only="platform-status"/);
    // SSR-hidden, revealed via classList.remove('hidden') only on success.
    expect(body).toContain("card.classList.remove('hidden')");
    expect(existsSync(OWNER_ROUTE)).toBe(true);
    expect(read(OWNER_ROUTE)).toContain("'/v1/admin/owner/platform-status'");
  });

  it('owner pricing card hits GET /v1/admin/owner/pricing (owner-gated, reveal-on-200) + server registers it', () => {
    expect(body).toContain("authedFetch('/v1/admin/owner/pricing')");
    expect(body).toContain('renderPricing');
    expect(body).toMatch(/data-list="owner-pricing"/);
    expect(read(OWNER_ROUTE)).toContain("'/v1/admin/owner/pricing'");
  });

  it('owner pricing saves are confirm-gated and single-flight per tier', () => {
    expect(body).toMatch(/const pricingSavesInFlight = new Set\(\);/);
    expect(body).toMatch(/pricingSavesInFlight\.has\(tier\)/);
    expect(body).toMatch(/confirmLabel: 'Save price'/);
    expect(body).toMatch(/This changes the price used for future purchases/);
    expect(body).toMatch(/button\.textContent = 'Saving…'/);
    expect(body).toMatch(/button\.setAttribute\('aria-busy', 'true'\)/);
    expect(body).toMatch(/pricingSavesInFlight\.delete\(tier\)/);
    expect(body).toMatch(/if \(pricingSavesInFlight\.size > 0\) return;/);
  });

  it('reconciles ambiguous owner pricing saves against effective pricing', () => {
    expect(body).toMatch(/const refreshed = await fetchPricing\(\)\.catch\(\(\) => null\)/);
    expect(body).toMatch(/candidate && candidate\.tier === tier/);
    expect(body).toMatch(/liveCents === cents/);
    expect(body).toContain('the save completed, so do not submit it again');
    expect(body).toContain('Verify the tier price before retrying');
  });

  it('irreversible owner-secret deletion uses the branded destructive modal and the shared secret-action guard', () => {
    expect(body).toMatch(/let secretActionInFlight = null;/);
    expect(body).toMatch(/beginSecretAction\(name, 'delete', 'Confirming…'\)/);
    expect(body).toMatch(/window\.driftstackConfirm/);
    expect(body).toMatch(/confirmLabel: 'Delete secret',\s*destructive: true/);
    expect(body).toMatch(/button\.textContent = 'Deleting…'/);
    expect(body).toMatch(/button\.setAttribute\('aria-busy', 'true'\)/);
    expect(body).not.toMatch(/if \(!window\.confirm\('Delete secret/);
  });

  it('reconciles ambiguous owner-secret deletion against refreshed metadata', () => {
    expect(body).toContain("timeoutError.name = 'AbortError'");
    expect(body).toMatch(/const refreshed = await fetchSecrets\(\)\.catch\(\(\) => null\)/);
    expect(body).toMatch(
      /refreshed\.secrets\.some\(\(secret\) => secret && secret\.name === name\)/,
    );
    expect(body).toContain('deletion completed, so do not submit it again');
    expect(body).toContain('Verify the secret before retrying');
  });

  it('owner-secret writes are confirm-gated and single-flight without logging the value', () => {
    expect(body).toMatch(/if \(secretActionInFlight !== null\)/);
    expect(body).toMatch(/beginSecretAction\(name, 'save', 'Confirming…'\)/);
    expect(body).toMatch(/form\.setAttribute\('aria-busy', 'true'\)/);
    expect(body).toMatch(/confirmLabel: 'Save secret'/);
    expect(body).toMatch(/The value is never written to the audit log/);
    expect(body).toMatch(/if \(submit\) submit\.textContent = 'Saving…'/);
    expect(body).toMatch(/endSecretAction\('save'\);\s*form\.removeAttribute\('aria-busy'\)/);
  });

  it('treats accepted owner-secret status as authoritative when cosmetic JSON is malformed', () => {
    expect(body).toContain('Accepted status is the secret-save boundary');
    const start = body.indexOf('async function saveSecret(form)');
    const end = body.indexOf('if (secretForm)', start);
    const handler = body.slice(start, end);
    expect(handler).toMatch(/response\.json\(\)\.catch\(\(\) => \(\{\}\)\)/);
    expect(handler).toContain(": 'saved ✓'");
    expect(handler).toMatch(/form\.reset\(\);\s*await fetchSecrets\(\)/);
  });

  it('reconciles ambiguous owner-secret saves against versioned metadata', () => {
    expect(body).toMatch(/let secretMetadataByName = new Map\(\)/);
    expect(body).toMatch(/const previouslyPresent = secretMetadataByName\.has\(name\)/);
    expect(body).toMatch(/String\(liveSecret\.updated_at \|\| ''\) !== previousUpdatedAt/);
    expect(body).toContain('the save likely completed, so do not overwrite it again');
    expect(body).toContain('Validate the dependent integration before another change');
    expect(body).toContain('a new metadata version could not be confirmed');
  });

  it('owner-secret reveal is single-flight and clears plaintext on hide/failure', () => {
    expect(body).toMatch(/beginSecretAction\(name, 'reveal', 'Revealing…'\)/);
    expect(body).toMatch(/button\.textContent = 'Revealing…'/);
    expect(body).toMatch(/button\.setAttribute\('aria-busy', 'true'\)/);
    expect(body).toMatch(/out\.textContent = '';/);
    expect(body).toMatch(/endSecretAction\('reveal'\)/);
    expect(body).toMatch(/out\.classList\.contains\('hidden'\) \? 'Reveal' : 'Hide'/);
  });

  it('serializes every owner-secret control with a visible wait reason', () => {
    expect(body).toContain('Wait for the active secret action to finish.');
    expect(body).toMatch(/button\.disabled = active !== null/);
    expect(body).toMatch(/secretForm\.setAttribute\('aria-disabled', 'true'\)/);
    expect(body).toMatch(/syncSecretActionControls\(\)/);
  });

  it('tile data-fields map to overview-response keys', () => {
    // The progressive-enhancement script setText()s these three
    // fields from the body.accounts / body.webhooks payload —
    // renaming on either side without coordination silently
    // shows stale mock data forever.
    expect(body).toMatch(/data-field="active-accounts"/);
    expect(body).toMatch(/data-field="suspended-accounts"/);
    expect(body).toMatch(/data-field="dlq-depth"/);
    expect(body).toMatch(/setText\('active-accounts',\s*String\(body\.accounts\.active\)\)/);
    expect(body).toMatch(/setText\('suspended-accounts',\s*String\(body\.accounts\.suspended\)\)/);
    expect(body).toMatch(/setText\('dlq-depth',\s*String\(body\.webhooks\.dlq_depth\)\)/);
  });

  it('3rd health tile is the REAL Open-incidents KPI (2026-06-03 — replaced the former mock leads tile)', () => {
    // The 3rd of the 4 health tiles was a mock (MOCK_LEADS.length) until
    // 2026-06-03; it is now a real "Open incidents" count from
    // /v1/admin/incidents (status !== resolved), SSR'd as an honest "—"
    // placeholder that hydrates to the live count. Guards against (a) the
    // mock tile coming back and (b) the data-field/wiring being dropped.
    expect(body).toMatch(/data-field="incidents-open">—</);
    expect(body).toMatch(/authedFetch\('\/v1\/admin\/incidents'\)/);
    expect(body).toContain("setText('incidents-open'");
    // The old mock tile + its caveat must be gone.
    expect(body).not.toContain('MOCK_LEADS.length');
    expect(body).not.toMatch(/mock — leads endpoint TBD/);
  });

  it('D-025 audit-before-response contract pinned (staff-transparency commitment)', () => {
    expect(body).toMatch(
      /All actions on this panel are audit-logged with admin id \+ target id \+\s+input payload \+ ip address/,
    );
    expect(body).toMatch(
      /Audit trail is append-only and cannot be\s+mutated by admins \(D-025 audit-before-response contract\)/,
    );
  });

  it('403 → "admin scope required" copy pinned (no silent redirect)', () => {
    expect(body).toMatch(/r\.status === 403/);
    expect(body).toMatch(/forbidden/);
    expect(body).toMatch(
      /Access denied — admin scope required\. You are signed in as a customer account\./,
    );
  });

  it('audit-row payload-shape (timestamp / admin_account_id / target_account_id / action / result) pinned', () => {
    // The renderAudits() function destructures these specific keys
    // off each row — a server-side field rename would silently
    // render blanks.
    for (const key of [
      'entry.timestamp',
      'entry.admin_account_id',
      'entry.target_account_id',
      'entry.action',
      'entry.result',
    ]) {
      expect(body).toContain(key);
    }
  });

  it('localStorage key ds_web_session_token (admin-panel shares the customer-dashboard convention)', () => {
    expect(body).toContain("'ds_web_session_token'");
  });

  it('"recent admin activity" → /audit-log full-log cross-link resolves', () => {
    expect(body).toMatch(/<a href="\/audit-log\/"/);
    expect(body).toMatch(/See full log →/);
    expect(existsSync(resolve(REPO_ROOT, 'apps/admin-panel/src/pages/audit-log.astro'))).toBe(true);
  });

  it('no-token state: shows "sign-in" banner and clears every live-data region', () => {
    // V-190 / V-191 — page surfaces a "sign-in to see live data"
    // banner when the staff visitor has no token (no hard-redirect).
    // W604 — the inert SSR shell and every independently hydrated region
    // reset to neutral placeholders, so the no-token state never presents
    // fabricated or stale platform metrics.
    expect(body).toMatch(/if \(!token\)/);
    expect(body).toMatch(/Sign in with a staff admin account to see live data\./);
    expect(body).not.toMatch(/Showing preview below\./);
    expect(body).toMatch(/function renderOverviewUnavailable\(\)/);
    expect(body).toMatch(/function renderSessionsUnavailable\(\)/);
    expect(body).toMatch(/function renderIncidentsUnavailable\(\)/);
    expect(body).toMatch(
      /renderOverviewUnavailable\(\);\s*renderSessionsUnavailable\(\);\s*renderIncidentsUnavailable\(\);/,
    );
    expect(body).toContain("renderAuditsUnavailable('Sign in to load recent admin activity.')");
  });
});
