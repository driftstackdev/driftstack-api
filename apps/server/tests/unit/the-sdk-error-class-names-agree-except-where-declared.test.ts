// V-1138 — the SDK error classes carry one name across the three SDKs, except twice.
//
// `docs/architecture/sdk-versioning.md` lists cross-SDK lockstep requirements and states
// them as a MUST. One of them was that the error classes "exist with the same names in
// each". Two problem types deliberately do not, and both are explicit registry entries
// rather than oversights:
//
//   tier-limit             TypeScript TierLimitError   Python/Go QuotaExceededError
//   driver-not-integrated  TypeScript DriverNotIntegratedError   Python/Go DriverError
//
// The second is more than a name. Python and Go map `driver-not-integrated` onto the same
// class as `driver-error`, so a caller in those languages cannot tell the two apart by
// class at all — only by reading the problem-type URI. A TypeScript caller can catch them
// separately. That is a real cross-SDK behavioural difference and the policy said it did
// not exist.
//
// Converging them is a rename of a published class, which the same document classifies as
// a breaking change requiring a MAJOR bump and a deprecation cycle. That is the SDK
// owner's call and is NOT taken here. What is taken: the policy now describes what ships,
// in both copies of it, and this guard holds the exception set at exactly two.
//
// The mirrors matter. The bullet lives byte-identically in the internal policy and in the
// customer-facing `apps/docs/src/pages/sdk/versioning.md`, at the same line numbers.
// Correcting one and not the other would leave the customer reading the false version.
//
// ── Extractor note, because three attempts were wrong ──────────────────────
//
// Go's registry maps a URI to a BUILDER function, not to a type, and the builder names
// drop the `Error` suffix the types carry — `buildBadRequest` returns `*BadRequestError`.
// Deriving Go class names from builder names reported 29 of 30 slugs as divergent, which
// is the implausible number that gives the extractor away rather than the SDKs. Resolving
// the builder body's `return &<Type>{` fixed 23 of 32; the remaining nine build their
// struct across several lines, so the resolution has to scan the whole function body.
// Only then does the answer settle at two, which is what the reference table said all
// along.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const read = (rel: string): string => readFileSync(resolve(REPO_ROOT, rel), 'utf8');

/**
 * The problem types whose SDK class names deliberately differ, and what they differ to.
 * Converging either one is a published-class rename — a MAJOR bump under the same policy
 * this file guards — so these are declared, not fixed. A third entry appearing here
 * without that decision being taken is the drift this exists to catch.
 */
const DECLARED_DIVERGENCES: Readonly<Record<string, string>> = {
  'driver-not-integrated':
    'Python and Go map it onto DriverError, the same class as driver-error, so neither can distinguish the two by class',
  'tier-limit': 'TierLimitError in TypeScript, QuotaExceededError in Python and Go',
};

function typescriptRegistry(): Map<string, string> {
  const src = read('packages/sdk-typescript/src/errors.ts');
  const out = new Map<string, string>();
  for (const m of src.matchAll(
    /'https:\/\/errors\.driftstack\.dev\/([a-z-]+)':\s*\(p\)\s*=>\s*new (\w+)\(/g,
  )) {
    out.set(m[1] ?? '', m[2] ?? '');
  }
  return out;
}

function pythonRegistry(): Map<string, string> {
  const src = read('packages/sdk-python/src/driftstack/errors.py');
  const out = new Map<string, string>();
  for (const m of src.matchAll(/"https:\/\/errors\.driftstack\.dev\/([a-z-]+)":\s*(\w+)/g)) {
    out.set(m[1] ?? '', m[2] ?? '');
  }
  return out;
}

function goRegistry(): Map<string, string> {
  const src = read('packages/sdk-go/error_mapping.go');

  // Builder name → the struct it actually returns. The whole body is scanned because
  // several builders assemble fields over multiple lines before returning.
  const builders = new Map<string, string>();
  for (const m of src.matchAll(/^func (\w+)\([^)]*\) error \{/gm)) {
    const rest = src.slice(m.index + m[0].length);
    const end = rest.indexOf('\n}');
    const ret = /return &(\w+)\{/.exec(rest.slice(0, end === -1 ? rest.length : end));
    if (ret !== null) builders.set(m[1] ?? '', ret[1] ?? '');
  }

  const out = new Map<string, string>();
  for (const m of src.matchAll(/"https:\/\/errors\.driftstack\.dev\/([a-z-]+)":\s*(\w+)/g)) {
    out.set(m[1] ?? '', builders.get(m[2] ?? '') ?? `UNRESOLVED:${m[2] ?? ''}`);
  }
  return out;
}

describe('V-1138 the SDK error class names agree except where declared', () => {
  it('CRITICAL every Go registry entry resolves to a concrete struct. Go maps URIs to builder functions, so an unresolved builder silently becomes a name that matches nothing and reports a divergence that is really an extraction failure — the direction that manufactures findings.', () => {
    const go = goRegistry();
    expect(go.size, 'no Go registry entries parsed — error_mapping.go moved').toBeGreaterThan(20);
    const unresolved = [...go.entries()]
      .filter(([, cls]) => cls.startsWith('UNRESOLVED:'))
      .map(([slug, cls]) => `${slug} -> ${cls}`);
    expect(unresolved.sort(), 'Go builders whose returned struct could not be resolved').toEqual(
      [],
    );
  });

  it('CRITICAL the SDK error class names diverge in exactly the declared places. Converging either is a published-class rename and a MAJOR bump, so this holds the line rather than taking that decision — but a THIRD divergence arriving unnoticed is drift, and the policy would be wrong again without anyone editing it.', () => {
    const ts = typescriptRegistry();
    const py = pythonRegistry();
    const go = goRegistry();
    expect(ts.size, 'no TypeScript registry entries parsed').toBeGreaterThan(20);
    expect(py.size, 'no Python registry entries parsed').toBeGreaterThan(20);

    const shared = [...ts.keys()].filter((slug) => py.has(slug) && go.has(slug)).sort();
    expect(shared, 'no slug is present in all three registries').toContain('not-found');

    const divergent = shared.filter(
      (slug) => new Set([ts.get(slug), py.get(slug), go.get(slug)]).size > 1,
    );
    expect(divergent.sort(), 'problem types whose SDK class names disagree').toEqual(
      Object.keys(DECLARED_DIVERGENCES).sort(),
    );
  });

  it('CRITICAL both copies of the lockstep policy name the exceptions. The bullet is byte-identical in the internal policy and the customer-facing page, so correcting one leaves the other telling a customer the class names always match — and the customer-facing one is the copy that matters.', () => {
    for (const rel of [
      'docs/architecture/sdk-versioning.md',
      'apps/docs/src/pages/sdk/versioning.md',
    ]) {
      const body = read(rel);
      expect(body, `${rel} still makes the unqualified lockstep claim`).not.toMatch(
        /exist with the same names in each/,
      );
      expect(body, `${rel} does not name the tier-limit exception`).toMatch(/QuotaExceededError/);
      expect(body, `${rel} does not name the driver exception`).toMatch(/driver-not-integrated/);
    }
  });
});
