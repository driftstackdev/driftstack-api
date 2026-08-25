// Drift guard for apps/customer-dashboard/src/pages/auth/oauth-client/
// confirm-merge.astro. Pins the V-667.C Verdict 1 collision-flow
// completion page — the user clicks the email link with ?token=...
// which POSTs to /v1/auth/oauth-client/confirm-merge { token }. On
// success navigate to /; on error surface a banner with a "request a
// new link" hint pointing back to /login.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(
  REPO_ROOT,
  'apps/customer-dashboard/src/pages/auth/oauth-client/confirm-merge.astro',
);

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('customer-dashboard/pages/auth/oauth-client/confirm-merge content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });

  it('V-667.C Verdict 1 module-level framing pinned: \'collision-flow completion page. The user clicks the email link with ?token=... → this page POSTs to /v1/auth/oauth-client/confirm-merge { token } → server links the IDP onto the existing account + returns the new account id. On success the page navigates to /. On error (expired / consumed / invalid) it surfaces a banner with a "request a new link" hint pointing back to /login.\' — pinned so the V-667.C-Verdict-1 anchor + 3-step flow + 3-error-states roster (expired / consumed / invalid) + /login fallback contract all stay documented', () => {
    expect(body).toMatch(
      /\/\/ V-667\.C Verdict 1 — collision-flow completion page\. The user clicks\s*\/\/ the email link with \?token=\.\.\. → this page POSTs to\s*\/\/ \/v1\/auth\/oauth-client\/confirm-merge \{ token \} → server links the\s*\/\/ IDP onto the existing account \+ returns the new account id\./,
    );
    expect(body).toMatch(
      /\/\/ On success the page navigates to \/\. On error \(expired \/ consumed\s*\/\/ \/ invalid\) it surfaces a banner with a "request a new link" hint\s*\/\/ pointing back to \/login\./,
    );
  });

  it('data-page="oauth-confirm-merge" + Linking-your-account headline pinned. Drift to a different data-page attribute would break the page-script\'s root.querySelector hook', () => {
    expect(body).toMatch(/data-page="oauth-confirm-merge"/);
    expect(body).toMatch(/Linking your account…/);
    expect(body).toMatch(/data-field="intro"/);
    expect(body).toMatch(/data-banner/);
  });

  it("Missing-token banner copy + /login fallback link framing pinned: 'Missing token query parameter. Click the link in the verify-merge email.' + '<a href=\"/login\"…>login page</a>'. Drift to a different fallback URL would break the user's recovery path", () => {
    expect(body).toMatch(
      /showBanner\("Missing 'token' query parameter\. Click the link in the verify-merge email\."\);/,
    );
    expect(body).toMatch(
      /Link expired or invalid\? Sign in via password \+ retry the IDP\s*button from the <a\s*href="\/login\/"/,
    );
  });

  it("fetch credentials:'include' + POST /v1/auth/oauth-client/confirm-merge + content-type:application/json + body:JSON.stringify({token}) framing pinned. Drift to credentials:'omit' would not send the session cookie + drift to a non-JSON body would mismatch the server schema", () => {
    expect(body).toMatch(
      /fetch\(apiBaseUrl \+ '\/v1\/auth\/oauth-client\/confirm-merge', \{\s*method: 'POST',\s*headers: \{ 'content-type': 'application\/json' \},\s*credentials: 'include',\s*body: JSON\.stringify\(\{ token: token \}\),\s*signal: controller\.signal,\s*\}\)/,
    );
  });

  it('On success navigates home; on failure uses fixed shared response/request copy', () => {
    expect(body).toMatch(/\.then\(\(\) => \{\s*window\.location\.href = '\/';\s*\}\)/);
    expect(body).toMatch(
      /return r\s*\.json\(\)\s*\.catch\(\(\) => \(\{\}\)\)\s*\.then\(\(b\) =>\s*Promise\.reject\(window\.driftstackResponseError\(r, b\)\),?\s*\);/,
    );
    expect(body).toMatch(
      /window\.driftstackRequestErrorMessage\(\s*err,\s*'Account linking could not be confirmed\. Request a new link and try again\.',/,
    );
    expect(body).not.toMatch(/new Error\(b\.detail/);
  });
});
