// Customer-facing input-limit doc ↔ schema cross-source invariant.
//
// The documented max-length / range for a customer input MUST equal the
// Zod-enforced limit. Both sides are already independently content-pinned
// (api-types-*-content-parity pins the schema; docs-*-content-parity pins
// the doc text), but nothing LINKS the two numbers. So a schema-only change
// — e.g. ProfileNameSchema `.max(120)` → `.max(150)` — updates the schema
// pin while the doc keeps saying "max 120 chars", silently telling
// customers the wrong limit (they'd size inputs to 120 and get a 400, or
// trust 120 when 150 is allowed). This test reads the enforced number from
// the schema source and asserts the doc states that same number, so the
// two cannot drift apart.
//
// Bounded `[\s\S]{0,N}?` lookaheads (never unbounded chains) keep the regex
// linear — no catastrophic backtracking on a fail-match.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const read = (p: string): string => readFileSync(resolve(REPO_ROOT, p), 'utf8');

const PROFILES_SCHEMA = read('packages/api-types/src/profiles.ts');
const ACCOUNTS_SCHEMA = read('packages/api-types/src/accounts.ts');
const PROFILES_DOC = read('apps/docs/src/pages/api/profiles.md');
const ACCOUNT_DOC = read('apps/docs/src/pages/api/account.md');

describe('customer input-limit doc ↔ schema cross-source invariant', () => {
  it('profile name max-length: ProfileNameSchema .max(N) == api/profiles.md "max N chars"', () => {
    const schemaMax = PROFILES_SCHEMA.match(
      /ProfileNameSchema = z[\s\S]{0,200}?\.max\((\d+)\)/,
    )?.[1];
    expect(schemaMax, 'ProfileNameSchema .max(N) not found in source').toBeDefined();
    expect(PROFILES_DOC, `api/profiles.md must state name "max ${schemaMax} chars"`).toContain(
      `max ${schemaMax} chars`,
    );
  });

  it('profile description max-length: profiles.ts description .max(N) == api/profiles.md "max N chars"', () => {
    const schemaMax = PROFILES_SCHEMA.match(/description: z\.string\(\)\.max\((\d+)\)/)?.[1];
    expect(schemaMax, 'description .max(N) not found in source').toBeDefined();
    expect(
      PROFILES_DOC,
      `api/profiles.md must state description "max ${schemaMax} chars"`,
    ).toContain(`max ${schemaMax} chars`);
  });

  it('account slug range: AccountSlugSchema .min(a).max(b) == api/account.md "a-b chars"', () => {
    const m = ACCOUNTS_SCHEMA.match(
      /AccountSlugSchema = z[\s\S]{0,120}?\.min\((\d+)\)[\s\S]{0,60}?\.max\((\d+)\)/,
    );
    expect(m, 'AccountSlugSchema .min(a).max(b) not found in source').not.toBeNull();
    const [, min, max] = m!;
    expect(ACCOUNT_DOC, `api/account.md must state slug "${min}-${max} chars"`).toContain(
      `${min}-${max} chars`,
    );
  });
});
