// The operator's view of the AI automation over a time window: rates derived
// from the raw aggregates the telemetry repo returns.
//
// Aggregates only. Nothing here can name a customer, because nothing upstream
// stores one (see db/agent-turn-telemetry-repo.ts).
//
// ⛔ EVERY RATE CARRIES ITS DENOMINATOR, and a rate over nothing is `null`, not
// zero. Production had 27 AI turns in total when this was written: at that
// volume "0% completion" and "no turns yet" are different facts that must not
// render as the same number, and a 50% that means "one of two" must be readable
// as exactly that.

import type {
  AgentTurnTelemetryAggregates,
  AgentTurnTelemetryRepo,
  Percentiles,
} from '../db/agent-turn-telemetry-repo.js';
import {
  AGENT_TURN_DECIDED_OUTCOMES,
  AGENT_TURN_OUTCOMES,
  AGENT_TURN_TELEMETRY_RETENTION_DAYS,
} from './agent-turn-telemetry.js';

export const AGENT_TURN_SUMMARY_DEFAULT_WINDOW_HOURS = 24;
/** No wider than what is kept. */
export const AGENT_TURN_SUMMARY_MAX_WINDOW_HOURS = AGENT_TURN_TELEMETRY_RETENTION_DAYS * 24;

export interface AgentTurnSummary {
  window: { hours: number; since: string; until: string };
  retention_days: number;
  requests: {
    total: number;
    /** Every persisted outcome, zero-filled, so a missing key never reads as 0. */
    by_outcome: Record<string, number>;
  };
  turns: {
    /** Requests in which the runtime worked on a task — including an `error`
     *  that had already called the model, so spend on errored turns is counted.
     *  The denominator of every per-turn figure below. */
    ran: number;
    /** completed + failed + refused + stopped + error. */
    decided: number;
    completed: number;
    /** completed / decided. */
    completion_rate: number | null;
    /** Share of ran turns with at least one re-plan attempt. */
    replan_rate: number | null;
    avg_replans: number | null;
    recovered_after_replan: number;
    avg_model_calls: number | null;
    /** steps_succeeded / steps_run across ran turns. */
    step_success_rate: number | null;
    customer_stopped: number;
    viewer_disconnected: number;
  };
  conflicts: {
    /** (busy_409 + conflict_409) / total requests. */
    rate_409: number | null;
    /** busy_409 / total requests: "the previous turn is still running". */
    busy_409_rate: number | null;
    busy_409: number;
    conflict_409: number;
  };
  /** Turns that ended failed / refused / stopped / error, by why. Shares are of
   *  these turns only. */
  deaths: Array<{ reason: string; step_kind: string | null; count: number; share: number }>;
  /** Requests answered before any task existed (409 / 429 / other 4xx), by why.
   *  Listed apart so a burst of them cannot dilute `deaths`. Shares are of these
   *  requests only. */
  turned_away: Array<{ reason: string; count: number; share: number }>;
  durations_ms: {
    turn: Percentiles;
    time_to_first_progress: {
      stream: Percentiles;
      all: Percentiles;
      /** Streaming requests behind `stream`: its denominator. */
      stream_samples: number;
    };
    phases: {
      planning: Percentiles;
      starting_browser: Percentiles;
      executing: Percentiles;
      reading_page: Percentiles;
      answering: Percentiles;
    };
    /** duration − time to first progress − the phases: the route's own work
     *  after the runtime returned. High here means storage, not the model. */
    after_turn: Percentiles;
  };
  tokens: {
    total: { input: number; output: number; cache_read: number; cache_write: number };
    per_turn: {
      input: number | null;
      output: number | null;
      cache_read: number | null;
      cache_write: number | null;
    };
    /** cache_read / (input + cache_read + cache_write): how much of the prompt
     *  was served from cache. */
    cache_read_share: number | null;
  };
  cost: {
    /** List-price ESTIMATE, in cents. Not what any customer was billed. */
    estimated_cents_total: number;
    estimated_cents_per_turn: number | null;
    estimated_cents_per_completed_turn: number | null;
  };
  models: Array<{ model: string; turns: number }>;
}

/** Outcomes that can appear in the table (`manual_note` and `replayed` are
 *  metrics-only and never persisted). */
const PERSISTED_OUTCOMES = AGENT_TURN_OUTCOMES.filter(
  (o) => o !== 'manual_note' && o !== 'replayed',
);

function ratio(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return Math.round((numerator / denominator) * 10_000) / 10_000;
}

function average(sum: number, count: number, digits = 2): number | null {
  if (count <= 0) return null;
  const scale = 10 ** digits;
  return Math.round((sum / count) * scale) / scale;
}

export function buildAgentTurnSummary(
  aggregates: AgentTurnTelemetryAggregates,
  window: { hours: number; since: Date; until: Date },
): AgentTurnSummary {
  const byOutcome: Record<string, number> = {};
  for (const outcome of PERSISTED_OUTCOMES) byOutcome[outcome] = aggregates.byOutcome[outcome] ?? 0;
  const total = Object.values(byOutcome).reduce((a, b) => a + b, 0);
  const decided = AGENT_TURN_DECIDED_OUTCOMES.reduce((n, o) => n + (byOutcome[o] ?? 0), 0);
  const completed = byOutcome['completed'] ?? 0;
  const busy = byOutcome['busy_409'] ?? 0;
  const conflict = byOutcome['conflict_409'] ?? 0;
  const ran = aggregates.ran;
  const deathTotal = aggregates.deaths.reduce((n, d) => n + d.count, 0);
  const turnedAwayTotal = aggregates.turnedAway.reduce((n, d) => n + d.count, 0);
  const promptTokens = ran.inputTokens + ran.cacheReadTokens + ran.cacheWriteTokens;
  const p = aggregates.percentilesMs;

  return {
    window: {
      hours: window.hours,
      since: window.since.toISOString(),
      until: window.until.toISOString(),
    },
    retention_days: AGENT_TURN_TELEMETRY_RETENTION_DAYS,
    requests: { total, by_outcome: byOutcome },
    turns: {
      ran: ran.count,
      decided,
      completed,
      completion_rate: ratio(completed, decided),
      replan_rate: ratio(ran.replanned, ran.count),
      avg_replans: average(ran.replansSum, ran.count),
      recovered_after_replan: ran.recoveredAfterReplan,
      avg_model_calls: average(ran.modelCallsSum, ran.count),
      step_success_rate: ratio(ran.stepsSucceededSum, ran.stepsRunSum),
      customer_stopped: ran.customerStopped,
      viewer_disconnected: ran.viewerDisconnected,
    },
    conflicts: {
      rate_409: ratio(busy + conflict, total),
      busy_409_rate: ratio(busy, total),
      busy_409: busy,
      conflict_409: conflict,
    },
    deaths: aggregates.deaths.map((d) => ({
      reason: d.reason,
      step_kind: d.stepKind,
      count: d.count,
      share: ratio(d.count, deathTotal) ?? 0,
    })),
    turned_away: aggregates.turnedAway.map((d) => ({
      reason: d.reason,
      count: d.count,
      share: ratio(d.count, turnedAwayTotal) ?? 0,
    })),
    durations_ms: {
      turn: p.turn,
      time_to_first_progress: {
        stream: p.firstProgressStream,
        all: p.firstProgressAll,
        stream_samples: aggregates.firstProgressStreamSamples,
      },
      phases: {
        planning: p.planning,
        starting_browser: p.startingBrowser,
        executing: p.executing,
        reading_page: p.readingPage,
        answering: p.answering,
      },
      after_turn: p.afterTurn,
    },
    tokens: {
      total: {
        input: ran.inputTokens,
        output: ran.outputTokens,
        cache_read: ran.cacheReadTokens,
        cache_write: ran.cacheWriteTokens,
      },
      per_turn: {
        input: average(ran.inputTokens, ran.count, 0),
        output: average(ran.outputTokens, ran.count, 0),
        cache_read: average(ran.cacheReadTokens, ran.count, 0),
        cache_write: average(ran.cacheWriteTokens, ran.count, 0),
      },
      cache_read_share: ratio(ran.cacheReadTokens, promptTokens),
    },
    cost: {
      estimated_cents_total: Math.round(ran.costMillicents / 10) / 100,
      estimated_cents_per_turn: average(ran.costMillicents / 1000, ran.count),
      estimated_cents_per_completed_turn: average(ran.costMillicents / 1000, completed),
    },
    models: aggregates.byModel.map((m) => ({ model: m.model, turns: m.count })),
  };
}

export class AgentTurnSummaryService {
  constructor(private readonly deps: { repo: AgentTurnTelemetryRepo; nowFn?: () => number }) {}

  /** `statementTimeoutMs` cancels the window's queries in the database after
   *  that long (see AgentTurnTelemetryAggregateArgs); the admin route leaves it
   *  unset, a background caller that gives up on a slow window sets it. */
  async summarize(
    windowHours: number,
    opts: { statementTimeoutMs?: number } = {},
  ): Promise<AgentTurnSummary> {
    const until = new Date((this.deps.nowFn ?? Date.now)());
    const since = new Date(until.getTime() - windowHours * 60 * 60 * 1000);
    const aggregates = await this.deps.repo.aggregate({
      since,
      until,
      ...(opts.statementTimeoutMs !== undefined
        ? { statementTimeoutMs: opts.statementTimeoutMs }
        : {}),
    });
    return buildAgentTurnSummary(aggregates, { hours: windowHours, since, until });
  }
}
