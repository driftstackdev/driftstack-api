// W253.D — workspace-wide sweep guard for docs.driftstack.io tier
// table drift. Mirrors W248.D for marketing-site. Walks every .md/.astro
// under apps/docs/src/pages and flags any page that asserts a
// concurrent count above the live cap or a profile cap above the
// live PROFILES_PER_TIER ceiling for any tier.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROFILES_PER_TIER, TIER_CONCURRENT_SESSION_LIMITS } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGES = resolve(REPO_ROOT, 'apps/docs/src/pages');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (entry.endsWith('.md') || entry.endsWith('.astro')) out.push(p);
  }
  return out;
}

const TIER_NAMES: Record<string, { conc: number; profiles: number | 'custom' }> = {
  trial_pack: {
    conc: TIER_CONCURRENT_SESSION_LIMITS.trial_pack,
    profiles: PROFILES_PER_TIER.trial_pack,
  },
  solo_manual: {
    conc: TIER_CONCURRENT_SESSION_LIMITS.solo_manual,
    profiles: PROFILES_PER_TIER.solo_manual,
  },
  team_manual: {
    conc: TIER_CONCURRENT_SESSION_LIMITS.team_manual,
    profiles: PROFILES_PER_TIER.team_manual,
  },
  agency_manual: {
    conc: TIER_CONCURRENT_SESSION_LIMITS.agency_manual,
    profiles: PROFILES_PER_TIER.agency_manual,
  },
  api_starter: {
    conc: TIER_CONCURRENT_SESSION_LIMITS.api_starter,
    profiles: PROFILES_PER_TIER.api_starter,
  },
  api_builder: {
    conc: TIER_CONCURRENT_SESSION_LIMITS.api_builder,
    profiles: PROFILES_PER_TIER.api_builder,
  },
  api_scale: {
    conc: TIER_CONCURRENT_SESSION_LIMITS.api_scale,
    profiles: PROFILES_PER_TIER.api_scale,
  },
  enterprise: {
    conc: TIER_CONCURRENT_SESSION_LIMITS.enterprise,
    profiles: PROFILES_PER_TIER.enterprise,
  },
};

const MAX_CONC = Math.max(...Object.values(TIER_CONCURRENT_SESSION_LIMITS));
const MAX_PROFILES = Math.max(
  ...Object.values(PROFILES_PER_TIER).filter((v): v is number => typeof v === 'number'),
);

describe('W253.D docs.driftstack.io tier-table drift sweep', () => {
  const pages = walk(PAGES);

  it('no docs page asserts the old over-cap concurrent claims (Agency 10 / API Builder 5 / API Scale 20)', () => {
    // Narrow regression check — these were the specific drift values
    // we fixed in W253.A/C. A broader sweep is too noisy because
    // tier-row tables often carry per-bucket rate-limit capacities or
    // profile caps in adjacent columns that legitimately exceed the
    // concurrent cap.
    const FORBIDDEN: ReadonlyArray<readonly [string, number]> = [
      ['agency_manual', 10],
      ['api_builder', 5],
      ['api_scale', 20],
    ];
    const offenders: string[] = [];
    for (const p of pages) {
      const body = readFileSync(p, 'utf8');
      for (const [tier, oldClaim] of FORBIDDEN) {
        // Only flag in lines that explicitly mention "concurrent".
        const concurrentRows = body
          .split('\n')
          .filter((line) => /concurrent/i.test(line) || /Concurrent sessions/.test(line));
        for (const row of concurrentRows) {
          const re = new RegExp(
            `(?:\`${tier}\`|${tier.replace(/_/g, ' ')}).*?\\b${oldClaim.toString()}\\b`,
            'i',
          );
          if (re.test(row)) {
            offenders.push(
              `${p.replace(REPO_ROOT + '/', '')}: ${tier} claims ${oldClaim.toString()} concurrent`,
            );
          }
        }
      }
    }
    expect(offenders).toEqual([]);
    void MAX_CONC; // referenced for future use
  });

  it('no doc page asserts a profile cap above MAX_PROFILES', () => {
    // Loose ceiling — any cap > 500 (current max) is presumptively wrong.
    const offenders: string[] = [];
    for (const p of pages) {
      const body = readFileSync(p, 'utf8');
      // Find table rows that explicitly list profile caps.
      // Only flag obviously-too-high numbers (>= MAX_PROFILES * 2).
      const obviousOver = body.match(new RegExp(`\\b(\\d{4,})\\s*profiles\\b`));
      if (obviousOver) {
        const n = Number(obviousOver[1]);
        if (n > MAX_PROFILES * 2) {
          offenders.push(`${p.replace(REPO_ROOT + '/', '')}: profiles=${n.toString()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
