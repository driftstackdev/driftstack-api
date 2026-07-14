// W392.C — drift guard for apps/server/src/lib/errors-helpers.ts.
// V-174 + V-481 scope-check helpers + V-485 per-tier feature guard.
// requireScope/hasScope are mirrored in services/auth.ts — keeping
// the predicate at both call sites in sync is the whole point of this
// module. Drift here re-classifies authorization decisions silently.
//
//   • V-174 legacy customer alias: 'admin' satisfies 'account_owner'
//     but never the exact 'driftstack_internal_admin' staff boundary.
//   • V-481 broad-satisfies-granular: required `read:X` satisfied by
//     `read` or `account_owner`; granular does NOT satisfy broad.
//   • requireScope: throws ForbiddenError; mirrored in
//     services/auth.ts::requireScope.
//   • hasScope: pure predicate (V-481 export).
//   • V-485 requireTierFeature: throws when TIER_FEATURES[tier]
//     [feature] is false; replaces scattered `if (tier==='X' || …)`
//     conditionals.
//   • Today's gated feature: only `aiAgent`. `trialPack` is read-side
//     decision (apiKeyEnvironment).
//   • Re-exports NotFoundError for ergonomic single-import.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/lib/errors-helpers.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W392.C apps/server/src/lib/errors-helpers.ts content parity', () => {
  const body = read(LIB);

  it('Module framing: helpers next to errors.ts so services skip auth-service import', () => {
    expect(body).toMatch(
      /Helpers that need the AccountContext type but live next to errors\.ts so\s*\n?\s*\/\/\s*services can import without pulling the auth service/,
    );
  });

  it('V-174 + V-481 scope-check framing pinned (exact / customer-only alias / broad-satisfies-granular)', () => {
    expect(body).toMatch(/V-174 \+ V-481 — scope check with backwards-compat aliases\./);
    expect(body).toMatch(/1\. Exact match — the key carries the required scope verbatim\./);
    expect(body).toMatch(
      /2\. V-174 legacy customer alias — `'admin'`-scoped keys satisfy\s*\n?\s*\*\s*`'account_owner'` so pre-split customer automation keeps its own-account\s*\n?\s*\*\s*authority\. The expired migration bridge to\s*\n?\s*\*\s*`'driftstack_internal_admin'` is deliberately closed: only the exact\s*\n?\s*\*\s*staff scope can authorize cross-account operations/,
    );
    expect(body).toMatch(
      /3\. V-481 broad-satisfies-granular — when the required scope is\s*\n?\s*\*\s*granular \(`read:sessions`, `admin:profiles`, etc\.\), the key's\s*\n?\s*\*\s*broad scopes can satisfy it on the same verb:/,
    );
  });

  it('V-481 verb-table framing: read/write/admin granular each satisfied by matching broad or account_owner', () => {
    expect(body).toMatch(
      /required `read:X` is satisfied by any of `read`,\s*\n?\s*\*\s*`account_owner` \(read implied by full account access\)/,
    );
    expect(body).toMatch(/required `write:X` is satisfied by `write`, `account_owner`/);
    expect(body).toMatch(/required `admin:X` is satisfied by `account_owner`, `admin`/);
  });

  it('"granular do NOT satisfy broad" framing pinned (narrow keys stay narrow)', () => {
    expect(body).toMatch(
      /Granular scopes do NOT satisfy broad checks — a key with\s*\n?\s*\*\s*`read:sessions` cannot pass `requireScope\('read'\)`\. That's\s*\n?\s*\*\s*the point of granular scoping; narrow keys stay narrow/,
    );
  });

  it('Mirrored-in-auth-service framing pinned (services/auth.ts::requireScope same predicate)', () => {
    expect(body).toMatch(
      /Mirrored in `services\/auth\.ts::requireScope` \(kept in sync — same\s*\n?\s*\*\s*predicate evaluated at both call sites\)/,
    );
  });

  it('requireScope: throws ForbiddenError with "requires X scope" detail', () => {
    expect(body).toMatch(
      /export function requireScope\(ctx: AccountContext, required: ApiKeyScope\): void \{\s*\n?\s*if \(hasScope\(ctx, required\)\) return;\s*\n?\s*throw new ForbiddenError\(`This action requires the "\$\{required\}" scope\.`\);/,
    );
  });

  it('hasScope: pure predicate keeps the V-174 alias customer-only before the V-481 verb-table', () => {
    expect(body).toMatch(
      /V-481 — pure predicate version of \{@link requireScope\}\. Returns\s*\n?\s*\*\s*true iff the key satisfies the required scope/,
    );
    expect(body).toMatch(/if \(scopes\.includes\(required\)\) return true;/);
    expect(body).toMatch(
      /\/\/ V-174 legacy customer alias\. Never satisfies the staff-only scope\./,
    );
    expect(body).toMatch(
      /if \(required === 'account_owner' && scopes\.includes\('admin'\)\) \{\s*\n?\s*return true;\s*\n?\s*\}/,
    );
    expect(body).toMatch(/\/\/ V-481 broad satisfies granular on the same verb\./);
  });

  it('hasScope: verb switch — read/write/admin each → includes(matching broad) || includes(account_owner)', () => {
    expect(body).toMatch(
      /case 'read':\s*\n?\s*return scopes\.includes\('read'\) \|\| scopes\.includes\('account_owner'\);/,
    );
    expect(body).toMatch(
      /case 'write':\s*\n?\s*return scopes\.includes\('write'\) \|\| scopes\.includes\('account_owner'\);/,
    );
    expect(body).toMatch(
      /case 'admin':\s*\n?\s*return scopes\.includes\('admin'\) \|\| scopes\.includes\('account_owner'\);/,
    );
  });

  it('hasScope: exhaustive default branch with _exhaustive: never assertion', () => {
    expect(body).toMatch(
      /default: \{\s*\n?\s*const _exhaustive: never = granular\.verb;\s*\n?\s*return _exhaustive;\s*\n?\s*\}/,
    );
  });

  it('V-485 requireTierFeature framing + today-only-aiAgent-gated note', () => {
    expect(body).toMatch(
      /V-485 — per-tier feature guard\. Throws `ForbiddenError` when the\s*\n?\s*\*\s*given tier does NOT have the requested boolean feature enabled/,
    );
    expect(body).toMatch(
      /The single guard call replaces\s*\n?\s*\*\s*`if \(tier === 'X' \|\| tier === 'Y'\) throw …` style scattered\s*\n?\s*\*\s*conditionals — when a tier's feature row in\s*\n?\s*\*\s*`packages\/api-types\/src\/common\.ts:TIER_FEATURES` flips, every\s*\n?\s*\*\s*call site picks it up automatically/,
    );
    expect(body).toMatch(/Today's matrix: only `aiAgent` is gated this way\. Future features/);
    expect(body).not.toMatch(/trialPack/);
  });

  it('requireTierFeature: signature + TIER_FEATURES[tier][feature] check + ForbiddenError detail', () => {
    expect(body).toMatch(
      /export function requireTierFeature\(tier: AccountTier, feature: TierBooleanFeature\): void \{\s*\n?\s*if \(TIER_FEATURES\[tier\]\[feature\]\) return;\s*\n?\s*throw new ForbiddenError\(\s*\n?\s*`The "\$\{feature\}" feature is not available on the "\$\{tier\}" tier\. ` \+\s*\n?\s*`Upgrade to a tier that includes this feature\.`,/,
    );
  });

  it('Re-exports NotFoundError for ergonomic single-import surface', () => {
    expect(body).toMatch(/export \{ NotFoundError \};/);
  });

  it('imports: parseGranularScope + TIER_FEATURES + 3 types from @driftstack/api-types + AccountContext + ForbiddenError/NotFoundError', () => {
    expect(body).toMatch(
      /import \{\s*\n?\s*parseGranularScope,\s*\n?\s*TIER_FEATURES,\s*\n?\s*type AccountTier,\s*\n?\s*type ApiKeyScope,\s*\n?\s*type TierBooleanFeature,\s*\n?\s*\} from '@driftstack\/api-types';/,
    );
    expect(body).toMatch(/import type \{ AccountContext \} from '\.\.\/services\/auth\.js';/);
    expect(body).toMatch(/import \{ ForbiddenError, NotFoundError \} from '\.\/errors\.js';/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
