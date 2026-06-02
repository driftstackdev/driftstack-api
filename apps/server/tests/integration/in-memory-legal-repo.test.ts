// Behavioral guard for the InMemoryLegalRepo test double's
// latest-per-document tiebreaker.
//
// `latestAcceptancesForAccount` must pick the latest acceptance per
// (account, document_key). `acceptedAt` is not monotonic-unique — JS
// `Date` is millisecond-resolution, so two acceptances recorded in the
// same millisecond TIE. The double resolves that tie by `id DESC`
// (larger id wins), matching the Drizzle repo's
// `ORDER BY document_key, accepted_at DESC, id DESC`. Without the
// tiebreaker the result is insertion-order-dependent and can return the
// wrong (older) row as "latest" on a tie — the exact non-determinism
// this test pins shut.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemoryLegalRepo } from './_helpers/in-memory-legal-repo.js';

function accept(repo: InMemoryLegalRepo, version: string, contentHash: string) {
  return repo.recordAcceptance({
    accountId: 'acc-1',
    documentKey: 'tos',
    version,
    contentHash,
    acceptedFromIp: null,
    acceptedUserAgent: null,
  });
}

describe('InMemoryLegalRepo.latestAcceptancesForAccount tiebreaker', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves a same-millisecond tie deterministically by id (larger id wins)', async () => {
    // Freeze time so both acceptances share an identical acceptedAt — a
    // genuine tie that exercises the id tiebreaker, not the timestamp.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-02T00:00:00.000Z'));

    const repo = new InMemoryLegalRepo();
    const a = await accept(repo, '1.0.0', 'hash-a');
    const b = await accept(repo, '2.0.0', 'hash-b');

    // Confirm the tie is real (same acceptedAt to the millisecond).
    expect(a.acceptedAt.getTime()).toBe(b.acceptedAt.getTime());

    // The larger id must win — deterministically, regardless of which
    // random uuid sorted higher or which row was inserted first.
    const expectedWinner = a.id > b.id ? a : b;
    const latest = await repo.latestAcceptancesForAccount('acc-1');
    expect(latest.get('tos')?.id).toBe(expectedWinner.id);
    expect(latest.get('tos')?.version).toBe(expectedWinner.version);
  });

  it('honours acceptedAt ordering when timestamps differ (newer wins)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-02T00:00:00.000Z'));
    const repo = new InMemoryLegalRepo();
    const older = await accept(repo, '1.0.0', 'hash-old');
    vi.setSystemTime(new Date('2026-06-02T00:00:01.000Z'));
    const newer = await accept(repo, '2.0.0', 'hash-new');

    expect(newer.acceptedAt.getTime()).toBeGreaterThan(older.acceptedAt.getTime());
    const latest = await repo.latestAcceptancesForAccount('acc-1');
    expect(latest.get('tos')?.version).toBe('2.0.0');
  });
});
