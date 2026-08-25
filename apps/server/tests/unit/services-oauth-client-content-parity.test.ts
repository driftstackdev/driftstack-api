// Drift guard for apps/server/src/services/oauth-client.ts. Pins the
// V-667.C OAuth-client repo + service interfaces — 3 founder verdicts
// (merge-with-verification + IDP-revocation-fallback + first-link-only
// avatar/name sync) + 4-result discriminated linkOrCreateAccount union.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/services/oauth-client.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('services/oauth-client content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });

  it("V-667.C 3-verdict framing pinned: 'The service composes 4 repos (oauth-links + oauth-pending-links + accounts + email-sender) to fulfil the founder-locked verdicts: Verdict 1: existing-email collision → merge-with-verification via oauth_pending_links token sent to existing account's email. Verdict 2: IDP revocation → mark account_oauth_links.last_revoked_at on next-login-failure; graceful fallback to password (if set). Verdict 3: avatar/name sync → first-link-only; user-override wins (driven by accounts.avatar_source enum).' — pinned so the V-667.C anchor + 4-repo composition + 3-founder-verdict catalog + accounts.avatar_source enum cross-reference all stay documented", () => {
    expect(body).toMatch(/\/\/ V-667\.C — OAuth-client service interfaces\./);
    expect(body).toMatch(
      /\/\/ The service composes 4 repos \(oauth-links \+ oauth-pending-links \+\s*\/\/ accounts \+ email-sender\) to fulfil the founder-locked verdicts:/,
    );
    expect(body).toMatch(
      /\/\/ {3}Verdict 1: existing-email collision → merge-with-verification via\s*\/\/ {5}oauth_pending_links token sent to existing account's email\./,
    );
    expect(body).toMatch(
      /\/\/ {3}Verdict 2: IDP revocation → mark account_oauth_links\.last_revoked_at\s*\/\/ {5}on next-login-failure; graceful fallback to password \(if set\)\./,
    );
    expect(body).toMatch(
      /\/\/ {3}Verdict 3: avatar\/name sync → first-link-only; user-override\s*\/\/ {5}wins \(driven by accounts\.avatar_source enum\)\./,
    );
  });

  it('landing-plan framing pinned: both implementations SHIPPED. This header described db/oauth-links-repo.ts and services/oauth-client-service.ts as later slices long after both existed, so a reader planning work would have believed the persistence layer was still to be written. The negative keeps that wording from coming back.', () => {
    expect(body).toMatch(
      /\/\/ This file defines the REPO interfaces \+ the SERVICE interface\. The\s*\/\/ Drizzle implementation is in db\/oauth-links-repo\.ts and the service\s*\/\/ implementation is in services\/oauth-client-service\.ts\. Both shipped;/,
    );
    // V-1017 — the retracted framing named each file as a future slice.
    expect(body, 'the deferred landing-plan wording is back').not.toMatch(
      /\(next slice\)|\(slice after\)/,
    );
  });

  it('OAuthLinkRow 10-field shape pinned: id + accountId + provider + providerSub + providerEmail/Name/AvatarUrl (nullable) + linkedAt + lastLoginAt (nullable) + lastRevokedAt (nullable). Drift to making lastRevokedAt non-nullable would break Verdict 2 fallback semantics; drift to dropping providerSub would lose the stable IDP-identity discriminator', () => {
    expect(body).toMatch(/export interface OAuthLinkRow \{/);
    expect(body).toMatch(/id: string;/);
    expect(body).toMatch(/accountId: string;/);
    expect(body).toMatch(/provider: OAuthClientProvider;/);
    expect(body).toMatch(/providerSub: string;/);
    expect(body).toMatch(/providerEmail: string \| null;/);
    expect(body).toMatch(/providerName: string \| null;/);
    expect(body).toMatch(/providerAvatarUrl: string \| null;/);
    expect(body).toMatch(/linkedAt: Date;/);
    expect(body).toMatch(/lastLoginAt: Date \| null;/);
    expect(body).toMatch(/lastRevokedAt: Date \| null;/);
  });

  it("OAuthLinksRepo 5-method surface pinned: findByProviderSub + listForAccount + insertLink + markLoginAt + markRevokedAt. + 'Stamp last_revoked_at when the token-exchange returns an IDP-revoke error. Subsequent login attempts fall back to password per the founder verdict.' framing — pinned so the Verdict-2 token-exchange-revoke-detection contract stays documented (drift to dropping markRevokedAt would defeat the Verdict 2 fallback)", () => {
    expect(body).toMatch(/export interface OAuthLinksRepo \{/);
    expect(body).toMatch(
      /findByProviderSub\(\s*provider: OAuthClientProvider,\s*providerSub: string,\s*\): Promise<OAuthLinkRow \| null>;/,
    );
    expect(body).toMatch(
      /listForAccount\(accountId: string\): Promise<readonly OAuthLinkRow\[\]>;/,
    );
    expect(body).toMatch(/insertLink\(input: InsertOAuthLinkInput\): Promise<OAuthLinkRow>;/);
    expect(body).toMatch(/markLoginAt\(id: string, at: Date\): Promise<void>;/);
    expect(body).toMatch(/markRevokedAt\(id: string, at: Date\): Promise<void>;/);
    expect(body).toMatch(
      /\/\*\* Verdict 2 — stamp last_revoked_at when the token-exchange returns\s*\*\s+an IDP-revoke error\. Subsequent login attempts fall back to\s*\*\s+password per the founder verdict\. \*\//,
    );
  });

  it('OAuthPendingLinkRow 11-field shape pinned: id + accountId + provider + providerSub + providerEmail + providerName/AvatarUrl (nullable) + tokenHash + expiresAt + consumedAt (nullable) + createdAt. Drift to dropping tokenHash would break the single-use confirmation flow; drift to making consumedAt non-nullable would break the markConsumedAt idempotency contract', () => {
    expect(body).toMatch(/export interface OAuthPendingLinkRow \{/);
    expect(body).toMatch(/tokenHash: string;/);
    expect(body).toMatch(/expiresAt: Date;/);
    expect(body).toMatch(/consumedAt: Date \| null;/);
    expect(body).toMatch(/createdAt: Date;/);
  });

  it("OAuthPendingLinksRepo 3-method surface pinned: insertPending + findActiveByTokenHash + markConsumedAt. + 'Find by hash + check it isn't expired or already consumed. The now arg makes the time-check deterministic for tests.' framing + 'Mark consumed (single-use). Idempotent — second call no-ops.' — pinned so the deterministic-now-for-tests + idempotent-mark-consumed + single-use-token contract stay documented", () => {
    expect(body).toMatch(/export interface OAuthPendingLinksRepo \{/);
    expect(body).toMatch(
      /insertPending\(input: InsertPendingLinkInput\): Promise<OAuthPendingLinkRow>;/,
    );
    expect(body).toMatch(
      /\/\*\* Find by hash \+ check it isn't expired or already consumed\. The\s*\*\s+`now` arg makes the time-check deterministic for tests\. \*\//,
    );
    expect(body).toMatch(
      /findActiveByTokenHash\(tokenHash: string, now: Date\): Promise<OAuthPendingLinkRow \| null>;/,
    );
    expect(body).toMatch(
      // Atomic-claim CAS (2026-07-10): returns true only when THIS call claimed
      // the pending row, so confirmPendingLink can gate link-creation on the win.
      /Atomically claim the pending row as consumed \(single-use\)[\s\S]{0,420}?markConsumedAt\(id: string, at: Date\): Promise<boolean>;/,
    );
  });

  it("LinkOrCreateAccountResult 4-variant discriminated union pinned: signed-in-existing-link (accountId + linkId) + created-new-account (accountId + linkId) + collision-pending-verification (pendingLinkId + expiresAt, Verdict 1) + existing-link-revoked (accountId + linkId, Verdict 2). Drift to dropping a variant would break the route handler's exhaustive switch + leave one of the 4 OAuth login paths unhandled", () => {
    expect(body).toMatch(/export type LinkOrCreateAccountResult =/);
    expect(body).toMatch(/kind: 'signed-in-existing-link';/);
    expect(body).toMatch(/kind: 'created-new-account';/);
    expect(body).toMatch(/kind: 'collision-pending-verification';/);
    expect(body).toMatch(/kind: 'existing-link-revoked';/);
    expect(body).toMatch(/pendingLinkId: string;/);
    expect(body).toMatch(/expiresAt: Date;/);
  });

  it("Per-variant framing pinned: 'Existing link found — return the resolved account_id. The route should immediately issue a web session.' + 'New account created — IDP identity is the first + only account for this email.' + 'Email already has a password account; Verdict 1 collision flow: a oauth_pending_links token has been issued + emailed to the account's address. The route renders a \"check your email\" page.' + 'Existing link was previously marked revoked (Verdict 2). The route should prompt the user to re-link or sign in via password.' — pinned so the per-variant route-handler-action contract stays documented (drift would orphan the route logic from the service's discriminator)", () => {
    expect(body).toMatch(
      /\* Existing link found — return the resolved account_id\. The\s*\*\s+route should immediately issue a web session\./,
    );
    expect(body).toMatch(
      /\* New account created — IDP identity is the first \+ only\s*\*\s+account for this email\./,
    );
    expect(body).toMatch(
      /\* Email already has a password account; Verdict 1 collision\s*\*\s+flow: a oauth_pending_links token has been issued \+ emailed\s*\*\s+to the account's address\. The route renders a "check your\s*\*\s+email" page\./,
    );
    expect(body).toMatch(
      /\* Existing link was previously marked revoked \(Verdict 2\)\. The\s*\*\s+route should prompt the user to re-link or sign in via\s*\*\s+password\./,
    );
  });

  it('OAuthClientService 2-method interface pinned: linkOrCreateAccount (4-result union) + confirmPendingLink (token consume returning accountId + linkId, or null on expired/consumed/not-found). Drift would break the route layer that dispatches against these methods', () => {
    expect(body).toMatch(/export interface OAuthClientService \{/);
    expect(body).toMatch(
      /linkOrCreateAccount\(args: LinkOrCreateAccountArgs\): Promise<LinkOrCreateAccountResult>;/,
    );
    expect(body).toMatch(
      /confirmPendingLink\(\s*plaintextToken: string,\s*now\?: Date,\s*\): Promise<\{ accountId: string; linkId: string \} \| null>;/,
    );
    expect(body).toMatch(
      /\/\*\* Consume a pending-link token \(Verdict 1 collision-flow\s*\*\s+completion\)\. Returns the resolved account_id \+ the newly-\s*\*\s+inserted link, or `null` if the token is expired \/ consumed \/\s*\*\s+not found\. \*\//,
    );
  });

  it("LinkOrCreateAccountArgs 5-field shape pinned: provider + providerSub + email + name (nullable) + avatarUrl (nullable) + now? (test override). Drift to making name/avatarUrl required would break Verdict 3 first-link-only sync semantics for IDPs that don't return them", () => {
    expect(body).toMatch(/export interface LinkOrCreateAccountArgs \{/);
    expect(body).toMatch(/provider: OAuthClientProvider;/);
    expect(body).toMatch(/providerSub: string;/);
    expect(body).toMatch(/email: string;/);
    expect(body).toMatch(/name: string \| null;/);
    expect(body).toMatch(/avatarUrl: string \| null;/);
    expect(body).toMatch(/\/\*\* Override `now` for tests\. \*\/\s*now\?: Date;/);
  });
});
