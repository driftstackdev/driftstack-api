// ARC A slice 5 transport — /v1/account/me/proxies CRUD (raw authed fetch).

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProxy, deleteProxy, listProxies, updateProxy } from '../../src/lib/account-proxies';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const META = {
  id: 'p1',
  label: 'home',
  scheme: 'socks5',
  host: '203.0.113.5',
  port: 1080,
  username: 'u',
  has_password: true,
  created_at: '2026-06-16T00:00:00.000Z',
  updated_at: '2026-06-16T00:00:00.000Z',
};

describe('listProxies', () => {
  it('GETs the proxies endpoint with a bearer token and returns data[]', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ data: [META] }), { status: 200 })),
    );
    vi.stubGlobal('fetch', fetchMock);
    const out = await listProxies('https://api.driftstack.dev/', 'ds_key');
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      'https://api.driftstack.dev/v1/account/me/proxies',
    );
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe('GET');
    expect(init.signal).toBeTruthy();
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer ds_key');
    expect(out).toEqual([META]);
  });

  it('throws on non-2xx so the caller can fall back to the local cache', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('nope', { status: 503 }))),
    );
    await expect(listProxies('https://api.driftstack.dev', 'ds_key')).rejects.toThrow();
  });

  it('cancels an unread non-2xx body before throwing', async () => {
    const cancel = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(new Response(new ReadableStream<Uint8Array>({ cancel }), { status: 503 })),
      ),
    );
    await expect(listProxies('https://api.driftstack.dev', 'ds_key')).rejects.toThrow(
      'proxies fetch failed: 503',
    );
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('aborts a hung transport after 15 seconds', async () => {
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
    const pending = listProxies('https://api.driftstack.dev', 'ds_key');
    const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(15_000);
    await rejection;
  });
});

describe('createProxy', () => {
  it('POSTs the input as JSON and returns the created metadata', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify(META), { status: 201 })),
    );
    vi.stubGlobal('fetch', fetchMock);
    const out = await createProxy('https://api.driftstack.dev', 'ds_key', {
      label: 'home',
      host: '203.0.113.5',
      port: 1080,
      password: 'pw',
    });
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe('POST');
    expect((JSON.parse(init.body as string) as { password?: string }).password).toBe('pw');
    expect(out.id).toBe('p1');
  });
});

describe('updateProxy', () => {
  it('PUTs to the id-scoped URL', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify(META), { status: 200 })),
    );
    vi.stubGlobal('fetch', fetchMock);
    await updateProxy('https://api.driftstack.dev', 'ds_key', 'p1', { label: 'renamed' });
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      'https://api.driftstack.dev/v1/account/me/proxies/p1',
    );
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).method).toBe('PUT');
  });
});

describe('deleteProxy', () => {
  it('DELETEs the id-scoped URL and treats 404 as already-gone', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response(null, { status: 404 })));
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      deleteProxy('https://api.driftstack.dev', 'ds_key', 'p1'),
    ).resolves.toBeUndefined();
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).method).toBe('DELETE');
  });

  it('throws on a non-404 error status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('err', { status: 500 }))),
    );
    await expect(deleteProxy('https://api.driftstack.dev', 'ds_key', 'p1')).rejects.toThrow();
  });
});
