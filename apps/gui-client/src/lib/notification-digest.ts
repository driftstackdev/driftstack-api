import type { NotificationEvent } from './notifications';

/**
 * V-1611 #18 — the decisions a notification CENTRE needs that a toast stack does
 * not: how urgent is this, what does it say in one line, and how many has the
 * customer not seen.
 *
 * Pure — no React, no clock, no I/O — because every one of these is a claim made
 * to the customer and each deserves its own arm. The transport
 * (`lib/notifications.ts`), the ring (`use-notifications.ts`) and the toasts
 * (`NotificationToastStack`) already exist and are untouched; this is the part
 * they never needed.
 */

/** One vocabulary for the panel, across four kinds that do not share one. */
export type NotificationLevel = 'info' | 'warn' | 'critical';

/**
 * ⛔ The four kinds carry THREE different severity conventions and this is the
 * whole reason the function exists:
 *
 *   cost.threshold_alert   'warn' | 'critical' | 'resolved'
 *   incident.broadcast     'minor' | 'major' | 'outage'
 *   audit.high_severity    (no severity field at all)
 *   session.errored        (no severity field at all)
 *
 * ⛔ `resolved` is the trap. It is the ONLY severity value in the union that
 * means GOOD NEWS — spend went back under the threshold — and every naive
 * mapping (`severity === 'critical' ? … : 'warn'`) renders it as a warning. A
 * customer whose bill just came back under budget should not be shown an amber
 * badge saying so.
 */
export function notificationLevel(e: NotificationEvent): NotificationLevel {
  switch (e.kind) {
    case 'cost.threshold_alert':
      if (e.severity === 'resolved') return 'info';
      return e.severity === 'critical' ? 'critical' : 'warn';
    case 'incident.broadcast':
      // `outage` is the only one the customer cannot work around.
      return e.severity === 'outage' ? 'critical' : 'warn';
    case 'audit.high_severity':
      // The server has already decided this is high-severity by publishing it;
      // it does not carry a level of its own, and downgrading here would
      // contradict the name of the event.
      return 'warn';
    case 'session.errored':
      // A session that died is a job the customer lost. It carries no severity
      // field, and treating "no field" as low would be the wrong default for
      // the one event that reports work not happening.
      return 'warn';
  }
}

/** One line, safe to render. Deliberately says WHAT happened rather than naming
 *  the event kind — `session.errored` is not a sentence. */
export function notificationTitle(e: NotificationEvent): string {
  switch (e.kind) {
    case 'cost.threshold_alert':
      return e.severity === 'resolved'
        ? 'Spending is back under your limit'
        : e.severity === 'critical'
          ? 'Spending passed your hard limit'
          : 'Spending passed your soft limit';
    case 'incident.broadcast':
      return e.title;
    case 'audit.high_severity':
      return `Security event: ${e.action}`;
    case 'session.errored':
      return `A session stopped: ${e.errorClass}`;
  }
}

/**
 * How many events the customer has not seen.
 *
 * ⚠️ `lastSeenAt` is an ISO string compared as a DATE, not as text. ISO-8601
 * sorts lexicographically only while the offsets match, and `at` comes off the
 * wire — a `+01:00` timestamp would compare wrongly against a `Z` one while
 * looking perfectly ordered.
 *
 * ⛔ Strictly AFTER, never equal: re-opening the panel without a new event must
 * show zero, and `>=` would make the most recent event permanently unread.
 */
export function unreadCount(
  events: ReadonlyArray<NotificationEvent>,
  lastSeenAt: string | null,
): number {
  if (lastSeenAt === null) return events.length;
  const seen = Date.parse(lastSeenAt);
  // An unparseable marker is treated as "never seen" rather than "all seen":
  // showing an unread badge that should not be there is recoverable, hiding one
  // that should is not.
  if (Number.isNaN(seen)) return events.length;
  return events.filter((e) => {
    const at = Date.parse(e.at);
    return Number.isNaN(at) ? true : at > seen;
  }).length;
}

/** The highest level present, for the bell itself. `null` when there is nothing
 *  to show — distinct from `'info'`, which means there IS something and it is
 *  calm. */
export function highestLevel(events: ReadonlyArray<NotificationEvent>): NotificationLevel | null {
  let best: NotificationLevel | null = null;
  for (const e of events) {
    const l = notificationLevel(e);
    if (l === 'critical') return 'critical';
    if (l === 'warn') best = 'warn';
    else if (best === null) best = 'info';
  }
  return best;
}
