// W736 — customer-dashboard reset-password.astro + magic-link.astro
// V-079.C sister-page parity. Sixty-second in the cross-SDK drift-
// guard series. Companion to W735 (verify-email.astro).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const RESET = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/reset-password.astro');
const MAGIC = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/auth/magic-link.astro');

describe('W736 reset-password + magic-link dashboard pages parity', () => {
  it('both dashboard pages exist at V-079.C canonical paths', () => {
    expect(existsSync(RESET), `missing ${RESET}`).toBe(true);
    expect(existsSync(MAGIC), `missing ${MAGIC}`).toBe(true);
  });

  // --- reset-password.astro ---------------------------------------

  it('CRITICAL reset-password V-273 anchor + V-079 backend pairing and one-shot recovery are pinned', () => {
    const r = read(RESET);

    expect(r).toMatch(/V-273 — Password-reset confirmation page\. Pairs with the V-079/);
    expect(r).toMatch(/backend route `POST \/v1\/auth\/password-reset\/confirm`/);
    expect(r).toMatch(
      /Token is one-shot — second use returns 400; a successful MFA challenge is too/,
    );
  });

  it('CRITICAL reset-password 12-char minimum + autocomplete=new-password pinned. The 12-char minimum matches server-side password validation; new-password autocomplete tells password managers to suggest a fresh strong password.', () => {
    const r = read(RESET);

    // Both password fields enforce minlength=12 + autocomplete=new-password.
    const minlengthCount = (r.match(/minlength="12"/g) ?? []).length;
    expect(minlengthCount, 'minlength="12" on both fields').toBe(2);

    const autoCount = (r.match(/autocomplete="new-password"/g) ?? []).length;
    expect(autoCount, 'autocomplete="new-password" on both fields').toBe(2);

    expect(r).toMatch(/12\+ characters\. Use a passphrase\./);
  });

  it('CRITICAL reset-password client-side password-match guard + length re-check before POST. Drift to client-only check would let JS-disabled browsers bypass; the server-side check catches that, but the UX-level guard prevents the round-trip on the obvious typo.', () => {
    const r = read(RESET);

    expect(r).toMatch(/if \(password !== confirm\)/);
    expect(r).toMatch(/showBanner\('Passwords do not match\.'\)/);
    expect(r).toMatch(/if \(password\.length < 12\)/);
    expect(r).toMatch(/showBanner\('Password must be at least 12 characters\.'\)/);
  });

  it('CRITICAL reset-password POST /v1/auth/password-reset/confirm contract pinned — body {token, new_password}. The 2-field body shape matches the V-079 confirm route; drift would break the round-trip.', () => {
    const r = read(RESET);

    expect(r).toMatch(/fetch\(apiBaseUrl \+ '\/v1\/auth\/password-reset\/confirm'/);
    expect(r).toMatch(/JSON\.stringify\(\{ token: token, new_password: password \}\)/);
  });

  it('CRITICAL reset-password missing-token UX path pinned. When `?token=` is absent, show a clear "No reset token in URL" message + link to /forgot-password (NOT a generic error). Drift to a generic error would leave customers stuck.', () => {
    const r = read(RESET);

    expect(r).toMatch(/data-missing/);
    expect(r).toMatch(/No reset token in URL\./);
    expect(r).toMatch(
      /Open the page from the link in your reset email, or\s*\n\s+<a\s*\n\s+href="\/forgot-password"/,
    );

    // Implementation: hide form + show missing-block when no token.
    expect(r).toMatch(
      /if \(!token\) \{\s*\n\s+form\.classList\.add\('hidden'\);\s*\n\s+missing\.classList\.remove\('hidden'\);/,
    );
  });

  it('CRITICAL reset-password persists a session only after direct or MFA completion', () => {
    const r = read(RESET);

    expect(r).toMatch(/localStorage\.setItem\('ds_web_session_token', session\.token\)/);
    expect(r).toMatch(/window\.location\.href = '\/'/);
    expect(r).toContain('if (body.mfa_required === true)');
    expect(r).toContain("'/v1/auth/mfa/challenge'");
  });

  // --- auth/magic-link.astro --------------------------------------

  it('CRITICAL magic-link #190 anchor + V-079 backend pairing and one-shot recovery are pinned', () => {
    const m = read(MAGIC);

    expect(m).toMatch(/#190 — magic-link consume page\. Pairs with the V-079/);
    expect(m).toMatch(/backend route\s*\n?\s*\/\/\s*`POST \/v1\/auth\/magic-link\/consume`/);
    expect(m).toMatch(
      /Token is one-shot — second use returns 400; a successful MFA challenge is too/,
    );
  });

  it('CRITICAL magic-link auto-submit pattern pinned — `if (linkToken && linkToken.length > 0) submitToken(linkToken)`. Drift to requiring manual paste would mis-document the canonical happy-path (click email link → signed in).', () => {
    const m = read(MAGIC);

    expect(m).toMatch(/const linkToken = params\.get\('token'\)/);
    expect(m).toMatch(
      /if \(linkToken && linkToken\.length > 0\) \{\s*\n\s+submitToken\(linkToken\);\s*\n\s+\} else \{\s*\n\s+showFallbackForm\(null\);/,
    );
  });

  it('CRITICAL magic-link fallback-form for mangled-link case. The hidden-by-default form re-appears when the URL has no token OR the auto-submit fails. Drift to dropping would lock out customers whose mail client mangled the link.', () => {
    const m = read(MAGIC);

    expect(m).toMatch(
      /The form is rendered as a fallback for the rare case where a mail\s*\n\/\/ client mangles the link \(drops the query string\), so the user can\s*\n\/\/ paste the token manually/,
    );

    // Form starts hidden + data-state="fallback".
    expect(m).toMatch(/data-form="magic-link" class="hidden space-y-5" data-state="fallback"/);

    // showFallbackForm helper exists.
    expect(m).toMatch(/function showFallbackForm\(prefill\) \{/);
  });

  it("CRITICAL magic-link POST /v1/auth/magic-link/consume contract pinned — body {token} + credentials:'include'. The credentials:'include' is what threads the cookie-session round-trip; drift would break web-session bootstrap.", () => {
    const m = read(MAGIC);

    expect(m).toMatch(
      /fetch\(apiBaseUrl \+ '\/v1\/auth\/magic-link\/consume', \{[\s\S]+?body: JSON\.stringify\(\{ token: token \}\),[\s\S]+?credentials: 'include',[\s\S]+?signal: controller\.signal,/,
    );
  });

  it('CRITICAL magic-link ?next= deep-link round-trip pinned. Matches V-267 verify-email pattern from W735.', () => {
    const m = read(MAGIC);

    expect(m).toMatch(/const params = new URLSearchParams\(window\.location\.search\)/);
    // audit w2flmiw48 #5-7 — magic-link now matches the verify-email safeNextPath guard
    // (was a raw `next ? next : '/'` open redirect).
    expect(m).toMatch(/const safeNextPath = \(next, origin\) =>/);
    expect(m).toMatch(
      /window\.location\.href = safeNextPath\(params\.get\('next'\), window\.location\.origin\)/,
    );

    // V-079 framing notes the next=round-trip in docstring.
    expect(m).toMatch(/to localStorage and redirects to \/ \(or the safe \?next= path\)/);
  });

  it('CRITICAL magic-link on-failure UX — show fallback form THEN banner with error. Drift to hiding form on error would leave the customer with no recovery path.', () => {
    const m = read(MAGIC);

    expect(m).toMatch(/\.catch\(\(err\) => \{[\s\S]+?showFallbackForm\(token\);\s*\n\s+showBanner/);
  });

  it('CRITICAL magic-link token input has autocomplete="one-time-code". Matches W735 verify-email pattern.', () => {
    const m = read(MAGIC);
    expect(m).toMatch(/autocomplete="one-time-code"/);
    expect(m).toMatch(/id="magic-link-token"/);
    expect(m).toMatch(/name="token"/);
  });

  // --- Shared invariants -------------------------------------------

  it('CRITICAL both pages use resolveApiBaseUrl() helper (NOT hardcoded). Drift to hardcoding api.driftstack.dev would break local + staging.', () => {
    for (const path of [RESET, MAGIC]) {
      const c = read(path);
      expect(c, `${path} resolveApiBaseUrl import`).toMatch(
        /import \{ resolveApiBaseUrl \} from '\.\.\/(?:\.\.\/)?lib\/api-base-url'/,
      );
      expect(c, `${path} apiBaseUrl define:vars`).toMatch(/define:vars=\{\{ apiBaseUrl \}\}/);
    }
  });

  it('CRITICAL both pages store the completed session under the shared dashboard key', () => {
    for (const path of [RESET, MAGIC]) {
      const c = read(path);
      expect(c, `${path} session.token localStorage`).toMatch(
        /localStorage\.setItem\('ds_web_session_token', session\.token\)/,
      );
    }
  });

  it('CRITICAL both pages handle r.json() error-fallback gracefully — `.catch(() => ({}))` on the .json() chain. Drift to dropping would let non-JSON server errors crash the .then().', () => {
    for (const path of [RESET, MAGIC]) {
      const c = read(path);
      expect(c, `${path} .json().catch fallback`).toMatch(/\.catch\(\(\) => \(\{\}\)\)/);
    }
  });

  it('CRITICAL both pages use DashboardLayout + withSidebar={false} (auth pages have NO sidebar). Drift to enabling sidebar would show navigation links to pages the unauthenticated user cannot access.', () => {
    for (const path of [RESET, MAGIC]) {
      const c = read(path);
      expect(c, `${path} DashboardLayout import`).toMatch(/import DashboardLayout from/);
      expect(c, `${path} withSidebar={false}`).toMatch(/withSidebar=\{false\}/);
    }
  });

  it('CRITICAL both pages have data-banner role="status" for accessible error messaging. Drift to dropping role="status" would let screen readers miss the banner update.', () => {
    for (const path of [RESET, MAGIC]) {
      const c = read(path);
      expect(c, `${path} data-banner role="status"`).toMatch(
        /data-banner class="banner-warn mb-5 hidden" role="status"/,
      );
    }
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/dashboard-reset-password-magic-link-parity.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
