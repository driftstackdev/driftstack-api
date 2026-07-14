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
const BYOK_ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/account-byok-anthropic.ts');

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

  it('fails closed before auth/current-profile authority and releases signed-out hydration', () => {
    for (const selector of [
      'data-field="profile-name"',
      'data-field="profile-timezone"',
      'data-field="profile-slug"',
      'data-field="profile-region"',
      'data-button="profile-save"',
      'id="byok-key"',
    ]) {
      const start = body.indexOf(selector);
      expect(start).toBeGreaterThanOrEqual(0);
      expect(body.slice(start, body.indexOf('>', start))).toMatch(/disabled/);
    }
    expect(body).toMatch(/try \{\s*return localStorage\.getItem\('ds_web_session_token'\)/);
    expect(body).toMatch(/if \(!profileHydrated\) \{[\s\S]*?before saving/);
    expect(body).toMatch(
      /profileHydrated = true;\s*profileUnavailableReason = '';\s*syncProfileControls\(\)/,
    );
    expect(body).toMatch(
      /showBanner\('Sign in to see live preferences \+ recent activity\.'\);\s*if \(typeof window\.dashboardHydrated === 'function'\) \{\s*window\.dashboardHydrated\(\);\s*\}\s*return;/,
    );
  });

  it('avatar controls distinguish removable uploads from linked-account fallbacks', () => {
    expect(body).toMatch(/avatar_source/);
    expect(body).toMatch(/avatarRemoveBtn\.hidden = source !== 'user'/);
    expect(body).toMatch(/From your linked sign-in\. Upload an image to replace it\./);
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
      /Security, sign-ins &amp; danger zone moved to\s*\n?\s*<a href="\/security\/" class="text-tk-accent-text underline">Privacy &amp; security<\/a>\./,
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

  it('reconciles ambiguous email preference saves without inventing a boolean state', () => {
    expect(body).toMatch(/fetchEmailPrefs\(\)/);
    expect(body).toMatch(/liveOptedIn === optedIn/);
    expect(body).toMatch(/input\.indeterminate = true/);
    expect(body).toMatch(/outcome is unknown\. Reload to verify it/);
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

  it('does not parse unused accepted profile or BYOK save bodies', () => {
    expect(body).toContain('The profile response body is unused. Accepted status is the');
    expect(body).toContain('The PUT response body is unused. Trust accepted status before');

    const profileStart = body.indexOf('if (profileForm) {');
    const profileEnd = body.indexOf('function authedFetch', profileStart);
    const profileHandler = body.slice(profileStart, profileEnd);
    expect(profileHandler).not.toContain('? r.json()');

    const byokStart = body.indexOf('if (byokForm) {');
    const byokEnd = body.indexOf('if (byokTestBtn)', byokStart);
    const byokHandler = body.slice(byokStart, byokEnd);
    expect(byokHandler).not.toContain('return r.json();');
  });

  it('BYOK Test is stored-key-only and serialized with Save/Clear', () => {
    expect(body).toMatch(/After saving, Test stored key/);
    expect(body).toMatch(/let byokActionInFlight = null/);
    expect(body).toMatch(/loadGeneration !== byokLoadGeneration/);
    expect(body).toMatch(/if \(!beginByokAction\('test'\)\) return/);
    const testRequest = body.match(
      /boundedFetch\(apiBaseUrl \+ '\/v1\/account\/me\/byok-anthropic-key\/test',[\s\S]*?\n\s*\}\)/,
    );
    expect(testRequest).not.toBeNull();
    expect(testRequest![0]).not.toMatch(/body:/);
    expect(testRequest![0]).not.toMatch(/content-type/);

    const route = read(BYOK_ROUTE);
    const testStart = route.indexOf("app.post(\n    '/v1/account/me/byok-anthropic-key/test'");
    const testEnd = route.indexOf('\n  );', testStart);
    expect(testStart).toBeGreaterThanOrEqual(0);
    expect(testEnd).toBeGreaterThan(testStart);
    const testHandler = route.slice(testStart, testEnd);
    expect(testHandler).toMatch(/const plaintext = await service\.getPlaintext/);
    expect(testHandler).not.toMatch(/request\.body/);
  });

  it('reconciles an ambiguous BYOK clear against authoritative metadata', () => {
    expect(body).toMatch(/if \(refreshed\?\.hasKey === false\)/);
    expect(body).toMatch(/clear likely completed before the response timed out/);
    expect(body).toMatch(/key is still on file/);
    expect(body).toMatch(/clear outcome is unknown after the timeout/);
    expect(body).toMatch(/Reload to verify before retrying/);
  });
});
