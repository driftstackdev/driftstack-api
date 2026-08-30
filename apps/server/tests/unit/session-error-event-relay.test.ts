import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../src/lib/logger.js';
import {
  HARNESS_ERROR_EVENT_DETAIL_MAX_LENGTH,
  HARNESS_ERROR_EVENT_SUMMARY_MAX_LENGTH,
  type HarnessErrorEvent,
} from '../../src/schemas/harness-control-protocol.js';
import { InMemoryAgentSessionsRepo } from '../../src/services/agent-sessions.js';
import { NotificationEventBus } from '../../src/services/notification-event-bus.js';
import {
  ERROR_EVENT_RELAY_MAX_CONCURRENT_PER_NODE,
  ERROR_EVENT_RELAY_MAX_SESSIONS_PER_NODE,
  makeSessionErrorEventRelay,
} from '../../src/services/session-error-event-relay.js';

function frame(overrides: Partial<HarnessErrorEvent> = {}): HarnessErrorEvent {
  return {
    type: 'errorEvent',
    sessionId: 'agt_inmem_00000001',
    timestamp: '2026-07-13T06:00:00.000Z',
    code: 'proxy_connection_failed',
    severity: 'error',
    summary: 'proxied=203.0.113.1 direct=10.0.0.7 Bearer abc+SECRET/==',
    detail: 'GET https://user:pass@example.test/?ds_token=SECRET failed at 192.168.1.9',
    customerActionable: true,
    retryable: true,
    ...overrides,
  };
}

function logger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
}

describe('makeSessionErrorEventRelay', () => {
  it('accepts the owning node even after terminal status, scrubs customer text, persists, and notifies', async () => {
    const repo = new InMemoryAgentSessionsRepo();
    const session = await repo.create({ accountId: 'acc_1', tokenBudgetTotal: 100 });
    await repo.setNodeId(session.id, 'node-1');
    await repo.closeWithReason(session.id, 'session_errored');
    const bus = new NotificationEventBus();
    const events: unknown[] = [];
    bus.subscribe('acc_1', (event) => events.push(event));
    const relay = makeSessionErrorEventRelay(repo, bus, logger());

    relay(frame({ sessionId: session.id }), 'node-1');
    await vi.waitFor(async () =>
      expect((await repo.get(session.id))?.lastErrorEvent).not.toBeNull(),
    );
    const stored = (await repo.get(session.id))?.lastErrorEvent;
    expect(stored).toMatchObject({ code: 'proxy_connection_failed', retryable: true });
    expect(JSON.stringify(stored)).not.toMatch(
      /10\.0\.0\.7|192\.168\.1\.9|abc\+SECRET|ds_token=SECRET|user:pass/,
    );
    expect(events).toEqual([
      expect.objectContaining({
        kind: 'session.errored',
        accountId: 'acc_1',
        sessionId: session.id,
        errorClass: 'proxy_connection_failed',
      }),
    ]);
  });

  it('drops cross-node and node-scoped events without customer mutation or notification', async () => {
    const repo = new InMemoryAgentSessionsRepo();
    const session = await repo.create({ accountId: 'acc_1', tokenBudgetTotal: 100 });
    await repo.setNodeId(session.id, 'node-1');
    const bus = new NotificationEventBus();
    const publish = vi.spyOn(bus, 'publish');
    const log = logger();
    const relay = makeSessionErrorEventRelay(repo, bus, log);

    relay(frame({ sessionId: session.id }), 'node-2');
    await vi.waitFor(() => expect(log.warn).toHaveBeenCalledTimes(1));
    relay(frame({ sessionId: undefined }), 'node-1');
    await Promise.resolve();
    expect((await repo.get(session.id))?.lastErrorEvent).toBeNull();
    expect(publish).not.toHaveBeenCalled();
    // V-2155 — the node-scoped drop is no longer silent: one warn naming the
    // node and the code (never summary/detail, which can carry the node's IP),
    // so an operator reading the server log can correlate a "load just stopped"
    // report with the failure the box actually reported.
    await vi.waitFor(() => expect(log.warn).toHaveBeenCalledTimes(2));
    const nodeScoped = (log.warn as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => typeof c[1] === 'string' && c[1].startsWith('node-scoped errorEvent'),
    );
    expect(nodeScoped, 'no warn for the node-scoped drop').toBeDefined();
    const ctx = nodeScoped?.[0] as Record<string, unknown>;
    expect(ctx.reportingNodeId).toBe('node-1');
    expect(ctx.code).toBe(frame({ sessionId: undefined }).code);
    expect(ctx).not.toHaveProperty('summary');
    expect(ctx).not.toHaveProperty('detail');
  });

  it('re-applies bounds after IP redaction expands customer-visible text', async () => {
    const repo = new InMemoryAgentSessionsRepo();
    const session = await repo.create({ accountId: 'acc_1', tokenBudgetTotal: 100 });
    await repo.setNodeId(session.id, 'node-1');
    const relay = makeSessionErrorEventRelay(repo, new NotificationEventBus(), logger());

    relay(
      frame({
        sessionId: session.id,
        summary: '1.1.1.1 '.repeat(450),
        detail: '2.2.2.2 '.repeat(1_800),
      }),
      'node-1',
    );
    await vi.waitFor(async () =>
      expect((await repo.get(session.id))?.lastErrorEvent).not.toBeNull(),
    );
    const stored = (await repo.get(session.id))?.lastErrorEvent;
    expect(stored?.summary.length).toBeLessThanOrEqual(HARNESS_ERROR_EVENT_SUMMARY_MAX_LENGTH);
    expect(stored?.detail?.length).toBeLessThanOrEqual(HARNESS_ERROR_EVENT_DETAIL_MAX_LENGTH);
    expect(stored?.summary).not.toContain('1.1.1.1');
    expect(stored?.detail).not.toContain('2.2.2.2');
  });

  it('serializes same-session persistence so a delayed older event cannot overwrite a newer one', async () => {
    let releaseFirst!: () => void;
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const writes: string[] = [];
    let calls = 0;
    const repo = {
      recordErrorEvent: vi.fn(async (_id: string, _node: string, event: { code: string }) => {
        calls += 1;
        if (calls === 1) await first;
        writes.push(event.code);
        return { id: 'agt_1', accountId: 'acc_1' } as never;
      }),
    };
    const relay = makeSessionErrorEventRelay(repo, new NotificationEventBus(), logger());
    relay(frame({ sessionId: 'agt_1', code: 'older_error' }), 'node-1');
    relay(frame({ sessionId: 'agt_1', code: 'newer_error' }), 'node-1');
    await Promise.resolve();
    expect(calls).toBe(1);
    releaseFirst();
    await vi.waitFor(() => expect(writes).toEqual(['older_error', 'newer_error']));
  });

  it('coalesces repeated pending diagnostics to the latest event while one session write is in flight', async () => {
    let releaseFirst!: () => void;
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const writes: string[] = [];
    const repo = {
      recordErrorEvent: vi.fn(async (_id: string, _node: string, event: { code: string }) => {
        writes.push(event.code);
        if (writes.length === 1) await first;
        return { id: 'agt_1', accountId: 'acc_1' } as never;
      }),
    };
    const relay = makeSessionErrorEventRelay(repo, new NotificationEventBus(), logger());
    relay(frame({ sessionId: 'agt_1', code: 'first_error' }), 'node-1');
    relay(frame({ sessionId: 'agt_1', code: 'superseded_error' }), 'node-1');
    relay(frame({ sessionId: 'agt_1', code: 'latest_error' }), 'node-1');

    expect(writes).toEqual(['first_error']);
    releaseFirst();
    await vi.waitFor(() => expect(writes).toEqual(['first_error', 'latest_error']));
  });

  it('caps concurrent ownership/persistence work per reporting node', async () => {
    const releases: Array<() => void> = [];
    const repo = {
      recordErrorEvent: vi.fn(
        () =>
          new Promise<never>((resolve) => {
            releases.push(resolve as () => void);
          }),
      ),
    };
    const relay = makeSessionErrorEventRelay(repo, new NotificationEventBus(), logger());
    for (let i = 0; i < ERROR_EVENT_RELAY_MAX_CONCURRENT_PER_NODE * 3; i += 1) {
      relay(frame({ sessionId: `agt_${i}` }), 'node-1');
    }

    expect(repo.recordErrorEvent).toHaveBeenCalledTimes(ERROR_EVENT_RELAY_MAX_CONCURRENT_PER_NODE);
    for (const release of releases.splice(0)) release();
    await vi.waitFor(() =>
      expect(repo.recordErrorEvent).toHaveBeenCalledTimes(
        ERROR_EVENT_RELAY_MAX_CONCURRENT_PER_NODE * 2,
      ),
    );
  });

  it('sheds unique-session overflow at the worker capacity budget without starting more DB work', () => {
    const repo = {
      recordErrorEvent: vi.fn(() => new Promise<never>(() => undefined)),
    };
    const log = logger();
    const relay = makeSessionErrorEventRelay(repo, new NotificationEventBus(), log);
    for (let i = 0; i < ERROR_EVENT_RELAY_MAX_SESSIONS_PER_NODE; i += 1) {
      relay(frame({ sessionId: `agt_budget_${i}` }), 'node-1');
    }
    relay(frame({ sessionId: 'agt_overflow' }), 'node-1');

    expect(repo.recordErrorEvent).toHaveBeenCalledTimes(ERROR_EVENT_RELAY_MAX_CONCURRENT_PER_NODE);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'agt_overflow',
        reportingNodeId: 'node-1',
        sessionBudget: ERROR_EVENT_RELAY_MAX_SESSIONS_PER_NODE,
      }),
      expect.stringContaining('exceeded its relay session budget'),
    );
  });

  it('contains a throwing error logger, releases the slot, drains the newest successor, and emits no unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      let calls = 0;
      const repo = {
        recordErrorEvent: vi.fn((_id: string, _node: string, event: { code: string }) => {
          calls += 1;
          if (calls === 1) return Promise.reject(new Error('persistence failed'));
          return Promise.resolve({ id: `agt_${event.code}`, accountId: 'acc_1' } as never);
        }),
      };
      const log = logger();
      vi.mocked(log.error).mockImplementation(() => {
        throw new Error('error logger failed');
      });
      const relay = makeSessionErrorEventRelay(repo, new NotificationEventBus(), log);

      expect(() => {
        relay(frame({ sessionId: 'agt_1', code: 'first_error' }), 'node-1');
        relay(frame({ sessionId: 'agt_1', code: 'newest_error' }), 'node-1');
      }).not.toThrow();
      await vi.waitFor(() => expect(repo.recordErrorEvent).toHaveBeenCalledTimes(2));
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(log.error).toHaveBeenCalledTimes(1);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('contains a throwing overflow logger and starts no overflow work', () => {
    const repo = {
      recordErrorEvent: vi.fn(() => new Promise<never>(() => undefined)),
    };
    const log = logger();
    vi.mocked(log.warn).mockImplementation(() => {
      throw new Error('overflow logger failed');
    });
    const relay = makeSessionErrorEventRelay(repo, new NotificationEventBus(), log);
    for (let i = 0; i < ERROR_EVENT_RELAY_MAX_SESSIONS_PER_NODE; i += 1) {
      relay(frame({ sessionId: `agt_budget_${i}` }), 'node-1');
    }

    expect(() => relay(frame({ sessionId: 'agt_overflow_1' }), 'node-1')).not.toThrow();
    expect(() => relay(frame({ sessionId: 'agt_overflow_2' }), 'node-1')).not.toThrow();
    expect(repo.recordErrorEvent).toHaveBeenCalledTimes(ERROR_EVENT_RELAY_MAX_CONCURRENT_PER_NODE);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });
});
