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
  sanitizePublicProbeError,
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

/** Holds inside probe() until unblock() — lets a test keep one tick in
 *  flight while it fires an overlapping tick (re-entrancy guard test). */
class BlockingProber implements Prober {
  public calls = 0;
  private release!: () => void;
  private readonly gate = new Promise<void>((r) => {
    this.release = r;
  });
  async probe(): Promise<ProbeResult> {
    this.calls += 1;
    await this.gate;
    return { ok: true, latencyMs: 1, httpStatus: 200, errorMessage: null };
  }
  unblock(): void {
    this.release();
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
    creates: Array<{
      title: string;
      description: string;
      public: boolean;
      autoProbeTarget: string | null;
    }>;
    resolves: string[];
  };
} {
  const state = {
    creates: [] as Array<{
      title: string;
      description: string;
      public: boolean;
      autoProbeTarget: string | null;
    }>,
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
        description: input.description,
        public: input.public,
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

  it('re-entrancy guard: an overlapping tick is skipped (no double-probe / double-record)', async () => {
    const { logger, warns } = makeLogger();
    const probes = new FakeProbesRepo();
    const { service } = makeIncidents();
    const blocker = new BlockingProber();
    const svc = new HealthProbeService(probes, service, blocker, logger, { targets: [TARGET] });
    // Start tick 1 — it blocks inside probe() with `ticking` already set
    // (set synchronously before the first await), then fire an overlapping tick.
    const p1 = svc.processTick(NOW);
    const out2 = await svc.processTick(NOW);
    expect(out2.skipped).toBe(true);
    expect(out2.probed).toBe(0);
    expect(warns.some((m) => m.includes('processTick skipped'))).toBe(true);
    // Let tick 1 finish — only ONE tick actually probed/recorded.
    blocker.unblock();
    const out1 = await p1;
    expect(out1.skipped).toBeUndefined();
    expect(out1.probed).toBe(1);
    expect(blocker.calls).toBe(1);
    expect(probes.rows).toHaveLength(1);
    // The guard clears — a subsequent tick runs normally.
    const out3 = await svc.processTick(NOW);
    expect(out3.skipped).toBeUndefined();
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

  it('never reflects the configured probe URL or raw network diagnostic in a public incident', async () => {
    const hostileTarget: HealthProbeTarget = {
      id: 'api',
      label: 'API',
      url: 'http://internal-api.local:8443/health?access_token=do-not-publish',
    };
    const rawError = 'connect ECONNREFUSED 10.0.0.7:8443 password=do-not-publish';
    const { logger } = makeLogger();
    const probes = new FakeProbesRepo();
    const { service, state } = makeIncidents();
    const prober = new FakeProber([fail(rawError), fail(rawError), fail(rawError)]);
    const svc = new HealthProbeService(probes, service, prober, logger, {
      targets: [hostileTarget],
      failureThreshold: 3,
    });

    for (let i = 0; i < 3; i += 1) await svc.processTick(NOW);

    expect(state.creates).toHaveLength(1);
    expect(state.creates[0]).toMatchObject({
      public: true,
      description:
        'Auto-detected: 3 consecutive health checks failed. Latest error: a connectivity error.',
    });
    expect(state.creates[0]?.description).not.toContain(hostileTarget.url);
    expect(state.creates[0]?.description).not.toContain('internal-api.local');
    expect(state.creates[0]?.description).not.toContain('access_token');
    expect(state.creates[0]?.description).not.toContain('10.0.0.7');
    expect(state.creates[0]?.description).not.toContain('password');
    // Operators retain the exact private diagnostic in probe history.
    expect(probes.rows[0]?.errorMessage).toBe(rawError);
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

describe('sanitizePublicProbeError — public incident must not leak internal infra (V-295b)', () => {
  it('passes through the benign HTTP <status> shape verbatim', () => {
    expect(sanitizePublicProbeError('HTTP 503')).toBe('HTTP 503');
    expect(sanitizePublicProbeError('HTTP 200')).toBe('HTTP 200');
  });

  it('collapses raw network errors that embed an internal IP/host to a generic phrase', () => {
    expect(sanitizePublicProbeError('connect ECONNREFUSED 10.0.0.5:8443')).toBe(
      'a connectivity error',
    );
    expect(sanitizePublicProbeError('getaddrinfo ENOTFOUND internal-db.driftstack.internal')).toBe(
      'a connectivity error',
    );
    expect(sanitizePublicProbeError('connect ETIMEDOUT 172.16.4.9:5432')).toBe(
      'a connectivity error',
    );
  });

  it('collapses null / unknown to the generic phrase (never undefined-y)', () => {
    expect(sanitizePublicProbeError(null)).toBe('a connectivity error');
    expect(sanitizePublicProbeError('unknown error')).toBe('a connectivity error');
  });

  it('does not pass through a malformed HTTP-prefixed string that carries extra detail', () => {
    expect(sanitizePublicProbeError('HTTP 503 from 10.0.0.5')).toBe('a connectivity error');
  });
});
