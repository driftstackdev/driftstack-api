// org-sync phase 3c transport — GET/PUT /v1/account/me/organization.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchOrganization, saveOrganization } from '../../src/lib/account-organization';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('fetchOrganization', () => {
  it('GETs the org endpoint with a bearer token and normalizes the response', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ folders: [{ name: 'Sales', icon: '🛒' }], tags: ['aged'] }), {
          status: 200,
        }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const org = await fetchOrganization('https://api.driftstack.dev/', 'ds_key');
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      'https://api.driftstack.dev/v1/account/me/organization',
    );
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe('GET');
    expect(init.signal).toBeTruthy();
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer ds_key');
    expect(org).toEqual({ folders: [{ name: 'Sales', icon: '🛒' }], tags: ['aged'] });
  });

  it('drops malformed folders/tags and defaults missing arrays to empty', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({ folders: [{ name: 'OK' }, { icon: 'x' }], tags: ['t', 5] }),
            {
              status: 200,
            },
          ),
        ),
      ),
    );
    const org = await fetchOrganization('https://api.driftstack.dev', 'ds_key');
    expect(org.folders).toEqual([{ name: 'OK' }]);
    expect(org.tags).toEqual(['t']);
  });

  it('throws on a non-2xx so the caller can fall back to the local cache', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('nope', { status: 503 }))),
    );
    await expect(fetchOrganization('https://api.driftstack.dev', 'ds_key')).rejects.toThrow();
  });

  it('aborts a hung organization read after 15 seconds', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              reject(new DOMException('aborted', 'AbortError'));
            });
          }),
      ),
    );
    const pending = fetchOrganization('https://api.driftstack.dev', 'ds_key');
    const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(15_000);
    await rejection;
  });

  it('sends X-Driftstack-Account when an active workspace is passed (matches profile scope)', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ folders: [], tags: [] }), { status: 200 })),
    );
    vi.stubGlobal('fetch', fetchMock);
    await fetchOrganization('https://api.driftstack.dev', 'ds_key', 'acc_team_owner');
    const headers = (fetchMock.mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>;
    expect(headers['x-driftstack-account']).toBe('acc_team_owner');
  });

  it('omits X-Driftstack-Account for personal scope (null)', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ folders: [], tags: [] }), { status: 200 })),
    );
    vi.stubGlobal('fetch', fetchMock);
    await fetchOrganization('https://api.driftstack.dev', 'ds_key', null);
    const headers = (fetchMock.mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>;
    expect(headers['x-driftstack-account']).toBeUndefined();
  });
});

describe('saveOrganization', () => {
  it('PUTs the taxonomy as JSON with a bearer token', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response('{}', { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);
    await saveOrganization('https://api.driftstack.dev', 'ds_key', {
      folders: [{ name: 'QA' }],
      tags: ['warmup'],
    });
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body as string)).toEqual({
      folders: [{ name: 'QA' }],
      tags: ['warmup'],
    });
  });

  it('sends X-Driftstack-Account on the PUT when an active workspace is passed', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response('{}', { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);
    await saveOrganization(
      'https://api.driftstack.dev',
      'ds_key',
      { folders: [], tags: [] },
      'acc_team_owner',
    );
    const headers = (fetchMock.mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>;
    expect(headers['x-driftstack-account']).toBe('acc_team_owner');
  });
});
