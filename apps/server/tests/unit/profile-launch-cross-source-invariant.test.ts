// 2026-05-20 — antidetect-browser-style profile-launch arc.
// Cross-source invariant: the profile_id binding + POST /v1/profiles/:id/launch
// verb is pinned across:
//   - api-types CreateSessionRequestSchema (profile_id optional UUID)
//   - server routes/sessions.ts (validation + touch + launch endpoint)
//   - TS / Py / Go SDKs (profiles.launch helper)
//   - SDK type imports (Session passthrough on TS)
// Drift on any leg breaks the antidetect-browser UX paradigm — the
// GUI's Launch button is the single load-bearing flow this arc
// supports, and the harness will read profile_id off session metadata.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('Slice 1-2 — profile_id + POST /v1/profiles/:id/launch cross-source invariant', () => {
  it('api-types/src/sessions.ts CreateSessionRequestSchema includes profile_id as optional (prof_<uuid> or bare uuid; server normalizes) with the antidetect rationale comment', () => {
    const lib = resolve(REPO_ROOT, 'packages/api-types/src/sessions.ts');
    expect(existsSync(lib)).toBe(true);
    const body = read(lib);
    // V-1489 — was `profile_id: z\\.string\\(\\)\\.optional\\(\\)`. The accepted-input
    // contract (`prof_<uuid>` or a bare uuid) lived only in the server's
    // parseProfileId, so this schema could not express it and the document
    // published the field unconstrained. It is `ProfileIdInputSchema` now.
    expect(body).toMatch(/profile_id: ProfileIdInputSchema\.optional\(\),/);
    expect(body).toMatch(/2026-05-20 — profile binding\. When supplied/);
    expect(body).toMatch(/a profile_id outside it returns/);

    // V-1101 — the scope the docstring states is derived from the route that
    // enforces it rather than restated here. The docstring said "the calling
    // account" while sessions.ts scopes the lookup to the team-resolved owner,
    // and two pins froze the wrong side of that.
    const route = read(resolve(REPO_ROOT, 'apps/server/src/routes/sessions.ts'));
    expect(
      route,
      'the profile lookup is no longer scoped to the team-resolved owner, so the EFFECTIVE-account ' +
        'wording in api-types is now the wrong one',
    ).toMatch(
      /const ownerAccountId = effective\.kind === 'team' \? effective\.accountId : ctx\.account\.id;/,
    );
    expect(route, 'resolveProfileBinding is no longer called with the owner account').toMatch(
      /resolveProfileBinding\(profileBareId, ownerAccountId, ownerTier\)/,
    );
  });

  it('server/src/routes/sessions.ts resolveProfileBinding helper validates ownership + inherits archetype + stamps metadata', () => {
    const lib = resolve(REPO_ROOT, 'apps/server/src/routes/sessions.ts');
    const body = read(lib);
    expect(body).toMatch(/async function resolveProfileBinding\(/);
    expect(body).toMatch(/await profilesService\.get\(\{ id: profileId, accountId \}\);/);
    expect(body).toMatch(/metadata: \{ profile_id: profile\.id, profile_name: profile\.name \}/);
  });

  it('server/src/routes/sessions.ts POST /v1/sessions resolves profile_id from body + bumps last_used_at fire-and-forget', () => {
    const lib = resolve(REPO_ROOT, 'apps/server/src/routes/sessions.ts');
    const body = read(lib);
    expect(body).toMatch(/body\.profile_id !== undefined/);
    expect(body).toMatch(
      /\.touch\(\{ id: profileId, accountId: ownerAccountId, at: new Date\(\) \}\)\s*\n?\s*\.catch\(\(\) => undefined\)/,
    );
  });

  it('server/src/routes/sessions.ts registers a strict max-120 profile launch with fail-closed direct egress before ownership flow', () => {
    const lib = resolve(REPO_ROOT, 'apps/server/src/routes/sessions.ts');
    const body = read(lib);
    expect(body).toMatch(/'\/v1\/profiles\/:id\/launch'/);
    expect(body).toMatch(
      /\/\^prof_\(\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{12\}\)\$\/\s*\.exec\(/,
    );
    expect(body).toMatch(/LaunchProfileRequestSchema\.parse\(rawBody\)/);
    expect(body).toMatch(/assertDirectSessionEgressAvailable\(rawBody, egressProxyRequired\)/);
    expect(body).toMatch(/label: launchBody\.label/);
    expect(body).not.toMatch(/A proxy configuration is required to launch a profile/);
  });

  it('api-types and OpenAPI share the strict canonical launch schema', () => {
    const apiTypes = read(resolve(REPO_ROOT, 'packages/api-types/src/sessions.ts'));
    const openapi = read(resolve(REPO_ROOT, 'apps/server/src/lib/openapi.ts'));
    expect(apiTypes).toMatch(/export const SessionLabelSchema = z\.string\(\)\.max\(120\);/);
    expect(apiTypes).toMatch(
      /LaunchProfileRequestSchema = CreateSessionRequestSchema\.pick\(\{ label: true \}\)\.strict\(\)/,
    );
    expect(openapi).toMatch(/LaunchProfileRequestSchema\.openapi\('LaunchProfileRequest'\)/);
  });

  it('TS SDK profiles.ts exposes launch(id, body?) returning Promise<Session>, with NO proxy field (removed — /v1/sessions has no driver-layer proxy plumbing yet; see agentSessions.create({ proxy_id }) for real customer egress)', () => {
    const lib = resolve(REPO_ROOT, 'packages/sdk-typescript/src/resources/profiles.ts');
    const body = read(lib);
    expect(body).toMatch(
      /launch\(\s*\n?\s*id: string,\s*\n?\s*body: \{ label\?: string \} = \{\}\s*,?\s*\n?\s*\): Promise<Session>/,
    );
    expect(body).toMatch(/path: `\/v1\/profiles\/\$\{encodeURIComponent\(id\)\}\/launch`,/);
    expect(body).not.toMatch(/proxy\?: unknown/);
    expect(body).toMatch(/agentSessions\.create\(\{ proxy_id \}\)/);
  });

  it('Python SDK profiles.py exposes def launch + async def launch (sync + async mirrors), docstring no longer claims a proxy override', () => {
    const lib = resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/resources/profiles.py');
    const body = read(lib);
    expect(body).toMatch(
      /def launch\(self, profile_id: str, body: dict\[str, Any\] \| None = None\) -> dict\[str, Any\]:/,
    );
    expect(body).toMatch(
      /async def launch\(\s*\n?\s*self, profile_id: str, body: dict\[str, Any\] \| None = None\s*\n?\s*\) -> dict\[str, Any\]:/,
    );
    expect(body).toMatch(/f"\/v1\/profiles\/\{quote\(profile_id, safe=''\)\}\/launch"/);
    expect(body).not.toMatch(/accepts optional ``proxy`` \+ ``label`` overrides/);
  });

  it("Go SDK profiles.go exposes LaunchProfileRequest + Launch method returning *Session, with NO Proxy field (removed — customer-configurable egress isn't wired for /v1/sessions yet)", () => {
    const lib = resolve(REPO_ROOT, 'packages/sdk-go/profiles.go');
    const body = read(lib);
    expect(body).toMatch(/type LaunchProfileRequest struct \{[\s\S]*?Label string/);
    expect(body).not.toMatch(/Proxy any/);
    expect(body).toMatch(
      /func \(r \*ProfilesResource\) Launch\(\s*\n?\s*ctx context\.Context,\s*\n?\s*profileID string,\s*\n?\s*body \*LaunchProfileRequest,\s*\n?\s*\) \(\*Session, error\)/,
    );
    expect(body).toMatch(/"\/v1\/profiles\/" \+ url\.PathEscape\(profileID\) \+ "\/launch"/);
  });
});
