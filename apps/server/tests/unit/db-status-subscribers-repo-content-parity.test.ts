// W447.B — drift guard for apps/server/src/db/status-subscribers-repo.ts.
// V-295c3 StatusSubscribersRepo. Drift here can let anonymous
// re-subscribe suppress an active recipient, reactivate an opted-out
// recipient without proof, permit token replay, or break
// the V-295c3-tombstone purge contract (email NULL + tokens
// cleared so the row preserves audit shape without retaining PII).
//
//   • V-295c3 framing pinned.
//   • toRow: 8-field StatusSubscriberRow (email + confirm/
//     unsubscribe token hashes + 3 timestamps).
//   • upsertPending conflict updates only pending proof fields; current
//     confirmation, unsubscribe credential, and opt-out stay authoritative.
//   • findByConfirmTokenHash + findByUnsubscribeTokenHash: limit 1
//     lookups.
//   • markConfirmed/markUnsubscribed bind updates to the presented token hash
//     and return null when a concurrent caller has replaced/consumed it.
//   • rotateUnsubscribeTokenHash: per-email rotation.
//   • listConfirmed: where and(isNotNull(confirmedAt), isNull
//     (unsubscribedAt)) — active confirmed only.
//   • listPurgeCandidates: where and(lt(unsubscribedAt, cutoff),
//     isNotNull(email)) — purge candidates have non-null email
//     (haven't been purged yet).
//   • purgeEmails framing pinned: email NULL + clear all tokens
//     (derivative of email); inArray batched; empty early-return.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/db/status-subscribers-repo.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W447.B apps/server/src/db/status-subscribers-repo.ts content parity', () => {
  const body = read(LIB);

  it("V-295c3 framing pinned: 'Drizzle-backed StatusSubscribersRepo.'", () => {
    expect(body).toMatch(/\/\/ V-295c3 — Drizzle-backed StatusSubscribersRepo\./);
  });

  it('imports: and/desc/eq/inArray/isNotNull/isNull/lt from drizzle-orm; StatusSubscriberRow/Repo from services; Database; statusSubscribers schema', () => {
    expect(body).toMatch(
      /import \{ and, desc, eq, inArray, isNotNull, isNull, lt \} from 'drizzle-orm';/,
    );
    expect(body).toMatch(
      /import type \{ StatusSubscriberRow, StatusSubscribersRepo \} from '\.\.\/services\/status-subscribers\.js';/,
    );
    expect(body).toMatch(/import \{ statusSubscribers \} from '\.\/schema\.js';/);
  });

  it('toRow: 8-field StatusSubscriberRow (id + email + confirmTokenHash + confirmExpiresAt + confirmedAt + unsubscribeTokenHash + unsubscribedAt + createdAt)', () => {
    expect(body).toMatch(
      /function toRow\(row: DbRow\): StatusSubscriberRow \{\s*\n?\s*return \{\s*\n?\s*id: row\.id,\s*\n?\s*email: row\.email,\s*\n?\s*confirmTokenHash: row\.confirmTokenHash,\s*\n?\s*confirmExpiresAt: row\.confirmExpiresAt,\s*\n?\s*confirmedAt: row\.confirmedAt,\s*\n?\s*unsubscribeTokenHash: row\.unsubscribeTokenHash,\s*\n?\s*unsubscribedAt: row\.unsubscribedAt,\s*\n?\s*createdAt: row\.createdAt,\s*\n?\s*\};\s*\n?\s*\}/,
    );
  });

  it('upsertPending framing pins anonymous refresh to pending proof only', () => {
    expect(body).toMatch(
      /\/\/ INSERT \.\.\. ON CONFLICT \(email\) DO UPDATE — re-subscribe refreshes only\s*\n?\s*\/\/ the pending proof\. Preserve confirmed\/unsubscribed authority until the/,
    );
  });

  it('upsertPending seeds a new row, while conflict SET contains only fresh confirmation fields', () => {
    expect(body).toMatch(
      /\.values\(\{\s*\n?\s*email: input\.email,\s*\n?\s*confirmTokenHash: input\.confirmTokenHash,\s*\n?\s*confirmExpiresAt: input\.confirmExpiresAt,\s*\n?\s*confirmedAt: null,\s*\n?\s*unsubscribeTokenHash: null,\s*\n?\s*unsubscribedAt: null,\s*\n?\s*\}\)/,
    );
    expect(body).toMatch(
      /set: \{\s*\n?\s*confirmTokenHash: input\.confirmTokenHash,\s*\n?\s*confirmExpiresAt: input\.confirmExpiresAt,\s*\n?\s*\},/,
    );
    expect(body).not.toMatch(/set: \{[^}]*confirmedAt: null/s);
    expect(body).not.toMatch(/set: \{[^}]*unsubscribeTokenHash: null/s);
    expect(body).not.toMatch(/set: \{[^}]*unsubscribedAt: null/s);
    expect(body).toMatch(
      /if \(!row\) throw new Error\('status_subscribers upsert returned no row'\);/,
    );
  });

  it('findByConfirmTokenHash + findByUnsubscribeTokenHash: each are limit 1 lookups on their respective token hash column', () => {
    expect(body).toMatch(
      /async findByConfirmTokenHash\(hash: string\): Promise<StatusSubscriberRow \| null> \{\s*\n?\s*const \[row\] = await this\.database\.db\s*\n?\s*\.select\(\)\s*\n?\s*\.from\(statusSubscribers\)\s*\n?\s*\.where\(eq\(statusSubscribers\.confirmTokenHash, hash\)\)\s*\n?\s*\.limit\(1\);\s*\n?\s*return row \? toRow\(row\) : null;\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /async findByUnsubscribeTokenHash\(hash: string\): Promise<StatusSubscriberRow \| null> \{\s*\n?\s*const \[row\] = await this\.database\.db\s*\n?\s*\.select\(\)\s*\n?\s*\.from\(statusSubscribers\)\s*\n?\s*\.where\(eq\(statusSubscribers\.unsubscribeTokenHash, hash\)\)\s*\n?\s*\.limit\(1\);\s*\n?\s*return row \? toRow\(row\) : null;\s*\n?\s*\}/,
    );
  });

  it('markConfirmed atomically consumes the expected hash and returns null to a loser', () => {
    expect(body).toMatch(
      /\.set\(\{\s*\n?\s*confirmedAt: input\.confirmedAt,\s*\n?\s*confirmTokenHash: null,\s*\n?\s*confirmExpiresAt: null,\s*\n?\s*unsubscribeTokenHash: input\.unsubscribeTokenHash,\s*\n?\s*unsubscribedAt: null,\s*\n?\s*\}\)/,
    );
    expect(body).toMatch(
      /eq\(statusSubscribers\.id, input\.id\),\s*\n?\s*eq\(statusSubscribers\.confirmTokenHash, input\.expectedConfirmTokenHash\)/,
    );
    expect(body).toMatch(/return row \? toRow\(row\) : null;/);
  });

  it('markUnsubscribed supports exact-hash public CAS and explicit admin id-only authority; rotation touches only its token', () => {
    expect(body).toMatch(
      /input\.expectedUnsubscribeTokenHash === null\s*\n?\s*\? eq\(statusSubscribers\.id, input\.id\)\s*\n?\s*: and\(\s*\n?\s*eq\(statusSubscribers\.id, input\.id\),\s*\n?\s*eq\(statusSubscribers\.unsubscribeTokenHash, input\.expectedUnsubscribeTokenHash\)/,
    );
    expect(body).toMatch(
      /\.set\(\{ unsubscribedAt: input\.unsubscribedAt \}\)\s*\n?\s*\.where\(predicate\)\s*\n?\s*\.returning\(\);/,
    );
    expect(body).toMatch(
      /async rotateUnsubscribeTokenHash\(input: \{ id: string; hash: string \}\): Promise<void> \{\s*\n?\s*await this\.database\.db\s*\n?\s*\.update\(statusSubscribers\)\s*\n?\s*\.set\(\{ unsubscribeTokenHash: input\.hash \}\)\s*\n?\s*\.where\(eq\(statusSubscribers\.id, input\.id\)\);\s*\n?\s*\}/,
    );
  });

  it('listConfirmed: where and(isNotNull(confirmedAt), isNull(unsubscribedAt)) — active confirmed only', () => {
    expect(body).toMatch(
      /async listConfirmed\(\): Promise<StatusSubscriberRow\[\]> \{\s*\n?\s*const rows = await this\.database\.db\s*\n?\s*\.select\(\)\s*\n?\s*\.from\(statusSubscribers\)\s*\n?\s*\.where\(\s*\n?\s*and\(isNotNull\(statusSubscribers\.confirmedAt\), isNull\(statusSubscribers\.unsubscribedAt\)\),\s*\n?\s*\);\s*\n?\s*return rows\.map\(toRow\);\s*\n?\s*\}/,
    );
  });

  it('listAll: orderBy desc(createdAt) + limit + offset for admin pagination; getById limit 1 lookup', () => {
    expect(body).toMatch(
      /async listAll\(opts: \{ limit: number; offset: number \}\): Promise<StatusSubscriberRow\[\]> \{\s*\n?\s*const rows = await this\.database\.db\s*\n?\s*\.select\(\)\s*\n?\s*\.from\(statusSubscribers\)\s*\n?\s*\.orderBy\(desc\(statusSubscribers\.createdAt\)\)\s*\n?\s*\.limit\(opts\.limit\)\s*\n?\s*\.offset\(opts\.offset\);\s*\n?\s*return rows\.map\(toRow\);\s*\n?\s*\}/,
    );
  });

  it("listPurgeCandidates: where and(lt(unsubscribedAt, cutoff), isNotNull(email)) — V-295c3-tombstone candidates have non-null email (haven't been purged yet)", () => {
    expect(body).toMatch(
      /async listPurgeCandidates\(cutoff: Date\): Promise<StatusSubscriberRow\[\]> \{\s*\n?\s*const rows = await this\.database\.db\s*\n?\s*\.select\(\)\s*\n?\s*\.from\(statusSubscribers\)\s*\n?\s*\.where\(and\(lt\(statusSubscribers\.unsubscribedAt, cutoff\), isNotNull\(statusSubscribers\.email\)\)\);\s*\n?\s*return rows\.map\(toRow\);\s*\n?\s*\}/,
    );
  });

  it("purgeEmails framing pinned: empty early-return; chunked; sets email:null + clear confirmTokenHash/confirmExpiresAt/unsubscribeTokenHash; comment 'Clear the tokens too — they're all derivative of the email.'; inArray per chunk returning {id}; sums the counts", () => {
    expect(body).toMatch(
      /async purgeEmails\(ids: readonly string\[\]\): Promise<number> \{\s*\n?\s*if \(ids\.length === 0\) return 0;/,
    );
    expect(body).toMatch(
      /\.set\(\{\s*\n?\s*email: null,\s*\n?\s*\/\/ Clear the tokens too — they're all derivative of the email\.\s*\n?\s*confirmTokenHash: null,\s*\n?\s*confirmExpiresAt: null,\s*\n?\s*unsubscribeTokenHash: null,\s*\n?\s*\}\)\s*\n?\s*\.where\(inArray\(statusSubscribers\.id, chunk\)\)\s*\n?\s*\.returning\(\{ id: statusSubscribers\.id \}\);/,
    );
    // The four NULLed columns are the privacy property and stay pinned above.
    // What changed is the statement count: processPurge selects every row past
    // the cutoff with no limit, so binding them all threw past 65534 ids and
    // the 90-day erasure never ran. Chunking is now the load-bearing part.
    expect(body).toMatch(/for \(const chunk of chunkIds\(ids\)\)/);
    expect(body).toMatch(/purged \+= result\.length;/);
    expect(body).toMatch(/from '\.\/chunk-ids\.js'/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
