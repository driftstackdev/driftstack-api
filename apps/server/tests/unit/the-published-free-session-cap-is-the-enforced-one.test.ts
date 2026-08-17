// Six customer-facing surfaces state how long a free-tier session lasts. The
// server enforces that from MAX_SESSION_MINUTES_PER_TIER.free. Nothing tied
// the two together.
//
// Measured: raising the enforced cap 20 → 30 reds 7 arms — four in
// session-duration-sweeper, two in an-unbounded-paid-session-is-a-visible-
// choice, one source-text pin in api-types-common-content-parity. Every one of
// them is server-internal. NOT ONE names a docs page or a dashboard page, so
// the product would auto-destroy free sessions at 30 minutes while six
// published surfaces still promised 20, suite green.
//
// The dashboard makes that easy to miss. select-tier.astro DOES import the
// constant and derives from it (`const minutes = MAX_SESSION_MINUTES_PER_TIER
// [tier]`), and two tests pin that the import is present — which reads like
// coverage. Its prose sentence hardcodes the number anyway, and welcome.astro
// never imports it at all. Partial derivation is what makes this survive
// review: the page genuinely uses the constant, just not where it makes the
// promise.
//
// Deriving the prose would fix the two .astro files, but the four docs claims
// live in .md that cannot interpolate — so the pairing has to be a guard, and
// one guard covering all six is better than two mechanisms. Making the Astro
// copy interpolate later is still welcome; this stays correct either way.
//
// Every pattern below MUST match its file. A claim rewritten past its pattern
// fails loudly rather than silently passing on zero matches — a detector that
// cannot see its own target is the failure mode this arm exists to prevent.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MAX_SESSION_MINUTES_PER_TIER } from '@driftstack/api-types';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

interface PublishedClaim {
  file: string;
  /** Anchored on the claim's own wording, with the minutes figure captured. */
  claim: RegExp;
  what: string;
}

const PUBLISHED_CLAIMS: readonly PublishedClaim[] = [
  {
    file: 'apps/docs/src/pages/api/sessions.md',
    claim: /free-tier sessions stop at the (\d+)-minute duration/,
    what: 'sessions reference — duration cap',
  },
  {
    file: 'apps/docs/src/pages/api/usage.md',
    claim: /enforces a (\d+)-minute \*\*per-session\*\* wall-clock cap/,
    what: 'usage reference — wall-clock cap',
  },
  {
    file: 'apps/docs/src/pages/api/usage.md',
    claim: /auto-destroys after (\d+) minutes/,
    what: 'usage reference — auto-destroy',
  },
  {
    file: 'apps/docs/src/pages/api/usage.md',
    claim: /free tier's (\d+)-minute per-session wall-clock cap/,
    what: 'usage reference — free-tier cap restatement',
  },
  {
    file: 'apps/docs/src/pages/guides/concurrency.md',
    claim: /sessions also auto-destroy at (\d+) minutes/,
    what: 'concurrency guide — tier table note',
  },
  {
    file: 'apps/customer-dashboard/src/pages/select-tier.astro',
    claim: /sessions up\s+to (\d+) minutes each/,
    what: 'select-tier page — free plan note',
  },
  {
    file: 'apps/customer-dashboard/src/pages/welcome.astro',
    claim: /session of up to (\d+) minutes/,
    what: 'welcome page — free plan summary',
  },
];

function read(rel: string): string {
  return readFileSync(resolve(REPO, rel), 'utf-8');
}

describe('the published free-tier session cap is the enforced one', () => {
  it('CRITICAL the enforced value is a real number, so the comparison means something', () => {
    const enforced = MAX_SESSION_MINUTES_PER_TIER.free;
    expect(
      typeof enforced,
      'the free tier no longer carries a session cap — every claim below is now unbacked and this guard needs rewriting, not deleting',
    ).toBe('number');
    expect(enforced).toBeGreaterThan(0);
    expect(PUBLISHED_CLAIMS.length, 'the roster is empty').toBeGreaterThanOrEqual(7);
  });

  it('CRITICAL every published surface states the cap the server actually enforces', () => {
    const enforced = String(MAX_SESSION_MINUTES_PER_TIER.free);
    const offenders: string[] = [];
    for (const { file, claim, what } of PUBLISHED_CLAIMS) {
      const found = claim.exec(read(file));
      if (!found) {
        offenders.push(
          `${file} (${what}): the claim this pattern was written for is no longer there`,
        );
        continue;
      }
      if (found[1] !== enforced)
        offenders.push(
          `${file} (${what}): published ${found[1]} minutes, server enforces ${enforced}`,
        );
    }
    expect(offenders.sort(), 'a customer is told one session length and given another').toEqual([]);
  });

  it('CRITICAL the patterns reject a different number (they are not satisfied by anything)', () => {
    const sessions = PUBLISHED_CLAIMS[0]!;
    expect(sessions.claim.exec('free-tier sessions stop at the 20-minute duration')?.[1]).toBe(
      '20',
    );
    expect(sessions.claim.exec('free-tier sessions stop at the 45-minute duration')?.[1]).toBe(
      '45',
    );
    expect(sessions.claim.exec('free-tier sessions run until you destroy them')).toBeNull();
  });
});
