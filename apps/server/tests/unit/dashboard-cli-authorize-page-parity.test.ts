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

  it('CRITICAL 5-step canonical flow includes the device-only verification code before bind', () => {
    const p = read(PAGE);

    expect(p).toMatch(/1\. GUI opens this URL with `\?code=…&state=…` query params/);
    expect(p).toMatch(/2\. Page checks localStorage\.ds_web_session_token — if missing/);
    expect(p).toMatch(/redirects to \/signup\?next=<this-url>/);
    expect(p).toMatch(/3\. Page requires the separate verification code displayed only by/);
    expect(p).toMatch(/initiating desktop app/);
    expect(p).toMatch(/4\. On Authorize: POST \/v1\/auth\/cli-authorize\/bind-device-code with/);
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

  it('CRITICAL bind contract requires Bearer auth plus code, state, and device-displayed user_code', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /fetch\(apiBaseUrl \+ '\/v1\/auth\/cli-authorize\/bind-device-code', \{[\s\S]*?authorization: 'Bearer ' \+ sessionToken,[\s\S]*?body: JSON\.stringify\(\{ code: code, state: state, user_code: userCode \}\),/,
    );
  });

  it('CRITICAL V-328e OS deep-link hand-off pinned — driftstack:// URL scheme on success. The 600ms setTimeout gives the user time to see the success confirmation before the OS focus swap. Drift would break the auto-return-to-desktop-app UX.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/V-328e — fire the OS deep-link redirect to hand off the/);
    expect(p).toMatch(/authorization to the desktop app's onOpenUrl listener/);
    expect(p).toMatch(/function returnToDesktop\(delayMs\) \{/);
    expect(p).toMatch(
      /'driftstack:\/\/auth\/callback\?code=' \+\s*\n\s+encodeURIComponent\(code\) \+\s*\n\s+'&state=' \+\s*\n\s+encodeURIComponent\(state\)/,
    );
    expect(p).toMatch(/returnToDesktop\(600\)/);
  });

  it('CRITICAL V-328 fallback framing pinned — "polling fallback in browser-sign-in.ts continues to work for installs where the URL scheme registration didn\'t take". The polling-as-fallback path is what guarantees GUI activation completes even when driftstack:// scheme isn\'t registered.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /The polling fallback in browser-sign-in\.ts\s*\n\s+\/\/ continues to work for installs where the URL scheme\s*\n\s+\/\/ registration didn't take/,
    );
  });

  it('CRITICAL separate user-code input is required and normalized without exposing it in the URL', () => {
    const p = read(PAGE);
    expect(p).toMatch(/data-user-code/);
    expect(p).toMatch(/placeholder="XXXX-XXXX"/);
    expect(p).toMatch(/\^\[A-HJ-NP-Z2-9\]\{4\}-\[A-HJ-NP-Z2-9\]\{4\}\$/);
    expect(p).not.toMatch(/codePreview|code\.slice\(0, 6\)/);
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

  it('CRITICAL retry avoids replay after an ambiguous bind timeout', () => {
    const p = read(PAGE);
    expect(p).toMatch(/if \(authorizeOutcomeUnknown\) \{\s*\n\s+returnToDesktop\(0\)/);
    expect(p).toMatch(/retryBtn\.textContent = 'Return to desktop'/);
  });

  it('CRITICAL customer copy identifies the minted key as restricted', () => {
    const p = read(PAGE);
    expect(p).toMatch(/Authorizing will mint a new restricted API key named "Desktop client"/);
  });

  it('CRITICAL /api-keys revoke-anytime framing pinned. The wording — "remains active until you revoke it from API keys" — tells customers how to undo a mistaken authorization.', () => {
    const p = read(PAGE);
    // S23 2026-07-06 — accent-toned TEXT re-pinned raw tk-accent → AA-safe tk-accent-text (cross-app WCAG sweep).
    expect(p).toMatch(
      /It remains active until you revoke it from <a href="\/api-keys" class="text-tk-accent-text underline">API keys<\/a>/,
    );
  });

  it('CRITICAL authorize-button loading state pinned — "Authorizing…" while in-flight + disabled. Drift to dropping would let users double-click + mint 2 keys.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /authorizeBtn\.disabled = true;[\s\S]*?authorizeBtn\.setAttribute\('aria-busy', 'true'\);\s*\n\s+authorizeBtn\.textContent = 'Authorizing…'/,
    );
    expect(p).toMatch(
      /\.finally\(\(\) => \{[\s\S]*?authorizeBtn\.disabled = false;[\s\S]*?authorizeBtn\.setAttribute\('aria-busy', 'false'\);\s*\n\s+authorizeBtn\.textContent = 'Authorize'/,
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
