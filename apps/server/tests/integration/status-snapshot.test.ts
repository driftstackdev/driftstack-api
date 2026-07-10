// V-295c2 — status snapshot writer tests.
//
// Drives StatusSnapshotService against an in-memory IncidentsRepo + a
// fake R2 client that records every putObject call. Asserts the JSON
// body shape, the public-only filter, and the windowing default.

import { describe, expect, it } from 'vitest';
import { IncidentsService } from '../../src/services/incidents.js';
import { STATUS_SNAPSHOT_KEY, StatusSnapshotService } from '../../src/services/status-snapshot.js';
import type { R2 } from '../../src/lib/r2.js';
import { InMemoryIncidentsRepo } from './_helpers/in-memory-incidents-repo.js';

interface PutCall {
  key: string;
  body: Buffer | Uint8Array | string;
  contentType?: string;
}

function fakeR2(): R2 & { calls: PutCall[] } {
  const calls: PutCall[] = [];
  return {
    bucket: 'driftstack-recordings',
    calls,
    // eslint-disable-next-line @typescript-eslint/require-await
    async headObject() {
      return { exists: true };
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    async putObject(args) {
      calls.push(args);
    },

    async deleteObject() {},
    // eslint-disable-next-line @typescript-eslint/require-await
    async presignPut() {
      return 'http://test/put';
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    async presignGet() {
      return 'http://test/get';
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    async listObjects() {
      return [];
    },
  };
}

const SILENT_LOGGER = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  trace() {},
  fatal() {},
  child() {
    return SILENT_LOGGER;
  },
} as never;

const ADMIN = '00000000-0000-4000-8000-000000000aaa';
const KEY = '00000000-0000-4000-8000-000000000bbb';

interface SnapshotBody {
  generated_at: string;
  data: { id: string; title: string; status: string; public: boolean }[];
}

describe('StatusSnapshotService', () => {
  it('writes a JSON snapshot of public incidents to R2', async () => {
    const repo = new InMemoryIncidentsRepo();
    const incidents = new IncidentsService(repo);
    const r2 = fakeR2();
    const service = new StatusSnapshotService(incidents, r2, SILENT_LOGGER);

    await incidents.create({
      title: 'public incident',
      description: 'd',
      severity: 'minor',
      affectedComponents: ['api'],
      public: true,
      startedAt: new Date('2026-05-07T00:00:00Z'),
      createdByAdminId: ADMIN,
      createdByAdminKeyId: KEY,
    });
    await incidents.create({
      title: 'private incident',
      description: 'd',
      severity: 'minor',
      affectedComponents: [],
      public: false,
      startedAt: new Date('2026-05-07T00:00:00Z'),
      createdByAdminId: ADMIN,
      createdByAdminKeyId: KEY,
    });

    const out = await service.processSnapshot(new Date('2026-05-07T01:00:00Z'));
    expect(out.count).toBe(1); // only the public one

    expect(r2.calls).toHaveLength(1);
    const call = r2.calls[0]!;
    expect(call.key).toBe(STATUS_SNAPSHOT_KEY);
    expect(call.contentType).toBe('application/json; charset=utf-8');

    const body = JSON.parse(
      typeof call.body === 'string' ? call.body : Buffer.from(call.body).toString('utf-8'),
    ) as SnapshotBody;
    expect(body.generated_at).toBe('2026-05-07T01:00:00.000Z');
    expect(body.data).toHaveLength(1);
    expect(body.data[0]!.title).toBe('public incident');
    expect(body.data[0]!.public).toBe(true);

    // The public R2 snapshot is a public egress (the status-site CF Pages
    // frontend reads it during API outages), so publicIncident MUST omit
    // the internal incident columns — same exclusion contract the
    // admin-incidents API mapper got a behavioral guard for (ea8775f1).
    // The incident above was seeded WITH createdByAdminId/KeyId populated;
    // assert neither casing (row camelCase nor wire snake_case), plus
    // autoProbeTarget, ever reaches the serialized snapshot — so a future
    // spread/renamed-field leak fails here, not silently on the status page.
    const incident0 = body.data[0]!;
    for (const internalField of [
      'createdByAdminId',
      'created_by_admin_id',
      'createdByAdminKeyId',
      'created_by_admin_key_id',
      'autoProbeTarget',
      'auto_probe_target',
    ]) {
      expect(incident0).not.toHaveProperty(internalField);
    }
  });

  it('overwrites the same key on every snapshot', async () => {
    const repo = new InMemoryIncidentsRepo();
    const incidents = new IncidentsService(repo);
    const r2 = fakeR2();
    const service = new StatusSnapshotService(incidents, r2, SILENT_LOGGER);

    await service.processSnapshot(new Date('2026-05-07T00:00:00Z'));
    await service.processSnapshot(new Date('2026-05-07T00:01:00Z'));
    await service.processSnapshot(new Date('2026-05-07T00:02:00Z'));

    expect(r2.calls).toHaveLength(3);
    expect(r2.calls.every((c) => c.key === STATUS_SNAPSHOT_KEY)).toBe(true);
  });

  it('respects the 30d default window — old incidents are excluded', async () => {
    const repo = new InMemoryIncidentsRepo();
    const incidents = new IncidentsService(repo);
    const r2 = fakeR2();
    const service = new StatusSnapshotService(incidents, r2, SILENT_LOGGER);

    const now = new Date('2026-05-07T00:00:00Z');
    await incidents.create({
      title: 'old',
      description: 'd',
      severity: 'minor',
      affectedComponents: [],
      public: true,
      startedAt: new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000), // 60 days ago
      createdByAdminId: ADMIN,
      createdByAdminKeyId: KEY,
    });
    await incidents.create({
      title: 'recent',
      description: 'd',
      severity: 'minor',
      affectedComponents: [],
      public: true,
      startedAt: new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000), // 5 days ago
      createdByAdminId: ADMIN,
      createdByAdminKeyId: KEY,
    });

    const out = await service.processSnapshot(now);
    expect(out.count).toBe(1);

    const body = JSON.parse(
      typeof r2.calls[0]!.body === 'string'
        ? r2.calls[0]!.body
        : Buffer.from(r2.calls[0]!.body).toString('utf-8'),
    ) as SnapshotBody;
    expect(body.data).toHaveLength(1);
    expect(body.data[0]!.title).toBe('recent');
  });

  it('uses a custom key + window when configured', async () => {
    const repo = new InMemoryIncidentsRepo();
    const incidents = new IncidentsService(repo);
    const r2 = fakeR2();
    const service = new StatusSnapshotService(incidents, r2, SILENT_LOGGER, {
      key: 'custom/snapshot.json',
      windowMs: 60 * 60 * 1000, // 1h
      limit: 10,
    });

    await service.processSnapshot(new Date('2026-05-07T00:00:00Z'));
    expect(r2.calls[0]!.key).toBe('custom/snapshot.json');
  });
});
