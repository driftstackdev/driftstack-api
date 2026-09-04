// V-553.B-18 — unit tests for IncidentNotificationsService (V-295c3-followup).
//
// Surface under test:
//   - notifyCreated / notifyResolved both walk the confirmed-subscriber
//     list, rotate unsubscribe tokens per email, send the matching
//     template, swallow per-recipient errors so one bad address can't
//     poison the batch
//   - empty subscriber list is a no-op
//   - subscribers with email=null (defensive type guard) are skipped

import { describe, expect, it, vi } from 'vitest';
import { IncidentNotificationsService } from '../../src/services/incident-notifications.js';
import type { EmailService } from '../../src/services/email.js';
import type { IncidentRow, IncidentUpdateRow } from '../../src/services/incidents.js';
import type {
  StatusSubscriberRow,
  StatusSubscribersService,
} from '../../src/services/status-subscribers.js';
import type { Logger } from '../../src/lib/logger.js';

interface SentEmail {
  to: string;
  kind: 'created' | 'resolved';
  title: string;
  unsubscribeLink: string;
}

function makeIncident(overrides: Partial<IncidentRow> = {}): IncidentRow {
  return {
    id: 'inc_1',
    title: 'API blip',
    description: 'investigating',
    severity: 'minor',
    status: 'investigating',
    affectedComponents: ['api'],
    public: true,
    startedAt: new Date('2026-05-11T15:00:00Z'),
    resolvedAt: null,
    createdByAdminId: null,
    createdByAdminKeyId: null,
    autoProbeTarget: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeUpdate(message: string): IncidentUpdateRow {
  return {
    id: 'iu_1',
    incidentId: 'inc_1',
    message,
    status: 'investigating',
    postedByAdminId: null,
    postedByAdminKeyId: null,
    postedAt: new Date(),
  };
}

function makeSubscriber(overrides: Partial<StatusSubscriberRow> = {}): StatusSubscriberRow {
  return {
    id: 'sub_1',
    email: 'subscriber@e.test',
    confirmTokenHash: null,
    confirmExpiresAt: null,
    confirmedAt: new Date('2026-04-01Z'),
    unsubscribeTokenHash: 'unsub_hash',
    unsubscribedAt: null,
    createdAt: new Date(),
    ...overrides,
  };
}

function makeStubs(subscribers: StatusSubscriberRow[]): {
  subs: StatusSubscribersService;
  email: EmailService;
  sends: SentEmail[];
  rotateSpy: ReturnType<typeof vi.fn>;
  logger: Logger;
  logCalls: { fn: 'info' | 'warn'; args: unknown[] }[];
  emailWillThrowFor?: (recipient: string) => boolean;
  setEmailThrowPredicate: (pred: (recipient: string) => boolean) => void;
} {
  const sends: SentEmail[] = [];
  const logCalls: { fn: 'info' | 'warn'; args: unknown[] }[] = [];
  let emailWillThrowFor: ((recipient: string) => boolean) | undefined;
  const rotateSpy = vi.fn((id: string) =>
    Promise.resolve(`fresh-tok-${id}-${(Math.random() * 1e9).toString(36)}`),
  );
  const subs = {
    listConfirmed: () => Promise.resolve(subscribers),
    rotateUnsubscribeToken: rotateSpy,
  } as unknown as StatusSubscribersService;
  const email = {
    sendStatusIncidentNotification: (args: SentEmail & { incidentTime: Date }) => {
      if (emailWillThrowFor?.(args.to)) {
        return Promise.reject(new Error(`recipient ${args.to} bounced`));
      }
      sends.push({
        to: args.to,
        kind: args.kind,
        title: args.title,
        unsubscribeLink: args.unsubscribeLink,
      });
      return Promise.resolve();
    },
  } as unknown as EmailService;
  const logger = {
    info: (...args: unknown[]) => logCalls.push({ fn: 'info', args }),
    warn: (...args: unknown[]) => logCalls.push({ fn: 'warn', args }),
    debug: () => undefined,
    error: () => undefined,
    fatal: () => undefined,
    trace: () => undefined,
  } as unknown as Logger;
  return {
    subs,
    email,
    sends,
    rotateSpy,
    logger,
    logCalls,
    setEmailThrowPredicate: (pred) => {
      emailWillThrowFor = pred;
    },
  };
}

const CONFIG = { statusPageBaseUrl: 'https://status.driftstack.io/' };

describe('V-553.B-18 IncidentNotificationsService.notifyCreated', () => {
  it('no-ops when the confirmed-subscriber list is empty', async () => {
    const stubs = makeStubs([]);
    const svc = new IncidentNotificationsService(stubs.subs, stubs.email, stubs.logger, CONFIG);
    await svc.notifyCreated(makeIncident(), makeUpdate('initial msg'));
    expect(stubs.sends).toHaveLength(0);
    expect(stubs.rotateSpy).not.toHaveBeenCalled();
  });

  it('sends one "created" email per subscriber with a fresh unsub token', async () => {
    const stubs = makeStubs([
      makeSubscriber({ id: 'sub_a', email: 'a@e.test' }),
      makeSubscriber({ id: 'sub_b', email: 'b@e.test' }),
    ]);
    const svc = new IncidentNotificationsService(stubs.subs, stubs.email, stubs.logger, CONFIG);
    await svc.notifyCreated(makeIncident(), makeUpdate('first update'));
    expect(stubs.sends).toHaveLength(2);
    expect(stubs.rotateSpy).toHaveBeenCalledTimes(2);
    // Each send carries a distinct unsubscribe link.
    expect(stubs.sends[0]?.unsubscribeLink).not.toBe(stubs.sends[1]?.unsubscribeLink);
    expect(stubs.sends.every((s) => s.kind === 'created')).toBe(true);
  });

  it('one bad recipient does not poison the batch (failures are swallowed + logged)', async () => {
    const stubs = makeStubs([
      makeSubscriber({ id: 'sub_a', email: 'a@e.test' }),
      makeSubscriber({ id: 'sub_b', email: 'b@e.test' }),
      makeSubscriber({ id: 'sub_c', email: 'c@e.test' }),
    ]);
    stubs.setEmailThrowPredicate((to) => to === 'b@e.test');
    const svc = new IncidentNotificationsService(stubs.subs, stubs.email, stubs.logger, CONFIG);
    await svc.notifyCreated(makeIncident(), makeUpdate('first'));
    // Two successful sends (a + c); b threw.
    expect(stubs.sends.map((s) => s.to)).toEqual(['a@e.test', 'c@e.test']);
    // The failure surfaced as a warn-level log line.
    expect(stubs.logCalls.some((c) => c.fn === 'warn')).toBe(true);
    // The summary line still fires.
    expect(stubs.logCalls.some((c) => c.fn === 'info')).toBe(true);
  });

  it('defensive: skips subscribers with email=null (the listConfirmed invariant should prevent these)', async () => {
    const stubs = makeStubs([
      makeSubscriber({ id: 'sub_a', email: 'a@e.test' }),
      makeSubscriber({ id: 'sub_dead', email: null }),
    ]);
    const svc = new IncidentNotificationsService(stubs.subs, stubs.email, stubs.logger, CONFIG);
    await svc.notifyCreated(makeIncident(), makeUpdate('first'));
    expect(stubs.sends).toHaveLength(1);
    expect(stubs.sends[0]?.to).toBe('a@e.test');
  });

  it('strips trailing base slashes and emits the canonical status unsubscribe route', async () => {
    const stubs = makeStubs([makeSubscriber({ email: 'a@e.test' })]);
    const svc = new IncidentNotificationsService(stubs.subs, stubs.email, stubs.logger, {
      statusPageBaseUrl: 'https://status.driftstack.io///',
    });
    await svc.notifyCreated(makeIncident(), makeUpdate('first'));
    expect(stubs.sends[0]?.unsubscribeLink).toMatch(
      /^https:\/\/status\.driftstack\.io\/subscribe\/unsubscribe\/\?token=/,
    );
    expect(stubs.sends[0]?.unsubscribeLink).not.toContain('driftstack.io//');
  });
});

describe('V-553.B-18 IncidentNotificationsService.notifyResolved', () => {
  it('sends "resolved" template per subscriber', async () => {
    const stubs = makeStubs([makeSubscriber({ email: 'a@e.test' })]);
    const svc = new IncidentNotificationsService(stubs.subs, stubs.email, stubs.logger, CONFIG);
    const incident = makeIncident({
      status: 'resolved',
      resolvedAt: new Date('2026-05-11T16:00:00Z'),
    });
    await svc.notifyResolved(incident, makeUpdate('all clear'));
    expect(stubs.sends).toHaveLength(1);
    expect(stubs.sends[0]?.kind).toBe('resolved');
  });
});
