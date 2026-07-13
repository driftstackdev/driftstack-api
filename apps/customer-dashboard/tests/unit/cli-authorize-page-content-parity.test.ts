// W372.C — drift guard for customer-dashboard /cli/authorize
// page content. V-266 + V-267 + V-328e. Existing cli-authorize-
// page-parity + cli-authorize-page-endpoints-parity + cli-
// authorize-route-parity tests cover route + endpoint wiring.
// This guard pins the load-bearing security + UX claims for
// the GUI-client activation deep-link surface:
//
//   • V-266 + V-267 + V-328e framing comment pinned (5-step
//     flow + V-266 "ONLY surface where a customer's web session
//     converts a CLI authorization code into a GUI-paired API
//     key" framing). A future redesign must update this comment.
//   • 6-state UI machine: loading / missing / needs-signin /
//     confirm / success / error.
//   • ?code= + ?state= URL-param parsing + missing-state branch.
//   • Sign-in gate redirect: /login?next= + /signup?next= both
//     encode the current URL (pathname + search), so deep-link
//     resumes cleanly after auth.
//   • POST /v1/auth/cli-authorize/bind registered server-side
//     + Bearer-token request shape.
//   • V-328e OS deep-link: driftstack://auth/callback?code=…&
//     state=… after 600ms delay (so user sees success first).
//   • Code preview: first 6 chars + ellipsis (no full-code leak
//     in UI).
//   • "API key named 'Desktop client'" + same-scope-as-dashboard
//     framing pinned (load-bearing security claim).
//   • Cross-links: /api-keys (revoke surface) + cancel → /.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/cli/authorize.astro');
const AUTH_CLI_ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/auth-cli.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W372.C customer-dashboard /cli/authorize page content parity', () => {
  const body = read(PAGE);

  it('V-266 + V-267 + V-328e framing comment pinned (ONLY surface for code→key conversion)', () => {
    expect(body).toMatch(/V-267 — Browser-OAuth confirmation page for the GUI client/);
    expect(body).toMatch(/V-266 backend cli-authorize routes/);
    // "Per V-266: this page is the ONLY surface where a customer's web"
    // is all on one line; the continuation wraps to the next // line.
    expect(body).toMatch(
      /Per V-266: this page is the ONLY surface where a customer's web\s*\n?\s*\/\/\s*session converts a CLI authorization code into a GUI-paired API key\./,
    );
    expect(body).toMatch(/The plaintext key never traverses this page\./);
  });

  it('6-state UI machine pinned: loading / missing / needs-signin / confirm / success / error', () => {
    for (const state of ['loading', 'missing', 'needs-signin', 'confirm', 'success', 'error']) {
      expect(body, `state missing: ${state}`).toMatch(new RegExp(`data-state="${state}"`));
    }
  });

  it('?code= + ?state= URL-param parsing + missing-state branch (both required)', () => {
    expect(body).toMatch(
      /const code = params\.get\('code'\);\s*\n?\s*const state = params\.get\('state'\);/,
    );
    expect(body).toMatch(/if \(!code \|\| !state\) \{\s*\n?\s*show\('missing'\);/);
  });

  it('sign-in gate redirect: /login?next= + /signup?next= encode current URL (deep-link resume)', () => {
    expect(body).toMatch(
      /const next = encodeURIComponent\(window\.location\.pathname \+ window\.location\.search\);/,
    );
    expect(body).toMatch(/signinLink\.setAttribute\('href', '\/login\?next=' \+ next\)/);
    expect(body).toMatch(/signupLink\.setAttribute\('href', '\/signup\?next=' \+ next\)/);
  });

  it('POST /v1/auth/cli-authorize/bind wired client + registered server-side (Bearer-token)', () => {
    expect(existsSync(AUTH_CLI_ROUTE)).toBe(true);
    expect(read(AUTH_CLI_ROUTE)).toContain("'/v1/auth/cli-authorize/bind'");
    expect(body).toMatch(/fetch\(apiBaseUrl \+ '\/v1\/auth\/cli-authorize\/bind'/);
    expect(body).toMatch(/authorization: 'Bearer ' \+ sessionToken/);
    expect(body).toMatch(/body: JSON\.stringify\(\{ code: code, state: state \}\)/);
  });

  it('serializes and bounds the consequential bind request', () => {
    expect(body).toContain('const AUTHORIZE_TIMEOUT_MS = 15_000;');
    expect(body).toContain('let authorizeInFlight = false;');
    expect(body).toMatch(/if \(authorizeInFlight\) return;/);
    expect(body).toMatch(/authorizeBtn\.setAttribute\('aria-busy', 'true'\)/);
    expect(body).toMatch(/const controller = new AbortController\(\);/);
    expect(body).toMatch(/signal: controller\.signal/);
    expect(body).toMatch(/window\.clearTimeout\(timeout\);\s*authorizeInFlight = false;/);
    expect(body).toContain('Authorization took too long. Check your connection and try again.');
  });

  it('V-328e OS deep-link: driftstack://auth/callback?code=…&state=… after 600ms delay', () => {
    expect(body).toMatch(/V-328e/);
    expect(body).toMatch(
      /'driftstack:\/\/auth\/callback\?code=' \+\s*\n?\s*encodeURIComponent\(code\) \+\s*\n?\s*'&state=' \+\s*\n?\s*encodeURIComponent\(state\)/,
    );
    expect(body).toMatch(/window\.setTimeout\(\(\) => \{[\s\S]*?\}, 600\);/);
  });

  it('code preview: first 6 chars + ellipsis (no full-code leak in UI)', () => {
    expect(body).toMatch(/codePreview\.textContent = code\.slice\(0, 6\) \+ '…';/);
  });

  it('"API key named \'Desktop client\'" + same-scope-as-dashboard security framing pinned', () => {
    expect(body).toMatch(
      /Authorizing will mint a new API key named "Desktop client" with the same scope\s+as your dashboard session/,
    );
    expect(body).toMatch(
      /The key gives the desktop app the same access as your web session\s+and remains active until you revoke it from <a href="\/api-keys"/,
    );
  });

  it('cross-links pinned: /api-keys (revoke surface) + cancel → /', () => {
    // S23 2026-07-06 — accent-toned TEXT re-pinned raw tk-accent → AA-safe tk-accent-text (cross-app WCAG sweep).
    expect(body).toMatch(
      /<a href="\/api-keys" class="text-tk-accent-text underline">API keys<\/a>/,
    );
    expect(body).toMatch(/<a href="\/api-keys"[\s\S]*?>\s*View your API keys\s*<\/a>/);
    expect(body).toMatch(
      /cancelBtn\.addEventListener\('click', \(\) => \{\s*\n?\s*window\.location\.href = '\/';/,
    );
    expect(existsSync(resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/api-keys.astro'))).toBe(
      true,
    );
  });

  it("'Sign in with browser' GUI affordance pinned in missing-state copy", () => {
    expect(body).toMatch(
      /Open it from the Driftstack\s+desktop app's "Sign in with browser" button/,
    );
  });

  it('localStorage ds_web_session_token read for sign-in gate', () => {
    expect(body).toMatch(/window\.localStorage\.getItem\('ds_web_session_token'\) \?\? null/);
  });

  it('withSidebar={false} pre-pair layout (CLI flow is its own surface)', () => {
    expect(body).toMatch(/<DashboardLayout title="Authorize desktop client" withSidebar=\{false\}/);
  });

  it('success-state polling-fallback hint pinned (URL-scheme reg may fail)', () => {
    // Load-bearing UX claim — V-328e's OS deep-link is best-
    // effort; the polling fallback in browser-sign-in.ts is the
    // actual delivery mechanism.
    expect(body).toMatch(
      /The desktop app should reopen automatically\. If it doesn't, switch back to it\s+manually — it will pick up the credentials on the next poll\./,
    );
  });
});
