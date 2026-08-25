// Drift guard for apps/customer-dashboard/src/pages/auth/magic-link-
// request.astro. Pins #190 magic-link REQUEST page — anti-enumeration
// "stable shape regardless of whether email matches" + AUTH_EXPOSE_
// DEBUG_TOKEN dev-mode debug-token surface + 15-minute expiry default
// + ?email= deep-link prefill. Drift to leaking which emails match
// would defeat the same-as-forgot-password anti-enumeration posture.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/auth/magic-link-request.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('customer-dashboard/pages/auth/magic-link-request content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });

  it("#190 module-level framing pinned: 'Magic-link REQUEST page (the inbound side of the magic-link flow). Pairs with the V-079 backend route POST /v1/auth/magic-link/request.' — pinned so the #190 anchor + V-079 cross-reference + inbound-side framing all stay documented", () => {
    expect(body).toMatch(
      /\/\/ #190 — Magic-link REQUEST page \(the inbound side of the magic-link\s*\/\/ flow\)\. Pairs with the V-079 backend route\s*\/\/ `POST \/v1\/auth\/magic-link\/request`\./,
    );
  });

  it("Anti-enumeration stable-shape framing pinned: 'Submits email; server returns {sent: true, expires_at[, debug_token]}. The shape is stable regardless of whether the email matches an account (anti-enumeration — same posture as forgot-password).' + 'Mirrors forgot-password.astro's shape so the visual + behavior are consistent across the two no-leak self-service flows.' — pinned so the stable-shape + forgot-password-symmetry + no-leak contract all stay documented", () => {
    expect(body).toMatch(
      /\/\/\s+2\. Submits email; server returns `\{sent: true, expires_at\[, debug_token\]\}`\.\s*\/\/\s+The shape is stable regardless of whether the email matches an\s*\/\/\s+account \(anti-enumeration — same posture as forgot-password\)\./,
    );
    expect(body).toMatch(
      /\/\/ Mirrors forgot-password\.astro's shape so the visual \+ behavior are\s*\/\/ consistent across the two no-leak self-service flows\./,
    );
  });

  it("AUTH_EXPOSE_DEBUG_TOKEN dev-mode framing pinned: 'Dev convenience: when AUTH_EXPOSE_DEBUG_TOKEN=true on the server, a debug_token field is surfaced as a paste-into link.' + 'Dev mode:' badge in markup + /auth/magic-link?token=... href construction. Drift to surfacing debug_token without the server-side gate would create a phishing-payload-injection vector", () => {
    expect(body).toMatch(
      /\/\/\s+4\. Dev convenience: when AUTH_EXPOSE_DEBUG_TOKEN=true on the server,\s*\/\/\s+a `debug_token` field is surfaced as a paste-into link\./,
    );
    // S23 2026-07-06 — accent-toned TEXT re-pinned raw tk-accent → AA-safe tk-accent-text (cross-app WCAG sweep).
    expect(body).toMatch(
      /<span class="font-mono uppercase tracking-wide text-tk-accent-text">Dev mode:<\/span>/,
    );
    expect(body).toMatch(
      /debugLink\.setAttribute\(\s*'href',\s*'\/auth\/magic-link\?token=' \+ encodeURIComponent\(body\.debug_token\),\s*\);/,
    );
  });

  it('data-page="magic-link-request" + Email-me-a-sign-in-link headline + form fields (id="magic-link-email" + name="email" + type="email" + autocomplete="email" + required) + Send-magic-link button — pinned so the page-script root + form-shape + browser-autocomplete-hint contract all stay documented', () => {
    expect(body).toMatch(/data-page="magic-link-request"/);
    expect(body).toMatch(/Email me a sign-in link/);
    expect(body).toMatch(
      /<input\s*id="magic-link-email"\s*name="email"\s*type="email"\s*required\s*autocomplete="email"/,
    );
    expect(body).toMatch(/Send magic-link/);
  });

  it("Check-your-inbox card copy pinned: 'If <span data-success-email…> matches a Driftstack account, a one-shot sign-in link is on the way. The link expires in <span data-success-window…>15 minutes</span>.' — pinned so the 15-minute-default expiry text + 'if matches' anti-enumeration phrasing (NOT 'we sent to') contract stays documented", () => {
    expect(body).toMatch(
      // S21 2026-07-06: text-tk-accent-text (was text-tk-accent-soft — the
      // 13%-alpha WASH token misused as a text color; ~1.2:1, invisible).
      /If <span data-success-email class="font-mono text-tk-accent-text"><\/span> matches a Driftstack\s*account, a one-shot sign-in link is on the way\. The link expires in <span\s*data-success-window\s*class="font-mono">15 minutes<\/span\s*>\./,
    );
  });

  it("?email= deep-link prefill framing pinned: 'Honor ?email= prefill — e.g. from a /login bounce after a failed password attempt where the user wants to try magic-link instead.' + params.get('email') + emailInput.value = prefill — pinned so the /login-bounce-prefill UX contract stays documented", () => {
    expect(body).toMatch(
      /\/\/ Honor \?email= prefill — e\.g\. from a \/login bounce after a failed\s*\/\/ password attempt where the user wants to try magic-link instead\./,
    );
    expect(body).toMatch(
      /const prefill = params\.get\('email'\);\s*if \(prefill && emailInput\) emailInput\.value = prefill;/,
    );
  });

  it("Dynamic-minutes-from-expires_at framing pinned: Math.max(1, Math.round((new Date(body.expires_at).getTime() - Date.now()) / 60000)) — pinned so the Math.max(1, …) floor stays documented (drift would let '0 minutes' surface for sub-30s windows)", () => {
    expect(body).toMatch(
      /const minutes = Math\.max\(\s*1,\s*Math\.round\(\(new Date\(body\.expires_at\)\.getTime\(\) - Date\.now\(\)\) \/ 60000\),\s*\);\s*successWindow\.textContent = minutes \+ ' minutes';/,
    );
  });
});
