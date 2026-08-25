// Cross-source invariant: OAuth-client PKCE cookie + state JWT TTL
// both = 5 minutes. The cookie's Max-Age MUST match the state JWT TTL
// so a verifier outlives its signing state (and vice versa). Drift
// would create asymmetric expiry → either the cookie carries a
// verifier longer than the state token validates (replay risk) or
// the state outlives the cookie (legitimate flows fail mid-handshake).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/auth-oauth-client.ts');
const STATE = resolve(REPO_ROOT, 'apps/server/src/lib/oauth-client-state.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('OAuth-client 5-min-TTL cross-source invariant (PKCE cookie ↔ state JWT)', () => {
  const routeSrc = read(ROUTE);
  const stateSrc = read(STATE);

  it('routes/auth-oauth-client COOKIE_TTL_SECONDS = 300 with "5 min — matches state TTL" comment', () => {
    expect(routeSrc).toMatch(/const COOKIE_TTL_SECONDS = 300; \/\/ 5 min — matches state TTL/);
  });

  it('lib/oauth-client-state DEFAULT_TTL_SECONDS = 300 with "5 minutes" comment', () => {
    expect(stateSrc).toMatch(/const DEFAULT_TTL_SECONDS = 300; \/\/ 5 minutes/);
  });

  it('Both constants extract to the same numeric value (300 seconds = 5 minutes)', () => {
    const routeMatch = routeSrc.match(/const COOKIE_TTL_SECONDS = (\d+);/);
    const stateMatch = stateSrc.match(/const DEFAULT_TTL_SECONDS = (\d+);/);
    expect(routeMatch).not.toBeNull();
    expect(stateMatch).not.toBeNull();
    expect(routeMatch![1]).toBe(stateMatch![1]);
    expect(routeMatch![1]).toBe('300');
  });

  it("routes/auth-oauth-client header explicitly documents the cookie-state TTL coupling: 'Cookie path is restricted to /v1/auth/oauth-client and 5-min Max-Age matches the state TTL.' — pinned so the explicit cross-reference stays documented (drift on one without the other would orphan this guarantee)", () => {
    expect(routeSrc).toMatch(
      /Cookie path is restricted to \/v1\/auth\/oauth-client and 5-min Max-\s*\/\/ Age matches the state TTL\./,
    );
  });

  it("lib/oauth-client-state header documents the rationale for the short TTL: 'Lifetime: short (5 min default). The token is only in-flight' — pinned so the in-flight-only rationale stays documented", () => {
    expect(stateSrc).toMatch(
      /\/\/ Lifetime: short \(5 min default\)\. The token is only in-flight/,
    );
  });
});
