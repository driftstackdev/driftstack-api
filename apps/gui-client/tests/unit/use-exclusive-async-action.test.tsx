import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  useExclusiveAsyncAction,
  type ExclusiveAsyncActionResult,
} from '../../src/lib/use-exclusive-async-action';

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe('useExclusiveAsyncAction', () => {
  it('acquires synchronously and never invokes same-tick duplicate work', async () => {
    const task = deferred<string>();
    const work = vi.fn(() => task.promise);
    const { result } = renderHook(() => useExclusiveAsyncAction({ mapError: () => 'safe error' }));

    let first!: Promise<ExclusiveAsyncActionResult<string>>;
    let duplicate!: Promise<ExclusiveAsyncActionResult<string>>;
    act(() => {
      first = result.current.run(work);
      duplicate = result.current.run(work);
    });

    expect(work).toHaveBeenCalledTimes(1);
    await expect(duplicate).resolves.toEqual({ status: 'busy' });
    expect(result.current.pending).toBe(true);

    let firstOutcome!: ExclusiveAsyncActionResult<string>;
    await act(async () => {
      task.resolve('done');
      firstOutcome = await first;
    });
    expect(firstOutcome).toEqual({ status: 'success', value: 'done' });
    expect(result.current.pending).toBe(false);

    let next!: ExclusiveAsyncActionResult<number>;
    await act(async () => {
      next = await result.current.run(() => 42);
    });
    expect(next).toEqual({ status: 'success', value: 42 });
  });

  it('maps rejections to safe copy, resolves the caller promise, resets, and releases', async () => {
    const rawError = new Error('token=secret /Users/customer private.internal');
    const mapError = vi.fn(() => "Couldn't stop the session. Try again.");
    const { result } = renderHook(() => useExclusiveAsyncAction({ mapError }));

    let failure!: ExclusiveAsyncActionResult<never>;
    await act(async () => {
      failure = await result.current.run(() => Promise.reject(rawError));
    });

    expect(mapError).toHaveBeenCalledWith(rawError);
    expect(failure).toEqual({
      status: 'error',
      error: "Couldn't stop the session. Try again.",
    });
    expect(result.current).toMatchObject({
      pending: false,
      error: "Couldn't stop the session. Try again.",
    });

    act(() => result.current.reset());
    expect(result.current.error).toBeNull();

    let retry!: ExclusiveAsyncActionResult<string>;
    await act(async () => {
      retry = await result.current.run(() => 'released');
    });
    expect(retry).toEqual({ status: 'success', value: 'released' });
  });

  it('releases ownership when the caller cancels before doing write work', async () => {
    const decision = deferred<boolean>();
    const write = vi.fn();
    const { result } = renderHook(() => useExclusiveAsyncAction({ mapError: () => 'safe error' }));

    let cancelled!: Promise<ExclusiveAsyncActionResult<'cancelled' | 'written'>>;
    act(() => {
      cancelled = result.current.run(async () => {
        if (!(await decision.promise)) return 'cancelled' as const;
        write();
        return 'written' as const;
      });
    });

    decision.resolve(false);
    await expect(cancelled).resolves.toEqual({ status: 'success', value: 'cancelled' });
    expect(write).not.toHaveBeenCalled();

    let next!: ExclusiveAsyncActionResult<string>;
    await act(async () => {
      next = await result.current.run(() => 'next');
    });
    expect(next).toEqual({ status: 'success', value: 'next' });
  });

  it('settles after unmount without publishing late pending or error state', async () => {
    const task = deferred<number>();
    const { result, unmount } = renderHook(() =>
      useExclusiveAsyncAction({ mapError: () => 'safe late error' }),
    );

    let pending!: Promise<ExclusiveAsyncActionResult<number>>;
    act(() => {
      pending = result.current.run(() => task.promise);
    });
    expect(result.current).toMatchObject({ pending: true, error: null });

    unmount();
    task.reject(new Error('late rejection'));

    await expect(pending).resolves.toEqual({ status: 'error', error: 'safe late error' });
    // renderHook retains the last published snapshot after unmount. If the
    // hook attempted a late publication, no new snapshot may replace it.
    expect(result.current).toMatchObject({ pending: true, error: null });
  });

  it('keeps run non-rejecting when the caller-provided mapper itself fails', async () => {
    const { result } = renderHook(() =>
      useExclusiveAsyncAction({
        mapError: () => {
          throw new Error('mapper regression');
        },
      }),
    );

    let outcome!: ExclusiveAsyncActionResult<never>;
    await act(async () => {
      outcome = await result.current.run(() => Promise.reject(new Error('raw secret')));
    });

    expect(outcome).toEqual({
      status: 'error',
      error: "Couldn't complete that action. Try again.",
    });
    expect(result.current.error).toBe("Couldn't complete that action. Try again.");
    expect(result.current.pending).toBe(false);
  });
});
