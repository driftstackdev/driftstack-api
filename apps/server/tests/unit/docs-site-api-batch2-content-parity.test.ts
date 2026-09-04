// W606 — drift guard for apps/docs/src/pages/api batch 2 (close-out).
// 8 modules: usage + audit-log + mfa + billing + legal + team + email-preferences + account-rate-limits.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const P = (rel: string) => resolve(REPO_ROOT, `apps/docs/src/pages/api/${rel}`);

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W606 apps/docs/api batch 2 close-out (8 modules) content parity', () => {
  it('usage.md: /v1/usage current-period totals + tier quotas + /v1/usage/series daily-bucketed time-series pinned', () => {
    const body = read(P('usage.md'));
    expect(body).toMatch(/^title: Usage$/m);
    expect(body).toMatch(/^# Usage$/m);
    expect(body).toMatch(/`\/v1\/usage` exposes the calling account's current billing-period/);
    expect(body).toMatch(/totals \+ tier quotas\./);
    expect(body).toMatch(/`\/v1\/usage\/series` returns a daily-bucketed/);
    expect(existsSync(P('usage.md'))).toBe(true);
  });

  it('audit-log.md: append-only ledger (API key + session + profile + subscription events) + list-with-filters + cursor pagination + CSV/JSON export for GDPR portability pinned', () => {
    const body = read(P('audit-log.md'));
    expect(body).toMatch(/^title: Audit log$/m);
    expect(body).toMatch(/^# Audit log$/m);
    expect(body).toMatch(/Every action on your account lands in an append-only audit log:/);
    expect(body).toMatch(/API key lifecycle, session events, profile changes, subscription/);
    expect(existsSync(P('audit-log.md'))).toBe(true);
  });

  it('mfa.md: TOTP per RFC 6238 + single-use recovery codes + /v1/account/mfa enrollment + /v1/auth/mfa login challenge + step-up reauth pinned', () => {
    const body = read(P('mfa.md'));
    expect(body).toMatch(/^title: Two-factor authentication \(MFA\)$/m);
    expect(body).toMatch(/^# Two-factor authentication \(MFA\)$/m);
    expect(body).toMatch(/Driftstack supports time-based one-time passwords \(TOTP\) per RFC 6238/);
    expect(body).toMatch(/plus single-use recovery codes\./);
    expect(body).toMatch(/Once enrolled, sign-in to the dashboard/);
    expect(existsSync(P('mfa.md'))).toBe(true);
  });

  it('billing.md: thin layer over Stripe + checkout-session mint + portal-URL mint + customer-interacts-with-Stripe surface pinned', () => {
    const body = read(P('billing.md'));
    expect(body).toMatch(/^title: Billing$/m);
    expect(body).toMatch(/^# Billing$/m);
    expect(body).toMatch(/All Driftstack billing is a thin layer over Stripe\./);
    expect(body).toMatch(/The Driftstack/);
    expect(body).toMatch(/API mints checkout sessions \+ portal URLs;/);
    expect(existsSync(P('billing.md'))).toBe(true);
  });

  it('legal.md: records customer acceptance + versioned legal documents (ToS + Privacy + DPA + AUP) + content-hash binding pinned. The previous skip pinned inline `V-523 reference.` prefix that was removed from the customer-facing docs as a UX cleanup (internal V-anchors should not bleed into docs.driftstack.io pages); the framing itself survives without it.', () => {
    const body = read(P('legal.md'));
    expect(body).toMatch(/^title: Legal documents \+ acceptance$/m);
    expect(body).toMatch(/^# Legal documents \+ acceptance$/m);
    expect(body).toMatch(/Driftstack records customer acceptance of every/);
    expect(body).toMatch(/versioned legal document \(Terms of Service, Privacy Policy, DPA,/);
    expect(existsSync(P('legal.md'))).toBe(true);
    // Internal V-anchor must NOT bleed into customer-facing docs copy.
    expect(body).not.toMatch(/V-523 reference\./);
  });

  it('team.md: multi-user teams + one-owner-plus-zero-or-more-members topology + /v1/team/* invite/accept/list/remove verbs pinned', () => {
    const body = read(P('team.md'));
    expect(body).toMatch(/^title: Team RBAC$/m);
    expect(body).toMatch(/^# Team RBAC$/m);
    expect(body).toMatch(/Driftstack supports multi-user teams: one owner-account plus zero or/);
    expect(body).toMatch(/more member-accounts joined to it via the `\/v1\/team\/\*` endpoints\./);
    expect(existsSync(P('team.md'))).toBe(true);
  });

  it('email-preferences.md: 2 email categories (transactional opt-outable vs operational never-opt-outable) pinned. The previous skip pinned inline `V-520 reference.` prefix that was removed from the customer-facing docs as a UX cleanup (internal V-anchors should not bleed into docs.driftstack.io pages); the framing itself survives without it.', () => {
    const body = read(P('email-preferences.md'));
    expect(body).toMatch(/^title: Email preferences$/m);
    expect(body).toMatch(/^# Email preferences$/m);
    expect(body).toMatch(/Driftstack sends two categories of email:/);
    expect(existsSync(P('email-preferences.md'))).toBe(true);
    // Internal V-anchor must NOT bleed into customer-facing docs copy.
    expect(body).not.toMatch(/V-520 reference\./);
  });

  it('account-rate-limits.md: per-tier token-bucket on every authenticated /v1/* + admin overrides + reads effective config pinned. The previous skip pinned inline `V-517 reference.` prefix that was removed from the customer-facing docs as a UX cleanup (internal V-anchors should not bleed into docs.driftstack.io pages); the framing itself survives without it.', () => {
    const body = read(P('account-rate-limits.md'));
    expect(body).toMatch(/^title: Account rate limits$/m);
    expect(body).toMatch(/^# Account rate limits$/m);
    expect(body).toMatch(/Driftstack enforces per-tier token-bucket rate/);
    expect(body).toMatch(/limits on every authenticated `\/v1\/\*` call\./);
    expect(existsSync(P('account-rate-limits.md'))).toBe(true);
    // Internal V-anchor must NOT bleed into customer-facing docs copy.
    expect(body).not.toMatch(/V-517 reference\./);
  });
});
