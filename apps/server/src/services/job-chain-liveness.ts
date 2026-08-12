// Liveness probe for the self-re-arming job chains.
//
// Every recurring sweep in this server survives by enqueueing its own
// successor, so exactly one pending row per job type is the steady state. Each
// `register*Job` helper carries a comment warning what happens when that
// breaks: a throw with no re-arm leaves the poller to retry until `maxAttempts`
// is exhausted, and then "the self-re-arming chain is then dead until a process
// restart". The retention sweeps that keep three privacy-policy §9 commitments
// are among the chains that can die this way.
//
// Nothing detected it. A dead chain produces no error, no log line at the
// moment it matters, and a green suite — the sweep simply stops happening. This
// turns that into a gauge: 1 while a chain has pending work, 0 when it has
// none.
//
// Reported for a PINNED roster of job types rather than for whatever the table
// happens to contain. That direction is the whole point: a chain that has died
// leaves no rows at all, so a query grouped by what exists would report nothing
// for exactly the job type in trouble, and the gauge would look healthy by
// omission.

import { METRIC_NAMES, type MetricsRegistry } from './metrics-registry.js';

/**
 * The recurring chains expected to be alive in a fully-wired deployment.
 *
 * Hand-pinned on purpose. Deriving it from the registrations would make it
 * agree with the code by construction and it would never fail — the same
 * self-grading hole that lets a deleted gate pass its own generated table.
 */
export const EXPECTED_RECURRING_JOB_TYPES: readonly string[] = [
  'account_deletion.purge',
  'agent_session.orphan_reap',
  'auth_tokens.sweep',
  'cost.recompute_nightly',
  'crypto.entitlement_expiry_sweep',
  'oauth.retention_sweep',
  'privacy.retention_scrub',
  'profile_trash.purge',
  'scheduled_jobs.prune',
  'sessions.duration_sweep',
];

export interface JobChainLivenessDeps {
  readonly repo: { jobTypesWithPendingWork(): Promise<string[]> };
  readonly metrics: MetricsRegistry;
  /**
   * Job types this deployment does not run, with the reason. A type listed here
   * is not reported at all rather than reported as 0, so an intentionally
   * absent chain does not page.
   */
  readonly notRunHere?: ReadonlySet<string>;
}

/**
 * Set `driftstack_scheduled_job_chain_pending{job_type}` for every expected
 * chain. Intended to run at scrape time: the gauge describes current state, and
 * driving it from a job tick would make the watchdog die with the chain it
 * watches.
 */
export async function refreshJobChainLiveness(deps: JobChainLivenessDeps): Promise<void> {
  const pending = new Set(await deps.repo.jobTypesWithPendingWork());
  for (const jobType of EXPECTED_RECURRING_JOB_TYPES) {
    if (deps.notRunHere?.has(jobType) === true) continue;
    deps.metrics.setGauge(METRIC_NAMES.scheduledJobChainPending, pending.has(jobType) ? 1 : 0, {
      job_type: jobType,
    });
  }
}
