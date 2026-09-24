import { describe, expect, it, vi } from 'vitest';
import { FREE_DESKTOP_ROUTE_DENIED_DETAIL } from '@driftstack/api-types';

/**
 * GUI audit #11 (GUI part) — a Free account signed in with the browser holds a
 * desktop key the server bounds to the routes the app needs, and the proxy Test
 * route is not one of them: the full check is a paid-plan feature. The app used
 * to answer that refusal with "Testing through Driftstack needs an API key.
 * Connect your API key in Settings to test it." — a dead end: the customer IS
 * signed in, and a pasted key is refused for Free accounts too. The refusal now
 * says the check isn't included on the Free plan, and never sends the customer
 * to connect a key.
 *
 * The request goes through the real `testAccountProxy` / `vpnStoreRefusal`
 * over a stubbed response carrying the server's own route-policy sentence (the
 * shared contract constant, never a copy).
 */

let nextResponse: () => Response = () => new Response('{}', { status: 500 });
vi.mock('../../src/lib/fetch-with-deadline', () => ({
  DEFAULT_REQUEST_TIMEOUT_MS: 15_000,
  fetchWithDeadline: (): Promise<Response> => Promise.resolve(nextResponse()),
}));

const { testAccountProxy, AccountProxyRequestError } =
  await import('../../src/lib/account-proxies');
const { vpnStoreRefusal } = await import('../../src/lib/proxy-server-test');

function routePolicyRefusal(): Response {
  return new Response(
    JSON.stringify({
      type: 'https://errors.driftstack.dev/forbidden',
      title: 'Forbidden',
      status: 403,
      detail: FREE_DESKTOP_ROUTE_DENIED_DETAIL,
    }),
    { status: 403, headers: { 'content-type': 'application/problem+json' } },
  );
}

/** Nothing a Free desktop key can act on: no key to connect, no Settings step. */
const DEAD_END = /API key|Settings/i;
const FREE_PLAN = /isn't included on the Free plan/;

describe('the proxy check refused for a Free desktop key', () => {
  it('CRITICAL Test says the check is not on the Free plan, and never "connect your API key"', async () => {
    for (const vantage of ['cp', 'fleet'] as const) {
      nextResponse = routePolicyRefusal;
      const r = await testAccountProxy('https://api.example.test', 'ds_free_desktop', 'aprx_1', {
        vantage,
      });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.not_run).toBe('desktop_credential');
      expect(r.reason).toMatch(FREE_PLAN);
      expect(r.reason).not.toMatch(DEAD_END);
      // The server's sentence is the discriminator, never the customer's copy.
      expect(r.reason).not.toContain('API route');
    }
  });

  it('CRITICAL a VPN the account refuses to store for the same reason says the same, notice and tally', () => {
    const r = vpnStoreRefusal(
      new AccountProxyRequestError('create', 403, { detail: FREE_DESKTOP_ROUTE_DENIED_DETAIL }),
    );
    expect(r.notice).toMatch(/^Address found\. /);
    expect(r.notice).toMatch(FREE_PLAN);
    expect(r.notice).not.toMatch(DEAD_END);
    expect(r.tally).toMatch(/Free plan/);
    expect(r.tally).not.toMatch(DEAD_END);
  });
});
