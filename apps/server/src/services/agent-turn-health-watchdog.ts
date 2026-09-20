// The AI automation's health, evaluated where production can actually see it.
//
// docs/runbooks/agent-turn-monitoring.md names the conditions worth an alert
// and gives them as PromQL. In production none of that PromQL runs: there is no
// METRICS_SCRAPE_TOKEN, `/metrics` does not exist, and no Prometheus or
// Alertmanager is on the box (measured 2026-09-18), so every rule in
// ops/alerts is inert. Sentry IS live. This job evaluates the same conditions
// from the `agent_turn_telemetry` table, over the same windows and thresholds,
// and reports them through Sentry AND by email to the project owner (see
// agent-turn-health-email.ts for why Sentry alone tells nobody).
//
// WHY THE DATABASE and not the in-process counters: those reset on every
// deploy and belong to one process, so "6 hours of turns" would mean "turns
// since the last deploy, on whichever process ran this tick". The table is the
// one record that is complete, shared and survives restarts.
//
// WHAT IT CANNOT SEE — condition 4, telemetry writes failing. A failed write
// leaves no row, so the table cannot report its own gaps. The only count is the
// metrics registry's `driftstack_agent_turn_telemetry_write_total`, and that is
// not usable here: the registry does not exist without METRICS_SCRAPE_TOKEN
// (i.e. in production today), its counter is per process and resets on deploy,
// and this job's ticks may land on any process, so a delta between two ticks
// is not a quantity. Out of scope; the runbook says so. Until a scraper exists,
// write failures are visible only as the writer's warn line
// ('agent turn telemetry failed; the turn was not affected').
//
// ALERTING SHAPE. One Sentry issue per condition (a fixed fingerprint), an
// event on the transition INTO breach, a reminder at most every
// AGENT_TURN_HEALTH_RENOTIFY_MS while it persists, and a `recovered` event
// once it has stopped crossing — back under the threshold, or below the volume
// floor — for the rule's `for:`. Below the floor nothing new ever fires: "not
// enough data" is never a breach.
//
// STATE lives in the job's own payload. The chain re-arms by enqueueing its
// successor, and the successor carries the state forward, so it survives a
// deploy or restart (bootstrap's enqueue is deduplicated against the pending
// row, which keeps its payload), and with several API processes only the one
// that claims the row (FOR UPDATE SKIP LOCKED) runs the tick — they behave as
// one watchdog, not N.
//
// CONTENT-FREE. The aggregates it reads cannot name a customer (see
// db/agent-turn-telemetry-repo.ts), and what it sends is built field by field
// from a closed list: condition, window, counts, rates, thresholds,
// percentiles. Nothing is copied through from the summary wholesale.
//
// EMAIL. Every notice that goes to Sentry is also mailed to the owner, at most
// AGENT_TURN_HEALTH_EMAIL_MAX_PER_HOUR an hour; the spent budget travels in the
// job row with the rest of the state, so a restart neither resets it nor mails
// a transition twice.
//
// IT MUST NEVER HURT THE PRODUCT. Every query is cancelled at a deadline and
// every failure is swallowed, logged and counted; a Sentry client that throws
// is caught, and an email is sent last, under its own deadline, with its
// failure swallowed. The only thing that can throw out of the handler is the re-arm
// itself, which is the scheduler's own retry path (as in every other chain).

import type { AgentTurnSummary, AgentTurnSummaryService } from './agent-turn-summary.js';
import type { ProfileAttachmentWindow } from './agent-turn-telemetry.js';
import type { ScheduledJobRow, ScheduledJobsService } from './scheduled-jobs.js';
import type { SentryClient } from '../lib/sentry.js';

export const AGENT_TURN_HEALTH_WATCHDOG_JOB_TYPE = 'agent_turn.health_watchdog';

/**
 * Five minutes. The shortest `for:` is 15 minutes and the narrowest window 30,
 * so a condition that has held for its `for:` is reported at most five minutes
 * later than Prometheus would have — well inside either. Each tick is three summaries (one per
 * window), each five index range scans on `occurred_at` over at most six hours
 * of rows: at tens of turns a day that is nothing, and at a thousand an hour it
 * is still a few thousand rows sorted once per five minutes. Faster would add
 * load and no information; slower would lag the 30-minute window badly.
 */
export const AGENT_TURN_HEALTH_WATCHDOG_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Six hours between reminders while one condition stays in breach. The widest
 * window is six hours, so a reminder means a whole fresh window has gone by
 * still breaching; more often and the issue's event count turns into noise
 * that teaches everyone to mute it.
 */
export const AGENT_TURN_HEALTH_RENOTIFY_MS = 6 * 60 * 60 * 1000;

/**
 * Each window's summary must answer within this, and is CANCELLED in Postgres
 * at this age (a per-transaction statement_timeout), not merely abandoned: an
 * abandoned query would keep its pool connection into the next tick while
 * request-path queries queue behind it. The three windows run one after
 * another, so the watchdog holds at most one connection at a time and a tick
 * is bounded by three deadlines (90 s), inside the scheduler's 5-minute
 * stale-lock window — it is never claimed and run a second time.
 */
export const AGENT_TURN_HEALTH_EVALUATION_DEADLINE_MS = 30_000;

/**
 * Consecutive ticks with a failed evaluation before the watchdog reports that
 * it is blind. Three ticks is fifteen minutes: one failed query during a deploy
 * is not news, a watchdog that has seen nothing for a quarter of an hour is.
 */
export const AGENT_TURN_HEALTH_BLIND_AFTER_TICKS = 3;

/**
 * At most this many alert emails in any rolling hour, across every condition.
 * The watchdog's own clocks already bound a condition to about two breaches and
 * two recoveries an hour, but four signals flapping together could still fill
 * an inbox; six covers a real incident (three conditions breaching at once, then
 * recovering) and caps the worst case at 144 a day. Emails over the limit are
 * held back — Sentry and the log still get every notice — and the next email
 * that goes out says how many were held.
 */
export const AGENT_TURN_HEALTH_EMAIL_MAX_PER_HOUR = 6;
const EMAIL_RATE_WINDOW_MS = 60 * 60 * 1000;

/**
 * Each email must be handed to Postmark within this. The emails of one tick go
 * out together, so a hung Postmark costs a tick ten seconds, which with the
 * three evaluation deadlines still sits well inside the scheduler's 5-minute
 * stale-lock window.
 */
export const AGENT_TURN_HEALTH_EMAIL_DEADLINE_MS = 10_000;

/** The conditions read from the per-request diagnostics table. */
export const AGENT_TURN_SUMMARY_CONDITIONS = [
  'completion_rate_low',
  'conflict_rate_high',
  'first_progress_slow',
] as const;
export type AgentTurnSummaryCondition = (typeof AGENT_TURN_SUMMARY_CONDITIONS)[number];

/**
 * `no_profile_attached` is the fourth, and it is not read from the table.
 *
 * ⛔ IT IS A CONFIGURATION ALERT, NOT A DETECTABILITY VERDICT. The device
 * reports, on every click and every typed step, whether a BEHAVIOUR PROFILE WAS
 * ATTACHED to the session (`persona != nil`). A session acting with none is
 * misconfigured, and the misconfiguration leaves NO other trace: the step
 * succeeds, the customer's task finishes, the turn is `completed`, and none of
 * the three conditions above can see it because every one of them is a rate
 * over outcomes. What this does NOT say is that such an action looked
 * mechanical, or that a profile being attached made it undetectable — the flag
 * is necessary and not sufficient, and nothing here measures what the device
 * then did.
 *
 * ⛔ WHERE ITS NUMBERS COME FROM, AND WHAT THAT COSTS. `agent_turn_telemetry`
 * has no column for these counts and its text columns are CHECK-constrained
 * closed lists, so carrying them there is a migration — which this change does
 * not make. The watchdog instead reads the IN-PROCESS window the turn's
 * `agent_turn_action_paths` log line is written from (see
 * ProfileAttachmentWindow in agent-turn-telemetry.ts): the same numbers, from
 * the same place, one tick later. That window belongs to ONE process and starts
 * empty after a deploy, and the tick runs on whichever process claims the job
 * row — production runs one API process today, so today it sees every turn.
 * The error is ONE-SIDED: a turn it cannot see is a MISSED alert, never a false
 * one, and the log line still carries the counts for an operator to grep (the
 * runbook gives the command). A scraper, or a column, replaces this.
 */
export const AGENT_TURN_HEALTH_CONDITIONS = [
  ...AGENT_TURN_SUMMARY_CONDITIONS,
  'no_profile_attached',
] as const;
export type AgentTurnHealthCondition = (typeof AGENT_TURN_HEALTH_CONDITIONS)[number];

export interface AgentTurnAlertRule {
  /** The Prometheus alert of the same meaning in ops/alerts/driftstack.yml. */
  readonly alert: string;
  readonly windowMinutes: number;
  /** Samples the window must hold before the condition is judged at all (the
   *  PromQL `and … >= N`). Below it the answer is "not enough data". */
  readonly minSamples: number;
  /** Breach when the measured value is strictly on this side of `threshold`,
   *  as the PromQL `<` / `>` is strict. */
  readonly breachWhen: 'below' | 'above';
  readonly threshold: number;
  /** `count` is a plain number of events in the window, not a rate: the rule
   *  breaches on the FIRST one, so there is nothing to normalise. */
  readonly unit: 'ratio' | 'ms' | 'count';
  /** The rule's `for:` — how long the condition must hold, tick after tick,
   *  before it is a breach. A single bad tick is flapping, not an incident. */
  readonly forMinutes: number;
}

/**
 * THE thresholds. The runbook's PromQL, ops/alerts/driftstack.yml and this
 * watchdog all state the same numbers, and
 * `agent-turn-health-watchdog-runbook-parity.test.ts` reads each one out of the
 * runbook and compares — so the two cannot drift. Deliberately not
 * configurable by environment: one truth, and a threshold changed in one place
 * only would make the watchdog and the runbook disagree about what "breach"
 * means.
 */
export const AGENT_TURN_ALERT_RULES: Readonly<
  Record<AgentTurnHealthCondition, AgentTurnAlertRule>
> = {
  completion_rate_low: {
    alert: 'AgentTurnCompletionRateLow',
    windowMinutes: 6 * 60,
    minSamples: 10,
    breachWhen: 'below',
    threshold: 0.5,
    unit: 'ratio',
    forMinutes: 30,
  },
  conflict_rate_high: {
    alert: 'AgentTurnConflictRateHigh',
    windowMinutes: 60,
    minSamples: 10,
    breachWhen: 'above',
    threshold: 0.1,
    unit: 'ratio',
    forMinutes: 15,
  },
  first_progress_slow: {
    alert: 'AgentTurnFirstProgressSlow',
    windowMinutes: 30,
    minSamples: 10,
    breachWhen: 'above',
    threshold: 5000,
    unit: 'ms',
    forMinutes: 15,
  },
  no_profile_attached: {
    alert: 'AgentActionNoProfileAttached',
    windowMinutes: 30,
    // ⛔ THE FLOOR IS ONE ACTION, NOT TEN. Every other rule here is a RATE, and
    // a rate over a handful of turns is noise — hence their floors. This one
    // counts events, and one action by a session with no behaviour profile
    // attached is the whole finding. The floor exists only so that a window with
    // no AI action in it answers "not enough data" instead of "none, so all is
    // well".
    minSamples: 1,
    breachWhen: 'above',
    // Zero, and strict: the first such action breaches. There is no acceptable
    // share of AI sessions running unconfigured.
    threshold: 0,
    unit: 'count',
    // No hold. The other three wait out a `for:` because a rate at tens of
    // requests crosses its threshold on one unlucky customer; this is a count
    // of a configuration that must never happen, and waiting to be sure of it
    // only delays the news. Recovery uses the same clock, so it clears as soon
    // as the last such action has aged out of the window.
    forMinutes: 0,
  },
};

/** A condition, or the watchdog's own blindness. */
export type AgentTurnHealthSignal = AgentTurnHealthCondition | 'evaluation_failing';
const SIGNALS: readonly AgentTurnHealthSignal[] = [
  ...AGENT_TURN_HEALTH_CONDITIONS,
  'evaluation_failing',
];

export type AgentTurnHealthStatus = 'ok' | 'breach' | 'insufficient_data' | 'unavailable';
const STATUSES: readonly AgentTurnHealthStatus[] = [
  'ok',
  'breach',
  'insufficient_data',
  'unavailable',
];

/** Numbers only. Every key a reading or notice can carry is listed here, and
 *  the content-free test holds the payload to this list. */
export interface AgentTurnHealthFigures {
  samples?: number;
  value?: number | null;
  completed?: number;
  busy_409?: number;
  conflict_409?: number;
  p50_ms?: number | null;
  p95_ms?: number | null;
  consecutive_failed_ticks?: number;
  /** Actions by a session with no behaviour profile attached, by verb. Counts
   *  by verb and nothing else — no selector, no page, no session. */
  no_profile_click?: number;
  no_profile_send_keys?: number;
}

/** The exact span a reading was computed over, as ISO timestamps. Carried to
 *  the alert so an operator can reproduce the numbers that fired: the admin
 *  page's window is anchored at the moment it is opened, not at the tick. */
export interface AgentTurnHealthWindow {
  since: string | null;
  until: string | null;
}

export interface AgentTurnHealthReading {
  condition: AgentTurnHealthCondition;
  status: AgentTurnHealthStatus;
  figures: AgentTurnHealthFigures;
  window?: AgentTurnHealthWindow;
}

// ── reading one condition off a summary ────────────────────────────────────

/**
 * Judge one condition against the summary of its window. Pure.
 *
 * The figures are the SAME ones the admin page shows for that window (the
 * summary is shared, not re-derived), so the watchdog and the page cannot
 * disagree about a number.
 */
export function readAgentTurnHealthCondition(
  condition: AgentTurnSummaryCondition,
  summary: AgentTurnSummary,
): AgentTurnHealthReading {
  const rule = AGENT_TURN_ALERT_RULES[condition];
  let samples: number;
  let value: number | null;
  let figures: AgentTurnHealthFigures;
  switch (condition) {
    case 'completion_rate_low':
      samples = summary.turns.decided;
      value = summary.turns.completion_rate;
      figures = { completed: summary.turns.completed };
      break;
    case 'conflict_rate_high':
      // Every persisted request is the denominator — the PromQL's
      // `outcome!~"replayed|manual_note"`, since neither of those is written.
      samples = summary.requests.total;
      value = summary.conflicts.rate_409;
      figures = {
        busy_409: summary.conflicts.busy_409,
        conflict_409: summary.conflicts.conflict_409,
      };
      break;
    case 'first_progress_slow': {
      const stream = summary.durations_ms.time_to_first_progress.stream;
      samples = summary.durations_ms.time_to_first_progress.stream_samples;
      value = stream.p95;
      figures = { p50_ms: stream.p50, p95_ms: stream.p95 };
      break;
    }
    default: {
      const unreachable: never = condition;
      throw new Error(`unknown agent turn health condition: ${String(unreachable)}`);
    }
  }
  figures = { samples, value, ...figures };
  // Re-serialised, not copied: only a well-formed timestamp leaves.
  const window = { since: isoOrNull(summary.window.since), until: isoOrNull(summary.window.until) };
  if (samples < rule.minSamples || value === null) {
    return { condition, status: 'insufficient_data', figures, window };
  }
  const breaching = rule.breachWhen === 'below' ? value < rule.threshold : value > rule.threshold;
  return { condition, status: breaching ? 'breach' : 'ok', figures, window };
}

/**
 * Judge the fourth condition — an AI action performed by a session with NO
 * behaviour profile attached. Pure.
 *
 * `samples` is every AI action the window saw, so a window with no AI action in
 * it is `insufficient_data` rather than a clean bill of health: at production's
 * volume (zero AI turns when this was written) that is the usual state, and
 * "none happened" must not read as "all of them were configured".
 *
 * ⛔ SCROLLS ARE NOT IN IT. The device picks the scroll implementation with the
 * SAME predicate, so counting a segmented scroll here would count one fact
 * twice and make a single misconfiguration look like two findings.
 */
export function readNoProfileAttachedCondition(
  reading: {
    samples: number;
    unprofiled: number;
    byVerb: { click: number; send_keys: number };
  },
  window: AgentTurnHealthWindow,
): AgentTurnHealthReading {
  const rule = AGENT_TURN_ALERT_RULES.no_profile_attached;
  const figures: AgentTurnHealthFigures = {
    samples: reading.samples,
    value: reading.unprofiled,
    no_profile_click: reading.byVerb.click,
    no_profile_send_keys: reading.byVerb.send_keys,
  };
  if (reading.samples < rule.minSamples) {
    return { condition: 'no_profile_attached', status: 'insufficient_data', figures, window };
  }
  return {
    condition: 'no_profile_attached',
    status: reading.unprofiled > rule.threshold ? 'breach' : 'ok',
    figures,
    window,
  };
}

// ── evaluating every condition ─────────────────────────────────────────────

function withDeadline<T>(
  work: Promise<T>,
  ms: number,
  what = 'agent turn health evaluation',
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  // A late rejection after the deadline must not surface as an unhandled one.
  work.catch(() => undefined);
  return Promise.race([
    work,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`${what} exceeded ${String(ms)}ms`));
      }, ms);
      timer.unref();
    }),
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

export interface AgentTurnHealthLogger {
  info?: (obj: Record<string, unknown>, msg: string) => void;
  warn?: (obj: Record<string, unknown>, msg: string) => void;
  error?: (obj: Record<string, unknown>, msg: string) => void;
}

function errorShape(err: unknown): { name: string; message: string } {
  return err instanceof Error
    ? { name: err.name, message: err.message }
    : { name: 'non_error', message: String(err) };
}

/**
 * One summary per distinct window, each under its own deadline, ONE AT A TIME:
 * three windows in parallel would each open their queries at once and could
 * take a third of the pool on a slow database. A window whose query fails or
 * times out makes ITS conditions `unavailable` and leaves the others judged.
 * Never rejects.
 */
export async function evaluateAgentTurnHealth(deps: {
  summary: Pick<AgentTurnSummaryService, 'summarize'>;
  /** Where the fourth condition's numbers come from. Absent — not wired, or a
   *  deployment without it — makes that condition `unavailable`, which holds
   *  every clock: no evidence either way, never a clean bill of health. */
  profileAttachmentWindow?: ProfileAttachmentWindow;
  now?: () => number;
  deadlineMs?: number;
  logger?: AgentTurnHealthLogger;
}): Promise<AgentTurnHealthReading[]> {
  const deadline = deps.deadlineMs ?? AGENT_TURN_HEALTH_EVALUATION_DEADLINE_MS;
  const byWindow = new Map<number, AgentTurnSummary | null>();
  for (const condition of AGENT_TURN_SUMMARY_CONDITIONS) {
    const minutes = AGENT_TURN_ALERT_RULES[condition].windowMinutes;
    if (byWindow.has(minutes)) continue;
    byWindow.set(
      minutes,
      await withDeadline(
        // Wrapped so a summarize() that throws synchronously is a rejection.
        // The database cancels the queries at the deadline; the race is the
        // backstop for time spent waiting for a pool connection, which a
        // statement timeout does not cover.
        Promise.resolve().then(() =>
          deps.summary.summarize(minutes / 60, { statementTimeoutMs: deadline }),
        ),
        deadline,
      ).catch((err: unknown) => {
        deps.logger?.warn?.(
          {
            component: 'agent-turn-health',
            event: 'agent_turn_health_evaluation_failed',
            window_minutes: minutes,
            err: errorShape(err),
          },
          'agent turn health: could not read a window; its conditions are unevaluated this tick',
        );
        return null;
      }),
    );
  }
  const readings: AgentTurnHealthReading[] = [];
  for (const condition of AGENT_TURN_SUMMARY_CONDITIONS) {
    const summary = byWindow.get(AGENT_TURN_ALERT_RULES[condition].windowMinutes);
    if (summary === null || summary === undefined) {
      readings.push({ condition, status: 'unavailable', figures: {} });
      continue;
    }
    try {
      readings.push(readAgentTurnHealthCondition(condition, summary));
    } catch (err) {
      // A malformed summary is a bug, but not one that may stop the others.
      deps.logger?.warn?.(
        {
          component: 'agent-turn-health',
          event: 'agent_turn_health_evaluation_failed',
          condition,
          err: errorShape(err),
        },
        'agent turn health: could not judge a condition this tick',
      );
      readings.push({ condition, status: 'unavailable', figures: {} });
    }
  }
  readings.push(readProfileAttachment(deps));
  return readings;
}

/**
 * The fourth condition, read from the in-process window. Never throws: a reader
 * that misbehaves makes the condition `unavailable`, which holds its clocks,
 * exactly as an unreadable database window does for the other three.
 */
function readProfileAttachment(deps: {
  profileAttachmentWindow?: ProfileAttachmentWindow;
  now?: () => number;
  logger?: AgentTurnHealthLogger;
}): AgentTurnHealthReading {
  const source = deps.profileAttachmentWindow;
  if (source === undefined) {
    return { condition: 'no_profile_attached', status: 'unavailable', figures: {} };
  }
  const minutes = AGENT_TURN_ALERT_RULES.no_profile_attached.windowMinutes;
  try {
    const until = new Date((deps.now ?? Date.now)());
    const reading = source.since(minutes, until.getTime());
    return readNoProfileAttachedCondition(reading, {
      since: new Date(until.getTime() - minutes * 60_000).toISOString(),
      until: until.toISOString(),
    });
  } catch (err) {
    deps.logger?.warn?.(
      {
        component: 'agent-turn-health',
        event: 'agent_turn_health_evaluation_failed',
        condition: 'no_profile_attached',
        err: errorShape(err),
      },
      'agent turn health: could not judge a condition this tick',
    );
    return { condition: 'no_profile_attached', status: 'unavailable', figures: {} };
  }
}

// ── state carried from tick to tick ────────────────────────────────────────

export interface AgentTurnHealthSignalState {
  breaching: boolean;
  /** When the current breach began (ISO), null when not breaching. */
  since: string | null;
  /** When the value first crossed the threshold in the current unbroken run
   *  of crossing ticks — the `for:` clock. Null when not crossing. */
  pendingSince: string | null;
  /** While breaching: when the value first stopped crossing (ok or below the
   *  floor) in the current unbroken run of such ticks — the recovery clock,
   *  which must also run for the rule's `for:` before `recovered` is sent.
   *  Null when not breaching, or when the latest verdict was a breach. */
  clearingSince: string | null;
  lastNotifiedAt: string | null;
  /** Last status seen, so a CHANGE of status is logged once, not every tick. */
  status: AgentTurnHealthStatus | null;
}

/** The alert-email rate limit, carried in the job row like everything else so
 *  a deploy neither resets the budget nor re-sends what was already sent. */
export interface AgentTurnHealthEmailState {
  /** When each email of the last hour was handed over (ISO), oldest first. */
  sentAt: string[];
  /** Emails held back by the limit since the last one that went out. */
  withheld: number;
}

export interface AgentTurnHealthState {
  /** Consecutive ticks in which at least one window could not be read. */
  failedTicks: number;
  signals: Partial<Record<AgentTurnHealthSignal, AgentTurnHealthSignalState>>;
  /** Absent until alert email has first been planned. */
  email?: AgentTurnHealthEmailState;
}

export const INITIAL_AGENT_TURN_HEALTH_STATE: AgentTurnHealthState = {
  failedTicks: 0,
  signals: {},
};

function isoOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * Read the state back out of a job payload. The payload is a database row, so
 * it is parsed as untrusted: only known keys, only the right types, dates
 * re-serialised. Anything else — including a row written by an older version —
 * reads as "nothing breaching", whose worst case is one repeated breach event.
 */
export function parseAgentTurnHealthState(payload: unknown): AgentTurnHealthState {
  const root = (payload as { state?: unknown } | null | undefined)?.state;
  if (root === null || typeof root !== 'object') return INITIAL_AGENT_TURN_HEALTH_STATE;
  const raw = root as { failedTicks?: unknown; signals?: unknown };
  const failedTicks =
    typeof raw.failedTicks === 'number' && Number.isInteger(raw.failedTicks) && raw.failedTicks > 0
      ? Math.min(raw.failedTicks, 1_000_000)
      : 0;
  const signals: AgentTurnHealthState['signals'] = {};
  const rawSignals =
    raw.signals !== null && typeof raw.signals === 'object'
      ? (raw.signals as Record<string, unknown>)
      : {};
  for (const signal of SIGNALS) {
    const s = rawSignals[signal];
    if (s === null || typeof s !== 'object') continue;
    const r = s as Record<string, unknown>;
    const breaching = r['breaching'] === true;
    const status = STATUSES.find((st) => st === r['status']) ?? null;
    signals[signal] = {
      breaching,
      since: breaching ? isoOrNull(r['since']) : null,
      pendingSince: isoOrNull(r['pendingSince']),
      clearingSince: breaching ? isoOrNull(r['clearingSince']) : null,
      lastNotifiedAt: isoOrNull(r['lastNotifiedAt']),
      status,
    };
  }
  const email = parseEmailState((raw as { email?: unknown }).email);
  return email === null ? { failedTicks, signals } : { failedTicks, signals, email };
}

function parseEmailState(raw: unknown): AgentTurnHealthEmailState | null {
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as { sentAt?: unknown; withheld?: unknown };
  const sentAt = (Array.isArray(r.sentAt) ? (r.sentAt as unknown[]) : [])
    .map(isoOrNull)
    .filter((v): v is string => v !== null)
    .sort()
    // Only the newest can still count against the limit.
    .slice(-AGENT_TURN_HEALTH_EMAIL_MAX_PER_HOUR);
  const withheld =
    typeof r.withheld === 'number' && Number.isInteger(r.withheld) && r.withheld > 0
      ? Math.min(r.withheld, 1_000_000)
      : 0;
  return { sentAt, withheld };
}

/**
 * Which of this tick's notices may be emailed. Pure. The first `send` notices
 * are emailed, the rest held back; `withheldBefore` is the count the first
 * email should report. The returned state is persisted with the re-arm BEFORE
 * anything is sent, so the budget is spent at most once per notice even when a
 * process dies mid-send.
 */
export function planAgentTurnHealthEmails(
  prev: AgentTurnHealthEmailState | undefined,
  noticeCount: number,
  now: Date,
): { send: number; withheld: number; withheldBefore: number; next: AgentTurnHealthEmailState } {
  const nowMs = now.getTime();
  const recent = (prev?.sentAt ?? []).filter((iso) => {
    const t = Date.parse(iso);
    return Number.isFinite(t) && nowMs - t < EMAIL_RATE_WINDOW_MS;
  });
  const budget = Math.max(0, AGENT_TURN_HEALTH_EMAIL_MAX_PER_HOUR - recent.length);
  const send = Math.min(budget, noticeCount);
  const withheld = noticeCount - send;
  const withheldBefore = prev?.withheld ?? 0;
  return {
    send,
    withheld,
    withheldBefore,
    next: {
      sentAt: [...recent, ...Array.from({ length: send }, () => now.toISOString())],
      withheld: send > 0 ? withheld : withheldBefore + withheld,
    },
  };
}

// ── transitions ────────────────────────────────────────────────────────────

export type AgentTurnHealthTransition = 'breach' | 'still_breaching' | 'recovered';

/** What ended a breach: the value came back under the threshold, or traffic
 *  fell below the volume floor and there has been no verdict since. */
export type AgentTurnHealthClearedBy = 'ok' | 'insufficient_data';

export interface AgentTurnHealthNotice {
  signal: AgentTurnHealthSignal;
  transition: AgentTurnHealthTransition;
  /** ISO time the breach began. */
  breaching_since: string | null;
  figures: AgentTurnHealthFigures;
  /** The span the figures were computed over; absent for the blind signal. */
  window?: AgentTurnHealthWindow;
  /** Set on `recovered` only. */
  cleared_by?: AgentTurnHealthClearedBy;
}

export interface AgentTurnHealthStatusChange {
  signal: AgentTurnHealthSignal;
  from: AgentTurnHealthStatus | null;
  to: AgentTurnHealthStatus;
  figures: AgentTurnHealthFigures;
}

/**
 * Move every signal one tick forward. Pure.
 *
 *   ok → crossing                  pending: the rule's `for:` clock starts
 *   crossing for `for:` or longer  `breach` notice
 *   breach → breach                `still_breaching`, at most every RENOTIFY_MS
 *   breach → ok or below floor     clearing: the recovery clock starts. A
 *                                  breaching tick stops it again
 *   clearing for `for:` or longer  `recovered` notice, naming what cleared it
 *   not breaching, below floor     no transition, and the pending `for:` clock
 *                                  resets, as it does in Prometheus when the
 *                                  floor's `and` empties the vector
 *   anything → unavailable         no transition, every clock held: a failed
 *                                  query says nothing about the AI turns
 *
 * WHY below the floor clears a breach. Prometheus resolves a firing alert as
 * soon as the floor empties the vector. Holding the breach instead would keep
 * it open indefinitely at today's volume (a burst, then quiet), and a lone
 * crossing tick days later would then skip the `for:` hold and report a
 * days-old incident. WHY the recovery waits for `for:` (Prometheus does not):
 * at tens of requests a single request moves a rate across the threshold, and
 * clearing on one tick would turn a rate sitting on the line into a
 * breach/recovered pair every twenty minutes.
 *
 * The watchdog's own blindness is a fourth signal on the same machinery:
 * breaching after BLIND_AFTER_TICKS consecutive failed ticks, clear on the
 * first fully-read tick.
 */
export function advanceAgentTurnHealth(
  prev: AgentTurnHealthState,
  readings: readonly AgentTurnHealthReading[],
  now: Date,
): {
  next: AgentTurnHealthState;
  notices: AgentTurnHealthNotice[];
  statusChanges: AgentTurnHealthStatusChange[];
} {
  const nowIso = now.toISOString();
  const nowMs = now.getTime();
  // ⛔ BLINDNESS IS ABOUT THE TABLE, AND ONLY THE TABLE. `evaluation_failing`
  // says the watchdog could not READ the AI turn records; it is what stops a
  // silent watchdog being mistaken for a healthy product. `no_profile_attached`
  // reads somewhere else entirely (see AGENT_TURN_HEALTH_CONDITIONS), so its
  // `unavailable` — a deployment where that source is not wired — is a fact
  // about that one condition and must not be reported as the watchdog going
  // blind. Counting it did exactly that: three ticks after boot, a watchdog
  // reading every window perfectly would have paged that it could see nothing.
  const anyUnavailable = readings.some(
    (r) =>
      r.status === 'unavailable' &&
      (AGENT_TURN_SUMMARY_CONDITIONS as readonly AgentTurnHealthCondition[]).includes(r.condition),
  );
  const failedTicks = anyUnavailable ? prev.failedTicks + 1 : 0;

  const blindStatus: AgentTurnHealthStatus = !anyUnavailable
    ? 'ok'
    : failedTicks >= AGENT_TURN_HEALTH_BLIND_AFTER_TICKS
      ? 'breach'
      : // Failing, but not yet for long enough to say so: hold, like a
        // condition under its floor.
        'insufficient_data';
  const all: Array<{
    signal: AgentTurnHealthSignal;
    status: AgentTurnHealthStatus;
    figures: AgentTurnHealthFigures;
    window?: AgentTurnHealthWindow;
  }> = [
    ...readings.map((r) => ({
      signal: r.condition,
      status: r.status,
      figures: r.figures,
      ...(r.window === undefined ? {} : { window: r.window }),
    })),
    {
      signal: 'evaluation_failing',
      status: blindStatus,
      figures: { consecutive_failed_ticks: failedTicks },
    },
  ];

  const signals: AgentTurnHealthState['signals'] = { ...prev.signals };
  const notices: AgentTurnHealthNotice[] = [];
  const statusChanges: AgentTurnHealthStatusChange[] = [];
  for (const { signal, status, figures, window } of all) {
    const before = prev.signals[signal] ?? {
      breaching: false,
      since: null,
      lastNotifiedAt: null,
      pendingSince: null,
      clearingSince: null,
      status: null,
    };
    const after: AgentTurnHealthSignalState = { ...before, status };
    if (before.status !== status) {
      statusChanges.push({ signal, from: before.status, to: status, figures });
    }
    const forMs = (signalRule(signal)?.forMinutes ?? 0) * 60_000;
    const context = window === undefined ? {} : { window };
    /** Not crossing (ok, or no verdict below the floor): no pending breach,
     *  and a current breach runs its recovery clock. */
    const clearing = (clearedBy: AgentTurnHealthClearedBy): void => {
      after.pendingSince = null;
      if (!before.breaching) return;
      const clearingSince = before.clearingSince ?? nowIso;
      after.clearingSince = clearingSince;
      if (nowMs - Date.parse(clearingSince) < forMs) return;
      after.breaching = false;
      after.since = null;
      after.clearingSince = null;
      after.lastNotifiedAt = nowIso;
      notices.push({
        signal,
        transition: 'recovered',
        breaching_since: before.since,
        figures,
        ...context,
        cleared_by: clearedBy,
      });
    };
    switch (status) {
      case 'breach':
        if (!before.breaching) {
          const pendingSince = before.pendingSince ?? nowIso;
          after.pendingSince = pendingSince;
          if (nowMs - Date.parse(pendingSince) < forMs) break;
          after.breaching = true;
          after.since = nowIso;
          after.clearingSince = null;
          after.lastNotifiedAt = nowIso;
          notices.push({
            signal,
            transition: 'breach',
            breaching_since: nowIso,
            figures,
            ...context,
          });
        } else {
          // Crossing again stops the recovery clock: it must run unbroken.
          after.clearingSince = null;
          const last = before.lastNotifiedAt === null ? NaN : Date.parse(before.lastNotifiedAt);
          if (!Number.isFinite(last) || nowMs - last >= AGENT_TURN_HEALTH_RENOTIFY_MS) {
            after.lastNotifiedAt = nowIso;
            notices.push({
              signal,
              transition: 'still_breaching',
              breaching_since: before.since,
              figures,
              ...context,
            });
          }
        }
        break;
      case 'ok':
        clearing('ok');
        break;
      case 'insufficient_data':
        clearing('insufficient_data');
        break;
      case 'unavailable':
        // No verdict and no evidence either way: everything is held.
        break;
      default: {
        const unreachable: never = status;
        void unreachable;
      }
    }
    signals[signal] = after;
  }
  return {
    // The email budget is not the business of the conditions: carried as is.
    next:
      prev.email === undefined
        ? { failedTicks, signals }
        : { failedTicks, signals, email: prev.email },
    notices,
    statusChanges,
  };
}

// ── delivery ───────────────────────────────────────────────────────────────

/** One Sentry issue per condition for its breaches and reminders; its
 *  recoveries group into a second, separate issue, so a `recovered` event
 *  cannot reopen (regress) a breach issue someone has resolved. */
export function agentTurnHealthFingerprint(
  signal: AgentTurnHealthSignal,
  transition: AgentTurnHealthTransition,
): string[] {
  return transition === 'recovered'
    ? ['agent-turn-health', signal, 'recovered']
    : ['agent-turn-health', signal];
}

function signalRule(signal: AgentTurnHealthSignal): AgentTurnAlertRule | null {
  return signal === 'evaluation_failing' ? null : AGENT_TURN_ALERT_RULES[signal];
}

const FIGURE_KEYS: ReadonlyArray<keyof AgentTurnHealthFigures> = [
  'samples',
  'value',
  'completed',
  'busy_409',
  'conflict_409',
  'p50_ms',
  'p95_ms',
  'consecutive_failed_ticks',
  'no_profile_click',
  'no_profile_send_keys',
];

/** The figures, by the closed key list, numbers only. The type already says
 *  "numbers", but a type is erased at runtime; everything that leaves the
 *  process (Sentry and the log alike) goes through this filter instead of a
 *  spread, so a string that ever reached a figure would still stop here. */
function numericFigures(f: AgentTurnHealthFigures): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const key of FIGURE_KEYS) {
    const v: unknown = f[key];
    if (v === undefined) continue;
    out[key] = typeof v === 'number' && Number.isFinite(v) ? v : null;
  }
  return out;
}

/**
 * The whole alert, built key by key from closed vocabularies and numbers.
 * Exported so the content-free test can inspect exactly what leaves.
 */
export function agentTurnHealthPayload(notice: AgentTurnHealthNotice): {
  message: string;
  level: 'info' | 'warning';
  fingerprint: string[];
  tags: Record<string, string>;
  extra: Record<string, string | number | null>;
} {
  const rule = signalRule(notice.signal);
  const name = rule?.alert ?? 'AgentTurnHealthWatchdogBlind';
  const extra: Record<string, string | number | null> = {
    condition: notice.signal,
    transition: notice.transition,
    // Re-serialised on the way out as well: only a timestamp, never a string
    // that happened to reach the field.
    breaching_since: isoOrNull(notice.breaching_since),
  };
  if (notice.window !== undefined) {
    extra['window_since'] = isoOrNull(notice.window.since);
    extra['window_until'] = isoOrNull(notice.window.until);
  }
  if (notice.cleared_by !== undefined) {
    // Closed vocabulary, checked at runtime rather than trusted from the type.
    extra['cleared_by'] = notice.cleared_by === 'insufficient_data' ? 'insufficient_data' : 'ok';
  }
  if (rule !== null) {
    extra['window_minutes'] = rule.windowMinutes;
    extra['min_samples'] = rule.minSamples;
    extra['threshold'] = rule.threshold;
    extra['breach_when'] = rule.breachWhen;
    extra['unit'] = rule.unit;
    extra['for_minutes'] = rule.forMinutes;
  } else {
    extra['threshold'] = AGENT_TURN_HEALTH_BLIND_AFTER_TICKS;
    extra['unit'] = 'ticks';
  }
  Object.assign(extra, numericFigures(notice.figures));
  return {
    message: `AI turns: ${name} ${notice.transition}`,
    level: notice.transition === 'recovered' ? 'info' : 'warning',
    fingerprint: agentTurnHealthFingerprint(notice.signal, notice.transition),
    tags: {
      component: 'agent-turn-health',
      condition: notice.signal,
      transition: notice.transition,
    },
    extra,
  };
}

// ── the job ────────────────────────────────────────────────────────────────

/** Counted per process since boot. Not a metric (production has no scraper):
 *  every line the watchdog logs about a failure or a notice carries the
 *  running totals, so an operator reads them from the logs. */
export interface AgentTurnHealthWatchdogStats {
  ticks: number;
  /** Ticks in which at least one window could not be read. */
  failedTicks: number;
  /** Sentry calls that threw (the client swallows its own; this is a client
   *  that misbehaved). */
  deliveryFailures: number;
  noticesSent: number;
  /** Alert emails handed to Postmark. */
  emailsSent: number;
  /** Alert emails that failed or timed out (swallowed). */
  emailFailures: number;
  /** Alert emails held back by AGENT_TURN_HEALTH_EMAIL_MAX_PER_HOUR. */
  emailsWithheld: number;
}

/** Sends one notice to the owner. Throws on failure; the watchdog catches. */
export interface AgentTurnHealthEmailer {
  send(notice: AgentTurnHealthNotice, context: { withheld: number }): Promise<void>;
}

export interface RegisterAgentTurnHealthWatchdogOpts {
  scheduledJobs: ScheduledJobsService;
  summary: Pick<AgentTurnSummaryService, 'summarize'>;
  /** The in-process window the fourth condition reads (see
   *  AGENT_TURN_HEALTH_CONDITIONS for what it can and cannot see). Absent makes
   *  that condition `unavailable` rather than silently healthy. */
  profileAttachmentWindow?: ProfileAttachmentWindow;
  sentry: Pick<SentryClient, 'captureMessage'>;
  /** Null or absent: alert email is off (its factory logged why, once). */
  email?: AgentTurnHealthEmailer | null;
  logger?: AgentTurnHealthLogger;
  nowFn?: () => number;
  deadlineMs?: number;
  emailDeadlineMs?: number;
}

/**
 * The tick when evaluating or advancing threw: every condition unreadable, so
 * the blindness counter moves and fires at BLIND_AFTER_TICKS like any other
 * failed read. If even that throws, the counter is moved by hand — it is the
 * one number that must keep counting when everything else is broken.
 */
function advanceBlind(
  prev: AgentTurnHealthState,
  now: Date,
): ReturnType<typeof advanceAgentTurnHealth> {
  try {
    return advanceAgentTurnHealth(
      prev,
      AGENT_TURN_HEALTH_CONDITIONS.map((condition) => ({
        condition,
        status: 'unavailable' as const,
        figures: {},
      })),
      now,
    );
  } catch {
    return {
      next: { ...prev, failedTicks: prev.failedTicks + 1 },
      notices: [],
      statusChanges: [],
    };
  }
}

export interface AgentTurnHealthWatchdogHandle {
  stats(): AgentTurnHealthWatchdogStats;
}

/**
 * The switched-off watchdog: a handler that completes a leftover pending row
 * WITHOUT re-arming, so turning it off ends the chain cleanly instead of
 * leaving the scheduler to mark an orphan row failed for want of a handler.
 * Deliberately not a `register*Job`: it is the one handler here that must NOT
 * re-arm, and every `register*Job` is held to re-arming on every path.
 */
export function endAgentTurnHealthWatchdogChain(opts: {
  scheduledJobs: ScheduledJobsService;
  logger?: AgentTurnHealthLogger;
}): void {
  opts.scheduledJobs.register(AGENT_TURN_HEALTH_WATCHDOG_JOB_TYPE, () => {
    opts.logger?.info?.(
      { component: 'agent-turn-health', event: 'agent_turn_health_disabled' },
      'agent turn health watchdog is disabled; ending its job chain',
    );
    return Promise.resolve();
  });
  opts.logger?.warn?.(
    { component: 'agent-turn-health' },
    'DRIFTSTACK_DISABLE_AGENT_TURN_HEALTH_WATCHDOG is set — AI turn health is not evaluated and nothing reaches Sentry',
  );
}

/**
 * The handler: evaluate, advance, persist the new state by re-arming, THEN
 * notify.
 *
 * Re-arm before notify: if the re-arm throws, the scheduler retries this job
 * with its OLD payload, and the retry evaluates and notifies afresh — nothing
 * is sent twice. If the re-arm finds a later successor already armed
 * (`enqueued: false`, a duplicate run after a stale lock), that successor's run
 * owns the notices and this one sends none.
 */
export function registerAgentTurnHealthWatchdogJob(
  opts: RegisterAgentTurnHealthWatchdogOpts,
): AgentTurnHealthWatchdogHandle {
  const now = opts.nowFn ?? Date.now;
  const stats: AgentTurnHealthWatchdogStats = {
    ticks: 0,
    failedTicks: 0,
    deliveryFailures: 0,
    noticesSent: 0,
    emailsSent: 0,
    emailFailures: 0,
    emailsWithheld: 0,
  };
  const totals = (): Record<string, number> => ({
    ticks_total: stats.ticks,
    failed_ticks_total: stats.failedTicks,
    delivery_failures_total: stats.deliveryFailures,
    notices_sent_total: stats.noticesSent,
    emails_sent_total: stats.emailsSent,
    email_failures_total: stats.emailFailures,
    emails_withheld_total: stats.emailsWithheld,
  });
  const emailer = opts.email ?? null;
  opts.scheduledJobs.register(AGENT_TURN_HEALTH_WATCHDOG_JOB_TYPE, async (job: ScheduledJobRow) => {
    stats.ticks += 1;
    const prev = parseAgentTurnHealthState(job.payload);
    let next = prev;
    let notices: AgentTurnHealthNotice[] = [];
    let statusChanges: AgentTurnHealthStatusChange[] = [];
    try {
      const readings = await evaluateAgentTurnHealth({
        summary: opts.summary,
        now,
        ...(opts.profileAttachmentWindow !== undefined
          ? { profileAttachmentWindow: opts.profileAttachmentWindow }
          : {}),
        ...(opts.deadlineMs !== undefined ? { deadlineMs: opts.deadlineMs } : {}),
        ...(opts.logger !== undefined ? { logger: opts.logger } : {}),
      });
      const advanced = advanceAgentTurnHealth(prev, readings, new Date(now()));
      next = advanced.next;
      notices = advanced.notices;
      statusChanges = advanced.statusChanges;
      if (next.failedTicks > 0) stats.failedTicks += 1;
    } catch (err) {
      // Defence in depth: evaluate never rejects and advance is pure, so this
      // is a bug. It still counts as a tick that saw nothing: were it to
      // repeat every tick (say, a stored state that trips advance), carrying
      // the old state unchanged would keep the blindness counter at zero and
      // the watchdog would be blind without ever saying so.
      stats.failedTicks += 1;
      opts.logger?.error?.(
        {
          component: 'agent-turn-health',
          event: 'agent_turn_health_tick_failed',
          err: errorShape(err),
          ...totals(),
        },
        'agent turn health tick failed; counted as an unreadable tick',
      );
      ({ next, notices, statusChanges } = advanceBlind(prev, new Date(now())));
    }
    for (const change of statusChanges) {
      opts.logger?.info?.(
        {
          component: 'agent-turn-health',
          event: 'agent_turn_health_status',
          condition: change.signal,
          from: change.from,
          to: change.to,
          ...numericFigures(change.figures),
          ...totals(),
        },
        `agent turn health: ${change.signal} is now ${change.to}`,
      );
    }

    // Decide the emails BEFORE the re-arm, so the spent budget is saved with
    // the rest of the state: a restart, or a retry of this row after a failed
    // re-arm, can then never mail the same transition twice.
    let emailPlan: ReturnType<typeof planAgentTurnHealthEmails> | null = null;
    if (emailer !== null && notices.length > 0) {
      emailPlan = planAgentTurnHealthEmails(next.email, notices.length, new Date(now()));
      next = { ...next, email: emailPlan.next };
    }

    const { enqueued } = await enqueueNextAgentTurnHealthWatchdog({
      scheduledJobs: opts.scheduledJobs,
      nowFn: now,
      currentRunAt: job.runAt,
      state: next,
    });
    if (!enqueued) {
      opts.logger?.warn?.(
        {
          component: 'agent-turn-health',
          event: 'agent_turn_health_successor_exists',
          withheld_notices: notices.length,
        },
        'agent turn health: a later run already armed the chain; its notices are its own',
      );
      return;
    }

    for (const notice of notices) {
      const payload = agentTurnHealthPayload(notice);
      // The structured line is ALWAYS written, so the signal exists where
      // Sentry is not configured (dev, tests, a DSN removed in an incident).
      const line = {
        event: `agent_turn_health_${notice.transition}`,
        ...payload.extra,
        ...totals(),
      };
      if (notice.transition === 'recovered') {
        opts.logger?.info?.({ component: 'agent-turn-health', ...line }, payload.message);
      } else {
        opts.logger?.warn?.({ component: 'agent-turn-health', ...line }, payload.message);
      }
      try {
        opts.sentry.captureMessage(payload);
        stats.noticesSent += 1;
      } catch (err) {
        stats.deliveryFailures += 1;
        opts.logger?.warn?.(
          {
            component: 'agent-turn-health',
            event: 'agent_turn_health_delivery_failed',
            condition: notice.signal,
            err: errorShape(err),
            ...totals(),
          },
          'agent turn health: Sentry delivery failed; the structured line above stands',
        );
      }
    }

    // Email last, so nothing it does can delay or stop the Sentry path.
    if (emailer !== null && emailPlan !== null) {
      const plan = emailPlan;
      if (plan.withheld > 0) {
        stats.emailsWithheld += plan.withheld;
        opts.logger?.warn?.(
          {
            component: 'agent-turn-health',
            event: 'agent_turn_health_email_withheld',
            withheld: plan.withheld,
            max_per_hour: AGENT_TURN_HEALTH_EMAIL_MAX_PER_HOUR,
            ...totals(),
          },
          'agent turn health: alert emails held back by the hourly limit; Sentry and the log have them',
        );
      }
      const deadline = opts.emailDeadlineMs ?? AGENT_TURN_HEALTH_EMAIL_DEADLINE_MS;
      const batch = notices.slice(0, plan.send);
      const results = await Promise.allSettled(
        batch.map((notice, i) =>
          withDeadline(
            // Wrapped so a send() that throws synchronously is a rejection.
            Promise.resolve().then(() =>
              emailer.send(notice, { withheld: i === 0 ? plan.withheldBefore : 0 }),
            ),
            deadline,
            'agent turn health alert email',
          ),
        ),
      );
      results.forEach((result, i) => {
        if (result.status === 'fulfilled') {
          stats.emailsSent += 1;
          return;
        }
        stats.emailFailures += 1;
        opts.logger?.warn?.(
          {
            component: 'agent-turn-health',
            event: 'agent_turn_health_email_failed',
            condition: batch[i]?.signal ?? null,
            transition: batch[i]?.transition ?? null,
            err: errorShape(result.reason),
            ...totals(),
          },
          'agent turn health: alert email failed; Sentry and the structured line stand',
        );
      });
    }
  });
  return { stats: () => ({ ...stats }) };
}

/**
 * Enqueue the next tick, carrying the state. Bootstrap omits `currentRunAt`
 * and dedups against every pending row — so after a restart the pending row,
 * and the state in it, is kept rather than replaced by an empty one. A re-arm
 * passes the running row's `runAt` and dedups only against a LATER successor.
 */
export async function enqueueNextAgentTurnHealthWatchdog(opts: {
  scheduledJobs: ScheduledJobsService;
  nowFn?: () => number;
  currentRunAt?: Date;
  state?: AgentTurnHealthState;
}): Promise<{ enqueued: boolean }> {
  const now = (opts.nowFn ?? Date.now)();
  return opts.scheduledJobs.enqueue({
    jobType: AGENT_TURN_HEALTH_WATCHDOG_JOB_TYPE,
    accountId: null,
    payload: { state: opts.state ?? INITIAL_AGENT_TURN_HEALTH_STATE },
    runAt: new Date(now + AGENT_TURN_HEALTH_WATCHDOG_INTERVAL_MS),
    dedupOnAccountAndType: true,
    ...(opts.currentRunAt === undefined ? {} : { dedupAfterRunAt: opts.currentRunAt }),
  });
}
