// ARC A slice 5 transport — /v1/account/me/proxies CRUD (raw authed fetch).

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AccountProxyRequestError,
  createProxy,
  deleteProxy,
  listProxies,
  updateProxy,
} from '../../src/lib/account-proxies';

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
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
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
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
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

// T-20 — a refusal keeps its reason. The server answers a rejected OpenVPN
// config with `Line 8: "up …" — Driftstack does not run scripts from VPN
// configs…`; this transport used to dispose that body and throw the status
// alone, so the launch dialog had nothing to show but a guess.
describe('createProxy / updateProxy — a refusal keeps its reason (T-20)', () => {
  const PROBLEM = {
    type: 'https://errors.driftstack.dev/bad-request',
    title: 'Bad Request',
    status: 400,
    detail:
      'Line 8: "up /etc/openvpn/update-resolv-conf" — Driftstack does not run scripts from VPN ' +
      'configs. Remove this line and try again.',
  };
  const INPUT = { label: 'ovpn', host: 'vpn.example.com', port: 1194 };

  it('CRITICAL a 400 with a problem+json body throws an error carrying status, type, title and detail verbatim — the detail is the sentence the owner is shown, so it must survive the wire untouched.', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify(PROBLEM), {
            status: 400,
            headers: { 'content-type': 'application/problem+json' },
          }),
        ),
      ),
    );
    const err: unknown = await createProxy('https://api.driftstack.dev', 'ds_key', INPUT).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AccountProxyRequestError);
    expect(err).toMatchObject({
      status: 400,
      type: PROBLEM.type,
      title: PROBLEM.title,
      detail: PROBLEM.detail,
    });
    expect((err as Error).message).toBe(`proxy create failed: 400 — ${PROBLEM.detail}`);
  });

  it('CONTROL a body-less 500 falls back to today’s status-only message with no detail. This is the vacuity arm: a transport that invented a detail for every failure would satisfy the arm above and put words in the server’s mouth.', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(null, { status: 500 }))),
    );
    const err: unknown = await createProxy('https://api.driftstack.dev', 'ds_key', INPUT).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AccountProxyRequestError);
    expect(err).toMatchObject({
      status: 500,
      type: undefined,
      title: undefined,
      detail: undefined,
    });
    expect((err as Error).message).toBe('proxy create failed: 500');
  });

  it('a non-JSON body (an HTML 502 from something in front of the API) falls back the same way instead of throwing a parse error at the caller', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('<html>bad gateway</html>', { status: 502 }))),
    );
    const err: unknown = await createProxy('https://api.driftstack.dev', 'ds_key', INPUT).catch(
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ status: 502, detail: undefined });
    expect((err as Error).message).toBe('proxy update failed: 502'.replace('update', 'create'));
  });

  it('CRITICAL updateProxy carries the same fields and still exposes `status`, which the stale-id self-heal in ProfilesView reads to tell a deleted row (404) from a refusal', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ ...PROBLEM, status: 404, title: 'Not Found' }), {
            status: 404,
          }),
        ),
      ),
    );
    const err: unknown = await updateProxy('https://api.driftstack.dev', 'ds_key', 'p1', {
      label: 'x',
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AccountProxyRequestError);
    expect(err).toMatchObject({ status: 404, title: 'Not Found', detail: PROBLEM.detail });
    expect((err as Error).message).toMatch(/^proxy update failed: 404 — Line 8/);
  });
});

describe('updateProxy', () => {
  it('PUTs to the id-scoped URL', async () => {
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
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
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(new Response(null, { status: 404 })),
    );
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
