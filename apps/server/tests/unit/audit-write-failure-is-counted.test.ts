// A failed audit write leaves a trace.
//
// Callers swallow audit failures on purpose — losing an audit row must not break
// the customer's operation — and several do it with a *completely empty* catch:
// no log, no metric, nothing. Combined with a counter that only incremented on
// success, that made a failing audit trail invisible: the success rate quietly
// drops toward zero and every dashboard still looks healthy.
//
// For a compliance trail that is the worst possible failure shape. You cannot
// reconstruct who did what, and you do not know that you cannot.
//
// The signal therefore lives in the SERVICE rather than at the call sites. A
// signal that depends on sixty-odd callers each remembering to log is a signal
// that will be missing exactly where somebody forgot — and the call site that
// forgets is not knowable in advance.
//
// Caller-visible behaviour is deliberately unchanged: the error is re-thrown,
// so every existing `try { await audit.record(...) } catch {}` keeps swallowing
// it exactly as before. This adds a trace, not a new failure mode.

import { describe, expect, it } from 'vitest';

import { AccountAuditService } from '../../src/services/account-audit.js';
import { MetricsRegistry, METRIC_NAMES } from '../../src/services/metrics-registry.js';
import type {
  AccountAuditRepo,
  RecordAccountAuditInput,
} from '../../src/services/account-audit.js';

function registryOf(): MetricsRegistry {
  const m = new MetricsRegistry();
  m.registerCounter(METRIC_NAMES.accountAuditEmitTotal, 'test', [
    'prefix',
    'actor_type',
    'outcome',
  ]);
  return m;
}

/** `prefix/actor_type/outcome=value` for each recorded sample. */
function samples(metrics: MetricsRegistry): string[] {
  return metrics
    .render()
    .split('\n')
    .filter((l) => l.startsWith(METRIC_NAMES.accountAuditEmitTotal))
    .map((l) => {
      const outcome = /outcome="([^"]+)"/.exec(l)?.[1] ?? '?';
      const value = l.trim().split(/\s+/).pop() ?? '?';
      return `${outcome}=${value}`;
    })
    .sort();
}

const INPUT: RecordAccountAuditInput = {
  accountId: '11111111-1111-1111-1111-111111111111',
  actorType: 'customer' as const,
  action: 'proxy.created',
  targetResourceId: 'proxy_1',
  payload: {},
  ipAddress: null,
};

function serviceWith(
  insert: () => Promise<unknown>,
  metrics: MetricsRegistry,
): AccountAuditService {
  return new AccountAuditService({ insert } as unknown as AccountAuditRepo, metrics);
}

describe('a failed audit write is counted, not silent', () => {
  it('CRITICAL a failing insert increments the counter with outcome=error. Before this the only evidence was a success counter that stopped rising — indistinguishable on a dashboard from an account that simply did nothing.', async () => {
    const metrics = registryOf();
    const service = serviceWith(() => Promise.reject(new Error('db down')), metrics);

    await expect(service.record(INPUT)).rejects.toThrow('db down');

    expect(samples(metrics), 'the failure is recorded').toEqual(['error=1']);
  });

  it('CRITICAL the error is still RE-THROWN, so caller behaviour is unchanged. Every existing call site swallows this deliberately; turning a swallowed failure into a customer-visible one would be a worse bug than the blindness being fixed.', async () => {
    const metrics = registryOf();
    const service = serviceWith(() => Promise.reject(new Error('db down')), metrics);

    let swallowed = false;
    try {
      await service.record(INPUT);
    } catch {
      swallowed = true; // exactly what the routes do
    }
    expect(swallowed, 'the caller still receives the rejection to swallow').toBe(true);
  });

  it('CRITICAL a successful write is counted as ok, not as error. Without this the check above is satisfied by a service that reports every write as failing — which would page constantly and then be muted.', async () => {
    const metrics = registryOf();
    const service = serviceWith(() => Promise.resolve({ id: 'row_1' }), metrics);

    await service.record(INPUT);

    expect(samples(metrics)).toEqual(['ok=1']);
  });

  it('CRITICAL the audit write itself still happens and its result is returned. Instrumenting a path must not change what it does.', async () => {
    const metrics = registryOf();
    let called = 0;
    const service = serviceWith(() => {
      called += 1;
      return Promise.resolve({ id: 'row_1' });
    }, metrics);

    const row = await service.record(INPUT);

    expect(called, 'the repo was written to exactly once').toBe(1);
    expect((row as unknown as { id: string }).id).toBe('row_1');
  });

  it('CRITICAL a broken metrics registry does not break the audit write. Observability must never be load-bearing for the thing it observes.', async () => {
    const exploding = {
      inc: () => {
        throw new Error('counter not registered');
      },
    } as unknown as MetricsRegistry;
    const service = serviceWith(() => Promise.resolve({ id: 'row_1' }), exploding);

    await expect(service.record(INPUT)).resolves.toMatchObject({ id: 'row_1' });
  });
});
