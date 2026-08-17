// A transaction that reads and then writes must serialise concurrent callers.
//
// Wrapping a read-modify-write in `db.transaction` does NOT make it atomic.
// Postgres runs READ COMMITTED by default, so two concurrent transactions both
// see the same pre-state, both decide they are under the limit, and both write.
// Several methods here are exactly that shape — `insertSessionIfUnderLimit`,
// `createIfUnderActiveCap`, `insertEndpointIfUnderLimit`, `createIfUnderLimit` —
// and a tier cap that can be exceeded by racing two requests is an abuse and
// billing control that does not hold.
//
// They are all correct today, and the reason this file exists is that they are
// correct in FOUR different ways. Measured across the 43 transactions in
// apps/server/src:
//
//   pg_advisory_xact_lock   session + agent-session create, keyed per account so
//                           different accounts never contend; released on
//                           commit/rollback
//   SELECT … FOR UPDATE     the tier writers and token debits
//   ON CONFLICT             upserts that let the unique index arbitrate
//   DELETE … RETURNING      removeMemberWithInvites, where the delete IS the
//                           claim: null means another caller won
//
// Four idioms, no list of them anywhere, and each one looks like ordinary code
// to a reader who does not already know the hazard. The fifth cap-enforcing
// method is the one that gets written without any of them — it will pass every
// test, because the race needs concurrency to show and unit tests are
// sequential.
//
// SCOPE, measured rather than asserted, because it is narrower than the title
// suggests. This proves a serialiser was CHOSEN, not that it covers the read.
// Mutation-tested at the boundary:
//
//   caught     every serialiser removed from insertEndpointIfUnderLimit
//   caught     every serialiser removed from createIfUnderActiveCap
//   SURVIVED   the ACCOUNT advisory lock removed from insertSessionIfUnderLimit
//
// That last one is the honest limit. insertSessionIfUnderLimit takes two locks —
// per-account, then per-profile — and deleting the account lock leaves the
// profile lock in the body, so a presence check still sees `pg_advisory_xact_lock`
// while the cap it made atomic is now racy. Distinguishing them needs to know
// which lock covers which read, which is not a thing a source scan can decide.
//
// So: this stops the next cap-enforcing method being written with NO mechanism
// at all, which is the failure that actually happens. It will not catch a lock
// that is present but wrong. The correctness of individual locks is covered
// where they live — the profile single-session guard has its own cross-surface
// race tests.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '..', '..', 'src');

/** Recognised ways to serialise concurrent callers of a read-modify-write. */
const SERIALISERS = [
  'pg_advisory_xact_lock',
  '.for(',
  'FOR UPDATE',
  'onConflictDoNothing',
  'onConflictDoUpdate',
] as const;

/**
 * Read-modify-write transactions that deliberately do not serialise.
 *
 * `incidents.addUpdate` reads `resolved_at` to preserve an existing resolution
 * time, then writes. Two staff resolving the SAME incident in the same instant
 * could both read null and the later write wins — the cost is a resolution
 * timestamp off by milliseconds on a staff-only path. Recorded rather than
 * fixed, because the lock would be real complexity for that.
 */
const ACCEPTED_UNSERIALISED = new Map<string, string>([
  ['db/incidents-repo.ts:addUpdate', 'resolved_at preservation; staff-only, cost is a timestamp'],
]);

interface Tx {
  readonly file: string;
  readonly method: string;
  readonly body: string;
}

function matchBrace(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** Every `db.transaction(async (tx) => { … })` body in the server source. */
function transactions(): Tx[] {
  const out: Tx[] = [];
  for (const full of walk(SRC)) {
    const src = readFileSync(full, 'utf8');
    for (const m of src.matchAll(/\.transaction\(async \(\w+\) => \{/g)) {
      const open = src.indexOf('{', (m.index ?? 0) + '.transaction(async ('.length);
      const close = matchBrace(src, open);
      if (close === -1) continue;
      const head = src.slice(0, m.index);
      const methods = [...head.matchAll(/\n {2}(?:async )?(\w+)\(/g)];
      out.push({
        file: full.slice(SRC.length + 1),
        method: methods.at(-1)?.[1] ?? '?',
        body: src.slice(open, close + 1),
      });
    }
  }
  return out;
}

const readsThenWrites = (b: string): boolean =>
  /\.select\(/.test(b) && /\.(insert|update|delete)\(/.test(b);

const serialises = (b: string): boolean => SERIALISERS.some((s) => b.includes(s));

/** DELETE … RETURNING used as the claim: the delete itself decides the winner. */
const claimsByDeleteReturning = (b: string): boolean =>
  /\.delete\([\s\S]{0,400}?\.returning\(/.test(b);

describe('read-modify-write transactions serialise their callers', () => {
  const all = transactions();
  const rmw = all.filter((t) => readsThenWrites(t.body));

  it('CRITICAL the scan found transactions, so a green means checked', () => {
    // Without this, a change to how transactions are opened empties the
    // population and every check below passes having inspected nothing.
    expect(
      all.length,
      'no db.transaction blocks found — the scan is broken',
    ).toBeGreaterThanOrEqual(40);
    expect(
      rmw.length,
      'no read-modify-write transactions found — the shape this file is about',
    ).toBeGreaterThanOrEqual(8);
  });

  it('the detector detects — it must flag a bare count-then-insert and clear each idiom', () => {
    // Anti-vacuity on the INSTRUMENT. This check took three corrections before
    // it told the truth: it first recognised only FOR UPDATE, then missed
    // pg_advisory_xact_lock, then missed DELETE … RETURNING claims. A detector
    // that misses an idiom reports safe code as broken; one that misses the
    // BARE shape reports broken code as safe.
    const bare = `{ const [row] = await tx.select().from(t); if (row.n < 5) await tx.insert(t).values({}); }`;
    const advisory = `{ await tx.execute(sql\`SELECT pg_advisory_xact_lock(hashtext(\${k}))\`); const [r] = await tx.select().from(t); await tx.insert(t).values({}); }`;
    const forUpdate = `{ const [r] = await tx.select().from(t).for('update'); await tx.update(t).set({}); }`;
    const conflict = `{ const [r] = await tx.select().from(t); await tx.insert(t).values({}).onConflictDoNothing(); }`;
    const claim = `{ const [r] = await tx.delete(t).where(x).returning({ id: t.id }); const [a] = await tx.select().from(u); await tx.delete(u); }`;
    expect(serialises(bare) || claimsByDeleteReturning(bare)).toBe(false);
    expect(serialises(advisory)).toBe(true);
    expect(serialises(forUpdate)).toBe(true);
    expect(serialises(conflict)).toBe(true);
    expect(claimsByDeleteReturning(claim)).toBe(true);
  });

  it('CRITICAL every read-modify-write transaction serialises, or is a named exception', () => {
    const unserialised = rmw
      .filter((t) => !serialises(t.body) && !claimsByDeleteReturning(t.body))
      .map((t) => `${t.file}:${t.method}`)
      .filter((k) => !ACCEPTED_UNSERIALISED.has(k));
    expect(
      unserialised,
      'this transaction reads and then writes without an advisory lock, FOR UPDATE, an ON ' +
        'CONFLICT clause, or a DELETE … RETURNING claim. Wrapping it in a transaction is not ' +
        'enough — READ COMMITTED lets two concurrent callers both read the pre-state and both ' +
        'write, so a count-then-insert cap can be exceeded by racing two requests',
    ).toEqual([]);
  });

  it('CRITICAL the accepted-exception list may only shrink', () => {
    // An entry for a transaction that no longer exists, or that now serialises,
    // stops meaning "we decided this is fine" and starts meaning "nobody looked".
    const keys = new Set(rmw.map((t) => `${t.file}:${t.method}`));
    const stale = [...ACCEPTED_UNSERIALISED.keys()].filter((k) => !keys.has(k));
    expect(stale, 'an accepted-unserialised entry no longer matches a read-modify-write').toEqual(
      [],
    );
  });
});
