// W248.D — workspace-wide sweep guard for tier concurrent-cap drift.
// After W242 / W243 / W246 / W247, no marketing page should assert
// a concurrent cap that exceeds TIER_CONCURRENT_SESSION_LIMITS for
// any tier. The previous incarnation of /docs/rate-limits and
// /docs/concurrency both inflated these. This guard scans every
// .astro under marketing-site/src/pages and flags any string
// asserting an over-cap claim for a known tier name.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TIER_CONCURRENT_SESSION_LIMITS } from '@driftstack/api-types';

const REPO = join(__dirname, '..', '..', '..', '..');
const PAGES = join(REPO, 'apps', 'marketing-site', 'src', 'pages');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (entry.endsWith('.astro')) out.push(p);
  }
  return out;
}

// Map of tier display-names (the strings docs actually use) to their
// live concurrent-cap value.
const DISPLAY_NAME_TO_CAP: Record<string, number> = {
  Personal: TIER_CONCURRENT_SESSION_LIMITS.solo_manual,
  Team: TIER_CONCURRENT_SESSION_LIMITS.team_manual,
  Agency: TIER_CONCURRENT_SESSION_LIMITS.agency_manual,
  'API Starter': TIER_CONCURRENT_SESSION_LIMITS.api_starter,
  'API Builder': TIER_CONCURRENT_SESSION_LIMITS.api_builder,
  'API Scale': TIER_CONCURRENT_SESSION_LIMITS.api_scale,
};

// V-1456 — MEASURED VACUOUS, and left in place deliberately. Read this before
// trusting a green run here.
//
// The arms below scan page markup for `Personal: 5`-style claims. Across the 61
// `.astro` pages walked today they match ZERO occurrences, for all six display
// names. The caps stopped being written into markup: they live in
// `apps/marketing-site/src/data/pricing.ts` and the pages render from it, which
// is a better arrangement and is exactly why this sweep now checks nothing.
//
// The page floor cannot see that — it counts the corpus, and the corpus is
// healthy; the subject left it. Same shape as `marketing-prefix-id-sweep`, whose
// subject had moved to apps/docs and which was re-pointed there.
//
// This one was NOT re-pointed, because the risk is already covered twice, both
// verified rather than assumed:
//
//   tier-limits-server-side-parity   reads api-types/common.ts AND
//                                    marketing-site/src/data/pricing.ts and
//                                    asserts each tier's number in BOTH, so the
//                                    two files cannot drift apart.
//   published-tier-caps-match-the-code  compares six apps/docs surfaces against
//                                    the imported TIER_CONCURRENT_SESSION_LIMITS
//                                    numerically, with completeness checks.
//
// So adding a subject floor here would red the build over an absence that is
// correct. Retiring the file or re-pointing it at the data module is a decision
// worth making deliberately; what is recorded here is the measurement, so the
// next reader does not re-derive it.
describe('W248.D marketing-site tier-cap drift sweep', () => {
  const pages = walk(PAGES);
  // Vacuity arm. Every assertion below reports an ABSENCE, and an absence is
  // vacuously true over an empty scan — so a filter that stops matching (a
  // rename, a new extension, a moved page root) would make this guard report
  // clean forever while checking nothing. Measured, not hypothetical: pointing
  // the extension filter at a non-existent suffix left this file GREEN.
  it('CRITICAL the scan found real pages, so a clean result means checked rather than not looked.', () => {
    // V-939 — floor raised to just under the measured 61; it stood at 5, so this
    // scan could have lost 92% of its corpus and still called itself non-vacuous.
    expect(pages.length, 'marketing-site .astro pages scanned').toBeGreaterThan(55);
  });

  it('no page asserts a concurrent count above the live cap for any tier', () => {
    const offenders: { file: string; name: string; assertion: number; live: number }[] = [];
    for (const p of pages) {
      const body = readFileSync(p, 'utf8');
      for (const [name, live] of Object.entries(DISPLAY_NAME_TO_CAP)) {
        // Match patterns like "Personal: 5 concurrent" / "Personal = 5"
        // — both flavours appeared in pre-W242 incarnations.
        const re = new RegExp(`${name}\\s*[:=]\\s*(\\d+)`, 'g');
        for (const m of body.matchAll(re)) {
          const asserted = Number(m[1]);
          // Tolerate trial-pack literal copy near the tier; we're after
          // explicit concurrent counts, so only flag asserted > live.
          if (asserted > live) {
            offenders.push({ file: p.replace(REPO + '/', ''), name, assertion: asserted, live });
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
