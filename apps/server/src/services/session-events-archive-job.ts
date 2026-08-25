// V-1591 — SCHEDULE the session_events half of the audit archive.
//
// `AuditArchiveService` has bounded five tables on a 90-day window since V-163
// and has never run once: `audit_archive_runs` has zero rows. That was recorded
// deliberately rather than fixed in passing, because `archiveTable` DELETES
// production rows after an R2 upload and four of those five tables are legal or
// financial records (admin_audit_log, processed_stripe_events,
// legal_acceptances, webhook_deliveries).
//
// Those four stay unscheduled. They grow slowly and deleting them is a decision
// with consequences well beyond disk. `session_events` is the one that cannot
// wait, and it is a different kind of table:
//
//   • it is an internal action log (created/navigated/…), not billing- and not
//     customer-read-critical;
//   • it has ON DELETE CASCADE from sessions, so on paper it is bounded — but
//     sessions are marked-destroyed, never row-deleted (`delete(sessions)`
//     appears nowhere in the source), so the cascade never fires;
//   • the wired retention sweep (privacy.retention_scrub, V-759) anonymises
//     session_operations, sessions and keys, and does not touch it;
//   • so it grows for the lifetime of the deployment, and the privacy policy's
//     "session metadata 90 days operational" line has this sweep as its SOLE
//     enforcer. Unscheduled, that line was a promise nothing kept.
//
// Rows are uploaded to R2 BEFORE they are deleted, so this bounds the table
// without destroying the forensic history.
//
// ⚠️ Cadence is hourly, not the monthly cron ADR-006 designs, and the row cap is
// why. A capped run archives at most ARCHIVE_RUN_ROW_CAP rows, so the ceiling
// that matters is rows-per-run × runs-per-day against rows crossing the 90-day
// boundary each day. Monthly × 10k could not keep up with any real volume;
// hourly × 10k clears 240k/day, which is far above what this deployment
// produces and leaves each individual run small. A backlog simply drains over
// successive runs — `capped` says one remains.
//
// Failure posture mirrors crypto-order-expiry-sweep-job EXACTLY: a thrown tick
// is SWALLOWED and logged, then re-armed once. Re-throwing would let the poller
// retry while the `finally` also re-armed, fanning out duplicate parallel
// chains — and duplicate chains are especially bad here, because two concurrent
// runs would each read, upload and DELETE overlapping row sets. The tick is
// idempotent: rows a failed tick did not delete stay in Postgres (upload
// precedes delete) and the next tick re-selects them.

import type { AuditArchiveService } from './audit-archive.js';
import { ARCHIVE_RUN_ROW_CAP } from './audit-archive.js';
import type { ScheduledJobsService, ScheduledJobRow } from './scheduled-jobs.js';
import type { Logger } from '../lib/logger.js';

export const SESSION_EVENTS_ARCHIVE_JOB_TYPE = 'audit.session_events_archive';

/** Re-arm cadence: hourly. See the cadence note in the header. */
export const SESSION_EVENTS_ARCHIVE_INTERVAL_MS = 60 * 60 * 1000;

export interface RegisterSessionEventsArchiveJobOpts {
  scheduledJobs: ScheduledJobsService;
  /**
   * Null when R2 is unconfigured, because archiving uploads before it deletes
   * and there is nowhere to upload to.
   *
   * ⛔ The registration itself stays UNCONDITIONAL even then — see
   * `retention-sweeps-are-unconditional-invariant`. Gating the wiring on R2
   * would make an unset R2_* env var silently switch off a published retention
   * promise, which is the exact failure that invariant exists to prevent. So
   * the chain is always armed and the NULL is reported by the tick, where it is
   * visible, instead of by an absence nobody can see.
   */
  service: Pick<AuditArchiveService, 'archiveTable'> | null;
  logger?: Logger;
  nowFn?: () => number;
}

export function registerSessionEventsArchiveJob(opts: RegisterSessionEventsArchiveJobOpts): void {
  const now = opts.nowFn ?? Date.now;
  opts.scheduledJobs.register(SESSION_EVENTS_ARCHIVE_JOB_TYPE, async (job: ScheduledJobRow) => {
    if (opts.service === null) {
      // Warned rather than thrown: a throw here would be caught below and
      // logged as a tick FAILURE, which reads as a bug in the sweep instead of
      // what it is — a deployment that has not configured R2 and is therefore
      // not keeping its 90-day retention promise.
      opts.logger?.warn?.(
        {
          component: 'session-events-archiver',
          event: 'session_events_archive_unconfigured',
        },
        'session events archive cannot run — R2 is not configured, so session_events is not being bounded. Set R2_* env vars.',
      );
      await enqueueNextSessionEventsArchive({
        scheduledJobs: opts.scheduledJobs,
        nowFn: now,
        currentRunAt: job.runAt,
      });
      return;
    }
    try {
      const result = await opts.service.archiveTable('session_events', {
        rowCap: ARCHIVE_RUN_ROW_CAP,
      });
      // A run that archived nothing is the steady state once the backlog is
      // gone, and logging it hourly would be noise. Anything else is worth a
      // line — including `capped`, because a silent cap reads as "nothing left".
      if (result.rowsArchived > 0 || result.capped) {
        opts.logger?.info?.(
          {
            component: 'session-events-archiver',
            event: 'session_events_archive_tick',
            rowsArchived: result.rowsArchived,
            capped: result.capped,
            deletedFromPostgres: result.deletedFromPostgres,
            r2ObjectKey: result.r2ObjectKey,
          },
          'session events archive tick',
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      opts.logger?.error?.(
        {
          component: 'session-events-archiver',
          event: 'session_events_archive_tick_failed',
          err: { message },
        },
        'session events archive tick failed — re-arming; rows stay in postgres and retry next tick',
      );
    }
    await enqueueNextSessionEventsArchive({
      scheduledJobs: opts.scheduledJobs,
      nowFn: now,
      currentRunAt: job.runAt,
    });
  });
}

/**
 * Enqueue the next run at `now + interval`. Bootstrap dedups all pending;
 * re-arms dedup only against successors after `currentRunAt`.
 */
export async function enqueueNextSessionEventsArchive(opts: {
  scheduledJobs: ScheduledJobsService;
  nowFn?: () => number;
  currentRunAt?: Date;
}): Promise<{ enqueued: boolean }> {
  const now = (opts.nowFn ?? Date.now)();
  return opts.scheduledJobs.enqueue({
    jobType: SESSION_EVENTS_ARCHIVE_JOB_TYPE,
    accountId: null,
    payload: {},
    runAt: new Date(now + SESSION_EVENTS_ARCHIVE_INTERVAL_MS),
    dedupOnAccountAndType: true,
    ...(opts.currentRunAt === undefined ? {} : { dedupAfterRunAt: opts.currentRunAt }),
  });
}
