// Cross-source invariant: OAuth-client server-side PKCE-verifier record TTL
// + state token TTL both = 5 minutes. The verifier record (Redis, keyed by
// the state nonce) MUST NOT outlive the state that names it, nor the state
// the record: drift either way is asymmetric expiry — a verifier lingering
// past its state (replay surface) or a state that still verifies after its
// verifier is gone (legitimate flows fail mid-handshake as state_replayed).
// Until 2026-09-14 the route-side half of this coupling was the PKCE
// cookie's Max-Age (COOKIE_TTL_SECONDS); the cookie is gone and the record
// TTL is the coupling now.

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

describe('OAuth-client 5-min-TTL cross-source invariant (verifier record ↔ state token)', () => {
  const routeSrc = read(ROUTE);
  const stateSrc = read(STATE);

  it('routes/auth-oauth-client VERIFIER_TTL_SECONDS = 300 with "5 min — matches state TTL" comment', () => {
    expect(routeSrc).toMatch(/const VERIFIER_TTL_SECONDS = 300; \/\/ 5 min — matches state TTL/);
  });

  it('lib/oauth-client-state DEFAULT_TTL_SECONDS = 300 with "5 minutes" comment', () => {
    expect(stateSrc).toMatch(/const DEFAULT_TTL_SECONDS = 300; \/\/ 5 minutes/);
  });

  it('Both constants extract to the same numeric value (300 seconds = 5 minutes)', () => {
    const routeMatch = routeSrc.match(/const VERIFIER_TTL_SECONDS = (\d+);/);
    const stateMatch = stateSrc.match(/const DEFAULT_TTL_SECONDS = (\d+);/);
    expect(routeMatch).not.toBeNull();
    expect(stateMatch).not.toBeNull();
    expect(routeMatch![1]).toBe(stateMatch![1]);
    expect(routeMatch![1]).toBe('300');
  });

  it('the route stores the verifier under VERIFIER_TTL_SECONDS at /start, and no cookie TTL survives to drift from it', () => {
    expect(routeSrc).toMatch(
      /await deps\.flowStore\.set\(verifierKey\(nonce\), verifier, VERIFIER_TTL_SECONDS\);/,
    );
    expect(routeSrc).not.toMatch(/COOKIE_TTL_SECONDS/);
    expect(routeSrc).not.toMatch(/Max-Age/);
  });

  it("routes/auth-oauth-client documents the record-state coupling: 'Verifier record lifetime — equals the state TTL; the state's iat check stays the authority, the record TTL only bounds Redis occupancy.' — pinned so the explicit cross-reference stays documented", () => {
    expect(routeSrc).toMatch(
      /Verifier record lifetime — equals the state TTL; the state's iat check\s*\*\s+stays the authority, the record TTL only bounds Redis occupancy\./,
    );
  });

  it("lib/oauth-client-state header documents the rationale for the short TTL: 'Lifetime: short (5 min default). The token is only in-flight' — pinned so the in-flight-only rationale stays documented", () => {
    expect(stateSrc).toMatch(
      /\/\/ Lifetime: short \(5 min default\)\. The token is only in-flight/,
    );
  });
});
