// V-1061 — the SDK docs a customer reads must name the set the SDK actually retries.
//
// Two guards already pin the retryable set across the three retry implementations —
// `sdk-retry-policy-cross-sdk-parity` and `cross-sdk-retry-policy-parity` both assert
// TransportError + RateLimitError + InternalError in retry.ts, retry.py and retry.go.
// Those files are correct and have been for a long time.
//
// The prose was not. Three customer-facing documents said something else:
//
//   sdk-go/doc.go        — "not on 4xx or 5xx response bodies — those are terminal
//                          in the Go SDK"                              (V-1060)
//   sdk-python/README.md — "5xx responses are terminal (not retried)"  (V-1061)
//   sdk-go/README.md     — "Retryable: *TransportError + *RateLimitError"
//                          with InternalError simply absent            (V-1061)
//
// All three told a customer that a plain 500 will not be retried. That is the belief
// that leads to writing an outer retry loop on top of one already running, and the
// idempotency warnings on those same pages cover only the transport case — so the
// customer following the docs gets the double-execution the warning is about, for a
// reason the warning does not mention.
//
// The gap was structural rather than accidental: every guard pointed at an
// implementation file, and nothing asked whether the pages customers actually read
// agreed with them. This file asks that.
//
// ── Deriving rather than restating ─────────────────────────────────────────
//
// The canonical set is read from the implementations, not written here, so this
// cannot drift with either side. Each document must then name every member and must
// not carry a phrasing that contradicts it.
//
// The negative half matters more than the positive half. A page can mention
// `InternalError` in passing while a sentence two lines down calls 5xx terminal —
// which is close to what sdk-go/README.md did, listing two members and omitting the
// third with no visible gap.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

const read = (p: string): string => readFileSync(resolve(REPO_ROOT, p), 'utf8');

/** The three retry implementations, and the predicate each uses. */
const IMPLEMENTATIONS = [
  { sdk: 'typescript', file: 'packages/sdk-typescript/src/errors.ts' },
  { sdk: 'python', file: 'packages/sdk-python/src/driftstack/retry.py' },
  { sdk: 'go', file: 'packages/sdk-go/errors.go' },
] as const;

/** Error kinds the SDKs retry. Every implementation must name all three. */
const RETRYABLE = ['TransportError', 'RateLimitError', 'InternalError'] as const;

/**
 * Customer-facing pages that describe WHAT gets retried.
 *
 * A page belongs here when a customer deciding whether to write their own retry loop
 * would reasonably read it. Changelogs are excluded on purpose: they are a historical
 * record of what was true at a version, and correcting them would be falsifying it.
 */
const CUSTOMER_FACING = [
  'packages/sdk-go/doc.go',
  'packages/sdk-go/README.md',
  'packages/sdk-python/README.md',
  'packages/sdk-typescript/README.md',
] as const;

/** Phrasings that assert the opposite, in the words each page actually used. */
const CONTRADICTIONS: ReadonlyArray<{ re: RegExp; was: string }> = [
  { re: /not on 4xx or 5xx response bodies/i, was: 'sdk-go/doc.go before V-1060' },
  { re: /5xx responses are terminal/i, was: 'sdk-python/README.md before V-1061' },
  { re: /5xx[^.\n]{0,40}\bnot retried\b/i, was: 'the same claim in other words' },
  { re: /\b5xx\b[^.\n]{0,30}\bare terminal\b/i, was: 'the same claim in other words' },
];

describe('V-1061 what the SDKs say they retry is what they retry', () => {
  it('CRITICAL the implementations agree on the retryable set, which is what the documents below are checked against. If this roster were read from nothing, every arm here would pass for pages that describe an SDK doing something else entirely.', () => {
    for (const { sdk, file } of IMPLEMENTATIONS) {
      const src = read(file);
      expect(src.length, `${sdk}: ${file} is empty`).toBeGreaterThan(500);
      for (const kind of RETRYABLE) {
        expect(src, `${sdk} no longer names ${kind} as retryable in ${file}`).toContain(kind);
      }
    }

    // The contradiction patterns must be capable of matching. A typo in one would
    // silently retire that half of the check.
    expect(
      CONTRADICTIONS.some((c) => c.re.test('5xx responses are terminal (not retried).')),
      'the contradiction patterns no longer match the sentence they were written for',
    ).toBe(true);
  });

  it('CRITICAL every customer-facing page names InternalError, the plain 500, among the errors retried. Omitting it tells a customer to write their own loop on top of the one already running, and the idempotency warning on those same pages covers only the transport case — so they get the double execution it warns about, for a reason it does not mention.', () => {
    const silent = CUSTOMER_FACING.filter((p) => {
      const src = read(p);
      return !/InternalError/.test(src) && !/\b5xx\b/.test(src);
    });
    expect(
      silent,
      'these customer-facing pages describe the retry policy without saying that a plain 500 is ' +
        'retried — name InternalError, or say 5xx explicitly:',
    ).toEqual([]);
  });

  it('CRITICAL no customer-facing page carries a phrasing that contradicts the implementation. A page can name InternalError in one line and call 5xx terminal two lines down; the positive check above would pass and the customer would still be misled.', () => {
    const offenders: string[] = [];
    for (const p of CUSTOMER_FACING) {
      const src = read(p);
      for (const { re, was } of CONTRADICTIONS) {
        if (re.test(src)) offenders.push(`${p} matches /${re.source}/ — ${was}`);
      }
    }
    expect(
      offenders.sort(),
      'these pages tell customers a 5xx is terminal, while IsRetryable / is_retryable / ' +
        'isRetryable all return true for InternalError:',
    ).toEqual([]);
  });
});
