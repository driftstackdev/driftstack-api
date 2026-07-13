// Drift guard for apps/customer-dashboard/src/pages/auth/magic-link.astro.
// Pins #190 magic-link consume page — token-one-shot semantics +
// ds_web_session_token localStorage write + fallback form for mangled
// links + ?next= round-trip. The session-token-localStorage-write is
// the load-bearing customer-side persistence; drift would lose the
// signed-in state on redirect.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/auth/magic-link.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('customer-dashboard/pages/auth/magic-link content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });

  it('#190 module framing pins the backend pairing and one-shot link/MFA challenge', () => {
    expect(body).toMatch(
      /\/\/ #190 — magic-link consume page\. Pairs with the V-079 backend route\s*\n?\s*\/\/ `POST \/v1\/auth\/magic-link\/consume`\./,
    );
    expect(body).toMatch(
      /\/\/\s+1\. User requests a magic-link on \/login \(forgot-password style\)\./,
    );
    expect(body).toMatch(
      /\/\/\s+6\. Token is one-shot — second use returns 400; a successful MFA challenge is too\./,
    );
  });

  it("Fallback-form-for-mangled-link framing pinned: 'The form is rendered as a fallback for the rare case where a mail client mangles the link (drops the query string), so the user can paste the token manually.' — pinned so the mail-client-mangled-recovery contract stays documented", () => {
    expect(body).toMatch(
      /\/\/ The form is rendered as a fallback for the rare case where a mail\s*\n?\s*\/\/ client mangles the link \(drops the query string\), so the user can\s*\n?\s*\/\/ paste the token manually\./,
    );
  });

  it('data-page="magic-link" + Signing-you-in headline + data-form="magic-link" data-state="fallback" hidden + magic-link-token input + autocomplete="one-time-code" — pinned so the page-script root + fallback-form + browser-autocomplete-hint contract all stay documented', () => {
    expect(body).toMatch(/data-page="magic-link"/);
    expect(body).toMatch(/Signing you in…/);
    expect(body).toMatch(/data-form="magic-link" class="hidden space-y-5" data-state="fallback"/);
    expect(body).toMatch(
      /<input\s*\n?\s*id="magic-link-token"\s*\n?\s*name="token"\s*\n?\s*type="text"\s*\n?\s*required\s*\n?\s*autocomplete="one-time-code"/,
    );
  });

  it('completeSession persists the canonical session token and clears prior-user overrides', () => {
    expect(body).toMatch(
      /function completeSession\(session\) \{\s*\n?\s*localStorage\.setItem\('ds_web_session_token', session\.token\);[\s\S]*?localStorage\.removeItem\('ds_act_as_account'\);[\s\S]*?localStorage\.removeItem\('ds_is_staff_user'\);/,
    );
  });

  it("?next= round-trip is open-redirect-guarded via safeNextPath (audit w2flmiw48 #5-7 — was a raw next ? next : '/' open redirect). Same-origin relative path only, else '/'.", () => {
    expect(body).toMatch(
      /const params = new URLSearchParams\(window\.location\.search\);\s*\n?\s*window\.location\.href = safeNextPath\(params\.get\('next'\), window\.location\.origin\);/,
    );
    expect(body).toMatch(/const safeNextPath = \(next, origin\) =>/);
  });

  it("fetch POST /v1/auth/magic-link/consume + credentials:'include' + body:JSON.stringify({token:token}) framing pinned. Drift to dropping credentials:'include' would prevent the server's Set-Cookie response from landing", () => {
    expect(body).toMatch(
      /fetch\(apiBaseUrl \+ '\/v1\/auth\/magic-link\/consume', \{[\s\S]+?body: JSON\.stringify\(\{ token: token \}\),[\s\S]+?credentials: 'include',[\s\S]+?signal: controller\.signal,/,
    );
  });

  it('On-error keeps the token prefilled and routes visible copy through the shared fixed mapper', () => {
    expect(body).toMatch(
      /\.catch\(\(err\) => \{[\s\S]+?if \(err && err\.name === 'AbortError'\)[\s\S]+?showFallbackForm\(token\);\s*\n?\s*showBanner\(\s*\n?\s*window\.driftstackRequestErrorMessage\(err, 'Magic-link sign-in failed\.'\),\s*\n?\s*\);/,
    );
    expect(body).not.toMatch(/showBanner\(err && err\.message/);
  });
});
