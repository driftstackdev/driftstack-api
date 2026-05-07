// V-295b — health-probe service threshold + auto-incident logic.
//
// The service composes IncidentsService + ProbesRepo + a Prober. Tests
// drive a fake Prober deterministically through fail / pass sequences
// and assert that incidents auto-create at 3-fail and auto-resolve at
// 3-pass. Production cadence (60s setInterval) is tested via the
// bootstrap wiring path; this file tests the pure logic.

import { describe, expect, it } from 'vitest';
import {
  HealthProbeService,
  type HealthProbeTarget,
  type Prober,
  type ProbeResult,
} from '../../src/services/health-probe.js';
import { IncidentsService } from '../../src/services/incidents.js';
import { InMemoryIncidentsRepo } from './_helpers/in-memory-incidents-repo.js';
import { InMemoryProbesRepo } from './_helpers/in-memory-probes-repo.js';

const TARGET: HealthProbeTarget = {
  id: 'api',
  label: 'API server',
  url: 'http://localhost:3000/health',
};

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

class ScriptedProber implements Prober {
  private readonly results: ProbeResult[];
  private cursor = 0;
  constructor(results: ProbeResult[]) {
    this.results = results;
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async probe(): Promise<ProbeResult> {
    const result = this.results[this.cursor] ?? {
      ok: true,
      latencyMs: 5,
      httpStatus: 200,
      errorMessage: null,
    };
    this.cursor += 1;
    return result;
  }
}

const FAIL: ProbeResult = {
  ok: false,
  latencyMs: 5,
  httpStatus: 500,
  errorMessage: 'HTTP 500',
};
const PASS: ProbeResult = {
  ok: true,
  latencyMs: 5,
  httpStatus: 200,
  errorMessage: null,
};

function build(prober: Prober) {
  const probes = new InMemoryProbesRepo();
  const incidentsRepo = new InMemoryIncidentsRepo();
  const incidents = new IncidentsService(incidentsRepo);
  const service = new HealthProbeService(probes, incidents, prober, SILENT_LOGGER, {
    targets: [TARGET],
  });
  return { service, probes, incidentsRepo, incidents };
}

describe('HealthProbeService', () => {
  it('records every probe in order', async () => {
    const { service, probes } = build(new ScriptedProber([PASS, FAIL, PASS]));
    const t = new Date('2026-05-07T00:00:00Z');
    await service.processTick(new Date(t.getTime()));
    await service.processTick(new Date(t.getTime() + 60_000));
    await service.processTick(new Date(t.getTime() + 120_000));
    const rows = probes.getAll();
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.ok)).toEqual([true, false, true]);
  });

  it('does NOT auto-create on 1 or 2 consecutive failures', async () => {
    const { service, incidentsRepo } = build(new ScriptedProber([FAIL, FAIL]));
    const t = new Date('2026-05-07T00:00:00Z');
    await service.processTick(new Date(t.getTime()));
    await service.processTick(new Date(t.getTime() + 60_000));
    expect(incidentsRepo.getAll().incidents).toHaveLength(0);
  });

  it('auto-creates incident on 3rd consecutive failure', async () => {
    const { service, incidentsRepo } = build(new ScriptedProber([FAIL, FAIL, FAIL]));
    const t = new Date('2026-05-07T00:00:00Z');
    await service.processTick(new Date(t.getTime()));
    await service.processTick(new Date(t.getTime() + 60_000));
    const result = await service.processTick(new Date(t.getTime() + 120_000));
    expect(result.autoCreated).toBe(1);
    const all = incidentsRepo.getAll().incidents;
    expect(all).toHaveLength(1);
    const inc = all[0]!;
    expect(inc.autoProbeTarget).toBe('api');
    expect(inc.severity).toBe('major');
    expect(inc.public).toBe(true);
    expect(inc.createdByAdminId).toBeNull();
    expect(inc.createdByAdminKeyId).toBeNull();
    expect(inc.title).toContain('API server');
  });

  it('does NOT auto-create a second incident while one is open', async () => {
    const { service, incidentsRepo } = build(
      new ScriptedProber([FAIL, FAIL, FAIL, FAIL, FAIL, FAIL]),
    );
    const t = new Date('2026-05-07T00:00:00Z');
    for (let i = 0; i < 6; i++) {
      await service.processTick(new Date(t.getTime() + i * 60_000));
    }
    expect(incidentsRepo.getAll().incidents).toHaveLength(1);
  });

  it('auto-resolves incident on 3rd consecutive pass after open auto-incident', async () => {
    const { service, incidentsRepo } = build(
      new ScriptedProber([FAIL, FAIL, FAIL, PASS, PASS, PASS]),
    );
    const t = new Date('2026-05-07T00:00:00Z');
    for (let i = 0; i < 5; i++) {
      await service.processTick(new Date(t.getTime() + i * 60_000));
    }
    const final = await service.processTick(new Date(t.getTime() + 5 * 60_000));
    expect(final.autoResolved).toBe(1);
    const inc = incidentsRepo.getAll().incidents[0]!;
    expect(inc.status).toBe('resolved');
    expect(inc.resolvedAt).not.toBeNull();
  });

  it('does NOT auto-resolve on 1 or 2 consecutive passes', async () => {
    const { service, incidentsRepo } = build(new ScriptedProber([FAIL, FAIL, FAIL, PASS, PASS]));
    const t = new Date('2026-05-07T00:00:00Z');
    for (let i = 0; i < 5; i++) {
      await service.processTick(new Date(t.getTime() + i * 60_000));
    }
    expect(incidentsRepo.getAll().incidents[0]!.status).not.toBe('resolved');
  });

  it('handles a fail/recover/fail sequence — only one open incident at a time', async () => {
    // 3 fails → auto-create. 3 passes → auto-resolve. 3 fails → new auto-create.
    const seq = [FAIL, FAIL, FAIL, PASS, PASS, PASS, FAIL, FAIL, FAIL];
    const { service, incidentsRepo } = build(new ScriptedProber(seq));
    const t = new Date('2026-05-07T00:00:00Z');
    for (let i = 0; i < seq.length; i++) {
      await service.processTick(new Date(t.getTime() + i * 60_000));
    }
    const all = incidentsRepo.getAll().incidents;
    expect(all).toHaveLength(2);
    expect(all[0]!.status).toBe('resolved');
    expect(all[1]!.status).not.toBe('resolved');
    expect(all[1]!.autoProbeTarget).toBe('api');
  });

  it('swallows prober errors and does not throw from processTick', async () => {
    const throwingProber: Prober = {
      probe() {
        throw new Error('network unreachable');
      },
    };
    const { service, probes, incidentsRepo } = build(throwingProber);
    await expect(service.processTick(new Date('2026-05-07T00:00:00Z'))).resolves.toEqual({
      probed: 1,
      autoCreated: 0,
      autoResolved: 0,
    });
    // No probe row recorded — the throw happens before recordProbe.
    expect(probes.getAll()).toHaveLength(0);
    expect(incidentsRepo.getAll().incidents).toHaveLength(0);
  });

  it('admin-posted incidents are NOT touched by the auto-resolve path', async () => {
    // Simulate: admin posts an unrelated incident manually (no autoProbeTarget).
    // Then probes pass 3x. Manual incident must NOT be auto-resolved.
    const { service, incidents, incidentsRepo } = build(new ScriptedProber([PASS, PASS, PASS]));
    const ADMIN = '00000000-0000-4000-8000-000000000aaa';
    const KEY = '00000000-0000-4000-8000-000000000bbb';
    await incidents.create({
      title: 'Manual incident',
      description: 'unrelated',
      severity: 'minor',
      affectedComponents: [],
      public: true,
      startedAt: new Date(),
      createdByAdminId: ADMIN,
      createdByAdminKeyId: KEY,
    });
    const t = new Date('2026-05-07T00:00:00Z');
    for (let i = 0; i < 3; i++) {
      await service.processTick(new Date(t.getTime() + i * 60_000));
    }
    const manual = incidentsRepo.getAll().incidents[0]!;
    expect(manual.status).not.toBe('resolved');
  });
});
