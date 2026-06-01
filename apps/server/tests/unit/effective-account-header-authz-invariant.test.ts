// Cross-route authz invariant — every X-Driftstack-Account ("acting-as") header
// read MUST go through the membership-validating resolver.
//
// `readEffectiveAccountHeader(req)` (lib/effective-account-header.ts) only PARSES
// the X-Driftstack-Account header — it does NOT authorize. The authorization
// lives in `resolveEffectiveAccount(ctx, header)` (services/auth.ts), which 403s
// unless `ctx.teams` proves the caller is a member of the requested owner
// account. So a route that uses the raw parsed header WITHOUT passing it through
// `resolveEffectiveAccount` would be a cross-account IDOR: anyone could set
// `X-Driftstack-Account: acc_<victim>` and operate on the victim's resources.
//
// The parser + resolver are each unit-tested in isolation, but nothing pinned
// that every CALL SITE pairs them. This invariant does: across all of routes/,
// (1) every `readEffectiveAccountHeader(` call appears inside a
// `resolveEffectiveAccount(ctx, readEffectiveAccountHeader(` wrapper, and
// (2) no route accesses the raw header by any other means. A new route that
// reads the header unvalidated — or grabs it raw off req.headers — fails here.

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROUTES_DIR = resolve(HERE, '..', '..', 'src', 'routes');

function allRoutesSource(): string {
  return readdirSync(ROUTES_DIR)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => readFileSync(resolve(ROUTES_DIR, f), 'utf8'))
    .join('\n');
}

function count(haystack: string, needle: string): number {
  // Count non-overlapping occurrences of a literal substring.
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    n += 1;
    i = haystack.indexOf(needle, i + needle.length);
  }
  return n;
}

describe('X-Driftstack-Account acting-as authz invariant (all routes/)', () => {
  const src = allRoutesSource();
  // `(` excludes the `import { readEffectiveAccountHeader }` lines (no paren).
  const reads = count(src, 'readEffectiveAccountHeader(');
  const validatedReads = count(src, 'resolveEffectiveAccount(ctx, readEffectiveAccountHeader(');

  it('sanity — the acting-as header IS read somewhere (invariant is not vacuous)', () => {
    expect(reads).toBeGreaterThan(0);
  });

  it('EVERY readEffectiveAccountHeader() call site is wrapped in resolveEffectiveAccount(ctx, …) — an unvalidated read would be a cross-account IDOR', () => {
    // `resolveEffectiveAccount(ctx, readEffectiveAccountHeader(` CONTAINS a
    // `readEffectiveAccountHeader(`, so validatedReads <= reads always; equality
    // proves no read escapes the membership check. A raw `const h =
    // readEffectiveAccountHeader(req)` would make reads > validatedReads.
    expect(validatedReads).toBe(reads);
  });

  it('no route accesses the raw X-Driftstack-Account header (must go through the parser+resolver, never req.headers directly)', () => {
    // The only legitimate reader is lib/effective-account-header.ts; route code
    // must never grab the header off the request itself.
    expect(src.toLowerCase()).not.toContain("headers['x-driftstack-account']");
    expect(src.toLowerCase()).not.toContain('headers["x-driftstack-account"]');
    expect(src.toLowerCase()).not.toContain("'x-driftstack-account'");
    expect(src.toLowerCase()).not.toContain('"x-driftstack-account"');
  });
});
