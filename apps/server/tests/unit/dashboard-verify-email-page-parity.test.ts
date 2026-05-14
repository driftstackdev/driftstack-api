// W735 — customer-dashboard verify-email.astro page parity.
//
// Sixty-first in the cross-SDK drift-guard series. Pins the
// dashboard's verify-email.astro page as the V-184a.B canonical
// implementation of the email→dashboard verify handoff. Drift here
// would re-introduce the 2026-05-12 customer-incident class of bug
// (verify link that lands on the wrong handler shape).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const PAGE = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/verify-email.astro');

describe('W735 customer-dashboard verify-email.astro page parity', () => {
  it('verify-email.astro file exists at the canonical path matching V-079.C', () => {
    expect(existsSync(PAGE)).toBe(true);
  });

  it('CRITICAL V-184a anchor + onboarding-step-2 framing pinned. The anchor threads the verify-email page provenance into V-184a (4-step onboarding).', () => {
    const p = read(PAGE);
    expect(p).toMatch(/V-184a — onboarding step 2\. Consume verification token, store/);
    expect(p).toMatch(/resulting web-session token in localStorage, redirect to \/welcome/);
  });

  it('CRITICAL "Step 2 of 4" section-label pinned. Drift to a different step-count would mismatch the V-184a 4-step onboarding (signup → verify-email → profile → first-key).', () => {
    const p = read(PAGE);
    expect(p).toMatch(/<p class="section-label">Step 2 of 4<\/p>/);
  });

  it("CRITICAL V-184a.B URL-token auto-prefill pinned — `new URLSearchParams(window.location.search).get('token')` reads the link token. The form is pre-filled + auto-submitted; form stays mounted as fallback for mail-client mangling.", () => {
    const p = read(PAGE);

    expect(p).toMatch(/V-184a\.B — when the user clicks the link in the verify/);
    expect(p).toMatch(/email, the token is already in `\?token=…`/);
    expect(p).toMatch(
      /Pre-fill the\s*\n\s+\/\/ form \+ auto-submit so they don't have to paste it/,
    );

    // Implementation matches the framing.
    expect(p).toMatch(/const params = new URLSearchParams\(window\.location\.search\)/);
    expect(p).toMatch(/const linkToken = params\.get\('token'\)/);
  });

  it('CRITICAL form stays mounted even when auto-submitting ("The\\n form stays visible as a fallback"). Drift to hiding the form would lock out customers whose mail-client mangled the link or whose page hit without query param.', () => {
    const p = read(PAGE);
    expect(p).toMatch(/The\s*\n\s+\/\/ form stays visible as a fallback for the rare case where/);
    expect(p).toMatch(
      /a recipient mail client mangles the link or the page is\s*\n\s+\/\/ hit without the query param/,
    );
  });

  it('CRITICAL ds_debug_verify_token sessionStorage back-compat pinned — URL token wins when both present. The dev-mode debug-token path is kept for back-compat; URL token has priority.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/Pre-fill debug_token from signup response in test\/dev mode/);
    expect(p).toMatch(/kept for back-compat — the URL token wins when both/);
    expect(p).toMatch(/const debugToken = sessionStorage\.getItem\('ds_debug_verify_token'\)/);
    expect(p).toMatch(/const prefill = linkToken \?\? debugToken/);
  });

  it('CRITICAL POST /v1/auth/verify-email submit-handler shape pinned. The fetch contract is: POST + content-type:application/json + body {token} + credentials: include. Drift to GET or missing credentials would break the cookie/session round-trip.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /fetch\(apiBaseUrl \+ '\/v1\/auth\/verify-email', \{\s*\n\s+method: 'POST',\s*\n\s+headers: \{ 'content-type': 'application\/json' \},\s*\n\s+body: JSON\.stringify\(\{ token \}\),\s*\n\s+credentials: 'include',\s*\n\s+\}\)/,
    );
  });

  it('CRITICAL on-success: stash session.token in localStorage as `ds_web_session_token` + cleanup ds_signup_email + ds_debug_verify_token sessionStorage keys. Drift to dropping the cleanup would let stale signup-stage state persist across logins.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/localStorage\.setItem\('ds_web_session_token', session\.token\)/);
    expect(p).toMatch(/sessionStorage\.removeItem\('ds_signup_email'\)/);
    expect(p).toMatch(/sessionStorage\.removeItem\('ds_debug_verify_token'\)/);
  });

  it('CRITICAL V-267 ?next= deep-link round-trip pinned. The `next` query-param honors deep-link entry from /cli/authorize + any other surface. Falls back to /welcome for the first-time onboarding flow.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/V-267 — honor \?next= round-trip from \/cli\/authorize and/);
    expect(p).toMatch(/any other deep-link entry\. Falls back to \/welcome for the/);
    expect(p).toMatch(/first-time onboarding flow/);

    // Implementation.
    expect(p).toMatch(/const next = params\.get\('next'\)/);
    expect(p).toMatch(/window\.location\.href = next \? next : '\/welcome'/);
  });

  it('CRITICAL #187 resend-verification self-service pinned. POST /v1/auth/resend-verification with email body. Drift to dropping would force customers to restart signup.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/#187 — self-service resend of the signup-verification email/);
    expect(p).toMatch(
      /POST', '\/v1\/auth\/resend-verification|apiBaseUrl \+ '\/v1\/auth\/resend-verification'/,
    );
    expect(p).toMatch(/JSON\.stringify\(\{ email: resendEmail \}\)/);
  });

  it("CRITICAL resend-button 60s cooldown pinned — `Re-enable after 60s so accidental double-clicks don't burn through the per-IP 3/min cap on the server side`. Matches W714 V-251 IP rate-limit (3/min for resend-verification).", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /Re-enable after 60s so accidental double-clicks don't\s*\n\s+\/\/ burn through the per-IP 3\/min cap on the server side/,
    );
    expect(p).toMatch(
      /window\.setTimeout\(\(\) => \{\s*\n\s+resendBtn\.disabled = false;\s*\n\s+\}, 60_000\)/,
    );
  });

  it('CRITICAL resend-email fallback prompt — if ds_signup_email is absent, prompt the user. "Server is shape-stable, so the success message is identical regardless of whether the email matched." Drift to revealing whether email matched would let attackers enumerate accounts.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/let resendEmail = sessionStorage\.getItem\('ds_signup_email'\)/);
    expect(p).toMatch(/resendEmail = window\.prompt\('Email address used at signup:'\)/);
    expect(p).toMatch(
      /Server is shape-stable, so the success message\s*\n\s+\/\/ is identical regardless of whether the email matched/,
    );
  });

  it('CRITICAL data-page="verify-email" + data-form="verify" + data-banner + data-action="resend" data-attributes pinned. Inline script reads these selectors; drift would silently break the page.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/data-page="verify-email"/);
    expect(p).toMatch(/data-form="verify"/);
    expect(p).toMatch(/data-banner/);
    expect(p).toMatch(/data-action="resend"/);
    expect(p).toMatch(/data-field="email"/);
    expect(p).toMatch(/data-field="intro"/);
    expect(p).toMatch(/data-field="resend-status"/);
  });

  it('CRITICAL token input has autocomplete="one-time-code" + autocompletes paste from password managers. Drift to dropping would let some password managers stuff stored passwords into the verify field.', () => {
    const p = read(PAGE);
    expect(p).toMatch(/autocomplete="one-time-code"/);
    expect(p).toMatch(/id="verify-token"/);
    expect(p).toMatch(/name="token"/);
    expect(p).toMatch(/required/);
  });

  it('CRITICAL resolveApiBaseUrl() helper used (NOT hardcoded). The resolveApiBaseUrl path lets the dashboard be deployed in multiple envs (local/staging/prod). Drift to hardcoding api.driftstack.dev would break local + staging flows.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/import \{ resolveApiBaseUrl \} from '\.\.\/lib\/api-base-url'/);
    expect(p).toMatch(/const apiBaseUrl = resolveApiBaseUrl\(\)/);
    expect(p).toMatch(/define:vars=\{\{ apiBaseUrl \}\}/);
  });

  it('CRITICAL cross-app parity test exists at apps/customer-dashboard/tests/unit/auth-url-paths-parity.test.ts (the cross-surface guard referenced from server config.ts).', () => {
    const cross = resolve(
      REPO_ROOT,
      'apps/customer-dashboard/tests/unit/auth-url-paths-parity.test.ts',
    );
    expect(existsSync(cross), `cross-app parity test missing: ${cross}`).toBe(true);

    // The cross-app test asserts the dashboard pages exist for each
    // resolved server URL — verify it loads loadConfig() and reads
    // verify-email.astro existence.
    const c = read(cross);
    expect(c).toMatch(/V-079\.C/);
    expect(c).toMatch(/loadConfig/);
    expect(c).toMatch(/2026-05-12/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/dashboard-verify-email-page-parity.test.ts'),
      ),
    ).toBe(true);
  });
});
