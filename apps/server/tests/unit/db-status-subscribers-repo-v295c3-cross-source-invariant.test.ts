// W1012 — db/status-subscribers-repo V-295c3 cross-source invariant.
// Three-hundred-thirty-eighth in the drift-guard series. Pins the
// apps/server/src/db/status-subscribers-repo.ts double-opt-in repo:
//
//   V-295c3 anchor — 'V-295c3 — Drizzle-backed StatusSubscribersRepo'.
//
//   9-method DrizzleStatusSubscribersRepo — upsertPending +
//     findByConfirmTokenHash + findByUnsubscribeTokenHash +
//     markConfirmed + markUnsubscribed + rotateUnsubscribeTokenHash
//     + listConfirmed + listAll + getById + listPurgeCandidates +
//     purgeEmails.
//
//   upsertPending framing — 'INSERT ... ON CONFLICT (email) DO
//   UPDATE — re-subscribe path resets confirmation state. Drizzle's
//   onConflictDoUpdate covers this without a separate select'.
//
//   upsertPending re-subscribe-reset framing — 'Reset confirmation
//   state on re-subscribe so a previously unsubscribed user starts a
//   fresh double-opt-in'.
//
//   upsertPending onConflictDoUpdate target = email; SET clears 3
//     state fields (confirmedAt + unsubscribeTokenHash +
//     unsubscribedAt → null) + sets 2 fresh-confirm fields
//     (confirmTokenHash + confirmExpiresAt).
//
//   markConfirmed 5-field SET — confirmedAt + confirmTokenHash:null
//     + confirmExpiresAt:null + unsubscribeTokenHash + unsubscribedAt:
//     null. The 'clear-tokens-after-use' design + V-295c3 unsubscribe-
//     token issuance happens here.
//
//   listConfirmed filter — and(isNotNull(confirmedAt), isNull
//     (unsubscribedAt)). The confirmed-and-not-unsubscribed cohort
//     is who actually receives broadcasts.
//
//   listPurgeCandidates — and(lt(unsubscribedAt, cutoff), isNotNull
//     (email)). The GDPR retention sweep filters unsubscribed-past-
//     cutoff rows that still hold an email.
//
//   purgeEmails framing — 'Clear the tokens too — they're all
//     derivative of the email'. 4-field SET → null (email +
//     confirmTokenHash + confirmExpiresAt + unsubscribeTokenHash).
//
//   purgeEmails early-return on empty ids — 'if (ids.length === 0)
//     return 0'.
//
//   toRow 8-field shape — id + email + confirmTokenHash +
//     confirmExpiresAt + confirmedAt + unsubscribeTokenHash +
//     unsubscribedAt + createdAt.
//
// stays in lockstep across apps/server/src/db/status-subscribers-repo.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W1012 db/status-subscribers-repo V-295c3 cross-source invariant', () => {
  it("CRITICAL V-295c3 anchor — 'V-295c3 — Drizzle-backed StatusSubscribersRepo'.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/status-subscribers-repo.ts'));
    expect(p).toMatch(/\/\/ V-295c3 — Drizzle-backed StatusSubscribersRepo\./);
    expect(p).toMatch(
      /export class DrizzleStatusSubscribersRepo implements StatusSubscribersRepo \{/,
    );
  });

  it("CRITICAL upsertPending re-subscribe framing — 'INSERT ... ON CONFLICT (email) DO UPDATE — re-subscribe path resets confirmation state. Drizzle's onConflictDoUpdate covers this without a separate select'.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/status-subscribers-repo.ts'));
    expect(p).toMatch(/\/\/ INSERT \.\.\. ON CONFLICT \(email\) DO UPDATE — re-subscribe path/);
    expect(p).toMatch(/\/\/ resets confirmation state\. Drizzle's onConflictDoUpdate covers/);
    expect(p).toMatch(/\/\/ this without a separate select\./);
  });

  it("CRITICAL upsertPending reset-state framing — 'Reset confirmation state on re-subscribe so a previously unsubscribed user starts a fresh double-opt-in'.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/status-subscribers-repo.ts'));
    expect(p).toMatch(/\/\/ Reset confirmation state on re-subscribe so a previously/);
    expect(p).toMatch(/\/\/ unsubscribed user starts a fresh double-opt-in\./);
  });

  it('CRITICAL upsertPending onConflictDoUpdate target=email + SET 3-null + 2-fresh fields.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/status-subscribers-repo.ts'));
    expect(p).toMatch(/target: statusSubscribers\.email,/);
    expect(p).toMatch(/confirmTokenHash: input\.confirmTokenHash,/);
    expect(p).toMatch(/confirmExpiresAt: input\.confirmExpiresAt,/);
    expect(p).toMatch(/confirmedAt: null,/);
    expect(p).toMatch(/unsubscribeTokenHash: null,/);
    expect(p).toMatch(/unsubscribedAt: null,/);
  });

  it('CRITICAL markConfirmed 5-field SET — confirmedAt + confirmTokenHash:null + confirmExpiresAt:null + unsubscribeTokenHash + unsubscribedAt:null. Clear-after-use + issue-unsubscribe-token design.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/status-subscribers-repo.ts'));
    expect(p).toMatch(/confirmedAt: input\.confirmedAt,/);
    expect(p).toMatch(/confirmTokenHash: null,/);
    expect(p).toMatch(/confirmExpiresAt: null,/);
    expect(p).toMatch(/unsubscribeTokenHash: input\.unsubscribeTokenHash,/);
    expect(p).toMatch(/unsubscribedAt: null,/);
  });

  it('CRITICAL listConfirmed filter — and(isNotNull(confirmedAt), isNull(unsubscribedAt)). The confirmed-and-not-unsubscribed cohort is the broadcast audience.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/status-subscribers-repo.ts'));
    expect(p).toMatch(
      /and\(isNotNull\(statusSubscribers\.confirmedAt\), isNull\(statusSubscribers\.unsubscribedAt\)\)/,
    );
  });

  it('CRITICAL listPurgeCandidates filter — and(lt(unsubscribedAt, cutoff), isNotNull(email)). GDPR retention sweep — unsubscribed past cutoff with email still set.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/status-subscribers-repo.ts'));
    expect(p).toMatch(
      /and\(lt\(statusSubscribers\.unsubscribedAt, cutoff\), isNotNull\(statusSubscribers\.email\)\)/,
    );
  });

  it("CRITICAL purgeEmails framing — 'Clear the tokens too — they're all derivative of the email'. 4-field NULL SET + early-return on empty ids.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/status-subscribers-repo.ts'));
    expect(p).toMatch(/if \(ids\.length === 0\) return 0;/);
    expect(p).toMatch(/email: null,/);
    expect(p).toMatch(/\/\/ Clear the tokens too — they're all derivative of the email\./);
    expect(p).toMatch(/confirmTokenHash: null,/);
    expect(p).toMatch(/confirmExpiresAt: null,/);
    expect(p).toMatch(/unsubscribeTokenHash: null,/);
    expect(p).toMatch(/\.where\(inArray\(statusSubscribers\.id, \[\.\.\.ids\]\)\)/);
    expect(p).toMatch(/return result\.length;/);
  });

  it('CRITICAL toRow 8-field shape — id + email + confirmTokenHash + confirmExpiresAt + confirmedAt + unsubscribeTokenHash + unsubscribedAt + createdAt.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/status-subscribers-repo.ts'));
    expect(p).toMatch(/function toRow\(row: DbRow\): StatusSubscriberRow \{/);
    expect(p).toMatch(/id: row\.id,/);
    expect(p).toMatch(/email: row\.email,/);
    expect(p).toMatch(/confirmTokenHash: row\.confirmTokenHash,/);
    expect(p).toMatch(/confirmExpiresAt: row\.confirmExpiresAt,/);
    expect(p).toMatch(/confirmedAt: row\.confirmedAt,/);
    expect(p).toMatch(/unsubscribeTokenHash: row\.unsubscribeTokenHash,/);
    expect(p).toMatch(/unsubscribedAt: row\.unsubscribedAt,/);
    expect(p).toMatch(/createdAt: row\.createdAt,/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/db-status-subscribers-repo-v295c3-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
