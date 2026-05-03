// V-090: unit tests for SessionsService.runWithFailureCapture.
//
// Driver throws → session marked 'errored' + destroyedAt set + 'errored'
// session_event recorded + session.failed webhook fired. Subsequent
// operations on the same session 410 SessionDestroyed (founder-approved
// semantic).

import { describe, expect, it } from 'vitest';
import { SessionsService } from '../../src/services/sessions.js';
import type {
  SessionRepo,
  SessionRecord,
  SessionEventInput,
  NewSessionInput,
} from '../../src/services/sessions.js';
import type { Driver } from '../../src/drivers/types.js';
import type { AccountContext } from '../../src/services/auth.js';

interface RecordedEvent {
  accountId: string;
  eventType: 'session.completed' | 'session.failed';
  data: Record<string, unknown>;
}

function buildCtx(): AccountContext {
  return {
    account: {
      id: 'acc-uuid-test',
      email: 'tester@driftstack.local',
      name: null,
      tier: 'api_builder',
      status: 'active',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
    },
    apiKey: {
      id: 'key-uuid-test',
      accountId: 'acc-uuid-test',
      name: 'tester',
      keyPrefix: 'ds_test_xxxx',
      keyHash: 'fake',
      scopes: ['read', 'write'],
      lastUsedAt: null,
      revokedAt: null,
      expiresAt: null,
      createdAt: new Date('2026-01-01T00:00:00Z'),
    },
    rateLimitOverrides: [],
  };
}

class StubRepo implements SessionRepo {
  private readonly sessions = new Map<string, SessionRecord>();
  readonly events: SessionEventInput[] = [];

  insertSession(input: NewSessionInput): Promise<SessionRecord> {
    const id = `sess-${this.sessions.size.toString().padStart(4, '0')}`;
    const now = new Date();
    const row: SessionRecord = {
      id,
      accountId: input.accountId,
      apiKeyId: input.apiKeyId,
      driverSessionId: input.driverSessionId,
      status: 'creating',
      archetype: input.archetype,
      label: input.label,
      metadata: input.metadata,
      createdAt: now,
      updatedAt: now,
      lastStateAt: null,
      destroyedAt: null,
    };
    this.sessions.set(id, row);
    return Promise.resolve(row);
  }
  findSession(id: string, accountId: string): Promise<SessionRecord | null> {
    const r = this.sessions.get(id);
    if (!r || r.accountId !== accountId) return Promise.resolve(null);
    return Promise.resolve(r);
  }
  findSessionUnscoped(id: string): Promise<SessionRecord | null> {
    return Promise.resolve(this.sessions.get(id) ?? null);
  }
  updateSessionStatus(
    id: string,
    status: SessionRecord['status'],
    extra?: { lastStateAt?: Date; destroyedAt?: Date },
  ): Promise<void> {
    const r = this.sessions.get(id);
    if (!r) return Promise.resolve();
    this.sessions.set(id, {
      ...r,
      status,
      ...(extra?.lastStateAt !== undefined ? { lastStateAt: extra.lastStateAt } : {}),
      ...(extra?.destroyedAt !== undefined ? { destroyedAt: extra.destroyedAt } : {}),
    });
    return Promise.resolve();
  }
  countActiveSessions(_accountId: string): Promise<number> {
    return Promise.resolve(0);
  }
  listSessions(): Promise<{ data: SessionRecord[]; hasMore: boolean; nextCursor: string | null }> {
    return Promise.resolve({ data: [], hasMore: false, nextCursor: null });
  }
  recordEvent(input: SessionEventInput): Promise<void> {
    this.events.push(input);
    return Promise.resolve();
  }

  /** Test seam. */
  read(id: string): SessionRecord | undefined {
    return this.sessions.get(id);
  }
}

class ThrowingDriver implements Driver {
  private nextId = 0;
  private throwOnNext: { name: string; message: string } | null = null;

  primeNextThrow(args: { name: string; message: string }): void {
    this.throwOnNext = args;
  }

  private throwIfArmed(): void {
    if (this.throwOnNext === null) return;
    const t = this.throwOnNext;
    this.throwOnNext = null;
    const err = new Error(t.message);
    err.name = t.name;
    throw err;
  }

  createSession(): Promise<{ driverSessionId: string }> {
    this.nextId += 1;
    return Promise.resolve({ driverSessionId: `mock-${this.nextId.toString()}` });
  }
  navigate(): Promise<{ url: string; finalUrl: string; status: number; durationMs: number }> {
    this.throwIfArmed();
    return Promise.resolve({
      url: 'about:blank',
      finalUrl: 'about:blank',
      status: 200,
      durationMs: 1,
    });
  }
  interact(): Promise<{ durationMs: number }> {
    this.throwIfArmed();
    return Promise.resolve({ durationMs: 1 });
  }
  guiInput(): Promise<{ durationMs: number }> {
    this.throwIfArmed();
    return Promise.resolve({ durationMs: 1 });
  }
  wait(): Promise<{ satisfied: boolean; durationMs: number }> {
    this.throwIfArmed();
    return Promise.resolve({ satisfied: true, durationMs: 1 });
  }
  getState(): Promise<{
    url: string | null;
    title: string | null;
    cookies: Array<Record<string, unknown>>;
    localStorage: Record<string, string>;
    capturedAt: Date;
  }> {
    this.throwIfArmed();
    return Promise.resolve({
      url: null,
      title: null,
      cookies: [],
      localStorage: {},
      capturedAt: new Date(),
    });
  }
  capture(): Promise<{
    kind: 'screenshot' | 'pdf' | 'dom_snapshot';
    data: string;
    encoding: 'base64' | 'utf8';
    byteSize: number;
    durationMs: number;
  }> {
    this.throwIfArmed();
    return Promise.resolve({
      kind: 'screenshot',
      data: 'AAAA',
      encoding: 'base64',
      byteSize: 4,
      durationMs: 1,
    });
  }
  destroy(): Promise<void> {
    return Promise.resolve();
  }
}

function buildService(): {
  service: SessionsService;
  repo: StubRepo;
  driver: ThrowingDriver;
  webhookEvents: RecordedEvent[];
} {
  const repo = new StubRepo();
  const driver = new ThrowingDriver();
  const webhookEvents: RecordedEvent[] = [];
  const service = new SessionsService({
    repo,
    driver,
    webhooks: {
      enqueueEvent: (accountId, eventType, data) => {
        webhookEvents.push({ accountId, eventType, data });
        return Promise.resolve(1);
      },
    },
  });
  return { service, repo, driver, webhookEvents };
}

describe('SessionsService — V-090 driver-failure capture', () => {
  it('navigate driver throw → session.errored + session.failed webhook + re-throw', async () => {
    const { service, repo, driver, webhookEvents } = buildService();
    const ctx = buildCtx();
    const session = await service.create(ctx, { archetype: 'iphone16pro_ios26_4_1' });

    driver.primeNextThrow({ name: 'DriverError', message: 'WebKit handle gone' });

    let caught: unknown;
    try {
      await service.navigate(ctx, session.id, { url: 'https://example.com', wait_until: 'load' });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe('WebKit handle gone');

    const updated = repo.read(session.id);
    expect(updated?.status).toBe('errored');
    expect(updated?.destroyedAt).toBeInstanceOf(Date);

    const erroredEvent = repo.events.find((e) => e.type === 'errored');
    expect(erroredEvent).toBeDefined();
    expect((erroredEvent?.payload as { operation: string } | null)?.operation).toBe('navigate');

    expect(webhookEvents).toHaveLength(1);
    expect(webhookEvents[0]?.eventType).toBe('session.failed');
    expect((webhookEvents[0]?.data as { operation: string }).operation).toBe('navigate');
    expect(webhookEvents[0]?.data.session_id).toBe(`ses_${session.id}`);
  });

  it('subsequent op on errored session 410s without re-firing webhook', async () => {
    const { service, repo, driver, webhookEvents } = buildService();
    const ctx = buildCtx();
    const session = await service.create(ctx, { archetype: 'iphone16pro_ios26_4_1' });

    // First failure
    driver.primeNextThrow({ name: 'DriverError', message: 'first fail' });
    await expect(
      service.navigate(ctx, session.id, { url: 'https://example.com', wait_until: 'load' }),
    ).rejects.toThrow();

    expect(webhookEvents).toHaveLength(1);

    // Subsequent op on the same session → SessionDestroyedError
    let caught: unknown;
    try {
      await service.interact(ctx, session.id, { action: { kind: 'tap', selector: 'button' } });
    } catch (e) {
      caught = e;
    }
    expect((caught as Error).name).toBe('SessionDestroyedError');

    // No second webhook event
    expect(webhookEvents).toHaveLength(1);
    expect(repo.read(session.id)?.status).toBe('errored');
  });

  it('interact / wait / capture / state — each produces session.failed on driver throw', async () => {
    for (const op of ['interact', 'wait', 'capture', 'state'] as const) {
      const { service, repo, driver, webhookEvents } = buildService();
      const ctx = buildCtx();
      const session = await service.create(ctx, { archetype: 'iphone16pro_ios26_4_1' });
      driver.primeNextThrow({ name: 'DriverError', message: `${op} boom` });

      try {
        if (op === 'interact') {
          await service.interact(ctx, session.id, { action: { kind: 'tap', selector: 'b' } });
        } else if (op === 'wait') {
          await service.wait(ctx, session.id, {
            condition: { kind: 'selector', selector: 'b' },
          });
        } else if (op === 'capture') {
          await service.capture(ctx, session.id, { kind: 'screenshot', full_page: false });
        } else {
          await service.getState(ctx, session.id);
        }
      } catch {
        // expected
      }

      expect(webhookEvents).toHaveLength(1);
      expect(webhookEvents[0]?.eventType).toBe('session.failed');
      const webhookOp = (webhookEvents[0]?.data as { operation: string }).operation;
      // capture / state map to capture / state_capture in the operation
      // tag respectively
      const expectedOp = op === 'state' ? 'state_capture' : op;
      expect(webhookOp).toBe(expectedOp);
      expect(repo.read(session.id)?.status).toBe('errored');
    }
  });

  it('successful ops do NOT emit session.failed', async () => {
    const { service, webhookEvents } = buildService();
    const ctx = buildCtx();
    const session = await service.create(ctx, { archetype: 'iphone16pro_ios26_4_1' });

    await service.navigate(ctx, session.id, { url: 'https://example.com', wait_until: 'load' });
    await service.getState(ctx, session.id);
    await service.destroy(ctx, session.id);

    // Only session.completed should fire (from destroy).
    expect(webhookEvents.map((e) => e.eventType)).toEqual(['session.completed']);
  });
});
