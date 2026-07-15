// org-sync phase 3c transport — GET/PUT /v1/account/me/organization.

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchOrganization,
  saveOrganization,
  type AccountOrganization,
} from '../../src/lib/account-organization';

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

  it('cancels an ignored successful response body', async () => {
    const cancel = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(new Response(new ReadableStream<Uint8Array>({ cancel }), { status: 200 })),
      ),
    );
    await saveOrganization('https://api.driftstack.dev', 'ds_key', {
      folders: [],
      tags: [],
    });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('runs same-scope whole-object saves FIFO and keeps a queued tail identity-owned', async () => {
    let releaseFirst: ((response: Response) => void) | undefined;
    let releaseSecond: ((response: Response) => void) | undefined;
    const firstResponse = new Promise<Response>((resolve) => {
      releaseFirst = resolve;
    });
    const secondResponse = new Promise<Response>((resolve) => {
      releaseSecond = resolve;
    });
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => firstResponse)
      .mockImplementationOnce(() => secondResponse)
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    const older = saveOrganization('https://api.driftstack.dev/', 'ds_key', {
      folders: [{ name: 'Old' }],
      tags: [],
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const newer = saveOrganization('https://api.driftstack.dev', 'ds_key', {
      folders: [{ name: 'New' }],
      tags: [],
    });
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    releaseFirst?.(new Response(null, { status: 204 }));
    await older;
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    const newest = saveOrganization('https://api.driftstack.dev', 'ds_key', {
      folders: [{ name: 'Newest' }],
      tags: [],
    });
    await Promise.resolve();
    // The older caller's finally must not delete the still-active New tail.
    expect(fetchMock).toHaveBeenCalledTimes(2);

    releaseSecond?.(new Response(null, { status: 204 }));
    await Promise.all([newer, newest]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(
      fetchMock.mock.calls.map((call) => {
        const init = call[1] as RequestInit;
        const body = JSON.parse(init.body as string) as AccountOrganization;
        return body.folders[0]?.name;
      }),
    ).toEqual(['Old', 'New', 'Newest']);
  });

  it('rejects the failed caller without poisoning its same-scope successor', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    const failed = saveOrganization('https://api.driftstack.dev', 'ds_key', {
      folders: [{ name: 'Old' }],
      tags: [],
    });
    const recovered = saveOrganization('https://api.driftstack.dev', 'ds_key', {
      folders: [{ name: 'New' }],
      tags: [],
    });

    await expect(failed).rejects.toThrow('organization save failed: 503');
    await expect(recovered).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('allows distinct effective-account scopes to save concurrently', async () => {
    let releaseOwner: ((response: Response) => void) | undefined;
    const heldOwner = new Promise<Response>((resolve) => {
      releaseOwner = resolve;
    });
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => heldOwner)
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    const ownerSave = saveOrganization(
      'https://api.driftstack.dev',
      'ds_key',
      { folders: [{ name: 'Owner' }], tags: [] },
      'acc_owner',
    );
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const otherSave = saveOrganization(
      'https://api.driftstack.dev',
      'ds_key',
      { folders: [{ name: 'Other' }], tags: [] },
      'acc_other',
    );

    await expect(otherSave).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    releaseOwner?.(new Response(null, { status: 204 }));
    await ownerSave;
  });
});
