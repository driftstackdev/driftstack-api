// V-553.B-28 — unit tests for ValidationHarnessService (V-218).
//
// Surface under test:
//   - admin CRUD: list/upsert/remove all gated on
//     driftstack_internal_admin scope; cadence < 60s rejected;
//     remove on missing archetype throws NotFound
//   - triggerNow: admin scope + dispatches a manual_request with
//     the locked archetype's baseline version
//   - processTick: pulls findDue rows, dispatches each via
//     recapture.triggerRecapture, marks each run on success, and
//     records per-archetype errors without aborting the batch

import { describe, expect, it } from 'vitest';
import { ARCHETYPE_REGISTRY } from '@driftstack/api-types';

// V-1582 — the service refuses an archetype the registry does not contain, so
// ARCH no longer stands for one. Taken from the registry rather than written
// out, so retiring a slug cannot rot this fixture.
const ARCH = ARCHETYPE_REGISTRY[0]?.id ?? '';
const UNKNOWN_ARCH = 'totally-not-an-archetype';
import type { ApiKeyScope } from '@driftstack/api-types';
import type { AccountContext } from '../../src/services/auth.js';
import {
  ValidationHarnessService,
  type UpsertValidationScheduleInput,
  type ValidationHarnessRecaptureBridge,
  type ValidationScheduleRow,
  type ValidationSchedulesRepo,
} from '../../src/services/validation-harness.js';
import { ConflictError, NotFoundError } from '../../src/lib/errors.js';

const LOCKED = { iosVersion: '17.4', safariVersion: '17.4' };

function ctxWith(scopes: ApiKeyScope[]): AccountContext {
  return {
    account: { id: 'acc_1' },
    apiKey: { id: 'key_1', scopes },
  } as unknown as AccountContext;
}

function makeRepo(initial: ValidationScheduleRow[] = []): {
  repo: ValidationSchedulesRepo;
  state: { rows: ValidationScheduleRow[]; marks: Array<{ archetypeId: string; runId: string }> };
} {
  const rows = [...initial];
  const marks: Array<{ archetypeId: string; runId: string }> = [];
  const repo: ValidationSchedulesRepo = {
    list: () => Promise.resolve(rows),
    findByArchetype: (archetypeId) =>
      Promise.resolve(rows.find((r) => r.archetypeId === archetypeId) ?? null),
    upsert: (input: UpsertValidationScheduleInput) => {
      const now = new Date();
      const existing = rows.find((r) => r.archetypeId === input.archetypeId);
      if (existing) {
        existing.cadenceSeconds = input.cadenceSeconds;
        existing.enabled = input.enabled;
        existing.reason = input.reason ?? null;
        existing.updatedAt = now;
        return Promise.resolve(existing);
      }
      const fresh: ValidationScheduleRow = {
        id: `sched_${(rows.length + 1).toString()}`,
        archetypeId: input.archetypeId,
        cadenceSeconds: input.cadenceSeconds,
        enabled: input.enabled,
        lastRunAt: null,
        nextRunAt: new Date(now.getTime() + input.cadenceSeconds * 1000),
        lastRunId: null,
        reason: input.reason ?? null,
        createdAt: now,
        updatedAt: now,
      };
      rows.push(fresh);
      return Promise.resolve(fresh);
    },
    remove: (archetypeId) => {
      const idx = rows.findIndex((r) => r.archetypeId === archetypeId);
      if (idx < 0) return Promise.resolve(false);
      rows.splice(idx, 1);
      return Promise.resolve(true);
    },
    findDue: (now, limit) =>
      Promise.resolve(
        rows
          .filter((r) => r.enabled && r.nextRunAt <= now)
          .sort((a, b) => a.nextRunAt.getTime() - b.nextRunAt.getTime())
          .slice(0, limit),
      ),
    markRun: (archetypeId, runId, now) => {
      const r = rows.find((row) => row.archetypeId === archetypeId);
      if (r) {
        r.lastRunAt = now;
        r.lastRunId = runId;
        r.nextRunAt = new Date(now.getTime() + r.cadenceSeconds * 1000);
      }
      marks.push({ archetypeId, runId });
      return Promise.resolve();
    },
  };
  return { repo, state: { rows, marks } };
}

function makeBridge(opts: { fail?: Set<string> } = {}): {
  bridge: ValidationHarnessRecaptureBridge;
  calls: Array<{ trigger: string; archetypeId: string; reason?: string | undefined }>;
} {
  const calls: Array<{ trigger: string; archetypeId: string; reason?: string | undefined }> = [];
  let counter = 0;
  const bridge: ValidationHarnessRecaptureBridge = {
    triggerRecapture: (opts2) => {
      if (opts.fail?.has(opts2.archetypeId)) {
        return Promise.reject(new Error(`boom-${opts2.archetypeId}`));
      }
      counter += 1;
      calls.push({
        trigger: opts2.trigger,
        archetypeId: opts2.archetypeId,
        reason: opts2.reason,
      });
      return Promise.resolve({ id: `run_${counter.toString()}` });
    },
  };
  return { bridge, calls };
}

describe('V-553.B-28 ValidationHarnessService.list', () => {
  it('rejects callers without driftstack_internal_admin scope', async () => {
    const { repo } = makeRepo();
    const { bridge } = makeBridge();
    const svc = new ValidationHarnessService(repo, bridge, LOCKED);
    await expect(svc.list(ctxWith(['read']))).rejects.toThrow(/driftstack_internal_admin/);
  });

  it('returns the repo list for an admin', async () => {
    const { repo } = makeRepo();
    const { bridge } = makeBridge();
    const svc = new ValidationHarnessService(repo, bridge, LOCKED);
    const out = await svc.list(ctxWith(['driftstack_internal_admin']));
    expect(out).toEqual([]);
  });
});

describe('V-553.B-28 ValidationHarnessService.upsert', () => {
  it('rejects cadence < 60 seconds with ConflictError', async () => {
    const { repo } = makeRepo();
    const { bridge } = makeBridge();
    const svc = new ValidationHarnessService(repo, bridge, LOCKED);
    await expect(
      svc.upsert(ctxWith(['driftstack_internal_admin']), {
        archetypeId: ARCH,
        cadenceSeconds: 30,
        enabled: true,
      }),
    ).rejects.toThrow(ConflictError);
  });

  it('writes a fresh schedule on the happy path', async () => {
    const { repo, state } = makeRepo();
    const { bridge } = makeBridge();
    const svc = new ValidationHarnessService(repo, bridge, LOCKED);
    const out = await svc.upsert(ctxWith(['driftstack_internal_admin']), {
      archetypeId: ARCH,
      cadenceSeconds: 600,
      enabled: true,
      reason: 'V-203 weekly drift',
    });
    expect(out.archetypeId).toBe(ARCH);
    expect(state.rows).toHaveLength(1);
  });
});

describe('V-553.B-28 ValidationHarnessService.remove', () => {
  it('throws NotFound when the schedule does not exist', async () => {
    const { repo } = makeRepo();
    const { bridge } = makeBridge();
    const svc = new ValidationHarnessService(repo, bridge, LOCKED);
    await expect(svc.remove(ctxWith(['driftstack_internal_admin']), 'arc_missing')).rejects.toThrow(
      NotFoundError,
    );
  });

  it('removes an existing schedule', async () => {
    const now = new Date();
    const { repo, state } = makeRepo([
      {
        id: 'sched_1',
        archetypeId: ARCH,
        cadenceSeconds: 600,
        enabled: true,
        lastRunAt: null,
        nextRunAt: now,
        lastRunId: null,
        reason: null,
        createdAt: now,
        updatedAt: now,
      },
    ]);
    const { bridge } = makeBridge();
    const svc = new ValidationHarnessService(repo, bridge, LOCKED);
    await svc.remove(ctxWith(['driftstack_internal_admin']), ARCH);
    expect(state.rows).toHaveLength(0);
  });
});

describe('V-553.B-28 ValidationHarnessService.triggerNow', () => {
  it('rejects callers without admin scope', async () => {
    const { repo } = makeRepo();
    const { bridge } = makeBridge();
    const svc = new ValidationHarnessService(repo, bridge, LOCKED);
    await expect(svc.triggerNow(ctxWith(['read']), ARCH)).rejects.toThrow(
      /driftstack_internal_admin/,
    );
  });

  it('dispatches a manual_request and returns the run id', async () => {
    const { repo } = makeRepo();
    const { bridge, calls } = makeBridge();
    const svc = new ValidationHarnessService(repo, bridge, LOCKED);
    const out = await svc.triggerNow(ctxWith(['driftstack_internal_admin']), ARCH, 'config tweak');
    expect(out.runId).toMatch(/^run_/);
    expect(calls[0]?.trigger).toBe('manual_request');
    expect(calls[0]?.archetypeId).toBe(ARCH);
    expect(calls[0]?.reason).toBe('config tweak');
  });
});

describe('V-1582 an archetype outside the registry', () => {
  it('upsert refuses it, so no enabled row exists for the tick loop to find', async () => {
    const { repo, state } = makeRepo();
    const { bridge } = makeBridge();
    const svc = new ValidationHarnessService(repo, bridge, LOCKED);
    await expect(
      svc.upsert(ctxWith(['driftstack_internal_admin']), {
        archetypeId: UNKNOWN_ARCH,
        cadenceSeconds: 3600,
        enabled: true,
      }),
    ).rejects.toThrow(/Unknown archetype/);
    expect(state.rows, 'and nothing was persisted').toHaveLength(0);
  });

  it('triggerNow refuses it, so no run is dispatched for something that does not exist', async () => {
    const { repo } = makeRepo();
    const { bridge, calls } = makeBridge();
    const svc = new ValidationHarnessService(repo, bridge, LOCKED);
    await expect(
      svc.triggerNow(ctxWith(['driftstack_internal_admin']), UNKNOWN_ARCH),
    ).rejects.toThrow(/Unknown archetype/);
    expect(calls, 'and the recapture bridge was never reached').toHaveLength(0);
  });

  it('remove still accepts it, so a schedule written before the guard stays deletable', async () => {
    // The asymmetry is deliberate: validating the way out as well as the way in
    // would make a pre-existing bad row permanent. NotFound is the honest answer.
    const { repo } = makeRepo();
    const { bridge } = makeBridge();
    const svc = new ValidationHarnessService(repo, bridge, LOCKED);
    await expect(svc.remove(ctxWith(['driftstack_internal_admin']), UNKNOWN_ARCH)).rejects.toThrow(
      /No validation schedule/,
    );
  });

  it('the scope check runs first, so a non-admin is refused before the archetype is judged', async () => {
    const { repo } = makeRepo();
    const { bridge } = makeBridge();
    const svc = new ValidationHarnessService(repo, bridge, LOCKED);
    await expect(svc.triggerNow(ctxWith(['read']), UNKNOWN_ARCH)).rejects.toThrow(
      /driftstack_internal_admin/,
    );
  });
});

describe('V-553.B-28 ValidationHarnessService.processTick', () => {
  function makeDueRow(
    archetypeId: string,
    opts: { reason?: string | null } = {},
  ): ValidationScheduleRow {
    const past = new Date(Date.now() - 60_000);
    return {
      id: `sched_${archetypeId}`,
      archetypeId,
      cadenceSeconds: 600,
      enabled: true,
      lastRunAt: null,
      nextRunAt: past,
      lastRunId: null,
      reason: opts.reason ?? null,
      createdAt: past,
      updatedAt: past,
    };
  }

  it('returns duePicked=0 + dispatched=0 when nothing is due', async () => {
    const { repo } = makeRepo();
    const { bridge } = makeBridge();
    const svc = new ValidationHarnessService(repo, bridge, LOCKED);
    const out = await svc.processTick();
    expect(out.duePicked).toBe(0);
    expect(out.dispatched).toBe(0);
    expect(out.errors).toEqual([]);
  });

  it('dispatches each due schedule + marks each run + records 0 errors on the happy path', async () => {
    const { repo, state } = makeRepo([
      makeDueRow('arc_a', { reason: 'V-203 weekly' }),
      makeDueRow('arc_b'),
    ]);
    const { bridge, calls } = makeBridge();
    const svc = new ValidationHarnessService(repo, bridge, LOCKED);
    const out = await svc.processTick({ now: new Date() });
    expect(out.duePicked).toBe(2);
    expect(out.dispatched).toBe(2);
    expect(out.errors).toEqual([]);
    expect(calls.map((c) => c.archetypeId).sort()).toEqual(['arc_a', 'arc_b']);
    expect(calls.find((c) => c.archetypeId === 'arc_a')?.reason).toBe('V-203 weekly');
    expect(state.marks).toHaveLength(2);
  });

  it('re-entrancy guard: an overlapping tick is skipped (no double-dispatch of the same due schedule)', async () => {
    const { repo, state } = makeRepo([makeDueRow('arc_a')]);
    // Blocking bridge: triggerRecapture holds until released, keeping tick 1
    // in flight (ticking=true, set synchronously before the first await) while
    // we fire an overlapping tick.
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let calls = 0;
    const bridge: ValidationHarnessRecaptureBridge = {
      triggerRecapture: async () => {
        calls += 1;
        await gate;
        return { id: 'run_1' };
      },
    };
    const svc = new ValidationHarnessService(repo, bridge, LOCKED);
    const p1 = svc.processTick({ now: new Date() });
    const out2 = await svc.processTick({ now: new Date() });
    expect(out2.skipped).toBe(true);
    expect(out2.duePicked).toBe(0);
    expect(out2.dispatched).toBe(0);
    release();
    const out1 = await p1;
    expect(out1.skipped).toBeUndefined();
    expect(out1.dispatched).toBe(1);
    expect(calls).toBe(1); // only ONE dispatch — the overlapping tick didn't double-fire
    expect(state.marks).toHaveLength(1);
  });

  it('records errors per archetype without aborting the batch', async () => {
    const { repo, state } = makeRepo([makeDueRow('arc_ok'), makeDueRow('arc_bad')]);
    const { bridge } = makeBridge({ fail: new Set(['arc_bad']) });
    const svc = new ValidationHarnessService(repo, bridge, LOCKED);
    const out = await svc.processTick();
    expect(out.duePicked).toBe(2);
    expect(out.dispatched).toBe(1);
    expect(out.errors).toHaveLength(1);
    expect(out.errors[0]?.archetypeId).toBe('arc_bad');
    expect(out.errors[0]?.message).toBe('boom-arc_bad');
    // Only the successful dispatch is marked.
    expect(state.marks.map((m) => m.archetypeId)).toEqual(['arc_ok']);
  });

  it('honours the batchSize cap', async () => {
    const { repo } = makeRepo([makeDueRow('arc_1'), makeDueRow('arc_2'), makeDueRow('arc_3')]);
    const { bridge } = makeBridge();
    const svc = new ValidationHarnessService(repo, bridge, LOCKED);
    const out = await svc.processTick({ batchSize: 2 });
    expect(out.duePicked).toBe(2);
    expect(out.dispatched).toBe(2);
  });
});
