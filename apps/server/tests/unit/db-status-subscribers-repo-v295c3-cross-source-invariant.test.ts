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
//   upsertPending conflict SET refreshes only confirmTokenHash +
//     confirmExpiresAt. It preserves confirmation/unsubscribe authority.
//
//   markConfirmed exact-hash CAS + 5-field SET — confirmedAt + confirmTokenHash:null
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

  it('CRITICAL upsertPending framing preserves current authority during pending proof refresh', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/status-subscribers-repo.ts'));
    expect(p).toMatch(
      /\/\/ INSERT \.\.\. ON CONFLICT \(email\) DO UPDATE — re-subscribe refreshes only/,
    );
    expect(p).toMatch(
      /\/\/ the pending proof\. Preserve confirmed\/unsubscribed authority until the/,
    );
    expect(p).toMatch(/\/\/ mailbox owner consumes that proof/);
  });

  it('CRITICAL upsertPending conflict SET has exactly the two pending-proof fields', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/status-subscribers-repo.ts'));
    expect(p).toMatch(/target: statusSubscribers\.email,/);
    expect(p).toMatch(/confirmTokenHash: input\.confirmTokenHash,/);
    expect(p).toMatch(/confirmExpiresAt: input\.confirmExpiresAt,/);
    expect(p).toMatch(
      /set: \{\s*\n?\s*confirmTokenHash: input\.confirmTokenHash,\s*\n?\s*confirmExpiresAt: input\.confirmExpiresAt,\s*\n?\s*\},/,
    );
    expect(p).not.toMatch(/set: \{[^}]*confirmedAt: null/s);
    expect(p).not.toMatch(/set: \{[^}]*unsubscribeTokenHash: null/s);
    expect(p).not.toMatch(/set: \{[^}]*unsubscribedAt: null/s);
  });

  it('CRITICAL markConfirmed exact-hash CAS + 5-field state transition', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/status-subscribers-repo.ts'));
    expect(p).toMatch(/confirmedAt: input\.confirmedAt,/);
    expect(p).toMatch(/confirmTokenHash: null,/);
    expect(p).toMatch(/confirmExpiresAt: null,/);
    expect(p).toMatch(/unsubscribeTokenHash: input\.unsubscribeTokenHash,/);
    expect(p).toMatch(/unsubscribedAt: null,/);
    expect(p).toMatch(/eq\(statusSubscribers\.confirmTokenHash, input\.expectedConfirmTokenHash\)/);
    expect(p).toMatch(/return row \? toRow\(row\) : null;/);
  });

  it('CRITICAL markUnsubscribed binds public transitions to the exact current token hash', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/status-subscribers-repo.ts'));
    expect(p).toMatch(/expectedUnsubscribeTokenHash: string \| null;/);
    expect(p).toMatch(
      /eq\(statusSubscribers\.unsubscribeTokenHash, input\.expectedUnsubscribeTokenHash\)/,
    );
    expect(p).toMatch(/\.where\(predicate\)/);
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
    // Chunked since the bind-parameter ceiling fix: processPurge has no limit,
    // so an unbounded backlog made a single statement throw and the erasure
    // never happened. The four NULLed columns above are the privacy property;
    // this is what makes it reachable at scale.
    expect(p).toMatch(/\.where\(inArray\(statusSubscribers\.id, chunk\)\)/);
    expect(p).toMatch(/for \(const chunk of chunkIds\(ids\)\)/);
    expect(p).toMatch(/purged \+= result\.length;/);
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
