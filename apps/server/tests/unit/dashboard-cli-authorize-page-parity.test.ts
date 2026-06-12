// W738 — customer-dashboard /cli/authorize.astro V-266/V-267/V-328e
// page parity. Sixty-fourth in the cross-SDK drift-guard series.
//
// Pins the canonical browser-OAuth confirmation page that converts a
// CLI / GUI authorization code into a GUI-paired API key. The page
// is the ONLY surface where a web session can mint a CLI API key —
// drift here would break GUI client activation for every customer.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const PAGE = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/cli/authorize.astro');

describe('W738 dashboard /cli/authorize page V-266/V-267/V-328e parity', () => {
  it('cli/authorize.astro file exists at the canonical path matching W686 cross-SDK CLI-activation flow', () => {
    expect(existsSync(PAGE)).toBe(true);
  });

  it('CRITICAL V-267 anchor + V-266 backend pairing pinned. The "Browser-OAuth confirmation page for the GUI client activation flow (paired with V-266 backend cli-authorize routes)" framing threads BOTH the V-anchors.', () => {
    const p = read(PAGE);
    expect(p).toMatch(/V-267 — Browser-OAuth confirmation page for the GUI client/);
    expect(p).toMatch(/activation flow \(paired with V-266 backend cli-authorize routes\)/);
  });

  it('CRITICAL 5-step canonical flow framing pinned. The flow is: GUI opens URL ?code=&state= → check session → confirmation UI → POST bind → success screen. Drift to a different step ordering would break the V-266 contract.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/1\. GUI opens this URL with `\?code=…&state=…` query params/);
    expect(p).toMatch(/2\. Page checks localStorage\.ds_web_session_token — if missing/);
    expect(p).toMatch(/redirects to \/signup\?next=<this-url>/);
    expect(p).toMatch(/3\. Page shows a confirmation: "Authorize Driftstack desktop client\?"/);
    expect(p).toMatch(/4\. On Authorize: POST \/v1\/auth\/cli-authorize\/bind with/);
    expect(p).toMatch(/5\. Success screen: "Authorized — return to the desktop app\."/);
  });

  it('CRITICAL plaintext-key-NEVER-traverses-page framing pinned. The wording "The plaintext key never traverses this page" is the load-bearing security invariant — server mints + stages key for GUI\'s exchange poll; web session NEVER sees the plaintext.', () => {
    const p = read(PAGE);
    expect(p).toMatch(/The plaintext key never traverses this page/);
    expect(p).toMatch(
      /Per V-266: this page is the ONLY surface where a customer's web\s*\n\/\/ session converts a CLI authorization code into a GUI-paired API key/,
    );
  });

  it('CRITICAL 6-state UI machine pinned — loading + missing + needs-signin + confirm + success + error. Each state has data-state attribute; the show() helper toggles visibility. Drift to dropping a state would leave customers in a UI dead-end.', () => {
    const p = read(PAGE);

    for (const state of ['loading', 'missing', 'needs-signin', 'confirm', 'success', 'error']) {
      expect(p, `state ${state}`).toMatch(new RegExp(`data-state="${state}"`));
    }

    // show() helper toggles visibility (one section visible at a time).
    // 2026-05-20 d1281076 — show() now indirects through KEY_BY_STATE so
    // kebab-case state names ('needs-signin') map to camelCase keys
    // (needsSignin); pin the indirection so a future refactor can't drop
    // it and re-introduce the blank-page bug.
    expect(p).toMatch(
      /function show\(name\) \{\s*\n\s+const target = KEY_BY_STATE\[name\] \?\? name;/,
    );
    expect(p).toMatch(/for \(const key of Object\.keys\(sections\)\)/);
  });

  it('CRITICAL code + state URL param validation pinned. Both required for the bind contract; missing either shows the missing-state UI with clear recovery framing ("Open it from the Driftstack desktop app\'s Sign in with browser button").', () => {
    const p = read(PAGE);

    expect(p).toMatch(/const code = params\.get\('code'\)/);
    expect(p).toMatch(/const state = params\.get\('state'\)/);
    expect(p).toMatch(/if \(!code \|\| !state\) \{\s*\n\s+show\('missing'\);/);
    expect(p).toMatch(
      /This page expects an authorization code in the URL\. Open it from the Driftstack\s*\n\s+desktop app's "Sign in with browser" button/,
    );
  });

  it('CRITICAL sign-in gate redirect ?next= contract pinned — `next = encodeURIComponent(window.location.pathname + window.location.search)`. The pathname + search round-trip is what brings the user back to /cli/authorize?code=...&state=... after signin. Drift to dropping search would lose the OAuth code mid-flow.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /const next = encodeURIComponent\(window\.location\.pathname \+ window\.location\.search\)/,
    );
    expect(p).toMatch(/signinLink\.setAttribute\('href', '\/login\?next=' \+ next\)/);
    expect(p).toMatch(/signupLink\.setAttribute\('href', '\/signup\?next=' \+ next\)/);
  });

  it('CRITICAL bind contract pinned — POST /v1/auth/cli-authorize/bind with Bearer auth + body {code, state}. The Bearer-not-cookie auth is what threads the web session into the server (mirrors W703 CLI activation cross-SDK).', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /fetch\(apiBaseUrl \+ '\/v1\/auth\/cli-authorize\/bind', \{\s*\n\s+method: 'POST',\s*\n\s+headers: \{\s*\n\s+'content-type': 'application\/json',\s*\n\s+authorization: 'Bearer ' \+ sessionToken,\s*\n\s+\},\s*\n\s+body: JSON\.stringify\(\{ code: code, state: state \}\),/,
    );
  });

  it('CRITICAL V-328e OS deep-link hand-off pinned — driftstack:// URL scheme on success. The 600ms setTimeout gives the user time to see the success confirmation before the OS focus swap. Drift would break the auto-return-to-desktop-app UX.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/V-328e — fire the OS deep-link redirect to hand off the/);
    expect(p).toMatch(/authorization to the desktop app's onOpenUrl listener/);
    expect(p).toMatch(
      /window\.setTimeout\(\(\) => \{\s*\n\s+try \{\s*\n\s+const target =\s*\n\s+'driftstack:\/\/auth\/callback\?code=' \+/,
    );
    expect(p).toMatch(
      /'driftstack:\/\/auth\/callback\?code=' \+\s*\n\s+encodeURIComponent\(code\) \+\s*\n\s+'&state=' \+\s*\n\s+encodeURIComponent\(state\)/,
    );
    expect(p).toMatch(/\}, 600\)/);
  });

  it('CRITICAL V-328 fallback framing pinned — "polling fallback in browser-sign-in.ts continues to work for installs where the URL scheme registration didn\'t take". The polling-as-fallback path is what guarantees GUI activation completes even when driftstack:// scheme isn\'t registered.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /The polling fallback in browser-sign-in\.ts\s*\n\s+\/\/ continues to work for installs where the URL scheme\s*\n\s+\/\/ registration didn't take/,
    );
  });

  it("CRITICAL code-preview truncation to 6 chars pinned — `code.slice(0, 6) + '…'`. The 6-char preview is what gives the user visible confirmation that they're authorizing THIS code (not some random replay). Drift to longer would leak more entropy; drift to shorter would lose the discrimination value.", () => {
    const p = read(PAGE);
    expect(p).toMatch(/codePreview\.textContent = code\.slice\(0, 6\) \+ '…'/);
  });

  it('CRITICAL Cancel button redirects to dashboard root. Drift to redirect-to-login would force re-authentication on cancel.', () => {
    const p = read(PAGE);
    expect(p).toMatch(
      /cancelBtn\.addEventListener\('click', \(\) => \{\s*\n\s+window\.location\.href = '\/'/,
    );
  });

  it('CRITICAL on-success fallback hint visible — "The desktop app should reopen automatically. If it doesn\'t, switch back to it manually — it will pick up the credentials on the next poll." Drift to dropping would leave customers confused if the deep-link doesn\'t fire.', () => {
    const p = read(PAGE);
    expect(p).toMatch(
      /The desktop app should reopen automatically\. If it doesn't, switch back to it\s*\n\s+manually — it will pick up the credentials on the next poll/,
    );
  });

  it('CRITICAL retry-button on error wired to authorize() handler. Drift to dropping would leave customers with a dead button after a transient network error.', () => {
    const p = read(PAGE);
    expect(p).toMatch(/retryBtn\.addEventListener\('click', authorize\)/);
  });

  it('CRITICAL Desktop client name framing pinned — "Authorizing will mint a new API key named \'Desktop client\' with the same scope as your dashboard session". Drift to a different default name would mismatch the V-266 backend; the customer sees this name in /api-keys later.', () => {
    const p = read(PAGE);
    expect(p).toMatch(
      /Authorizing will mint a new API key named "Desktop client" with the same scope\s*\n\s+as your dashboard session/,
    );
  });

  it('CRITICAL /api-keys revoke-anytime framing pinned. The wording — "remains active until you revoke it from API keys" — tells customers how to undo a mistaken authorization.', () => {
    const p = read(PAGE);
    expect(p).toMatch(
      /and remains active until you revoke it from <a href="\/api-keys" class="text-tk-accent underline">API keys<\/a>/,
    );
  });

  it('CRITICAL authorize-button loading state pinned — "Authorizing…" while in-flight + disabled. Drift to dropping would let users double-click + mint 2 keys.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /authorizeBtn\.disabled = true;\s*\n\s+authorizeBtn\.textContent = 'Authorizing…'/,
    );
    expect(p).toMatch(
      /\.finally\(\(\) => \{\s*\n\s+authorizeBtn\.disabled = false;\s*\n\s+authorizeBtn\.textContent = 'Authorize'/,
    );
  });

  it('CRITICAL resolveApiBaseUrl + DashboardLayout(withSidebar=false) used (matches W735+W736+W737 auth-page pattern).', () => {
    const p = read(PAGE);
    expect(p).toMatch(/import \{ resolveApiBaseUrl \} from '\.\.\/\.\.\/lib\/api-base-url'/);
    expect(p).toMatch(/const apiBaseUrl = resolveApiBaseUrl\(\)/);
    expect(p).toMatch(/withSidebar=\{false\}/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/dashboard-cli-authorize-page-parity.test.ts'),
      ),
    ).toBe(true);
  });
});
