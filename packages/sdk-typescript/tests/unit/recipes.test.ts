// AI-B4 SDK + doc-132 §5.2 — unit tests for RecipesResource.
//
// Pins the wire contract: method/path/body shape per endpoint, plus
// URL-encoding on id parameters so labels with spaces or slashes
// don't break route matching.

import { describe, expect, it } from 'vitest';
import { RecipesResource } from '../../src/resources/recipes.js';
import type { HttpClient } from '../../src/http.js';

interface RecordedRequest {
  method: string;
  path: string;
  body?: unknown;
  query?: Record<string, unknown>;
}

function makeFakeHttp<T>(reply: T): { http: HttpClient; calls: RecordedRequest[] } {
  const calls: RecordedRequest[] = [];
  const http = {
    request: <R>(opts: {
      method: string;
      path: string;
      body?: unknown;
      query?: Record<string, unknown>;
    }) => {
      const recorded: RecordedRequest = { method: opts.method, path: opts.path };
      if (opts.body !== undefined) recorded.body = opts.body;
      // Recorded only when NON-EMPTY, which is the property under test rather
      // than a convenience: `list()` with no arguments must put no key on the
      // wire at all, and that reads here as the absence of `query`. Recording an
      // empty object instead would make the absent case indistinguishable from
      // `{ limit: undefined }` — the defect where a client serialises the literal
      // string "undefined" into the URL. A key that exists with an undefined
      // value still has length 1, so it is still recorded and still caught.
      if (opts.query !== undefined && Object.keys(opts.query).length > 0) {
        recorded.query = opts.query;
      }
      calls.push(recorded);
      return Promise.resolve(reply as unknown as R);
    },
  } as unknown as HttpClient;
  return { http, calls };
}

describe('RecipesResource', () => {
  it('create POSTs /v1/recipes with the body verbatim', async () => {
    const reply = {
      id: 'rec_1',
      account_id: 'acc_1',
      agent_session_id: 'agt_1',
      label: 'my recipe',
      description: null,
      intent_count: 3,
      created_at: '2026-07-01T00:00:00Z',
      updated_at: '2026-07-01T00:00:00Z',
    };
    const { http, calls } = makeFakeHttp(reply);
    const recipes = new RecipesResource(http);
    const result = await recipes.create({ agent_session_id: 'agt_1', label: 'my recipe' });
    expect(calls).toEqual([
      {
        method: 'POST',
        path: '/v1/recipes',
        body: { agent_session_id: 'agt_1', label: 'my recipe' },
      },
    ]);
    expect(result).toEqual(reply);
  });

  it('get URL-encodes the id', async () => {
    const { http, calls } = makeFakeHttp({});
    await new RecipesResource(http).get('rec/with slash');
    expect(calls).toEqual([{ method: 'GET', path: '/v1/recipes/rec%2Fwith%20slash' }]);
  });

  it('delete URL-encodes the id', async () => {
    const { http, calls } = makeFakeHttp(undefined);
    await new RecipesResource(http).delete('rec/with slash');
    expect(calls).toEqual([{ method: 'DELETE', path: '/v1/recipes/rec%2Fwith%20slash' }]);
  });

  // The arm below used to be titled "list forwards pagination query params only
  // when present" while calling list() with no arguments — it asserted the ABSENT
  // direction alone, and the recorder it asserted against did not capture `query`
  // at all, so the forwarding half was untestable by construction. A dropped
  // spread in RecipesResource.list would not have reddened anything here.
  it('list with no arguments puts NO query on the wire', async () => {
    const { http, calls } = makeFakeHttp({ data: [], has_more: false, next_cursor: null });
    await new RecipesResource(http).list();
    expect(calls).toEqual([{ method: 'GET', path: '/v1/recipes' }]);
  });

  it('CRITICAL list forwards limit ALONE without inventing a cursor key', async () => {
    const { http, calls } = makeFakeHttp({ data: [], has_more: false, next_cursor: null });
    await new RecipesResource(http).list({ limit: 25 });
    expect(calls[0]?.query).toEqual({ limit: 25 });
  });

  it('CRITICAL list forwards cursor ALONE without inventing a limit key', async () => {
    const { http, calls } = makeFakeHttp({ data: [], has_more: false, next_cursor: null });
    await new RecipesResource(http).list({ cursor: 'cur_2' });
    expect(calls[0]?.query).toEqual({ cursor: 'cur_2' });
  });

  it('list forwards both params when both are given', async () => {
    const { http, calls } = makeFakeHttp({ data: [], has_more: false, next_cursor: null });
    await new RecipesResource(http).list({ limit: 10, cursor: 'cur_9' });
    expect(calls[0]?.query).toEqual({ limit: 10, cursor: 'cur_9' });
  });

  it('CRITICAL iterate threads next_cursor into the following page request', async () => {
    const page = (id: string, next: string | null): unknown => ({
      data: [
        {
          id,
          account_id: 'acc_1',
          agent_session_id: 'agt_1',
          label: 'r',
          description: null,
          intent_count: 1,
          created_at: '2026-07-01T00:00:00Z',
          updated_at: '2026-07-01T00:00:00Z',
        },
      ],
      has_more: next !== null,
      next_cursor: next,
    });
    const pages = [page('rec_1', 'cur_2'), page('rec_2', null)];
    const seen: Array<Record<string, unknown> | undefined> = [];
    let i = 0;
    const http = {
      request: (opts: { query?: Record<string, unknown> }) => {
        seen.push(opts.query);
        const r = pages[i];
        i += 1;
        return Promise.resolve(r);
      },
    } as unknown as HttpClient;

    const out: string[] = [];
    for await (const r of new RecipesResource(http).iterate({ limit: 1 })) {
      out.push((r as { id: string }).id);
    }

    expect(out, 'every page is yielded').toEqual(['rec_1', 'rec_2']);
    // The load-bearing half: page 2 must carry the cursor page 1 returned. If the
    // cursor spread were dropped, page 2 would repeat page 1's query and the walk
    // would either loop or silently stop — both invisible to a length check alone.
    expect(seen, 'page 2 carries page 1 next_cursor').toEqual([
      { limit: 1 },
      { limit: 1, cursor: 'cur_2' },
    ]);
  });

  it('suggest GETs /v1/agent-sessions/:id/recipe-suggestion with a URL-encoded id, returns the suggestion verbatim', async () => {
    const reply = {
      suggested_label: 'Fill form on example.com',
      suggested_description: 'Navigates to example.com, fills 1 field.',
      intent_count: 4,
    };
    const { http, calls } = makeFakeHttp(reply);
    const recipes = new RecipesResource(http);
    const result = await recipes.suggest('agt/with space');
    expect(calls).toEqual([
      { method: 'GET', path: '/v1/agent-sessions/agt%2Fwith%20space/recipe-suggestion' },
    ]);
    expect(result).toEqual(reply);
  });
});
