import { describe, expect, it, vi } from 'vitest';
import { iteratePaginated, type CursorPage } from '../../src/pagination.js';
import { TransportError } from '../../src/errors.js';

describe('iteratePaginated', () => {
  it('walks a single full page and stops on null next_cursor', async () => {
    const fetchPage = vi.fn((_cursor: string | null): Promise<CursorPage<number>> => {
      return Promise.resolve({ data: [1, 2, 3], next_cursor: null });
    });
    const collected: number[] = [];
    for await (const n of iteratePaginated(fetchPage)) {
      collected.push(n);
    }
    expect(collected).toEqual([1, 2, 3]);
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(fetchPage).toHaveBeenCalledWith(null);
  });

  it('walks multi-page sequence using next_cursor', async () => {
    const pages: Array<CursorPage<string>> = [
      { data: ['a', 'b'], next_cursor: 'cur_2' },
      { data: ['c', 'd'], next_cursor: 'cur_3' },
      { data: ['e'], next_cursor: null },
    ];
    let i = 0;
    const seenCursors: Array<string | null> = [];
    const fetchPage = vi.fn((cursor: string | null): Promise<CursorPage<string>> => {
      seenCursors.push(cursor);
      const page = pages[i]!;
      i += 1;
      return Promise.resolve(page);
    });
    const collected: string[] = [];
    for await (const s of iteratePaginated(fetchPage)) {
      collected.push(s);
    }
    expect(collected).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(fetchPage).toHaveBeenCalledTimes(3);
    expect(seenCursors).toEqual([null, 'cur_2', 'cur_3']);
  });

  it('handles an empty first page (data: [], next_cursor: null)', async () => {
    const fetchPage = vi.fn(
      (_cursor: string | null): Promise<CursorPage<number>> =>
        Promise.resolve({ data: [], next_cursor: null }),
    );
    const collected: number[] = [];
    for await (const n of iteratePaginated(fetchPage)) {
      collected.push(n);
    }
    expect(collected).toEqual([]);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it('handles intermediate empty pages (no items but more cursors)', async () => {
    const pages: Array<CursorPage<number>> = [
      { data: [], next_cursor: 'cur_2' },
      { data: [42], next_cursor: null },
    ];
    let i = 0;
    const fetchPage = vi.fn((_cursor: string | null): Promise<CursorPage<number>> => {
      const page = pages[i]!;
      i += 1;
      return Promise.resolve(page);
    });
    const collected: number[] = [];
    for await (const n of iteratePaginated(fetchPage)) {
      collected.push(n);
    }
    expect(collected).toEqual([42]);
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it('propagates errors from fetchPage', async () => {
    const fetchPage = vi.fn(
      (_cursor: string | null): Promise<CursorPage<number>> =>
        Promise.reject(new Error('network blip')),
    );
    const iter = iteratePaginated(fetchPage);
    await expect(iter.next()).rejects.toThrow('network blip');
  });

  it('stops calling fetchPage when consumer breaks early', async () => {
    const pages: Array<CursorPage<number>> = [
      { data: [1, 2, 3], next_cursor: 'cur_2' },
      { data: [4, 5, 6], next_cursor: null },
    ];
    let i = 0;
    const fetchPage = vi.fn((_cursor: string | null): Promise<CursorPage<number>> => {
      const page = pages[i]!;
      i += 1;
      return Promise.resolve(page);
    });
    for await (const n of iteratePaginated(fetchPage)) {
      if (n === 2) break;
    }
    // We never advanced past the first page — second fetch never fires.
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it('throws TransportError (does not hang) when the cursor does not advance', async () => {
    // A buggy server / proxy returns the SAME non-null cursor forever. Without
    // the non-advance guard this would loop infinitely and hang the caller.
    const fetchPage = vi.fn(
      (_cursor: string | null): Promise<CursorPage<number>> =>
        Promise.resolve({ data: [1], next_cursor: 'stuck' }),
    );
    const collected: number[] = [];
    await expect(
      (async () => {
        for await (const n of iteratePaginated(fetchPage)) collected.push(n);
      })(),
    ).rejects.toBeInstanceOf(TransportError);
    // First page yielded, second fetch saw the same cursor and bailed — not ∞.
    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(collected).toEqual([1, 1]);
  });
});
