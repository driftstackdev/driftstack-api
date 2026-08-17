// What a third-party OAuth client is allowed to ask for.
//
// `OAUTH_ALLOWED_SCOPES` states its own intent: "an allowlist rather than a
// privileged-scope denylist: newly added API-key scopes and deprecated broad
// aliases must never become OAuth-authorizable by accident."
//
// The mechanism is well covered. `authorize` rejects a request carrying any
// non-allowlisted scope; `approveAuthorization` re-filters as defence in depth
// (`oauth.test.ts` injects a pending row with `read` + `account_owner` past the
// staging gate and asserts only `read:sessions` survives); and the approver
// intersection is pinned too.
//
// What is NOT pinned is the POLICY — which scopes belong in the list. One arm
// elsewhere asserts `gui_control` stays out. Nothing asserts the same of
// `driftstack_internal_admin`, `admin`, `account_owner`, `read` or `write`, so
// adding any of those to the allowlist passes the whole suite: the injected-row
// arm only names two of them, and the coverage tools see a set literal either
// way.
//
// The rule is derived from the two sources rather than hard-coded, so it keeps
// holding as scopes are added:
//
//   granular scopes carry a verb:resource colon (`read:sessions`). The broad and
//   privileged ones — read, write, admin, account_owner, gui_control,
//   driftstack_internal_admin — do not. So "no colon ⇒ must not be
//   OAuth-authorizable" is the allowlist's shape expressed as a check, and a NEW
//   broad scope added to ApiKeyScope is covered the moment it is added.
//
// The structural assertions are then tied to behaviour: each excluded scope is
// actually refused by `authorize`. A policy check that only reads text would
// pass if the allowlist were correct but no longer consulted.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { InMemoryOAuthStore, OAuthError, OAuthService } from '../../src/services/oauth.js';
import { computeS256Challenge } from '../../src/lib/oauth-pkce.js';
import type { ApiKeyScope } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (rel: string): string => readFileSync(resolve(HERE, '../..', rel), 'utf8');

/** Members of a source-declared list, with line comments stripped first. */
function stringMembers(block: string): string[] {
  return [...block.replace(/\/\/[^\n]*/g, '').matchAll(/'([a-z0-9_:-]+)'/g)].map((m) => m[1]!);
}

function apiKeyScopes(): string[] {
  const src = readFileSync(resolve(HERE, '../../../../packages/api-types/src/common.ts'), 'utf8');
  const block = /ApiKeyScopeSchema\s*=\s*z\.enum\(\[([\s\S]*?)\]\)/.exec(src);
  expect(block, 'the ApiKeyScope enum could not be located').not.toBeNull();
  return stringMembers(block?.[1] ?? '');
}

function oauthAllowedScopes(): string[] {
  const src = read('src/services/oauth.ts');
  const block = /OAUTH_ALLOWED_SCOPES[^=]*=\s*new Set\(\[([\s\S]*?)\]\)/.exec(src);
  expect(block, 'the OAuth allowlist could not be located').not.toBeNull();
  return stringMembers(block?.[1] ?? '');
}

/** Broad/privileged scopes are the ones without a verb:resource colon. */
const isBroad = (scope: string): boolean => !scope.includes(':');

describe('the OAuth scope allowlist admits only granular scopes', () => {
  it('CRITICAL both source lists parse to a real population', () => {
    // Without this, a rename or reshape turns every assertion below into a
    // comparison of two empty arrays.
    expect(apiKeyScopes().length, 'the ApiKeyScope union parsed empty').toBeGreaterThanOrEqual(15);
    expect(oauthAllowedScopes().length, 'the OAuth allowlist parsed empty').toBeGreaterThanOrEqual(
      10,
    );
  });

  it('CRITICAL every allowlisted scope is a real ApiKeyScope', () => {
    const union = new Set(apiKeyScopes());
    const unknown = oauthAllowedScopes().filter((s) => !union.has(s));
    expect(
      unknown,
      'the allowlist names a scope that is not in the ApiKeyScope union. A typo here is silent — ' +
        'the scope simply never matches, so the integration it was added for stays unauthorizable ' +
        'with no error anywhere',
    ).toEqual([]);
  });

  it('CRITICAL no BROAD or privileged scope is OAuth-authorizable', () => {
    const allowed = new Set(oauthAllowedScopes());
    const leaked = apiKeyScopes().filter((s) => isBroad(s) && allowed.has(s));
    expect(
      leaked,
      'a broad or privileged scope is OAuth-authorizable. These are the account-wide grants — a ' +
        'third-party app holding one is not scoped to a resource at all, which is the exact ' +
        'accident the allowlist exists to prevent',
    ).toEqual([]);
    // And the rule is not vacuous: broad scopes DO exist in the union.
    expect(
      apiKeyScopes().filter(isBroad).length,
      'no broad scopes were found, so the exclusion above asserted nothing',
    ).toBeGreaterThanOrEqual(4);
  });

  it('CRITICAL each excluded scope is actually refused by authorize()', async () => {
    // Ties the policy to the mechanism. A text-only check would still pass if
    // the allowlist were correct but no longer consulted at the gate.
    const store = new InMemoryOAuthStore();
    const svc = new OAuthService(store);
    const client = await svc.registerClient({
      label: 'Third-party App',
      redirect_uris: ['https://app.example/cb'],
    });
    const excluded = apiKeyScopes().filter(isBroad);

    for (const scope of excluded) {
      await expect(
        svc.authorize({
          client_id: client.client_id,
          redirect_uri: 'https://app.example/cb',
          state: 'state',
          code_challenge: computeS256Challenge(randomBytes(48).toString('base64url').slice(0, 64)),
          code_challenge_method: 'S256',
          scope: [scope as ApiKeyScope],
        }),
        `authorize() accepted the broad scope "${scope}"`,
      ).rejects.toBeInstanceOf(OAuthError);
    }
  });

  it('CRITICAL a granular scope is still accepted, so the gate is not refusing everything', async () => {
    const store = new InMemoryOAuthStore();
    const svc = new OAuthService(store);
    const client = await svc.registerClient({
      label: 'Third-party App',
      redirect_uris: ['https://app.example/cb'],
    });
    const pending = await svc.authorize({
      client_id: client.client_id,
      redirect_uri: 'https://app.example/cb',
      state: 'state',
      code_challenge: computeS256Challenge(randomBytes(48).toString('base64url').slice(0, 64)),
      code_challenge_method: 'S256',
      scope: ['read:sessions'],
    });
    expect(
      pending.authorization_id,
      'a legitimate granular request was refused — the arms above would then prove nothing',
    ).toBeTruthy();
  });
});
