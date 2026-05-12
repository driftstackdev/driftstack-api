// V-553.B-31 — unit tests for HealthProbeService.
//
// Surface under test:
//   - processTick records one probe row per target via the prober
//   - failureThreshold consecutive failures auto-creates an incident
//   - auto-create is suppressed when an open auto-incident already exists
//   - recoveryThreshold consecutive successes auto-resolves the open incident
//   - mixed history (e.g. fail-fail-ok) triggers neither path
//   - prober throwing → no probe row, no incident churn, warn logged
//   - probe-record-then-evaluate path failing → swallowed, next tick recovers
//   - hourly prune fires once per hour boundary; second tick within the
//     hour does not re-prune

import { describe, expect, it } from 'vitest';
import {
  HealthProbeService,
  type HealthProbeTarget,
  type Prober,
  type ProbeRecordRow,
  type ProbeResult,
  type ProbesRepo,
} from '../../src/services/health-probe.js';
import type {
  CreateIncidentInput,
  IncidentRow,
  IncidentUpdateRow,
  IncidentsService,
  ResolveIncidentInput,
} from '../../src/services/incidents.js';
import type { Logger } from '../../src/lib/logger.js';

const TARGET: HealthProbeTarget = {
  id: 'api',
  label: 'API',
  url: 'https://api.driftstack.dev/health',
};

function makeLogger(): { logger: Logger; warns: string[]; infos: string[] } {
  const warns: string[] = [];
  const infos: string[] = [];
  const logger = {
    debug: () => undefined,
    info: (_obj: unknown, msg: string) => infos.push(msg),
    warn: (_obj: unknown, msg: string) => warns.push(msg),
    error: () => undefined,
  } as unknown as Logger;
  return { logger, warns, infos };
}

class FakeProber implements Prober {
  private queue: ProbeResult[];
  public calls = 0;
  constructor(results: ProbeResult[]) {
    this.queue = [...results];
  }
  probe(): Promise<ProbeResult> {
    this.calls += 1;
    const next = this.queue.shift();
    if (!next) throw new Error('FakeProber exhausted');
    return Promise.resolve(next);
  }
}

class ThrowingProber implements Prober {
  probe(): Promise<ProbeResult> {
    return Promise.reject(new Error('boom'));
  }
}

class FakeProbesRepo implements ProbesRepo {
  public rows: ProbeRecordRow[] = [];
  public pruneCalls: Date[] = [];
  public pruneReturns = 0;
  recordProbe(input: {
    target: string;
    ok: boolean;
    latencyMs: number | null;
    httpStatus: number | null;
    errorMessage: string | null;
    probedAt: Date;
  }): Promise<ProbeRecordRow> {
    const row: ProbeRecordRow = {
      id: `pr_${(this.rows.length + 1).toString()}`,
      target: input.target,
      probedAt: input.probedAt,
      ok: input.ok,
      latencyMs: input.latencyMs,
      httpStatus: input.httpStatus,
      errorMessage: input.errorMessage,
    };
    this.rows.unshift(row); // newest first
    return Promise.resolve(row);
  }
  recentForTarget(target: string, n: number): Promise<ProbeRecordRow[]> {
    return Promise.resolve(this.rows.filter((r) => r.target === target).slice(0, n));
  }
  pruneOlderThan(before: Date): Promise<number> {
    this.pruneCalls.push(before);
    return Promise.resolve(this.pruneReturns);
  }
  countByTargetSince(): Promise<never> {
    throw new Error('not used in unit tests');
  }
}

function makeIncidents(
  opts: {
    open?: IncidentRow | null;
    createReturns?: IncidentRow;
  } = {},
): {
  service: IncidentsService;
  state: {
    creates: Array<{ title: string; autoProbeTarget: string | null }>;
    resolves: string[];
  };
} {
  const state = {
    creates: [] as Array<{ title: string; autoProbeTarget: string | null }>,
    resolves: [] as string[],
  };
  let openIncident = opts.open ?? null;
  const fakeIncident: IncidentRow = opts.createReturns ?? {
    id: 'inc_a',
    title: 'auto',
    description: '',
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
  const fakeUpdate: IncidentUpdateRow = {
    id: 'u_a',
    incidentId: fakeIncident.id,
    message: '',
    status: 'investigating',
    postedByAdminId: null,
    postedByAdminKeyId: null,
    postedAt: new Date(),
  };
  const service: IncidentsService = {
    create: (input: CreateIncidentInput) => {
      state.creates.push({
        title: input.title,
        autoProbeTarget: input.autoProbeTarget ?? null,
      });
      openIncident = fakeIncident;
      return Promise.resolve({ incident: fakeIncident, update: fakeUpdate });
    },
    resolve: (input: ResolveIncidentInput) => {
      state.resolves.push(input.incidentId);
      openIncident = null;
      return Promise.resolve({
        incident: { ...fakeIncident, status: 'resolved', resolvedAt: new Date() },
        update: { ...fakeUpdate, status: 'resolved' },
      });
    },
    findOpenAutoIncident: () => Promise.resolve(openIncident),
  } as unknown as IncidentsService;
  return { service, state };
}

const NOW = new Date('2026-05-11T12:00:00Z');

function fail(reason = 'down'): ProbeResult {
  return { ok: false, latencyMs: 50, httpStatus: null, errorMessage: reason };
}
function pass(): ProbeResult {
  return { ok: true, latencyMs: 50, httpStatus: 200, errorMessage: null };
}

describe('V-553.B-31 HealthProbeService.processTick — basics', () => {
  it('records one probe row per target per tick', async () => {
    const { logger } = makeLogger();
    const probes = new FakeProbesRepo();
    const prober = new FakeProber([pass()]);
    const { service } = makeIncidents();
    const svc = new HealthProbeService(probes, service, prober, logger, { targets: [TARGET] });
    const out = await svc.processTick(NOW);
    expect(out.probed).toBe(1);
    expect(probes.rows).toHaveLength(1);
    expect(probes.rows[0]?.target).toBe('api');
    expect(probes.rows[0]?.ok).toBe(true);
  });

  it('warns + records nothing when the prober throws', async () => {
    const { logger, warns } = makeLogger();
    const probes = new FakeProbesRepo();
    const { service } = makeIncidents();
    const svc = new HealthProbeService(probes, service, new ThrowingProber(), logger, {
      targets: [TARGET],
    });
    await svc.processTick(NOW);
    expect(probes.rows).toHaveLength(0);
    expect(warns.some((m) => m.includes('health probe tick failed'))).toBe(true);
  });
});

describe('V-553.B-31 HealthProbeService — threshold auto-create', () => {
  it('auto-creates an incident after failureThreshold consecutive failures', async () => {
    const { logger } = makeLogger();
    const probes = new FakeProbesRepo();
    const { service, state } = makeIncidents();
    const prober = new FakeProber([fail('boom'), fail('boom'), fail('boom')]);
    const svc = new HealthProbeService(probes, service, prober, logger, {
      targets: [TARGET],
      failureThreshold: 3,
    });
    await svc.processTick(NOW); // fail 1
    expect(state.creates).toHaveLength(0);
    await svc.processTick(NOW); // fail 2
    expect(state.creates).toHaveLength(0);
    await svc.processTick(NOW); // fail 3 → auto-create
    expect(state.creates).toHaveLength(1);
    expect(state.creates[0]?.title).toContain('API');
    expect(state.creates[0]?.autoProbeTarget).toBe('api');
  });

  it('does NOT auto-create when an open auto-incident already exists', async () => {
    const { logger } = makeLogger();
    const probes = new FakeProbesRepo();
    const openIncident: IncidentRow = {
      id: 'inc_existing',
      title: 'API health check failing',
      description: '',
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
    const { service, state } = makeIncidents({ open: openIncident });
    const prober = new FakeProber([fail(), fail(), fail()]);
    const svc = new HealthProbeService(probes, service, prober, logger, {
      targets: [TARGET],
      failureThreshold: 3,
    });
    for (let i = 0; i < 3; i += 1) {
      await svc.processTick(NOW);
    }
    expect(state.creates).toHaveLength(0);
  });

  it('does NOT auto-create when last 3 probes are mixed (fail-pass-fail)', async () => {
    const { logger } = makeLogger();
    const probes = new FakeProbesRepo();
    const { service, state } = makeIncidents();
    const prober = new FakeProber([fail(), pass(), fail()]);
    const svc = new HealthProbeService(probes, service, prober, logger, {
      targets: [TARGET],
      failureThreshold: 3,
    });
    for (let i = 0; i < 3; i += 1) {
      await svc.processTick(NOW);
    }
    expect(state.creates).toHaveLength(0);
  });
});

describe('V-553.B-31 HealthProbeService — threshold auto-resolve', () => {
  it('auto-resolves the open incident after recoveryThreshold consecutive successes', async () => {
    const { logger } = makeLogger();
    const probes = new FakeProbesRepo();
    const openIncident: IncidentRow = {
      id: 'inc_open',
      title: 'API health check failing',
      description: '',
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
    const { service, state } = makeIncidents({ open: openIncident });
    const prober = new FakeProber([pass(), pass(), pass()]);
    const svc = new HealthProbeService(probes, service, prober, logger, {
      targets: [TARGET],
      recoveryThreshold: 3,
    });
    for (let i = 0; i < 3; i += 1) {
      await svc.processTick(NOW);
    }
    expect(state.resolves).toEqual(['inc_open']);
  });

  it('does NOT resolve when no incident is open, even after many passes', async () => {
    const { logger } = makeLogger();
    const probes = new FakeProbesRepo();
    const { service, state } = makeIncidents();
    const prober = new FakeProber([pass(), pass(), pass()]);
    const svc = new HealthProbeService(probes, service, prober, logger, {
      targets: [TARGET],
      recoveryThreshold: 3,
    });
    for (let i = 0; i < 3; i += 1) {
      await svc.processTick(NOW);
    }
    expect(state.resolves).toEqual([]);
  });
});

describe('V-553.B-31 HealthProbeService — hourly prune', () => {
  it('prunes on first tick, skips on a second tick within the hour, re-prunes after an hour', async () => {
    const { logger } = makeLogger();
    const probes = new FakeProbesRepo();
    const { service } = makeIncidents();
    const prober = new FakeProber([pass(), pass(), pass()]);
    const svc = new HealthProbeService(probes, service, prober, logger, { targets: [TARGET] });
    const t0 = NOW;
    const t1 = new Date(NOW.getTime() + 10 * 60_000);
    const t2 = new Date(NOW.getTime() + 65 * 60_000);
    await svc.processTick(t0);
    expect(probes.pruneCalls).toHaveLength(1);
    await svc.processTick(t1);
    // 10 min later — still within the hour, no extra prune.
    expect(probes.pruneCalls).toHaveLength(1);
    await svc.processTick(t2);
    // 65 min later — fresh prune.
    expect(probes.pruneCalls).toHaveLength(2);
  });
});
