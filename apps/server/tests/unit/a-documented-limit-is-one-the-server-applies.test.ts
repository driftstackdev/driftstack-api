// A limit the reference states must be the limit the server applies.
//
// Found by sweeping every "at most / up to / capped at / limited to N" claim in
// apps/docs and asking which of them any test that READS that page also names.
// 19 claims, 6 unpaired. Two of those six are real enforced limits and are
// paired here; the rest were prose about behaviour rather than a bound.
//
// The measurement that mattered, because "is it covered?" is the wrong
// question: raising DEFAULT_MAX_SSE_PER_ACCOUNT 10 → 25 reds exactly 2 arms —
// one integration test for the read floor and one source-text pin quoting the
// constant back to itself. NEITHER names the docs page. The reference would
// keep promising 10 while the route admitted 25.
//
// The two claims are paired by different means on purpose:
//
//   • the profile-name bound is paired BEHAVIOURALLY — a name of exactly the
//     documented length must be accepted and one character more rejected. That
//     is stronger than reading `.max(120)` out of the schema, because it fails
//     if the bound moves in either direction, and it fails if the docs change
//     without the schema.
//   • the subscriber cap is paired by VALUE against the exported constant,
//     since admitting an 11th SSE stream in a unit test would mean standing up
//     ten live streams to prove one number.
//
// Neither restates a figure: both read it out of the docs sentence.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ExtractRequestSchema, InputEventSchema, ProfileNameSchema } from '@driftstack/api-types';
import { DEFAULT_MAX_SSE_PER_ACCOUNT } from '../../src/routes/account-notifications.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const DOCS = resolve(REPO, 'apps', 'docs', 'src', 'pages');

function claimedNumber(relativePath: string, claim: RegExp, what: string): number {
  const found = claim.exec(readFileSync(resolve(DOCS, relativePath), 'utf-8'));
  expect(found?.[1], `${what}: the documented claim this pattern exists for is gone`).toBeTruthy();
  return Number(found![1]);
}

const PROFILE_NAME_CLAIM = {
  path: 'guides/profile-management.md',
  claim: /Profile names are free-form strings up to (\d+) characters/,
  what: 'profile name length',
};

const SWIPE_DURATION_CLAIM = {
  path: 'guides/live-video.md',
  claim: /`durationMs` on `swipe` is capped at (\d+)/,
  what: 'swipe durationMs',
};

const EXTRACT_BATCH_CLAIM = {
  path: 'guides/migrate-from-puppeteer.md',
  claim: /up to (\d+) named selector/,
  what: 'extractions per request',
};

const SSE_SUBSCRIBER_CLAIM = {
  path: 'api/account-notifications.md',
  claim: /permits up to (\d+) concurrent subscribers per account/,
  what: 'concurrent SSE subscribers per account',
};

describe('a documented limit is one the server applies', () => {
  it('CRITICAL both documented claims are still present and read as numbers', () => {
    expect(
      claimedNumber(PROFILE_NAME_CLAIM.path, PROFILE_NAME_CLAIM.claim, 'profile'),
    ).toBeGreaterThan(0);
    expect(
      claimedNumber(SSE_SUBSCRIBER_CLAIM.path, SSE_SUBSCRIBER_CLAIM.claim, 'sse'),
    ).toBeGreaterThan(0);
    // The patterns must read the figure, not merely match the sentence.
    expect(
      /Profile names are free-form strings up to (\d+) characters/.exec(
        'Profile names are free-form strings up to 45 characters.',
      )?.[1],
    ).toBe('45');
  });

  it('CRITICAL a profile name of the documented length is accepted, one longer is not', () => {
    const max = claimedNumber(PROFILE_NAME_CLAIM.path, PROFILE_NAME_CLAIM.claim, 'profile name');
    // Alphanumeric throughout: ProfileNameSchema also requires the first and
    // last character to be alphanumeric, so a padding character would test the
    // regex rather than the length bound.
    const atLimit = 'a'.repeat(max);
    const overLimit = 'a'.repeat(max + 1);
    expect(
      ProfileNameSchema.safeParse(atLimit).success,
      `the guide promises ${max} characters, but the schema rejects a ${max}-character name`,
    ).toBe(true);
    expect(
      ProfileNameSchema.safeParse(overLimit).success,
      `the guide promises ${max} characters, but the schema also accepts ${max + 1}`,
    ).toBe(false);
  });

  it('CRITICAL the route admits the number of SSE subscribers the reference promises', () => {
    const promised = claimedNumber(
      SSE_SUBSCRIBER_CLAIM.path,
      SSE_SUBSCRIBER_CLAIM.claim,
      'sse subscribers',
    );
    expect(
      DEFAULT_MAX_SSE_PER_ACCOUNT,
      `the reference promises ${promised} concurrent subscribers per account, the route defaults to ${DEFAULT_MAX_SSE_PER_ACCOUNT}`,
    ).toBe(promised);
  });

  it('CRITICAL a swipe of the documented duration is accepted, one millisecond longer is not', () => {
    const max = claimedNumber(SWIPE_DURATION_CLAIM.path, SWIPE_DURATION_CLAIM.claim, 'swipe');
    // Otherwise-valid swipe: only durationMs varies, so a rejection can only be
    // the bound. MAX_SWIPE_DURATION_MS had NO test naming it before this.
    const swipe = (durationMs: number): unknown => ({
      type: 'swipe',
      x1: 10,
      y1: 20,
      x2: 30,
      y2: 40,
      durationMs,
    });
    expect(
      InputEventSchema.safeParse(swipe(max)).success,
      `the guide caps swipe durationMs at ${max}, but the schema rejects exactly ${max}`,
    ).toBe(true);
    expect(
      InputEventSchema.safeParse(swipe(max + 1)).success,
      `the guide caps swipe durationMs at ${max}, but the schema also accepts ${max + 1}`,
    ).toBe(false);
  });

  it('CRITICAL an extraction batch of the documented size is accepted, one more is not', () => {
    const max = claimedNumber(EXTRACT_BATCH_CLAIM.path, EXTRACT_BATCH_CLAIM.claim, 'extract batch');
    const batch = (n: number): unknown => ({
      extractions: Array.from({ length: n }, (_unused, i) => ({
        name: `field_${i}`,
        selector: `#f${i}`,
        type: 'text',
      })),
    });
    expect(
      ExtractRequestSchema.safeParse(batch(max)).success,
      `the guide promises ${max} named extractions, but the schema rejects exactly ${max}`,
    ).toBe(true);
    expect(
      ExtractRequestSchema.safeParse(batch(max + 1)).success,
      `the guide promises ${max} named extractions, but the schema also accepts ${max + 1}`,
    ).toBe(false);
  });
});
