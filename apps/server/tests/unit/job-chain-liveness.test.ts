// `driftstack_scheduled_job_chain_pending{job_type}` — a dead job chain is
// visible instead of silent.
//
// Every recurring sweep survives by enqueueing its own successor, so one
// pending row per job type is the steady state. Each `register*Job` helper
// warns in its own comments what happens when that breaks: the poller retries
// until `maxAttempts` is exhausted and then "the self-re-arming chain is dead
// until a process restart". Among those chains are the retention sweeps that
// keep three privacy-policy §9 commitments.
//
// Nothing detected that. A dead chain produces no error, no log at the moment
// it matters, and a green suite — the work just stops happening.
//
// The property that carries the whole design is that a dead chain reports 0
// rather than reporting nothing. A gauge built from "group by what is in the
// table" would emit no series at all for the one job type in trouble, and a
// missing series reads as healthy on every dashboard. So these cases attack the
// absent case, not the present one.

import { describe, expect, it } from 'vitest';

import {
  refreshJobChainLiveness,
  EXPECTED_RECURRING_JOB_TYPES,
} from '../../src/services/job-chain-liveness.js';
import { MetricsRegistry, METRIC_NAMES } from '../../src/services/metrics-registry.js';

function registryOf(): MetricsRegistry {
  const m = new MetricsRegistry();
  m.registerGauge(METRIC_NAMES.scheduledJobChainPending, 'test', ['job_type']);
  return m;
}

/** `job_type=value` for every emitted chain-liveness sample. */
function samples(metrics: MetricsRegistry): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of metrics.render().split('\n')) {
    if (!line.startsWith(METRIC_NAMES.scheduledJobChainPending)) continue;
    const jobType = /job_type="([^"]+)"/.exec(line)?.[1];
    const value = Number(line.trim().split(/\s+/).pop());
    if (jobType !== undefined) out[jobType] = value;
  }
  return out;
}

const repoWith = (types: string[]) => ({ jobTypesWithPendingWork: () => Promise.resolve(types) });

describe('a dead job chain is reported as 0, not as an absent series', () => {
  it('CRITICAL a job type with NO pending row reports 0. This is the entire point: a gauge derived from what the table contains would emit nothing for the chain that died, and a missing series reads as healthy everywhere.', async () => {
    const metrics = registryOf();

    await refreshJobChainLiveness({
      repo: repoWith(['account_deletion.purge']),
      metrics,
    });

    const s = samples(metrics);
    expect(s['account_deletion.purge'], 'the live chain reports 1').toBe(1);
    expect(s['profile_trash.purge'], 'the dead chain reports 0, not undefined').toBe(0);
    expect(s['crypto.entitlement_expiry_sweep'], 'and so does every other dead chain').toBe(0);
  });

  it('CRITICAL every expected chain gets a series on every refresh, so a dashboard can alert on the value rather than on the absence of data. Alerting on absent series is unreliable — it fires identically when the scrape target is down.', async () => {
    const metrics = registryOf();

    await refreshJobChainLiveness({ repo: repoWith([]), metrics });

    const s = samples(metrics);
    expect(Object.keys(s).sort(), 'one series per expected chain').toEqual(
      [...EXPECTED_RECURRING_JOB_TYPES].sort(),
    );
    expect(
      Object.values(s).every((v) => v === 0),
      'all dead in this scenario',
    ).toBe(true);
  });

  it('CRITICAL an unexpected job type in the table does NOT create a series. The roster is what is expected to be alive; reporting whatever the table happens to contain would let a one-off job mask a missing recurring one by inflating the count.', async () => {
    const metrics = registryOf();

    await refreshJobChainLiveness({
      repo: repoWith(['some.adhoc_job', 'account_deletion.purge']),
      metrics,
    });

    const s = samples(metrics);
    expect(s['some.adhoc_job'], 'ad-hoc work is not a chain').toBeUndefined();
    expect(s['account_deletion.purge']).toBe(1);
  });

  it('CRITICAL a chain this deployment does not run is OMITTED rather than reported as 0, so an intentionally absent chain never pages. Reporting it as 0 would be indistinguishable from a dead one.', async () => {
    const metrics = registryOf();

    await refreshJobChainLiveness({
      repo: repoWith([]),
      metrics,
      notRunHere: new Set(['cost.recompute_nightly']),
    });

    const s = samples(metrics);
    expect(s['cost.recompute_nightly'], 'omitted entirely').toBeUndefined();
    expect(s['auth_tokens.sweep'], 'while the rest are still reported').toBe(0);
  });

  it('CRITICAL the roster covers every recurring sweep the server registers. A chain missing from the roster is a chain nobody is watching, which is the same blind spot in a different place.', () => {
    expect([...EXPECTED_RECURRING_JOB_TYPES].sort()).toEqual([
      'account_deletion.purge',
      'agent_session.orphan_reap',
      'auth_tokens.sweep',
      'cost.recompute_nightly',
      'crypto.entitlement_expiry_sweep',
      'oauth.retention_sweep',
      'profile_trash.purge',
      'scheduled_jobs.prune',
      'sessions.duration_sweep',
    ]);
  });
});
