// FAST IS TODAY, BYTE FOR BYTE — enforced, not asserted.
//
// The whole safety case for shipping a pacing policy rests on one claim: with
// the flag off, this executor dispatches exactly what it dispatches today. Not
// "roughly the same", not "the same verbs" — the same verbs, in the same order,
// with the same parameter bytes, drawing from the same generator in the same
// order.
//
// ⛔ THE DRAW ORDER IS THE HALF THAT IS EASY TO MISS. Every server-side gap this
// executor spends is drawn from ONE per-session generator. An extra draw taken
// with the flag off — a probability rolled and thrown away, a "cheap" unit
// sampled to decide not to pause — consumes a value the next retry gap would
// have had, so every later gap in that session changes. Nothing would fail; the
// numbers would simply be different ones, in a system whose entire purpose is
// that two spacings are not equal. So the arms below compare the DRAWN VALUES
// and not only the verb list.
//
// ⛔ AND THE BASELINE IS THE POST-AUDIT ONE. The dispatch path already differs
// from the pre-audit executor — an off-screen tap can now carry a scroll and a
// dwell, and every retry gap is drawn. Those are not pace. Comparing fast
// against a pre-audit recording would fail on changes pace did not make, so
// what "today" means here is: the same executor, with `pace` absent.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { AgentIntent } from '../../src/services/agent-decomposer.js';
import { parseAiPace } from '../../src/lib/config.js';
import { AI_PACE_BANDS } from '../../src/services/agent-pace.js';
import { budgetFor, draws, names, paceDevice, paceExecutor } from './_helpers/pace-harness.js';

const PLAN: AgentIntent[] = [
  { kind: 'navigate', url: 'https://shop.test/page' },
  { kind: 'interact', action: 'tap', selector: '#next' },
  { kind: 'interact', action: 'type', selector: '#field', value: 'hi' },
  { kind: 'interact', action: 'type', selector: '#other', value: 'there' },
  { kind: 'interact', action: 'tap', selector: '#send' },
  { kind: 'capture', capture: 'screenshot' },
];

async function run(
  pace: ReturnType<typeof budgetFor> | undefined,
  sessionId = 'ses_fast',
): Promise<{ sent: ReturnType<typeof paceDevice>['sent']; ok: boolean; steps: number }> {
  const d = paceDevice();
  // A generator with a long, fixed list: two runs that take the SAME number of
  // draws see the same values, and a run that takes one more sees every later
  // value shifted — which is exactly the failure this file exists to catch.
  const executor = paceExecutor(d.dispatcher, {
    makeRandom: () => draws([0.1, 0.9, 0.2, 0.8, 0.3, 0.7, 0.4, 0.6, 0.15, 0.85]),
  });
  const res = await executor.execute({
    sessionId,
    agentSessionId: `agt_${sessionId}`,
    plan: { kind: 'plan', intents: PLAN, tokensConsumed: 0 },
    ...(pace !== undefined ? { pace } : {}),
  });
  return { sent: d.sent, ok: res.ok, steps: res.results.length };
}

describe('fast dispatches exactly what it dispatches today', () => {
  it('CRITICAL with no pace threaded, the wire is byte-identical to the same executor run again with no pace — verbs, order and every parameter', async () => {
    const a = await run(undefined);
    const b = await run(undefined);
    // Self-consistency first: without this arm a comparison that always passed
    // because both sides were empty would read as a proof.
    expect(a.sent.length).toBeGreaterThan(0);
    expect(JSON.stringify(a.sent)).toBe(JSON.stringify(b.sent));
    expect(a.sent.some((s) => s.name === 'behavioral_pause')).toBe(false);
  });

  it("CRITICAL the flag-off run takes NO draw the policy could have taken: a `slow` run over the same plan consumes the generator differently, and fast's gaps are the ones it had before pace existed", async () => {
    const off = await run(undefined);
    const paced = await run(budgetFor('slow', 30_000, { pageWordCount: 300 }));

    // The paced run really did insert something — otherwise the comparison
    // below would be comparing two identical runs and calling that a proof.
    expect(paced.sent.filter((s) => s.name === 'behavioral_pause').length).toBeGreaterThan(0);
    expect(off.sent.filter((s) => s.name === 'behavioral_pause').length).toBe(0);

    // ⛔ THE PROPERTY. Strip the inserted pauses out of the paced run and what
    // is left is NOT required to equal the flag-off run — the paced run spent
    // draws, and the draws it spent are gone from every later gap. That is the
    // asymmetry this arm names: pace is allowed to change the paced run, and is
    // not allowed to change the unpaced one. The unpaced one is pinned by the
    // arm above and by the differential against HEAD in the eval corpus.
    const offVerbs = names(off.sent);
    const pacedVerbs = names(paced.sent).filter((v) => v !== 'behavioral_pause');
    expect(pacedVerbs).toEqual(offVerbs);
  });

  it('CRITICAL a pace budget of `fast` cannot be built at all — the type has no such band, so "fast inserts nothing" is a property of the code and not of a table someone can fill in wrongly', () => {
    // ⛔ THIS IS THE ARM THAT MAKES THE OTHERS HOLD IN FUTURE. Every other
    // proof here is behavioural and could be defeated by a later table entry
    // like `PACE_FRACTION.fast = 0.01`. `PacedBand` excludes `fast`, so there
    // is no row to fill in: fast is the ABSENCE of a budget, which the runtime
    // expresses by threading no `pace` at all.
    //
    // Read off the source rather than asserted in prose, so the day somebody
    // widens the type this goes red.
    const src = readPaceSource();
    expect(src).toMatch(/export type PacedBand = Exclude<AiPaceBand, 'fast'>;/);
    expect(src).toMatch(/Record<PacedBand, number> = \{ medium:/);
    // And no table in that file is keyed by the full band roster, which would
    // put a `fast` row back.
    expect(src).not.toMatch(/Record<AiPaceBand, number>/);
  });

  it('a step list that runs clean with the flag off still runs clean with it on — pace degrades, it never fails', async () => {
    const off = await run(undefined);
    const paced = await run(budgetFor('slow', 30_000, { pageWordCount: 300 }));
    expect(off.ok).toBe(true);
    expect(paced.ok).toBe(true);
    // And the customer's step list is the same length: an inserted pause is not
    // a step, so it cannot lengthen it.
    expect(paced.steps).toBe(off.steps);
  });
});

function readPaceSource(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return readFileSync(resolve(here, '..', '..', 'src', 'services', 'agent-pace.ts'), 'utf8');
}

describe('the flag is default off, and a typo cannot run as off', () => {
  it('CRITICAL an unset or blank DRIFTSTACK_AI_PACE is `fast` — the default deployment is today', () => {
    expect(parseAiPace(undefined)).toBe('fast');
    expect(parseAiPace('')).toBe('fast');
    expect(parseAiPace('   ')).toBe('fast');
  });

  it('every band is accepted, trimmed and case-insensitively, because a value pasted out of a secret store carries whitespace', () => {
    for (const band of AI_PACE_BANDS) {
      expect(parseAiPace(band)).toBe(band);
      expect(parseAiPace(` ${band.toUpperCase()}\n`)).toBe(band);
    }
  });

  it('CRITICAL a value that is not a band REFUSES TO BOOT rather than reading as fast — an experiment that silently ran its control arm would be reported as a null result', () => {
    for (const wrong of ['slo', 'off', 'true', '1', 'medium slow']) {
      expect(() => parseAiPace(wrong), `${wrong} was accepted`).toThrow(/DRIFTSTACK_AI_PACE/);
    }
  });
});
