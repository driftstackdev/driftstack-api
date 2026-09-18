// The AI turn health watchdog: the runbook's alert conditions evaluated from
// the diagnostics table and reported through Sentry, because production has no
// scraper to run the PromQL.
//
// Condition cases go through the REAL aggregation (in-memory repo → summary
// service → watchdog), so a floor or window that disagreed with the admin page
// would show here. Transition cases drive the pure state machine directly; the
// job cases run the registered handler the way the scheduler does, feeding each
// tick the payload the previous one enqueued.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

import { InMemoryAgentTurnTelemetryRepo } from '../../src/db/agent-turn-telemetry-repo.js';
import {
  AgentTurnSummaryService,
  buildAgentTurnSummary,
  type AgentTurnSummary,
} from '../../src/services/agent-turn-summary.js';
import {
  AGENT_TURN_ALERT_RULES,
  AGENT_TURN_HEALTH_BLIND_AFTER_TICKS,
  AGENT_TURN_HEALTH_RENOTIFY_MS,
  AGENT_TURN_HEALTH_WATCHDOG_INTERVAL_MS,
  AGENT_TURN_HEALTH_WATCHDOG_JOB_TYPE,
  INITIAL_AGENT_TURN_HEALTH_STATE,
  advanceAgentTurnHealth,
  agentTurnHealthFingerprint,
  agentTurnHealthPayload,
  evaluateAgentTurnHealth,
  parseAgentTurnHealthState,
  endAgentTurnHealthWatchdogChain,
  enqueueNextAgentTurnHealthWatchdog,
  registerAgentTurnHealthWatchdogJob,
  type RegisterAgentTurnHealthWatchdogOpts,
  type AgentTurnHealthWatchdogHandle,
  type AgentTurnHealthCondition,
  type AgentTurnHealthReading,
  type AgentTurnHealthState,
  type AgentTurnHealthStatus,
} from '../../src/services/agent-turn-health-watchdog.js';
import type { AgentTurnTelemetryRow } from '../../src/services/agent-turn-telemetry.js';
import type { ScheduledJobRow, ScheduledJobsService } from '../../src/services/scheduled-jobs.js';
import type { SentryMessage } from '../../src/lib/sentry.js';
import { AGENT_TURN_ROW_NOW, row } from './_helpers/agent-turn-telemetry-row.js';

const NOW = AGENT_TURN_ROW_NOW;
const MIN = 60_000;

const at = (minutesAgo: number): Date => new Date(NOW - minutesAgo * MIN);
const failed = (over: Partial<AgentTurnTelemetryRow> = {}): AgentTurnTelemetryRow =>
  row({ outcome: 'failed', deathReason: 'element_never_appeared_in_retry_budget', ...over });
const busy = (over: Partial<AgentTurnTelemetryRow> = {}): AgentTurnTelemetryRow =>
  row({
    outcome: 'busy_409',
    deathReason: 'turn_in_progress',
    httpStatus: 409,
    model: 'none',
    modelCalls: 0,
    timeToFirstProgressMs: null,
    ...over,
  });
const times = (n: number, make: () => AgentTurnTelemetryRow): AgentTurnTelemetryRow[] =>
  Array.from({ length: n }, make);

function summaryServiceOver(rows: AgentTurnTelemetryRow[], now = NOW): AgentTurnSummaryService {
  const repo = new InMemoryAgentTurnTelemetryRepo();
  for (const r of rows) void repo.insert(r);
  return new AgentTurnSummaryService({ repo, nowFn: () => now });
}

async function reading(
  condition: AgentTurnHealthCondition,
  rows: AgentTurnTelemetryRow[],
): Promise<AgentTurnHealthReading> {
  const readings = await evaluateAgentTurnHealth({ summary: summaryServiceOver(rows) });
  const found = readings.find((r) => r.condition === condition);
  if (found === undefined) throw new Error(`no reading for ${condition}`);
  return found;
}

// ── the conditions, through the real aggregation ───────────────────────────

describe('completion rate low (6 h, < 0.5, floor 10 decided turns)', () => {
  it('CRITICAL breaches when fewer than half of at least ten decided turns completed', async () => {
    const r = await reading('completion_rate_low', [
      ...times(4, () => row()),
      ...times(6, () => failed()),
    ]);
    expect(r.status).toBe('breach');
    expect(r.figures).toMatchObject({ samples: 10, value: 0.4, completed: 4 });
  });

  it('clears when at least half completed — and exactly half is NOT a breach, as the PromQL `<` is strict', async () => {
    expect(
      (
        await reading('completion_rate_low', [
          ...times(6, () => row()),
          ...times(4, () => failed()),
        ])
      ).status,
    ).toBe('ok');
    expect(
      (
        await reading('completion_rate_low', [
          ...times(5, () => row()),
          ...times(5, () => failed()),
        ])
      ).status,
    ).toBe('ok');
  });

  it('CRITICAL nine failed turns out of nine is NOT a breach: below the floor the answer is "not enough data"', async () => {
    const r = await reading(
      'completion_rate_low',
      times(9, () => failed()),
    );
    expect(r.status).toBe('insufficient_data');
    expect(r.figures.samples).toBe(9);
  });

  it('pauses for confirmation and clarifying questions are in neither side, so they do not lift the count over the floor', async () => {
    const r = await reading('completion_rate_low', [
      ...times(20, () => row({ outcome: 'halted_for_confirmation' })),
      ...times(20, () => row({ outcome: 'clarified' })),
      ...times(9, () => failed()),
    ]);
    expect(r.status).toBe('insufficient_data');
  });

  it('only the last six hours count', async () => {
    const r = await reading('completion_rate_low', [
      ...times(10, () => failed({ occurredAt: at(6 * 60 + 5) })),
      ...times(3, () => failed({ occurredAt: at(10) })),
    ]);
    expect(r.status).toBe('insufficient_data');
    expect(r.figures.samples).toBe(3);
  });
});

describe('409 rate high (1 h, > 0.10, floor 10 requests)', () => {
  it('CRITICAL breaches when more than a tenth of at least ten requests were answered 409', async () => {
    const r = await reading('conflict_rate_high', [
      ...times(2, () => busy()),
      ...times(8, () => row()),
    ]);
    expect(r.status).toBe('breach');
    expect(r.figures).toMatchObject({ samples: 10, value: 0.2, busy_409: 2, conflict_409: 0 });
  });

  it('exactly a tenth clears (strict `>`), and so does none', async () => {
    expect((await reading('conflict_rate_high', [busy(), ...times(9, () => row())])).status).toBe(
      'ok',
    );
    expect(
      (
        await reading(
          'conflict_rate_high',
          times(12, () => row()),
        )
      ).status,
    ).toBe('ok');
  });

  it('CRITICAL nine 409s out of nine requests is "not enough data", not a 100% conflict rate', async () => {
    const r = await reading(
      'conflict_rate_high',
      times(9, () => busy()),
    );
    expect(r.status).toBe('insufficient_data');
  });

  it('only the last hour counts', async () => {
    const r = await reading('conflict_rate_high', [
      ...times(10, () => busy({ occurredAt: at(90) })),
      ...times(10, () => row({ occurredAt: at(10) })),
    ]);
    expect(r.status).toBe('ok');
    expect(r.figures.samples).toBe(10);
  });
});

describe('time to first progress slow (30 min, streaming p95 > 5 s, floor 10 streaming samples)', () => {
  it('CRITICAL breaches when the streaming p95 is over five seconds', async () => {
    const r = await reading(
      'first_progress_slow',
      times(10, () => row({ timeToFirstProgressMs: 6000 })),
    );
    expect(r.status).toBe('breach');
    expect(r.figures).toMatchObject({ samples: 10, p95_ms: 6000 });
  });

  it('clears when streaming turns show progress quickly — a slow json transport does not count', async () => {
    const r = await reading('first_progress_slow', [
      ...times(10, () => row({ timeToFirstProgressMs: 400 })),
      ...times(30, () => row({ transport: 'json', timeToFirstProgressMs: 60_000 })),
    ]);
    expect(r.status).toBe('ok');
    expect(r.figures.samples).toBe(10);
  });

  it('CRITICAL nine slow streaming turns are "not enough data" — json turns and requests that never showed progress do not lift the floor', async () => {
    const r = await reading('first_progress_slow', [
      ...times(9, () => row({ timeToFirstProgressMs: 60_000 })),
      ...times(30, () => row({ transport: 'json', timeToFirstProgressMs: 60_000 })),
      ...times(30, () => busy()),
    ]);
    expect(r.status).toBe('insufficient_data');
    expect(r.figures.samples).toBe(9);
  });

  it('only the last thirty minutes count', async () => {
    const r = await reading('first_progress_slow', [
      ...times(10, () => row({ occurredAt: at(45), timeToFirstProgressMs: 60_000 })),
    ]);
    expect(r.status).toBe('insufficient_data');
  });

  it('with no traffic at all, every condition is "not enough data" — the state production is usually in', async () => {
    const readings = await evaluateAgentTurnHealth({ summary: summaryServiceOver([]) });
    expect(readings.map((r) => r.status)).toEqual([
      'insufficient_data',
      'insufficient_data',
      'insufficient_data',
    ]);
  });
});

// ── transitions ────────────────────────────────────────────────────────────

const ALL: readonly AgentTurnHealthCondition[] = [
  'completion_rate_low',
  'conflict_rate_high',
  'first_progress_slow',
];

function readingsWith(
  statuses: Partial<Record<AgentTurnHealthCondition, AgentTurnHealthStatus>>,
): AgentTurnHealthReading[] {
  return ALL.map((condition) => ({
    condition,
    status: statuses[condition] ?? 'ok',
    figures: { samples: 12, value: 0.3 },
  }));
}

/** Tick a sequence of statuses for one condition, `stepMin` apart. */
function run(
  condition: AgentTurnHealthCondition,
  statuses: AgentTurnHealthStatus[],
  stepMin = 5,
): Array<{ minute: number; transitions: string[] }> {
  let state: AgentTurnHealthState = INITIAL_AGENT_TURN_HEALTH_STATE;
  return statuses.map((status, i) => {
    const out = advanceAgentTurnHealth(
      state,
      readingsWith({ [condition]: status }),
      new Date(NOW + i * stepMin * MIN),
    );
    state = out.next;
    return {
      minute: i * stepMin,
      transitions: out.notices.filter((n) => n.signal === condition).map((n) => n.transition),
    };
  });
}
const fired = (ticks: Array<{ minute: number; transitions: string[] }>) =>
  ticks.filter((t) => t.transitions.length > 0);

describe('alerting on transitions', () => {
  it('CRITICAL a breach is reported ONCE, on the transition — not on every tick it persists', () => {
    // conflict_rate_high has `for: 15m`: breach from minute 0, reported at 15.
    const ticks = run('conflict_rate_high', Array<AgentTurnHealthStatus>(30).fill('breach'));
    expect(fired(ticks)).toEqual([{ minute: 15, transitions: ['breach'] }]);
  });

  it('CRITICAL the rule `for:` is honoured: a crossing shorter than it never fires', () => {
    expect(
      fired(run('conflict_rate_high', ['breach', 'breach', 'breach', 'ok', 'breach', 'ok'])),
    ).toEqual([]);
    // completion_rate_low holds for 30 minutes.
    const ticks = run('completion_rate_low', Array<AgentTurnHealthStatus>(8).fill('breach'));
    expect(fired(ticks)).toEqual([{ minute: 30, transitions: ['breach'] }]);
  });

  it('CRITICAL re-notifies while it persists, but no more often than every six hours', () => {
    const perDay = (24 * 60) / 5;
    const ticks = run('conflict_rate_high', Array<AgentTurnHealthStatus>(perDay).fill('breach'));
    expect(fired(ticks)).toEqual([
      { minute: 15, transitions: ['breach'] },
      { minute: 15 + 360, transitions: ['still_breaching'] },
      { minute: 15 + 720, transitions: ['still_breaching'] },
      { minute: 15 + 1080, transitions: ['still_breaching'] },
    ]);
    expect(AGENT_TURN_HEALTH_RENOTIFY_MS).toBe(6 * 60 * MIN);
  });

  it('CRITICAL sends a recovered event on the way out, once — after the value has stayed under the threshold for the rule `for:` — and nothing while it stays healthy', () => {
    const ticks = run('conflict_rate_high', [
      ...Array<AgentTurnHealthStatus>(4).fill('breach'),
      ...Array<AgentTurnHealthStatus>(8).fill('ok'),
    ]);
    // Breach reported at 15; ok from 20; 15 minutes of ok is minute 35.
    expect(fired(ticks)).toEqual([
      { minute: 15, transitions: ['breach'] },
      { minute: 35, transitions: ['recovered'] },
    ]);
  });

  it('CRITICAL the recovery clock must run unbroken: one crossing tick while clearing restarts it', () => {
    const ticks = run('conflict_rate_high', [
      ...Array<AgentTurnHealthStatus>(4).fill('breach'), // reported at 15
      'ok', // 20: clearing starts
      'ok', // 25
      'breach', // 30: clock stopped, no reminder (inside six hours)
      'ok', // 35: clearing restarts
      'ok',
      'ok',
      'ok', // 50: 15 minutes unbroken
      'ok',
    ]);
    expect(fired(ticks)).toEqual([
      { minute: 15, transitions: ['breach'] },
      { minute: 50, transitions: ['recovered'] },
    ]);
  });

  it('CRITICAL traffic falling below the floor CLEARS a breach after the rule `for:` — as Prometheus resolves when the floor empties the vector — and says why', () => {
    let state: AgentTurnHealthState = INITIAL_AGENT_TURN_HEALTH_STATE;
    const seen: string[] = [];
    const statuses: AgentTurnHealthStatus[] = [
      ...Array<AgentTurnHealthStatus>(4).fill('breach'),
      ...Array<AgentTurnHealthStatus>(100).fill('insufficient_data'),
    ];
    statuses.forEach((status, i) => {
      const out = advanceAgentTurnHealth(
        state,
        readingsWith({ conflict_rate_high: status }),
        new Date(NOW + i * 5 * MIN),
      );
      state = out.next;
      for (const n of out.notices.filter((x) => x.signal === 'conflict_rate_high')) {
        seen.push(`${String(i * 5)}:${n.transition}:${String(n.cleared_by)}`);
      }
    });
    // Below the floor from 20; cleared at 35; nothing after, and no reminders.
    expect(seen).toEqual(['15:breach:undefined', '35:recovered:insufficient_data']);
    expect(state.signals.conflict_rate_high?.breaching).toBe(false);
  });

  it('CRITICAL after a breach went quiet for longer than the reminder interval, ONE crossing tick is not an event: a new breach goes through the `for:` hold again, with a fresh `since`', () => {
    const quiet = Array<AgentTurnHealthStatus>((7 * 60) / 5).fill('insufficient_data');
    // breach → below the floor for seven hours → one crossing tick → ok.
    expect(
      fired(
        run('conflict_rate_high', [
          ...Array<AgentTurnHealthStatus>(4).fill('breach'),
          ...quiet,
          'breach',
          'ok',
        ]),
      ).map((t) => t.transitions),
    ).toEqual([['breach'], ['recovered']]);

    // …and a sustained crossing afterwards is a NEW breach, not a reminder.
    let state: AgentTurnHealthState = INITIAL_AGENT_TURN_HEALTH_STATE;
    const statuses: AgentTurnHealthStatus[] = [
      ...Array<AgentTurnHealthStatus>(4).fill('breach'),
      ...quiet,
      ...Array<AgentTurnHealthStatus>(4).fill('breach'),
    ];
    const notices: Array<{ minute: number; transition: string; since: string | null }> = [];
    statuses.forEach((status, i) => {
      const out = advanceAgentTurnHealth(
        state,
        readingsWith({ conflict_rate_high: status }),
        new Date(NOW + i * 5 * MIN),
      );
      state = out.next;
      for (const n of out.notices.filter((x) => x.signal === 'conflict_rate_high')) {
        notices.push({ minute: i * 5, transition: n.transition, since: n.breaching_since });
      }
    });
    const secondStart = (4 + quiet.length) * 5;
    expect(notices.map((n) => `${String(n.minute)}:${n.transition}`)).toEqual([
      '15:breach',
      '35:recovered',
      `${String(secondStart + 15)}:breach`,
    ]);
    expect(notices[2]?.since).toBe(new Date(NOW + (secondStart + 15) * MIN).toISOString());
  });

  it('CRITICAL a rate flapping across the threshold every tick produces a bounded number of events, not a pair every twenty minutes', () => {
    const alternating = (n: number): AgentTurnHealthStatus[] =>
      Array.from({ length: n }, (_, i) => (i % 2 === 0 ? 'breach' : 'ok'));
    // Never held for `for:`: nothing at all.
    expect(fired(run('conflict_rate_high', alternating(24)))).toEqual([]);
    // Already breaching, then two hours of flapping: the breach stays open
    // and quiet (reminders are six hours apart); nothing recovers.
    const ticks = run('conflict_rate_high', [
      ...Array<AgentTurnHealthStatus>(4).fill('breach'),
      ...alternating(24),
    ]);
    expect(fired(ticks)).toEqual([{ minute: 15, transitions: ['breach'] }]);
  });

  it('"not enough data" restarts the `for:` clock (as the floor emptying the PromQL vector does); an unreadable tick holds it', () => {
    expect(
      fired(
        run('conflict_rate_high', [
          'breach',
          'breach',
          'insufficient_data',
          'breach',
          'breach',
          'breach',
        ]),
      ),
    ).toEqual([]);
    expect(fired(run('conflict_rate_high', ['breach', 'breach', 'unavailable', 'breach']))).toEqual(
      [{ minute: 15, transitions: ['breach'] }],
    );
  });

  it('CRITICAL the watchdog reports its own blindness after three unreadable ticks, and its recovery', () => {
    let state = INITIAL_AGENT_TURN_HEALTH_STATE;
    const seen: string[] = [];
    const statuses: AgentTurnHealthStatus[] = [
      'unavailable',
      'unavailable',
      'unavailable',
      'unavailable',
      'ok',
    ];
    statuses.forEach((status, i) => {
      const out = advanceAgentTurnHealth(
        state,
        readingsWith({ completion_rate_low: status }),
        new Date(NOW + i * 5 * MIN),
      );
      state = out.next;
      for (const n of out.notices) seen.push(`${String(i)}:${n.signal}:${n.transition}`);
    });
    expect(AGENT_TURN_HEALTH_BLIND_AFTER_TICKS).toBe(3);
    expect(seen).toEqual(['2:evaluation_failing:breach', '4:evaluation_failing:recovered']);
  });
});

// ── fingerprints and payloads ──────────────────────────────────────────────

describe('what reaches Sentry', () => {
  it('CRITICAL one stable fingerprint per condition: every breach and reminder of a condition groups into ONE issue, whatever its numbers', () => {
    const a = agentTurnHealthPayload({
      signal: 'completion_rate_low',
      transition: 'breach',
      breaching_since: new Date(NOW).toISOString(),
      figures: { samples: 10, value: 0.1 },
    });
    const b = agentTurnHealthPayload({
      signal: 'completion_rate_low',
      transition: 'still_breaching',
      breaching_since: new Date(NOW - 99 * MIN).toISOString(),
      figures: { samples: 400, value: 0.33 },
    });
    expect(a.fingerprint).toEqual(['agent-turn-health', 'completion_rate_low']);
    expect(b.fingerprint).toEqual(a.fingerprint);
    // A literal pin: changing it splits history into a new issue.
    expect(agentTurnHealthFingerprint('first_progress_slow', 'breach')).toEqual([
      'agent-turn-health',
      'first_progress_slow',
    ]);
  });

  it('conditions do not share an issue, and recoveries go to their own so they cannot reopen a resolved breach', () => {
    const prints = new Set(
      (
        [
          'completion_rate_low',
          'conflict_rate_high',
          'first_progress_slow',
          'evaluation_failing',
        ] as const
      ).flatMap((s) => [
        agentTurnHealthFingerprint(s, 'breach').join('/'),
        agentTurnHealthFingerprint(s, 'recovered').join('/'),
      ]),
    );
    expect(prints.size).toBe(8);
    expect(agentTurnHealthFingerprint('conflict_rate_high', 'recovered')).toEqual([
      'agent-turn-health',
      'conflict_rate_high',
      'recovered',
    ]);
  });

  it('the payload carries the exact span the figures were computed over, so the numbers that fired can be reproduced', () => {
    const p = agentTurnHealthPayload({
      signal: 'first_progress_slow',
      transition: 'breach',
      breaching_since: new Date(NOW).toISOString(),
      figures: { samples: 11, value: 6200, p50_ms: 900, p95_ms: 6200 },
      window: {
        since: new Date(NOW - 30 * MIN).toISOString(),
        until: new Date(NOW).toISOString(),
      },
    });
    expect(p.extra).toMatchObject({
      window_since: new Date(NOW - 30 * MIN).toISOString(),
      window_until: new Date(NOW).toISOString(),
      window_minutes: 30,
    });
    const r = agentTurnHealthPayload({
      signal: 'first_progress_slow',
      transition: 'recovered',
      breaching_since: null,
      figures: { samples: 3, value: 100 },
      cleared_by: 'insufficient_data',
    });
    expect(r.extra['cleared_by']).toBe('insufficient_data');
    expect(r.extra).not.toHaveProperty('window_since');
  });

  it('the payload names the rule it evaluated: window, floor, threshold, direction and `for:`', () => {
    const p = agentTurnHealthPayload({
      signal: 'conflict_rate_high',
      transition: 'breach',
      breaching_since: null,
      figures: { samples: 20, value: 0.25, busy_409: 5, conflict_409: 0 },
    });
    expect(p.message).toBe('AI turns: AgentTurnConflictRateHigh breach');
    expect(p.level).toBe('warning');
    expect(p.extra).toMatchObject({
      condition: 'conflict_rate_high',
      window_minutes: 60,
      min_samples: 10,
      threshold: 0.1,
      breach_when: 'above',
      for_minutes: 15,
      samples: 20,
      value: 0.25,
    });
  });
});

// ── the job ────────────────────────────────────────────────────────────────

/** What bootstrap does, in the same order: register, then arm (or, switched
 *  off, register the chain-ending handler and arm nothing). */
async function wire(
  opts: RegisterAgentTurnHealthWatchdogOpts & { disabled?: boolean },
): Promise<AgentTurnHealthWatchdogHandle> {
  if (opts.disabled === true) {
    endAgentTurnHealthWatchdogChain(opts);
    return { stats: () => ({ ticks: 0, failedTicks: 0, deliveryFailures: 0, noticesSent: 0 }) };
  }
  const handle = registerAgentTurnHealthWatchdogJob(opts);
  await enqueueNextAgentTurnHealthWatchdog({
    scheduledJobs: opts.scheduledJobs,
    ...(opts.nowFn !== undefined ? { nowFn: opts.nowFn } : {}),
  });
  return handle;
}

interface Enqueued {
  jobType: string;
  accountId: string | null;
  payload: Record<string, unknown>;
  runAt: Date;
  dedupOnAccountAndType?: boolean;
  dedupAfterRunAt?: Date;
}

function fakeJobs(opts: { enqueue?: (e: Enqueued) => Promise<{ enqueued: boolean }> } = {}): {
  service: ScheduledJobsService;
  enqueued: Enqueued[];
  handlers: Map<string, (job: ScheduledJobRow) => Promise<void>>;
} {
  const enqueued: Enqueued[] = [];
  const handlers = new Map<string, (job: ScheduledJobRow) => Promise<void>>();
  const service = {
    register: (type: string, fn: (job: ScheduledJobRow) => Promise<void>) => {
      handlers.set(type, fn);
    },
    enqueue: (e: Enqueued) => {
      enqueued.push(e);
      return opts.enqueue?.(e) ?? Promise.resolve({ enqueued: true });
    },
  } as unknown as ScheduledJobsService;
  return { service, enqueued, handlers };
}

function jobRow(payload: Record<string, unknown>, runAt = new Date(NOW)): ScheduledJobRow {
  return {
    id: 'job-1',
    jobType: AGENT_TURN_HEALTH_WATCHDOG_JOB_TYPE,
    accountId: null,
    payload,
    runAt,
    attempts: 1,
    maxAttempts: 3,
  };
}

const logFn = () => vi.fn<(obj: Record<string, unknown>, msg: string) => void>();
type LogFn = ReturnType<typeof logFn>;

function recorder(): {
  sentry: { captureMessage: (m: SentryMessage) => void };
  sent: SentryMessage[];
  logger: { info: LogFn; warn: LogFn; error: LogFn };
} {
  const sent: SentryMessage[] = [];
  return {
    sentry: { captureMessage: (m) => sent.push(m) },
    sent,
    logger: { info: logFn(), warn: logFn(), error: logFn() },
  };
}

/** A summary service whose every window reports a completion breach. */
const breachingSummary = (): { summarize: () => Promise<AgentTurnSummary> } => {
  const service = summaryServiceOver([...times(2, () => row()), ...times(10, () => failed())]);
  return { summarize: () => service.summarize(6) };
};

describe('the job', () => {
  it('CRITICAL is registered AND armed at boot: 5 minutes out, deduplicated against a pending row so a restart keeps that row and the state in it', async () => {
    const jobs = fakeJobs();
    const r = recorder();
    await wire({
      scheduledJobs: jobs.service,
      summary: breachingSummary(),
      sentry: r.sentry,
      nowFn: () => NOW,
    });
    expect([...jobs.handlers.keys()]).toEqual([AGENT_TURN_HEALTH_WATCHDOG_JOB_TYPE]);
    expect(jobs.enqueued).toHaveLength(1);
    expect(jobs.enqueued[0]).toMatchObject({
      jobType: AGENT_TURN_HEALTH_WATCHDOG_JOB_TYPE,
      accountId: null,
      runAt: new Date(NOW + AGENT_TURN_HEALTH_WATCHDOG_INTERVAL_MS),
      dedupOnAccountAndType: true,
    });
    expect(jobs.enqueued[0]?.dedupAfterRunAt).toBeUndefined();
    expect(AGENT_TURN_HEALTH_WATCHDOG_INTERVAL_MS).toBe(5 * MIN);
  });

  it('CRITICAL state survives restarts because it lives in the job row: a fresh process per tick still fires the breach exactly once', async () => {
    let payload: Record<string, unknown> = { state: INITIAL_AGENT_TURN_HEALTH_STATE };
    const sent: SentryMessage[] = [];
    for (let tick = 0; tick < 12; tick += 1) {
      // A new registration every tick: nothing in memory carries over.
      const jobs = fakeJobs();
      const now = NOW + tick * AGENT_TURN_HEALTH_WATCHDOG_INTERVAL_MS;
      const r = recorder();
      await wire({
        scheduledJobs: jobs.service,
        summary: breachingSummary(),
        sentry: r.sentry,
        nowFn: () => now,
      });
      jobs.enqueued.length = 0;
      await jobs.handlers.get(AGENT_TURN_HEALTH_WATCHDOG_JOB_TYPE)!(jobRow(payload, new Date(now)));
      expect(jobs.enqueued, 'every tick re-arms exactly once').toHaveLength(1);
      expect(jobs.enqueued[0]?.dedupAfterRunAt).toEqual(new Date(now));
      payload = jobs.enqueued[0]!.payload;
      sent.push(...r.sent);
    }
    // for: 30m on completion → reported on the 7th tick, and only then.
    expect(
      sent.map((m) => `${m.extra?.['condition'] as string}:${m.extra?.['transition'] as string}`),
    ).toEqual(['completion_rate_low:breach']);
  });

  it('every notice is ALSO a structured log line, so the signal exists where Sentry is not configured', async () => {
    const jobs = fakeJobs();
    const r = recorder();
    await wire({
      scheduledJobs: jobs.service,
      summary: breachingSummary(),
      sentry: r.sentry,
      logger: r.logger,
      nowFn: () => NOW,
    });
    const breaching = parseAgentTurnHealthState({
      state: {
        failedTicks: 0,
        signals: {
          completion_rate_low: {
            breaching: false,
            pendingSince: new Date(NOW - 60 * MIN).toISOString(),
            status: 'breach',
          },
        },
      },
    });
    await jobs.handlers.get(AGENT_TURN_HEALTH_WATCHDOG_JOB_TYPE)!(jobRow({ state: breaching }));
    expect(r.sent).toHaveLength(1);
    expect(r.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        component: 'agent-turn-health',
        event: 'agent_turn_health_breach',
        condition: 'completion_rate_low',
        samples: 12,
        // The summary's own window, end to end.
        window_since: new Date(NOW - 6 * 60 * MIN).toISOString(),
        window_until: new Date(NOW).toISOString(),
      }),
      'AI turns: AgentTurnCompletionRateLow breach',
    );
    expect(r.sent[0]?.extra?.['window_until']).toBe(new Date(NOW).toISOString());
  });

  it('switched off, it registers a handler that ends the chain (no re-arm) and arms nothing at boot', async () => {
    const jobs = fakeJobs();
    const r = recorder();
    await wire({
      scheduledJobs: jobs.service,
      summary: breachingSummary(),
      sentry: r.sentry,
      logger: r.logger,
      disabled: true,
    });
    expect(jobs.enqueued).toEqual([]);
    await jobs.handlers.get(AGENT_TURN_HEALTH_WATCHDOG_JOB_TYPE)!(jobRow({}));
    expect(jobs.enqueued).toEqual([]);
    expect(r.sent).toEqual([]);
  });
});

// ── never hurts the product ────────────────────────────────────────────────

describe('never throws into the scheduler, never blocks', () => {
  async function tickWith(
    summary: { summarize: (h: number) => Promise<AgentTurnSummary> },
    extra: { sentryThrows?: boolean; deadlineMs?: number; state?: AgentTurnHealthState } = {},
  ) {
    const jobs = fakeJobs();
    const r = recorder();
    const sentry = extra.sentryThrows
      ? {
          captureMessage: () => {
            throw new Error('sentry down');
          },
        }
      : r.sentry;
    const handle = await wire({
      scheduledJobs: jobs.service,
      summary,
      sentry,
      logger: r.logger,
      nowFn: () => NOW,
      ...(extra.deadlineMs !== undefined ? { deadlineMs: extra.deadlineMs } : {}),
    });
    jobs.enqueued.length = 0;
    await jobs.handlers.get(AGENT_TURN_HEALTH_WATCHDOG_JOB_TYPE)!(
      jobRow({ state: extra.state ?? INITIAL_AGENT_TURN_HEALTH_STATE }),
    );
    return { jobs, r, handle };
  }

  it('CRITICAL a failing query is swallowed, logged and counted — and the chain still re-arms', async () => {
    const { jobs, r, handle } = await tickWith({
      summarize: () => Promise.reject(new Error('connection refused')),
    });
    expect(jobs.enqueued).toHaveLength(1);
    expect(handle.stats().failedTicks).toBe(1);
    expect(r.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'agent_turn_health_evaluation_failed' }),
      expect.any(String),
    );
    expect(parseAgentTurnHealthState(jobs.enqueued[0]!.payload).failedTicks).toBe(1);
  });

  it('a summarize() that throws synchronously is the same as one that rejects', async () => {
    const { jobs } = await tickWith({
      summarize: () => {
        throw new Error('boom');
      },
    });
    expect(jobs.enqueued).toHaveLength(1);
  });

  it('CRITICAL a hung database costs one unevaluated tick, not a handler that outruns the stale-lock window', async () => {
    const started = Date.now();
    const { jobs } = await tickWith(
      { summarize: () => new Promise<AgentTurnSummary>(() => {}) },
      { deadlineMs: 20 },
    );
    expect(Date.now() - started).toBeLessThan(2000);
    expect(jobs.enqueued).toHaveLength(1);
  });

  it('CRITICAL a Sentry client that throws is caught and counted; the tick completes and the log line stands', async () => {
    const pending: AgentTurnHealthState = {
      failedTicks: 0,
      signals: {
        completion_rate_low: {
          breaching: false,
          since: null,
          lastNotifiedAt: null,
          pendingSince: new Date(NOW - 60 * MIN).toISOString(),
          clearingSince: null,
          status: 'breach',
        },
      },
    };
    const { jobs, r, handle } = await tickWith(breachingSummary(), {
      sentryThrows: true,
      state: pending,
    });
    expect(handle.stats().deliveryFailures).toBe(1);
    expect(jobs.enqueued).toHaveLength(1);
    expect(r.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'agent_turn_health_breach' }),
      expect.any(String),
    );
  });

  it('CRITICAL the new state is persisted BEFORE anything is sent: if the re-arm fails, the scheduler retries the old row and nothing was sent twice', async () => {
    const jobs = fakeJobs({ enqueue: () => Promise.reject(new Error('db gone')) });
    const r = recorder();
    await wire({
      scheduledJobs: jobs.service,
      summary: breachingSummary(),
      sentry: r.sentry,
      nowFn: () => NOW,
    }).catch(() => undefined);
    const pending = {
      state: {
        failedTicks: 0,
        signals: {
          completion_rate_low: {
            breaching: false,
            pendingSince: new Date(NOW - 60 * MIN).toISOString(),
            status: 'breach',
          },
        },
      },
    };
    await expect(
      jobs.handlers.get(AGENT_TURN_HEALTH_WATCHDOG_JOB_TYPE)!(jobRow(pending)),
    ).rejects.toThrow('db gone');
    expect(r.sent).toEqual([]);
  });

  it('a run that finds a later successor already armed (a duplicate after a stale lock) sends nothing: that run owns the notices', async () => {
    const jobs = fakeJobs({ enqueue: () => Promise.resolve({ enqueued: false }) });
    const r = recorder();
    await wire({
      scheduledJobs: jobs.service,
      summary: breachingSummary(),
      sentry: r.sentry,
      nowFn: () => NOW,
    });
    const pending = {
      state: {
        signals: {
          completion_rate_low: {
            pendingSince: new Date(NOW - 60 * MIN).toISOString(),
            status: 'breach',
          },
        },
      },
    };
    await jobs.handlers.get(AGENT_TURN_HEALTH_WATCHDOG_JOB_TYPE)!(jobRow(pending));
    expect(r.sent).toEqual([]);
  });

  it('CRITICAL windows are read ONE AT A TIME, each asking the database to cancel at the deadline — a slow database never has three of its connections held by the watchdog', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const asked: Array<{ hours: number; statementTimeoutMs: number | undefined }> = [];
    const inner = breachingSummary();
    await evaluateAgentTurnHealth({
      deadlineMs: 1234,
      summary: {
        summarize: async (hours: number, opts?: { statementTimeoutMs?: number }) => {
          asked.push({ hours, statementTimeoutMs: opts?.statementTimeoutMs });
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((done) => setTimeout(done, 5));
          inFlight -= 1;
          return inner.summarize();
        },
      },
    });
    expect(asked).toEqual([
      { hours: 6, statementTimeoutMs: 1234 },
      { hours: 1, statementTimeoutMs: 1234 },
      { hours: 0.5, statementTimeoutMs: 1234 },
    ]);
    expect(maxInFlight).toBe(1);
  });

  it('CRITICAL a tick that throws past evaluation still counts as unreadable, so a watchdog broken on every tick reports its blindness instead of carrying a zero forward', async () => {
    // An invalid clock makes advance() throw (Date#toISOString on NaN) on the
    // first call of each tick; the catch path's own clock read is valid.
    let payload: Record<string, unknown> = { state: INITIAL_AGENT_TURN_HEALTH_STATE };
    const seen: string[] = [];
    for (let tick = 0; tick < 4; tick += 1) {
      const jobs = fakeJobs();
      const r = recorder();
      let calls = 0;
      const valid = NOW + tick * AGENT_TURN_HEALTH_WATCHDOG_INTERVAL_MS;
      registerAgentTurnHealthWatchdogJob({
        scheduledJobs: jobs.service,
        summary: summaryServiceOver([]),
        sentry: r.sentry,
        logger: r.logger,
        nowFn: () => (calls++ === 0 ? NaN : valid),
      });
      await jobs.handlers.get(AGENT_TURN_HEALTH_WATCHDOG_JOB_TYPE)!(jobRow(payload));
      expect(r.logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'agent_turn_health_tick_failed' }),
        expect.any(String),
      );
      payload = jobs.enqueued[0]!.payload;
      expect(parseAgentTurnHealthState(payload).failedTicks).toBe(tick + 1);
      for (const m of r.sent) seen.push(`${String(tick)}:${String(m.extra?.['condition'])}`);
    }
    expect(seen).toEqual(['2:evaluation_failing']);
  });

  it('even when the fallback itself cannot advance, the blindness counter still moves', async () => {
    const jobs = fakeJobs();
    const r = recorder();
    registerAgentTurnHealthWatchdogJob({
      scheduledJobs: jobs.service,
      summary: summaryServiceOver([]),
      sentry: r.sentry,
      logger: r.logger,
      nowFn: () => NaN,
    });
    await jobs.handlers.get(AGENT_TURN_HEALTH_WATCHDOG_JOB_TYPE)!(
      jobRow({ state: { failedTicks: 4, signals: {} } }),
    );
    expect(parseAgentTurnHealthState(jobs.enqueued[0]!.payload).failedTicks).toBe(5);
  });

  it('the failure counts are readable in production: failure and status lines carry the running totals', async () => {
    const { r } = await tickWith({
      summarize: () => Promise.reject(new Error('connection refused')),
    });
    expect(r.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'agent_turn_health_status',
        condition: 'evaluation_failing',
        ticks_total: 1,
        failed_ticks_total: 1,
        delivery_failures_total: 0,
      }),
      expect.any(String),
    );
    const pending: AgentTurnHealthState = {
      failedTicks: 0,
      signals: {
        completion_rate_low: {
          breaching: false,
          since: null,
          lastNotifiedAt: null,
          pendingSince: new Date(NOW - 60 * MIN).toISOString(),
          clearingSince: null,
          status: 'breach',
        },
      },
    };
    const thrown = await tickWith(breachingSummary(), { sentryThrows: true, state: pending });
    expect(thrown.r.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'agent_turn_health_delivery_failed',
        delivery_failures_total: 1,
      }),
      expect.any(String),
    );
  });
});

// ── content-free ───────────────────────────────────────────────────────────

describe('content-free alerts', () => {
  const ALLOWED_EXTRA = new Set([
    'condition',
    'transition',
    'breaching_since',
    'window_minutes',
    'min_samples',
    'threshold',
    'breach_when',
    'unit',
    'for_minutes',
    'samples',
    'value',
    'completed',
    'busy_409',
    'conflict_409',
    'p50_ms',
    'p95_ms',
    'consecutive_failed_ticks',
    'window_since',
    'window_until',
    'cleared_by',
  ]);

  it('CRITICAL sentinels planted in every string the watchdog can reach — the summary, the job row, its payload — reach neither Sentry, nor the log, nor the next job row', async () => {
    // A summary whose free-form strings are all sentinels. The real aggregates
    // cannot hold these (the table CHECK-constrains them); the point is that
    // the watchdog would not forward them if they could.
    const base = await summaryServiceOver([
      ...times(2, () => row()),
      ...times(10, () => failed({ timeToFirstProgressMs: 9000 })),
      ...times(10, () => busy()),
    ]).summarize(6);
    const poisoned: AgentTurnSummary = {
      ...base,
      window: { hours: 6, since: 'SENTINEL_SINCE', until: 'SENTINEL_UNTIL' },
      deaths: [{ reason: 'SENTINEL_TASK_TEXT', step_kind: 'SENTINEL_URL', count: 10, share: 1 }],
      turned_away: [{ reason: 'SENTINEL_SESSION', count: 10, share: 1 }],
      models: [{ model: 'SENTINEL_MODEL_OUTPUT', turns: 10 }],
    };
    expect(JSON.stringify(poisoned)).toContain('SENTINEL');

    const jobs = fakeJobs();
    const r = recorder();
    await wire({
      scheduledJobs: jobs.service,
      summary: { summarize: () => Promise.resolve(poisoned) },
      sentry: r.sentry,
      logger: r.logger,
      nowFn: () => NOW,
    });
    jobs.enqueued.length = 0;
    const longAgo = new Date(NOW - 60 * MIN).toISOString();
    // One condition about to breach, two already breaching with a reminder
    // due — so both the `breach` and the `still_breaching` paths (which
    // forwards the stored `since`) are exercised with sentinels in the row.
    const signal = {
      breaching: false,
      pendingSince: longAgo,
      status: 'breach',
      since: 'SENTINEL_SINCE_FIELD',
      accountId: 'acct_SENTINEL',
    };
    const breachingSignal = {
      ...signal,
      breaching: true,
      lastNotifiedAt: new Date(NOW - 7 * 60 * MIN).toISOString(),
    };
    await jobs.handlers.get(AGENT_TURN_HEALTH_WATCHDOG_JOB_TYPE)!({
      ...jobRow({
        taskText: 'SENTINEL_TASK',
        state: {
          failedTicks: 'SENTINEL_COUNT',
          sessionId: 'as_SENTINEL',
          signals: {
            // Stored as `ok`, so this tick's status CHANGE is logged too.
            completion_rate_low: { ...signal, status: 'ok' },
            conflict_rate_high: breachingSignal,
            first_progress_slow: breachingSignal,
            SENTINEL_KEY: signal,
          },
        },
      }),
      accountId: 'acct_SENTINEL_ROW',
    });

    // Positive control: all three conditions fired, so the payloads were built.
    expect(
      r.sent.map((m) => `${String(m.extra?.['condition'])}:${String(m.extra?.['transition'])}`),
    ).toEqual([
      'completion_rate_low:breach',
      'conflict_rate_high:still_breaching',
      'first_progress_slow:still_breaching',
    ]);
    const everything = JSON.stringify({
      sent: r.sent,
      logs: [r.logger.info.mock.calls, r.logger.warn.mock.calls, r.logger.error.mock.calls],
      nextRow: jobs.enqueued,
    });
    expect(everything).not.toContain('SENTINEL');
    expect(everything).not.toContain('acct_');

    for (const m of r.sent) {
      expect(Object.keys(m.extra ?? {}).filter((k) => !ALLOWED_EXTRA.has(k))).toEqual([]);
      for (const v of Object.values(m.extra ?? {})) {
        expect(v === null || typeof v === 'number' || typeof v === 'string').toBe(true);
      }
      expect(Object.keys(m.tags ?? {}).sort()).toEqual(['component', 'condition', 'transition']);
    }
  });

  it('a parsed state keeps only known signals, well-formed dates and closed statuses', () => {
    const s = parseAgentTurnHealthState({
      state: {
        failedTicks: 2,
        signals: {
          completion_rate_low: {
            breaching: true,
            since: 'not a date',
            lastNotifiedAt: '2026-09-18T10:00:00Z',
            status: 'SENTINEL',
          },
          other: { breaching: true },
        },
      },
    });
    expect(s).toEqual({
      failedTicks: 2,
      signals: {
        completion_rate_low: {
          breaching: true,
          since: null,
          pendingSince: null,
          clearingSince: null,
          lastNotifiedAt: '2026-09-18T10:00:00.000Z',
          status: null,
        },
      },
    });
    expect(parseAgentTurnHealthState(null)).toEqual(INITIAL_AGENT_TURN_HEALTH_STATE);
    expect(parseAgentTurnHealthState({ state: 'x' })).toEqual(INITIAL_AGENT_TURN_HEALTH_STATE);
  });
});

// ── wiring pins ────────────────────────────────────────────────────────────

describe('wiring', () => {
  const HERE = dirname(fileURLToPath(import.meta.url));
  const bootstrap = readFileSync(resolve(HERE, '..', '..', 'src', 'lib', 'bootstrap.ts'), 'utf8');

  it('CRITICAL bootstrap wires the watchdog to the live summary service and the Sentry client, behind the shared env-flag rule', () => {
    const wiring =
      /if \(agentTurnHealthWatchdogDisabled\) \{\s*endAgentTurnHealthWatchdogChain\(\{[^}]*\}\);\s*\} else \{\s*registerAgentTurnHealthWatchdogJob\(\{([\s\S]*?)\}\);\s*await enqueueNextAgentTurnHealthWatchdog\(\{ scheduledJobs: scheduledJobsService \}\);\s*\}/.exec(
        bootstrap,
      );
    expect(
      wiring,
      'bootstrap must register AND arm the watchdog, unless switched off',
    ).not.toBeNull();
    expect(wiring![1]).toMatch(/scheduledJobs: scheduledJobsService,/);
    expect(wiring![1]).toMatch(/summary: agentTurnSummaryService,/);
    expect(wiring![1]).toMatch(/\bsentry,/);
    expect(bootstrap).toMatch(
      /const agentTurnHealthWatchdogDisabled = envFlag\(\s*process\.env\.DRIFTSTACK_DISABLE_AGENT_TURN_HEALTH_WATCHDOG,\s*\);/,
    );
  });

  it('a switched-off watchdog is left off the liveness gauge rather than reported as a dead chain', () => {
    expect(bootstrap).toMatch(
      /agentTurnHealthWatchdogDisabled\s*\?\s*\[AGENT_TURN_HEALTH_WATCHDOG_JOB_TYPE\]/,
    );
    expect(bootstrap).toMatch(/agentTurnHealthWatchdog: !agentTurnHealthWatchdogDisabled,/);
  });

  it('the rule table covers exactly the conditions the watchdog evaluates', () => {
    expect(Object.keys(AGENT_TURN_ALERT_RULES).sort()).toEqual([...ALL].sort());
  });

  it('builds its figures from the shared summary, so the page and the watchdog cannot disagree', () => {
    const empty = buildAgentTurnSummary(
      {
        byOutcome: {},
        deaths: [],
        turnedAway: [],
        byModel: [],
        ran: {
          count: 0,
          replanned: 0,
          replansSum: 0,
          recoveredAfterReplan: 0,
          customerStopped: 0,
          viewerDisconnected: 0,
          modelCallsSum: 0,
          stepsRunSum: 0,
          stepsSucceededSum: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costMillicents: 0,
        },
        firstProgressStreamSamples: 42,
        percentilesMs: {
          turn: { p50: null, p95: null },
          firstProgressStream: { p50: 100, p95: 200 },
          firstProgressAll: { p50: null, p95: null },
          planning: { p50: null, p95: null },
          startingBrowser: { p50: null, p95: null },
          executing: { p50: null, p95: null },
          readingPage: { p50: null, p95: null },
          answering: { p50: null, p95: null },
          afterTurn: { p50: null, p95: null },
        },
      },
      { hours: 0.5, since: new Date(NOW - 30 * MIN), until: new Date(NOW) },
    );
    expect(empty.durations_ms.time_to_first_progress.stream_samples).toBe(42);
  });
});
