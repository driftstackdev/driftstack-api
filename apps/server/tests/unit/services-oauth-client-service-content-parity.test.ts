// Drift guard for apps/server/src/services/oauth-client-service.ts.
// Pins the V-667.C OAuth-client service implementation — the 3-step
// linkOrCreateAccount dispatch (existing-link → email-collision →
// create-new) + the 60-min pending-token TTL + sha256-hashed token
// at rest + 32-byte plaintext token generation.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/services/oauth-client-service.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('services/oauth-client-service content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });

  it("V-667.C implementation framing pinned: 'OAuth-client service implementation. Composes the 2 repos (oauth-links + pending-links) + a minimal accounts lookup + a token generator to fulfil the founder-verdict-locked flow.' + 3-verdict catalog. — pinned so the V-667.C anchor + 2-repo + accounts-lookup + token-generator composition + 3-verdict catalog (60-min collision + IDP-revocation marker + avatar-source-enum-not-re-pull-every-login) all stay documented", () => {
    expect(body).toMatch(
      /\/\/ V-667\.C — OAuth-client service implementation\. Composes the 2 repos\s*\/\/ \(oauth-links \+ pending-links\) \+ a minimal accounts lookup \+ a token\s*\/\/ generator to fulfil the founder-verdict-locked flow:/,
    );
    expect(body).toMatch(
      /\/\/ {3}Verdict 1: existing-email collision → MERGE-WITH-VERIFICATION\s*\/\/ {5}\(60-min single-use token sent to existing account's email\)/,
    );
    expect(body).toMatch(/\/\/ {3}Verdict 2: IDP-revocation marker on next-login-failure/);
    expect(body).toMatch(
      /\/\/ {3}Verdict 3: avatar\/name sync first-link-only \+ user-overridable\s*\/\/ {5}\(driven by accounts\.avatar_source enum, NOT by re-pull every\s*\/\/ {5}login\)/,
    );
  });

  it("PENDING_TTL_MS = 60 minutes pinned: 'const PENDING_TTL_MS = 60 * 60 * 1000; // V-667.C Verdict 1 — 60 min'. Drift would diverge from the Verdict-1 founder lock-window and either make collision tokens easier to brute force (shorter) or leave attack surface open longer than intended", () => {
    expect(body).toMatch(
      /const PENDING_TTL_MS = 60 \* 60 \* 1000; \/\/ V-667\.C Verdict 1 — 60 min/,
    );
  });

  it("AccountsLookup 2-method dep interface pinned: findIdByEmail (case-insensitive) + createFromIdp (sets avatar_source='idp' when avatarUrl provided, Verdict 3). + 'Insert a new account from an IDP signup. Sets avatar_source to idp when avatarUrl is provided + name from IDP per Verdict 3.' framing — pinned so the Verdict-3 avatar_source='idp' contract stays explicit (drift to dropping the avatar_source set would break the user-override-wins precedence)", () => {
    expect(body).toMatch(/export interface AccountsLookup \{/);
    expect(body).toMatch(/findIdByEmail\(email: string\): Promise<string \| null>;/);
    expect(body).toMatch(
      /\* Insert a new account from an IDP signup\. Sets avatar_source\s*\*\s+to 'idp' when avatarUrl is provided \+ name from IDP per\s*\*\s+Verdict 3\. Returns the new account id\./,
    );
    expect(body).toMatch(
      /createFromIdp\(args: \{\s*email: string;\s*name: string \| null;\s*avatarUrl: string \| null;\s*\}\): Promise<string>;/,
    );
  });

  it("OAuthPendingMailer fire-and-forget framing pinned: 'Send the Verdict-1 verify-merge email with the plaintext token in the URL. Fire-and-forget; failures are surfaced via the passed-in logger but not awaited (matches the rest of the email-service posture).' — pinned so the fire-and-forget contract + logger-not-throw + matches-rest-of-email-service rationale all stay documented (drift to awaiting would couple link-or-create latency to Postmark delivery latency)", () => {
    expect(body).toMatch(/export interface OAuthPendingMailer \{/);
    expect(body).toMatch(
      /\* Send the Verdict-1 verify-merge email with the plaintext token\s*\*\s+in the URL\. Fire-and-forget; failures are surfaced via the\s*\*\s+passed-in logger but not awaited \(matches the rest of the\s*\*\s+email-service posture\)\./,
    );
    expect(body).toMatch(
      /sendVerifyMergeEmail\(args: \{\s*to: string;\s*provider: 'google' \| 'github';\s*plaintextToken: string;\s*expiresAt: Date;\s*\}\): Promise<void>;/,
    );
  });

  it('OAuthClientServiceDeps 4-field shape pinned: links + pending + accounts + mailer. Drift to dropping a dep would break the 3-step linkOrCreateAccount dispatch that depends on all 4 collaborators', () => {
    expect(body).toMatch(
      /export interface OAuthClientServiceDeps \{\s*links: OAuthLinksRepo;\s*pending: OAuthPendingLinksRepo;\s*accounts: AccountsLookup;\s*mailer: OAuthPendingMailer;\s*\}/,
    );
  });

  it('linkOrCreateAccount 3-step dispatch pinned: Step 1 fast-path findByProviderSub + Verdict-2 fork on lastRevokedAt + signed-in-existing-link on success. Drift to checking email-collision BEFORE existing-link would re-prompt verify-merge on every login for already-linked accounts (UX regression + extra email spam)', () => {
    expect(body).toMatch(
      /\/\/ Step 1 — fast path: existing link for this IDP identity\?\s*const existing = await this\.deps\.links\.findByProviderSub\(args\.provider, args\.providerSub\);/,
    );
    expect(body).toMatch(
      /\/\/ Verdict 2 fork — previously marked revoked\. Don't auto-sign-in;\s*\/\/ the route prompts the user to re-link or fall back to password\.\s*if \(existing\.lastRevokedAt !== null\) \{/,
    );
    expect(body).toMatch(
      /return \{\s*kind: 'signed-in-existing-link',\s*accountId: existing\.accountId,\s*linkId: existing\.id,\s*\};/,
    );
  });

  it("Step 2 email-collision pinned: findIdByEmail → if non-null, generate plaintext + sha256-hash + 60-min expiresAt + insertPending + fire-and-forget mailer + return collision-pending-verification. + 'Fire-and-forget per email-service posture; route-layer logs any send error via Sentry-pinned warn handler.' — pinned so the void-the-mailer + Sentry-warn-handler-route-logs contract stays documented", () => {
    expect(body).toMatch(
      /\/\/ Step 2 — no link\. Is there an existing account with this email\?\s*const collidingAccountId = await this\.deps\.accounts\.findIdByEmail\(args\.email\);/,
    );
    expect(body).toMatch(
      /\/\/ Verdict 1 — collision\. Issue a pending-link token, send email\.\s*const plaintext = generatePlaintextToken\(\);\s*const tokenHash = sha256Hex\(plaintext\);\s*const expiresAt = new Date\(now\.getTime\(\) \+ PENDING_TTL_MS\);/,
    );
    expect(body).toMatch(
      /\/\/ Fire-and-forget per email-service posture; route-layer logs\s*\/\/ any send error via Sentry-pinned warn handler\.\s*void this\.deps\.mailer\.sendVerifyMergeEmail\(\{/,
    );
    expect(body).toMatch(
      /return \{\s*kind: 'collision-pending-verification',\s*pendingLinkId: pending\.id,\s*expiresAt,\s*\};/,
    );
  });

  it('Step 3 create-new-account pinned: no link + no collision → createFromIdp + insertLink + markLoginAt + return created-new-account. Drift to skipping markLoginAt on the new-account path would leave lastLoginAt NULL after the very first sign-in (defeats the audit-trail purpose)', () => {
    expect(body).toMatch(
      /\/\/ Step 3 — no link, no colliding account → create new from IDP\.\s*const newAccountId = await this\.deps\.accounts\.createFromIdp\(\{/,
    );
    expect(body).toMatch(
      /const link = await this\.deps\.links\.insertLink\(\{\s*accountId: newAccountId,/,
    );
    expect(body).toMatch(/await this\.deps\.links\.markLoginAt\(link\.id, now\);/);
    expect(body).toMatch(
      /return \{\s*kind: 'created-new-account',\s*accountId: newAccountId,\s*linkId: link\.id,\s*\};/,
    );
  });

  it("confirmPendingLink 4-step flow pinned: sha256Hex(plaintext) → findActiveByTokenHash → if null return null → insertLink onto pending.accountId + markLoginAt + markConsumedAt + return accountId+linkId. + 'mark the pending row consumed (single-use)' framing — pinned so the single-use-token + idempotent-mark-consumed + return-null-on-expired-or-consumed-or-not-found contract stays documented", () => {
    expect(body).toMatch(
      /async confirmPendingLink\(\s*plaintextToken: string,\s*now\?: Date,\s*\): Promise<\{ accountId: string; linkId: string \} \| null>/,
    );
    expect(body).toMatch(
      /const tokenHash = sha256Hex\(plaintextToken\);\s*const nowDate = now \?\? new Date\(\);\s*const pending = await this\.deps\.pending\.findActiveByTokenHash\(tokenHash, nowDate\);\s*if \(!pending\) return null;/,
    );
    // Atomic-claim reorder (2026-07-10): the single-use consume is now a CAS
    // gate BEFORE insertLink (claim wins → create; loser → clean null/400), so a
    // double-submit can't hit the duplicate-key 500. Mirrors consumeCodeIfUnconsumed.
    expect(body).toMatch(
      /Atomic single-use gate: claim the pending row BEFORE creating the link\./,
    );
    expect(body).toMatch(/authoritative serialization point/);
    expect(body).toMatch(
      /if \(!\(await this\.deps\.pending\.markConsumedAt\(pending\.id, nowDate\)\)\) \{\s*return null;\s*\}/,
    );
  });

  it("generatePlaintextToken 32-byte → 64-hex framing pinned: 'Same shape as the existing auth-flow plaintext tokens (email_verify, magic_link, password_reset) so the per-token entropy ceiling stays consistent across the auth surface.' — pinned so the cross-token-shape uniformity contract + the existing 3-auth-flow-token cross-reference (email_verify + magic_link + password_reset) all stay documented", () => {
    expect(body).toMatch(
      /\/\*\* 32 random bytes → 64 hex chars\. Same shape as the existing\s*\*\s+auth-flow plaintext tokens \(email_verify, magic_link, password_reset\)\s*\*\s+so the per-token entropy ceiling stays consistent across the auth\s*\*\s+surface\. \*\/\s*function generatePlaintextToken\(\): string \{\s*return randomBytes\(32\)\.toString\('hex'\);\s*\}/,
    );
  });

  it('sha256Hex helper pinned: createHash(sha256).update(value).digest(hex). Drift to a weaker hash (md5/sha1) would let attackers brute-force the pending-link token store; drift to a different encoding (base64) would break the at-rest comparison contract', () => {
    expect(body).toMatch(
      /function sha256Hex\(value: string\): string \{\s*return createHash\('sha256'\)\.update\(value\)\.digest\('hex'\);\s*\}/,
    );
  });
});
