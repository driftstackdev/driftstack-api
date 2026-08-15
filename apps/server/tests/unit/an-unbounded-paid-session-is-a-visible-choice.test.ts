// A paid session has no duration bound, and that is a decision, not an oversight.
//
// Billed minutes derive from the `sessions` table: an active row with no
// `destroyed_at` accrues to `now()`. `MAX_SESSION_MINUTES_PER_TIER` caps `free`
// at 20 minutes and leaves all seven paid tiers `null`, and `durationCutoffsFor`
// skips a null cap outright — "unlimited, never auto-destroyed". So a paid
// session that is abandoned, or whose driver dies quietly, bills until someone
// notices.
//
// THE READINESS ASSESSMENT RECORDED THIS AS BLOCKED ON A1/A3, on the grounds
// that "there is no liveness signal on driver sessions". That premise is wrong,
// and checking it was A2's to do rather than A3's to answer:
//
//   • Fleet nodes DO report liveness — `/v1/fleet/events` carries `heartbeat`
//     frames with `bootId` and `activeSessionStates`, gated on
//     `config.fleetControlPlaneEnabled`.
//   • The control plane ALREADY consumes it: a `bootId` change closes the
//     sessions a restarted node can no longer be running (`node-boot-reconcile`),
//     worker-reported orphans are reconciled (`cp-daemon-reconcile`), and there
//     is an orphan sweeper with its own reap job.
//   • All of that is wired to `agent_sessions`. The `sessions` table — the one
//     that bills — has no equivalent, and no node column to hang one on.
//
// So the signal exists and is proven in production code; it simply does not
// reach the table that bills. That makes this an engineering task in A2's own
// scope rather than a question for another agent — and a cheap one, because
// `durationCutoffsFor` iterates the whole tier enum and picks up a newly capped
// tier with no sweep change. Capping a paid tier is one value in one table.
//
// WHAT IS ACTUALLY UNDECIDED is the number: how long a paid session must run
// before it counts as abandoned. That is a product call with real customer
// consequences — a long-running session is a legitimate use of the product —
// so this file does not invent one. It holds the current posture visible so the
// choice stays a choice, and fails if any part of the reasoning above stops
// being true.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AccountTierSchema, MAX_SESSION_MINUTES_PER_TIER } from '@driftstack/api-types';
import { durationCutoffsFor } from '../../src/services/session-duration-sweeper.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const SCHEMA = resolve(REPO_ROOT, 'apps/server/src/db/schema.ts');

const API_TYPES_SRC = resolve(REPO_ROOT, 'packages/api-types/src/common.ts');

/**
 * The cap table as WRITTEN IN SOURCE, not as built.
 *
 * `@driftstack/api-types` resolves to `dist/index.js`, and a local `npm test`
 * does not rebuild it — CI does (`npm run build` precedes the test job), but the
 * local loop does not. So a developer can change a cap in `src`, run the suite,
 * and watch every assertion about that cap pass against a build artifact from
 * days earlier.
 *
 * That is not hypothetical here: three mutations of this file's own cap table
 * failed to red anything until this function existed, because the test was
 * reading the built copy. The arm below compares the two so the staleness itself
 * is reported rather than quietly making everything else vacuous.
 */
function capsFromSource(): Record<string, number | null> {
  const block = /MAX_SESSION_MINUTES_PER_TIER[^{]*\{([\s\S]*?)\}/.exec(
    readFileSync(API_TYPES_SRC, 'utf8'),
  )?.[1];
  if (block === undefined) return {};
  const caps: Record<string, number | null> = {};
  for (const [, tier, value] of block.matchAll(/(\w+):\s*(null|\d+)\s*,/g)) {
    if (tier !== undefined && value !== undefined)
      caps[tier] = value === 'null' ? null : Number(value);
  }
  return caps;
}

/** The `sessions` table definition, as written. */
function sessionsTableSource(): string {
  const schema = readFileSync(SCHEMA, 'utf8');
  const start = schema.indexOf('export const sessions = pgTable');
  if (start === -1) return '';
  const end = schema.indexOf('export const ', start + 30);
  return schema.slice(start, end === -1 ? start + 6000 : end);
}

describe('an unbounded paid session is a visible choice', () => {
  it('CRITICAL the cap table was read FROM SOURCE and covers every tier the enum defines. The arms below reason about which tiers are uncapped, and a table that parsed to nothing would make "all paid tiers are null" true by absence rather than by decision.', () => {
    const tiers = AccountTierSchema.options;
    const caps = capsFromSource();
    // MEASURED: 8 tiers — free plus seven paid.
    expect(tiers.length, 'tiers in the enum').toBe(8);
    expect(Object.keys(caps).length, 'entries parsed out of the source table').toBe(8);
    const missing = tiers.filter((t) => !(t in caps));
    expect(missing, 'tier(s) with no entry in MAX_SESSION_MINUTES_PER_TIER:').toEqual([]);
  });

  it('CRITICAL the built package agrees with source. `@driftstack/api-types` resolves to dist and a local `npm test` does not rebuild it, so every other assertion about these caps would otherwise be made against a build artifact from days earlier — green while the source says something else. CI builds first; the local loop does not.', () => {
    const caps = capsFromSource();
    const built = Object.fromEntries(
      AccountTierSchema.options.map((t) => [t, MAX_SESSION_MINUTES_PER_TIER[t]]),
    );
    expect(
      built,
      'built api-types cap table vs packages/api-types/src — rebuild if this fails',
    ).toEqual(caps);
  });

  it('CRITICAL exactly one tier is capped, and it is `free`. Every paid tier being `null` is the whole of the abandoned-session exposure — it is recorded here so raising or removing a cap is a deliberate edit against a stated baseline rather than a quiet change to a lookup table.', () => {
    const caps = capsFromSource();
    const capped = Object.keys(caps)
      .filter((t) => caps[t] !== null)
      .sort();
    expect(capped, 'tiers with a duration cap').toEqual(['free']);
    expect(caps.free, 'the free cap, in minutes').toBe(20);
  });

  it('CRITICAL the sweeper genuinely never targets an uncapped tier. Behavioural, not textual: a null cap is skipped rather than treated as zero — the difference between "paid sessions are never auto-destroyed" and "paid sessions are destroyed immediately" is one `continue`.', () => {
    const cutoffs = durationCutoffsFor(new Date('2026-08-15T12:00:00.000Z'));
    expect(
      cutoffs.map((c) => c.tier).sort(),
      'tiers the duration sweep produces cutoffs for',
    ).toEqual(['free']);
    // And the cutoff is the cap behind now, not the epoch or now itself.
    expect(cutoffs[0]?.expiredBefore.toISOString(), 'free cutoff = now - 20m').toBe(
      '2026-08-15T11:40:00.000Z',
    );
  });

  it('CRITICAL the billing `sessions` table still has no node attribution. This is why the fleet bootId reaper — which already closes orphaned AGENT sessions when a node restarts — cannot simply be pointed at the table that bills. If a node column is ever added, that reaper becomes extensible and this exposure has a cheap fix; the arm exists to say so at that moment rather than years later.', () => {
    const table = sessionsTableSource();
    expect(table.length, 'the sessions table definition was found').toBeGreaterThan(200);
    expect(table, 'no mac/fleet node column on sessions').not.toMatch(/mac_node_id|macNodeId/);
  });
});
