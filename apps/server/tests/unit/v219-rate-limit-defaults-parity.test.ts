// W731 — V-219 TIER_RATE_LIMIT_DEFAULTS server-side parity.
//
// Fifty-eighth in the cross-SDK drift-guard series. Pins the V-219
// per-tier rate-limit defaults Record in api-types/src/common.ts —
// the source of truth for token-bucket capacity + refill per
// (tier, bucketKey) pair.
//
// The bucket keys match the W704 + W713 + W706 cross-SDK rate-limit
// roster. Drift here would silently change customer rate limits without
// dashboard / SDK notification.
//
// V-1091: this said "The 2 bucket keys (global, sessions:create)" while
// four were enforced. A count written into a comment is a claim that goes
// stale in silence, so the roster arm below derives it.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { TIER_RATE_LIMIT_DEFAULTS } from '@driftstack/api-types';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const COMMON = resolve(REPO_ROOT, 'packages/api-types/src/common.ts');

describe('W731 V-219 TIER_RATE_LIMIT_DEFAULTS parity', () => {
  it('common.ts file exists', () => {
    expect(existsSync(COMMON)).toBe(true);
  });

  it('CRITICAL V-219 anchor + per-tier defaults framing pinned. The "per-tier rate-limit defaults (token-bucket capacity + refill)" wording is what tells engineers this is the wire-format law.', () => {
    const c = read(COMMON);
    expect(c).toMatch(/V-219 — per-tier rate-limit defaults \(token-bucket capacity \+ refill\)/);
  });

  it("CRITICAL the bucket-key roster in the doc comment lists every bucket the constant defines. V-1091: this arm used to pin a two-key roster and warn that a third would mismatch the cross-SDK guards — by then four existed, nothing had mismatched, and the comment still said 'Two bucket keys are defined today'. The count is derived from the constant now, so a fifth cannot be described here as anything else.", () => {
    const c = read(COMMON);
    const keys = Object.keys(
      TIER_RATE_LIMIT_DEFAULTS[
        Object.keys(TIER_RATE_LIMIT_DEFAULTS)[0] as keyof typeof TIER_RATE_LIMIT_DEFAULTS
      ],
    );
    const spelled = ['zero', 'one', 'Two', 'Three', 'Four', 'Five', 'Six'][keys.length];
    expect(c, 'the roster preamble no longer states the live bucket count').toContain(
      `${spelled} bucket keys are defined today:`,
    );
    for (const k of keys) {
      expect(c, `bucket key ${k} is enforced but absent from the roster comment`).toContain(
        `\`${k}\``,
      );
    }
    expect(c).toMatch(/`global` — every authenticated `\/v1\/\*` call consumes this bucket/);
    expect(c).toMatch(/`sessions:create` — `POST \/v1\/sessions` only\./);
    expect(c).toMatch(/Lower cap because\s*\n\s*\*\s*session creation is the most expensive op/);
  });

  it('CRITICAL anti-abuse-not-pricing framing pinned — "These are anti-abuse limits, not pricing — per ADR-004, customers pay for concurrent sessions, not per-call". The wording threads ADR-004\'s pricing-model decision into the rate-limit constants.', () => {
    const c = read(COMMON);
    expect(c).toMatch(
      /These are anti-abuse limits, not pricing — per ADR-004, customers\s*\n\s*\*\s*pay for concurrent sessions, not per-call/,
    );
  });

  it('CRITICAL V-052 per-account overrides framing pinned — "Per-account overrides via the rate-limit-overrides path (V-052) supersede these defaults". The override path is what lets admins bump real Enterprise customers above the floor.', () => {
    const c = read(COMMON);
    expect(c).toMatch(
      /Per-account overrides\s*\n\s*\*\s*via the rate-limit-overrides path \(V-052\) supersede these defaults/,
    );
  });

  it('CRITICAL BucketLimitConfig 2-field shape pinned — capacity + refill_per_second. The snake_case wire field is what dashboards + SDKs serialize/deserialize.', () => {
    const c = read(COMMON);
    expect(c).toMatch(
      /export interface BucketLimitConfig \{\s*\n\s*capacity: number;\s*\n\s*refill_per_second: number;\s*\n\s*\}/,
    );
  });

  it("CRITICAL TIER_RATE_LIMIT_DEFAULTS Record type-shape pinned — Record<AccountTier, Record<'global' | 'sessions:create' | 'agent_sessions:message' | 'agent_sessions:input_event', BucketLimitConfig>>. The 4-bucket-key shape (v2-#13 added agent_sessions:message AI chat throttle; Slice 4 added agent_sessions:input_event LK.6 manual-control stream).", () => {
    const c = read(COMMON);
    expect(c).toMatch(
      /export const TIER_RATE_LIMIT_DEFAULTS: Record<\s*\n\s*AccountTier,\s*\n\s*Record<\s*\n\s*'global' \| 'sessions:create' \| 'agent_sessions:message' \| 'agent_sessions:input_event',\s*\n\s*BucketLimitConfig\s*\n\s*>\s*\n>/,
    );
  });

  it('CRITICAL free rate limits — global 60/1 + sessions:create 5/(1/60). The 1-token-per-minute session-create cap matches the 16h trial budget.', () => {
    const c = read(COMMON);
    expect(c).toMatch(
      /free: \{\s*\n\s*global: \{ capacity: 60, refill_per_second: 1 \},\s*\n\s*'sessions:create': \{ capacity: 5, refill_per_second: 1 \/ 60 \},/,
    );
  });

  it('CRITICAL solo_manual rate limits — global 120/2 + sessions:create 10/(1/30).', () => {
    const c = read(COMMON);
    expect(c).toMatch(
      /solo_manual: \{\s*\n\s*global: \{ capacity: 120, refill_per_second: 2 \},\s*\n\s*'sessions:create': \{ capacity: 10, refill_per_second: 1 \/ 30 \},/,
    );
  });

  it('CRITICAL team_manual rate limits — global 360/6 + sessions:create 20/(1/10).', () => {
    const c = read(COMMON);
    expect(c).toMatch(
      /team_manual: \{\s*\n\s*global: \{ capacity: 360, refill_per_second: 6 \},\s*\n\s*'sessions:create': \{ capacity: 20, refill_per_second: 1 \/ 10 \},/,
    );
  });

  it('CRITICAL agency_manual rate limits — global 1_800/30 + sessions:create 60/1.', () => {
    const c = read(COMMON);
    expect(c).toMatch(
      /agency_manual: \{\s*\n\s*global: \{ capacity: 1_800, refill_per_second: 30 \},\s*\n\s*'sessions:create': \{ capacity: 60, refill_per_second: 1 \},/,
    );
  });

  it('CRITICAL api_starter rate limits — global 240/4 + sessions:create 15/(1/20).', () => {
    const c = read(COMMON);
    expect(c).toMatch(
      /api_starter: \{\s*\n\s*global: \{ capacity: 240, refill_per_second: 4 \},\s*\n\s*'sessions:create': \{ capacity: 15, refill_per_second: 1 \/ 20 \},/,
    );
  });

  it('CRITICAL api_builder rate limits — global 1_800/30 + sessions:create 60/1.', () => {
    const c = read(COMMON);
    expect(c).toMatch(
      /api_builder: \{\s*\n\s*global: \{ capacity: 1_800, refill_per_second: 30 \},\s*\n\s*'sessions:create': \{ capacity: 60, refill_per_second: 1 \},/,
    );
  });

  it('CRITICAL api_scale rate limits — global 6_000/100 + sessions:create 120/2.', () => {
    const c = read(COMMON);
    expect(c).toMatch(
      /api_scale: \{\s*\n\s*global: \{ capacity: 6_000, refill_per_second: 100 \},\s*\n\s*'sessions:create': \{ capacity: 120, refill_per_second: 2 \},/,
    );
  });

  it('CRITICAL enterprise rate limits — global 60_000/1_000 + sessions:create 600/10. The 60k/1k global capacity is the sentinel-floor (real Enterprise gets higher via V-052 override).', () => {
    const c = read(COMMON);
    expect(c).toMatch(
      /enterprise: \{\s*\n\s*global: \{ capacity: 60_000, refill_per_second: 1_000 \},\s*\n\s*'sessions:create': \{ capacity: 600, refill_per_second: 10 \},/,
    );
  });

  it('CRITICAL bucketConfigFor() helper indirection framing pinned. The helper at apps/server/src/services/rate-limit.ts is what every callsite uses; drift to inlining the lookup would scatter the source-of-truth.', () => {
    const c = read(COMMON);
    expect(c).toMatch(
      /the server reads from this constant via\s*\n\s*\*\s*`bucketConfigFor\(\)` in `apps\/server\/src\/services\/rate-limit\.ts`/,
    );
  });

  it('CRITICAL effective-sustained-RPS framing — `the effective sustained RPS for a default-cost call is refillPerSecond`. The framing tells engineers what the customer-visible rate actually is.', () => {
    const c = read(COMMON);
    expect(c).toMatch(
      /Capacity = max burst size\. Refill = sustained rate \(tokens\/sec\)\. The\s*\n\s*\*\s*effective sustained RPS for a default-cost call is `refillPerSecond`/,
    );
  });

  it('CRITICAL scale-with-concurrent-cap framing — "The numbers scale roughly with concurrent cap (more concurrent = more API calls likely)". The relationship explanation is what justifies the per-tier ladder.', () => {
    const c = read(COMMON);
    expect(c).toMatch(
      /The numbers scale roughly\s*\n\s*\*\s*with concurrent cap \(more concurrent = more API calls likely\)/,
    );
  });

  it('CRITICAL exposed-to-SDK-and-dashboard framing pinned. The "Exposed to SDK consumers + the customer dashboard so they can render the effective limit" wording tells engineers this is a STABLE PUBLIC API.', () => {
    const c = read(COMMON);
    expect(c).toMatch(
      /Exposed\s*\n\s*\*\s*to SDK consumers \+ the customer dashboard so they can render the/,
    );
    expect(c).toMatch(/effective limit on the \/settings \/ \/usage surface/);
  });

  it('CRITICAL all 8 tier entries present in TIER_RATE_LIMIT_DEFAULTS (matches W728 AccountTier roster).', () => {
    const c = read(COMMON);

    // Match within the TIER_RATE_LIMIT_DEFAULTS block.
    const block = c.match(/TIER_RATE_LIMIT_DEFAULTS:[\s\S]+?^\};/m)?.[0];
    expect(block).toBeDefined();

    for (const tier of [
      'free',
      'solo_manual',
      'team_manual',
      'agency_manual',
      'api_starter',
      'api_builder',
      'api_scale',
      'enterprise',
    ]) {
      expect(block, `${tier} in TIER_RATE_LIMIT_DEFAULTS`).toMatch(new RegExp(`${tier}: \\{`));
    }
  });

  it('CRITICAL ladder monotonicity — agency_manual and api_builder share global rate limit (1_800/30). The shared rung is intentional (different ladders, same throughput tier).', () => {
    const c = read(COMMON);
    expect(c).toMatch(
      /agency_manual:[\s\S]{0,100}global: \{ capacity: 1_800, refill_per_second: 30 \}/,
    );
    expect(c).toMatch(
      /api_builder:[\s\S]{0,100}global: \{ capacity: 1_800, refill_per_second: 30 \}/,
    );
  });

  it('V-219 6-invariant cluster — anchor + 2-bucket-key roster + 8 tier entries + anti-abuse-not-pricing framing + V-052 override path + BucketLimitConfig 2-field shape + bucketConfigFor() helper.', () => {
    const c = read(COMMON);

    expect(c).toMatch(/V-219/);
    expect(c).toMatch(/V-052/);
    expect(c).toMatch(/'global' \| 'sessions:create'/);
    expect(c).toMatch(/TIER_RATE_LIMIT_DEFAULTS/);
    expect(c).toMatch(/anti-abuse limits, not pricing/);
    expect(c).toMatch(/bucketConfigFor\(\)/);
    expect(c).toMatch(
      /export interface BucketLimitConfig \{[\s\S]{0,100}capacity: number;[\s\S]{0,100}refill_per_second: number;/,
    );
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/v219-rate-limit-defaults-parity.test.ts'),
      ),
    ).toBe(true);
  });
});
