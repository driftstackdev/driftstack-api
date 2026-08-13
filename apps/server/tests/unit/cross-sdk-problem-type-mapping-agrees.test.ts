// The same problem type produces the same error class in all three SDKs.
//
// A customer writes `except RateLimitError` in Python, `catch (e) { if (e
// instanceof RateLimitError) }` in TypeScript, and `errors.As(err,
// &driftstack.RateLimitError{})` in Go. Those are the same intent, and the
// server sends the same problem-type URI to all three, so the class each SDK
// produces has to agree or the customer's control flow silently differs by
// language.
//
// Two existing tests cover the neighbouring facts and neither covers this one.
// `cross-sdk-error-parity` asserts each SDK DECLARES the 21 canonical class
// names. `cross-sdk-problem-type-parity` asserts each SDK REFERENCES all 24
// canonical URIs. Names on one side, URIs on the other, and nothing joining
// them: a URI could map to `RateLimitError` in two SDKs and something else in
// the third with both tests green. The same names-covered-values-not shape this
// suite keeps finding.
//
// The mapping is EXTRACTED from each SDK's own table rather than restated:
// `TYPE_TO_CTOR` in TypeScript, `PROBLEM_TYPE_TO_ERROR` in Python, and
// `problemTypeToFactory` in Go — whose entries are builder functions, so each
// builder is resolved to the concrete type it RETURNS. A restated table would
// be a fourth copy of the thing under test.
//
// Extraction has two subtleties, both found by the extraction being wrong first.
// TypeScript handles `rate-limited` in an explicit `if` BEFORE the table lookup
// (it reads the Retry-After header), so a table-only reader reports it missing.
// And Python writes some entries across several lines. Both are handled, and the
// per-SDK counts are floored so a reader that silently stops finding entries
// fails instead of reporting agreement.
//
// TWO GENUINE DIVERGENCES exist today and are enumerated rather than fixed here,
// because collapsing them is a customer-facing API decision rather than a
// cleanup:
//
//   tier-limit             TypeScript → TierLimitError, which does not exist in
//                          Python or Go; both map to QuotaExceededError. A
//                          customer cannot write portable handling for it.
//   driver-not-integrated  TypeScript → DriverNotIntegratedError, which extends
//                          DriftstackError and NOT DriverError; Python and Go
//                          map to DriverError. So `catch (DriverError)` catches
//                          it in Python and misses it in TypeScript.
//
// Listing them keeps the set from growing quietly and makes the decision
// visible. A THIRD divergence appearing fails this file.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..', '..');
const TS = resolve(REPO, 'packages', 'sdk-typescript', 'src', 'errors.ts');
const PY = resolve(REPO, 'packages', 'sdk-python', 'src', 'driftstack', 'errors.py');
const GO_MAP = resolve(REPO, 'packages', 'sdk-go', 'error_mapping.go');
const GO_ERRORS = resolve(REPO, 'packages', 'sdk-go', 'errors.go');

/** Divergences reviewed and deliberately left, keyed by the URI's last segment. */
const KNOWN_DIVERGENCES = new Set(['tier-limit', 'driver-not-integrated']);

const read = (p: string): string => readFileSync(p, 'utf8');
const slug = (uri: string): string => uri.slice(uri.lastIndexOf('/') + 1);

function typescriptMapping(): Map<string, string> {
  const src = read(TS);
  const out = new Map<string, string>();
  for (const m of src.matchAll(
    /'(https:\/\/errors\.driftstack\.dev\/[a-z0-9-]+)':\s*\(p\)\s*=>\s*new (\w+)/g,
  )) {
    out.set(m[1]!, m[2]!);
  }
  // `rate-limited` is handled in an explicit branch before the table, because it
  // reads the Retry-After header. A table-only reader calls it missing.
  for (const m of src.matchAll(
    /p\.type === '(https:\/\/errors\.driftstack\.dev\/[a-z0-9-]+)'\)\s*\{[\s\S]{0,400}?new (\w+Error)\(/g,
  )) {
    if (!out.has(m[1]!)) out.set(m[1]!, m[2]!);
  }
  return out;
}

function pythonMapping(): Map<string, string> {
  const src = read(PY);
  const out = new Map<string, string>();
  // Entries are `"URI": ErrorClass,` but some wrap across lines, so the class is
  // taken as the next identifier after the colon rather than same-line.
  for (const m of src.matchAll(
    /"(https:\/\/errors\.driftstack\.dev\/[a-z0-9-]+)":\s*\(?\s*\n?\s*(\w+)/g,
  )) {
    out.set(m[1]!, m[2]!);
  }
  return out;
}

function goMapping(): Map<string, string> {
  const table = read(GO_MAP);
  const all = table + read(GO_ERRORS);
  const out = new Map<string, string>();
  for (const m of table.matchAll(/"(https:\/\/errors\.driftstack\.dev\/[a-z0-9-]+)":\s*(\w+)/g)) {
    // Resolve the builder to the concrete type it returns — the builder NAME is
    // a convention, and a convention is not the thing under test.
    const built = new RegExp(
      `func ${m[2]!}\\([^)]*\\)[^{]*\\{[\\s\\S]{0,800}?return &?(\\w+Error)\\{`,
    ).exec(all);
    out.set(m[1]!, built?.[1] ?? `unresolved:${m[2]!}`);
  }
  return out;
}

describe('the three SDKs map each problem type to the same error class', () => {
  it('CRITICAL every mapping table was read and resolved. The comparison reports disagreement, so a reader that found nothing would compare nothing and report the SDKs in perfect agreement — and each of these tables is a different language with a different shape.', () => {
    const ts = typescriptMapping();
    const py = pythonMapping();
    const go = goMapping();

    // MEASURED: 31 / 31 / 32 entries.
    expect(ts.size, 'TypeScript URI mappings extracted').toBeGreaterThanOrEqual(30);
    expect(py.size, 'Python URI mappings extracted').toBeGreaterThanOrEqual(30);
    expect(go.size, 'Go URI mappings extracted').toBeGreaterThanOrEqual(30);

    // The two extraction subtleties, on cases whose answer is not in doubt.
    expect(
      ts.get('https://errors.driftstack.dev/rate-limited'),
      'the TypeScript entry handled outside the table is still found',
    ).toBe('RateLimitError');
    expect(
      py.get('https://errors.driftstack.dev/pair-mode-invalid-transition'),
      'a Python entry written across lines is still found',
    ).toBe('PairModeStateInvalidTransitionError');

    // Every Go builder resolved to a concrete type rather than a name.
    expect(
      [...go.entries()].filter(([, cls]) => cls.startsWith('unresolved:')).map(([u]) => slug(u)),
      'Go builder(s) whose returned type could not be resolved:',
    ).toEqual([]);
  });

  it('CRITICAL no NEW divergence appears. A URI mapping to different classes by language means a customer catching one class gets different control flow in another SDK for the identical server response — and the two existing cross-SDK tests cannot see it, because one checks class NAMES and the other checks URI PRESENCE.', () => {
    const ts = typescriptMapping();
    const py = pythonMapping();
    const go = goMapping();
    const uris = [...new Set([...ts.keys(), ...py.keys(), ...go.keys()])].sort();

    const diverging: string[] = [];
    for (const uri of uris) {
      const seen = [ts.get(uri), py.get(uri), go.get(uri)];
      if (seen.some((c) => c === undefined)) continue; // presence is the other test's job
      if (new Set(seen).size === 1) continue;
      if (KNOWN_DIVERGENCES.has(slug(uri))) continue;
      diverging.push(`${slug(uri)}: ts=${seen[0]!}, python=${seen[1]!}, go=${seen[2]!}`);
    }
    expect(diverging.sort(), 'problem type(s) mapping to different classes by language:').toEqual(
      [],
    );
  });

  it('CRITICAL the known divergences are still divergent. An entry that has been reconciled should leave this list — a reviewed-exception set that keeps closed items is how the live entries stop being read.', () => {
    const ts = typescriptMapping();
    const py = pythonMapping();
    const go = goMapping();
    const stale: string[] = [];
    for (const name of KNOWN_DIVERGENCES) {
      const uri = `https://errors.driftstack.dev/${name}`;
      const seen = [ts.get(uri), py.get(uri), go.get(uri)];
      if (seen.some((c) => c === undefined)) continue;
      if (new Set(seen).size === 1) stale.push(`${name} now agrees (${seen[0]!})`);
    }
    expect(stale.sort(), 'known divergence(s) that have been reconciled:').toEqual([]);
  });

  it('CRITICAL TierLimitError still exists in TypeScript only. The Go SDK documented returning one for a profile tier cap while defining no such type — customers get QuotaExceededError. If Go or Python ever gains the class, the divergence above becomes fixable and the documentation must move with it.', () => {
    expect(read(TS), 'TypeScript declares it').toMatch(/export class TierLimitError\b/);
    expect(read(GO_ERRORS) + read(GO_MAP), 'Go does not define it').not.toMatch(
      /type TierLimitError\b/,
    );
    expect(read(PY), 'Python does not define it').not.toMatch(/^class TierLimitError\b/m);
  });
});
