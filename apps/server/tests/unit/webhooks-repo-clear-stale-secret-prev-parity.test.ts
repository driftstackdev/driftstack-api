// v2-#31 — clearStaleSecretPrev cross-repo parity guard.
//
// The Drizzle path (apps/server/src/db/webhooks-repo.ts) and the
// in-memory path (apps/server/tests/integration/_helpers/
// in-memory-webhooks-repo.ts) MUST implement the same predicate
// semantics. Drift here means production behavior diverges from what
// integration tests observe — exactly the class of bug the
// W439.B-style content-parity tests are designed to catch.
//
// Pins both implementations' predicate to:
//   secretPrev IS NOT NULL
//   AND secretPrevExpiresAt IS NOT NULL
//   AND secretPrevExpiresAt < now
//
// And the mutation to: secret_prev := NULL, secret_prev_expires_at := NULL.
// Nothing else on the row touched. Return value is `{ cleared: count }`
// — counts MUST match across both impls (Drizzle returns rows.length
// of an `.returning({ id })`; in-memory increments a counter).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const DRIZZLE = resolve(REPO_ROOT, 'apps/server/src/db/webhooks-repo.ts');
const IN_MEMORY = resolve(
  REPO_ROOT,
  'apps/server/tests/integration/_helpers/in-memory-webhooks-repo.ts',
);

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('v2-#31 clearStaleSecretPrev Drizzle ↔ InMemory parity', () => {
  it('canonical source files exist', () => {
    expect(existsSync(DRIZZLE)).toBe(true);
    expect(existsSync(IN_MEMORY)).toBe(true);
  });

  it('Drizzle impl pins isNotNull(secretPrev) + isNotNull(secretPrevExpiresAt) + lt(secretPrevExpiresAt, now) predicate', () => {
    const body = read(DRIZZLE);
    // The impl uses drizzle-orm helpers; pin the AND-clause shape.
    expect(body).toMatch(
      /isNotNull\(webhookEndpoints\.secretPrev\),\s*isNotNull\(webhookEndpoints\.secretPrevExpiresAt\),\s*lt\(webhookEndpoints\.secretPrevExpiresAt,\s*args\.now\)/,
    );
  });

  it('Drizzle impl pins the mutation: secretPrev = null + secretPrevExpiresAt = null', () => {
    const body = read(DRIZZLE);
    expect(body).toMatch(/\.set\(\{\s*secretPrev:\s*null,\s*secretPrevExpiresAt:\s*null\s*\}\)/);
  });

  it('Drizzle impl returns { cleared: rows.length } so the count is wire-stable across the abstraction', () => {
    const body = read(DRIZZLE);
    expect(body).toMatch(/return\s*\{\s*cleared:\s*rows\.length\s*\}/);
  });

  it('InMemory impl pins the same predicate shape: secretPrev !== null && secretPrevExpiresAt !== null && secretPrevExpiresAt.getTime() < args.now.getTime()', () => {
    const body = read(IN_MEMORY);
    expect(body).toMatch(
      /r\.secretPrev\s*!==\s*null\s*&&\s*r\.secretPrevExpiresAt\s*!==\s*null\s*&&\s*r\.secretPrevExpiresAt\.getTime\(\)\s*<\s*args\.now\.getTime\(\)/,
    );
  });

  it('InMemory impl pins the same mutation: secretPrev = null + secretPrevExpiresAt = null (preserves every other field)', () => {
    const body = read(IN_MEMORY);
    expect(body).toMatch(/\.\.\.r,\s*secretPrev:\s*null,\s*secretPrevExpiresAt:\s*null,/);
  });

  it('InMemory impl returns { cleared } — variable named `cleared` so the parity test pins the same shape', () => {
    const body = read(IN_MEMORY);
    expect(body).toMatch(/return\s*Promise\.resolve\(\s*\{\s*cleared\s*\}\s*\)/);
  });
});
