// v2-#12 SDK error type catalog standardization.
//
// Pins the bidirectional consistency between api-types PROBLEM_TYPES
// (URI catalog) and the TS SDK TYPE_TO_CTOR dispatch table. Drift
// = customer hits an undocumented problem-type URI + the SDK falls
// back to a generic DriftstackError instead of a typed subclass.
//
// The check is on URIs, not slug→kind transformation (the SDK
// abbreviates some kinds, e.g. 'validation-failed' → kind
// 'validation', so a pure mechanical transform doesn't work). What
// matters operationally: every PROBLEM_TYPES URI must have a
// TYPE_TO_CTOR entry OR be the rate-limited special case
// (handled inline in errorFromProblem because of the
// retry_after_seconds extraction).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROBLEM_TYPES } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const SDK_TS_ERRORS = resolve(REPO_ROOT, 'packages/sdk-typescript/src/errors.ts');

const RATE_LIMITED_URI = 'https://errors.driftstack.dev/rate-limited';

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('v2-#12 SDK error catalog parity', () => {
  it('canonical SDK error file exists', () => {
    expect(existsSync(SDK_TS_ERRORS)).toBe(true);
  });

  it('CRITICAL every PROBLEM_TYPES URI has a TYPE_TO_CTOR entry (or is the rate-limited inline case). Drift = customer hits an undocumented problem-type and falls back to a generic DriftstackError without a typed subclass.', () => {
    const src = read(SDK_TS_ERRORS);
    // Extract the TYPE_TO_CTOR block contents.
    const m = src.match(/const TYPE_TO_CTOR:[^{]+\{([\s\S]+?)\};/);
    expect(m, 'TYPE_TO_CTOR map must exist').not.toBeNull();
    const block = m![1] ?? '';

    const missing: string[] = [];
    for (const uri of Object.values(PROBLEM_TYPES)) {
      if (uri === RATE_LIMITED_URI) continue;
      if (!block.includes(`'${uri}'`)) {
        missing.push(uri);
      }
    }
    expect(missing, 'PROBLEM_TYPES entries missing from TYPE_TO_CTOR').toEqual([]);
  });

  it('CRITICAL TYPE_TO_CTOR exists + errorFromProblem dispatches via it. Drift to inlining ctor selection would defeat the per-URI extension point that lets future problem types layer on without a code change to errorFromProblem.', () => {
    const src = read(SDK_TS_ERRORS);
    expect(src).toMatch(/const TYPE_TO_CTOR:/);
    expect(src).toMatch(/const ctor = TYPE_TO_CTOR\[p\.type\];/);
    expect(src).toMatch(/if \(ctor\) return ctor\(p\);/);
  });

  it("CRITICAL rate-limited URI is handled BEFORE TYPE_TO_CTOR dispatch — the Retry-After header path needs to read retry_after_seconds from the body OR Retry-After response header. Drift to dropping the explicit branch would break the customer's exponential-backoff hint.", () => {
    const src = read(SDK_TS_ERRORS);
    expect(src).toMatch(/if \(p\.type === 'https:\/\/errors\.driftstack\.dev\/rate-limited'\) \{/);
    expect(src).toMatch(/retry_after_seconds/);
    expect(src).toMatch(/new RateLimitError\(p, retryAfter\);/);
  });

  it("CRITICAL DriftstackErrorKind union includes the 'transport' sentinel — SDK-side only, never returned by the server. Drift = network/parse failures surface as a non-Driftstack error class.", () => {
    const src = read(SDK_TS_ERRORS);
    expect(src).toMatch(/'transport'/);
  });

  it('CRITICAL TYPE_TO_CTOR has no entry pointing OUTSIDE the PROBLEM_TYPES URI roster — drift would mean the SDK ships a ctor for a URI the server cannot ever emit (silent dead code).', () => {
    const src = read(SDK_TS_ERRORS);
    const m = src.match(/const TYPE_TO_CTOR:[^{]+\{([\s\S]+?)\};/);
    const block = m![1] ?? '';
    const validUris = new Set<string>([...Object.values(PROBLEM_TYPES), RATE_LIMITED_URI]);

    // Pull every quoted URI in the TYPE_TO_CTOR block.
    const uris = Array.from(block.matchAll(/'(https:\/\/errors\.driftstack\.dev\/[^']+)'/g)).map(
      (mm) => mm[1] as string,
    );

    for (const u of uris) {
      expect(validUris, `TYPE_TO_CTOR entry '${u}' has no matching PROBLEM_TYPES URI`).toContain(u);
    }
  });
});
