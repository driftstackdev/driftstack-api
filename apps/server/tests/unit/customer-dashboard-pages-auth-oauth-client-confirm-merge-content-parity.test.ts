// Drift guard for apps/customer-dashboard/src/pages/auth/oauth-
// client/confirm-merge.astro. Pins the V-667.C Verdict 1 flow +
// the IDP-link-onto-existing-account semantic + the expired/
// consumed/invalid error-bucket framing.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(
  REPO_ROOT,
  'apps/customer-dashboard/src/pages/auth/oauth-client/confirm-merge.astro',
);

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('customer-dashboard auth/oauth-client/confirm-merge content parity', () => {
  const body = read(PAGE);

  it('file exists at canonical path', () => {
    expect(existsSync(PAGE)).toBe(true);
  });

  it('V-667.C Verdict 1 doc-comment framing pinned: pairs with backend `POST /v1/auth/oauth-client/confirm-merge`. Drift to renaming would orphan the email-link target + the frontend-backend pairing for the collision-flow completion', () => {
    expect(body).toMatch(/\/\/ V-667\.C Verdict 1 — collision-flow completion page/);
    expect(body).toMatch(/\/v1\/auth\/oauth-client\/confirm-merge \{ token \}/);
  });

  it('IDP-link-onto-existing-account semantic pinned: server links the IDP onto the existing account + returns the new account id. Drift to creating a new account instead would re-introduce the duplicate-account problem this flow was designed to prevent', () => {
    expect(body).toMatch(
      /server links the\s*\/\/?\s*IDP onto the existing account \+ returns the new account id/,
    );
  });

  it('On-success navigation pinned: navigates to / on success. Drift would leave customers stranded on the verify-merge page after a successful link', () => {
    expect(body).toMatch(/On success the page navigates to \//);
  });

  it('expired/consumed/invalid error bucket pinned: the 3 failure modes treated as one to avoid leaking which-bucket-the-token-was-in. Drift to distinguishing buckets in the UI would let attackers enumerate token state', () => {
    expect(body).toMatch(/On error \(expired \/ consumed\s*\/\/?\s*\/ invalid\)/);
    expect(body).toMatch(
      /surfaces a banner with a "request a new link" hint\s*\/\/?\s*pointing back to \/login/,
    );
  });

  it('withSidebar={false} on DashboardLayout — pinned because confirm-merge lands BEFORE the user has a session on the linked account (legacy session may have expired). Drift to a full layout would surface broken/inappropriate nav', () => {
    expect(body).toMatch(/<DashboardLayout title="Confirm IDP link" withSidebar=\{false\}>/);
  });

  it('expired-link fallback help-text pinned: redirects customers to /login + retry the IDP button. Drift to dropping the fallback would leave customers with no recovery path on expired/invalid tokens', () => {
    expect(body).toMatch(/Link expired or invalid\?/);
    expect(body).toMatch(/Sign in via password \+ retry the IDP\s+button from the/);
  });
});
