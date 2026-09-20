// The daily job that asks whether the credit records still agree with
// themselves, and tells a person when they do not (§5.3).
//
//   credits.invariant_audit   once a day: nine rules, nine counts. Silent
//                             while every count is zero; one alert, with the
//                             counts and nothing else, when any is not.
//
// ⛔ REGISTERED ONLY WHILE AI CREDITS ARE SWITCHED ON, like the three grant
// jobs beside it. Bootstrap registers and seeds this inside the same
// `creditGrants !== null`, and that is null while DRIFTSTACK_AI_CREDITS_MODE is
// off. With it off no handler exists, no row is enqueued and nothing here runs.
//
// ⛔ THE ALERT CARRIES COUNTS AND NOTHING ELSE. No account id, no email, no
// amount, no model. A breach means somebody opens the database; it does not
// mean customer data is copied into an inbox or an error reporter on the way to
// telling them. The rules themselves are named — `lot_held_vs_holds` says where
// to look without saying whose.
//
// ⛔ AN AUDIT THAT FAILS IS NOT AN AUDIT THAT PASSED. A tick whose queries throw
// is logged and alerted as its own condition, because a daily check that
// silently stopped running looks exactly like a daily check that keeps finding
// nothing — which is the failure this whole file exists to catch one level
// down. It re-arms either way: this is a self-re-arming chain like every other
// sweep in this server, and a thrown tick that skipped its own enqueue would be
// the last tick that ever ran.

import type {
  CreditInvariantCheck,
  CreditInvariantCounts,
} from '../db/credit-invariant-audit-repo.js';
import { CREDIT_INVARIANT_CHECKS } from '../db/credit-invariant-audit-repo.js';
import type { Logger } from '../lib/logger.js';
import type { SentryClient } from '../lib/sentry.js';
import type { ScheduledJobRow, ScheduledJobsService } from './scheduled-jobs.js';

export const CREDITS_INVARIANT_AUDIT_JOB_TYPE = 'credits.invariant_audit';

/** Once a day. The rules it checks are written by minutes-long transactions, not by the hour. */
export const CREDITS_INVARIANT_AUDIT_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** What the audit needs of the repository, so a test can stand in for it. */
export interface CreditInvariantAuditTarget {
  countAll(): Promise<CreditInvariantCounts>;
}

/** One rule that does not hold, and how many rows break it. */
export interface CreditInvariantBreach {
  readonly check: CreditInvariantCheck;
  readonly count: number;
}

/**
 * Ask every rule and keep the ones that failed, in the order
 * `CREDIT_INVARIANT_CHECKS` declares them — so an alert always reads the same
 * way and two alerts can be compared line by line.
 *
 * ⛔ IT WALKS THE DECLARED LIST, NOT THE OBJECT'S KEYS. A check added to the
 * repository and forgotten here would be invisible; walking the closed set
 * means a missing count reads as `-1` and is reported rather than skipped.
 */
export function breachesIn(counts: CreditInvariantCounts): CreditInvariantBreach[] {
  const out: CreditInvariantBreach[] = [];
  for (const check of CREDIT_INVARIANT_CHECKS) {
    const count = counts[check] ?? -1;
    if (count !== 0) out.push({ check, count });
  }
  return out;
}

export interface CreditInvariantAuditReport {
  readonly counts: CreditInvariantCounts;
  readonly breaches: readonly CreditInvariantBreach[];
}

/** Run every check once. Throws only if the database does. */
export async function auditCreditInvariants(
  repo: CreditInvariantAuditTarget,
): Promise<CreditInvariantAuditReport> {
  const counts = await repo.countAll();
  return { counts, breaches: breachesIn(counts) };
}

export interface CreditInvariantAlertSink {
  logger?: Logger | null;
  sentry?: Pick<SentryClient, 'captureMessage'> | null;
}

/**
 * Tell a person. The log line carries every count so the whole picture is in
 * one place; the alert carries the failing rules and their counts, which is
 * what reaches somebody who is not reading logs.
 *
 * Fire-and-forget, like every other alert in this server: an error reporter
 * that is down must not turn a bookkeeping breach into a failed job.
 */
export function reportCreditInvariantBreaches(
  report: CreditInvariantAuditReport,
  sink: CreditInvariantAlertSink,
): void {
  if (report.breaches.length === 0) return;
  const failing = report.breaches.map((b) => `${b.check}=${String(b.count)}`).join(' ');
  sink.logger?.error?.(
    {
      component: 'credit-invariant-audit',
      event: 'ai_credits_invariant_breach',
      breaches: report.breaches.length,
      counts: report.counts,
    },
    `AI credit records disagree with themselves: ${failing}`,
  );
  try {
    sink.sentry?.captureMessage({
      message:
        'The daily AI credit invariant audit found records that disagree. ' +
        `Rules and row counts: ${failing}. Nothing here names an account — open the database.`,
      level: 'error',
      fingerprint: ['billing', 'ai_credits_invariant_breach'],
      tags: { kind: 'ai_credits_invariant_breach' },
      extra: { counts: report.counts },
    });
  } catch {
    // Fire-and-forget, like every Sentry call.
  }
}

/** The audit itself could not run, which is its own condition. */
function reportCreditInvariantAuditFailed(err: unknown, sink: CreditInvariantAlertSink): void {
  sink.logger?.error?.(
    {
      component: 'credit-invariant-audit',
      event: 'ai_credits_invariant_audit_failed',
      err:
        err instanceof Error
          ? { name: err.name, message: err.message, cause: err.cause }
          : { value: err },
    },
    'the daily AI credit invariant audit could not run — it is re-armed for tomorrow',
  );
  try {
    sink.sentry?.captureMessage({
      message:
        'The daily AI credit invariant audit could not run. Until it does, a breach in the ' +
        'credit records would go unreported; the server log carries the error.',
      level: 'error',
      fingerprint: ['billing', 'ai_credits_invariant_audit_failed'],
      tags: { kind: 'ai_credits_invariant_audit_failed' },
    });
  } catch {
    // Fire-and-forget, like every Sentry call.
  }
}

export interface RegisterCreditInvariantAuditOpts {
  scheduledJobs: ScheduledJobsService;
  audit: CreditInvariantAuditTarget;
  logger?: Logger;
  sentry?: Pick<SentryClient, 'captureMessage'> | null;
  nowFn?: () => number;
}

/**
 * Register the daily audit. Like every sweep in this server it re-arms AFTER
 * the catch, never as the last statement of the `try`: a tick that threw would
 * otherwise skip its own enqueue, the poller would retry to `maxAttempts`, and
 * the chain would be dead until a process restart — silently, which is the one
 * way an audit fails without anybody noticing.
 */
export function registerCreditsInvariantAuditJob(opts: RegisterCreditInvariantAuditOpts): void {
  const now = opts.nowFn ?? Date.now;
  const sink: CreditInvariantAlertSink = {
    logger: opts.logger ?? null,
    sentry: opts.sentry ?? null,
  };
  opts.scheduledJobs.register(CREDITS_INVARIANT_AUDIT_JOB_TYPE, async (job: ScheduledJobRow) => {
    try {
      const report = await auditCreditInvariants(opts.audit);
      if (report.breaches.length === 0) {
        opts.logger?.info?.(
          {
            component: 'credit-invariant-audit',
            event: 'ai_credits_invariant_audit_clean',
            checks: CREDIT_INVARIANT_CHECKS.length,
          },
          'the daily AI credit invariant audit found nothing',
        );
      } else {
        reportCreditInvariantBreaches(report, sink);
      }
    } catch (err) {
      reportCreditInvariantAuditFailed(err, sink);
    }
    await enqueueNextCreditsInvariantAudit({
      scheduledJobs: opts.scheduledJobs,
      nowFn: now,
      currentRunAt: job.runAt,
    });
  });
}

/**
 * Enqueue tomorrow's audit. Bootstrap omits `currentRunAt` and dedups against
 * every pending row; a re-arm passes the running row's `runAt` and dedups only
 * against a LATER successor — the same shape the three grant jobs use, so a
 * poller retry of one tick cannot fan the chain out into two.
 */
export async function enqueueNextCreditsInvariantAudit(opts: {
  scheduledJobs: ScheduledJobsService;
  nowFn?: () => number;
  currentRunAt?: Date;
}): Promise<{ enqueued: boolean }> {
  const now = (opts.nowFn ?? Date.now)();
  return opts.scheduledJobs.enqueue({
    jobType: CREDITS_INVARIANT_AUDIT_JOB_TYPE,
    accountId: null,
    payload: {},
    runAt: new Date(now + CREDITS_INVARIANT_AUDIT_INTERVAL_MS),
    dedupOnAccountAndType: true,
    ...(opts.currentRunAt === undefined ? {} : { dedupAfterRunAt: opts.currentRunAt }),
  });
}
