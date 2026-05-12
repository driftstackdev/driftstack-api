// W447.B — drift guard for apps/server/src/db/status-subscribers-repo.ts.
// V-295c3 StatusSubscribersRepo. Drift here either drops the
// double-opt-in reset on re-subscribe (previously-unsubscribed
// user re-confirms without fresh email click → bypass) or breaks
// the V-295c3-tombstone purge contract (email NULL + tokens
// cleared so the row preserves audit shape without retaining PII).
//
//   • V-295c3 framing pinned.
//   • toRow: 8-field StatusSubscriberRow (email + confirm/
//     unsubscribe token hashes + 3 timestamps).
//   • upsertPending framing pinned: INSERT ... ON CONFLICT (email)
//     DO UPDATE — re-subscribe path RESETS confirmation state
//     (confirmedAt:null, unsubscribeTokenHash:null, unsubscribedAt:
//     null) so previously-unsubscribed user starts FRESH
//     double-opt-in.
//   • findByConfirmTokenHash + findByUnsubscribeTokenHash: limit 1
//     lookups.
//   • markConfirmed: clears confirm fields + sets unsubscribeTokenHash
//     for future opt-out + resets unsubscribedAt.
//   • markUnsubscribed: sets unsubscribedAt only.
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

  it("upsertPending framing pinned: 'INSERT ... ON CONFLICT (email) DO UPDATE — re-subscribe path resets confirmation state. Drizzle's onConflictDoUpdate covers this without a separate select.'", () => {
    expect(body).toMatch(
      /\/\/ INSERT \.\.\. ON CONFLICT \(email\) DO UPDATE — re-subscribe path\s*\n?\s*\/\/ resets confirmation state\. Drizzle's onConflictDoUpdate covers\s*\n?\s*\/\/ this without a separate select\./,
    );
  });

  it("upsertPending: insert values seed (email + confirmTokenHash + confirmExpiresAt + null on confirmedAt/unsubscribeTokenHash/unsubscribedAt); onConflict reset comment 'Reset confirmation state on re-subscribe so a previously unsubscribed user starts a fresh double-opt-in.'", () => {
    expect(body).toMatch(
      /\.values\(\{\s*\n?\s*email: input\.email,\s*\n?\s*confirmTokenHash: input\.confirmTokenHash,\s*\n?\s*confirmExpiresAt: input\.confirmExpiresAt,\s*\n?\s*confirmedAt: null,\s*\n?\s*unsubscribeTokenHash: null,\s*\n?\s*unsubscribedAt: null,\s*\n?\s*\}\)/,
    );
    expect(body).toMatch(
      /\/\/ Reset confirmation state on re-subscribe so a previously\s*\n?\s*\/\/ unsubscribed user starts a fresh double-opt-in\./,
    );
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

  it('markConfirmed: clears confirmTokenHash + confirmExpiresAt; sets new unsubscribeTokenHash; resets unsubscribedAt null; returning() + throws on no-row', () => {
    expect(body).toMatch(
      /\.set\(\{\s*\n?\s*confirmedAt: input\.confirmedAt,\s*\n?\s*confirmTokenHash: null,\s*\n?\s*confirmExpiresAt: null,\s*\n?\s*unsubscribeTokenHash: input\.unsubscribeTokenHash,\s*\n?\s*unsubscribedAt: null,\s*\n?\s*\}\)/,
    );
    expect(body).toMatch(
      /if \(!row\) throw new Error\('status_subscribers markConfirmed returned no row'\);/,
    );
  });

  it('markUnsubscribed sets unsubscribedAt only; rotateUnsubscribeTokenHash sets unsubscribeTokenHash only', () => {
    expect(body).toMatch(
      /\.set\(\{ unsubscribedAt: input\.unsubscribedAt \}\)\s*\n?\s*\.where\(eq\(statusSubscribers\.id, input\.id\)\)\s*\n?\s*\.returning\(\);/,
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

  it("purgeEmails framing pinned: empty early-return; sets email:null + clear confirmTokenHash/confirmExpiresAt/unsubscribeTokenHash; comment 'Clear the tokens too — they're all derivative of the email.'; inArray batched returning {id}; returns result.length", () => {
    expect(body).toMatch(
      /async purgeEmails\(ids: readonly string\[\]\): Promise<number> \{\s*\n?\s*if \(ids\.length === 0\) return 0;/,
    );
    expect(body).toMatch(
      /\.set\(\{\s*\n?\s*email: null,\s*\n?\s*\/\/ Clear the tokens too — they're all derivative of the email\.\s*\n?\s*confirmTokenHash: null,\s*\n?\s*confirmExpiresAt: null,\s*\n?\s*unsubscribeTokenHash: null,\s*\n?\s*\}\)\s*\n?\s*\.where\(inArray\(statusSubscribers\.id, \[\.\.\.ids\]\)\)\s*\n?\s*\.returning\(\{ id: statusSubscribers\.id \}\);\s*\n?\s*return result\.length;/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
