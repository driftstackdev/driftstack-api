// 2026-09-11 — the v2 OAuth flow store (PKCE verifier + hand-off code, keyed
// by nonce / hashed code, single-use) is a REQUIRED dep of
// registerOAuthClientRoutes. That requirement is what turns a missing wire
// into a compile error instead of a 500 on every v2 /start
// (`deps.flowStore.set` on undefined → "The service is temporarily
// unavailable." on the login page). This pin freezes the whole chain, so
// that the store cannot be made optional at any hop and cannot be dropped
// from the production wiring without a red:
//
//   routes/auth-oauth-client.ts  `flowStore: Pick<MfaChallengeStore, …>;`  (required)
//   lib/app.ts                   AppDeps.oauthClient.flowStore             (required)
//   lib/app.ts                   `flowStore: deps.oauthClient.flowStore`    (passed through)
//   lib/bootstrap.ts             `flowStore: mfaChallengeStore`             (the Redis store)
//   tests/…/build-test-app.ts    `flowStore: mfaChallengeStore`             (the in-memory twin)
//
// Reverting any one line below reds exactly the `it` that names it.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = resolve(HERE, '..', '..');
const read = (rel: string): string => readFileSync(resolve(SERVER_ROOT, rel), 'utf8');

describe('the v2 OAuth flow store is required at every hop and wired in production', () => {
  const routes = read('src/routes/auth-oauth-client.ts');
  const app = read('src/lib/app.ts');
  const bootstrap = read('src/lib/bootstrap.ts');
  const testApp = read('tests/integration/_helpers/build-test-app.ts');

  it('routes/auth-oauth-client.ts declares flowStore as a REQUIRED route dep (no `?`)', () => {
    // Reverting: auth-oauth-client.ts RegisterOAuthClientRoutesDeps.flowStore.
    expect(routes).toMatch(/^\s+flowStore: Pick<MfaChallengeStore, 'set' \| 'consume'>;$/m);
    expect(routes).not.toMatch(/flowStore\?:/);
  });

  it('app.ts declares AppDeps.oauthClient.flowStore as REQUIRED, with the same Pick', () => {
    // Reverting: app.ts AppDeps.oauthClient block. An optional field here compiles
    // and then throws at runtime on the first v2 /start.
    expect(app).toMatch(/^\s+flowStore: Pick<MfaChallengeStore, 'set' \| 'consume'>;$/m);
    expect(app).not.toMatch(/flowStore\?:/);
    expect(app).toMatch(
      /import type \{ MfaChallengeStore \} from '\.\.\/services\/mfa-challenge-store\.js';/,
    );
  });

  it('app.ts passes deps.oauthClient.flowStore into registerOAuthClientRoutes', () => {
    // Reverting: the registerOAuthClientRoutes(app, {...}) call in app.ts.
    expect(app).toMatch(
      /registerOAuthClientRoutes\(app, \{[\s\S]*?flowStore: deps\.oauthClient\.flowStore,[\s\S]*?\}\);/,
    );
  });

  it('bootstrap.ts wires the Redis MFA challenge store as the production flow store', () => {
    // Reverting: bootstrap.ts oauthClient literal. The store must be the
    // RedisMfaChallengeStore instance (GETDEL single-use), not a fresh Map.
    expect(bootstrap).toMatch(/const mfaChallengeStore = new RedisMfaChallengeStore\(redis\);/);
    expect(bootstrap).toMatch(
      /oauthClient: \{[\s\S]*?dashboardOrigin: config\.dashboardOrigin,[\s\S]*?flowStore: mfaChallengeStore,[\s\S]*?\},/,
    );
  });

  it('build-test-app.ts injects the in-memory twin so every integration test is wired', () => {
    // Reverting: build-test-app.ts oauthClient spread. Injected by the helper,
    // not per test, so no integration test can construct an unwired app.
    expect(testApp).toMatch(/const mfaChallengeStore = new InMemoryMfaChallengeStore\(\);/);
    expect(testApp).toMatch(
      /oauthClient: \{ \.\.\.opts\.oauthClient, flowStore: mfaChallengeStore \},/,
    );
  });
});
