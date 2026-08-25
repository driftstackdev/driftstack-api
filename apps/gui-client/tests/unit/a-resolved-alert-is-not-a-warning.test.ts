import { describe, expect, it } from 'vitest';
import type { NotificationEvent } from '../../src/lib/notifications';
import {
  digestNotifications,
  highestLevel,
  notificationLevel,
  notificationTitle,
  unreadCount,
  type LocalNotice,
} from '../../src/lib/notification-digest';

/**
 * V-1611 #18. The four notification kinds carry THREE severity conventions —
 * `warn|critical|resolved`, `minor|major|outage`, and twice none at all — so a
 * single panel has to reconcile them. Each arm pins a case where the obvious
 * reconciliation is wrong.
 */

const cost = (severity: 'warn' | 'critical' | 'resolved'): NotificationEvent => ({
  kind: 'cost.threshold_alert',
  accountId: 'acc_1',
  severity,
  billingCycle: '2026-08',
  previousState: 'under-soft',
  currentState: 'between-soft-and-hard',
  totalCents: 1200,
  thresholdSoftCents: 1000,
  thresholdHardCents: 5000,
  at: '2026-08-25T12:00:00.000Z',
});
const incident = (severity: 'minor' | 'major' | 'outage'): NotificationEvent => ({
  kind: 'incident.broadcast',
  accountId: 'acc_1',
  incidentId: 'inc_1',
  severity,
  title: 'Elevated error rates in eu-central',
  at: '2026-08-25T12:00:00.000Z',
});
const audit: NotificationEvent = {
  kind: 'audit.high_severity',
  accountId: 'acc_1',
  action: 'account.api_key_revoked',
  actorType: 'customer',
  targetResourceId: 'key_1',
  at: '2026-08-25T12:00:00.000Z',
};
const errored: NotificationEvent = {
  kind: 'session.errored',
  accountId: 'acc_1',
  sessionId: 'as_1',
  errorClass: 'harness_unreachable',
  at: '2026-08-25T12:00:00.000Z',
};

describe('notificationLevel', () => {
  it('⛔ a RESOLVED cost alert is good news, not a warning', () => {
    // The only severity value in the union that means things got BETTER. Every
    // naive mapping (`critical ? critical : warn`) renders it amber, so a
    // customer whose bill just came back under budget gets an alert saying so.
    expect(notificationLevel(cost('resolved'))).toBe('info');
  });

  it('maps the two real cost severities', () => {
    expect(notificationLevel(cost('warn'))).toBe('warn');
    expect(notificationLevel(cost('critical'))).toBe('critical');
  });

  it('treats only an outage as critical among incidents', () => {
    expect(notificationLevel(incident('outage'))).toBe('critical');
    expect(notificationLevel(incident('major'))).toBe('warn');
    expect(notificationLevel(incident('minor'))).toBe('warn');
  });

  it('does not downgrade the two kinds that carry no severity field', () => {
    // `audit.high_severity` was named high-severity by the server that
    // published it; `session.errored` is work the customer lost. An absent
    // field is not a low one.
    expect(notificationLevel(audit)).toBe('warn');
    expect(notificationLevel(errored)).toBe('warn');
  });
});

describe('notificationTitle', () => {
  it('says what happened rather than naming the event kind', () => {
    expect(notificationTitle(errored)).toBe('A session stopped: harness_unreachable');
    expect(notificationTitle(audit)).toBe('Security event: account.api_key_revoked');
    expect(notificationTitle(incident('minor'))).toBe('Elevated error rates in eu-central');
  });

  it('distinguishes all three cost outcomes, including the good one', () => {
    expect(notificationTitle(cost('resolved'))).toMatch(/back under/i);
    expect(notificationTitle(cost('critical'))).toMatch(/hard limit/i);
    expect(notificationTitle(cost('warn'))).toMatch(/soft limit/i);
    for (const s of ['resolved', 'critical', 'warn'] as const) {
      expect(notificationTitle(cost(s))).not.toContain('threshold_alert');
    }
  });
});

describe('unreadCount', () => {
  const older: NotificationEvent = { ...errored, at: '2026-08-25T11:00:00.000Z' };
  const newer: NotificationEvent = { ...errored, at: '2026-08-25T13:00:00.000Z' };

  it('counts everything when nothing has been seen', () => {
    expect(unreadCount([older, newer], null)).toBe(2);
  });

  it('⛔ is STRICTLY after — reopening without a new event shows zero', () => {
    // `>=` would leave the most recent event permanently unread, so the badge
    // could never be cleared by reading it.
    expect(unreadCount([older, newer], newer.at)).toBe(0);
    expect(unreadCount([older, newer], older.at)).toBe(1);
  });

  it('⚠️ compares as DATES, not as strings', () => {
    // ISO-8601 sorts lexicographically only while the offsets match. This
    // marker is the SAME instant as `newer` written with an offset; string
    // comparison would call the event unread.
    expect(unreadCount([newer], '2026-08-25T14:00:00.000+01:00')).toBe(0);
  });

  it('treats an unparseable marker as never-seen rather than all-seen', () => {
    // A badge shown wrongly is recoverable; one hidden wrongly is not.
    expect(unreadCount([older, newer], 'not-a-date')).toBe(2);
  });

  it('counts an event with an unparseable timestamp as unread', () => {
    expect(unreadCount([{ ...errored, at: 'garbage' }], older.at)).toBe(1);
  });
});

describe('highestLevel', () => {
  it('returns null for an empty list — distinct from info', () => {
    // null = nothing to show. 'info' = there IS something and it is calm.
    expect(highestLevel([])).toBeNull();
  });

  it('critical beats warn beats info regardless of order', () => {
    expect(highestLevel([cost('resolved'), errored, incident('outage')])).toBe('critical');
    expect(highestLevel([incident('outage'), cost('resolved')])).toBe('critical');
    expect(highestLevel([cost('resolved'), errored])).toBe('warn');
    expect(highestLevel([cost('resolved')])).toBe('info');
  });
});

describe('digestNotifications', () => {
  const older: NotificationEvent = { ...errored, at: '2026-08-25T11:00:00.000Z' };
  const newer: NotificationEvent = { ...errored, at: '2026-08-25T13:00:00.000Z' };
  const update: LocalNotice = {
    id: 'update-1.2.3',
    level: 'info',
    title: 'Update 1.2.3 is ready to install',
    at: '2026-08-25T12:00:00.000Z',
  };

  it('⛔ merges a CLIENT notice into the server feed without it being a NotificationEvent', () => {
    // The plan asked for update events to be "routed through NotificationEvent".
    // That union is pinned across three surfaces against the server by
    // notification-bus-cross-source-invariant, and the server never publishes
    // an app update — so the two sources merge for DISPLAY only.
    const items = digestNotifications([older, newer], [update]);
    expect(items).toHaveLength(3);
    expect(items.map((i) => i.title)).toContain('Update 1.2.3 is ready to install');
  });

  it('orders newest first ACROSS both sources', () => {
    const items = digestNotifications([older, newer], [update]);
    expect(items.map((i) => i.at)).toEqual([newer.at, update.at, older.at]);
  });

  it('gives every row a distinct key so React can tell two identical events apart', () => {
    const twin: NotificationEvent = { ...errored };
    const items = digestNotifications([twin, twin], [update]);
    expect(new Set(items.map((i) => i.key)).size).toBe(3);
  });

  it('sorts an unparseable timestamp LAST rather than throwing', () => {
    // A row we cannot place is still a row worth showing.
    const bad: NotificationEvent = { ...errored, at: 'garbage' };
    const items = digestNotifications([bad, newer], []);
    expect(items[items.length - 1]?.at).toBe('garbage');
  });

  it('is just the stream when there are no local notices', () => {
    expect(digestNotifications([newer]).map((i) => i.at)).toEqual([newer.at]);
  });
});
