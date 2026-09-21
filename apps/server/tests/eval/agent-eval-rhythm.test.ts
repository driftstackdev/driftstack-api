// R11 — the eval measures RHYTHM AND ORDER, not presence.
//
// WHAT IT MEASURED BEFORE. One criterion, on one task: "≥1 succeeded
// behavioral_pause AND ≥1 succeeded scroll". Presence, on the wire, which was
// already an improvement on counting the typed plan — but a run that fires both
// beats back to back at machine speed passes it, and so does a run whose every
// tap re-fires at exactly the same interval.
//
// ⛔ EVERYTHING HERE IS READ OFF THE DEVICE'S DISPATCH LOG. `report.byHarness
// Intent` is computed from PLAN STEPS, which is why the suite can assert
// `perceive` is undefined there while the device sees one before every tap. A
// rhythm assertion built on it would be an assertion about what we typed.
//
// ⛔ AND NONE OF IT SAYS A RUN LOOKS HUMAN. These are properties the control
// plane owns: was every tap looked at first, did the dispatched vocabulary stay
// inside the ten, did a tap carry coordinates, how dense were the human beats,
// and were two spacings machine-equal. What the device then did with each verb
// is the device team's measurement, and the fake device models none of it.
//
// ⛔ THE FIXTURE PREREQUISITES ARE HALF THE POINT. The fake device used to
// hardcode `behavioral: true` on every result, so "the AI's actions took the
// behavioural path" was true here by construction and said nothing; and it
// recorded no timestamp at all, so no spacing could be asserted. Both are fixed,
// and both have an arm below that would fail if they regressed.

import { beforeAll, describe, expect, it } from 'vitest';
import { EVAL_TASKS } from './_lib/tasks.js';
import { RHYTHM_ALLOWED_VERBS, rhythmOf, type TaskReport } from './_lib/score.js';
import {
  EVAL_MAX_RETRIES,
  EVAL_OBSERVE_TIMEOUT_MS,
  EVAL_RETRY_DELAY_MS,
  EVAL_SESSION_ESTABLISH_RETRY_DELAY_MS,
  countsAsElapsedBrowsingTime,
  evalRandom,
  runEvalTask,
} from './_lib/runner.js';
import { FakeDevice } from './_lib/fake-device.js';
import { VirtualClock } from './_lib/virtual-clock.js';
import { EVAL_SITES } from './_lib/page-model.js';
import { ControlPlaneAgentExecutor } from '../../src/services/agent-executor-control-plane.js';
import type { AgentIntent } from '@driftstack/api-types';

let reports: TaskReport[] = [];

beforeAll(async () => {
  reports = [];
  for (const task of EVAL_TASKS) reports.push(await runEvalTask(task));
}, 120_000);

function rhythmFor(taskId: string): TaskReport['rhythm'] {
  const found = reports.find((report) => report.taskId === taskId);
  if (found === undefined) throw new Error(`no report for ${taskId}`);
  return found.rhythm;
}

describe('R11 — ordering, run-wide: a tap is looked at before it is sent', () => {
  it('CRITICAL every dispatched click and send_keys had a perceive for the SAME locator before it', () => {
    // Pinned case-by-case until now
    // (`a-tap-looks-at-what-it-will-land-on-before-it-is-sent`), which cannot
    // see a whole corpus drifting.
    const offenders = reports.flatMap((report) =>
      report.rhythm.unlooked.map(
        (entry) => `${report.taskId}: ${entry.verb} ${entry.locator} — ${entry.why}`,
      ),
    );
    expect(
      offenders,
      'every one of these is a tap the device performed without being asked what it would land on',
    ).toEqual([]);
  });

  it('the corpus really does dispatch actions — the arm above is not vacuous', () => {
    const actions = reports.reduce((total, report) => total + report.rhythm.actions, 0);
    expect(actions).toBeGreaterThan(0);
    // …and looks, which is what makes "looked" a match rather than an absence.
    expect(reports.some((report) => report.rhythm.verbs.includes('perceive'))).toBe(true);
  });
});

describe('R11 — vocabulary and shape, at the wire', () => {
  it('CRITICAL the dispatched verb set is a SUBSET of the ten, and execute_script is absent', () => {
    // Complements the static source scan: that one proves no emit site NAMES
    // another verb, this one proves no run SENT one.
    const dispatched = new Set(reports.flatMap((report) => report.rhythm.verbs));
    expect(dispatched.size).toBeGreaterThan(0);
    for (const verb of dispatched) {
      expect(RHYTHM_ALLOWED_VERBS.has(verb), `${verb} is not one of the ten`).toBe(true);
    }
    expect(dispatched.has('execute_script')).toBe(false);
  });

  it('CRITICAL no click carries coordinates, and no look carries a typed value', () => {
    for (const report of reports) {
      expect(report.rhythm.clicksCarryingCoordinates, report.taskId).toBe(0);
      expect(report.rhythm.perceivesCarryingAValue, report.taskId).toBe(0);
    }
  });
});

describe('R11 — density, not presence', () => {
  it('the open-ended task keeps a floor of human beats per site-visible action', () => {
    // ⛔ A FLOOR, NOT A PRESENCE TEST. "At least one pause and one scroll
    // happened" is satisfied by a run that does both at the start and then
    // taps twenty times; density falls with task complexity, which is exactly
    // the shape a detector looks for — the busiest sessions being the least
    // human.
    const browse = rhythmFor('P4');
    expect(browse.siteActions).toBeGreaterThan(0);
    expect(browse.beatDensity).not.toBeNull();
    expect(
      browse.beatDensity ?? 0,
      'the open-ended browse task dispatched fewer human beats than site-visible actions',
    ).toBeGreaterThanOrEqual(1);
  });

  it('⛔ states what the floor does NOT say', () => {
    // It says beats were SENT, at a rate. It says nothing about what the device
    // did with them — the fake device models a pause as a fixed cost and a
    // scroll as a flag — and nothing about whether a real site would read the
    // result as a person. Written here rather than only in a report.
    const browse = rhythmFor('P4');
    expect(browse.beats).toBeGreaterThan(0);
  });
});

describe('R11 — spacing: two re-dispatches of one action are not machine-equal', () => {
  it('CRITICAL a retried step’s re-dispatch gaps are not all exactly equal', async () => {
    // ⛔ THE INVERSE OF THE ASSERTION THAT WAS REJECTED, and it is the one the
    // control plane can own. "No two runs produce identical timing" is true by
    // construction against a device with fixed per-action costs, and is not a
    // control-plane property anyway. Whether the SAME action re-fires at the
    // same interval twice is.
    const gaps = await repeatGapsForOneStep('agt_rhythm_a');
    expect(gaps.length, 'the harness must actually provoke re-dispatches').toBeGreaterThanOrEqual(
      2,
    );
    expect(
      new Set(gaps).size,
      `identical re-dispatch spacings: ${gaps.join(', ')}`,
    ).toBeGreaterThan(1);
  });

  it('CRITICAL two sessions do not share a gap sequence', async () => {
    // Uses the PRODUCT's own per-session seeding, not an injected source: the
    // property is about what ships.
    const first = await repeatGapsForOneStep('agt_rhythm_one');
    const second = await repeatGapsForOneStep('agt_rhythm_two');
    expect(first.length).toBeGreaterThanOrEqual(2);
    expect(second).toHaveLength(first.length);
    expect(first, 'a shared sequence is a cross-session join key').not.toEqual(second);
  });

  it('⛔ MUTATION ARM: with the draw pinned, both properties fail — so the draw is what carries them', async () => {
    const pinned = () => () => 0.5;
    const first = await repeatGapsForOneStep('agt_pinned_one', pinned);
    const second = await repeatGapsForOneStep('agt_pinned_two', pinned);
    expect(new Set(first).size, 'a pinned draw must produce equal spacings').toBe(1);
    expect(second, 'a pinned draw must make two sessions identical').toEqual(first);
  });
});

describe('R11 — the fixture prerequisites, without which the assertions lie', () => {
  it('CRITICAL the device can answer `behavioral: false` — the flag is no longer true by construction', async () => {
    const clock = new VirtualClock(countsAsElapsedBrowsingTime);
    const device = new FakeDevice({
      sites: EVAL_SITES,
      startUrl: 'https://shop.test/deals',
      clock,
      behavioral: false,
    });
    let n = 0;
    const executor = new ControlPlaneAgentExecutor(
      device.dispatcher,
      () => `int_flag_${(n += 1).toString()}`,
      { sleep: clock.sleep, deadline: clock.deadline, makeRandom: () => evalRandom('flag') },
    );
    const paths = await executor.execute({
      sessionId: 'ses_flag',
      agentSessionId: 'agt_flag',
      plan: {
        kind: 'plan',
        intents: [{ kind: 'interact', action: 'tap', selector: 'button#show-sold-out' }],
        tokensConsumed: 0,
      },
    });
    // The executor's own counter is what reads the flag in production.
    expect(paths.actionPaths?.profileAttached.false).toBeGreaterThan(0);
    expect(paths.actionPaths?.profileAttached.true ?? 0).toBe(0);

    // …and the default is still the other answer, so both branches exist.
    const clockTrue = new VirtualClock(countsAsElapsedBrowsingTime);
    const deviceTrue = new FakeDevice({
      sites: EVAL_SITES,
      startUrl: 'https://shop.test/deals',
      clock: clockTrue,
    });
    let m = 0;
    const executorTrue = new ControlPlaneAgentExecutor(
      deviceTrue.dispatcher,
      () => `int_flagt_${(m += 1).toString()}`,
      {
        sleep: clockTrue.sleep,
        deadline: clockTrue.deadline,
        makeRandom: () => evalRandom('flag'),
      },
    );
    const truePaths = await executorTrue.execute({
      sessionId: 'ses_flagt',
      agentSessionId: 'agt_flagt',
      plan: {
        kind: 'plan',
        intents: [{ kind: 'interact', action: 'tap', selector: 'button#show-sold-out' }],
        tokensConsumed: 0,
      },
    });
    expect(truePaths.actionPaths?.profileAttached.true).toBeGreaterThan(0);
  });

  it('CRITICAL every dispatch carries a timestamp, taken from the injected clock', async () => {
    // Without it nothing above about spacing could be written at all. Read off
    // the CLOCK, never re-derived from the per-action costs — an assertion that
    // rebuilt the timeline from the costs would agree with itself.
    const { device } = await runOneStep('agt_stamp');
    const records = device.dispatches();
    expect(records.length).toBeGreaterThan(1);
    for (const record of records) {
      expect(Number.isFinite(record.atMs)).toBe(true);
    }
    for (let index = 1; index < records.length; index += 1) {
      expect(records[index]!.atMs).toBeGreaterThanOrEqual(records[index - 1]!.atMs);
    }
    // And the log really is the source of the gaps the report carries.
    expect(rhythmOf(records).gaps).toHaveLength(records.length - 1);
  });
});

/**
 * One step against a page whose element is never there, so the click spends its
 * whole retry budget and the SAME action re-fires. That is the shape a site
 * provokes with one cheap failure, and the only shape a re-dispatch gap can be
 * read from.
 */
async function runOneStep(
  sessionId: string,
  makeRandom?: () => () => number,
): Promise<{ device: FakeDevice }> {
  const clock = new VirtualClock(countsAsElapsedBrowsingTime);
  const device = new FakeDevice({
    sites: EVAL_SITES,
    startUrl: 'https://shop.test/deals',
    clock,
    // A device that predates the look answers with its page listing, so the
    // click's OWN element-not-found retries are what run — which is exactly
    // the path whose spacing the audit is about.
    predatesTapLook: true,
  });
  let n = 0;
  const executor = new ControlPlaneAgentExecutor(
    device.dispatcher,
    () => `int_${sessionId}_${(n += 1).toString()}`,
    {
      maxRetries: EVAL_MAX_RETRIES,
      retryDelayMs: EVAL_RETRY_DELAY_MS,
      sessionEstablishRetryDelayMs: EVAL_SESSION_ESTABLISH_RETRY_DELAY_MS,
      observeTimeoutMs: EVAL_OBSERVE_TIMEOUT_MS,
      planningObserveTimeoutMs: EVAL_OBSERVE_TIMEOUT_MS,
      sleep: clock.sleep,
      deadline: clock.deadline,
      // No element wait, so the retries are the only thing between the two
      // dispatches and the gap is the drawn one.
      elementAppearWaitMs: 0,
      ...(makeRandom !== undefined ? { makeRandom } : {}),
    },
  );
  const intents: AgentIntent[] = [
    { kind: 'interact', action: 'tap', selector: '#never-on-this-page' },
  ];
  await executor.execute({
    sessionId,
    agentSessionId: sessionId,
    plan: { kind: 'plan', intents, tokensConsumed: 0 },
  });
  return { device };
}

async function repeatGapsForOneStep(
  sessionId: string,
  makeRandom?: () => () => number,
): Promise<number[]> {
  const { device } = await runOneStep(sessionId, makeRandom);
  return rhythmOf(device.dispatches()).repeatGaps;
}
