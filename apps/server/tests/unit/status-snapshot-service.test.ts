// V-553.B-27 — unit tests for StatusSnapshotService (V-295c2).
//
// Surface under test:
//   - processSnapshot writes a JSON envelope to R2 at the configured
//     key with the contentType the CF Pages fallback expects
//   - the envelope carries `generated_at` ISO + `data: Incident[]`,
//     with IncidentRow shape transformed to the public Incident shape
//     (id prefixed with `inc_`, snake_case fields, ISO timestamps)
//   - empty incident list still writes the snapshot (so a stale file
//     never persists)
//   - default resolved-history window=90d + limit=50 forwarded to publicFeed

import { describe, expect, it } from 'vitest';
import { STATUS_SNAPSHOT_KEY, StatusSnapshotService } from '../../src/services/status-snapshot.js';
import type {
  IncidentRow,
  IncidentsService,
  PublicIncidentFeedRows,
} from '../../src/services/incidents.js';
import type { R2 } from '../../src/lib/r2.js';
import type { Logger } from '../../src/lib/logger.js';

function makeR2(): {
  r2: R2;
  puts: Array<{ key: string; body: Buffer | Uint8Array | string; contentType?: string }>;
} {
  const puts: Array<{ key: string; body: Buffer | Uint8Array | string; contentType?: string }> = [];
  const r2: R2 = {
    headObject: () => Promise.resolve({ exists: false }),
    putObject: (args) => {
      puts.push(args);
      return Promise.resolve();
    },
    deleteObject: () => Promise.resolve(),
    presignPut: () => Promise.resolve('stub'),
    presignGet: () => Promise.resolve('stub'),
    listObjects: () => Promise.resolve([]),
    bucket: 'stub-bucket',
  };
  return { r2, puts };
}

function makeIncidents(rows: IncidentRow[]): {
  svc: IncidentsService;
  calls: Array<{ since: Date; limit: number }>;
} {
  const calls: Array<{ since: Date; limit: number }> = [];
  const svc = {
    publicFeed: (opts: { since: Date; limit: number }): Promise<PublicIncidentFeedRows> => {
      calls.push(opts);
      return Promise.resolve({
        rows,
        total: rows.length,
        openCount: rows.filter((row) => row.status !== 'resolved').length,
        openOutageCount: rows.filter(
          (row) => row.status !== 'resolved' && row.severity === 'outage',
        ).length,
        truncated: false,
      });
    },
  } as unknown as IncidentsService;
  return { svc, calls };
}

function makeLogger(): Logger {
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  } as unknown as Logger;
}

function makeIncident(overrides: Partial<IncidentRow> = {}): IncidentRow {
  return {
    id: 'inc_abc',
    title: 'API degraded',
    description: 'Increased 5xx rate from EU PoP.',
    severity: 'minor',
    status: 'investigating',
    affectedComponents: ['api'],
    public: true,
    startedAt: new Date('2026-05-10T08:00:00Z'),
    resolvedAt: null,
    createdByAdminId: null,
    createdByAdminKeyId: null,
    createdAt: new Date('2026-05-10T08:00:00Z'),
    updatedAt: new Date('2026-05-10T08:00:00Z'),
    ...overrides,
  } as unknown as IncidentRow;
}

const NOW = new Date('2026-05-11T12:00:00Z');

describe('V-553.B-27 StatusSnapshotService.processSnapshot — happy path', () => {
  it('writes a JSON snapshot to R2 at the default key + correct contentType', async () => {
    const { r2, puts } = makeR2();
    const { svc } = makeIncidents([makeIncident()]);
    const snapshot = new StatusSnapshotService(svc, r2, makeLogger());
    const result = await snapshot.processSnapshot(NOW);
    expect(result.count).toBe(1);
    expect(puts).toHaveLength(1);
    expect(puts[0]?.key).toBe(STATUS_SNAPSHOT_KEY);
    expect(puts[0]?.contentType).toBe('application/json; charset=utf-8');
  });

  it('envelope carries generated_at + data array with public-shaped incidents', async () => {
    const { r2, puts } = makeR2();
    const { svc } = makeIncidents([
      makeIncident({ id: 'a1', title: 'first' }),
      makeIncident({
        id: 'a2',
        title: 'second',
        status: 'resolved',
        resolvedAt: new Date('2026-05-09T10:00:00Z'),
      }),
    ]);
    const snapshot = new StatusSnapshotService(svc, r2, makeLogger());
    await snapshot.processSnapshot(NOW);
    const body = JSON.parse(String(puts[0]?.body)) as {
      generated_at: string;
      total: number;
      open_count: number;
      open_outage_count: number;
      truncated: boolean;
      data: Array<{
        id: string;
        title: string;
        resolved_at: string | null;
        affected_components: string[];
      }>;
    };
    expect(body.generated_at).toBe('2026-05-11T12:00:00.000Z');
    expect(body.data).toHaveLength(2);
    expect(body.data[0]?.id).toBe('inc_a1'); // public shape prefixes
    expect(body.data[0]?.title).toBe('first');
    expect(body.data[1]?.resolved_at).toBe('2026-05-09T10:00:00.000Z');
    expect(body.data[0]?.affected_components).toEqual(['api']);
    expect(body.total).toBe(2);
    expect(body.open_count).toBe(1);
    expect(body.open_outage_count).toBe(0);
    expect(body.truncated).toBe(false);
  });

  it('writes the snapshot even when the incident list is empty (overwrites stale)', async () => {
    const { r2, puts } = makeR2();
    const { svc } = makeIncidents([]);
    const snapshot = new StatusSnapshotService(svc, r2, makeLogger());
    const result = await snapshot.processSnapshot(NOW);
    expect(result.count).toBe(0);
    expect(puts).toHaveLength(1);
    const body = JSON.parse(String(puts[0]?.body)) as { data: unknown[] };
    expect(body.data).toEqual([]);
  });
});

describe('V-553.B-27 StatusSnapshotService.processSnapshot — config forwarding', () => {
  it('forwards default windowMs=90d + limit=50 to incidents.publicFeed', async () => {
    const { r2 } = makeR2();
    const { svc, calls } = makeIncidents([]);
    const snapshot = new StatusSnapshotService(svc, r2, makeLogger());
    await snapshot.processSnapshot(NOW);
    expect(calls[0]?.limit).toBe(50);
    const sinceMs = calls[0]?.since?.getTime() ?? 0;
    expect(NOW.getTime() - sinceMs).toBe(90 * 24 * 60 * 60 * 1000);
  });

  it('honours custom windowMs + limit + key overrides', async () => {
    const { r2, puts } = makeR2();
    const { svc, calls } = makeIncidents([]);
    const snapshot = new StatusSnapshotService(svc, r2, makeLogger(), {
      windowMs: 7 * 24 * 60 * 60 * 1000,
      limit: 10,
      key: 'status/staging-incidents.json',
    });
    await snapshot.processSnapshot(NOW);
    expect(calls[0]?.limit).toBe(10);
    const sinceMs = calls[0]?.since?.getTime() ?? 0;
    expect(NOW.getTime() - sinceMs).toBe(7 * 24 * 60 * 60 * 1000);
    expect(puts[0]?.key).toBe('status/staging-incidents.json');
  });
});
