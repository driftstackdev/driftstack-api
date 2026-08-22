// V-553.B-12 — unit tests for IncidentsService (V-295a).
//
// Surface under test:
//   - create(): commits incident + synthetic initial update, fires
//     onPublicCreated callback only for public incidents, callback
//     errors do NOT roll back the write
//   - list() / findOpenAutoIncident(): repo pass-throughs
//   - get(): NotFoundError on unknown, bundles updates on hit, honours
//     publicOnly opt
//   - addUpdate(): repo pass-through
//   - resolve(): fires onPublicResolved only for public incidents,
//     callback errors swallowed (write is source of truth)

import { describe, expect, it, vi } from 'vitest';
import {
  IncidentsService,
  type AddUpdateInput,
  type CreateIncidentInput,
  type IncidentRow,
  type IncidentUpdateRow,
  type IncidentsRepo,
  type ResolveIncidentInput,
} from '../../src/services/incidents.js';
import { NotFoundError } from '../../src/lib/errors-helpers.js';
// V-1305 — the page default has one home in the repo; this stub restated it.
import { INCIDENT_PAGE_DEFAULT } from '../../src/db/incidents-repo.js';

function makeRepo(): {
  repo: IncidentsRepo;
  state: {
    incidents: IncidentRow[];
    updates: IncidentUpdateRow[];
    autoIncident: IncidentRow | null;
  };
} {
  const state = {
    incidents: [] as IncidentRow[],
    updates: [] as IncidentUpdateRow[],
    autoIncident: null as IncidentRow | null,
  };
  let incidentCounter = 0;
  let updateCounter = 0;
  const repo: IncidentsRepo = {
    createWithInitialUpdate: (input: CreateIncidentInput, explicitId?: string) => {
      const existing =
        explicitId === undefined ? undefined : state.incidents.find((row) => row.id === explicitId);
      if (existing) {
        const initial = state.updates.find((row) => row.incidentId === existing.id);
        if (!initial) throw new Error('missing initial update');
        const matches =
          existing.title === input.title &&
          existing.description === input.description &&
          existing.startedAt.getTime() === input.startedAt.getTime();
        return Promise.resolve({
          outcome: matches ? ('replayed' as const) : ('mismatch' as const),
          incident: existing,
          update: initial,
        });
      }
      incidentCounter += 1;
      const row: IncidentRow = {
        id: explicitId ?? `inc_${incidentCounter.toString()}`,
        title: input.title,
        description: input.description,
        severity: input.severity,
        status: input.status ?? 'investigating',
        affectedComponents: input.affectedComponents,
        public: input.public,
        startedAt: input.startedAt,
        resolvedAt: (input.status ?? 'investigating') === 'resolved' ? new Date() : null,
        createdByAdminId: input.createdByAdminId,
        createdByAdminKeyId: input.createdByAdminKeyId,
        autoProbeTarget: input.autoProbeTarget ?? null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      state.incidents.push(row);
      updateCounter += 1;
      const update: IncidentUpdateRow = {
        id: `iu_${updateCounter.toString()}`,
        incidentId: row.id,
        message: input.description,
        status: row.status,
        postedByAdminId: input.createdByAdminId,
        postedByAdminKeyId: input.createdByAdminKeyId,
        postedAt: new Date(),
      };
      state.updates.push(update);
      return Promise.resolve({ outcome: 'created' as const, incident: row, update });
    },
    list: ({ scope }) =>
      Promise.resolve(
        scope === 'public' ? state.incidents.filter((i) => i.public) : state.incidents,
      ),
    listPage: ({
      scope,
      state: lifecycleState,
      severity,
      since,
      limit = INCIDENT_PAGE_DEFAULT,
    }) => {
      let rows = scope === 'public' ? state.incidents.filter((i) => i.public) : state.incidents;
      const openCount = rows.filter((row) => row.status !== 'resolved').length;
      if (since) rows = rows.filter((i) => i.startedAt >= since);
      if (lifecycleState === 'open') rows = rows.filter((i) => i.status !== 'resolved');
      if (lifecycleState === 'resolved') rows = rows.filter((i) => i.status === 'resolved');
      if (severity) rows = rows.filter((i) => i.severity === severity);
      rows = [...rows].sort(
        (a, b) => b.startedAt.getTime() - a.startedAt.getTime() || b.id.localeCompare(a.id),
      );
      return Promise.resolve({
        rows: rows.slice(0, limit),
        total: rows.length,
        openCount,
        nextCursor: null,
      });
    },
    publicFeed: ({ since, limit }) => {
      const publicRows = state.incidents.filter((row) => row.public);
      const newestFirst = (left: IncidentRow, right: IncidentRow): number =>
        right.startedAt.getTime() - left.startedAt.getTime() || right.id.localeCompare(left.id);
      const open = publicRows.filter((row) => row.status !== 'resolved').sort(newestFirst);
      const resolved = publicRows
        .filter((row) => row.status === 'resolved' && row.startedAt >= since)
        .sort(newestFirst);
      const rows = [
        ...open.slice(0, limit),
        ...resolved.slice(0, Math.max(0, limit - open.length)),
      ];
      const total = open.length + resolved.length;
      return Promise.resolve({
        rows,
        total,
        openCount: open.length,
        openOutageCount: open.filter((row) => row.severity === 'outage').length,
        truncated: rows.length < total,
      });
    },
    get: (id, opts) => {
      const row = state.incidents.find((i) => i.id === id) ?? null;
      if (row !== null && opts?.publicOnly === true && !row.public) return Promise.resolve(null);
      return Promise.resolve(row);
    },
    listUpdates: (incidentId) =>
      Promise.resolve(state.updates.filter((u) => u.incidentId === incidentId)),
    addUpdate: (input: AddUpdateInput) => {
      updateCounter += 1;
      const u: IncidentUpdateRow = {
        id: `iu_${updateCounter.toString()}`,
        incidentId: input.incidentId,
        message: input.message,
        status: input.status,
        postedByAdminId: input.postedByAdminId,
        postedByAdminKeyId: input.postedByAdminKeyId,
        postedAt: new Date(),
      };
      state.updates.push(u);
      const incident = state.incidents.find((i) => i.id === input.incidentId);
      if (incident) incident.status = input.status;
      return Promise.resolve(u);
    },
    resolve: (input: ResolveIncidentInput) => {
      const incident = state.incidents.find((i) => i.id === input.incidentId);
      if (!incident) throw new Error('not found');
      updateCounter += 1;
      const update: IncidentUpdateRow = {
        id: `iu_${updateCounter.toString()}`,
        incidentId: incident.id,
        message: input.message,
        status: 'resolved',
        postedByAdminId: input.postedByAdminId,
        postedByAdminKeyId: input.postedByAdminKeyId,
        postedAt: new Date(),
      };
      incident.status = 'resolved';
      incident.resolvedAt = new Date();
      state.updates.push(update);
      return Promise.resolve({ incident, update });
    },
    findOpenAutoIncident: () => Promise.resolve(state.autoIncident),
    // 2026-05-22 — admin reopen (false-alarm correction). Mirrors
    // the resolve() stub above but flips status back to
    // 'investigating' + clears resolved_at.
    reopen: (input: {
      incidentId: string;
      message: string;
      postedByAdminId: string;
      postedByAdminKeyId: string;
    }) => {
      const incident = state.incidents.find((i) => i.id === input.incidentId);
      if (!incident) throw new Error('not found');
      updateCounter += 1;
      const update: IncidentUpdateRow = {
        id: `iu_${updateCounter.toString()}`,
        incidentId: incident.id,
        message: input.message,
        status: 'investigating',
        postedByAdminId: input.postedByAdminId,
        postedByAdminKeyId: input.postedByAdminKeyId,
        postedAt: new Date(),
      };
      incident.status = 'investigating';
      incident.resolvedAt = null;
      state.updates.push(update);
      return Promise.resolve({ incident, update });
    },
  };
  return { repo, state };
}

const BASE_INPUT: CreateIncidentInput = {
  title: 'API blip',
  description: 'investigating',
  severity: 'minor',
  status: 'investigating',
  affectedComponents: ['api'],
  public: true,
  startedAt: new Date('2026-05-11T15:00:00Z'),
  createdByAdminId: 'adm_1',
  createdByAdminKeyId: 'key_1',
};

describe('V-553.B-12 IncidentsService.create', () => {
  it('commits the incident + a synthetic initial update with matching status', async () => {
    const { repo, state } = makeRepo();
    const svc = new IncidentsService(repo);
    const result = await svc.create(BASE_INPUT);
    expect(state.incidents).toHaveLength(1);
    expect(state.updates).toHaveLength(1);
    expect(result.update.message).toBe('investigating');
    expect(result.update.status).toBe('investigating');
    expect(result.update.incidentId).toBe(result.incident.id);
  });

  it('fires onPublicCreated when the incident is public', async () => {
    const { repo } = makeRepo();
    const onPublicCreated = vi.fn(() => Promise.resolve());
    const svc = new IncidentsService(repo, { onPublicCreated });
    await svc.create({ ...BASE_INPUT, public: true });
    expect(onPublicCreated).toHaveBeenCalledTimes(1);
  });

  it('does NOT fire onPublicCreated when the incident is internal', async () => {
    const { repo } = makeRepo();
    const onPublicCreated = vi.fn(() => Promise.resolve());
    const svc = new IncidentsService(repo, { onPublicCreated });
    await svc.create({ ...BASE_INPUT, public: false });
    expect(onPublicCreated).not.toHaveBeenCalled();
  });

  it('swallows lifecycle callback failures — incident write succeeds anyway', async () => {
    const { repo, state } = makeRepo();
    const onPublicCreated = vi.fn(() => Promise.reject(new Error('notification down')));
    const svc = new IncidentsService(repo, { onPublicCreated });
    const result = await svc.create(BASE_INPUT);
    expect(result.incident.id).toBeTruthy();
    expect(state.incidents).toHaveLength(1);
  });

  it('same-id replay returns the original atomic write and emits lifecycle once', async () => {
    const { repo, state } = makeRepo();
    const onPublicCreated = vi.fn(() => Promise.resolve());
    const svc = new IncidentsService(repo, { onPublicCreated });
    const first = await svc.createWithId('00000000-0000-4000-8000-000000000123', BASE_INPUT);
    const replay = await svc.createWithId('00000000-0000-4000-8000-000000000123', BASE_INPUT);
    expect(first.outcome).toBe('created');
    expect(replay.outcome).toBe('replayed');
    expect(replay.incident.id).toBe(first.incident.id);
    expect(replay.update.id).toBe(first.update.id);
    expect(state.incidents).toHaveLength(1);
    expect(state.updates).toHaveLength(1);
    expect(onPublicCreated).toHaveBeenCalledTimes(1);
  });

  it('same id with a different request is an authoritative conflict', async () => {
    const { repo, state } = makeRepo();
    const svc = new IncidentsService(repo);
    const id = '00000000-0000-4000-8000-000000000124';
    await svc.createWithId(id, BASE_INPUT);
    await expect(
      svc.createWithId(id, { ...BASE_INPUT, description: 'different body' }),
    ).rejects.toThrow('already used with a different create request');
    expect(state.incidents).toHaveLength(1);
    expect(state.updates).toHaveLength(1);
  });
});

describe('V-553.B-12 IncidentsService.get', () => {
  it('throws NotFoundError for an unknown id', async () => {
    const { repo } = makeRepo();
    const svc = new IncidentsService(repo);
    await expect(svc.get('inc_does_not_exist')).rejects.toThrow(NotFoundError);
  });

  it('returns the incident + its updates on hit', async () => {
    const { repo } = makeRepo();
    const svc = new IncidentsService(repo);
    const created = await svc.create(BASE_INPUT);
    const result = await svc.get(created.incident.id);
    expect(result.incident.id).toBe(created.incident.id);
    expect(result.updates).toHaveLength(1);
  });

  it('publicOnly:true hides internal incidents', async () => {
    const { repo } = makeRepo();
    const svc = new IncidentsService(repo);
    const created = await svc.create({ ...BASE_INPUT, public: false });
    await expect(svc.get(created.incident.id, { publicOnly: true })).rejects.toThrow(NotFoundError);
    // Same incident still readable to admin (no publicOnly opt).
    const admin = await svc.get(created.incident.id);
    expect(admin.incident.id).toBe(created.incident.id);
  });
});

describe('V-553.B-12 IncidentsService.list + findOpenAutoIncident', () => {
  it('list() with scope=public hides internal incidents', async () => {
    const { repo } = makeRepo();
    const svc = new IncidentsService(repo);
    await svc.create({ ...BASE_INPUT, public: true, title: 'public 1' });
    await svc.create({ ...BASE_INPUT, public: false, title: 'internal 1' });
    const publicList = await svc.list({ scope: 'public' });
    expect(publicList.map((i) => i.title)).toEqual(['public 1']);
    const fullList = await svc.list({ scope: 'all' });
    expect(fullList).toHaveLength(2);
  });

  it('publicFeed never windows open incidents and reports exact truncation metadata', async () => {
    const { repo } = makeRepo();
    const svc = new IncidentsService(repo);
    const now = new Date('2026-07-17T12:00:00.000Z');
    await svc.create({
      ...BASE_INPUT,
      title: 'old-open',
      startedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    const recentResolved = await svc.create({
      ...BASE_INPUT,
      title: 'recent-resolved',
      startedAt: new Date('2026-07-10T00:00:00.000Z'),
    });
    await svc.resolve({
      incidentId: recentResolved.incident.id,
      message: 'resolved',
      postedByAdminId: 'adm_1',
      postedByAdminKeyId: 'key_1',
    });
    const oldResolved = await svc.create({
      ...BASE_INPUT,
      title: 'old-resolved',
      startedAt: new Date('2026-01-02T00:00:00.000Z'),
    });
    await svc.resolve({
      incidentId: oldResolved.incident.id,
      message: 'resolved',
      postedByAdminId: 'adm_1',
      postedByAdminKeyId: 'key_1',
    });

    const feed = await svc.publicFeed({
      since: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000),
      limit: 10,
    });
    expect(feed.rows.map((row) => row.title)).toEqual(['old-open', 'recent-resolved']);
    expect(feed.openCount).toBe(1);
    expect(feed.openOutageCount).toBe(0);
    expect(feed.total).toBe(2);
    expect(feed.truncated).toBe(false);

    const truncated = await svc.publicFeed({
      since: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000),
      limit: 1,
    });
    expect(truncated.rows.map((row) => row.title)).toEqual(['old-open']);
    expect(truncated.total).toBe(2);
    expect(truncated.truncated).toBe(true);
  });

  it('findOpenAutoIncident proxies through to the repo', async () => {
    const { repo, state } = makeRepo();
    state.autoIncident = {
      id: 'inc_auto',
      title: 'api down',
      description: 'auto',
      severity: 'major',
      status: 'investigating',
      affectedComponents: ['api'],
      public: true,
      startedAt: new Date(),
      resolvedAt: null,
      createdByAdminId: null,
      createdByAdminKeyId: null,
      autoProbeTarget: 'api',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const svc = new IncidentsService(repo);
    const result = await svc.findOpenAutoIncident('api');
    expect(result?.id).toBe('inc_auto');
  });
});

describe('V-553.B-12 IncidentsService.addUpdate', () => {
  it('forwards the update to the repo and returns the new row', async () => {
    const { repo, state } = makeRepo();
    const svc = new IncidentsService(repo);
    const created = await svc.create(BASE_INPUT);
    const update = await svc.addUpdate({
      incidentId: created.incident.id,
      message: 'monitoring',
      status: 'monitoring',
      postedByAdminId: 'adm_1',
      postedByAdminKeyId: 'key_1',
    });
    expect(update.status).toBe('monitoring');
    expect(state.updates).toHaveLength(2); // initial + this one
    expect(state.incidents[0]?.status).toBe('monitoring');
  });

  it('V-545.B fires onPublicUpdated when the incident is public', async () => {
    const { repo } = makeRepo();
    const onPublicUpdated = vi.fn(() => Promise.resolve());
    const svc = new IncidentsService(repo, { onPublicUpdated });
    const created = await svc.create(BASE_INPUT);
    await svc.addUpdate({
      incidentId: created.incident.id,
      message: 'monitoring',
      status: 'monitoring',
      postedByAdminId: 'adm_1',
      postedByAdminKeyId: 'key_1',
    });
    expect(onPublicUpdated).toHaveBeenCalledTimes(1);
    const call = onPublicUpdated.mock.calls[0] as [{ id: string }, { message: string }] | undefined;
    expect(call?.[0]?.id).toBe(created.incident.id);
    expect(call?.[1]?.message).toBe('monitoring');
  });

  it('V-545.B does NOT fire onPublicUpdated when the incident is internal (public=false)', async () => {
    const { repo } = makeRepo();
    const onPublicUpdated = vi.fn(() => Promise.resolve());
    const svc = new IncidentsService(repo, { onPublicUpdated });
    const created = await svc.create({ ...BASE_INPUT, public: false });
    await svc.addUpdate({
      incidentId: created.incident.id,
      message: 'monitoring',
      status: 'monitoring',
      postedByAdminId: 'adm_1',
      postedByAdminKeyId: 'key_1',
    });
    expect(onPublicUpdated).not.toHaveBeenCalled();
  });

  it('V-545.B swallows onPublicUpdated failures — addUpdate write succeeds', async () => {
    const { repo, state } = makeRepo();
    const onPublicUpdated = vi.fn(() => Promise.reject(new Error('mailer down')));
    const svc = new IncidentsService(repo, { onPublicUpdated });
    const created = await svc.create(BASE_INPUT);
    const update = await svc.addUpdate({
      incidentId: created.incident.id,
      message: 'monitoring',
      status: 'monitoring',
      postedByAdminId: 'adm_1',
      postedByAdminKeyId: 'key_1',
    });
    expect(update.status).toBe('monitoring');
    expect(state.updates).toHaveLength(2);
  });
});

describe('V-553.B-12 IncidentsService.resolve', () => {
  it('flips status to resolved + fires onPublicResolved for public incidents', async () => {
    const { repo, state } = makeRepo();
    const onPublicResolved = vi.fn(() => Promise.resolve());
    const svc = new IncidentsService(repo, { onPublicResolved });
    const created = await svc.create(BASE_INPUT);
    const result = await svc.resolve({
      incidentId: created.incident.id,
      message: 'all clear',
      postedByAdminId: 'adm_1',
      postedByAdminKeyId: 'key_1',
    });
    expect(result.incident.status).toBe('resolved');
    expect(result.incident.resolvedAt).not.toBeNull();
    expect(state.updates).toHaveLength(2); // initial + final
    expect(onPublicResolved).toHaveBeenCalledTimes(1);
  });

  it('does NOT fire onPublicResolved when the incident is internal', async () => {
    const { repo } = makeRepo();
    const onPublicResolved = vi.fn(() => Promise.resolve());
    const svc = new IncidentsService(repo, { onPublicResolved });
    const created = await svc.create({ ...BASE_INPUT, public: false });
    await svc.resolve({
      incidentId: created.incident.id,
      message: 'all clear',
      postedByAdminId: 'adm_1',
      postedByAdminKeyId: 'key_1',
    });
    expect(onPublicResolved).not.toHaveBeenCalled();
  });

  it('swallows onPublicResolved failures — resolve write is source of truth', async () => {
    const { repo, state } = makeRepo();
    const onPublicResolved = vi.fn(() => Promise.reject(new Error('email down')));
    const svc = new IncidentsService(repo, { onPublicResolved });
    const created = await svc.create(BASE_INPUT);
    const result = await svc.resolve({
      incidentId: created.incident.id,
      message: 'all clear',
      postedByAdminId: 'adm_1',
      postedByAdminKeyId: 'key_1',
    });
    expect(result.incident.status).toBe('resolved');
    expect(state.incidents[0]?.resolvedAt).not.toBeNull();
  });
});
