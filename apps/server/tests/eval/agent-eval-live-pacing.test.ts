// PACING THE LIVE TIER — `EVAL_LIVE_MAX_RPM`, proved without a key.
//
// ⛔ WHY IT EXISTS, MEASURED 2026-09-20. A six-arm comparison through one
// aggregator key was invalid: 54, 79 and 44 calls across three arms came back
// `Rate limit exceeded: new-account-rpm/<model> … new accounts are limited to 20
// requests per minute for this model`. Every one was scored
// `provider_call_failed`, which is right — a failed provider call is never a
// model failure — and the run had still measured the ACCOUNT'S rate limit
// instead of the models. The eval starts a call every two or three seconds, so
// it crosses twenty a minute by itself.
//
// ⛔ AND THE PROPERTY THAT MATTERS MORE THAN THE FEATURE: PACING MUST NOT
// DISTORT WHAT IS MEASURED. Every test below is one half of that pair —
//
//   · the wait is taken BEFORE each call's own clock starts, so first-token and
//     total latency are the provider's numbers whether or not a run was paced
//     (and the negative control moves the same wait INSIDE the call's clock and
//     watches that assertion fail);
//   · the wait IS inside the turn, so the runtime's three-minute ceiling counts
//     it exactly as it counts a slow model — which is a real behaviour change,
//     so the report flags any turn that ended there while pacing was on, and
//     the negative control is the same model unpaced, which never gets flagged;
//   · the spend caps still win: a run at its call cap refuses instantly and
//     waits for nothing;
//   · and the waiting is REPORTED rather than absorbed, in the text header and
//     in the JSON, so a paced run's seconds still add up.
//
// Everything here runs against the stand-in provider on an injected clock. No
// key, no network, no real sleeping — and, as everywhere in this tier, nothing
// below is evidence about how well any model plans.

import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MAX_MODEL_CALLS_PER_TURN,
  MAX_TURN_WALL_CLOCK_MS,
} from '../../src/services/agent-runtime.js';
import {
  AGGREGATOR_NEW_ACCOUNT_RPM,
  DEFAULT_LIVE_CAPS,
  LIVE_ENTRY_ENV_NAME,
  LIVE_ENTRY_MARKER,
  LIVE_HOW_TO_RUN,
  LIVE_KEY_ENV_NAMES,
  LiveConfigError,
  SUGGESTED_PACED_RPM,
  readLiveConfig,
} from './_lib/live-config.js';
import {
  LiveMeter,
  LiveSpendCapReachedError,
  isRateLimitRefusal,
  pacingGapMs,
  type LiveClock,
} from './_lib/live-meter.js';
import {
  renderLiveReport,
  runLiveSuite,
  turnsEndedOnTheWallClock,
  writeLiveReport,
  type LiveReport,
  type LiveSuiteArgs,
} from './_lib/live-report.js';
import { referenceModel } from './_lib/live-reference-models.js';
import { LIVE_TASKS, type LiveTask } from './_lib/live-tasks.js';
import {
  answerReply,
  planReply,
  standInProvider,
  type StandInModel,
} from './_lib/stand-in-planner-provider.js';

/** ⛔ NOT A KEY. A sentinel shaped like one, so a leak is findable by search. */
const SENTINEL_KEY = 'sk-ant-SENTINEL-pacing-not-a-real-key-71c4';

/** The model these tests PRICE. Named, never the moving product default: the
 *  arithmetic here is a statement about the meter at one price list. */
const PRICED_MODEL = 'claude-opus-5';

/** The rate the README recommends through one aggregator key, and the gap it
 *  implies. Read from the config module so the number in the test, the number in
 *  the usage sentence and the number in the README are ONE number. */
const PACED_RPM = SUGGESTED_PACED_RPM;
const GAP_MS = pacingGapMs(PACED_RPM);

/** How long the stand-in "provider" takes, on the injected clock. Non-zero on
 *  purpose: a latency assertion whose expected value is 0 would also hold for a
 *  meter that measured nothing. */
const CALL_TAKES_MS = 900;

function task(id: string): LiveTask {
  const found = LIVE_TASKS.find((t) => t.id === id);
  if (found === undefined) throw new Error(`no live task ${id}`);
  return found;
}

/**
 * A clock that moves ONLY when something sleeps or works on it.
 *
 * It is handed to the meter (its `now` and its pacing `sleep`) AND to the
 * runtime's wall-clock ceiling, because a live run has one clock and the whole
 * question here is what the two see of each other.
 */
function standInClock(): LiveClock & { advance: (ms: number) => void } {
  let nowMs = 0;
  return {
    now: () => nowMs,
    advance: (ms: number) => {
      if (ms > 0) nowMs += ms;
    },
    sleep: (ms: number) => {
      if (ms > 0) nowMs += ms;
      return Promise.resolve();
    },
  };
}

/**
 * The stand-in provider, with the instant each call reached it — read off the
 * SAME clock the meter paces on, so "when did the call start" is a measurement
 * rather than an inference from the reported latency.
 *
 * `spendsInsideTheCall` is how the negative control moves the wait to the wrong
 * side of the call's clock: time the provider itself burns after the meter has
 * started timing.
 */
function timedProvider(
  model: StandInModel,
  clock: LiveClock & { advance: (ms: number) => void },
  spendsInsideTheCall = CALL_TAKES_MS,
) {
  const inner = standInProvider({ model, expectedKey: SENTINEL_KEY });
  const startedAt: number[] = [];
  const fetch: typeof globalThis.fetch = (url, init) => {
    startedAt.push(clock.now());
    clock.advance(spendsInsideTheCall);
    return inner.fetch(url, init);
  };
  return { fetch, startedAt, log: inner.log };
}

function suiteArgs(
  tasks: ReadonlyArray<LiveTask>,
  providerFetch: typeof globalThis.fetch,
  clock: LiveClock,
  overrides: Partial<LiveSuiteArgs> = {},
): LiveSuiteArgs {
  return {
    tasks,
    apiKey: SENTINEL_KEY,
    keySource: LIVE_KEY_ENV_NAMES[0],
    model: PRICED_MODEL,
    reps: 1,
    maxTurns: 2,
    caps: DEFAULT_LIVE_CAPS,
    gitSha: 'test',
    providerFetch,
    retryBackoffMs: 0,
    // Real milliseconds of stand-in "thinking" must never age a fixture page.
    pageAgesWhileModelThinks: () => 0,
    clock,
    runId: 'pacing',
    ...overrides,
  };
}

/** Every call's measured latency, in order — the numbers pacing must not move. */
function latenciesOf(report: LiveReport): Array<[number | null, number | null]> {
  return report.tasks.flatMap((t) =>
    t.reps.flatMap((r) =>
      r.callTimings.map((c) => [c.firstTokenMs, c.totalMs] as [number, number]),
    ),
  );
}

/** Every gap between one call STARTING and the next, on the injected clock. */
function gapsBetweenStarts(startedAt: ReadonlyArray<number>): number[] {
  return startedAt.slice(1).map((at, i) => at - (startedAt[i] ?? 0));
}

const READ = () => task('L-READ');

// ── the option, and what refusing to parse it protects ────────────────

describe('live pacing — the variable is read with the same strictness as every other knob', () => {
  const env = {
    EVAL_LIVE: '1',
    [LIVE_ENTRY_ENV_NAME]: LIVE_ENTRY_MARKER,
    [LIVE_KEY_ENV_NAMES[0]]: SENTINEL_KEY,
  };

  it('unset means NO pacing — exactly the behaviour that shipped before the option existed', () => {
    // The positive control: this environment IS enabled, so a null below is
    // about the variable and not about a gate that was never open.
    const config = readLiveConfig(env);
    expect(config.enabled).toBe(true);
    expect(config.enabled ? config.maxRpm : 'disabled').toBeNull();
    expect(readLiveConfig({ ...env, EVAL_LIVE_MAX_RPM: '   ' }).enabled).toBe(true);
    const blank = readLiveConfig({ ...env, EVAL_LIVE_MAX_RPM: '   ' });
    expect(blank.enabled ? blank.maxRpm : 'disabled').toBeNull();
  });

  it('a positive number is the rate; a malformed one REFUSES THE RUN rather than running unpaced', () => {
    const paced = readLiveConfig({ ...env, EVAL_LIVE_MAX_RPM: String(PACED_RPM) });
    expect(paced.enabled ? paced.maxRpm : 'disabled').toBe(PACED_RPM);
    // Not an integer, and it does not have to be: 60000/rpm is milliseconds.
    const fractional = readLiveConfig({ ...env, EVAL_LIVE_MAX_RPM: '0.5' });
    expect(fractional.enabled ? fractional.maxRpm : 'disabled').toBe(0.5);
    // ⛔ The same shape EVAL_LIVE_MAX_CALLS refuses ('1o'), and for a sharper
    // reason: a silent fall back here is not an expensive run, it is a run that
    // LOOKS healthy while measuring the account's rate limit.
    for (const bad of ['1o', '0', '-18', '18rpm', 'eighteen', 'NaN', '']) {
      if (bad === '') continue;
      expect(() => readLiveConfig({ ...env, EVAL_LIVE_MAX_RPM: bad }), bad).toThrow(
        LiveConfigError,
      );
    }
    expect(() => readLiveConfig({ ...env, EVAL_LIVE_MAX_RPM: '1o' })).toThrow(
      /EVAL_LIVE_MAX_RPM must be a positive number of provider calls a minute/,
    );
  });

  it('the usage sentence names the variable, the measured reason and the rate to use', () => {
    expect(LIVE_HOW_TO_RUN).toContain('EVAL_LIVE_MAX_RPM');
    expect(LIVE_HOW_TO_RUN).toContain(`${String(AGGREGATOR_NEW_ACCOUNT_RPM)} requests a minute`);
    expect(LIVE_HOW_TO_RUN).toContain(`use ${String(SUGGESTED_PACED_RPM)}`);
    // The suggested rate leaves headroom under the measured ceiling rather than
    // sitting on it — the one relationship between these two numbers that matters.
    expect(SUGGESTED_PACED_RPM).toBeLessThan(AGGREGATOR_NEW_ACCOUNT_RPM);
  });
});

// ── the spacing, and the latency it must not touch ────────────────────

describe('live pacing — calls are spaced, and nothing they measure moves', () => {
  it('UNSET: no call ever waits, the report carries no pacing, and the text has no pacing line', async () => {
    const clock = standInClock();
    const provider = timedProvider(referenceModel('L-READ'), clock);
    const { report } = await runLiveSuite(suiteArgs([READ()], provider.fetch, clock, { reps: 2 }));

    // The positive control on "no waits": this run really did make calls that a
    // paced run would have had to space.
    expect(provider.startedAt.length).toBeGreaterThan(1);
    expect(report.pacing).toBeNull();
    // Back to back: each call starts the moment the last one finished.
    expect(gapsBetweenStarts(provider.startedAt)).toEqual(
      provider.startedAt.slice(1).map(() => CALL_TAKES_MS),
    );
    const text = renderLiveReport(report);
    expect(text).not.toContain('pacing —');
    expect(text).not.toContain('EVAL_LIVE_MAX_RPM');
  });

  it(`${String(PACED_RPM)} rpm: the second call starts no sooner than ${GAP_MS.toFixed(0)}ms after the first, and every later one too`, async () => {
    const clock = standInClock();
    const provider = timedProvider(referenceModel('L-READ'), clock);
    const { report } = await runLiveSuite(
      suiteArgs([READ()], provider.fetch, clock, { reps: 2, maxRpm: PACED_RPM }),
    );

    expect(provider.startedAt.length).toBeGreaterThan(1);
    // The requirement, stated as the requirement: no sooner than 60000/rpm ms.
    for (const [i, gap] of gapsBetweenStarts(provider.startedAt).entries()) {
      expect(gap, `gap ${String(i)}`).toBeGreaterThanOrEqual(60_000 / PACED_RPM);
    }
    // Start to start, not end to start: a call that took 900ms is followed
    // GAP_MS after it STARTED, not GAP_MS after it ended.
    expect(gapsBetweenStarts(provider.startedAt)).toEqual(
      provider.startedAt.slice(1).map(() => GAP_MS),
    );
    expect(report.pacing?.maxRpm).toBe(PACED_RPM);
    expect(report.pacing?.waits).toBe(provider.startedAt.length - 1);
  });

  it('⛔ the measured latency of every call is UNCHANGED by the waiting — the same stand-in, paced and unpaced', async () => {
    const unpacedClock = standInClock();
    const unpacedProvider = timedProvider(referenceModel('L-READ'), unpacedClock);
    const unpaced = await runLiveSuite(
      suiteArgs([READ()], unpacedProvider.fetch, unpacedClock, { reps: 2 }),
    );

    const pacedClock = standInClock();
    const pacedProvider = timedProvider(referenceModel('L-READ'), pacedClock);
    const paced = await runLiveSuite(
      suiteArgs([READ()], pacedProvider.fetch, pacedClock, { reps: 2, maxRpm: PACED_RPM }),
    );

    // The runs are the same run except for the pacing: same tasks, same stand-in,
    // same number of calls. Without this the comparison below could be two
    // different runs agreeing by accident.
    expect(pacedProvider.startedAt.length).toBe(unpacedProvider.startedAt.length);
    expect(latenciesOf(paced.report)).toEqual(latenciesOf(unpaced.report));
    // And it is a real measurement on both sides, not a pair of nulls.
    expect(latenciesOf(unpaced.report).length).toBeGreaterThan(0);
    for (const [firstToken, total] of latenciesOf(paced.report)) {
      expect(total).toBe(CALL_TAKES_MS);
      expect(firstToken).toBe(CALL_TAKES_MS);
    }
    expect(paced.report.latency.plan?.totalMsMax).toBe(CALL_TAKES_MS);
    expect(unpaced.report.latency.plan?.totalMsMax).toBe(CALL_TAKES_MS);
  });

  it('⛔ NEGATIVE CONTROL — move the same wait INSIDE the call’s clock and the latency assertion above fails', async () => {
    const unpacedClock = standInClock();
    const unpacedProvider = timedProvider(referenceModel('L-READ'), unpacedClock);
    const unpaced = await runLiveSuite(
      suiteArgs([READ()], unpacedProvider.fetch, unpacedClock, { reps: 2 }),
    );

    // Not paced at all: the provider itself burns GAP_MS, AFTER the meter has
    // started the call's clock. That is the one-line mistake this design exists
    // to avoid — the spacing would be identical and every latency inflated.
    const insideClock = standInClock();
    const insideProvider = timedProvider(
      referenceModel('L-READ'),
      insideClock,
      CALL_TAKES_MS + GAP_MS,
    );
    const inside = await runLiveSuite(
      suiteArgs([READ()], insideProvider.fetch, insideClock, { reps: 2 }),
    );

    expect(insideProvider.startedAt.length).toBe(unpacedProvider.startedAt.length);
    expect(latenciesOf(inside.report)).not.toEqual(latenciesOf(unpaced.report));
    for (const [, total] of latenciesOf(inside.report)) {
      expect(total).toBe(Math.round(CALL_TAKES_MS + GAP_MS));
    }
  });

  it('⛔ NEGATIVE CONTROL — drop the wait and the spacing assertion fails: the calls come back to back', async () => {
    const clock = standInClock();
    const provider = timedProvider(referenceModel('L-READ'), clock);
    await runLiveSuite(suiteArgs([READ()], provider.fetch, clock, { reps: 2 }));

    expect(provider.startedAt.length).toBeGreaterThan(1);
    for (const gap of gapsBetweenStarts(provider.startedAt)) {
      expect(gap).toBeLessThan(GAP_MS);
    }
  });
});

// ── the OTHER clock that times a call, and the page it ages ───────────

describe('live pacing — the page the model is shown ages by what the MODEL took', () => {
  /**
   * ⛔ THE SECOND TIMER ON EVERY PLANNING CALL, AND THE ONE THAT DECIDES
   * PASS/FAIL. The call's own clock (`firstTokenMs`/`totalMs`) starts after the
   * wait, which the test above proves. But `LiveRecordingDecomposer` ALSO times
   * `decompose` from the outside, and the runner credits that duration to the
   * fixture's clock as time the customer's page went on living while the model
   * thought — see the shipped pair in agent-eval-live-plumbing: "a planning call
   * that took a minute finds the late button there" against "with no time
   * credited the same plans never see the button". A wait this harness took to
   * obey somebody's rate limit is not time the model spent.
   *
   * Every run here returns 0 from the credit function, so the fixture is not
   * actually aged: the measurement is what the runner was TOLD the model took.
   */
  function creditedPlanningMs(): {
    ms: number[];
    pageAgesWhileModelThinks: (measuredMs: number) => number;
  } {
    const ms: number[] = [];
    return {
      ms,
      pageAgesWhileModelThinks: (measuredMs: number) => {
        ms.push(Math.round(measuredMs));
        return 0;
      },
    };
  }

  it('⛔ a paced run credits the model with exactly what an unpaced one does — the wait is taken back out', async () => {
    const unpacedCredit = creditedPlanningMs();
    const unpacedClock = standInClock();
    const unpacedProvider = timedProvider(referenceModel('L-READ'), unpacedClock);
    await runLiveSuite(
      suiteArgs([READ()], unpacedProvider.fetch, unpacedClock, {
        reps: 2,
        pageAgesWhileModelThinks: unpacedCredit.pageAgesWhileModelThinks,
      }),
    );

    const pacedCredit = creditedPlanningMs();
    const pacedClock = standInClock();
    const pacedProvider = timedProvider(referenceModel('L-READ'), pacedClock);
    const paced = await runLiveSuite(
      suiteArgs([READ()], pacedProvider.fetch, pacedClock, {
        reps: 2,
        maxRpm: PACED_RPM,
        pageAgesWhileModelThinks: pacedCredit.pageAgesWhileModelThinks,
      }),
    );

    // The positive control on the comparison: this paced run really did wait,
    // and really did plan more than once, so there was something to get wrong.
    expect(paced.report.pacing?.waits ?? 0).toBeGreaterThan(0);
    expect(unpacedCredit.ms.length).toBeGreaterThan(1);
    expect(pacedCredit.ms.length).toBe(unpacedCredit.ms.length);
    // The claim: same model, same fixture, same credited time.
    expect(pacedCredit.ms).toEqual(unpacedCredit.ms);
    expect(pacedCredit.ms.every((ms) => ms === CALL_TAKES_MS)).toBe(true);
  });

  it('⛔ NEGATIVE CONTROL — the credit is not blind: time the PROVIDER itself takes does reach it', async () => {
    // Same instrument, same unpaced run, but the stand-in burns GAP_MS more
    // INSIDE the call. If the subtraction above had simply flattened this
    // measurement to a constant, this assertion would not hold.
    const baseline = creditedPlanningMs();
    const baselineClock = standInClock();
    await runLiveSuite(
      suiteArgs(
        [READ()],
        timedProvider(referenceModel('L-READ'), baselineClock).fetch,
        baselineClock,
        {
          reps: 2,
          pageAgesWhileModelThinks: baseline.pageAgesWhileModelThinks,
        },
      ),
    );

    const slower = creditedPlanningMs();
    const slowerClock = standInClock();
    await runLiveSuite(
      suiteArgs(
        [READ()],
        timedProvider(referenceModel('L-READ'), slowerClock, CALL_TAKES_MS + GAP_MS).fetch,
        slowerClock,
        { reps: 2, pageAgesWhileModelThinks: slower.pageAgesWhileModelThinks },
      ),
    );

    expect(slower.ms.length).toBe(baseline.ms.length);
    expect(slower.ms).not.toEqual(baseline.ms);
    expect(slower.ms.every((ms) => ms === CALL_TAKES_MS + GAP_MS)).toBe(true);
  });
});

// ── a wait that is holding a call nobody is waiting for any more ──────

describe('live pacing — an aborted call gives up its wait instead of sitting it out', () => {
  /** A sleep that never ends on its own, so what ends it is the only question. */
  function neverEndingSleep(): { sleep: (ms: number) => Promise<void>; asked: number[] } {
    const asked: number[] = [];
    return {
      asked,
      sleep: (ms: number) => {
        asked.push(ms);
        return new Promise<void>(() => undefined);
      },
    };
  }

  function pacedMeter(sleep: (ms: number) => Promise<void>): {
    meter: LiveMeter;
    log: ReturnType<typeof standInProvider>['log'];
    body: string;
  } {
    const provider = standInProvider({ model: () => planReply([]), expectedKey: SENTINEL_KEY });
    return {
      meter: new LiveMeter(
        provider.fetch,
        { maxCalls: 10, maxTotalTokens: 1_000_000, maxUsd: 1_000 },
        new Map(),
        standInClock().now,
        null,
        { maxRpm: PACED_RPM, sleep },
      ),
      log: provider.log,
      body: JSON.stringify({ model: 'm', system: 's', stream: false, messages: [] }),
    };
  }

  /** Enough microtask turns for a wait that was going to end to have ended. */
  const settleMicrotasks = async (): Promise<void> => {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  };

  it('⛔ the call’s own AbortSignal ends the wait at once — both adapters arm their abort timer BEFORE this fetch', async () => {
    const sleeping = neverEndingSleep();
    const { meter, log, body } = pacedMeter(sleeping.sleep);

    await meter.fetch('https://provider.invalid/', { method: 'POST', body });
    await meter.settle();
    const stop = new AbortController();
    const second = meter.fetch('https://provider.invalid/', {
      method: 'POST',
      body,
      signal: stop.signal,
    });

    // The positive control, in the same breath: right now it IS waiting, and
    // nothing has reached the provider.
    await settleMicrotasks();
    expect(sleeping.asked).toEqual([GAP_MS]);
    expect(log.requests.length).toBe(1);

    stop.abort();
    await second;
    // ⛔ AND THE CALL IS STILL THE CALL. An abort here changes WHEN the wait
    // ends and nothing else: the record is made and the request is forwarded
    // exactly as an unpaced run would, so a paced run never counts one call
    // fewer than the identical unpaced one. In production the transport was
    // handed the same signal and fails it there.
    expect(log.requests.length).toBe(2);
    expect(meter.records().length).toBe(2);
  });

  it('⛔ NEGATIVE CONTROL — with nothing aborting it, that same wait never ends', async () => {
    const sleeping = neverEndingSleep();
    const { meter, log, body } = pacedMeter(sleeping.sleep);

    await meter.fetch('https://provider.invalid/', { method: 'POST', body });
    await meter.settle();
    let settled = false;
    void meter
      .fetch('https://provider.invalid/', { method: 'POST', body })
      .then(() => (settled = true));

    await settleMicrotasks();
    expect(sleeping.asked).toEqual([GAP_MS]);
    expect(settled).toBe(false);
    expect(log.requests.length).toBe(1);
    expect(meter.records().length).toBe(1);
  });
});

// ── what the waiting cost, said out loud ──────────────────────────────

describe('live pacing — the waiting is reported, never absorbed', () => {
  it('the text header and the JSON both carry the waits, the seconds and the rate', async () => {
    const clock = standInClock();
    const provider = timedProvider(referenceModel('L-READ'), clock);
    const { report, secrets } = await runLiveSuite(
      suiteArgs([READ()], provider.fetch, clock, { reps: 2, maxRpm: PACED_RPM }),
    );

    // What a wait COSTS is the gap minus what the call itself took: the meter
    // spaces call STARTS, so a call that ran for 900ms has already spent 900ms
    // of the 3334ms gap by the time the next one asks to begin.
    const waits = provider.startedAt.length - 1;
    const seconds = Math.round((waits * (GAP_MS - CALL_TAKES_MS)) / 100) / 10;
    expect(report.pacing).toMatchObject({
      maxRpm: PACED_RPM,
      waits,
      secondsWaited: seconds,
      turnsEndedOnTheWallClock: [],
    });

    const text = renderLiveReport(report);
    expect(text).toContain(
      `pacing — ${String(waits)} waits, ${seconds.toFixed(1)} seconds waited, to stay under ${String(PACED_RPM)} requests a minute (EVAL_LIVE_MAX_RPM)`,
    );
    // The arithmetic, stated rather than reassured about: a turn's worst case
    // against the runtime's own ceiling, both read from the runtime's constants.
    expect(text).toContain(
      `a turn of ${String(MAX_MODEL_CALLS_PER_TURN)} calls spends up to ${(((MAX_MODEL_CALLS_PER_TURN - 1) * GAP_MS) / 1000).toFixed(1)}s of its ${(MAX_TURN_WALL_CLOCK_MS / 1000).toFixed(0)}s wall clock waiting`,
    );

    const dir = resolve(tmpdir(), `driftstack-agent-eval-live-pacing-${String(process.pid)}`);
    try {
      const written = writeLiveReport(report, secrets, dir);
      const onDisk = JSON.parse(readFileSync(written.jsonPath, 'utf8')) as LiveReport;
      expect(onDisk.pacing).toEqual(report.pacing);
      expect(readFileSync(written.textPath, 'utf8')).toContain('pacing — ');
      for (const output of [written.json, written.text]) {
        expect(output).not.toContain(SENTINEL_KEY);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── the caps still win ────────────────────────────────────────────────

describe('live pacing — a spend cap beats the pacing, every time', () => {
  it('a run at its call cap refuses instantly: no wait, no call, and the clock never moves', async () => {
    const clock = standInClock();
    const provider = standInProvider({ model: () => planReply([]), expectedKey: SENTINEL_KEY });
    const meter = new LiveMeter(
      provider.fetch,
      { maxCalls: 1, maxTotalTokens: 1_000_000, maxUsd: 1_000 },
      new Map(),
      clock.now,
      null,
      { maxRpm: PACED_RPM, sleep: clock.sleep },
    );
    const body = JSON.stringify({ model: 'm', system: 's', stream: false, messages: [] });

    await meter.fetch('https://provider.invalid/', { method: 'POST', body });
    await meter.settle();
    // The first call reserves the next slot, so a SECOND call under the cap
    // would have had to wait GAP_MS — which is what makes the refusal below a
    // statement about the cap winning rather than about there being no wait due.
    expect(meter.pacingTotals()).toEqual({ maxRpm: PACED_RPM, waits: 0, waitedMs: 0 });

    await expect(
      meter.fetch('https://provider.invalid/', { method: 'POST', body }),
    ).rejects.toBeInstanceOf(LiveSpendCapReachedError);
    expect(provider.log.requests.length).toBe(1);
    expect(meter.capReached()).toBe('calls');
    expect(meter.pacingTotals()).toEqual({ maxRpm: PACED_RPM, waits: 0, waitedMs: 0 });
    expect(clock.now()).toBe(0);
  });

  it('the positive control: without the cap in the way, that same second call DOES wait', async () => {
    const clock = standInClock();
    const provider = standInProvider({ model: () => planReply([]), expectedKey: SENTINEL_KEY });
    const meter = new LiveMeter(
      provider.fetch,
      { maxCalls: 10, maxTotalTokens: 1_000_000, maxUsd: 1_000 },
      new Map(),
      clock.now,
      null,
      { maxRpm: PACED_RPM, sleep: clock.sleep },
    );
    const body = JSON.stringify({ model: 'm', system: 's', stream: false, messages: [] });

    await meter.fetch('https://provider.invalid/', { method: 'POST', body });
    await meter.settle();
    await meter.fetch('https://provider.invalid/', { method: 'POST', body });
    await meter.settle();

    expect(provider.log.requests.length).toBe(2);
    expect(meter.pacingTotals()).toEqual({
      maxRpm: PACED_RPM,
      waits: 1,
      waitedMs: Math.round(GAP_MS),
    });
    expect(clock.now()).toBe(GAP_MS);
  });
});

// ── the provider's own refusal stays what it is, and says what prevents it ──

describe('live pacing — a rate-limit refusal is still a failed provider call, with a hint', () => {
  /** The aggregator's own words, at its own status. Not retried here, not
   *  re-classed: the report already calls this a failed provider call. */
  const RATE_LIMITED: typeof globalThis.fetch = () =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          error: {
            type: 'rate_limit_error',
            message:
              'Rate limit exceeded: new-account-rpm/claude-opus-5. Please wait. New accounts are limited to 20 requests per minute for this model.',
          },
        }),
        { status: 429, headers: { 'content-type': 'application/json' } },
      ),
    );

  it('names it a refusal, keeps the provider’s message, and prints ONE line at the top of the failures section', async () => {
    const clock = standInClock();
    const { report } = await runLiveSuite(suiteArgs([READ()], RATE_LIMITED, clock));

    expect(report.provider.throttledCalls).toBeGreaterThan(0);
    // Every call this run made was that refusal — so the hint is about the run,
    // not about one unlucky call among successes.
    expect(report.provider.throttledCalls).toBe(report.spend.callsStarted);
    // ⛔ IT IS STILL A FAILED PROVIDER CALL, scored as one. Pacing changes what
    // a future run asks for; it never re-labels what this one got.
    expect(report.tasks[0]?.reps[0]?.reasonClass).toBe('provider_call_failed');
    expect(report.provider.errors.join('\n')).toContain('new-account-rpm');

    const lines = renderLiveReport(report).split('\n');
    const header = lines.indexOf('every repetition that did not pass:');
    expect(header).toBeGreaterThan(-1);
    const hint = lines[header + 1] ?? '';
    expect(hint).toContain('refused for RATE LIMITING');
    expect(hint).toContain('EVAL_LIVE_MAX_RPM');
    expect(hint).toContain(String(SUGGESTED_PACED_RPM));
    expect(hint).toContain(`${String(AGGREGATOR_NEW_ACCOUNT_RPM)} requests a minute`);
    // One line, not a paragraph: the next line is the first failing repetition.
    expect(lines[header + 2] ?? '').toMatch(/^ {2}L-READ rep 1 —/);
  });

  it('a healthy run prints no such line, and the detector does not fire on an ordinary 4xx', async () => {
    const clock = standInClock();
    const provider = timedProvider(referenceModel('L-READ'), clock);
    const { report } = await runLiveSuite(suiteArgs([READ()], provider.fetch, clock));
    expect(report.provider.throttledCalls).toBe(0);
    expect(renderLiveReport(report)).not.toContain('refused for RATE LIMITING');

    // The detector reads the CALL, so it must say no to the refusals that are
    // not about a rate at all.
    expect(isRateLimitRefusal({ status: 429, providerError: null })).toBe(true);
    expect(
      isRateLimitRefusal({ status: 400, providerError: 'error: Rate limit exceeded: rpm/x' }),
    ).toBe(true);
    expect(isRateLimitRefusal({ status: 200, providerError: null })).toBe(false);
    expect(isRateLimitRefusal({ status: 402, providerError: 'error: Insufficient credits' })).toBe(
      false,
    );
    expect(
      isRateLimitRefusal({ status: 401, providerError: 'authentication_error: bad key' }),
    ).toBe(false);
  });
});

// ── the one thing pacing really does change ───────────────────────────

describe('live pacing — a turn that ends on the wall clock while paced is FLAGGED, never read as a slow model', () => {
  /**
   * A planner that always says `continue`, with a DIFFERENT page each segment so
   * the loop ends on one of its bounds rather than on "the page did not change".
   */
  const KEEPS_GOING: StandInModel = (request, index) => {
    if (request.purpose === 'answer') {
      return answerReply('The last ferry from Harbour to Skerry leaves at 21:40.');
    }
    const url = index % 2 === 0 ? 'https://ferries.test/timetable' : 'https://ferries.test/';
    return planReply(
      [
        { kind: 'navigate', url },
        { kind: 'wait', condition: 'idle' },
        { kind: 'capture', capture: 'screenshot' },
      ],
      'continue',
    );
  };

  /** One wait alone is longer than the whole turn is allowed to take. Absurd as
   *  a setting, and the point: it makes the interaction observable in a keyless
   *  test instead of leaving it as a claim about arithmetic. */
  const CRAWLING_RPM = 60_000 / (MAX_TURN_WALL_CLOCK_MS + 60_000);

  it('the runtime’s three-minute ceiling counts the pacing wait, and the report says so in its header', async () => {
    const clock = standInClock();
    const provider = timedProvider(KEEPS_GOING, clock, 0);
    const { report } = await runLiveSuite(
      suiteArgs([READ()], provider.fetch, clock, { maxTurns: 1, maxRpm: CRAWLING_RPM }),
    );

    const rep = report.tasks[0]?.reps[0];
    // The runtime itself named the ending. Nothing here infers it from a duration.
    expect(rep?.turns[0]?.loop?.stopped).toBe('wall_clock');
    expect(report.pacing?.turnsEndedOnTheWallClock).toEqual([
      "L-READ rep 1 message 1 ended on the turn's three-minute wall clock",
    ]);
    const text = renderLiveReport(report);
    expect(text).toContain('ended on the runtime’s'.replace('’', "'"));
    expect(text).toContain('WHILE PACING WAS ON');
    expect(text).toContain('NOT as "the model ran out of time"');
  });

  it('⛔ NEGATIVE CONTROL — drop the pacing and the SAME planner on the SAME fixture never ends on the wall clock', async () => {
    // The A/B in one test, because the claim is comparative: the only thing
    // that differs between these two runs is `maxRpm`.
    const pacedClock = standInClock();
    const pacedProvider = timedProvider(KEEPS_GOING, pacedClock, 0);
    const paced = await runLiveSuite(
      suiteArgs([READ()], pacedProvider.fetch, pacedClock, {
        maxTurns: 1,
        maxRpm: CRAWLING_RPM,
      }),
    );

    const clock = standInClock();
    const provider = timedProvider(KEEPS_GOING, clock, 0);
    const { report } = await runLiveSuite(
      suiteArgs([READ()], provider.fetch, clock, { maxTurns: 1 }),
    );

    const unpacedTurn = report.tasks[0]?.reps[0]?.turns[0];
    const pacedTurn = paced.report.tasks[0]?.reps[0]?.turns[0];
    expect(pacedTurn?.loop?.stopped).toBe('wall_clock');
    // Unpaced, the SAME planner runs into a bound that is a fact about IT —
    // never the clock. Which bound is the runtime's business, not this test's.
    expect(unpacedTurn?.loop?.stopped).not.toBe('wall_clock');
    expect(unpacedTurn?.loop?.stopped).not.toBeUndefined();
    // And it got FURTHER: the paced run was stopped early, it did not simply
    // do less work for some other reason.
    expect(unpacedTurn?.loop?.segments ?? 0).toBeGreaterThan(pacedTurn?.loop?.segments ?? 0);
    expect(report.pacing).toBeNull();
    expect(renderLiveReport(report)).not.toContain('WHILE PACING WAS ON');
  });

  it('the collector names every wall-clock turn, and cannot see a re-plan that met the same ceiling', () => {
    // ⛔ The blind spot, pinned rather than left to a comment: AgentRuntime
    // records `stopped: 'wall_clock'` only for a loop that was going round on a
    // planner's `continue`. A loop going round to RE-PLAN a failed step breaks
    // at the same ceiling without naming it, because there the ✗ row is already
    // the message — so an empty list means "none ended there mid-progress".
    expect(
      turnsEndedOnTheWallClock([
        {
          taskId: 'T-A',
          reps: [
            {
              rep: 2,
              turns: [
                { turn: 1, loop: { stopped: 'no_progress' } },
                { turn: 2, loop: { stopped: 'wall_clock' } },
              ],
            },
            { rep: 3, turns: [{ turn: 1, loop: null }] },
          ],
        },
        {
          taskId: 'T-B',
          reps: [{ rep: 1, turns: [{ turn: 1, loop: { stopped: 'planner_call_limit' } }] }],
        },
      ]),
    ).toEqual(["T-A rep 2 message 2 ended on the turn's three-minute wall clock"]);
  });
});
