// Drift guard for apps/customer-dashboard/src/pages/auth/oauth-
// client/callback.astro. Pins the V-667.C IDP callback handler +
// the 4-outcome branching + the cookie-free v2 fragment hand-off /
// redeem (the v1 PKCE-cookie exchange was retired 2026-09-14).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(
  REPO_ROOT,
  'apps/customer-dashboard/src/pages/auth/oauth-client/callback.astro',
);

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('customer-dashboard auth/oauth-client/callback content parity', () => {
  const body = read(PAGE);

  it('file exists at canonical path', () => {
    expect(existsSync(PAGE)).toBe(true);
  });

  it('V-667.C doc-comment framing pinned: OAuth-client callback landing page. Pairs with the top-level GET /v1/auth/oauth/:provider/callback (fragment hand-off) + POST /v1/auth/oauth-client/redeem server endpoints. Drift would orphan the frontend-backend pairing', () => {
    expect(body).toMatch(/\/\/ V-667\.C — OAuth-client callback landing page/);
    expect(body).toMatch(
      /\/v1\/auth\/oauth\/:provider\/callback finishes the IDP exchange itself and\s*\/\/ 302s here with `#flow=<id>&code=<hand-off>` in the URL FRAGMENT/,
    );
    expect(body).toMatch(
      /this page POSTs \{code, flow_secret\} to\s*\/\/ \/v1\/auth\/oauth-client\/redeem with NO credentials/,
    );
  });

  it('all OAuth account outcomes plus the enrolled-MFA handoff are documented', () => {
    expect(body).toMatch(
      /signed-in-existing-link \/ created-new-account → session or mfa_required/,
    );
    // Both outcomes stay on this page (a card and a banner, no navigation);
    // /auth/oauth-client/check-email has never existed.
    expect(body).toMatch(/collision-pending-verification → in-page "Check your inbox" card/);
    expect(body).toMatch(
      /existing-link-revoked → in-page banner \(password or re-link via \/login\)/,
    );
    expect(body).not.toMatch(/check-email/);
    expect(body).toMatch(/mfa_required/);
  });

  it("Cookie-free v2 pinned (v1 cookie path retired 2026-09-14): 'No cookie exists anywhere in v2' framing + the retired v1 query shape is refused without a request; the source carries no credentials:'include', no v1 route literal, and no PKCE-cookie framing. Drift back to a credentialed exchange would re-expose every Safari / Incognito / Total-Cookie-Protection sign-in to the cross-site cookie drop", () => {
    expect(body).toMatch(/No cookie exists anywhere in v2/);
    expect(body).toMatch(
      /A \?code=&state= QUERY arrival \(the retired v1 shape\) is scrubbed from\s*\/\/ history and refused without any request/,
    );
    expect(body).not.toMatch(/credentials: 'include'/);
    expect(body).not.toMatch(/'\/v1\/auth\/oauth-client\/callback'/);
    expect(body).not.toMatch(/PKCE verifier cookie round-trip/);
  });

  it("Collision-pending-verification UI pinned: 'Check your inbox' card + neutral 'the email on your existing account' (the specific address was never populated → blank gap; reworded to drop the address claim) + 60-minute window. Drift to dropping the 60-min window would mislead customers about how long they have to click the verify link", () => {
    expect(body).toMatch(/data-success-merge/);
    expect(body).toMatch(/Check your inbox/);
    expect(body).toMatch(/We sent a confirmation link to the email on your existing account/);
    expect(body).toMatch(/data-merge-provider/);
    expect(body).toMatch(/expires in <span data-merge-window class="font-mono">60 minutes/);
  });

  it('withSidebar={false} on DashboardLayout — pinned because OAuth callback lands BEFORE the user is fully signed in. Drift would surface partial-auth navigation that can lead to confusing dead ends', () => {
    expect(body).toMatch(/<DashboardLayout title="Signing you in…" withSidebar=\{false\}>/);
  });

  it('renders the partial-auth MFA form without persisting its challenge token', () => {
    expect(body).toMatch(/data-form="oauth-mfa"/);
    expect(body).toMatch(/autocomplete="one-time-code"/);
    expect(body).toMatch(/let mfaChallengeToken = null/);
    expect(body).not.toMatch(/localStorage\.setItem\([^\n]*challenge/);
  });
});
