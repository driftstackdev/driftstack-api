// V-905 — the operator-facing env spec is missing 26 variables the server reads.
//
// `docs/operations/production-env-schema.md` calls itself the cheat sheet and
// names `docs/deployment/env-vars.md` as "the longer per-variable spec
// (defaults, allowed values, behaviour-on-absent)". That spec is what an
// operator provisions from. It does not mention `PROFILE_MASTER_KEY`,
// `NOWPAYMENTS_IPN_SECRET`, `OAUTH_CLIENT_SIGNING_SECRET`, the Google/GitHub
// OAuth credentials, the LiveKit trio, `TRUST_PROXY`, `METRICS_SCRAPE_TOKEN` or
// `DRIFTSTACK_FLEET_INTERNAL_TOKEN`, among others.
//
// Most are documented SOMEWHERE — the go-live runbook, an internal design note,
// the verification log. That is the problem rather than the mitigation: the
// operator reads the spec, and a variable whose only home is a design document
// from June is one nobody provisions.
//
// WHY A CEILING RATHER THAN A FIX. Writing the missing entries means stating a
// default, an allowed range and an on-absent behaviour for each — for profile
// encryption keys, an IPN signing secret and OAuth credentials. Getting that
// wrong in an operator document is worse than the gap, and the values are
// deployment facts I cannot verify from source. So this records the exact set
// and holds it as a ceiling: it may fall as entries are written, never rise.
//
// A NEW undocumented variable fails immediately, which is the case worth
// catching — the existing 26 are a known debt, and the next one would be silent.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readdirSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const SPEC = resolve(REPO_ROOT, 'docs/deployment/env-vars.md');
const SRC = resolve(REPO_ROOT, 'apps/server/src');

/**
 * Read but absent from the operator spec, measured 2026-08-18. A CEILING, not a
 * target: every entry is a variable an operator provisioning from the spec would
 * not know to set. Delete entries as they are documented; never add.
 */
const UNDOCUMENTED_CEILING = 26;

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = resolve(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

/** Every env var the server reads, via the config loader or `process.env` directly. */
function readVars(): string[] {
  const found = new Set<string>();
  const cfg = readFileSync(resolve(SRC, 'lib/config.ts'), 'utf8');
  for (const m of cfg.matchAll(/\benv\.([A-Z][A-Z0-9_]+)/g)) found.add(m[1] as string);
  for (const m of cfg.matchAll(/\benv\[['"]([A-Z][A-Z0-9_]+)['"]\]/g)) found.add(m[1] as string);
  for (const f of walk(SRC)) {
    const s = readFileSync(f, 'utf8');
    for (const m of s.matchAll(/process\.env\.([A-Z][A-Z0-9_]+)/g)) found.add(m[1] as string);
    for (const m of s.matchAll(/process\.env\[['"]([A-Z][A-Z0-9_]+)['"]\]/g))
      found.add(m[1] as string);
  }
  return [...found].sort();
}

function undocumented(): string[] {
  const spec = readFileSync(SPEC, 'utf8');
  return readVars().filter((v) => !new RegExp(`\\b${v}\\b`).test(spec));
}

describe('V-905 an env var the server reads is documented or listed', () => {
  it('CRITICAL both sides parse. The arm below counts a difference, so an unread source tree or an unparsed spec would report zero undocumented variables and pass — reporting perfect coverage over nothing, which is the failure this sweep kept finding in other guards.', () => {
    expect(readVars().length, 'env vars the server reads').toBeGreaterThan(60);
    expect(readFileSync(SPEC, 'utf8').length, 'the operator spec').toBeGreaterThan(2000);
  });

  it('CRITICAL the undocumented set does not grow. An operator provisions from env-vars.md, so a variable missing from it is one nobody sets — and the failure lands at runtime on whichever feature it gated. The current 26 are recorded debt; this arm exists so the 27th cannot arrive quietly.', () => {
    expect(
      undocumented().length,
      `env vars read by the server but absent from docs/deployment/env-vars.md:\n  ${undocumented().join('\n  ')}\nDocument the new one, or if it is genuinely internal, say so in the spec.`,
    ).toBeLessThanOrEqual(UNDOCUMENTED_CEILING);
  });

  it('CRITICAL the ceiling is tight against reality, so documenting a variable is required to lower it rather than merely permitted. A ceiling with slack is a guard that has already stopped working — the next few additions would fit underneath it unnoticed.', () => {
    expect(
      undocumented().length,
      'if this is below the ceiling, lower UNDOCUMENTED_CEILING in the same commit',
    ).toBe(UNDOCUMENTED_CEILING);
  });
});
