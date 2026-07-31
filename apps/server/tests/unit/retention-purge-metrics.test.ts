// `driftstack_retention_purge_total{arm,outcome}` — the observability half of
// the account-deletion sweep.
//
// Three privacy-policy.md §9 erasure commitments ride on one sweeper: the BYOK
// Anthropic key, the wrapped proxy credentials, and the account's profiles and
// snapshots. Until this counter existed the sweep emitted nothing. If a tick
// started failing, or an arm was never wired at all, the only trace was a log
// line nobody is watching for.
//
// `skipped` is the load-bearing label, and it exists because of a real defect
// rather than for symmetry: the sweeper was gated on an unrelated feature flag,
// so an unset MFA_ENCRYPTION_KEY switched off all three promises while
// everything still reported success. Emitting nothing and having nothing to
// emit are indistinguishable from a dashboard; `skipped` is what tells them
// apart, so that is what these cases pin.

import { describe, expect, it } from 'vitest';

import { AccountDeletionPurgeSweeperService } from '../../src/services/account-deletion-purge-sweeper.js';
import { MetricsRegistry, METRIC_NAMES } from '../../src/services/metrics-registry.js';
import type { BYOKAnthropicService } from '../../src/services/byok-anthropic.js';

const NOW = new Date('2026-07-31T00:00:00Z');

/**
 * A registry wired exactly as bootstrap wires it. Registering here rather than
 * relying on a bare `new MetricsRegistry()` is deliberate: `inc` throws on an
 * unregistered counter, so a fixture that skipped registration would exercise
 * the throwing path and prove nothing about the labels.
 */
function registryOf(): MetricsRegistry {
  const m = new MetricsRegistry();
  m.registerCounter(METRIC_NAMES.retentionPurgeTotal, 'test', ['arm', 'outcome']);
  return m;
}

/** Every sample recorded for the retention counter, as `arm/outcome` pairs. */
function samples(metrics: MetricsRegistry): string[] {
  const text = metrics.render();
  return text
    .split('\n')
    .filter((l) => l.startsWith(METRIC_NAMES.retentionPurgeTotal))
    .map((l) => {
      const arm = /arm="([^"]+)"/.exec(l)?.[1] ?? '?';
      const outcome = /outcome="([^"]+)"/.exec(l)?.[1] ?? '?';
      const value = l.trim().split(/\s+/).pop() ?? '?';
      return `${arm}/${outcome}=${value}`;
    })
    .sort();
}

const byokRepo = {
  findDeletedAccountIdsWithByokKeyBefore: () => Promise.resolve(['acc_byok']),
};
const noByokRepo = {
  findDeletedAccountIdsWithByokKeyBefore: () => Promise.resolve([]),
};

const okByok = {
  clearKey: () => Promise.resolve(undefined),
} as unknown as BYOKAnthropicService;

describe('the retention purge reports what it did, and what it never ran', () => {
  it('CRITICAL an UNWIRED arm emits `skipped`. This is the failure that actually happened — the sweeper gated on an unrelated flag, so three erasure promises stopped while everything still reported success. Emitting nothing and having nothing to purge are indistinguishable on a dashboard; this label is what separates them.', async () => {
    const metrics = registryOf();
    const sweeper = new AccountDeletionPurgeSweeperService({ repo: noByokRepo, metrics });

    await sweeper.tickOnce(NOW);

    // The full arm roster, asserted exhaustively. A new arm added without a
    // `skipped` emit would leave an erasure promise that looks identical on a
    // dashboard whether it ran or was never wired — which is the failure this
    // whole file exists for, so the list must fail on additions too.
    expect(samples(metrics)).toEqual([
      'byok/skipped=1',
      'profiles/skipped=1',
      'proxy_secrets/skipped=1',
      'snapshots/skipped=1',
      'turn_receipts/skipped=1',
    ]);
  });

  it('CRITICAL a WIRED arm that purges emits `purged`, not `skipped`. Without this the check above is satisfied by a counter that reports every arm skipped forever — which would be worse than no metric, because it would alert constantly and get muted.', async () => {
    const metrics = registryOf();
    const sweeper = new AccountDeletionPurgeSweeperService({
      repo: byokRepo,
      byok: okByok,
      metrics,
    });

    await sweeper.tickOnce(NOW);

    const s = samples(metrics);
    expect(s, 'the wired arm reports work done').toContain('byok/purged=1');
    expect(s.join(','), 'and is NOT reported as skipped').not.toContain('byok/skipped');
  });

  it('CRITICAL a FAILING arm emits `failed` and does not emit `purged`. A retention promise that throws every tick must not be indistinguishable from one that is quietly succeeding.', async () => {
    const metrics = registryOf();
    const sweeper = new AccountDeletionPurgeSweeperService({
      repo: noByokRepo,
      proxySecrets: {
        findDeletedAccountIdsWithProxySecretsBefore: () => Promise.resolve(['acc_p']),
        clearProxySecretsForAccount: () => Promise.reject(new Error('db down')),
      },
      metrics,
    });

    await sweeper.tickOnce(NOW);

    const s = samples(metrics);
    expect(s, 'the failure is counted').toContain('proxy_secrets/failed=1');
    expect(s.join(','), 'and nothing is claimed as purged').not.toContain('proxy_secrets/purged');
  });

  it('CRITICAL each arm is labelled separately, so one healthy arm cannot mask another that is skipped or failing. A single aggregate counter would go up every tick and hide exactly the case this exists to surface.', async () => {
    const metrics = registryOf();
    const sweeper = new AccountDeletionPurgeSweeperService({
      repo: byokRepo,
      byok: okByok,
      profiles: {
        purgeProfilesForTerminatedAccountsBefore: () => Promise.resolve(['p1']),
        purgeSnapshotsForTerminatedAccountsBefore: () => Promise.resolve(2),
      },
      metrics,
    });

    await sweeper.tickOnce(NOW);

    const s = samples(metrics);
    expect(s, 'the working arms report purged').toEqual(
      expect.arrayContaining(['byok/purged=1', 'profiles/purged=1', 'snapshots/purged=1']),
    );
    expect(s, 'while the absent one still reports skipped').toContain('proxy_secrets/skipped=1');
  });

  it('CRITICAL the sweeper runs without a metrics registry at all. Observability must never be load-bearing for the erasure itself — a deployment with no registry still has to keep its §9 promises.', async () => {
    const sweeper = new AccountDeletionPurgeSweeperService({
      repo: byokRepo,
      byok: okByok,
    });

    await expect(sweeper.tickOnce(NOW)).resolves.toMatchObject({ purged: 1 });
  });

  it('CRITICAL a THROWING metrics registry does not stop the purge. `inc` throws on an unregistered counter or a label mismatch, and these calls sit on the erasure path — so a metrics misconfiguration must not take down the promise the counter exists to watch. Caught during development: the first version of this instrumentation threw exactly this way.', async () => {
    const exploding = {
      inc: () => {
        throw new Error('Counter not registered: driftstack_retention_purge_total');
      },
    } as unknown as MetricsRegistry;
    const sweeper = new AccountDeletionPurgeSweeperService({
      repo: byokRepo,
      byok: okByok,
      metrics: exploding,
    });

    await expect(
      sweeper.tickOnce(NOW),
      'the BYOK key is still erased despite the broken counter',
    ).resolves.toMatchObject({ purged: 1 });
  });
});
