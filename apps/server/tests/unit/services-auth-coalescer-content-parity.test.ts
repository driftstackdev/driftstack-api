// W395.C — drift guard for apps/server/src/services/auth-coalescer.ts.
// V-012 / V-015 single-flight coalescer for the auth slow path. The
// 50–100ms scrypt verify at logN=15 was V-012's residual cold-start
// blip; this module collapses N concurrent cache-misses for the same
// plaintext to 1 scrypt call. Drift either removes the coalescing
// (cold-start blip returns under N-concurrent perf:sustained shape)
// or removes the .finally() cleanup (rejected promise stays in the
// map → next caller awaits failed promise → cascade fail; test-covered).
//
//   • V-012 / V-015 cold-start blip framing pinned.
//   • Pre-warming impossible: cache key is sha256(plaintext); plaintext
//     not stored anywhere server can read.
//   • Process-local (in-memory) only; cross-process needs distributed
//     lock (overkill for single-process server).
//   • Multi-process posture: each process owns its own coalescer; the
//     shared Redis cache absorbs across-process duplication.
//   • Lifecycle: first request kicks off slow path + stores Promise;
//     subsequent concurrent for same sha get same Promise (coalesce-
//     hit); .finally() removes from in-flight map on BOTH fulfilment
//     AND rejection.
//   • CoalescerStats: starts + hits + inFlight (3 counters).
//   • coalesce(sha, slowPath): existing → hits++ + return existing;
//     else starts++ + run slowPath + .finally(delete).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/services/auth-coalescer.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W395.C apps/server/src/services/auth-coalescer.ts content parity', () => {
  const body = read(LIB);

  it('Module framing pinned: single-flight on auth slow path, collapses N → 1 scrypt verify', () => {
    expect(body).toMatch(
      /Single-flight coalescer for the auth slow path\. When N concurrent\s*\/\/\s*requests arrive carrying the same plaintext API key and all miss the\s*\/\/\s*auth cache, only one runs the prefix lookup \+ scrypt verification \+\s*\/\/\s*account fetch; the other N−1 await the in-flight Promise and resolve\s*\/\/\s*with the same AccountContext/,
    );
  });

  it('V-012 / V-015 cold-start blip framing pinned + scrypt logN=15 cost note', () => {
    expect(body).toMatch(/Why this exists \(V-012 \/ V-015\):/);
    expect(body).toMatch(
      /The auth cache \(D-020\) is keyed on `sha256\(plaintext\)`\. On a cold\s*\/\/\s*cache the first request for a given plaintext misses and runs scrypt\s*\/\/\s*\(~50–100 ms at logN=15\)/,
    );
    expect(body).toMatch(
      /This was\s*\/\/\s*V-012's residual cold-start blip — documented but not fixed there/,
    );
  });

  it('Pre-warm-impossible framing pinned: sha256(plaintext) unkeyable since plaintext not stored', () => {
    expect(body).toMatch(
      /Pre-warming the cache from the api_keys table is impossible: the\s*\/\/\s*cache key is sha256\(plaintext\) and plaintext is not stored anywhere\s*\/\/\s*the server can read\./,
    );
    expect(body).toMatch(
      /Single-flight coalescing is the right shape:\s*\/\/\s*no design change to the cache, no security-model change to D-020,\s*\/\/\s*collapses N concurrent cold-misses to 1 scrypt call/,
    );
  });

  it('Process-local scope framing pinned + multi-process posture (shared Redis absorbs duplication)', () => {
    expect(body).toMatch(
      /Process-local \(in-memory\) only\. Not Redis-backed\. Cross-process\s*\/\/\s*coalescing would require a distributed lock, which is overkill for\s*\/\/\s*a single-process server/,
    );
    expect(body).toMatch(
      /If we ever scale to multi-process,\s*\/\/\s*each process gets its own coalescer; the shared Redis cache absorbs\s*\/\/\s*the across-process duplication/,
    );
  });

  it('Lifecycle framing pinned: .finally() removes from map on BOTH fulfilment AND rejection (test-covered)', () => {
    expect(body).toMatch(
      /The Promise is removed from the in-flight map on settlement —\s*\/\/\s*both fulfilment AND rejection — so a failed slow path doesn't\s*\/\/\s*poison future requests\. \(Without `\.finally\(\)`, a rejected promise\s*\/\/\s*stays in the map; the next caller awaits the rejected promise and\s*\/\/\s*errors out instead of retrying\. Test covered\.\)/,
    );
  });

  it('CoalescerStats: 3 counters (starts / hits / inFlight snapshot)', () => {
    expect(body).toMatch(/export interface CoalescerStats \{/);
    expect(body).toMatch(
      /Number of times a slow-path was started \(one per unique sha mid-flight\)\./,
    );
    expect(body).toMatch(/starts: number;/);
    expect(body).toMatch(
      /Number of times a concurrent caller piggybacked on an in-flight Promise\./,
    );
    expect(body).toMatch(/hits: number;/);
    expect(body).toMatch(/Current number of in-flight Promises \(snapshot\)\./);
    expect(body).toMatch(/inFlight: number;/);
  });

  it('AuthCoalescer class: private inFlight Map + startsCount/hitsCount + optional logger', () => {
    expect(body).toMatch(/export class AuthCoalescer \{/);
    expect(body).toMatch(
      /private readonly inFlight = new Map<string, Promise<AccountContext>>\(\);/,
    );
    expect(body).toMatch(/private startsCount = 0;/);
    expect(body).toMatch(/private hitsCount = 0;/);
    expect(body).toMatch(/constructor\(private readonly logger: Logger \| null = null\) \{\}/);
  });

  it('coalesce: existing → hits++ + return existing Promise (no new slow path)', () => {
    expect(body).toMatch(
      /Run `slowPath` if no other call for this sha is in flight; otherwise\s*\*\s*await the existing Promise\. Either way, resolves with the\s*\*\s*AccountContext from whichever call actually executed/,
    );
    expect(body).toMatch(
      /coalesce\(sha: string, slowPath: \(\) => Promise<AccountContext>\): Promise<AccountContext> \{\s*const existing = this\.inFlight\.get\(sha\);\s*if \(existing\) \{\s*this\.hitsCount \+= 1;/,
    );
    expect(body).toMatch(
      /this\.logger\?\.debug\(\{ shaPrefix: sha\.slice\(0, 8\) \}, 'auth coalesce hit'\);\s*return existing;/,
    );
  });

  it('coalesce: no existing → starts++ + slowPath().finally(delete) + set in-flight', () => {
    expect(body).toMatch(/this\.startsCount \+= 1;/);
    expect(body).toMatch(
      /const p = slowPath\(\)\.finally\(\(\) => \{\s*this\.inFlight\.delete\(sha\);\s*\}\);\s*this\.inFlight\.set\(sha, p\);\s*return p;/,
    );
  });

  it('stats(): snapshot of starts / hits / inFlight.size', () => {
    expect(body).toMatch(
      /stats\(\): CoalescerStats \{\s*return \{\s*starts: this\.startsCount,\s*hits: this\.hitsCount,\s*inFlight: this\.inFlight\.size,\s*\};\s*\}/,
    );
  });

  it('imports: Logger type + AccountContext type only', () => {
    expect(body).toMatch(/import type \{ Logger \} from '\.\.\/lib\/logger\.js';/);
    expect(body).toMatch(/import type \{ AccountContext \} from '\.\/auth\.js';/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
