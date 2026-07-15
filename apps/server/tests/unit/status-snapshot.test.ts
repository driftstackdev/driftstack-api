// V-553.B-6 — unit tests for V-295c2 StatusSnapshotService.

import { describe, expect, it, vi } from 'vitest';
import { STATUS_SNAPSHOT_KEY, StatusSnapshotService } from '../../src/services/status-snapshot.js';
import type { IncidentRow, IncidentsService } from '../../src/services/incidents.js';
import type { R2 } from '../../src/lib/r2.js';
import type { Logger } from '../../src/lib/logger.js';

function makeRow(overrides: Partial<IncidentRow> = {}): IncidentRow {
  return {
    id: 'i1',
    title: 'API blip',
    description: 'investigating',
    severity: 'minor',
    status: 'monitoring',
    affectedComponents: ['api'],
    public: true,
    startedAt: new Date('2026-05-11T15:00:00Z'),
    resolvedAt: null,
    createdByAdminId: null,
    createdByAdminKeyId: null,
    autoProbeTarget: null,
    createdAt: new Date('2026-05-11T15:00:00Z'),
    updatedAt: new Date('2026-05-11T15:00:00Z'),
    ...overrides,
  };
}

function makeFixture(rows: IncidentRow[]): {
  svc: StatusSnapshotService;
  putCalls: Array<{ key: string; body: Buffer; contentType?: string }>;
  listSpy: ReturnType<typeof vi.fn>;
} {
  const listSpy = vi.fn<IncidentsService['list']>(() => Promise.resolve(rows));
  const incidents = { list: listSpy } as unknown as IncidentsService;
  const putCalls: Array<{ key: string; body: Buffer; contentType?: string }> = [];
  const r2 = {
    putObject: (args: { key: string; body: Buffer; contentType?: string }) => {
      putCalls.push(args);
      return Promise.resolve();
    },
  } as unknown as R2;
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
  } as unknown as Logger;
  return {
    svc: new StatusSnapshotService(incidents, r2, logger),
    putCalls,
    listSpy,
  };
}

describe('V-553.B-6 StatusSnapshotService — processSnapshot', () => {
  it('writes to the canonical R2 key with JSON content-type', async () => {
    const { svc, putCalls } = makeFixture([makeRow()]);
    await svc.processSnapshot(new Date('2026-05-11T16:00:00Z'));
    expect(putCalls).toHaveLength(1);
    expect(putCalls[0]?.key).toBe(STATUS_SNAPSHOT_KEY);
    expect(putCalls[0]?.contentType).toBe('application/json; charset=utf-8');
  });

  it('JSON body carries generated_at + data envelope', async () => {
    const { svc, putCalls } = makeFixture([makeRow({ id: 'abc-123' })]);
    const now = new Date('2026-05-11T16:00:00Z');
    await svc.processSnapshot(now);
    const body = JSON.parse((putCalls[0]?.body as Buffer).toString('utf-8')) as {
      generated_at: string;
      data: Array<{ id: string; severity: string }>;
    };
    expect(body.generated_at).toBe('2026-05-11T16:00:00.000Z');
    expect(body.data).toHaveLength(1);
    expect(body.data[0]?.id).toBe('inc_abc-123');
    expect(body.data[0]?.severity).toBe('minor');
  });

  it('passes the configured window + limit to incidents.list', async () => {
    const { svc, listSpy } = makeFixture([]);
    const now = new Date('2026-05-11T16:00:00Z');
    await svc.processSnapshot(now);
    expect(listSpy).toHaveBeenCalledTimes(1);
    const call = listSpy.mock.calls[0]?.[0] as
      { scope: string; limit: number; since: Date } | undefined;
    expect(call?.scope).toBe('public');
    expect(call?.limit).toBe(50);
    // Default window: 30 days back.
    const expectedSince = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    expect(call?.since.toISOString()).toBe(expectedSince.toISOString());
  });

  it('honours custom windowMs + limit + key', async () => {
    const listSpy = vi.fn<IncidentsService['list']>(() => Promise.resolve([]));
    const incidents = { list: listSpy } as unknown as IncidentsService;
    const putCalls: Array<{ key: string }> = [];
    const r2 = {
      putObject: (args: { key: string }) => {
        putCalls.push(args);
        return Promise.resolve();
      },
    } as unknown as R2;
    const logger = { debug: vi.fn() } as unknown as Logger;
    const svc = new StatusSnapshotService(incidents, r2, logger, {
      windowMs: 60 * 60 * 1000,
      limit: 5,
      key: 'custom/key.json',
    });
    const now = new Date('2026-05-11T16:00:00Z');
    await svc.processSnapshot(now);
    expect(listSpy.mock.calls[0]?.[0]?.limit).toBe(5);
    expect(putCalls[0]?.key).toBe('custom/key.json');
    const expectedSince = new Date(now.getTime() - 60 * 60 * 1000);
    expect(listSpy.mock.calls[0]?.[0]?.since?.toISOString()).toBe(expectedSince.toISOString());
  });

  it('returns count + bytes of the snapshot written', async () => {
    const { svc } = makeFixture([makeRow(), makeRow({ id: 'i2' })]);
    const r = await svc.processSnapshot(new Date('2026-05-11T16:00:00Z'));
    expect(r.count).toBe(2);
    expect(r.bytes).toBeGreaterThan(0);
  });

  it('skips an overlapping writer, then publishes the newer snapshot on the next tick', async () => {
    const listSpy = vi.fn<IncidentsService['list']>(() => Promise.resolve([makeRow()]));
    const incidents = { list: listSpy } as unknown as IncidentsService;
    let releaseFirstPut!: () => void;
    const firstPutPending = new Promise<void>((resolvePut) => {
      releaseFirstPut = resolvePut;
    });
    let putCount = 0;
    let publishedAt: string | null = null;
    const r2 = {
      putObject: async (args: { body: Buffer | Uint8Array | string }) => {
        putCount += 1;
        const generatedAt = (
          JSON.parse(Buffer.from(args.body).toString('utf-8')) as { generated_at: string }
        ).generated_at;
        if (putCount === 1) await firstPutPending;
        publishedAt = generatedAt;
      },
    } as unknown as R2;
    const warn = vi.fn();
    const logger = { debug: vi.fn(), warn } as unknown as Logger;
    const svc = new StatusSnapshotService(incidents, r2, logger);
    const older = new Date('2026-05-11T16:00:00Z');
    const newer = new Date('2026-05-11T16:01:00Z');

    const first = svc.processSnapshot(older);
    await vi.waitFor(() => expect(putCount).toBe(1));
    const overlap = await svc.processSnapshot(newer);
    expect(overlap).toEqual({ count: 0, bytes: 0 });
    expect(listSpy).toHaveBeenCalledTimes(1);
    expect(putCount).toBe(1);
    expect(publishedAt).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);

    releaseFirstPut();
    await first;
    expect(publishedAt).toBe(older.toISOString());

    const retry = await svc.processSnapshot(newer);
    expect(retry.count).toBe(1);
    expect(listSpy).toHaveBeenCalledTimes(2);
    expect(putCount).toBe(2);
    expect(publishedAt).toBe(newer.toISOString());
  });

  it('releases the single-flight guard after a failed R2 write', async () => {
    const listSpy = vi.fn<IncidentsService['list']>(() => Promise.resolve([makeRow()]));
    const incidents = { list: listSpy } as unknown as IncidentsService;
    const putObject = vi.fn<R2['putObject']>();
    putObject.mockRejectedValueOnce(new Error('synthetic R2 failure')).mockResolvedValueOnce();
    const r2 = { putObject } as unknown as R2;
    const logger = { debug: vi.fn(), warn: vi.fn() } as unknown as Logger;
    const svc = new StatusSnapshotService(incidents, r2, logger);

    await expect(svc.processSnapshot(new Date('2026-05-11T16:00:00Z'))).rejects.toThrow(
      'synthetic R2 failure',
    );
    const retry = await svc.processSnapshot(new Date('2026-05-11T16:01:00Z'));
    expect(retry.count).toBe(1);
    expect(listSpy).toHaveBeenCalledTimes(2);
    expect(putObject).toHaveBeenCalledTimes(2);
  });

  it('renders inc_ prefix on row.id (matches public API wire shape)', async () => {
    const { svc, putCalls } = makeFixture([makeRow({ id: 'i-abc' })]);
    await svc.processSnapshot(new Date('2026-05-11T16:00:00Z'));
    const body = JSON.parse((putCalls[0]?.body as Buffer).toString('utf-8')) as {
      data: Array<{ id: string }>;
    };
    expect(body.data[0]?.id).toBe('inc_i-abc');
  });
});

describe('V-553.B-6 StatusSnapshotService — STATUS_SNAPSHOT_KEY constant', () => {
  it('is the documented path', () => {
    expect(STATUS_SNAPSHOT_KEY).toBe('status/incidents-public.json');
  });
});
