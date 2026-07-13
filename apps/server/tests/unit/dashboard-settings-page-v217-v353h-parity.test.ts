// W759 — customer-dashboard /settings.astro V-217 (live-wire) +
// V-204 (email prefs) + V-352 (profile + avatar + timezone) parity.
// Eighty-fifth in the cross-SDK drift-guard series.
//
// /settings is the account-profile + notifications surface. The
// security surfaces it used to carry (V-079 change-pw, V-353h MFA,
// V-355 sessions/devices, V-216 audit teaser, danger zone) moved to
// /security.astro with the 2026-07-03 design-system v2 split — their
// pins live in dashboard-security-page-parity.test.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const PAGE = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/settings.astro');

describe('W759 dashboard /settings page V-217 + V-204 + V-352 parity', () => {
  it('settings.astro file exists', () => {
    expect(existsSync(PAGE)).toBe(true);
  });

  it('CRITICAL V-217 anchor + V-204-route framing pinned. The "progressive-enhancement live wiring against /v1/account/email-preferences (V-204) — list + PUT per-event toggles" wording threads the remaining live-wire anchor (the V-216 + V-079 wires moved to security.astro 2026-07-03).', () => {
    const p = read(PAGE);

    expect(p).toMatch(/V-217 — progressive-enhancement live wiring against:/);
    expect(p).toMatch(/\/v1\/account\/email-preferences \(V-204\) — list \+ PUT per-event toggles/);
  });

  it('CRITICAL V-204 email-preferences GET + PUT lifecycle pinned. Drift to dropping PUT would lock customers out of opting out of marketing emails (GDPR-relevant).', () => {
    const p = read(PAGE);

    expect(p).toMatch(/authedFetch\('\/v1\/account\/email-preferences', \{ method: 'GET' \}\)/);
    expect(p).toMatch(/authedFetch\('\/v1\/account\/email-preferences', \{\s*\n\s+method: 'PUT'/);
    expect(p).toMatch(/liveOptedIn === optedIn/);
    expect(p).toMatch(/input\.indeterminate = true/);
    expect(p).toMatch(/input\.dataset\.outcomeUnknown = 'true'/);
  });

  it('CRITICAL V-204 OptOutableEmailEventSchema reference pinned. The "V-204 opt-outable email events. Mirrors OptOutableEmailEventSchema." comment is what threads the dashboard-server schema contract.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/V-204 opt-outable email events\. Mirrors OptOutableEmailEventSchema\./);
  });

  it("CRITICAL V-352c + V-298a profile form pinned (name + timezone + slug). The 'V-352c / V-298a — wire the profile (name + timezone + slug) form' comment threads BOTH the V-352c profile field set + V-298a slug addition.", () => {
    const p = read(PAGE);

    expect(p).toMatch(/V-352c \/ V-298a — wire the profile \(name \+ timezone \+ slug\) form\./);
  });

  it('CRITICAL V-298a slug-conditional-inclusion framing pinned. The "V-298a — only include slug when the input exists; the backend" wording protects against the slug-field being absent on accounts that haven\'t set one.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/\/\/ V-298a — only include slug when the input exists; the backend/);
  });

  it("CRITICAL V-298b region empty-string-as-null framing pinned. The 'V-298b — region from select; \\'\\' = no preference (null).' wording explains the dashboard-side null encoding.", () => {
    const p = read(PAGE);

    expect(p).toMatch(/\/\/ V-298b — region from select; '' = no preference \(null\)\./);
  });

  it('profile hydration preserves in-flight typing and timeout recovery requires exact live fields', () => {
    const p = read(PAGE);

    expect(p).toMatch(/if \(!profileHydrated\) profileEditedBeforeHydration = true/);
    expect(p).toMatch(/if \(!profileEditedBeforeHydration\) \{/);
    expect(p).toMatch(/accountMatchesProfile\(account, body\)/);
    expect(p).toMatch(/live profile matches your changes/);
    expect(p).toMatch(/Your edits are still here/);
  });

  it('CRITICAL V-352b avatar upload + remove flow pinned. POST/DELETE /v1/account/me/avatar. Drift to a different endpoint would break the V-352b avatar lifecycle.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/\/\/ V-352b — avatar upload handler\./);
    expect(p).toMatch(/\/\/ V-352b — avatar remove handler\./);
    expect(p).toMatch(/boundedFetch\(apiBaseUrl \+ '\/v1\/account\/me\/avatar', \{/);
    expect(p).toMatch(/avatarRemoveBtn\.hidden = source !== 'user'/);
    expect(p).toMatch(/\['user', 'idp', 'none'\]\.includes\(me\.avatar_source\)/);
    expect(p).toMatch(/snapshotKnownBeforeUpload &&/);
    expect(p).toMatch(/The response was lost, but removal completed/);
  });

  it("CRITICAL V-331b act-as header passthrough pinned in settings authedFetch. Drift would let team-RBAC customers update the wrong owner's settings.", () => {
    const p = read(PAGE);

    expect(p).toMatch(/\/\/ V-331b — act-as header for team-scoped requests\./);
    expect(p).toMatch(
      /\.\.\.\(typeof window\.driftstackActAsHeaders === 'function'\s*\n\s+\? window\.driftstackActAsHeaders\(\)\s*\n\s+: \{\}\),/,
    );
  });

  it("CRITICAL 'Account profile, email notifications, and your Anthropic API key' header framing pinned (2026-07-03 — the sub-copy no longer claims security/danger-zone live here; those moved to /security). The 'Changes here affect' subtitle keeps the load-bearing customer-impact framing, and the header cross-links the moved surfaces.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /Account profile, email notifications, and your Anthropic API key\.\s*\n?\s*Changes here affect/,
    );
    // S23 2026-07-06 — accent-toned TEXT re-pinned raw tk-accent → AA-safe tk-accent-text (cross-app WCAG sweep).
    expect(p).toMatch(
      /Security, sign-ins &amp; danger zone moved to\s*\n?\s*<a href="\/security" class="text-tk-accent-text underline">Privacy &amp; security<\/a>\./,
    );
  });

  it("CRITICAL no-token banner — 'Sign in to see live preferences + recent activity.' Drift to a 401 redirect would lose the partial-preview affordance.", () => {
    const p = read(PAGE);
    expect(p).toMatch(/showBanner\('Sign in to see live preferences \+ recent activity\.'\);/);
  });

  it('CRITICAL POST /v1/account/me profile-update endpoint pinned. Drift to a different endpoint would break the V-352c profile form.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/boundedFetch\(apiBaseUrl \+ '\/v1\/account\/me', \{/);
  });

  it('CRITICAL resolveApiBaseUrl + DashboardLayout used.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/<DashboardLayout title="Settings">/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/dashboard-settings-page-v217-v353h-parity.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
