// session_events is bounded now, and a capped run must not eat its own output.
//
// AuditArchiveService could archive five tables since V-163 and had never run
// once. V-1591 schedules it for session_events — the one table with genuinely
// unbounded growth, because its cascade from `sessions` never fires (sessions
// are marked-destroyed, never row-deleted) and the wired retention scrub does
// not touch it.
//
// Wiring it needed a row cap: `archiveTable` used to read the whole window into
// memory, and the first scheduled run would have been against the entire
// backlog. The cap is what makes the sweep safe to schedule, and it introduces
// the failure this file mostly exists for.
//
// ⛔ THE R2 KEY. It was granular only to YYYY/MM:
//     <prefix>/session_events/2026/05/session_events_2026-05.jsonl.gz
// which was fine while the design was ONE unbounded run per month. Under a
// capped run draining a backlog it is not: two runs whose oldest row falls in
// the same calendar month compute the SAME key, so the second putObject
// OVERWRITES the first — after the first run's rows were already deleted from
// postgres. Archived, deleted, then silently destroyed. The third arm is that
// case, and it fails against the pre-V-1591 key shape.

import { describe, expect, it, vi } from 'vitest';
import {
  AuditArchiveService,
  ARCHIVE_RUN_ROW_CAP,
  archiveObjectKey,
  type ArchiveLedgerRepo,
  type ArchiveTableName,
  type ArchiveTableRepo,
} from '../../src/services/audit-archive.js';
import {
  registerSessionEventsArchiveJob,
  SESSION_EVENTS_ARCHIVE_JOB_TYPE,
  SESSION_EVENTS_ARCHIVE_INTERVAL_MS,
} from '../../src/services/session-events-archive-job.js';
import type { R2 } from '../../src/lib/r2.js';
import type { ScheduledJobsService, ScheduledJobRow } from '../../src/services/scheduled-jobs.js';

const FIXED_NOW = new Date('2026-08-25T12:00:00.000Z');

interface Uploaded {
  key: string;
  body: Buffer;
}

function fakeR2(uploads: Uploaded[]): R2 {
  return {
    bucket: 'test-bucket',
    headObject: () => Promise.resolve({ exists: false }),
    putObject: ({ key, body }) => {
      uploads.push({ key, body: Buffer.isBuffer(body) ? body : Buffer.from(body) });
      return Promise.resolve();
    },
    deleteObject: () => Promise.resolve(),
    presignPut: () => Promise.resolve('https://presigned.test/put'),
    presignGet: () => Promise.resolve('https://presigned.test/get'),
    listObjects: () => Promise.resolve([]),
  };
}

function fakeLedger(): ArchiveLedgerRepo {
  let n = 0;
  return {
    insertRun: () => Promise.resolve(`run_${++n}`),
    markDeletedFromPostgres: () => Promise.resolve(),
  };
}

/** A session_events row `n` days before FIXED_NOW. */
function evt(id: string, daysAgo: number): Record<string, unknown> {
  return {
    id,
    created_at: new Date(FIXED_NOW.getTime() - daysAgo * 24 * 60 * 60 * 1000),
    session_id: 'ses_x',
    // The column is `type`, and projectSessionEventMetadata REJECTS a value
    // outside SESSION_EVENT_TYPES. A double that spelled it `event_type` was
    // rejected by the real projection, which is the double being caught rather
    // than the code — so the shape here is the real one.
    type: 'navigated',
    payload: { url: 'https://example.test/' },
  };
}

/**
 * A store that HONOURS the limit and actually removes deleted rows, so a second
 * run sees what the first one left behind. A fake that ignored either would let
 * the drain arm pass without draining anything.
 */
function fakeRows(store: Record<string, unknown>[]): ArchiveTableRepo {
  return {
    selectArchivableRows: (_t: ArchiveTableName, olderThan: Date, limit?: number) => {
      const eligible = store
        .filter((r) => (r.created_at as Date) < olderThan)
        .sort((a, b) => (a.created_at as Date).getTime() - (b.created_at as Date).getTime());
      return Promise.resolve(limit === undefined ? eligible : eligible.slice(0, limit));
    },
    deleteRowsById: (_t: ArchiveTableName, ids: readonly string[]) => {
      let removed = 0;
      for (const id of ids) {
        const i = store.findIndex((r) => r.id === id);
        if (i >= 0) {
          store.splice(i, 1);
          removed++;
        }
      }
      return Promise.resolve(removed);
    },
  };
}

function service(store: Record<string, unknown>[], uploads: Uploaded[]): AuditArchiveService {
  return new AuditArchiveService({
    r2: fakeR2(uploads),
    ledger: fakeLedger(),
    rows: fakeRows(store),
    now: () => FIXED_NOW,
  });
}

/**
 * Rows past the 90-day hot window, all inside ONE calendar month.
 *
 * ⚠️ The single-month property is load-bearing for the key-collision arm, and an
 * earlier version of this fixture did not have it: `100 + (i % 20)` days before
 * FIXED_NOW spans 2026-04-28 → 2026-05-17, so two runs drew their windowStart
 * from DIFFERENT months and got different keys from the YYYY/MM path alone. The
 * arm passed with the discriminator deleted — it proved nothing. 100..109 days
 * is 2026-05-08 → 2026-05-17, entirely within May, so a shared key is the
 * default and only the discriminator separates them.
 */
function backlog(count: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, i) => evt(`evt_${i}`, 100 + (i % 10)));
}

describe('session events are actually archived', () => {
  it('CRITICAL a capped run archives exactly the cap and says a backlog remains', async () => {
    const store = backlog(25);
    const uploads: Uploaded[] = [];
    const result = await service(store, uploads).archiveTable('session_events', { rowCap: 10 });

    expect(result.rowsArchived, 'archived more than the cap allows').toBe(10);
    expect(result.capped, 'a backlog remains but capped is false — reads as "nothing left"').toBe(
      true,
    );
    // The cap+1 probe row must NOT be archived or deleted.
    expect(store.length, 'the extra row read to detect the backlog was archived too').toBe(15);
  });

  it('CRITICAL successive runs drain the backlog rather than re-reading the same prefix', async () => {
    const store = backlog(25);
    const uploads: Uploaded[] = [];
    const svc = service(store, uploads);

    await svc.archiveTable('session_events', { rowCap: 10 });
    await svc.archiveTable('session_events', { rowCap: 10 });
    const third = await svc.archiveTable('session_events', { rowCap: 10 });

    expect(store.length, 'the backlog did not drain across runs').toBe(0);
    expect(third.capped, 'the final run still reports a backlog').toBe(false);
    expect(third.rowsArchived).toBe(5);
  });

  it('CRITICAL two runs draining ONE month write to DIFFERENT R2 keys. Sharing a key means the second upload destroys the first — whose rows were already deleted from postgres.', async () => {
    const store = backlog(25);
    const uploads: Uploaded[] = [];
    const svc = service(store, uploads);

    await svc.archiveTable('session_events', { rowCap: 10 });
    await svc.archiveTable('session_events', { rowCap: 10 });

    expect(uploads.length).toBe(2);
    // The precondition this arm depends on. Without it the two keys differ for
    // an uninteresting reason (different months) and the arm is vacuous — which
    // is exactly what happened before the fixture was narrowed to one month.
    const month = (k: string): string => k.split('/').slice(-3, -1).join('/');
    expect(
      month(uploads[0]!.key),
      'the two runs landed in different calendar months, so this arm is not testing the ' +
        'discriminator at all — narrow the fixture back to a single month',
    ).toBe(month(uploads[1]!.key));
    expect(
      uploads[0]!.key,
      "both runs uploaded to the same key — the first run's archive is gone and its rows are " +
        'already deleted from postgres. This is silent, unrecoverable data loss.',
    ).not.toBe(uploads[1]!.key);
    // And the payloads genuinely differ, so this is not two identical writes.
    expect(uploads[0]!.body.equals(uploads[1]!.body)).toBe(false);
  });

  it("CRITICAL a capped run's ledger window ends at its LAST archived row, not at the 90-day cutoff. The ledger is the audit trail for a DELETION — claiming the full window when only a prefix was archived sends a reader to an object that does not hold the row, and makes a still-hot row look archived.", async () => {
    const store = backlog(25);
    const uploads: Uploaded[] = [];
    const windows: { start: Date; end: Date }[] = [];
    const svc = new AuditArchiveService({
      r2: fakeR2(uploads),
      ledger: {
        insertRun: (args) => {
          windows.push({ start: args.windowStart, end: args.windowEnd });
          return Promise.resolve('run_1');
        },
        markDeletedFromPostgres: () => Promise.resolve(),
      },
      rows: fakeRows(store),
      now: () => FIXED_NOW,
    });

    const cutoff = new Date(FIXED_NOW.getTime() - 90 * 24 * 60 * 60 * 1000);
    const capped = await svc.archiveTable('session_events', { rowCap: 10 });
    expect(capped.capped).toBe(true);
    expect(
      windows[0]!.end.getTime(),
      'the capped run recorded the full 90-day cutoff as its window end, overstating what it archived',
    ).toBeLessThan(cutoff.getTime());

    // Drain the rest; the FINAL, uncapped run legitimately reaches the cutoff.
    await svc.archiveTable('session_events', { rowCap: 10 });
    const last = await svc.archiveTable('session_events', { rowCap: 10 });
    expect(last.capped).toBe(false);
    expect(
      windows[windows.length - 1]!.end.getTime(),
      'an uncapped run did cover the whole window and must say so',
    ).toBe(cutoff.getTime());
  });

  it('CRITICAL a scheduled run with nothing to archive writes NOTHING. Its steady state is the empty window every hour, and audit_archive_runs has no pruner — a ledger row per no-op is ~8,760 rows a year, trading one unbounded table for another.', async () => {
    const uploads: Uploaded[] = [];
    const inserts: number[] = [];
    const svc = new AuditArchiveService({
      r2: fakeR2(uploads),
      ledger: {
        insertRun: () => {
          inserts.push(1);
          return Promise.resolve('run_1');
        },
        markDeletedFromPostgres: () => Promise.resolve(),
      },
      // Nothing is old enough to archive.
      rows: fakeRows([evt('recent', 1)]),
      now: () => FIXED_NOW,
    });

    const result = await svc.archiveTable('session_events', { rowCap: 10 });
    expect(result.rowsArchived).toBe(0);
    expect(result.capped).toBe(false);
    expect(inserts.length, 'an empty scheduled run wrote a ledger row').toBe(0);
    expect(uploads.length, 'an empty scheduled run uploaded an object to R2').toBe(0);
  });

  it('an UNCAPPED empty run still records its no-op, because a manual run that found nothing is worth the record', async () => {
    const uploads: Uploaded[] = [];
    const inserts: number[] = [];
    const svc = new AuditArchiveService({
      r2: fakeR2(uploads),
      ledger: {
        insertRun: () => {
          inserts.push(1);
          return Promise.resolve('run_1');
        },
        markDeletedFromPostgres: () => Promise.resolve(),
      },
      rows: fakeRows([evt('recent', 1)]),
      now: () => FIXED_NOW,
    });

    await svc.archiveTable('session_events');
    expect(inserts.length, 'the documented no-op ledger row was dropped for manual runs too').toBe(
      1,
    );
  });

  it('an UNCAPPED call keeps the exact monthly key ADR-006 §2 documents', () => {
    const windowStart = new Date('2026-05-14T00:00:00.000Z');
    expect(archiveObjectKey('audit-archive', 'session_events', windowStart)).toBe(
      'audit-archive/session_events/2026/05/session_events_2026-05.jsonl.gz',
    );
  });

  it('re-archiving byte-identical content lands on the SAME key, preserving ADR §3 idempotent retry', () => {
    const windowStart = new Date('2026-05-14T00:00:00.000Z');
    const sum = 'a'.repeat(64);
    expect(archiveObjectKey('audit-archive', 'session_events', windowStart, sum)).toBe(
      archiveObjectKey('audit-archive', 'session_events', windowStart, sum),
    );
  });

  it('the scheduled tick uses the row cap, so it can never read an unbounded backlog', async () => {
    let seenCap: number | undefined;
    const jobs = fakeScheduledJobs();
    registerSessionEventsArchiveJob({
      scheduledJobs: jobs.service,
      service: {
        archiveTable: (_t, opts) => {
          seenCap = opts?.rowCap;
          return Promise.resolve({
            tableName: 'session_events' as const,
            rowsArchived: 0,
            r2ObjectKey: 'k',
            sha256Checksum: 's',
            deletedFromPostgres: true,
            capped: false,
          });
        },
      },
    });
    await jobs.run();
    expect(seenCap, 'the tick archived without a cap').toBe(ARCHIVE_RUN_ROW_CAP);
  });

  it('CRITICAL an unconfigured R2 warns and re-arms instead of throwing, so the chain survives', async () => {
    const warn = vi.fn();
    const jobs = fakeScheduledJobs();
    registerSessionEventsArchiveJob({
      scheduledJobs: jobs.service,
      service: null,
      logger: { warn } as never,
    });
    await expect(jobs.run()).resolves.not.toThrow();
    expect(
      warn,
      'an unconfigured R2 passed silently — the retention promise is not kept',
    ).toHaveBeenCalled();
    expect(jobs.enqueued.length, 'the chain was not re-armed and is now dead').toBe(1);
  });

  it('CRITICAL a thrown tick is swallowed and the chain re-armed exactly once', async () => {
    const error = vi.fn();
    const jobs = fakeScheduledJobs();
    registerSessionEventsArchiveJob({
      scheduledJobs: jobs.service,
      service: { archiveTable: () => Promise.reject(new Error('R2 down')) },
      logger: { error } as never,
    });
    await expect(jobs.run()).resolves.not.toThrow();
    expect(error).toHaveBeenCalled();
    // Exactly one: a second re-arm here fans out duplicate parallel chains, and
    // two concurrent runs would each read, upload and DELETE overlapping rows.
    expect(jobs.enqueued.length).toBe(1);
  });

  it('re-arms at the hourly cadence the cap depends on', async () => {
    const jobs = fakeScheduledJobs();
    registerSessionEventsArchiveJob({
      scheduledJobs: jobs.service,
      service: null,
      nowFn: () => FIXED_NOW.getTime(),
    });
    await jobs.run();
    expect(jobs.enqueued[0]!.runAt.getTime()).toBe(
      FIXED_NOW.getTime() + SESSION_EVENTS_ARCHIVE_INTERVAL_MS,
    );
  });
});

/** Minimal ScheduledJobsService double: captures the handler and the re-arms. */
function fakeScheduledJobs(): {
  service: ScheduledJobsService;
  run: () => Promise<void>;
  enqueued: { jobType: string; runAt: Date }[];
} {
  let handler: ((job: ScheduledJobRow) => Promise<void>) | null = null;
  const enqueued: { jobType: string; runAt: Date }[] = [];
  const service = {
    register: (jobType: string, fn: (job: ScheduledJobRow) => Promise<void>) => {
      expect(jobType).toBe(SESSION_EVENTS_ARCHIVE_JOB_TYPE);
      handler = fn;
    },
    enqueue: (args: { jobType: string; runAt: Date }) => {
      enqueued.push({ jobType: args.jobType, runAt: args.runAt });
      return Promise.resolve({ enqueued: true });
    },
  } as unknown as ScheduledJobsService;
  return {
    service,
    run: async () => {
      if (handler === null) throw new Error('handler was never registered');
      await handler({ runAt: FIXED_NOW } as ScheduledJobRow);
    },
    enqueued,
  };
}
