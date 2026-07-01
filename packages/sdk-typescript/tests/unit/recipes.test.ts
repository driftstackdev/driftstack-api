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
}

function makeFakeHttp<T>(reply: T): { http: HttpClient; calls: RecordedRequest[] } {
  const calls: RecordedRequest[] = [];
  const http = {
    request: <R>(opts: { method: string; path: string; body?: unknown }) => {
      const recorded: RecordedRequest = { method: opts.method, path: opts.path };
      if (opts.body !== undefined) recorded.body = opts.body;
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

  it('list forwards pagination query params only when present', async () => {
    const { http, calls } = makeFakeHttp({ data: [], has_more: false, next_cursor: null });
    await new RecipesResource(http).list();
    expect(calls).toEqual([{ method: 'GET', path: '/v1/recipes' }]);
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
