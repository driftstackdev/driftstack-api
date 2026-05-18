// EG-API-1.2/1.3 SDK — unit tests for EgressResource.
//
// Covers the contract surface:
// - attachToSession sends POST /v1/sessions/{id}/proxy with the
//   SessionEgressConfig body verbatim (URL-encoded id).
// - getSessionProxy reads GET on the same path.
// - saveProxy sends POST /v1/proxies with the SavedProxyConfig body.
// - listSavedProxies reads GET /v1/proxies.
// - deleteSavedProxy sends DELETE /v1/proxies/{id} (URL-encoded).

import { describe, expect, it } from 'vitest';
import { EgressResource } from '../../src/resources/egress.js';
import type { HttpClient } from '../../src/http.js';
import type { SessionEgressConfig, SavedProxyConfig } from '@driftstack/api-types';

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

  it('saveProxy POSTs /v1/proxies with SavedProxyConfig body', async () => {
    const body: SavedProxyConfig = {
      label: 'team SOCKS5',
      proxy: {
        type: 'socks5',
        socks5: { host: 'x.example', port: 1080, udp_associate: true, require_remote_dns: false },
      },
    };
    const reply = { id: 'proxy_1', label: 'team SOCKS5', type: 'socks5' as const };
    const { http, calls } = makeFakeHttp(reply);
    const res = new EgressResource(http);
    const result = await res.saveProxy(body);
    expect(calls).toEqual([{ method: 'POST', path: '/v1/proxies', body }]);
    expect(result).toEqual(reply);
  });

  it('listSavedProxies GETs /v1/proxies', async () => {
    const reply = {
      data: [{ id: 'proxy_1', label: 'l', type: 'socks5' as const }],
    };
    const { http, calls } = makeFakeHttp(reply);
    const res = new EgressResource(http);
    const result = await res.listSavedProxies();
    expect(calls).toEqual([{ method: 'GET', path: '/v1/proxies' }]);
    expect(result.data).toHaveLength(1);
  });

  it('deleteSavedProxy DELETEs /v1/proxies/{id} (URL-encoded)', async () => {
    const { http, calls } = makeFakeHttp(undefined as unknown as void);
    const res = new EgressResource(http);
    await res.deleteSavedProxy('proxy with space');
    expect(calls).toEqual([{ method: 'DELETE', path: '/v1/proxies/proxy%20with%20space' }]);
  });
});
