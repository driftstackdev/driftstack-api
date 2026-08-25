// Drift guard for apps/customer-dashboard/src/pages/auth/oauth-
// client/callback.astro. Pins the V-667.C IDP callback handler +
// the 3-outcome branching + the PKCE verifier cookie round-trip.

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

  it('V-667.C doc-comment framing pinned: OAuth-client callback landing page. Pairs with the GET /v1/auth/oauth-client/callback server endpoint. Drift would orphan the frontend-backend pairing', () => {
    expect(body).toMatch(/\/\/ V-667\.C — OAuth-client callback landing page/);
    expect(body).toMatch(
      /POSTs the same query params back to \/v1\/auth\/oauth-client\s*\/\/?\s*\/callback/,
    );
  });

  it('all OAuth account outcomes plus the enrolled-MFA handoff are documented', () => {
    expect(body).toMatch(
      /signed-in-existing-link \/ created-new-account → session or mfa_required/,
    );
    expect(body).toMatch(/collision-pending-verification → \/auth\/oauth-client\/check-email/);
    expect(body).toMatch(/existing-link-revoked → \/login with "re-link or password" prompt/);
    expect(body).toMatch(/mfa_required/);
  });

  it("PKCE verifier cookie round-trip framing pinned: 'PKCE verifier cookie round-trip is automatic via credentials:include'. Drift to dropping credentials:include would break the PKCE verifier round-trip + every OAuth sign-in attempt", () => {
    expect(body).toMatch(/PKCE verifier cookie round-trip is automatic via credentials:'include'/);
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
