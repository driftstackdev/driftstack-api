// V-553.B-23 — unit tests for AuthCoalescer (V-015).
//
// Surface under test:
//   - coalesce(): first call for a sha runs the slow path; concurrent
//     calls for the same sha share the in-flight Promise and count as
//     hits; settled Promises are removed from the in-flight map so the
//     next call after settlement runs the slow path again
//   - rejection cleanup: a rejected slow path is removed from the map
//     (no permanent poisoning of subsequent retries)
//   - stats(): starts / hits / inFlight tracked accurately

import { describe, expect, it } from 'vitest';
import { AuthCoalescer } from '../../src/services/auth-coalescer.js';
import type { AccountContext } from '../../src/services/auth.js';

function ctx(label: string): AccountContext {
  return { account: { id: label } } as unknown as AccountContext;
}

describe('V-553.B-23 AuthCoalescer.coalesce — single-flight semantics', () => {
  it('runs the slow path exactly once when N concurrent calls share a sha', async () => {
    const coalescer = new AuthCoalescer();
    let slowPathInvocations = 0;
    let resolveSlow!: (v: AccountContext) => void;
    const slowPath = (): Promise<AccountContext> => {
      slowPathInvocations += 1;
      return new Promise<AccountContext>((resolve) => {
        resolveSlow = resolve;
      });
    };
    const a = coalescer.coalesce('sha_x', slowPath);
    const b = coalescer.coalesce('sha_x', slowPath);
    const c = coalescer.coalesce('sha_x', slowPath);
    expect(slowPathInvocations).toBe(1);

    resolveSlow(ctx('shared'));
    const [ra, rb, rc] = await Promise.all([a, b, c]);
    // All three callers see the same AccountContext object.
    expect(ra.account.id).toBe('shared');
    expect(rb).toBe(ra);
    expect(rc).toBe(ra);
  });

  it('runs the slow path again on the next call after settlement', async () => {
    const coalescer = new AuthCoalescer();
    let invocations = 0;
    const slowPath = (): Promise<AccountContext> => {
      invocations += 1;
      return Promise.resolve(ctx(`run_${invocations.toString()}`));
    };
    const first = await coalescer.coalesce('sha_y', slowPath);
    const second = await coalescer.coalesce('sha_y', slowPath);
    expect(invocations).toBe(2);
    expect(first.account.id).toBe('run_1');
    expect(second.account.id).toBe('run_2');
  });

  it('keeps independent in-flight tracks for distinct shas', async () => {
    const coalescer = new AuthCoalescer();
    let invocations = 0;
    const slowPath =
      (label: string): (() => Promise<AccountContext>) =>
      (): Promise<AccountContext> => {
        invocations += 1;
        return Promise.resolve(ctx(label));
      };
    const a = coalescer.coalesce('sha_a', slowPath('A'));
    const b = coalescer.coalesce('sha_b', slowPath('B'));
    const [ra, rb] = await Promise.all([a, b]);
    expect(invocations).toBe(2);
    expect(ra.account.id).toBe('A');
    expect(rb.account.id).toBe('B');
  });
});

describe('V-553.B-23 AuthCoalescer.coalesce — rejection cleanup', () => {
  it('removes a rejected Promise from the map so retries can run again', async () => {
    const coalescer = new AuthCoalescer();
    let invocations = 0;
    const slowPath = (): Promise<AccountContext> => {
      invocations += 1;
      return invocations === 1
        ? Promise.reject(new Error('first fail'))
        : Promise.resolve(ctx('ok'));
    };
    await expect(coalescer.coalesce('sha_r', slowPath)).rejects.toThrow('first fail');
    // Second call should run the slow path again, not return the rejected promise.
    const r = await coalescer.coalesce('sha_r', slowPath);
    expect(invocations).toBe(2);
    expect(r.account.id).toBe('ok');
  });

  it('concurrent callers all see the same rejection when the slow path fails', async () => {
    const coalescer = new AuthCoalescer();
    let rejectSlow!: (e: unknown) => void;
    const slowPath = (): Promise<AccountContext> =>
      new Promise<AccountContext>((_resolve, reject) => {
        rejectSlow = reject;
      });
    const a = coalescer.coalesce('sha_e', slowPath);
    const b = coalescer.coalesce('sha_e', slowPath);
    rejectSlow(new Error('boom'));
    await expect(a).rejects.toThrow('boom');
    await expect(b).rejects.toThrow('boom');
  });
});

describe('V-553.B-23 AuthCoalescer.stats', () => {
  it('counts starts + hits + inFlight accurately', async () => {
    const coalescer = new AuthCoalescer();
    let resolveSlow!: (v: AccountContext) => void;
    const slowPath = (): Promise<AccountContext> =>
      new Promise<AccountContext>((resolve) => {
        resolveSlow = resolve;
      });
    const a = coalescer.coalesce('sha_s', slowPath);
    void coalescer.coalesce('sha_s', slowPath);
    void coalescer.coalesce('sha_s', slowPath);
    expect(coalescer.stats()).toEqual({ starts: 1, hits: 2, inFlight: 1 });

    resolveSlow(ctx('done'));
    await a;
    expect(coalescer.stats()).toEqual({ starts: 1, hits: 2, inFlight: 0 });
  });
});
