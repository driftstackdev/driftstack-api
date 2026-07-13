// Security regression coverage for account-wide identity, security, and
// billing metadata reads. A valid key is not automatically a read-capable
// key: zero-scope, write-only, and resource-granular credentials must not
// cross into these account-wide surfaces.

import { afterEach, describe, expect, it } from 'vitest';
import type { ApiKeyScope } from '@driftstack/api-types';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

let fx: TestAppFixture;

afterEach(async () => {
  if (fx) await fx.cleanup();
});

const OAUTH = {
  signingSecret: 'b'.repeat(32),
  callbackUrlBase: 'https://api.driftstack.test/v1/auth/oauth',
  dashboardOrigin: 'https://app.driftstack.test',
  google: { clientId: 'g-id', clientSecret: 'g-secret' },
};

const ACCOUNT_READ_PATHS = [
  '/v1/account/me',
  '/v1/account/me/organization',
  '/v1/account/mfa',
  '/v1/account/me/oauth-links',
  '/v1/account/web-sessions',
  '/v1/account/me/bundled-llm-settings',
  '/v1/account/me/bundled-llm-status',
  '/v1/account/me/byok-anthropic-key',
  '/v1/account/rate-limits',
] as const;

async function build(scopes: ApiKeyScope[]): Promise<TestAppFixture> {
  return buildTestApp({
    scopes,
    oauthClient: OAUTH,
    enableByokAnthropic: true,
  });
}

async function get(path: (typeof ACCOUNT_READ_PATHS)[number]) {
  return fx.app.inject({
    method: 'GET',
    url: path,
    headers: { authorization: `Bearer ${fx.plaintext}` },
  });
}

describe('broad read floor on sensitive account metadata', () => {
  it.each([
    ['zero-scope', []],
    ['write-only', ['write']],
    ['session-granular', ['read:sessions']],
    ['GUI-control-only', ['gui_control']],
  ] as const)('blocks a %s key from every account-wide read', async (_label, scopes) => {
    fx = await build([...scopes]);

    for (const path of ACCOUNT_READ_PATHS) {
      const res = await get(path);
      expect(res.statusCode, path).toBe(403);
      expect(res.json<{ detail: string }>().detail, path).toBe(
        'This action requires the "read" scope.',
      );
    }
  });

  it.each(['read', 'account_owner'] as const)(
    'allows a %s key through every account-wide read',
    async (scope) => {
      fx = await build([scope]);

      for (const path of ACCOUNT_READ_PATHS) {
        const res = await get(path);
        expect(res.statusCode, `${path}: ${res.body}`).toBe(200);
      }
    },
  );
});
