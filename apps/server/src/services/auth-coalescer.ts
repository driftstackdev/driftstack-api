// Single-flight coalescer for the auth slow path. When N concurrent
// requests arrive carrying the same plaintext API key and all miss the
// auth cache, only one runs the prefix lookup + scrypt verification +
// account fetch; the other N−1 await the in-flight Promise and resolve
// with the same AccountContext.
//
// Why this exists (V-012 / V-015):
//   The auth cache (D-020) is keyed on `sha256(plaintext)`. On a cold
//   cache the first request for a given plaintext misses and runs scrypt
//   (~50–100 ms at logN=15). If 16 connections all start simultaneously
//   with the same plaintext (the perf:sustained smoke shape), all 16
//   miss the cache simultaneously, all 16 run scrypt in parallel, and
//   p99 captures the slowest of those concurrent verifies. This was
//   V-012's residual cold-start blip — documented but not fixed there.
//
//   Pre-warming the cache from the api_keys table is impossible: the
//   cache key is sha256(plaintext) and plaintext is not stored anywhere
//   the server can read. Single-flight coalescing is the right shape:
//   no design change to the cache, no security-model change to D-020,
//   collapses N concurrent cold-misses to 1 scrypt call.
//
// Scope:
//   Process-local (in-memory) only. Not Redis-backed. Cross-process
//   coalescing would require a distributed lock, which is overkill for
//   a single-process server and would re-introduce the latency the
//   coalescer is supposed to remove. If we ever scale to multi-process,
//   each process gets its own coalescer; the shared Redis cache absorbs
//   the across-process duplication.
//
// Lifecycle:
//   - On the first request for a sha, the coalescer kicks off the slow
//     path and stores the Promise.
//   - Subsequent concurrent requests for the same sha return the same
//     Promise (counted as a coalesce-hit).
//   - The Promise is removed from the in-flight map on settlement —
//     both fulfilment AND rejection — so a failed slow path doesn't
//     poison future requests. (Without `.finally()`, a rejected promise
//     stays in the map; the next caller awaits the rejected promise and
//     errors out instead of retrying. Test covered.)

import type { Logger } from '../lib/logger.js';
import type { AccountContext } from './auth.js';

export interface CoalescerStats {
  /** Number of times a slow-path was started (one per unique sha mid-flight). */
  starts: number;
  /** Number of times a concurrent caller piggybacked on an in-flight Promise. */
  hits: number;
  /** Current number of in-flight Promises (snapshot). */
  inFlight: number;
}

export class AuthCoalescer {
  private readonly inFlight = new Map<string, Promise<AccountContext>>();
  private startsCount = 0;
  private hitsCount = 0;

  constructor(private readonly logger: Logger | null = null) {}

  /**
   * Run `slowPath` if no other call for this sha is in flight; otherwise
   * await the existing Promise. Either way, resolves with the
   * AccountContext from whichever call actually executed.
   */
  coalesce(sha: string, slowPath: () => Promise<AccountContext>): Promise<AccountContext> {
    const existing = this.inFlight.get(sha);
    if (existing) {
      this.hitsCount += 1;
      this.logger?.debug({ shaPrefix: sha.slice(0, 8) }, 'auth coalesce hit');
      return existing;
    }
    this.startsCount += 1;
    const p = slowPath().finally(() => {
      this.inFlight.delete(sha);
    });
    this.inFlight.set(sha, p);
    return p;
  }

  stats(): CoalescerStats {
    return {
      starts: this.startsCount,
      hits: this.hitsCount,
      inFlight: this.inFlight.size,
    };
  }
}
