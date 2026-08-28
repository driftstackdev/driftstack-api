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
  // ⭐ Takes anything CARRYING a timestamp, not `NotificationEvent`. The
  // function reads exactly one field, and narrowing the parameter to the full
  // event forced callers with a merged list to write
  // `as unknown as NotificationEvent` over an object that is not one — the
  // same "cast asserting a shape it does not have" this codebase fixed in
  // SimulatorWindow today. A parameter should ask for what it reads.
  events: ReadonlyArray<{ at: string }>,
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

/**
 * A notice that did NOT come from the server stream.
 *
 * ⛔ WHY THIS EXISTS RATHER THAN A NEW `NotificationEvent` KIND. The plan said
 * to "route update events through NotificationEvent". That is structurally
 * wrong: `NotificationEvent` is the wire shape of
 * `GET /v1/account/me/notifications`, and
 * `notification-bus-cross-source-invariant` pins it across THREE surfaces —
 * the server union, the SSE route, and the GUI union — asserting all three
 * agree. An app update is a CLIENT event from the Tauri updater; the server
 * neither knows nor publishes it. Adding a kind for it would either break that
 * invariant or force a lie into the server union.
 *
 * So the two sources stay separate at the wire and merge only for DISPLAY,
 * which is where the customer actually wants them together.
 */
export interface LocalNotice {
  /** Stable within a session; used as the React key. */
  id: string;
  level: NotificationLevel;
  title: string;
  at: string;
}

/** One row of the panel, whatever it came from. */
export interface DigestItem {
  key: string;
  level: NotificationLevel;
  title: string;
  at: string;
  /** In-app destination for click-through, or null when none exists (incidents
   *  point at the external status page; audit rows' surface IS the bell). */
  target?: NotificationTarget | null;
}

/**
 * Merge the server feed and any local notices into one list, newest first.
 *
 * ⚠️ Sorted by parsed DATE, not by string — the events carry server timestamps
 * and the notices carry client ones, so the two can differ in offset even when
 * both are valid ISO-8601. An unparseable timestamp sorts last rather than
 * throwing: a row we cannot place is still a row worth showing.
 */
export function digestNotifications(
  events: ReadonlyArray<NotificationEvent>,
  notices: ReadonlyArray<LocalNotice> = [],
): DigestItem[] {
  const fromStream: DigestItem[] = events.map((e, i) => ({
    key: `${e.kind}-${e.at}-${String(i)}`,
    level: notificationLevel(e),
    title: notificationTitle(e),
    at: e.at,
    target: notificationTarget(e),
  }));
  const fromLocal: DigestItem[] = notices.map((n) => ({
    key: `local-${n.id}`,
    level: n.level,
    title: n.title,
    at: n.at,
  }));
  const rank = (at: string): number => {
    const t = Date.parse(at);
    return Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t;
  };
  return [...fromStream, ...fromLocal].sort((a, b) => rank(b.at) - rank(a.at));
}

/** The slice of an audit-log row the bell's history section needs — structural,
 *  so this display lib never imports the SDK. */
export interface AuditHistoryRow {
  id: string;
  action: string;
  timestamp: string;
  target_resource_id: string | null;
}

/** Outcome of the bell's on-open durable-history fetch. Forbidden is its own
 *  case because a key without read:audit is a configuration the panel must
 *  EXPLAIN, not an error to shrug at. */
export type HistoryOutcome =
  | { kind: 'ok'; items: DigestItem[] }
  | { kind: 'forbidden' }
  | { kind: 'error' };

/** Destructive / access-revoking actions read as warnings in history; the rest
 *  are info. Critical stays reserved for LIVE events — a row already survived
 *  into the ledger, so it is context, not an alarm. */
const WARN_HISTORY_ACTION = /\.(deleted|revoked|failed|disabled|removed)$/;

export function auditHistoryItem(row: AuditHistoryRow): DigestItem {
  return {
    key: `audit-${row.id}`,
    level: WARN_HISTORY_ACTION.test(row.action) ? 'warn' : 'info',
    title:
      row.target_resource_id === null ? row.action : `${row.action} — ${row.target_resource_id}`,
    at: row.timestamp,
  };
}

/** Classify a failed audit-log fetch. 403 is the one status with a MEANING the
 *  panel can act on (the key lacks read:audit); everything else — transport,
 *  5xx, a thrown non-HTTP error — is just "couldn't load". Pure so the mapping
 *  is testable without a Shell render. */
export function historyOutcomeFromError(err: unknown): HistoryOutcome {
  const status = (err as { status?: unknown } | null)?.status;
  return status === 403 ? { kind: 'forbidden' } : { kind: 'error' };
}

/** The bell's click-through vocabulary — View kinds the shell can navigate to.
 *  A string union rather than the App View type so this lib stays render-free. */
export type NotificationTarget = 'billing' | 'sessions-history';

/** Where a live event should take the customer, or null when no in-app view is
 *  the answer: an incident's home is the status page (external), and a
 *  high-severity audit event's surface is the bell's own history section. */
export function notificationTarget(e: NotificationEvent): NotificationTarget | null {
  switch (e.kind) {
    case 'cost.threshold_alert':
      return 'billing';
    case 'session.errored':
      return 'sessions-history';
    default:
      return null;
  }
}
