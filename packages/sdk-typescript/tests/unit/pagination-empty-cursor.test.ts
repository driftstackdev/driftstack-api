// An empty-string cursor ends the walk; it is not a cursor to follow.
//
// The three SDK pagination helpers disagreed here. Measured by running the same
// page-sequences through all three: on `next_cursor: ""` sdk-go stopped, while
// this helper and sdk-python treated it as a real cursor and fetched again.
//
// The extra fetch is not the problem — the loop is. The server decodes an empty
// cursor as "first page", so the walk restarts and the iterator cycles
// c1 -> "" -> c1 forever, yielding duplicates. The repeated-cursor stall guard
// cannot catch it: consecutive cursors differ every time round.
//
// Not reachable from this API, whose list routes emit `next_cursor: null` when
// the walk is done. These helpers exist so a customer never hand-rolls a cursor
// loop, which means they have to be right about the boundary the customer never
// thinks about.

import { describe, expect, it } from 'vitest';
import { iteratePaginated } from '../../src/pagination.js';
import { TransportError } from '../../src/errors.js';

interface Page {
  readonly data: number[];
  readonly next_cursor: string | null;
}

/** Serves `pages` in order, then a terminal empty page, counting the calls. */
function server(pages: Page[]): { fetch: () => Promise<Page>; calls: () => number } {
  let n = 0;
  return {
    fetch: () => {
      const page = pages[n] ?? { data: [], next_cursor: null };
      n += 1;
      return Promise.resolve(page);
    },
    calls: () => n,
  };
}

async function walk(pages: Page[]): Promise<{ items: number[]; calls: number }> {
  const s = server(pages);
  const items: number[] = [];
  for await (const item of iteratePaginated<number>(s.fetch)) items.push(item);
  return { items, calls: s.calls() };
}

describe('cursor pagination termination', () => {
  it('CRITICAL an empty-string cursor ends the walk without another fetch', async () => {
    const { items, calls } = await walk([
      { data: [1], next_cursor: 'c1' },
      { data: [2], next_cursor: '' },
      { data: [99], next_cursor: null },
    ]);
    expect(
      items,
      'the walk continued past an empty cursor. The server reads an empty cursor as "first page", ' +
        'so this restarts the walk and yields the same rows again',
    ).toEqual([1, 2]);
    expect(calls, 'an empty cursor must not trigger another request').toBe(2);
  });

  it('CRITICAL a null cursor still ends the walk', async () => {
    const { items, calls } = await walk([
      { data: [1, 2], next_cursor: 'c1' },
      { data: [3], next_cursor: null },
    ]);
    expect(items).toEqual([1, 2, 3]);
    expect(calls).toBe(2);
  });

  it('CRITICAL a real cursor is still followed, so this is not "stop on anything falsy"', async () => {
    // Without this, terminating on every cursor would satisfy the arms above
    // and silently truncate every list to its first page.
    const { items, calls } = await walk([
      { data: [1], next_cursor: 'c1' },
      { data: [2], next_cursor: 'c2' },
      { data: [3], next_cursor: null },
    ]);
    expect(items).toEqual([1, 2, 3]);
    expect(calls).toBe(3);
  });

  it('CRITICAL a repeated cursor still raises rather than spinning', async () => {
    await expect(
      walk([
        { data: [1], next_cursor: 'c1' },
        { data: [2], next_cursor: 'c1' },
      ]),
    ).rejects.toBeInstanceOf(TransportError);
  });
});
