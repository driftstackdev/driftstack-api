// Arc 2 sub-slice 8.3 (v2-#8) — AgentSessionEventBus unit tests.

import { describe, expect, it, vi } from 'vitest';
import { AgentSessionEventBus } from '../../src/services/agent-session-event-bus.js';

describe('Arc 2 v2-#8 sub-slice 8.3 AgentSessionEventBus', () => {
  it('subscribe + publish routes events only to subscribers of the matching sessionId', () => {
    const bus = new AgentSessionEventBus();
    const handlerA = vi.fn();
    const handlerB = vi.fn();
    bus.subscribe('agt_a', handlerA);
    bus.subscribe('agt_b', handlerB);
    bus.publish({
      agentSessionId: 'agt_a',
      index: 0,
      entry: { at: 't0', role: 'user', body: 'hi' },
    });
    expect(handlerA).toHaveBeenCalledTimes(1);
    expect(handlerB).not.toHaveBeenCalled();
  });

  it('multiple subscribers per sessionId all receive each event', () => {
    const bus = new AgentSessionEventBus();
    const h1 = vi.fn();
    const h2 = vi.fn();
    const h3 = vi.fn();
    bus.subscribe('agt_x', h1);
    bus.subscribe('agt_x', h2);
    bus.subscribe('agt_x', h3);
    bus.publish({
      agentSessionId: 'agt_x',
      index: 5,
      entry: { at: 't', role: 'agent', body: 'ok' },
    });
    expect(h1).toHaveBeenCalledTimes(1);
    expect(h2).toHaveBeenCalledTimes(1);
    expect(h3).toHaveBeenCalledTimes(1);
  });

  it('unsubscribe() removes a single handler without affecting siblings', () => {
    const bus = new AgentSessionEventBus();
    const h1 = vi.fn();
    const h2 = vi.fn();
    const unsub1 = bus.subscribe('agt_x', h1);
    bus.subscribe('agt_x', h2);
    expect(bus.subscriberCount('agt_x')).toBe(2);
    unsub1();
    expect(bus.subscriberCount('agt_x')).toBe(1);
    bus.publish({
      agentSessionId: 'agt_x',
      index: 0,
      entry: { at: 't', role: 'user', body: 'x' },
    });
    expect(h1).not.toHaveBeenCalled();
    expect(h2).toHaveBeenCalledTimes(1);
  });

  it('subscriberCount drops to 0 + the per-session set is cleaned up when the last unsubscribe fires', () => {
    const bus = new AgentSessionEventBus();
    const unsub = bus.subscribe('agt_x', () => {});
    expect(bus.subscriberCount('agt_x')).toBe(1);
    unsub();
    expect(bus.subscriberCount('agt_x')).toBe(0);
  });

  it('handler exceptions are swallowed and do NOT block sibling handlers', () => {
    const bus = new AgentSessionEventBus();
    const h1 = vi.fn(() => {
      throw new Error('handler 1 explodes');
    });
    const h2 = vi.fn();
    bus.subscribe('agt_x', h1);
    bus.subscribe('agt_x', h2);
    expect(() =>
      bus.publish({
        agentSessionId: 'agt_x',
        index: 0,
        entry: { at: 't', role: 'user', body: 'hi' },
      }),
    ).not.toThrow();
    expect(h2).toHaveBeenCalledTimes(1);
  });

  it('AgentRuntime publishes one event per transcript append (user turn + agent response) when eventBus is wired', async () => {
    const { AgentRuntime } = await import('../../src/services/agent-runtime.js');
    const { DeterministicAgentDecomposer } =
      await import('../../src/services/agent-decomposer-deterministic.js');
    const { StubAgentExecutor } = await import('../../src/services/agent-executor.js');
    const { InMemoryAgentSessionsRepo } = await import('../../src/services/agent-sessions.js');

    const bus = new AgentSessionEventBus();
    const events: Array<{ index: number; entry: unknown }> = [];

    const sessions = new InMemoryAgentSessionsRepo();
    const created = await sessions.create({ accountId: 'acc_1', tokenBudgetTotal: 100_000 });
    bus.subscribe(created.id, (e) => events.push({ index: e.index, entry: e.entry }));

    const runtime = new AgentRuntime({
      decomposer: new DeterministicAgentDecomposer(),
      executor: new StubAgentExecutor(),
      sessions,
      archetype: 'iphone16pro_ios18_7_safari26_4',
      eventBus: bus,
    });
    await runtime.runTurn({
      agentSessionId: created.id,
      userMessage: 'open https://example.com and capture',
    });
    // 2 events expected: user turn (index 0) + plan-executed entry
    // (index 1). DeterministicAgentDecomposer on the "open URL +
    // capture" trigger phrase fires the plan path.
    expect(events).toHaveLength(2);
    expect(events[0]?.index).toBe(0);
    expect(events[1]?.index).toBe(1);
  });

  it('publish to a session with no subscribers is a silent no-op', () => {
    const bus = new AgentSessionEventBus();
    expect(() =>
      bus.publish({
        agentSessionId: 'agt_orphan',
        index: 0,
        entry: { at: 't', role: 'user', body: 'hi' },
      }),
    ).not.toThrow();
  });
});
