import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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
  DEFAULT_EGRESS_UNAVAILABLE_SUMMARY,
  ERROR_EVENT_RELAY_MAX_CONCURRENT_PER_NODE,
  ERROR_EVENT_RELAY_MAX_SESSIONS_PER_NODE,
  NO_PROXY_REFUSAL_SUMMARY,
  OUR_SIDE_CONNECTION_SUMMARY,
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
    // The customer's OWN proxy: a proxy failure on a session with no proxy of
    // its own is rewritten (see the describe block at the end of this file).
    await repo.setNodeId(session.id, 'node-1', 'prx_customer_own');
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
    // This session has no proxy of its own and the frame carries a proxy
    // failure, but the frame came from a node that does not own it: nothing
    // reports a failed default connection for a write that never happened.
    expect(log.error).not.toHaveBeenCalled();
  });

  it('re-applies bounds after IP redaction expands customer-visible text', async () => {
    const repo = new InMemoryAgentSessionsRepo();
    const session = await repo.create({ accountId: 'acc_1', tokenBudgetTotal: 100 });
    // A customer-owned proxy, so the device's summary and detail are what persist.
    await repo.setNodeId(session.id, 'node-1', 'prx_customer_own');
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
      get: vi.fn(() => Promise.resolve(null)),
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
      get: vi.fn(() => Promise.resolve(null)),
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
      get: vi.fn(() => Promise.resolve(null)),
      recordErrorEvent: vi.fn(
        () =>
          new Promise<never>((resolve) => {
            releases.push(resolve as () => void);
          }),
      ),
    };
    const relay = makeSessionErrorEventRelay(repo, new NotificationEventBus(), logger());
    for (let i = 0; i < ERROR_EVENT_RELAY_MAX_CONCURRENT_PER_NODE * 3; i += 1) {
      relay(frame({ sessionId: `agt_${i}`, code: 'renderer_crashed' }), 'node-1');
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
      get: vi.fn(() => Promise.resolve(null)),
      recordErrorEvent: vi.fn(() => new Promise<never>(() => undefined)),
    };
    const log = logger();
    const relay = makeSessionErrorEventRelay(repo, new NotificationEventBus(), log);
    for (let i = 0; i < ERROR_EVENT_RELAY_MAX_SESSIONS_PER_NODE; i += 1) {
      relay(frame({ sessionId: `agt_budget_${i}`, code: 'renderer_crashed' }), 'node-1');
    }
    relay(frame({ sessionId: 'agt_overflow', code: 'renderer_crashed' }), 'node-1');

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
        get: vi.fn(() => Promise.resolve(null)),
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
      get: vi.fn(() => Promise.resolve(null)),
      recordErrorEvent: vi.fn(() => new Promise<never>(() => undefined)),
    };
    const log = logger();
    vi.mocked(log.warn).mockImplementation(() => {
      throw new Error('overflow logger failed');
    });
    const relay = makeSessionErrorEventRelay(repo, new NotificationEventBus(), log);
    for (let i = 0; i < ERROR_EVENT_RELAY_MAX_SESSIONS_PER_NODE; i += 1) {
      relay(frame({ sessionId: `agt_budget_${i}`, code: 'renderer_crashed' }), 'node-1');
    }

    const overflow = (sessionId: string): HarnessErrorEvent =>
      frame({ sessionId, code: 'renderer_crashed' });
    expect(() => relay(overflow('agt_overflow_1'), 'node-1')).not.toThrow();
    expect(() => relay(overflow('agt_overflow_2'), 'node-1')).not.toThrow();
    expect(repo.recordErrorEvent).toHaveBeenCalledTimes(ERROR_EVENT_RELAY_MAX_CONCURRENT_PER_NODE);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });
});

// ⛔ A SESSION CREATED WITH NO proxy_id RUNS ON THE OPERATOR-DEFAULT UPSTREAM
// (routes/agent-sessions.ts: `inlineProxyConfig = sessionDispatch.proxy` unless
// the create named a proxy), and the row's proxyId stays NULL. When that upstream
// fails, the device cannot tell it from a customer's own proxy failing, so it
// reports the same proxy-family code with the same "your proxy" meaning — and
// often customerActionable: true. Measured in production 2026-09-25. Only this
// server knows the default was attached, so this is where the report is
// corrected: to a code, a flag and a sentence that say it is ours.
describe('a proxy failure on a session with no proxy of its own is reported as ours', () => {
  /** Every code the device sends that the desktop app renders with proxy wording
   *  and that can occur on a session with no proxy of its own. Listed here, not
   *  imported, so the test cannot agree with the code by construction. */
  const FAMILY = [
    'proxy_connection_failed',
    'egress_verification_unavailable',
    'egress_lost',
    'egress_unreachable',
    'egress_invariant_violation',
    'proxy_udp_unsupported',
    'proxy_boot_failed',
    'network_shim_boot_failed',
    // The device's own end reasons for the probe and invariant refusals. Today
    // they reach the server as proxy_connection_failed / egress_verification_
    // unavailable, but if the device change being shipped sends them as they are,
    // the app's `/^(proxy_|egress_)/` branch would call them a proxy failure.
    'egress_probe_failed',
    'egress_probe_unverifiable',
    // A device code shipping later: the proxy refused its sign-in. On a session
    // with no proxy of its own the proxy that refused is the one we provide.
    'proxy_auth_failed',
  ] as const;

  /** Proxy-worded codes that must pass through untouched even on a session with
   *  no proxy of its own: everything only a customer's own VPN proxy can produce.
   *  (The named refusal — `proxy_required` / `no_proxy_configured` — keeps its
   *  code but gets server copy; it has its own describe below.) */
  const NOT_FAMILY = [
    'egress_bind_failed',
    'vpn_bringup_failed',
    'remote_unresolved',
    'remote_refused',
    'tunnel_setup_timeout',
    'exit_ip_changed',
    'renderer_crashed',
  ] as const;

  const BANNED =
    /\b(fleet|nodes?|harness|control plane|observer|vantage|interpose|macworker|undetectable|egress)\b|ai credits?/i;

  async function sessionOn(
    proxyId: string | null,
  ): Promise<{ repo: InMemoryAgentSessionsRepo; id: string }> {
    const repo = new InMemoryAgentSessionsRepo();
    const session = await repo.create({ accountId: 'acc_1', tokenBudgetTotal: 100 });
    await repo.setNodeId(session.id, 'node-1', proxyId);
    return { repo, id: session.id };
  }

  function errorCalls(log: Logger): unknown[][] {
    return (log.error as ReturnType<typeof vi.fn>).mock.calls;
  }

  it.each([
    ['proxy_connection_failed', 'error', true, true],
    ['egress_verification_unavailable', 'fatal', false, false],
  ] as const)(
    'CRITICAL proxyId null + %s → persisted as default_egress_unavailable, not actionable, no detail, server copy; severity and retryable kept; one error log with the ORIGINAL code',
    async (code, severity, customerActionable, retryable) => {
      const { repo, id } = await sessionOn(null);
      const bus = new NotificationEventBus();
      const events: unknown[] = [];
      bus.subscribe('acc_1', (event) => events.push(event));
      const log = logger();
      const relay = makeSessionErrorEventRelay(repo, bus, log);

      relay(
        frame({
          sessionId: id,
          code,
          severity,
          customerActionable,
          retryable,
          summary: 'the session could not connect through its proxy',
          detail: 'upstream 198.51.100.7:1080 refused',
        }),
        'node-1',
      );
      await vi.waitFor(async () => expect((await repo.get(id))?.lastErrorEvent).not.toBeNull());

      expect((await repo.get(id))?.lastErrorEvent).toEqual({
        timestamp: '2026-07-13T06:00:00.000Z',
        code: 'default_egress_unavailable',
        severity,
        summary: DEFAULT_EGRESS_UNAVAILABLE_SUMMARY,
        detail: null,
        customerActionable: false,
        retryable,
      });
      // The customer is notified with the code they will read, not the device's.
      expect(events).toEqual([
        expect.objectContaining({
          kind: 'session.errored',
          errorClass: 'default_egress_unavailable',
        }),
      ]);
      // Operators still learn that the default connection failed, and how.
      expect(errorCalls(log)).toHaveLength(1);
      const [ctx, msg] = errorCalls(log)[0] as [Record<string, unknown>, string];
      expect(ctx).toMatchObject({ sessionId: id, reportingNodeId: 'node-1', code });
      expect(msg).toMatch(/default/i);
      // Never the summary or detail: either can carry an address.
      expect(JSON.stringify(ctx)).not.toMatch(/198\.51\.100\.7|could not connect/);
      expect(ctx).not.toHaveProperty('summary');
      expect(ctx).not.toHaveProperty('detail');
    },
  );

  it.each(FAMILY)('proxyId null + %s is rewritten', async (code) => {
    const { repo, id } = await sessionOn(null);
    const relay = makeSessionErrorEventRelay(repo, new NotificationEventBus(), logger());
    relay(frame({ sessionId: id, code }), 'node-1');
    await vi.waitFor(async () => expect((await repo.get(id))?.lastErrorEvent).not.toBeNull());
    expect((await repo.get(id))?.lastErrorEvent?.code).toBe('default_egress_unavailable');
  });

  it.each(NOT_FAMILY)(
    'proxyId null + %s is persisted exactly as sent, with no read and no error log',
    async (code) => {
      const { repo, id } = await sessionOn(null);
      const get = vi.spyOn(repo, 'get');
      const record = vi.spyOn(repo, 'recordErrorEvent');
      const log = logger();
      const relay = makeSessionErrorEventRelay(repo, new NotificationEventBus(), log);
      const sent = frame({
        sessionId: id,
        code,
        summary: 'The page stopped running.',
        detail: 'signal 9',
      });
      relay(sent, 'node-1');
      await vi.waitFor(() => expect(record).toHaveBeenCalledTimes(1));
      await record.mock.results[0]?.value;
      // A code outside the family costs what it did before: no read of the row.
      expect(get).not.toHaveBeenCalled();
      const stored = (await repo.get(id))?.lastErrorEvent;
      expect(stored).toEqual({
        timestamp: sent.timestamp,
        code,
        severity: sent.severity,
        summary: 'The page stopped running.',
        detail: 'signal 9',
        customerActionable: sent.customerActionable,
        retryable: sent.retryable,
      });
      expect(log.error).not.toHaveBeenCalled();
    },
  );

  it('CRITICAL proxyId set + proxy_connection_failed → persisted exactly as sent', async () => {
    const { repo, id } = await sessionOn('prx_customer_own');
    const log = logger();
    const relay = makeSessionErrorEventRelay(repo, new NotificationEventBus(), log);
    const sent = frame({
      sessionId: id,
      code: 'proxy_connection_failed',
      summary: 'the session could not connect through its proxy',
      detail: 'connection refused',
      customerActionable: true,
      retryable: true,
    });
    relay(sent, 'node-1');
    await vi.waitFor(async () => expect((await repo.get(id))?.lastErrorEvent).not.toBeNull());
    expect((await repo.get(id))?.lastErrorEvent).toEqual({
      timestamp: sent.timestamp,
      code: 'proxy_connection_failed',
      severity: 'error',
      summary: 'the session could not connect through its proxy',
      detail: 'connection refused',
      customerActionable: true,
      retryable: true,
    });
    expect(log.error).not.toHaveBeenCalled();
  });

  it('an unknown session drops as it does today: nothing persisted, no notification, the same warn, no error log', async () => {
    const repo = new InMemoryAgentSessionsRepo();
    const bus = new NotificationEventBus();
    const publish = vi.spyOn(bus, 'publish');
    const log = logger();
    const relay = makeSessionErrorEventRelay(repo, bus, log);
    relay(frame({ sessionId: 'agt_inmem_99999999', code: 'proxy_connection_failed' }), 'node-1');
    await vi.waitFor(() =>
      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'agt_inmem_99999999',
          reportingNodeId: 'node-1',
          code: 'proxy_connection_failed',
        }),
        'dropped errorEvent without an exact session-owner node match',
      ),
    );
    expect(publish).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
  });

  it('a node that does not own the session is still refused, and the rewrite does not widen that', async () => {
    const { repo, id } = await sessionOn(null);
    const bus = new NotificationEventBus();
    const publish = vi.spyOn(bus, 'publish');
    const log = logger();
    const relay = makeSessionErrorEventRelay(repo, bus, log);
    relay(frame({ sessionId: id, code: 'proxy_connection_failed' }), 'node-stranger');
    await vi.waitFor(() => expect(log.warn).toHaveBeenCalledTimes(1));
    expect((await repo.get(id))?.lastErrorEvent).toBeNull();
    expect(publish).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
  });

  it("the proxy read runs inside the reporting node's concurrency cap", () => {
    const repo = {
      get: vi.fn(() => new Promise<never>(() => undefined)),
      recordErrorEvent: vi.fn(() => new Promise<never>(() => undefined)),
    };
    const relay = makeSessionErrorEventRelay(repo, new NotificationEventBus(), logger());
    for (let i = 0; i < ERROR_EVENT_RELAY_MAX_CONCURRENT_PER_NODE * 3; i += 1) {
      relay(frame({ sessionId: `agt_read_${i}`, code: 'proxy_connection_failed' }), 'node-1');
    }
    expect(repo.get).toHaveBeenCalledTimes(ERROR_EVENT_RELAY_MAX_CONCURRENT_PER_NODE);
    expect(repo.recordErrorEvent).not.toHaveBeenCalled();
  });

  it('the server copy says what happened and what to do, and uses no internal word', () => {
    const summary = DEFAULT_EGRESS_UNAVAILABLE_SUMMARY;
    expect(summary).toMatch(/did not use a proxy of your own/);
    expect(summary).toMatch(/on our side/);
    expect(summary).toMatch(/one of your own proxies/);
    expect(summary).not.toMatch(BANNED);
    expect(summary.length).toBeLessThanOrEqual(HARNESS_ERROR_EVENT_SUMMARY_MAX_LENGTH);
  });

  it("the desktop app's sentence for the new code does not repeat the server's line word for word", () => {
    // The app renders the server summary VERBATIM as a quieter second line under
    // its own explanation (AgentSessionPanel), so both are on screen together.
    const panel = readFileSync(
      fileURLToPath(
        new URL('../../../gui-client/src/components/AgentSessionPanel.tsx', import.meta.url),
      ),
      'utf8',
    );
    const branch =
      /normalized === 'default_egress_unavailable'\)\s*\{[\s\S]*?outcome:\s*("|')(.+?)\1,[\s\S]*?explanation:\s*("|')(.+?)\3,/.exec(
        panel,
      );
    expect(branch, 'the app has a branch for default_egress_unavailable').not.toBeNull();
    const appText = `${branch?.[2] ?? ''} ${branch?.[4] ?? ''}`;
    expect(appText).not.toMatch(BANNED);
    const words = (t: string): string[] => t.toLowerCase().match(/[a-z']+/g) ?? [];
    const grams = (t: string, n: number): Set<string> => {
      const w = words(t);
      const out = new Set<string>();
      for (let i = 0; i + n <= w.length; i += 1) out.add(w.slice(i, i + n).join(' '));
      return out;
    };
    const serverGrams = grams(DEFAULT_EGRESS_UNAVAILABLE_SUMMARY, 5);
    const shared = [...grams(appText, 5)].filter((g) => serverGrams.has(g));
    expect(shared, 'five-word runs the two lines share').toEqual([]);
  });
});

describe('the refusal of a session started with no proxy reads in server copy, not the device sentence', () => {
  // When no connection of ours is offered, the device refuses a session started
  // with no proxy: errorEvent code `proxy_required` (end reason
  // `no_proxy_configured`), summary "no_proxy_configured: session refused —
  // egress requires the customer proxy". The desktop app renders the summary
  // VERBATIM as the session-end detail line, so a customer read our internal word
  // and a device token. If the default upstream is unset this is the path for
  // EVERY no-proxy session. The code, severity and both booleans stay as sent;
  // only the words change. It is NOT the default-connection remap: nothing of
  // ours failed — the session was refused for having no proxy.
  const BANNED =
    /\b(fleet|nodes?|harness|control plane|observer|vantage|interpose|macworker|undetectable|egress)\b|ai credits?/i;
  const DEVICE_SUMMARY =
    'no_proxy_configured: session refused — egress requires the customer proxy';

  async function sessionOn(
    proxyId: string | null,
  ): Promise<{ repo: InMemoryAgentSessionsRepo; id: string }> {
    const repo = new InMemoryAgentSessionsRepo();
    const session = await repo.create({ accountId: 'acc_1', tokenBudgetTotal: 100 });
    await repo.setNodeId(session.id, 'node-1', proxyId);
    return { repo, id: session.id };
  }

  it.each([
    ['proxy_required', null],
    ['no_proxy_configured', null],
    // The copy does not depend on the row: the device only refuses this way when
    // no proxy reached it, so a set proxyId changes nothing and is never read.
    ['proxy_required', 'prx_customer_own'],
  ] as const)(
    'CRITICAL %s (proxyId %s) keeps its code, severity and flags, with server copy and no detail',
    async (code, proxyId) => {
      const { repo, id } = await sessionOn(proxyId);
      const record = vi.spyOn(repo, 'recordErrorEvent');
      const bus = new NotificationEventBus();
      const events: unknown[] = [];
      bus.subscribe('acc_1', (event) => events.push(event));
      const log = logger();
      const relay = makeSessionErrorEventRelay(repo, bus, log);
      relay(
        frame({
          sessionId: id,
          code,
          severity: 'fatal',
          summary: DEVICE_SUMMARY,
          detail: 'require_proxy=1 upstream=',
          customerActionable: true,
          retryable: false,
        }),
        'node-1',
      );
      await vi.waitFor(() => expect(record).toHaveBeenCalledTimes(1));
      await record.mock.results[0]?.value;
      expect((await repo.get(id))?.lastErrorEvent).toEqual({
        timestamp: '2026-07-13T06:00:00.000Z',
        code,
        severity: 'fatal',
        summary: NO_PROXY_REFUSAL_SUMMARY,
        detail: null,
        customerActionable: true,
        retryable: false,
      });
      // Separate from the default-connection remap: the code is the refusal's.
      expect(events).toEqual([expect.objectContaining({ errorClass: code })]);
      expect(log.error).not.toHaveBeenCalled();
    },
  );

  it('the refusal costs no read of the row', async () => {
    const { repo, id } = await sessionOn(null);
    const get = vi.spyOn(repo, 'get');
    const record = vi.spyOn(repo, 'recordErrorEvent');
    const relay = makeSessionErrorEventRelay(repo, new NotificationEventBus(), logger());
    relay(frame({ sessionId: id, code: 'proxy_required', summary: DEVICE_SUMMARY }), 'node-1');
    await vi.waitFor(() => expect(record).toHaveBeenCalledTimes(1));
    expect(get).not.toHaveBeenCalled();
  });

  it('the server copy says what happened and what to do, in no internal word', () => {
    expect(NO_PROXY_REFUSAL_SUMMARY).toMatch(/without a proxy|no proxy of yours/);
    expect(NO_PROXY_REFUSAL_SUMMARY).toMatch(/one of your saved proxies/);
    expect(NO_PROXY_REFUSAL_SUMMARY).not.toMatch(BANNED);
    expect(NO_PROXY_REFUSAL_SUMMARY).not.toMatch(/_/);
    expect(NO_PROXY_REFUSAL_SUMMARY.length).toBeLessThanOrEqual(
      HARNESS_ERROR_EVENT_SUMMARY_MAX_LENGTH,
    );
  });

  it("the desktop app's sentence for the refusal does not repeat the server's line word for word", () => {
    const panel = readFileSync(
      fileURLToPath(
        new URL('../../../gui-client/src/components/AgentSessionPanel.tsx', import.meta.url),
      ),
      'utf8',
    );
    const branch =
      /normalized === 'proxy_required' \|\| normalized === 'no_proxy_configured'\)\s*\{[\s\S]*?outcome:\s*("|')(.+?)\1,[\s\S]*?explanation:\s*("|')(.+?)\3,/.exec(
        panel,
      );
    expect(branch, 'the app has a branch for the refusal').not.toBeNull();
    const appText = `${branch?.[2] ?? ''} ${branch?.[4] ?? ''}`;
    expect(appText).not.toMatch(BANNED);
    const words = (t: string): string[] => t.toLowerCase().match(/[a-z']+/g) ?? [];
    const grams = (t: string, n: number): Set<string> => {
      const w = words(t);
      const out = new Set<string>();
      for (let i = 0; i + n <= w.length; i += 1) out.add(w.slice(i, i + n).join(' '));
      return out;
    };
    const serverGrams = grams(NO_PROXY_REFUSAL_SUMMARY, 5);
    const shared = [...grams(appText, 5)].filter((g) => serverGrams.has(g));
    expect(shared, 'five-word runs the two lines share').toEqual([]);
  });
});

describe("a failure on our side, on a session with the customer's own proxy, is not blamed on that proxy", () => {
  // Checked against the device source: proxy_boot_failed is our local relay not
  // booting, network_shim_boot_failed our per-session network process not
  // starting, and egress_lost our local relay or tunnel PROCESS dying mid-session
  // (sweepEgressReverification decides it with a local isAlive(), which by the
  // device's own note cannot see a dead upstream proxy). The device's summary for
  // each is its internal detail — `egress_lost`, `proxy_boot_failed after 3
  // attempt(s): …` — and the app renders it verbatim. On a session with no proxy
  // of its own these are rewritten to default_egress_unavailable (above); on a
  // session WITH one the code stays, the words become ours, and egress_lost stops
  // telling the customer the fix is theirs.
  const BANNED =
    /\b(fleet|nodes?|harness|control plane|observer|vantage|interpose|macworker|undetectable|egress)\b|ai credits?/i;

  async function sessionOn(
    proxyId: string | null,
  ): Promise<{ repo: InMemoryAgentSessionsRepo; id: string }> {
    const repo = new InMemoryAgentSessionsRepo();
    const session = await repo.create({ accountId: 'acc_1', tokenBudgetTotal: 100 });
    await repo.setNodeId(session.id, 'node-1', proxyId);
    return { repo, id: session.id };
  }

  it.each([
    // [code, as the device sends it: summary, customerActionable, retryable]
    ['egress_lost', 'egress_lost', true, true],
    ['proxy_boot_failed', 'proxy_boot_failed after 3 attempt(s): bind 10.0.0.7:21080', false, true],
    ['network_shim_boot_failed', 'network_shim_boot_failed: spawn ENOENT', false, true],
  ] as const)(
    "CRITICAL proxyId set + %s → the code kept, server copy, no detail, not the customer's to fix",
    async (code, summary, customerActionable, retryable) => {
      const { repo, id } = await sessionOn('prx_customer_own');
      const bus = new NotificationEventBus();
      const events: unknown[] = [];
      bus.subscribe('acc_1', (event) => events.push(event));
      const log = logger();
      const relay = makeSessionErrorEventRelay(repo, bus, log);
      relay(
        frame({
          sessionId: id,
          code,
          severity: 'error',
          summary,
          // The device sends these with no detail at all (ErrorEvent.detail nil).
          detail: undefined,
          customerActionable,
          retryable,
        }),
        'node-1',
      );
      await vi.waitFor(async () => expect((await repo.get(id))?.lastErrorEvent).not.toBeNull());
      expect((await repo.get(id))?.lastErrorEvent).toEqual({
        timestamp: '2026-07-13T06:00:00.000Z',
        code,
        severity: 'error',
        summary: OUR_SIDE_CONNECTION_SUMMARY,
        detail: null,
        customerActionable: false,
        retryable,
      });
      expect(events).toEqual([expect.objectContaining({ errorClass: code })]);
      expect(log.error).not.toHaveBeenCalled();
    },
  );

  it('proxyId null + the same codes is still the default-connection rewrite, not this copy', async () => {
    const { repo, id } = await sessionOn(null);
    const relay = makeSessionErrorEventRelay(repo, new NotificationEventBus(), logger());
    relay(frame({ sessionId: id, code: 'egress_lost', summary: 'egress_lost' }), 'node-1');
    await vi.waitFor(async () => expect((await repo.get(id))?.lastErrorEvent).not.toBeNull());
    const stored = (await repo.get(id))?.lastErrorEvent;
    expect(stored?.code).toBe('default_egress_unavailable');
    expect(stored?.summary).toBe(DEFAULT_EGRESS_UNAVAILABLE_SUMMARY);
  });

  it("proxy_connection_failed on the customer's own proxy is still theirs, as sent", async () => {
    const { repo, id } = await sessionOn('prx_customer_own');
    const relay = makeSessionErrorEventRelay(repo, new NotificationEventBus(), logger());
    relay(
      frame({ sessionId: id, code: 'proxy_connection_failed', summary: 'could not connect' }),
      'node-1',
    );
    await vi.waitFor(async () => expect((await repo.get(id))?.lastErrorEvent).not.toBeNull());
    expect((await repo.get(id))?.lastErrorEvent?.summary).toBe('could not connect');
  });

  it('the server copy says it is ours and what to do, in no internal word', () => {
    expect(OUR_SIDE_CONNECTION_SUMMARY).toMatch(/our side/);
    expect(OUR_SIDE_CONNECTION_SUMMARY).not.toMatch(BANNED);
    expect(OUR_SIDE_CONNECTION_SUMMARY).not.toMatch(/_/);
    expect(OUR_SIDE_CONNECTION_SUMMARY.length).toBeLessThanOrEqual(
      HARNESS_ERROR_EVENT_SUMMARY_MAX_LENGTH,
    );
  });

  it("the desktop app's sentences for these codes do not repeat the server's line word for word", () => {
    const panel = readFileSync(
      fileURLToPath(
        new URL('../../../gui-client/src/components/AgentSessionPanel.tsx', import.meta.url),
      ),
      'utf8',
    );
    const words = (t: string): string[] => t.toLowerCase().match(/[a-z']+/g) ?? [];
    const grams = (t: string, n: number): Set<string> => {
      const w = words(t);
      const out = new Set<string>();
      for (let i = 0; i + n <= w.length; i += 1) out.add(w.slice(i, i + n).join(' '));
      return out;
    };
    const serverGrams = grams(OUR_SIDE_CONNECTION_SUMMARY, 5);
    for (const head of [
      "normalized === 'proxy_boot_failed' || normalized === 'network_shim_boot_failed'",
      "normalized === 'egress_lost'",
    ]) {
      const at = panel.indexOf(`if (${head}) {`);
      expect(at, head).toBeGreaterThan(-1);
      const branch = /outcome:\s*("|')(.+?)\1,[\s\S]*?explanation:\s*("|')(.+?)\3,/.exec(
        panel.slice(at),
      );
      expect(branch, head).not.toBeNull();
      const appText = `${branch?.[2] ?? ''} ${branch?.[4] ?? ''}`;
      expect(appText, head).not.toMatch(BANNED);
      const shared = [...grams(appText, 5)].filter((g) => serverGrams.has(g));
      expect(shared, `five-word runs shared with the server line (${head})`).toEqual([]);
    }
  });
});
