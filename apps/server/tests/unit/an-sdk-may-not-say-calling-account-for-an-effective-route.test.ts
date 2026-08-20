// V-1124 — one claim produced five findings, so it gets a guard instead of a sixth.
//
// V-1101, V-1103, V-1121, V-1122 and V-1123 were all the same sentence: a doc or an
// SDK saying a surface is scoped to the CALLING account where the route resolves an
// EFFECTIVE one. Under `X-Driftstack-Account` a team admin acts as the owner, so the
// difference is whose data comes back — and the wrong version reads as a reassurance
// rather than an error, which is why it survived three sweeps looking for it.
//
// Fixing the sentence five times did not stop the sixth. This derives the pairing
// instead.
//
// ── What is derived, and what is not ────────────────────────────────────────
//
// TypeScript SDK resources are named after their route module — `webhooks.ts` for
// `routes/webhooks.ts`, `profiles.ts` for `routes/profiles.ts`. Twelve of the
// nineteen pair that way, and for those the map needs no maintenance: the guard reads
// the route, decides whether its list handler resolves an effective account, and
// requires the docstrings to match.
//
// Seven do NOT pair, because their routes live under a different name — `account`,
// `api-keys`, `audit-log`, `crypto-orders`, `egress`, `mfa`, `usage`. A hand-written
// map for those would be the roster-is-its-own-population shape this suite has spent
// V-1106 through V-1113 removing, so they are OUT OF SCOPE and said to be, rather
// than covered by a list someone has to remember. `audit-log` in particular IS
// effective-scoped and was corrected by hand in V-1123; this guard cannot see it.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const SDK = resolve(REPO_ROOT, 'packages/sdk-typescript/src/resources');
const ROUTES = resolve(REPO_ROOT, 'apps/server/src/routes');

/** SDK resources whose route module carries a different filename. */
const UNPAIRED = ['account', 'api-keys', 'audit-log', 'crypto-orders', 'egress', 'mfa', 'usage'];

/** Resource names that exist on both sides, so the pairing is derived. */
function pairedResources(): string[] {
  const sdk = readdirSync(SDK)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => f.slice(0, -3));
  return sdk.filter((n) => existsSync(resolve(ROUTES, `${n}.ts`))).sort();
}

/**
 * Whether the route module resolves an effective account anywhere.
 *
 * Deliberately file-wide rather than per-handler. V-1123 spent three attempts on a
 * per-handler window and got a different answer each time — too narrow missed the
 * resolution, too wide caught the next handler, and keying on an `effectiveAccountId:`
 * option missed the two modules that pass `effective.accountId` positionally. A module
 * that resolves an effective account ANYWHERE is one whose docstrings must not promise
 * caller-only scoping, which is the property this guard actually needs.
 */
function resolvesEffective(resource: string): boolean {
  const src = readFileSync(resolve(ROUTES, `${resource}.ts`), 'utf8').replace(/\/\/[^\n]*/g, '');
  return /effectiveAccountIdFor|resolveEffectiveAccount|effective\.accountId|eff\.accountId/.test(
    src,
  );
}

/** Doc-comment lines in an SDK resource that promise calling-account scoping. */
function callingAccountLines(resource: string): string[] {
  const src = readFileSync(resolve(SDK, `${resource}.ts`), 'utf8');
  return (
    src
      .split('\n')
      .map((l, i) => [l, i + 1] as const)
      .filter(([l]) => /^\s*(\/\*\*|\*|\/\/)/.test(l))
      .filter(([l]) => /\bthe calling account\b|\bcalling account's\b/.test(l))
      // A retraction has to be able to name what it retracts.
      .filter(([l]) => !/V-\d{3,4}/.test(l))
      .map(([l, n]) => `${resource}.ts:${String(n)} ${l.trim().slice(0, 72)}`)
  );
}

describe('V-1124 an SDK may not say calling account for an effective-scoped route', () => {
  it('CRITICAL the pairing really resolved, and both detectors discriminate. The comparison below reports an ABSENCE, so a pairing that matched nothing would report every SDK clean having read none of them.', () => {
    const paired = pairedResources();
    expect(
      paired.length,
      'SDK resources paired to a same-named route module',
    ).toBeGreaterThanOrEqual(10);
    expect(paired, 'the webhooks pairing is the one V-1122 turned on').toContain('webhooks');

    // The effective-account detector must separate the two known cases.
    expect(resolvesEffective('webhooks'), 'webhooks resolves an effective account').toBe(true);
    expect(resolvesEffective('legal'), 'legal is caller-scoped').toBe(false);
  });

  it('CRITICAL no SDK resource promises calling-account scoping for a route that resolves an effective account. Under X-Driftstack-Account a team admin acts as the owner, so this sentence tells a customer the wrong data comes back — and it reads as a reassurance, which is how it survived being corrected five times.', () => {
    const offenders = pairedResources()
      .filter((r) => resolvesEffective(r))
      .flatMap((r) => callingAccountLines(r))
      .sort();
    expect(
      offenders,
      'these SDK doc comments promise the calling account on a route that resolves an effective ' +
        'one — say EFFECTIVE, or explain which surface really is caller-only:',
    ).toEqual([]);
  });

  it('CRITICAL the unpaired list names resources this guard cannot reach, and every one is really unpaired. An entry that has since gained a same-named route module would silently drop out of the check above while still looking excused.', () => {
    const stillUnpaired = UNPAIRED.filter((n) => !existsSync(resolve(ROUTES, `${n}.ts`)));
    expect(
      UNPAIRED.filter((n) => existsSync(resolve(ROUTES, `${n}.ts`))),
      'these are listed as unpaired but a same-named route module now exists — drop them from ' +
        'UNPAIRED so the derived check covers them:',
    ).toEqual([]);
    expect(stillUnpaired.length, 'resources genuinely outside the pairing').toBe(UNPAIRED.length);
  });
});
