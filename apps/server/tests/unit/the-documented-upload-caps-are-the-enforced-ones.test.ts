// The upload reference publishes three caps. The route enforces three caps.
// Nothing connected them.
//
// Measured: doubling the per-session lifetime cap
// (`sessionUploadMaxLifetimeBytes` 2 GiB → 4 GiB) left the ENTIRE suite green —
// 28,038 tests, zero reds. Not "only self-referential pins red", as with the
// pricing and session-length findings: nothing at all. The docs would keep
// promising 2 GiB, and no behavioural arm noticed either.
//
// Each cap had three independent copies: the value, the rejection message that
// quotes it back to the customer, and the docs sentence. The messages are now
// DERIVED from the values via binarySizeLabel(), which removes that copy
// entirely — worth doing rather than guarding, because the per-account cap is
// operator-configurable (AGENT_UPLOAD_MAX_ACCOUNT_INFLIGHT_BYTES → config →
// bootstrap → app → route). A deployment that lowered it told the customer
// "at most 512 MB" while rejecting at whatever it actually enforced. No guard
// on a hardcoded string could have made that message right; only deriving it
// could.
//
// That leaves the docs, which describe the DEFAULTS and cannot interpolate.
// This pairs them, reading both sides out of the source rather than restating
// any figure: the caps come from the route's own default parameters and the
// labels from the same formatter the messages use, so a cap change with stale
// docs fails here.
//
// SCOPE: this is a documentation-agreement check, not behavioural coverage.
// The per-session lifetime cap still has no test that exercises the rejection
// path — `upload-account-inflight-cap` covers the per-account cap only. Stated
// so a green here is not mistaken for the cap being tested.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { binarySizeLabel } from '../../src/lib/binary-size-label.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const ROUTE = resolve(REPO, 'apps', 'server', 'src', 'routes', 'agent-sessions.ts');
const DOC = resolve(REPO, 'apps', 'docs', 'src', 'pages', 'api', 'agent-sessions.md');

interface Cap {
  /** Reads the byte expression out of the route source. */
  source: RegExp;
  /** How the docs phrase it, with the figure captured. */
  published: RegExp;
  what: string;
}

const CAPS: readonly Cap[] = [
  {
    what: 'per-file decoded size',
    source: /const UPLOAD_MAX_FILE_BYTES = ([\d\s*]+);/,
    published: /decoded\s+size is capped at \*\*([\d.]+ [KMG]i?B)\*\* per file/,
  },
  {
    what: 'per-account concurrent volume',
    source: /uploadMaxAccountInFlightBytes = ([\d\s*]+),/,
    published: /per-account concurrent upload volume \(([\d.]+ [KMG]i?B)\)/,
  },
  {
    what: 'per-session lifetime total',
    source: /sessionUploadMaxLifetimeBytes = ([\d\s*]+),/,
    published: /per-session lifetime totals \(([\d.]+ [KMG]i?B)\)/,
  },
];

/** `64 * 1024 * 1024` → 67108864. Only multiplication of integers is accepted. */
function evalProduct(expression: string): number {
  const parts = expression
    .trim()
    .split('*')
    .map((p) => p.trim());
  expect(
    parts.every((p) => /^\d+$/.test(p)),
    `cap expression "${expression}" is no longer a plain product — teach this reader the new shape`,
  ).toBe(true);
  return parts.reduce((total, p) => total * Number(p), 1);
}

describe('the documented upload caps are the enforced ones', () => {
  const route = readFileSync(ROUTE, 'utf-8');
  const doc = readFileSync(DOC, 'utf-8');

  it('CRITICAL the readers find real values on both sides', () => {
    for (const { source, published, what } of CAPS) {
      expect(source.exec(route)?.[1], `${what}: cap not found in the route source`).toBeTruthy();
      expect(published.exec(doc)?.[1], `${what}: claim not found in the docs`).toBeTruthy();
    }
    expect(binarySizeLabel(64 * 2 ** 20)).toBe('64 MiB');
    expect(binarySizeLabel(512 * 2 ** 20)).toBe('512 MiB');
    expect(binarySizeLabel(2 * 2 ** 30)).toBe('2 GiB');
    expect(evalProduct('64 * 1024 * 1024')).toBe(67108864);
  });

  it('CRITICAL every documented cap equals the cap the route defaults to', () => {
    const wrong: string[] = [];
    for (const { source, published, what } of CAPS) {
      const enforced = evalProduct(source.exec(route)![1]!);
      const claimed = published.exec(doc)![1]!;
      const expected = binarySizeLabel(enforced);
      if (claimed !== expected)
        wrong.push(`${what}: docs say ${claimed}, the route enforces ${expected}`);
    }
    expect(wrong.sort(), 'the upload reference states a limit the server does not apply').toEqual(
      [],
    );
  });

  it('CRITICAL the rejection messages are derived, so they cannot drift from the caps', () => {
    // A hardcoded size in these messages is the defect this replaced: the
    // per-account cap is configurable, so any literal is wrong for some
    // deployment.
    for (const marker of [
      'at most ${binarySizeLabel(UPLOAD_MAX_ACCOUNT_INFLIGHT_BYTES)}',
      'at most ${binarySizeLabel(SESSION_UPLOAD_MAX_LIFETIME_BYTES)}',
      'Max ${binarySizeLabel(UPLOAD_MAX_FILE_BYTES)}',
    ])
      expect(route, `upload rejection message no longer derives its size: ${marker}`).toContain(
        marker,
      );
    expect(
      /at most \d+ ?[KMG]i?B of uploads/.test(route),
      'an upload rejection message hardcodes a size again',
    ).toBe(false);
  });
});
