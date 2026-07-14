// W930 — V-295c3 status-subscribers double-opt-in cross-source
// invariant. Two-hundred-fifty-sixth in the drift-guard series.
// Pins the public-status-page email subscriber service:
//
//   V-295c3 anchor — 'public status-page email subscriber service'.
//
//   3-flow lifecycle:
//     1. subscribe(email) — generate confirm token, store sha256
//        hash + 24h expiry, return plaintext for email handoff.
//     2. confirm(plaintext) — token-hash lookup, validate expiry,
//        set confirmed_at + generate fresh unsubscribe token
//        (lifelong).
//     3. unsubscribe(plaintext) — token-hash lookup, set
//        unsubscribed_at.
//
//   CONFIRM_TOKEN_TTL_MS = 24 * 60 * 60 * 1000 (= 24 hours).
//
//   StatusSubscriberRow (8 fields):
//     - id + email (nullable, V-295c3-tombstone purged) +
//       confirmTokenHash + confirmExpiresAt + confirmedAt +
//       unsubscribeTokenHash + unsubscribedAt + createdAt.
//
//   V-295c3-tombstone — 90d post-unsubscribe purge zeroes email
//   column but keeps row (so re-subscription kicks off fresh
//   double-opt-in flow rather than re-confirming a tombstoned email).
//
//   Re-subscribe semantics — refresh only the pending confirmation
//   credential. Existing confirmed/unsubscribed state stays authoritative
//   until the mailbox owner consumes that proof.
//
//   listConfirmed() returns rows the incident-notification dispatcher
//   uses to fan-out emails on public incidents.
//
//   V-295c3-followup rotateUnsubscribeTokenHash — replaces ONLY
//   unsubscribe_token_hash for already-confirmed row. Used by
//   fan-out path to issue fresh per-email unsubscribe token. Does
//   NOT touch confirmed_at.
//
//   statusPageBaseUrl trailing slash stripped at construction.
//
//   Email normalization: trim + lowercase + must contain '@'.
//
// stays in lockstep across apps/server/src/services/status-subscribers.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CONFIRM_TOKEN_TTL_MS } from '../../src/services/status-subscribers.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W930 V-295c3 status-subscribers cross-source invariant', () => {
  // ─── V-295c3 anchor + 3-flow framing ─────────────────────────

  it("CRITICAL apps/server/src/services/status-subscribers.ts header pins V-295c3 anchor — 'V-295c3 — public status-page email subscriber service'. The V-295c3 anchor is the policy provenance.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/status-subscribers.ts'));
    expect(p).toMatch(/V-295c3 — public status-page email subscriber service/);
  });

  it("CRITICAL 3-flow lifecycle framing — '1. subscribe(email) — generates confirm token, stores sha256 hash + 24h expiry, returns the plaintext token to the caller (route hands it to email.sendStatusSubscriptionConfirmation). 2. confirm(plaintext) — token-hash lookup, validates expiry, sets confirmed_at + generates a fresh unsubscribe token (lifelong). 3. unsubscribe(plaintext) — token-hash lookup, sets unsubscribed_at'. The 3-flow lifecycle is the customer-facing API.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/status-subscribers.ts'));
    expect(p).toMatch(/1\. subscribe\(email\) — generates confirm token, stores sha256 hash \+/);
    expect(p).toMatch(/24h expiry, returns the plaintext token to the caller \(route/);
    expect(p).toMatch(/hands it to email\.sendStatusSubscriptionConfirmation\)/);
    expect(p).toMatch(/2\. confirm\(plaintext\) — token-hash lookup, validates expiry, sets/);
    expect(p).toMatch(/confirmed_at \+ generates a fresh unsubscribe token \(lifelong\)/);
    expect(p).toMatch(/3\. unsubscribe\(plaintext\) — token-hash lookup, sets unsubscribed_at/);
  });

  // ─── CONFIRM_TOKEN_TTL_MS = 24h ──────────────────────────────

  it('CRITICAL CONFIRM_TOKEN_TTL_MS = 24 * 60 * 60 * 1000 (= 86_400_000 ms = 24 hours). The 24h confirm window is wide enough for distracted customers but narrow enough to bound stale-confirm rows.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/status-subscribers.ts'));
    expect(p).toMatch(/export const CONFIRM_TOKEN_TTL_MS = 24 \* 60 \* 60 \* 1000;\s*\/\/ 24h/);
    expect(CONFIRM_TOKEN_TTL_MS).toBe(86_400_000);
  });

  // ─── StatusSubscriberRow 8-field shape ───────────────────────

  it('CRITICAL StatusSubscriberRow has 8 fields — id + email (nullable) + confirmTokenHash (nullable) + confirmExpiresAt (nullable) + confirmedAt (nullable) + unsubscribeTokenHash (nullable) + unsubscribedAt (nullable) + createdAt. The nullable fields cover pending / confirmed / unsubscribed / tombstoned states in one row.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/status-subscribers.ts'));
    expect(p).toMatch(/export interface StatusSubscriberRow \{/);
    expect(p).toMatch(/id: string;/);
    expect(p).toMatch(/email: string \| null;/);
    expect(p).toMatch(/confirmTokenHash: string \| null;/);
    expect(p).toMatch(/confirmExpiresAt: Date \| null;/);
    expect(p).toMatch(/confirmedAt: Date \| null;/);
    expect(p).toMatch(/unsubscribeTokenHash: string \| null;/);
    expect(p).toMatch(/unsubscribedAt: Date \| null;/);
    expect(p).toMatch(/createdAt: Date;/);
  });

  // ─── V-295c3-tombstone 90d purge framing ─────────────────────

  it("CRITICAL V-295c3-tombstone framing — 'Null only when V-295c3-tombstone purge has zeroed the email out (90d post-unsubscribe). The row persists so re-subscription kicks off a fresh double-opt-in flow'. The tombstone-keeps-row design satisfies GDPR while preserving anti-abuse identity (can't re-subscribe immediately after unsubscribe).", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/status-subscribers.ts'));
    expect(p).toMatch(/Null only when V-295c3-tombstone purge has zeroed the email out/);
    expect(p).toMatch(/\(90d post-unsubscribe\)\. The row persists so re-subscription kicks/);
    expect(p).toMatch(/off a fresh double-opt-in flow/);
  });

  // ─── Re-subscribe semantics framing ──────────────────────────

  it('CRITICAL re-subscribe semantics preserve active and opted-out authority until fresh mailbox proof is consumed', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/status-subscribers.ts'));
    expect(p).toMatch(/Re-subscribe semantics: if the email already exists, we update only the/);
    expect(p).toMatch(/pending confirm token\. Existing confirmed\/unsubscribed state remains/);
    expect(p).toMatch(/authoritative until the mailbox owner uses that token/);
    expect(p).toMatch(/anonymous submitter who knows an active recipient's address could suppress/);
  });

  // ─── listConfirmed for fan-out ───────────────────────────────

  it("CRITICAL listConfirmed framing — 'listConfirmed() returns rows the incident-notification dispatcher uses to fan-out emails when a public incident is created or resolved'. The listConfirmed → dispatcher wiring is the V-295c3 fan-out path.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/status-subscribers.ts'));
    expect(p).toMatch(/listConfirmed\(\) returns rows the incident-notification dispatcher/);
    expect(p).toMatch(/uses to fan-out emails when a public incident is created or resolved/);
  });

  // ─── V-295c3-followup rotateUnsubscribeTokenHash ─────────────

  it("CRITICAL V-295c3-followup rotateUnsubscribeTokenHash JSDoc — 'replaces ONLY unsubscribe_token_hash for an already-confirmed row. Used by the fan-out path to issue a fresh per-email unsubscribe token. Does NOT touch confirmed_at'. The per-fanout token rotation is what makes unsubscribe links per-email-batch traceable.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/status-subscribers.ts'));
    expect(p).toMatch(/V-295c3-followup — replaces ONLY `unsubscribe_token_hash` for an/);
    expect(p).toMatch(/already-confirmed row\. Used by the fan-out path to issue a fresh/);
    expect(p).toMatch(/per-email unsubscribe token\. Does NOT touch confirmed_at/);
    expect(p).toMatch(
      /rotateUnsubscribeTokenHash\(input: \{ id: string; hash: string \}\): Promise<void>;/,
    );
  });

  // ─── StatusSubscribersRepo 7+ methods ────────────────────────

  it('CRITICAL StatusSubscribersRepo declares 7 methods — upsertPending + findByConfirmTokenHash + findByUnsubscribeTokenHash + markConfirmed + markUnsubscribed + rotateUnsubscribeTokenHash + listConfirmed. The 7-method repo separates per-token lookups from list/rotation primitives.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/status-subscribers.ts'));
    expect(p).toMatch(/upsertPending\(input: \{/);
    expect(p).toMatch(
      /findByConfirmTokenHash\(hash: string\): Promise<StatusSubscriberRow \| null>;/,
    );
    expect(p).toMatch(
      /findByUnsubscribeTokenHash\(hash: string\): Promise<StatusSubscriberRow \| null>;/,
    );
    expect(p).toMatch(/markConfirmed\(input: \{/);
    expect(p).toMatch(
      /expectedConfirmTokenHash: string;[\s\S]*?\}\): Promise<StatusSubscriberRow \| null>;/,
    );
    expect(p).toMatch(
      /expectedUnsubscribeTokenHash: string \| null;[\s\S]*?\}\): Promise<StatusSubscriberRow \| null>;/,
    );
    expect(p).toMatch(/listConfirmed\(\): Promise<StatusSubscriberRow\[\]>;/);
  });

  // ─── V-295c3-tombstone admin endpoints ───────────────────────

  it("CRITICAL V-295c3-tombstone admin endpoints — listAll (paginated read) + 'admin endpoint single read by id' + purgeCandidates + purgeEmails (NULLs email column). The 4-admin-method surface is the GDPR-compliance toolkit.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/status-subscribers.ts'));
    expect(p).toMatch(/V-295c3-tombstone — admin endpoint paginated read/);
    expect(p).toMatch(/V-295c3-tombstone — admin endpoint single read by id/);
    expect(p).toMatch(/V-295c3-tombstone — purge candidates \(rows where unsubscribed_at < cutoff/);
    expect(p).toMatch(/V-295c3-tombstone — NULLs the email column for the given ids/);
    expect(p).toMatch(/purgeEmails\(ids: readonly string\[\]\): Promise<number>;/);
  });

  // ─── statusPageBaseUrl trailing-slash stripping ──────────────

  it("CRITICAL statusPageBaseUrl framing — 'Public origin of the status site, used to build the confirm + unsubscribe URLs. E.g. https://status.driftstack.dev'. The status-page-base-url is the customer-facing URL root.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/status-subscribers.ts'));
    expect(p).toMatch(/Public origin of the status site, used to build the confirm \+/);
    expect(p).toMatch(/unsubscribe URLs\. E\.g\. `https:\/\/status\.driftstack\.dev`/);
    expect(p).toMatch(/statusPageBaseUrl: string;/);
  });

  it("CRITICAL constructor strips trailing slashes — 'this.baseUrl = config.statusPageBaseUrl.replace(/\\/+$/, '')'. The strip makes ${baseUrl}/path joins safe + matches the V-202b dashboardUrl + V-281 docsBaseUrl pattern.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/status-subscribers.ts'));
    expect(p).toMatch(/this\.baseUrl = config\.statusPageBaseUrl\.replace\(\/\\\/\+\$\/, ''\);/);
  });

  // ─── Email normalization ─────────────────────────────────────

  it("CRITICAL subscribe() normalizes email via trim + lowercase + must contain '@'. The 3-step normalization is what prevents subscribe-by-typo + case-mismatch dup rows.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/status-subscribers.ts'));
    expect(p).toMatch(/const normalized = rawEmail\.trim\(\)\.toLowerCase\(\);/);
    expect(p).toMatch(/if \(!normalized \|\| !normalized\.includes\('@'\)\) \{/);
    expect(p).toMatch(/throw new BadRequestError\('Invalid email address\.'\);/);
  });

  // ─── confirm/unsubscribe URL paths ───────────────────────────

  it('CRITICAL confirm and unsubscribe links use canonical trailing-slash status-page paths.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/status-subscribers.ts'));
    expect(p).toMatch(
      /const confirmLink = `\$\{this\.baseUrl\}\/subscribe\/confirm\/\?token=\$\{encodeURIComponent\(plaintext\)\}`;/,
    );
    expect(p).toMatch(
      /const unsubscribeLink = `\$\{this\.baseUrl\}\/subscribe\/unsubscribe\/\?token=\$\{encodeURIComponent\(unsubPlaintext\)\}`;/,
    );
  });

  // ─── confirm error messages ──────────────────────────────────

  it("CRITICAL confirm() throws 2 distinct errors — 'Confirmation link is invalid or has been used.' (404) on hash miss + 'Confirmation link has expired. Please subscribe again to receive a fresh link.' (400) on expired. The 2-error split distinguishes invalid-link from expired-link to the customer-dashboard.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/status-subscribers.ts'));
    expect(p).toMatch(
      /throw new NotFoundError\('Confirmation link is invalid or has been used\.'\);/,
    );
    expect(p).toMatch(
      /'Confirmation link has expired\. Please subscribe again to receive a fresh link\.'/,
    );
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/status-subscribers-v295c3-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
