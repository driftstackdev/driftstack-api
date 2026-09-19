// The AI turn health watchdog's email to the owner.
//
// Sentry notifies on a new issue or a regression only, and no Sentry auth token
// exists to create a per-event rule, so the owner is emailed every notice. These
// tests run the REGISTERED handler the way the scheduler does, a fresh
// registration per tick (a restart every five minutes), each tick fed the
// payload the previous one enqueued — so everything the email path remembers
// has to survive in the job row, as it must across a deploy.

import { describe, expect, it, vi } from 'vitest';

import { InMemoryAgentTurnTelemetryRepo } from '../../src/db/agent-turn-telemetry-repo.js';
import { AgentTurnSummaryService } from '../../src/services/agent-turn-summary.js';
import {
  AGENT_TURN_HEALTH_EMAIL_MAX_PER_HOUR,
  AGENT_TURN_HEALTH_WATCHDOG_INTERVAL_MS,
  AGENT_TURN_HEALTH_WATCHDOG_JOB_TYPE,
  INITIAL_AGENT_TURN_HEALTH_STATE,
  parseAgentTurnHealthState,
  planAgentTurnHealthEmails,
  registerAgentTurnHealthWatchdogJob,
  type AgentTurnHealthEmailer,
  type AgentTurnHealthNotice,
  type AgentTurnHealthWatchdogStats,
} from '../../src/services/agent-turn-health-watchdog.js';
import {
  AGENT_TURN_HEALTH_ADMIN_URL,
  AGENT_TURN_HEALTH_RUNBOOK_REF,
  createAgentTurnHealthEmailer,
  renderAgentTurnHealthEmail,
} from '../../src/services/agent-turn-health-email.js';
import type { PostmarkSendApi } from '../../src/services/email.js';
import type { AgentTurnTelemetryRow } from '../../src/services/agent-turn-telemetry.js';
import type { ScheduledJobRow, ScheduledJobsService } from '../../src/services/scheduled-jobs.js';
import type { SentryMessage } from '../../src/lib/sentry.js';
import { AGENT_TURN_ROW_NOW, row } from './_helpers/agent-turn-telemetry-row.js';

const NOW = AGENT_TURN_ROW_NOW;
const MIN = 60_000;
const TICK = AGENT_TURN_HEALTH_WATCHDOG_INTERVAL_MS;
const OWNER = 'owner@driftstack.test';
const POSTMARK = {
  apiToken: 'pm-test-token',
  from: 'alerts@driftstack.test',
  replyTo: 'ops@driftstack.test',
};

// ── the database, as three moods ───────────────────────────────────────────

const times = (n: number, make: () => AgentTurnTelemetryRow): AgentTurnTelemetryRow[] =>
  Array.from({ length: n }, make);

function service(rows: AgentTurnTelemetryRow[]): AgentTurnSummaryService {
  const repo = new InMemoryAgentTurnTelemetryRepo();
  for (const r of rows) void repo.insert(r);
  return new AgentTurnSummaryService({ repo, nowFn: () => NOW });
}

/** Every condition over its threshold: 2 of 12 completed, 10 of 22 answered
 *  409, streaming p95 at nine seconds. */
const BREACHING = service([
  ...times(2, () => row()),
  ...times(10, () =>
    row({
      outcome: 'failed',
      deathReason: 'element_never_appeared_in_retry_budget',
      timeToFirstProgressMs: 9000,
    }),
  ),
  ...times(10, () =>
    row({
      outcome: 'busy_409',
      deathReason: 'turn_in_progress',
      httpStatus: 409,
      model: 'none',
      modelCalls: 0,
      timeToFirstProgressMs: null,
    }),
  ),
]);
/** Every condition healthy. */
const HEALTHY = service(times(12, () => row()));

type Mood = 'breach' | 'ok' | 'fail';

function summaryFor(mood: Mood): Pick<AgentTurnSummaryService, 'summarize'> {
  return {
    summarize: (hours, opts) => {
      switch (mood) {
        case 'breach':
          return BREACHING.summarize(hours, opts);
        case 'ok':
          return HEALTHY.summarize(hours, opts);
        case 'fail':
          return Promise.reject(new Error('database unavailable'));
        default: {
          const unreachable: never = mood;
          throw new Error(`unknown mood ${String(unreachable)}`);
        }
      }
    },
  };
}

// ── the scheduler, one fresh process per tick ──────────────────────────────

interface Mailed {
  tick: number;
  at: number;
  subject: string;
  text: string;
  html: string;
}

interface Run {
  sentry: Array<{ tick: number; at: number; key: string }>;
  mailed: Mailed[];
  logs: Array<{ level: string; obj: Record<string, unknown>; msg: string }>;
  stats: AgentTurnHealthWatchdogStats[];
  payload: Record<string, unknown>;
}

function recordingClient(mailed: Mailed[], clock: { tick: number; at: number }): PostmarkSendApi {
  return {
    sendEmail: (input) => {
      expect(input.To).toBe(OWNER);
      expect(input.From).toBe(POSTMARK.from);
      expect(input.ReplyTo).toBe(POSTMARK.replyTo);
      mailed.push({
        tick: clock.tick,
        at: clock.at,
        subject: input.Subject,
        text: input.TextBody,
        html: input.HtmlBody,
      });
      return Promise.resolve({});
    },
  };
}

function jobRow(payload: Record<string, unknown>, runAt: Date): ScheduledJobRow {
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

const key = (m: { extra?: Record<string, unknown> }): string =>
  `${String(m.extra?.['condition'])}:${String(m.extra?.['transition'])}`;

/**
 * Tick through `moods`, five minutes apart, registering the watchdog afresh on
 * every tick with a real emailer over a recording Postmark client.
 */
async function run(
  moods: readonly Mood[],
  opts: {
    payload?: Record<string, unknown>;
    client?: (mailed: Mailed[], clock: { tick: number; at: number }) => PostmarkSendApi;
    emailer?: AgentTurnHealthEmailer | null;
    emailDeadlineMs?: number;
  } = {},
): Promise<Run> {
  const out: Run = {
    sentry: [],
    mailed: [],
    logs: [],
    stats: [],
    payload: opts.payload ?? { state: INITIAL_AGENT_TURN_HEALTH_STATE },
  };
  const clock = { tick: 0, at: NOW };
  const log =
    (level: string) =>
    (obj: Record<string, unknown>, msg: string): void => {
      out.logs.push({ level, obj, msg });
    };
  const logger = { info: log('info'), warn: log('warn'), error: log('error') };
  for (let tick = 0; tick < moods.length; tick += 1) {
    clock.tick = tick;
    clock.at = NOW + tick * TICK;
    const handlers = new Map<string, (job: ScheduledJobRow) => Promise<void>>();
    const enqueued: Array<{ payload: Record<string, unknown> }> = [];
    const jobs = {
      register: (type: string, fn: (job: ScheduledJobRow) => Promise<void>) => {
        handlers.set(type, fn);
      },
      enqueue: (e: { payload: Record<string, unknown> }) => {
        enqueued.push(e);
        return Promise.resolve({ enqueued: true });
      },
    } as unknown as ScheduledJobsService;
    const emailer =
      opts.emailer !== undefined
        ? opts.emailer
        : createAgentTurnHealthEmailer({
            postmark: POSTMARK,
            ownerEmail: OWNER,
            disabled: false,
            client: (opts.client ?? recordingClient)(out.mailed, clock),
          });
    const at = clock.at;
    const handle = registerAgentTurnHealthWatchdogJob({
      scheduledJobs: jobs,
      summary: summaryFor(moods[tick]!),
      sentry: {
        captureMessage: (m: SentryMessage) => {
          out.sentry.push({ tick, at, key: key(m) });
        },
      },
      email: emailer,
      logger,
      nowFn: () => at,
      ...(opts.emailDeadlineMs === undefined ? {} : { emailDeadlineMs: opts.emailDeadlineMs }),
    });
    await handlers.get(AGENT_TURN_HEALTH_WATCHDOG_JOB_TYPE)!(jobRow(out.payload, new Date(at)));
    expect(enqueued, 'every tick re-arms exactly once').toHaveLength(1);
    out.payload = enqueued[0]!.payload;
    out.stats.push(handle.stats());
  }
  return out;
}

const repeat = (mood: Mood, n: number): Mood[] => Array.from({ length: n }, () => mood);

/** The condition and transition an email is about, read back from its
 *  subject — the words the owner actually sees. */
function mailKey(m: Mailed): string {
  const titles: Record<string, string> = {
    'completion rate low': 'completion_rate_low',
    'busy/conflict rate high': 'conflict_rate_high',
    'first progress slow': 'first_progress_slow',
    'health watchdog blind': 'evaluation_failing',
  };
  const match = /^AI automation: (.+) — (started|still breaching|recovered)/.exec(m.subject);
  if (match === null) throw new Error(`unrecognised subject: ${m.subject}`);
  const transition =
    match[2] === 'started'
      ? 'breach'
      : match[2] === 'still breaching'
        ? 'still_breaching'
        : 'recovered';
  return `${titles[match[1]!] ?? match[1]!}:${transition}`;
}

// ── A1: every notice is also an email ──────────────────────────────────────

describe('every notice that reaches Sentry also reaches the owner, once', () => {
  it('CRITICAL breach, reminder, recovery and "watchdog blind" (and its recovery) each email exactly once, in step with Sentry', async () => {
    const moods: Mood[] = [
      ...repeat('breach', 80), // 6 h 40 min: breaches, then a reminder each
      ...repeat('ok', 30), // recoveries once each rule's hold has run
      ...repeat('fail', 3), // the watchdog goes blind
      'ok', // and sees again
      ...repeat('ok', 6),
    ];
    const r = await run(moods);
    const expected = [
      'conflict_rate_high:breach',
      'first_progress_slow:breach',
      'completion_rate_low:breach',
      'conflict_rate_high:still_breaching',
      'first_progress_slow:still_breaching',
      'completion_rate_low:still_breaching',
      'conflict_rate_high:recovered',
      'first_progress_slow:recovered',
      'completion_rate_low:recovered',
      'evaluation_failing:breach',
      'evaluation_failing:recovered',
    ];
    expect(r.sentry.map((s) => s.key)).toEqual(expected);
    expect(r.mailed.map(mailKey)).toEqual(expected);
    // On the SAME tick as its Sentry event, not late and not early.
    expect(r.mailed.map((m) => m.tick)).toEqual(r.sentry.map((s) => s.tick));
    // Each tick is a fresh process, so its stats are that tick's alone.
    const sum = (k: 'emailsSent' | 'emailFailures' | 'emailsWithheld'): number =>
      r.stats.reduce((n, s) => n + s[k], 0);
    expect([sum('emailsSent'), sum('emailFailures'), sum('emailsWithheld')]).toEqual([
      expected.length,
      0,
      0,
    ]);
  });

  it('the subject says the condition and the state plainly, and the body gives the window, counts, rates, threshold, meaning and where to look', async () => {
    const r = await run(repeat('breach', 7));
    const completion = r.mailed.find((m) => mailKey(m) === 'completion_rate_low:breach');
    expect(completion).toBeDefined();
    // Breach declared at tick 6 = 12:30 UTC.
    expect(completion!.subject).toBe('AI automation: completion rate low — started 12:30 UTC');
    const text = completion!.text;
    expect(text).toContain('What it means: Too few AI turns are finishing');
    expect(text).toContain('Window: last 6 h (2026-09-18 06:00 UTC to 2026-09-18 12:00 UTC)');
    expect(text).toContain('Measured: 16.7%');
    expect(text).toContain('Samples in the window: 12');
    expect(text).toContain('Completed turns: 2');
    expect(text).toContain(
      'Threshold: breach when below 50.0%, with at least 10 samples, held for 30 min',
    );
    expect(text).toContain(AGENT_TURN_HEALTH_ADMIN_URL);
    expect(text).toContain(AGENT_TURN_HEALTH_RUNBOOK_REF);
    expect(text).toContain('DRIFTSTACK_DISABLE_AGENT_TURN_HEALTH_EMAIL=true');
    // The HTML part is a whole document, with the same facts.
    expect(completion!.html).toMatch(/^<!DOCTYPE html>/);
    expect(completion!.html).toContain('<meta charset="utf-8">');
    expect(completion!.html).toContain(`<a href="${AGENT_TURN_HEALTH_ADMIN_URL}">`);
    expect(completion!.html).toContain('Measured: 16.7%');
  });
});

describe('rendering', () => {
  const base: AgentTurnHealthNotice = {
    signal: 'first_progress_slow',
    transition: 'still_breaching',
    breaching_since: '2026-09-18T09:05:00.000Z',
    figures: { samples: 10, value: 9000, p50_ms: 9000, p95_ms: 9000 },
    window: { since: '2026-09-18T11:30:00.000Z', until: '2026-09-18T12:00:00.000Z' },
  };

  it('reminders and recoveries name when the breach began, with the date; a recovery says what cleared it', () => {
    expect(renderAgentTurnHealthEmail(base).subject).toBe(
      'AI automation: first progress slow — still breaching since 2026-09-18 09:05 UTC',
    );
    const recovered = renderAgentTurnHealthEmail({
      ...base,
      transition: 'recovered',
      cleared_by: 'insufficient_data',
    });
    expect(recovered.subject).toBe(
      'AI automation: first progress slow — recovered (began 2026-09-18 09:05 UTC)',
    );
    expect(recovered.text).toContain('traffic fell below the volume floor');
    expect(
      renderAgentTurnHealthEmail({ ...base, transition: 'recovered', cleared_by: 'ok' }).text,
    ).toContain('back on the healthy side of the threshold');
  });

  it('"watchdog blind" says it is blind and gives the unreadable-check count, not a rate', () => {
    const blind = renderAgentTurnHealthEmail({
      signal: 'evaluation_failing',
      transition: 'breach',
      breaching_since: '2026-09-18T12:10:00.000Z',
      figures: { consecutive_failed_ticks: 3 },
    });
    expect(blind.subject).toBe('AI automation: health watchdog blind — started 12:10 UTC');
    expect(blind.text).toContain('Consecutive unreadable checks: 3');
    expect(blind.text).toContain('Threshold: blind after 3 checks in a row');
    expect(blind.text).not.toContain('Measured:');
  });

  it('a non-production environment is named in the subject; production, or a malformed name, is not', () => {
    expect(renderAgentTurnHealthEmail(base, { environment: 'staging' }).subject).toMatch(
      /^\[staging\] AI automation: /,
    );
    expect(renderAgentTurnHealthEmail(base, { environment: 'production' }).subject).toMatch(
      /^AI automation: /,
    );
    expect(renderAgentTurnHealthEmail(base, { environment: '<b>x</b>' }).subject).toMatch(
      /^AI automation: /,
    );
  });

  it('CRITICAL the renderer forwards nothing it is handed raw: sentinels in every free field of a notice reach neither subject, text nor HTML', () => {
    // The watchdog only ever hands it clean notices; this holds the renderer
    // itself to the Sentry payload's closed list, so a later edit that reads
    // a notice field directly is caught here.
    const poisoned: AgentTurnHealthNotice = JSON.parse(
      JSON.stringify({
        signal: 'completion_rate_low',
        transition: 'recovered',
        breaching_since: 'SENTINEL_SINCE',
        cleared_by: 'SENTINEL_CLEARED',
        window: { since: 'SENTINEL_WINDOW', until: '<script>SENTINEL</script>' },
        figures: { samples: 'SENTINEL_SAMPLES', value: 'SENTINEL_VALUE', completed: 3 },
        accountId: 'acct_SENTINEL',
      }),
    );
    const mail = renderAgentTurnHealthEmail(poisoned, { withheld: 2 });
    // Positive control: it rendered the real parts.
    expect(mail.subject).toBe('AI automation: completion rate low — recovered');
    expect(mail.text).toContain('Completed turns: 3');
    const all = JSON.stringify(mail);
    expect(all).not.toContain('SENTINEL');
    expect(all).not.toContain('acct_');
    expect(all).not.toContain('<script>');
  });

  it('the first email after the rate limit bit says how many were held back', () => {
    expect(renderAgentTurnHealthEmail(base, { withheld: 4 }).text).toContain(
      '4 earlier alert email(s) were held back by the rate limit',
    );
    expect(renderAgentTurnHealthEmail(base, { withheld: 0 }).text).not.toContain('held back');
  });
});

// ── A2: bounded, isolated, off when unconfigured, idempotent ───────────────

/** A deterministic pseudo-random sequence of moods: a database flapping
 *  between breach, healthy and unreadable at every scale. */
function flapping(ticks: number, seed: number): Mood[] {
  let s = seed;
  const out: Mood[] = [];
  while (out.length < ticks) {
    s = (s * 1103515245 + 12345) % 2147483648;
    const mood: Mood = s % 3 === 0 ? 'breach' : s % 3 === 1 ? 'ok' : 'fail';
    const len = 1 + ((s >> 8) % 5);
    for (let i = 0; i < len; i += 1) out.push(mood);
  }
  return out.slice(0, ticks);
}

describe('a flapping condition cannot fill the inbox', () => {
  it(`CRITICAL never more than ${String(AGENT_TURN_HEALTH_EMAIL_MAX_PER_HOUR)} emails in any rolling hour, across restarts — and every notice is either emailed or counted as held back`, async () => {
    // Two days of flapping. Each tick is a fresh process, so the limit only
    // holds if its budget travels in the job row.
    const r = await run(flapping(576, 7));
    const notices = r.sentry.length;
    const sent = r.mailed.length;
    const withheld = r.stats.reduce((n, s) => n + s.emailsWithheld, 0);
    // Positive control: the flapping really does outrun the limit.
    expect(notices).toBeGreaterThan(sent);
    expect(withheld).toBeGreaterThan(0);
    expect(sent + withheld).toBe(notices);
    for (const m of r.mailed) {
      const inHour = r.mailed.filter((o) => o.at <= m.at && m.at - o.at < 60 * MIN).length;
      expect(inHour).toBeLessThanOrEqual(AGENT_TURN_HEALTH_EMAIL_MAX_PER_HOUR);
    }
    // Held-back emails are reported in a later one, and logged when held.
    expect(r.mailed.some((m) => m.text.includes('were held back by the rate limit'))).toBe(true);
    expect(r.logs.some((l) => l.obj['event'] === 'agent_turn_health_email_withheld')).toBe(true);
  });

  it('the plan spends the budget oldest-first and forgets sends older than an hour', () => {
    const now = new Date(NOW);
    const recent = Array.from({ length: 5 }, (_, i) =>
      new Date(NOW - (10 + i) * MIN).toISOString(),
    );
    const old = new Date(NOW - 61 * MIN).toISOString();
    const plan = planAgentTurnHealthEmails({ sentAt: [old, ...recent], withheld: 2 }, 3, now);
    expect(plan).toMatchObject({ send: 1, withheld: 2, withheldBefore: 2 });
    expect(plan.next.sentAt).toHaveLength(AGENT_TURN_HEALTH_EMAIL_MAX_PER_HOUR);
    expect(plan.next.sentAt).not.toContain(old);
    expect(plan.next.withheld).toBe(2);
    // Nothing to spend: the held count accumulates for the next email.
    const full = planAgentTurnHealthEmails(plan.next, 2, now);
    expect(full).toMatchObject({ send: 0, withheld: 2 });
    expect(full.next.withheld).toBe(4);
  });

  it('a stored email state is parsed as untrusted: dates re-serialised, counts integers, the list capped', () => {
    const s = parseAgentTurnHealthState({
      state: {
        failedTicks: 0,
        signals: {},
        email: {
          sentAt: ['nonsense', ...Array.from({ length: 20 }, () => '2026-09-18T11:00:00Z')],
          withheld: 'lots',
        },
      },
    });
    expect(s.email?.sentAt).toHaveLength(AGENT_TURN_HEALTH_EMAIL_MAX_PER_HOUR);
    expect(s.email?.sentAt.every((d) => d === '2026-09-18T11:00:00.000Z')).toBe(true);
    expect(s.email?.withheld).toBe(0);
  });
});

describe('an email failure never hurts the tick or the Sentry path', () => {
  const breachAt = repeat('breach', 4); // conflict + first progress breach on tick 3

  it('CRITICAL Postmark rejecting is swallowed, logged without the address, and counted — Sentry still gets every notice and the chain re-arms', async () => {
    const r = await run(breachAt, {
      client: () => ({
        sendEmail: () =>
          Promise.reject(
            Object.assign(new Error(`Found inactive addresses: ${OWNER}`), { code: 405 }),
          ),
      }),
    });
    expect(r.sentry.map((s) => s.key)).toEqual([
      'conflict_rate_high:breach',
      'first_progress_slow:breach',
    ]);
    expect(r.stats.at(-1)).toMatchObject({ emailsSent: 0, emailFailures: 2, noticesSent: 2 });
    const failures = r.logs.filter((l) => l.obj['event'] === 'agent_turn_health_email_failed');
    expect(failures).toHaveLength(2);
    expect(JSON.stringify(failures)).toContain('inactive-recipient');
    expect(JSON.stringify(r.logs)).not.toContain(OWNER);
  });

  it('an emailer that throws synchronously is the same as one that rejects', async () => {
    const r = await run(breachAt, {
      emailer: {
        send: () => {
          throw new Error('boom');
        },
      },
    });
    expect(r.sentry).toHaveLength(2);
    expect(r.stats.at(-1)).toMatchObject({ emailFailures: 2 });
  });

  it('CRITICAL a hung Postmark costs the tick its email deadline, not the tick', async () => {
    const started = Date.now();
    const r = await run(breachAt, {
      client: () => ({ sendEmail: () => new Promise(() => undefined) }),
      emailDeadlineMs: 50,
    });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(r.sentry).toHaveLength(2);
    expect(r.stats.at(-1)).toMatchObject({ emailFailures: 2 });
    expect(
      r.logs.some(
        (l) =>
          l.obj['event'] === 'agent_turn_health_email_failed' &&
          JSON.stringify(l.obj['err']).includes('exceeded 50ms'),
      ),
    ).toBe(true);
  }, 5_000);

  it('Sentry is called before any email is attempted', async () => {
    const order: string[] = [];
    const handlers = new Map<string, (job: ScheduledJobRow) => Promise<void>>();
    registerAgentTurnHealthWatchdogJob({
      scheduledJobs: {
        register: (t: string, fn: (job: ScheduledJobRow) => Promise<void>) => handlers.set(t, fn),
        enqueue: () => Promise.resolve({ enqueued: true }),
      } as unknown as ScheduledJobsService,
      summary: summaryFor('breach'),
      sentry: { captureMessage: () => order.push('sentry') },
      email: {
        send: () => {
          order.push('email');
          return Promise.resolve();
        },
      },
      nowFn: () => NOW,
    });
    const pending = {
      breaching: false,
      pendingSince: new Date(NOW - 60 * MIN).toISOString(),
      status: 'breach',
    };
    await handlers.get(AGENT_TURN_HEALTH_WATCHDOG_JOB_TYPE)!(
      jobRow(
        { state: { failedTicks: 0, signals: { conflict_rate_high: pending } } },
        new Date(NOW),
      ),
    );
    expect(order).toEqual(['sentry', 'email']);
  });
});

describe('off when there is nothing to send with, and says so once', () => {
  it.each([
    ['postmark_not_configured', { postmark: null, ownerEmail: OWNER, disabled: false }],
    ['no_owner_address', { postmark: POSTMARK, ownerEmail: '  ', disabled: false }],
    ['no_owner_address', { postmark: POSTMARK, ownerEmail: null, disabled: false }],
    ['switched_off', { postmark: POSTMARK, ownerEmail: OWNER, disabled: true }],
  ] as const)('CRITICAL %s → no emailer, no send, and exactly one log line', (reason, cfg) => {
    const sendEmail = vi.fn(() => Promise.resolve({}));
    const info = vi.fn<(obj: Record<string, unknown>, msg: string) => void>();
    const emailer = createAgentTurnHealthEmailer({
      ...cfg,
      client: { sendEmail },
      logger: { info },
    });
    expect(emailer).toBeNull();
    expect(sendEmail).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0]![0]).toMatchObject({
      component: 'agent-turn-health',
      event: 'agent_turn_health_email_off',
      reason,
    });
    expect(JSON.stringify(info.mock.calls)).not.toContain(OWNER);
  });

  it('CRITICAL with email off the watchdog still reports to Sentry, sends nothing, and never repeats the "off" line per tick', async () => {
    const r = await run(repeat('breach', 8), { emailer: null });
    expect(r.sentry.length).toBeGreaterThan(0);
    expect(r.mailed).toEqual([]);
    expect(
      r.logs.filter((l) => String(l.obj['event']).startsWith('agent_turn_health_email')),
    ).toEqual([]);
    expect(r.stats.at(-1)).toMatchObject({ emailsSent: 0, emailFailures: 0, emailsWithheld: 0 });
  });

  it('configured, it logs that it is on — once, and without the address', () => {
    const info = vi.fn<(obj: Record<string, unknown>, msg: string) => void>();
    const emailer = createAgentTurnHealthEmailer({
      postmark: POSTMARK,
      ownerEmail: OWNER,
      disabled: false,
      client: { sendEmail: () => Promise.resolve({}) },
      logger: { info },
    });
    expect(emailer).not.toBeNull();
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0]![0]).toMatchObject({ event: 'agent_turn_health_email_on' });
    expect(JSON.stringify(info.mock.calls)).not.toContain(OWNER);
  });
});

describe('idempotent across restarts', () => {
  it('CRITICAL a retry of the same row after a failed re-arm mails nothing twice, and the budget spent is in the row the successor reads', async () => {
    const mailed: Mailed[] = [];
    const clock = { tick: 0, at: NOW };
    const emailer = createAgentTurnHealthEmailer({
      postmark: POSTMARK,
      ownerEmail: OWNER,
      disabled: false,
      client: recordingClient(mailed, clock),
    });
    const pending = {
      breaching: false,
      pendingSince: new Date(NOW - 60 * MIN).toISOString(),
      status: 'breach',
    };
    const row = jobRow(
      { state: { failedTicks: 0, signals: { conflict_rate_high: pending } } },
      new Date(NOW),
    );
    const enqueued: Array<{ payload: Record<string, unknown> }> = [];
    let failReArm = true;
    const handlers = new Map<string, (job: ScheduledJobRow) => Promise<void>>();
    registerAgentTurnHealthWatchdogJob({
      scheduledJobs: {
        register: (t: string, fn: (job: ScheduledJobRow) => Promise<void>) => handlers.set(t, fn),
        enqueue: (e: { payload: Record<string, unknown> }) => {
          if (failReArm) return Promise.reject(new Error('database gone'));
          enqueued.push(e);
          return Promise.resolve({ enqueued: true });
        },
      } as unknown as ScheduledJobsService,
      summary: summaryFor('breach'),
      sentry: { captureMessage: () => undefined },
      email: emailer,
      nowFn: () => NOW,
    });
    const handler = handlers.get(AGENT_TURN_HEALTH_WATCHDOG_JOB_TYPE)!;
    await expect(handler(row)).rejects.toThrow('database gone');
    expect(mailed, 'nothing is mailed before the state is saved').toEqual([]);
    failReArm = false;
    await handler(row); // the scheduler's retry, old payload
    expect(mailed.map(mailKey)).toContain('conflict_rate_high:breach');
    const count = mailed.length;
    const saved = parseAgentTurnHealthState(enqueued[0]!.payload);
    expect(saved.email?.sentAt).toHaveLength(count);
    // A deploy: the next process picks up the saved row — the transition is
    // not mailed again.
    const after = await run(['breach'], { payload: enqueued[0]!.payload });
    expect(after.mailed).toEqual([]);
  });

  it('a duplicate run that finds a later successor already armed mails nothing', async () => {
    const mailed: Mailed[] = [];
    const handlers = new Map<string, (job: ScheduledJobRow) => Promise<void>>();
    registerAgentTurnHealthWatchdogJob({
      scheduledJobs: {
        register: (t: string, fn: (job: ScheduledJobRow) => Promise<void>) => handlers.set(t, fn),
        enqueue: () => Promise.resolve({ enqueued: false }),
      } as unknown as ScheduledJobsService,
      summary: summaryFor('breach'),
      sentry: { captureMessage: () => undefined },
      email: createAgentTurnHealthEmailer({
        postmark: POSTMARK,
        ownerEmail: OWNER,
        disabled: false,
        client: recordingClient(mailed, { tick: 0, at: NOW }),
      }),
      nowFn: () => NOW,
    });
    const pending = {
      breaching: false,
      pendingSince: new Date(NOW - 60 * MIN).toISOString(),
      status: 'breach',
    };
    await handlers.get(AGENT_TURN_HEALTH_WATCHDOG_JOB_TYPE)!(
      jobRow(
        { state: { failedTicks: 0, signals: { conflict_rate_high: pending } } },
        new Date(NOW),
      ),
    );
    expect(mailed).toEqual([]);
  });
});
