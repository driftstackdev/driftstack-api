// All three SDKs must agree on which requests may be auto-retried.
//
// This is the highest-severity property in the SDK layer. A transient 5xx on a
// keyless POST that gets silently re-sent is a duplicate create — for
// `crypto-orders.createCheckout` that is a customer charged twice. Every SDK
// therefore gates auto-retry on a method set plus a usable Idempotency-Key, and
// all three currently agree: GET, HEAD, PUT, DELETE, OPTIONS, TRACE.
//
// Each SDK already tests its OWN gate behaviourally, and well — adding POST to
// the set reds Go's suite, four TypeScript cases including "does NOT retry a
// keyless POST (avoids double-submitting a create)", and three Python cases in
// `test_http_retry_gate.py`. That was measured, not assumed.
//
// What no per-SDK test can see is DIVERGENCE. Each one compares an SDK against
// itself, so a change made in one language — with that language's test updated
// alongside it, which is what a careful author would do — leaves the other two
// silently different and every suite green. The server-side parity suites do not
// close this either: running the same mutation against them left 1329 tests
// passing, because none of them reads the method set at all.
//
// So this file compares the three sets to EACH OTHER, which is the one question
// none of the existing coverage is positioned to ask.
//
// The sets are parsed from source rather than hard-coded here, with one
// deliberate exception: the expected set itself is written out, because a guard
// that derives BOTH sides of a comparison from the same place can be satisfied
// by two identically-wrong inputs.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const TS_HTTP = resolve(REPO, 'packages', 'sdk-typescript', 'src', 'http.ts');
const PY_HTTP = resolve(REPO, 'packages', 'sdk-python', 'src', 'driftstack', 'http.py');
const GO_CLIENT = resolve(REPO, 'packages', 'sdk-go', 'client.go');

/**
 * The agreed set, written out rather than derived.
 *
 * RFC 7231 idempotent methods. POST and PATCH are deliberately absent: they are
 * retry-safe only when the caller supplies a usable Idempotency-Key, which is a
 * per-request decision each SDK makes separately and which its own tests cover.
 */
const AGREED = ['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PUT', 'TRACE'];

function tsSet(): string[] {
  const src = readFileSync(TS_HTTP, 'utf8');
  const m = /const IDEMPOTENT_METHODS = new Set\(\[([^\]]*)\]\)/.exec(src);
  if (m === null) return [];
  return [...m[1]!.matchAll(/'([A-Z]+)'/g)].map((x) => x[1]!).sort();
}

function pySet(): string[] {
  const src = readFileSync(PY_HTTP, 'utf8');
  const m = /_IDEMPOTENT_METHODS = frozenset\(\{([^}]*)\}\)/.exec(src);
  if (m === null) return [];
  return [...m[1]!.matchAll(/"([A-Z]+)"/g)].map((x) => x[1]!).sort();
}

function goSet(): string[] {
  const src = readFileSync(GO_CLIENT, 'utf8');
  const fn = /func isRetrySafe\([\s\S]*?\n\}/.exec(src);
  if (fn === null) return [];
  const sw = /switch strings\.ToUpper\(method\) \{\s*case ([\s\S]*?):/.exec(fn[0]);
  if (sw === null) return [];
  // `http.MethodGet` etc — take the suffix and upper-case it.
  return [...sw[1]!.matchAll(/http\.Method(\w+)/g)].map((x) => x[1]!.toUpperCase()).sort();
}

describe('the SDK retry-safety gate agrees across all three languages', () => {
  it('CRITICAL each set was actually parsed. Every comparison below is an equality, and two empty arrays are equal — so a regex that stopped matching would report perfect agreement, which is exactly the failure this guard exists to prevent.', () => {
    expect(tsSet().length, 'TypeScript methods parsed').toBeGreaterThan(4);
    expect(pySet().length, 'Python methods parsed').toBeGreaterThan(4);
    expect(goSet().length, 'Go methods parsed').toBeGreaterThan(4);
  });

  it("CRITICAL all three SDKs allow auto-retry for exactly the same methods. Each SDK tests its own gate, so a change made in one language with that language's test updated alongside it — which is what a careful author does — leaves the other two silently different and every suite green. Nothing else compares them.", () => {
    expect(tsSet(), 'TypeScript').toEqual(AGREED);
    expect(pySet(), 'Python').toEqual(AGREED);
    expect(goSet(), 'Go').toEqual(AGREED);
  });

  it('CRITICAL POST and PATCH are absent from every set. They are retry-safe only with a usable Idempotency-Key; admitting either unconditionally means a transient 5xx silently re-sends a create, and for crypto checkout that is a customer charged twice.', () => {
    for (const [lang, set] of [
      ['TypeScript', tsSet()],
      ['Python', pySet()],
      ['Go', goSet()],
    ] as const) {
      expect(set, `${lang} must not treat POST as inherently retry-safe`).not.toContain('POST');
      expect(set, `${lang} must not treat PATCH as inherently retry-safe`).not.toContain('PATCH');
    }
  });

  it('CRITICAL all three treat a blank Idempotency-Key as ABSENT. The server stores no dedup record for an empty value, so a header present but blank would make a keyless create look retry-safe — the exact case that turns one checkout into two.', () => {
    expect(readFileSync(TS_HTTP, 'utf8'), 'TypeScript trims before accepting').toMatch(
      /\.trim\(\)\s*!==\s*''/,
    );
    expect(readFileSync(PY_HTTP, 'utf8'), 'Python strips before accepting').toMatch(
      /\.strip\(\)\s*!=\s*""/,
    );
    expect(readFileSync(GO_CLIENT, 'utf8'), 'Go trims before accepting').toMatch(
      /strings\.TrimSpace\(v\)\s*!=\s*""/,
    );
  });

  it('CRITICAL V-1095 the eligibility gate reads the method and the headers and nothing else. A retry policy is a caller-supplied argument in all three SDKs, and the one thing it must never do is make an ineligible request eligible — that is a keyless create being auto-resent. The Python module docstring states this as a promise ("does not make a request eligible ... reads only the method and the headers"), and until now it was pinned only against its own file, so the code it describes lives in another one entirely.', () => {
    const gates: { lang: string; params: string }[] = [];
    const tsSig = /function isRetrySafe\(([^)]*)\)/.exec(readFileSync(TS_HTTP, 'utf8'));
    const pySig = /def _is_retry_safe\(([^)]*)\)/.exec(readFileSync(PY_HTTP, 'utf8'));
    const goSig = /func isRetrySafe\(([^)]*)\)/.exec(readFileSync(GO_CLIENT, 'utf8'));
    expect(tsSig, 'the TypeScript gate is no longer declared as isRetrySafe').not.toBeNull();
    expect(pySig, 'the Python gate is no longer declared as _is_retry_safe').not.toBeNull();
    expect(goSig, 'the Go gate is no longer declared as isRetrySafe').not.toBeNull();
    gates.push({ lang: 'TypeScript', params: tsSig?.[1] ?? '' });
    gates.push({ lang: 'Python', params: pySig?.[1] ?? '' });
    gates.push({ lang: 'Go', params: goSig?.[1] ?? '' });

    const widened = gates
      .filter((g) => /retry|config|policy|attempts/i.test(g.params))
      .map((g) => `${g.lang}: isRetrySafe(${g.params.replace(/\s+/g, ' ').trim()})`);
    expect(
      widened.sort(),
      'the eligibility gate now takes retry configuration, so a caller-supplied policy can decide ' +
        'whether a keyless POST is resent — eligibility must stay a function of the request alone:',
    ).toEqual([]);

    // Each gate must also short-circuit BEFORE the retry loop, or take a branch
    // the caller's policy cannot override. The three do it three ways, so the
    // shapes are asserted separately rather than by one pattern.
    expect(
      readFileSync(PY_HTTP, 'utf8'),
      'the Python sync/async paths no longer return before with_retry when the gate says no',
    ).toMatch(/if not _is_retry_safe\(method, headers\):\s*\n\s*return (await )?_do\(\)/);
    expect(
      readFileSync(GO_CLIENT, 'utf8'),
      'the Go path no longer returns doOnce before withRetry when the gate says no',
    ).toMatch(/if !isRetrySafe\(opts\.method, opts\.headers\) \{\s*\n\s*return c\.doOnce/);
    expect(
      readFileSync(TS_HTTP, 'utf8'),
      'TypeScript no longer forces a single attempt for an ineligible request — it overrides the ' +
        'caller policy rather than short-circuiting, so the override is the load-bearing part',
    ).toMatch(/isRetrySafe\(opts\.method, opts\.headers\)\s*\?[\s\S]{0,80}maxAttempts: 0/);
  });
});
