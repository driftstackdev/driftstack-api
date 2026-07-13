// W366.B — drift guard for customer-dashboard /settings page
// content. V-217 + V-204 + V-352. The security surfaces (V-079
// change-password, V-353h MFA, V-355 web-sessions, V-216 audit
// teaser, danger zone) moved to /security with the 2026-07-03
// design-system v2 split — their pins live in
// security-page-content-parity.test.ts. Existing parity tests cover
// endpoint wiring + route registration; this guard pins:
//
//   • EMAIL_EVENTS list on the page is EXACTLY
//     OptOutableEmailEventSchema's values (a schema add
//     without a page update silently makes that event
//     unsubscribable from the GUI; a page add without a schema
//     update silently 400s).
//   • V-204 endpoint registered server-side.
//   • The live "Display & locale" profile editor (PATCH
//     /v1/account/me) with no mock-account literal.
//   • localStorage ds_web_session_token.
//   • The moved-to-/security cross-link so customers can still
//     find password/MFA/danger-zone from the settings header.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OptOutableEmailEventSchema } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/settings.astro');
const EMAIL_PREFS_ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/email-preferences.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W366.B customer-dashboard /settings page content parity', () => {
  const body = read(PAGE);

  it('EMAIL_EVENTS list on the page exactly matches OptOutableEmailEventSchema', () => {
    const block = body.match(/const EMAIL_EVENTS = \[([\s\S]*?)\] as const;/);
    expect(block).not.toBeNull();
    const types = Array.from(block![1]!.matchAll(/type: '([a-z\-]+)'/g)).map((m) => m[1] as string);
    const schemaVals = [
      ...(OptOutableEmailEventSchema._def as { values: readonly string[] }).values,
    ];
    expect(types.sort()).toEqual([...schemaVals].sort());
    // 6 total today (the trial-pack pair was removed with the dead
    // trial_pack lifecycle) — pin the count so a 7th type can't slip
    // into the schema without updating the page.
    expect(types.length).toBe(6);
  });

  it('V-204 /v1/account/email-preferences registered server-side + wired on page', () => {
    expect(existsSync(EMAIL_PREFS_ROUTE)).toBe(true);
    expect(read(EMAIL_PREFS_ROUTE)).toContain("'/v1/account/email-preferences'");
    expect(body).toContain('/v1/account/email-preferences');
  });

  it('legacy MOCK-seeded Profile section removed; the live "Display & locale" section is the canonical profile editor (PATCH /v1/account/me)', () => {
    // 2026-06-24 — the dead legacy "Profile" card (Name + Email inputs
    // seeded from MOCK_ACCOUNT, no-op "Save changes" button) was removed.
    // It's superseded by the live data-region="profile" section that PATCHes
    // /v1/account/me. No MOCK_ACCOUNT literal may ship.
    expect(body).not.toMatch(/MOCK_ACCOUNT/);
    expect(body).not.toMatch(/Profile editing endpoint lands as a follow-up slice/);
    expect(body).toMatch(/data-region="profile"/);
    expect(body).toMatch(/data-form="profile"/);
    expect(body).toMatch(/method: 'PATCH'/);
  });

  it('localStorage key ds_web_session_token (customer-dashboard convention)', () => {
    expect(body).toContain('ds_web_session_token');
  });

  it('V-217 progressive-enhancement framing pinned (SSG mocks + inline-script live wiring; V-204 is the remaining live-wire after the /security split)', () => {
    expect(body).toMatch(
      /V-217 — progressive-enhancement live wiring against:[\s\S]*?\/v1\/account\/email-preferences \(V-204\)/,
    );
  });

  it('header cross-links the moved security surfaces to /security (2026-07-03 split)', () => {
    // The change-password / MFA / sign-ins / danger-zone surfaces left
    // this page — customers hunting for them in the old place need the
    // pointer, or the move reads as a feature removal.
    // S23 2026-07-06 — accent-toned TEXT re-pinned raw tk-accent → AA-safe tk-accent-text (cross-app WCAG sweep).
    expect(body).toMatch(
      /Security, sign-ins &amp; danger zone moved to\s*\n?\s*<a href="\/security" class="text-tk-accent-text underline">Privacy &amp; security<\/a>\./,
    );
  });

  it('billing-receipt copy distinguishes Driftstack receipts from Stripe receipts', () => {
    // Load-bearing claim — opting out of Driftstack billing
    // receipts does NOT opt out of Stripe receipts. Pin so a
    // future receipt-system change can't soften the distinction.
    expect(body).toMatch(/Per-invoice receipt emails\. Stripe receipts continue regardless/);
  });

  it('generation-binds transient preference success dismissal', () => {
    expect(body).toMatch(/let bannerGeneration = 0/);
    expect(body).toMatch(/expectedGeneration !== bannerGeneration/);
    expect(body).toMatch(/const noticeGeneration = showBanner\('Email preference saved\.'\)/);
    expect(body).toMatch(/hideBanner\(noticeGeneration\)/);
  });

  it('BYOK status consumes the metadata-only API contract and reconciles an ambiguous save by set_at version', () => {
    expect(body).toMatch(/body\.has_key !== true/);
    expect(body).toMatch(/typeof body\.set_at === 'string'/);
    expect(body).toMatch(/typeof body\.last_used_at === 'string'/);
    expect(body).not.toMatch(/body\.key_set/);
    expect(body).not.toMatch(/body\.key_prefix/);
    expect(body).not.toMatch(/data-byok-prefix/);
    expect(body).toMatch(/const previousSetAt = byokMetadata\.setAt/);
    expect(body).toMatch(/nextMs > priorMs/);
    expect(body).toMatch(/The save likely completed before the response timed out/);
  });
});
