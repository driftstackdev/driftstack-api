// W489.C — drift guard for apps/admin-panel/src/pages/api-keys.astro.
// V-193 cross-account API key view for support cases. Drift here
// either drops the 'reason required' invariant on revoke (audit
// row would land without context, breaking the customer-facing
// 'revoked by Driftstack: <reason>' surface) or breaks the
// SCOPE_LABEL 6-key catalogue (a new scope would render as the
// raw enum string instead of the friendly label).
//
//   • V-193 framing pinned + amber-50 warning callout: 'Manual
//     revocation invalidates the key immediately + cascades to
//     the auth cache. Customer's running sessions on that key
//     continue until next token check; subsequent requests
//     return 401. Audit row records admin id + key id + reason.'
//   • SCOPE_LABEL 6-key catalogue (read / write / admin /
//     account_owner / driftstack_internal_admin / gui_control →
//     read / write / admin / owner / staff / gui).
//   • Reason REQUIRED on revoke (not optional like sessions
//     destroy) — window.prompt → bail if !reason.trim() with
//     'Revoke cancelled' banner.
//   • Customer-facing audit-surface framing: 'revoked by
//     Driftstack: <reason>'.
//   • Revoked-row opacity-60 dim + revoked badge slate-100.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/admin-panel/src/pages/api-keys.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W489.C apps/admin-panel/src/pages/api-keys.astro content parity', () => {
  const body = read(LIB);

  it("V-193 framing pinned: 'progressive-enhancement against /v1/admin/api-keys (new in V-193). SSG renders a small mock; an inline <script> fetches with bearer auth. Filter bar wired (account_id text input + hide-revoked checkbox). Revoke action POSTs to existing /v1/admin/api-keys/:id/revoke with audited reason.'", () => {
    expect(body).toMatch(
      /\/\/ V-193 — progressive-enhancement against \/v1\/admin\/api-keys \(new in\s*\n?\s*\/\/ V-193\)\. SSG renders a small mock; an inline <script> fetches with\s*\n?\s*\/\/ bearer auth\. Filter bar wired \(account_id text input \+ hide-revoked\s*\n?\s*\/\/ checkbox\)\. Revoke action POSTs to existing\s*\n?\s*\/\/ \/v1\/admin\/api-keys\/:id\/revoke with audited reason\./,
    );
  });

  it("Page-purpose framing pinned: 'Cross-account key view for support cases. Manual revocation when a customer reports a leak + can't reach the dashboard, or when abuse signals trip a moderation flag.' — pinned so the use-case framing (customer-reported leak + automated abuse-moderation) survives + operators know this page is the manual escape-hatch (not a routine view)", () => {
    expect(body).toMatch(
      /Cross-account key view for support cases\. Manual revocation when a\s*\n?\s*customer reports a leak \+ can't reach the dashboard, or when abuse\s*\n?\s*signals trip a moderation flag\./,
    );
  });

  it("Amber warning callout framing pinned: 'Manual revocation invalidates the key immediately + cascades to the auth cache. Customer's running sessions on that key continue until next token check; subsequent requests return 401. Audit row records admin id + key id + reason.' — pinned so operators understand the in-flight-request grace window (running sessions get one more token check before 401) before clicking Revoke", () => {
    expect(body).toMatch(
      /Manual revocation invalidates the key immediately \+ cascades to the\s*\n?\s*auth cache\. Customer's running sessions on that key continue until\s*\n?\s*next token check; subsequent requests return 401\. Audit row records\s*\n?\s*admin id \+ key id \+ reason\./,
    );
    expect(body).toMatch(
      /class="mb-6 flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"/,
    );
  });

  it("SCOPE_LABEL 6-key catalogue duplicated frontmatter + inline-script: read → 'read' / write → 'write' / admin → 'admin' / account_owner → 'owner' / driftstack_internal_admin → 'staff' / gui_control → 'gui' — pinned so the enum→friendly-label mapping stays consistent across SSG + inline (drift would render raw enum strings like 'driftstack_internal_admin' as a 28-char chip that overflows the row)", () => {
    expect(body).toMatch(
      /const SCOPE_LABEL: Record<string, string> = \{\s*\n?\s*read: 'read',\s*\n?\s*write: 'write',\s*\n?\s*admin: 'admin',\s*\n?\s*account_owner: 'owner',\s*\n?\s*driftstack_internal_admin: 'staff',\s*\n?\s*gui_control: 'gui',\s*\n?\s*\};/,
    );
    expect(body).toMatch(
      /const SCOPE_LABEL = \{\s*\n?\s*read: 'read',\s*\n?\s*write: 'write',\s*\n?\s*admin: 'admin',\s*\n?\s*account_owner: 'owner',\s*\n?\s*driftstack_internal_admin: 'staff',\s*\n?\s*gui_control: 'gui',\s*\n?\s*\};/,
    );
  });

  it("Reason REQUIRED on revoke: branded driftstackPrompt('Reason for revoking N (required):') → !reason || !reason.trim() → 'Revoke cancelled — reason is required.' banner + bail — pinned so the audit-row 'reason' field never lands empty (drift to optional reason would break the customer-facing 'revoked by Driftstack: <reason>' surface)", () => {
    expect(body).toMatch(
      /const reason = await window\.driftstackPrompt\(\s*\n?\s*'Reason for revoking ' \+ id \+ ' \(required\):',\s*\n?\s*\{/,
    );
    expect(body).toMatch(
      /if \(!reason \|\| !reason\.trim\(\)\) \{\s*\n?\s*showBanner\('Revoke cancelled — reason is required\.'\);\s*\n?\s*return;\s*\n?\s*\}/,
    );
  });

  it('Customer-facing audit-surface framing pinned: \'Revocation fires POST /v1/admin/api-keys/:id/revoke with a required reason. The reason is stored on the audit row and surfaced to the customer in their key list ("revoked by Driftstack: <reason>").\' — pinned so operators know their reason text becomes customer-visible (drift to internal-only would weaken the transparency contract)', () => {
    expect(body).toMatch(
      /Revocation fires <code class="font-mono">POST \/v1\/admin\/api-keys\/:id\/revoke<\/code> with\s*\n?\s*a required reason\. The reason is stored on the audit row and surfaced\s*\n?\s*to the customer in their key list \("revoked by Driftstack: &lt;reason&gt;"\)\./,
    );
  });

  it('Revoke POST contract stays deadline-bounded and async: encoded endpoint + trimmed reason + Bearer/JSON/cookie auth + 204-compatible success — pinned so the customer-visible audit reason is preserved without leaving the action unbounded', () => {
    expect(body).toMatch(
      /const response = await boundedFetch\(\s*\n?\s*apiBaseUrl \+ '\/v1\/admin\/api-keys\/' \+ encodeURIComponent\(id\) \+ '\/revoke',\s*\n?\s*\{\s*\n?\s*method: 'POST',\s*\n?\s*headers: \{\s*\n?\s*authorization: 'Bearer ' \+ token,\s*\n?\s*'content-type': 'application\/json',\s*\n?\s*\},\s*\n?\s*credentials: 'include',\s*\n?\s*body: JSON\.stringify\(\{ reason: reason\.trim\(\) \}\),\s*\n?\s*\},\s*\n?\s*\);/,
    );
    expect(body).toMatch(/if \(response\.status !== 204 && !response\.ok\) \{/);
    expect(body).toMatch(/const API_KEY_TIMEOUT_MS = 15_000;/);
    expect(body).toMatch(/if \(!token \|\| revokesInFlight\.has\(id\)\) return;/);
    expect(body).toMatch(/btn\.setAttribute\('aria-busy', 'true'\);/);
    expect(body).toMatch(/if \(err && err\.name === 'AbortError'\) \{/);
    expect(body).toMatch(/const refreshed = await load\(\);/);
  });

  it("Revoked-row visual treatment: SSG row class:list with opacity-60 when revokedAt !== null + inline rowHtml opacityClass = revoked ? 'opacity-60' : '' — pinned so revoked keys stay visible but visually de-emphasized (drift to hiding revoked keys would lose audit-history visibility) and drift between SSG + inline opacity-class would cause a hydrate flash", () => {
    expect(body).toMatch(
      /class:list=\{\['hover:bg-tk-bg', key\.revokedAt !== null && 'opacity-60'\]\}/,
    );
    expect(body).toMatch(
      /const revoked = k\.revoked_at !== null;\s*\n?\s*const opacityClass = revoked \? 'opacity-60' : '';/,
    );
  });

  it('Status-badge 2-tone duplicated: revoked → slate-100/slate-600 + active → emerald-50/emerald-700 (SSG ternary + inline statusBadge const) — pinned so the active/revoked binary stays visually distinct + drift between the two render paths would cause a hydrate flash', () => {
    expect(body).toMatch(
      /\{key\.revokedAt !== null \? \(\s*\n?\s*<span class="inline-flex rounded-full bg-tk-hover px-2 py-0\.5 text-xs font-medium uppercase tracking-wide text-tk-ink-2">\s*\n?\s*revoked\s*\n?\s*<\/span>\s*\n?\s*\) : \(\s*\n?\s*<span class="inline-flex rounded-full bg-emerald-50 px-2 py-0\.5 text-xs font-medium uppercase tracking-wide text-emerald-700">\s*\n?\s*active\s*\n?\s*<\/span>\s*\n?\s*\)\}/,
    );
    expect(body).toMatch(
      /const statusBadge = revoked\s*\n?\s*\? '<span class="inline-flex rounded-full bg-tk-hover px-2 py-0\.5 text-xs font-medium uppercase tracking-wide text-tk-ink-2">revoked<\/span>'\s*\n?\s*: '<span class="inline-flex rounded-full bg-emerald-50 px-2 py-0\.5 text-xs font-medium uppercase tracking-wide text-emerald-700">active<\/span>';/,
    );
  });

  it('Filter bar: account-id text input + hide-revoked checkbox → revoked=false query param (when checked) — pinned so the hide-revoked toggle maps to the right server-side filter (revoked=false, not hide_revoked=true) and operators see active-only keys when the checkbox is on', () => {
    expect(body).toMatch(
      /if \(hideRevokedEl && hideRevokedEl\.checked\) params\.set\('revoked', 'false'\);/,
    );
    expect(body).toMatch(/Hide revoked/);
  });

  it("Revoke button visibility: only shown when revokedAt === null (in both SSG ternary + inline actionCell) — pinned so already-revoked keys don't show a button that would 409/no-op (drift to always-show would create operator confusion when clicks return error)", () => {
    expect(body).toMatch(
      /\{key\.revokedAt === null && \(\s*\n?\s*<button\s*\n?\s*type="button"\s*\n?\s*data-action="revoke"\s*\n?\s*data-id=\{key\.id\}/,
    );
    expect(body).toMatch(
      /const actionCell = !revoked\s*\n?\s*\? '<button type="button" data-action="revoke" data-id="' \+/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
