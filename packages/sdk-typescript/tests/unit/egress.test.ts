// SDK unit tests for EgressResource.
//
// Covers the contract surface:
// - attachToSession sends POST /v1/sessions/{id}/proxy with the
//   SessionEgressConfig body verbatim (URL-encoded id).
// - getSessionProxy reads GET on the same path.
// - the saved-proxy library CRUD + test rides the LIVE account-proxies
//   API: createProxy/listProxies POST/GET /v1/account/me/proxies,
//   updateProxy PUT + deleteProxy DELETE /v1/account/me/proxies/{id},
//   testProxy POST /v1/account/me/proxies/{id}/test.

import { describe, expect, it } from 'vitest';
import { EgressResource } from '../../src/resources/egress.js';
import type { HttpClient } from '../../src/http.js';
import type { SessionEgressConfig, AccountProxyInput } from '@driftstack/api-types';

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

describe('EgressResource', () => {
  it('attachToSession POSTs /v1/sessions/{id}/proxy with the body verbatim (id URL-encoded)', async () => {
    const config: SessionEgressConfig = {
      session_id: 'ses xyz',
      proxy: {
        type: 'socks5',
        socks5: {
          host: 'proxy.example.com',
          port: 1080,
          udp_associate: true,
          require_remote_dns: false,
        },
      },
      egress_safeguard: {
        block_direct_internet: true,
        block_unproxied_dns: true,
        block_webrtc_stun_leakage: true,
      },
    };
    const reply = {
      type: 'socks5' as const,
      safeguards: {
        block_direct_internet: true,
        block_unproxied_dns: true,
        block_webrtc_stun_leakage: true,
      },
    };
    const { http, calls } = makeFakeHttp(reply);
    const res = new EgressResource(http);
    const result = await res.attachToSession('ses xyz', config);
    expect(calls).toEqual([{ method: 'POST', path: '/v1/sessions/ses%20xyz/proxy', body: config }]);
    expect(result).toEqual(reply);
  });

  it('getSessionProxy GETs /v1/sessions/{id}/proxy', async () => {
    const { http, calls } = makeFakeHttp({
      type: 'socks5',
      safeguards: {
        block_direct_internet: true,
        block_unproxied_dns: true,
        block_webrtc_stun_leakage: true,
      },
    });
    const res = new EgressResource(http);
    await res.getSessionProxy('ses_abc');
    expect(calls).toEqual([{ method: 'GET', path: '/v1/sessions/ses_abc/proxy' }]);
  });

  it('createProxy POSTs /v1/account/me/proxies with the flat AccountProxyInput body', async () => {
    const body: AccountProxyInput = {
      label: 'team SOCKS5',
      scheme: 'socks5',
      host: 'x.example',
      port: 1080,
      username: null,
      password: 'secret',
    };
    const reply = {
      id: 'apx_1',
      label: 'team SOCKS5',
      scheme: 'socks5' as const,
      host: 'x.example',
      port: 1080,
      username: null,
      has_password: true,
      has_secret: false,
      created_at: '2026-06-17T00:00:00Z',
      updated_at: '2026-06-17T00:00:00Z',
    };
    const { http, calls } = makeFakeHttp(reply);
    const res = new EgressResource(http);
    const result = await res.createProxy(body);
    expect(calls).toEqual([{ method: 'POST', path: '/v1/account/me/proxies', body }]);
    expect(result).toEqual(reply);
  });

  it('listProxies GETs /v1/account/me/proxies', async () => {
    const reply = { data: [{ id: 'apx_1', label: 'l', scheme: 'socks5' as const }] };
    const { http, calls } = makeFakeHttp(reply);
    const res = new EgressResource(http);
    const result = await res.listProxies();
    expect(calls).toEqual([{ method: 'GET', path: '/v1/account/me/proxies' }]);
    expect(result.data).toHaveLength(1);
  });

  it('updateProxy PUTs /v1/account/me/proxies/{id} (URL-encoded)', async () => {
    const { http, calls } = makeFakeHttp({ id: 'p 1' });
    const res = new EgressResource(http);
    await res.updateProxy('p 1', { label: 'renamed' });
    expect(calls).toEqual([
      { method: 'PUT', path: '/v1/account/me/proxies/p%201', body: { label: 'renamed' } },
    ]);
  });

  it('deleteProxy DELETEs /v1/account/me/proxies/{id} (URL-encoded)', async () => {
    const { http, calls } = makeFakeHttp(undefined as unknown as void);
    const res = new EgressResource(http);
    await res.deleteProxy('proxy with space');
    expect(calls).toEqual([
      { method: 'DELETE', path: '/v1/account/me/proxies/proxy%20with%20space' },
    ]);
  });

  it('testProxy POSTs /v1/account/me/proxies/{id}/test', async () => {
    const { http, calls } = makeFakeHttp({ ok: true, latency_ms: 42 });
    const res = new EgressResource(http);
    const result = await res.testProxy('apx_1');
    expect(calls).toEqual([{ method: 'POST', path: '/v1/account/me/proxies/apx_1/test' }]);
    expect(result).toEqual({ ok: true, latency_ms: 42 });
  });
});
