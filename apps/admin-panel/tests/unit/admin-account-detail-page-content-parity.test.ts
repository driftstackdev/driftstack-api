// W365.C — drift guard for admin-panel /accounts/[id] detail
// page content. V-191 + V-196 + V-200 + V-281. The detail
// surface is the canonical staff workflow for tier changes,
// suspends, rate-limit overrides, support notes, and refund
// records — every action needs a registered route + audit
// action. Pinned:
//
//   • Static-shell Cloudflare Pages rewrite keeps deep links to
//     non-mock UUIDs working without an SSR Worker.
//   • All 5 admin-action endpoints used by the page registered
//     server-side: POST .../tier, .../suspend, .../unsuspend,
//     .../audit-note, .../refund-record (note: refund-record
//     is the route, NOT refund-records).
//   • All 5 audit actions emitted by these routes pinned:
//     account.tier_changed, account.suspended (etc.),
//     admin.support_note, admin.refund_recorded.
//   • Rate-limit-override form lives on this page (Decision 4
//     from founder review) — not on /rate-limit-overrides.
//   • Bucket select options match the canonical
//     SetQuotaOverrideRequestSchema enum
//     (global / sessions:create / agent_sessions:message) — the
//     server 400s on anything else (the old session_create / capture
//     values were rejected).
//   • STATUS_BADGE map covers account-status taxonomy
//     (active / suspended / deleted) — same set as accounts
//     list page.
//   • localStorage key ds_web_session_token.
//   • Back link to /accounts works.
//   • Suspend-button visibility gated by status === 'active';
//     unsuspend-button by status === 'suspended'.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/admin-panel/src/pages/shells/account-detail.astro');
const REDIRECTS = resolve(REPO_ROOT, 'apps/admin-panel/public/_redirects');
const ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/admin-accounts.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W365.C admin-panel /accounts/[id] detail page content parity', () => {
  const body = read(PAGE);
  const route = read(ROUTE);

  it('static Pages shell preserves arbitrary account deep links', () => {
    expect(body).not.toMatch(/export const prerender = false/);
    expect(read(REDIRECTS)).toMatch(/^\/accounts\/:id \/shells\/account-detail\/ 200$/m);
    expect(body).toMatch(/window\.location\.pathname/);
  });

  it('CRITICAL per-account cost fetch uses the BARE accountUuid, NOT the acc_-prefixed id — /v1/admin/cost/accounts/:id matches accounts.id (a bare uuid) directly (unlike the prefix-stripping /v1/admin/accounts/:id), so a prefixed id 404s + soft-fails to "No cost data this cycle yet"', () => {
    expect(body).toMatch(/\/v1\/admin\/cost\/accounts\/\$\{encodeURIComponent\(accountUuid\)\}/);
    // Regression guard: must NOT send the prefixed id to the cost endpoint.
    expect(body).not.toMatch(/\/v1\/admin\/cost\/accounts\/\$\{encodeURIComponent\(prefixedId\)\}/);
  });

  it('all 5 admin-action endpoints registered server-side', () => {
    expect(existsSync(ROUTE)).toBe(true);
    for (const r of [
      "'/v1/admin/accounts/:id/tier'",
      "'/v1/admin/accounts/:id/suspend'",
      "'/v1/admin/accounts/:id/unsuspend'",
      "'/v1/admin/accounts/:id/audit-note'",
      "'/v1/admin/accounts/:id/refund-record'",
    ]) {
      expect(route, `route missing: ${r}`).toContain(r);
    }
  });

  it('audit actions emitted by the routes pinned (tier_changed / suspended / support_note / refund_recorded)', () => {
    for (const action of [
      "'account.tier_changed'",
      "'account.suspended'",
      "'admin.support_note'",
      "'admin.refund_recorded'",
    ]) {
      expect(route, `action missing: ${action}`).toContain(action);
    }
  });

  it('rate-limit-override form lives on this page (Decision 4 — NOT on /rate-limit-overrides)', () => {
    expect(body).toMatch(
      /V-196 — inline rate-limit-override form[\s\S]*?canonical staff workflow is \/accounts → detail → set, not a\s+top-level form on \/rate-limit-overrides/,
    );
    // The form posts to .../quota-override.
    expect(body).toMatch(/\/v1\/admin\/accounts\/:id\/quota-override/);
  });

  it('bucket-select options match the canonical SetQuotaOverrideRequestSchema enum (global / sessions:create / agent_sessions:message)', () => {
    // The prior set (global / session_create / capture) was rejected by
    // the server's Zod enum, so 2 of 3 buckets 400'd; these are the
    // canonical colonated bucket keys the POST actually accepts.
    const formMatch = body.match(/data-field="override-form"[\s\S]*?<\/form>/);
    expect(formMatch).not.toBeNull();
    const tag = formMatch![0]!;
    const opts = Array.from(tag.matchAll(/<option value="([a-z_:]+)">/g)).map(
      (m) => m[1] as string,
    );
    expect(opts.sort()).toEqual(['agent_sessions:message', 'global', 'sessions:create']);
  });

  it('STATUS_BADGE covers active / suspended / deleted (same taxonomy as list page)', () => {
    for (const s of ['active', 'suspended', 'deleted']) {
      expect(body).toMatch(new RegExp(`${s}:\\s*'bg-`));
    }
  });

  it('suspend/unsuspend buttons gated by status (visibility-by-state)', () => {
    expect(body).toMatch(/account\.status === 'active'/);
    expect(body).toMatch(/account\.status === 'suspended'/);
    // The script also toggles by current state.
    expect(body).toMatch(/if \(a\.status === 'active'\) suspendBtn\.classList\.remove\('hidden'\)/);
    expect(body).toMatch(
      /if \(a\.status === 'suspended'\) unsuspendBtn\.classList\.remove\('hidden'\)/,
    );
  });

  it('"tier change applies immediately; suspend revokes all sessions + keys" framing pinned', () => {
    expect(body).toMatch(
      /Tier change applies\s+immediately; suspend revokes all sessions \+ keys until unsuspend/,
    );
  });

  it('back link to /accounts list pinned', () => {
    expect(body).toMatch(
      /<a href="\/accounts" class="text-tk-accent hover:underline">← Back to accounts<\/a>/,
    );
  });

  it('localStorage key ds_web_session_token (admin-panel convention)', () => {
    expect(body).toContain('ds_web_session_token');
  });

  it('defers the SSO token read until AdminLayout has consumed the sign-in hash', () => {
    expect(body).toMatch(/let token = null;/);
    expect(body).toMatch(
      /function start\(\) \{[\s\S]*token = localStorage\.getItem\('ds_web_session_token'\)/,
    );
    expect(body).toMatch(
      /document\.addEventListener\('DOMContentLoaded', start, \{ once: true \}\)/,
    );
  });

  it('bounds every request and makes repeated three-resource hydration latest-wins', () => {
    expect(body).toMatch(/const ACCOUNT_DETAIL_TIMEOUT_MS = 15_000;/);
    expect(body).toMatch(
      /function authedFetch\(path, init = \{\}, controller = new AbortController\(\)\)/,
    );
    expect(body).toMatch(
      /window\.setTimeout\([\s\S]*controller\.abort\(\)[\s\S]*ACCOUNT_DETAIL_TIMEOUT_MS/,
    );
    expect(body).toMatch(/signal: controller\.signal/);
    expect(body).toMatch(/\.finally\(\(\) => window\.clearTimeout\(timeout\)\)/);
    expect(body).toMatch(/if \(hydrationController\) hydrationController\.abort\(\)/);
    expect(body).toMatch(/const generation = \+\+hydrationGeneration;/);
    expect(body).toMatch(/const isCurrent = \(\) => generation === hydrationGeneration;/);
    expect(body).toMatch(/Promise\.all\(\[accountP, auditP, costP\]\)/);
    expect(body).toMatch(/if \(!isCurrent\(\)\) return;/);
    expect(body).toMatch(/root\.removeAttribute\('aria-busy'\)/);
    expect(body).toContain('Request timed out. Try again.');
  });

  it('CRITICAL suspend confirm is destructive:true — without it the OK button auto-focuses and a stray Enter fires the suspend (revokes ALL sessions + API keys) with no click required (audit waefer6wu)', () => {
    const suspendFn = body.match(/async function suspend\(\)[\s\S]*?\n      \}/);
    expect(suspendFn).not.toBeNull();
    const fn = suspendFn![0]!;
    expect(fn).toMatch(/window\.driftstackConfirm\(/);
    const confirmCall = fn.match(/window\.driftstackConfirm\([\s\S]*?\);/);
    expect(confirmCall).not.toBeNull();
    expect(confirmCall![0]).toMatch(/destructive:\s*true/);
  });

  it('mutations surface the server problem+json detail via mutationJson (W151/W152), so refusals explain why', () => {
    // tier change / suspend / unsuspend / override / note / refund all
    // route their non-ok response through mutationJson, which reads
    // b.detail — so an operator sees "Refund amount exceeds the original
    // charge" instead of a bare "HTTP 400". Pin the helper + that the six
    // mutations use it (not the old inline bare-HTTP reject).
    expect(body).toMatch(/function mutationJson\(r\)/);
    expect(body).toMatch(/b\.detail \|\| 'HTTP ' \+ r\.status/);
    const usages = body.match(/\.then\(mutationJson\)/g) ?? [];
    expect(usages.length).toBe(6);
  });

  it('quota override apply is single-flight and locks the whole form accessibly', () => {
    expect(body).toMatch(/let overrideSubmitting = false;/);
    expect(body).toMatch(/if \(!token \|\| overrideSubmitting \|\| accountMutationInFlight\)/);
    expect(body).toMatch(/overrideSubmitting = true;/);
    expect(body).toMatch(/form\.setAttribute\('aria-busy', 'true'\)/);
    expect(body).toMatch(/const controls = Array\.from\(form\.elements\)/);
    expect(body).toMatch(/if \(submit\) submit\.textContent = 'Applying…'/);
    expect(body).toMatch(/\.finally\(\(\) => \{\s*overrideSubmitting = false;/);
    expect(body).toMatch(/if \(overrideSubmitting && !force\) return;/);
  });

  it('all account mutations share one accessible request lease', () => {
    expect(body).toMatch(/let accountMutationInFlight = false;/);
    expect(body).toMatch(/if \(accountMutationInFlight\) return false;/);
    expect(body).toMatch(/actionRow\.setAttribute\('aria-busy', 'true'\)/);
    expect(body).toMatch(
      /accountActionButtons\.forEach\(\(button\) => \{\s*button\.disabled = true;/,
    );
    expect(body).toMatch(/if \(!token \|\| overrideSubmitting \|\| accountMutationInFlight\)/);
    expect(body).toMatch(/if \(!beginAccountMutation\(submit\)\) return;/);
    expect(body).toMatch(/if \(!beginAccountMutation\(btn\)\) return;/);
    expect(body).toMatch(/mutationHandler\(\)\.finally\(\(\) => endAccountMutation\(btn\)\)/);
    expect(body).toMatch(/endAccountMutation\(submit\)/);
    expect(body.match(/return authedFetch\(/g)).toHaveLength(6);
  });

  it('reconciles ambiguous suspend/unsuspend timeouts against authoritative account status', () => {
    expect(body).toMatch(/async function reconcileAccountTransition\(action\)/);
    expect(body).toMatch(/const refreshed = await load\(\)/);
    expect(body).toMatch(/status === 'suspended'/);
    expect(body).toMatch(/status === 'active'/);
    expect(body).toContain('sessions and API keys were revoked; do not suspend it again');
    expect(body).toContain('do not unsuspend it again');
    expect(body).toContain('Verify its status before retrying');
    expect(body).toMatch(/err && err\.name === 'AbortError'/);
  });

  it('reconciles ambiguous tier changes against the refreshed target tier', () => {
    expect(body).toMatch(/async function reconcileAccountTier\(targetTier\)/);
    expect(body).toMatch(/tier === targetTier/);
    expect(body).toContain('the change completed, so do not submit it again');
    expect(body).toContain('Verify its tier before retrying');
    expect(body).toMatch(/await reconcileAccountTier\(body\.tier\)/);
  });

  it('fails closed after confirmed or unverifiable audit-only writes', () => {
    expect(body).toMatch(/const blockedAuditActions = new Set\(\)/);
    expect(body).toMatch(/blockedAuditActions\.add\(action\)/);
    expect(body).toMatch(
      /button\.disabled = blockedAuditActions\.has\(button\.getAttribute\('data-action'\)\)/,
    );
    expect(body).toMatch(/if \(blockedAuditActions\.has\(action\)\)/);
    expect(body).toMatch(/if \(blockedAuditActions\.has\('add-note'\)\)/);
    expect(body).toMatch(/if \(blockedAuditActions\.has\('record-refund'\)\)/);
    expect(body).toContain(
      'refreshed authoritative audit slice has no new matching successful entry',
    );
    expect(body).toContain('retry only if the record is still required');
    expect(body).toContain('Reload and review the audit log before recording another');
  });
});
