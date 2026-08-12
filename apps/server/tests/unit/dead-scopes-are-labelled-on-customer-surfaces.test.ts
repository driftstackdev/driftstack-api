// A granular scope that no route enforces must not be DESCRIBED to customers as a capability.
//
// The repo already knew this rule and already followed it in one place: `scopes.md` marks
// `admin:webhooks` and `admin:api-keys` "Reserved." and says `write:webhooks` is "enforced on
// no route today", with a footnote explaining that webhook and API-key management gate on
// `account_owner` instead. That convention was applied by hand, so it was applied unevenly —
// `admin:profiles` was left reading "All admin operations on profiles.", and the two marketing
// pages describe all four dead scopes as working features ("Rotate webhook secrets + delete
// endpoints.", "Mint + revoke API keys.").
//
// Consequence for a customer: they mint a key with the scope the page describes, and every
// call 403s. It fails CLOSED — the key grants less than advertised, so there is no security
// exposure — but the docs sent them down a path that cannot work.
//
// This is a CROSS-SOURCE check, deliberately. It does not pin any wording. It derives the
// enforced set from the server's own `requireScope` / `throwIfMissingScope` call sites,
// subtracts that from the scope enum, and then requires every customer surface mentioning a
// leftover to mark it as not-yet-enforced. So the next dead scope is caught the day it is
// added to the enum, without anyone remembering this rule.
//
// The three surfaces below are the complete set, not a sample. Every non-test file under
// `apps/`, `packages/` and `docs/` naming one of these scopes was enumerated; the others —
// `apps/admin-panel/src/pages/api-keys.astro`, `apps/customer-dashboard/src/pages/api-keys.astro`,
// `packages/api-types/src/common.ts`, `packages/sdk-python/openapi.json` and its generated
// `models.py` — list scope NAMES with no description, so they assert nothing that can be false.
// If a description is ever added to one of them, add it here too.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const SERVER_SRC = resolve(REPO_ROOT, 'apps/server/src');

/** Verb-prefixed scopes only. The broad aliases (`read`, `admin`, `account_owner`, ...) are a
 *  different mechanism and are enforced everywhere. */
const GRANULAR_RE = /^(?:read|write|admin):[a-z-]+$/;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    // Migrations are historical SQL; a scope named there is not an enforcement site.
    if (entry === 'migrations' || entry === 'node_modules') continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (entry.endsWith('.ts')) out.push(p);
  }
  return out;
}

/** Every granular scope the server actually gates something on. */
function enforcedScopes(): Set<string> {
  const found = new Set<string>();
  for (const file of walk(SERVER_SRC)) {
    const src = readFileSync(file, 'utf8');
    // All three real shapes: `requireScope('x')` (route preHandler),
    // `requireScope(ctx, 'x')`, and the aliased service-layer
    // `throwIfMissingScope(ctx, 'x')`.
    for (const m of src.matchAll(
      /(?:requireScope|throwIfMissingScope|hasScope)\(\s*(?:ctx,\s*)?'([a-z:_-]+)'/g,
    )) {
      if (GRANULAR_RE.test(m[1]!)) found.add(m[1]!);
    }
  }
  return found;
}

/** The granular scopes a customer can be issued, read out of the enum. */
function declaredScopes(): string[] {
  const schema = readFileSync(resolve(SERVER_SRC, 'db/schema.ts'), 'utf8');
  const block = /apiKeyScope[^[]*\[([\s\S]*?)\]/.exec(schema)?.[1] ?? '';
  return [...block.matchAll(/'([a-z:_-]+)'/g)].map((m) => m[1]!).filter((s) => GRANULAR_RE.test(s));
}

/**
 * Customer-visible surfaces that enumerate scopes WITH a description, and how to read a
 * (scope, description) pair out of each.
 *
 * Only description rows are in scope. A prose mention that merely names a scope as an example
 * ("Narrow keys for `read:sessions`, `write:webhooks`") makes no capability claim, and neither
 * does the footnote that exists precisely to explain the restriction — the first draft of this
 * guard flagged all three and was wrong to. What is checkable is the row that tells a customer
 * what the scope DOES.
 */
const SURFACES = [
  {
    path: 'apps/docs/src/pages/reference/scopes.md',
    // `| `admin:profiles` | granular | All admin operations on profiles. |`
    row: (scope: string): RegExp =>
      new RegExp(`^\\|\\s*\`${scope}\`\\s*\\|\\s*granular\\s*\\|([^|]*)\\|`, 'm'),
  },
  {
    path: 'apps/marketing-site/src/pages/docs/api-keys.astro',
    row: (scope: string): RegExp => new RegExp(`name: '${scope}',\\s*desc: '([^']*)'`),
  },
  {
    path: 'apps/marketing-site/src/pages/docs/oauth-apps.astro',
    row: (scope: string): RegExp => new RegExp(`name: '${scope}',\\s*desc: '([^']*)'`),
  },
] as const;

/** Wording that honestly tells the reader the scope is not enforced yet. */
const LABELLED_RE =
  /reserved|enforced on no route|not enforced|no route requires|requires `?account_owner`?/i;

interface Described {
  readonly surface: string;
  readonly scope: string;
  readonly desc: string;
}

function descriptions(scopes: string[]): Described[] {
  const out: Described[] = [];
  for (const surface of SURFACES) {
    const text = readFileSync(resolve(REPO_ROOT, surface.path), 'utf8');
    for (const scope of scopes) {
      const desc = surface.row(scope).exec(text)?.[1];
      if (desc === undefined) continue;
      out.push({ surface: surface.path, scope, desc: desc.trim() });
    }
  }
  return out;
}

describe('dead granular scopes are labelled, not advertised', () => {
  const enforced = enforcedScopes();
  const declared = declaredScopes();
  const dead = declared.filter((s) => !enforced.has(s));
  const described = descriptions(declared);

  it('CRITICAL all three derivations found real data. If the enum scan, the call-site scan, or the description extraction came back empty, every check below would pass by comparing nothing to nothing — and this whole file would silently stop protecting anything.', () => {
    expect(declared.length, 'granular scopes in the api_key_scope enum').toBeGreaterThan(10);
    expect(enforced.size, 'granular scopes with at least one enforcement site').toBeGreaterThan(5);
    // Sanity-anchor on a scope known to be enforced, so a matcher that silently stops
    // matching cannot pass as "everything is enforced".
    expect(enforced, 'write:profiles is enforced on 13 route gates').toContain('write:profiles');
    expect(declared, 'the enum must include the dead one this file was written for').toContain(
      'admin:profiles',
    );

    // Every granular scope carries a description on every surface, so a row-extractor that
    // silently stops matching shows up here rather than as a clean pass.
    const missing: string[] = [];
    for (const surface of SURFACES) {
      for (const scope of declared) {
        if (!described.some((d) => d.surface === surface.path && d.scope === scope)) {
          missing.push(`${surface.path} :: ${scope}`);
        }
      }
    }
    expect(missing.sort(), 'scope description row(s) the extractor could not read:').toEqual([]);
  });

  it('CRITICAL every dead scope is labelled as unenforced wherever a customer surface describes it — a scope described as a capability that no route gates sends the customer to mint a key that 403s on every call', () => {
    const unlabelled = described
      .filter((d) => dead.includes(d.scope))
      .filter((d) => !LABELLED_RE.test(d.desc))
      .map((d) => `${d.surface} :: ${d.scope} — "${d.desc.slice(0, 70)}"`)
      .sort();

    expect(
      unlabelled,
      'customer surface(s) describing a scope no route enforces as though it worked — say it is reserved, or enforce it:',
    ).toEqual([]);
  });

  it('records WHICH scopes are currently dead, so the set shrinking or growing is a visible event rather than a silent one', () => {
    // Not a wording pin — the membership itself. Enforcing one of these, or adding a new
    // unenforced scope to the enum, should require touching this line deliberately.
    expect(dead.sort()).toEqual([
      'admin:api-keys',
      'admin:profiles',
      'admin:webhooks',
      'write:webhooks',
    ]);
  });
});
