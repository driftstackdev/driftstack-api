// TWO SESSIONS RUNNING ONE TASK MUST NOT SHARE A RHYTHM.
//
// ⛔ THIS IS THE ARM THAT SEPARATES A PACING POLICY FROM A DELAY WITH A NAME.
// Three bands shipped as three constants are three cluster centroids: a site
// that sees two of our sessions doing the same task and measures identical
// spacings has joined them, and it has done so with no page instrumentation of
// any kind — "were these two intervals equal" needs no model of what an
// interval should be. A per-session draw destroys that outright. It does NOT
// hide the pauses, the distribution is narrow, and it is ours; nothing here may
// be described as undetectable.
//
// ⛔ THE PRODUCTION DERIVATION IS WHAT IS UNDER TEST, not an injected fixture.
// Every other file in this slice injects `makeRandom` so its assertions are
// about placement. This one deliberately does not: the property is a fact about
// the DEFAULT seeding — session id mixed with a per-process salt — and a test
// that injected a generator would be checking a generator it wrote.
//
// ⚠️ AND THE SALT IS THE STATED COST. The sequence is stable inside a session
// and inside a process, and it does NOT survive a restart: two processes give
// one session id two rhythms. That is the trade the salt buys — a site holding
// a public session id cannot reproduce the sequence — and it is written here so
// the day a feature needs replayable rhythm, this is the expression to revisit.

import { describe, expect, it } from 'vitest';
import type { AgentIntent } from '../../src/services/agent-decomposer.js';
import { budgetFor, paceDevice, paceExecutor, pauseDurations } from './_helpers/pace-harness.js';

const PLAN: AgentIntent[] = [
  { kind: 'navigate', url: 'https://shop.test/a' },
  { kind: 'interact', action: 'tap', selector: '#one' },
  { kind: 'interact', action: 'type', selector: '#f1', value: 'a' },
  { kind: 'interact', action: 'type', selector: '#f2', value: 'b' },
  { kind: 'interact', action: 'tap', selector: '#send' },
  { kind: 'navigate', url: 'https://shop.test/b' },
  { kind: 'interact', action: 'tap', selector: '#two' },
];

/** One session's inserted-pause sequence, with the PRODUCTION generator. */
async function rhythmOf(sessionId: string): Promise<number[]> {
  const d = paceDevice();
  // No `makeRandom`: the default per-session derivation is the thing being
  // tested. `sleep` is still stubbed — this is about what was ASKED for, and a
  // test that really waited would take half a minute per session.
  await paceExecutor(d.dispatcher).execute({
    sessionId,
    agentSessionId: `agt_${sessionId}`,
    plan: { kind: 'plan', intents: PLAN, tokensConsumed: 0 },
    pace: budgetFor('slow', 30_000, { pageWordCount: 240 }),
  });
  return pauseDurations(d.sent);
}

describe('two sessions running one task do not share a rhythm', () => {
  it('CRITICAL twelve sessions run the SAME plan and no two produce the same interval sequence', async () => {
    const sequences: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      const rhythm = await rhythmOf(`ses_rhythm_${String(i)}`);
      // Anti-vacuity: a run that inserted nothing would make every sequence the
      // empty one, and "all distinct" would be false rather than silently true
      // — but an empty sequence is a broken fixture either way, so say so here.
      expect(rhythm.length, 'a session inserted no pauses at all').toBeGreaterThan(1);
      sequences.push(rhythm.join(','));
    }
    expect(new Set(sequences).size, `sequences: ${sequences.join(' | ')}`).toBe(sequences.length);
  });

  it('CRITICAL there is no constant dwell anywhere — across twelve sessions, no single duration dominates, and a fixed-delay policy would fail this', async () => {
    const all: number[] = [];
    for (let i = 0; i < 12; i += 1) all.push(...(await rhythmOf(`ses_spread_${String(i)}`)));
    expect(all.length).toBeGreaterThan(20);

    const counts = new Map<number, number>();
    for (const ms of all) counts.set(ms, (counts.get(ms) ?? 0) + 1);
    const commonest = Math.max(...counts.values());
    // ⛔ A SPIKE AT ANY SINGLE VALUE IS WHAT A SERVER CONSTANT PRODUCES. With
    // four beat kinds drawn independently per session, no one value should
    // carry a third of the corpus. Stated as a share rather than a count so the
    // threshold does not drift when the plan above grows a step.
    expect(commonest / all.length).toBeLessThan(0.34);
    // And the values really do spread: more distinct durations than beats in
    // the plan, which a per-beat constant could not produce.
    expect(counts.size).toBeGreaterThan(4);
  });

  it('CRITICAL one session keeps ONE rhythm — the same id, run twice in this process, asks for the same sequence', async () => {
    // The same "person" does not read at different speeds page to page, and a
    // session whose rhythm was re-rolled per step would be a session with no
    // rhythm at all. Within a process, a session id is stable.
    const first = await rhythmOf('ses_stable');
    const again = await rhythmOf('ses_stable');
    expect(again).toEqual(first);
    // …and a different id in the same process is different, so the equality
    // above is not "the generator ignores its seed".
    expect(await rhythmOf('ses_stable_other')).not.toEqual(first);
  });

  it('CRITICAL NEGATIVE CONTROL — a PROCESS-WIDE generator (one sequence shared by every session) makes the sessions identical, which is exactly the fingerprint the per-session seam removes', async () => {
    // ⛔ WHY THE CONTROL IS WORTH ITS LINES. Without it, "twelve sessions
    // differ" could be true of a build with no pacing at all, or of a fixture
    // that happened to vary. This shows the arm has teeth: swap the seam for
    // the shape it replaced, and the property fails.
    const shared = sharedSequenceGenerator();
    const sequences: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const d = paceDevice();
      await paceExecutor(d.dispatcher, { makeRandom: () => shared() }).execute({
        sessionId: `ses_shared_${String(i)}`,
        agentSessionId: `agt_shared_${String(i)}`,
        plan: { kind: 'plan', intents: PLAN, tokensConsumed: 0 },
        pace: budgetFor('slow', 30_000, { pageWordCount: 240 }),
      });
      sequences.push(pauseDurations(d.sent).join(','));
    }
    expect(new Set(sequences).size).toBe(1);
  });
});

/** Every session handed the SAME generator — the pre-seam shape, where one
 *  process-wide source served every session. */
function sharedSequenceGenerator(): () => () => number {
  let state = 0x9e3779b9;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return () => {
    // Reset per session so every session walks the same values — which is what
    // "two sessions share a rhythm" looks like at its worst.
    state = 0x9e3779b9;
    return next;
  };
}
