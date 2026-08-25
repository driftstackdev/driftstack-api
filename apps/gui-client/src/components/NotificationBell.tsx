import { useCallback, useState } from 'react';
import type { NotificationEvent } from '../lib/notifications';
import {
  digestNotifications,
  highestLevel,
  unreadCount,
  type LocalNotice,
  type NotificationLevel,
} from '../lib/notification-digest';

/**
 * V-1611 #18 — the bell and its history panel.
 *
 * ⛔ Takes `events` as a PROP and does not call `useNotifications()`. That hook
 * opens an SSE subscription on mount, so calling it here would open a second
 * stream to the same account for the same events — invisible in the UI and
 * obvious in the server logs. `Shell` owns the one subscription and passes it
 * to both this and the toast stack.
 *
 * ⚠️ "Unread" means SINCE THIS APP LAUNCHED, and that is honest rather than a
 * limitation to apologise for: the ring it reads is in-memory and holds the last
 * 16 events of this session. Persisting a last-seen marker across launches would
 * describe events that are no longer there to show. A durable history belongs on
 * `GET /v1/account/audit-log` and is a separate piece of work.
 */

const DOT: Record<NotificationLevel, string> = {
  info: 'bg-status-ready',
  warn: 'bg-status-busy',
  critical: 'bg-status-error',
};
const BADGE: Record<NotificationLevel, string> = {
  info: 'bg-status-ready text-white',
  warn: 'bg-status-busy text-white',
  critical: 'bg-status-error text-white',
};

export function NotificationBell({
  events,
  notices = [],
}: {
  events: ReadonlyArray<NotificationEvent>;
  /** Client-originated rows — app updates today. Deliberately NOT folded into
   *  `NotificationEvent`: that union is pinned across three surfaces against
   *  the server, which never publishes them. They merge for display only. */
  notices?: ReadonlyArray<LocalNotice>;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  // The marker the unread count is measured against. Null until the panel has
  // been opened once, which is why a fresh launch shows everything as unread.
  const [lastSeenAt, setLastSeenAt] = useState<string | null>(null);

  const items = digestNotifications(events, notices);
  // Unread counts BOTH sources: a shipped update the customer has not looked at
  // is exactly the thing the bell exists to surface.
  const unread = unreadCount(items, lastSeenAt);
  const level = highestLevel(events) ?? (items.length > 0 ? 'info' : null);

  const toggle = useCallback(() => {
    setOpen((wasOpen) => {
      // Mark seen on OPEN, not on close: a customer who opens the panel has
      // seen what is in it, and marking on close would leave the badge lit
      // while they are looking at the thing it points to.
      if (!wasOpen) setLastSeenAt(new Date().toISOString());
      return !wasOpen;
    });
  }, []);

  return (
    <div className="relative">
      <button
        type="button"
        data-testid="notification-bell"
        aria-label={unread === 0 ? 'Notifications' : `Notifications, ${String(unread)} unread`}
        aria-expanded={open}
        onClick={toggle}
        className="relative flex h-6 w-6 items-center justify-center rounded text-ink-secondary hover:text-ink-primary"
      >
        <span aria-hidden="true">🔔</span>
        {unread > 0 && level !== null && (
          <span
            data-testid="notification-bell-badge"
            className={`absolute -right-1 -top-1 min-w-[14px] rounded-full px-1 text-[9px] font-semibold leading-[14px] ${BADGE[level]}`}
          >
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>
      {open && (
        <div
          data-testid="notification-panel"
          className="absolute right-0 top-8 z-50 w-80 rounded-lg border border-surface-divider bg-surface-elevated p-2 shadow-lg"
        >
          {items.length === 0 ? (
            <p className="px-2 py-3 text-2xs text-ink-muted">
              Nothing yet. Cost alerts, incidents and session failures show up here.
            </p>
          ) : (
            <ol className="flex max-h-80 flex-col gap-1 overflow-y-auto">
              {items.map((item) => (
                <li
                  key={item.key}
                  className="flex gap-2 rounded px-2 py-1.5 hover:bg-surface-inset"
                >
                  <span
                    aria-hidden="true"
                    className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${DOT[item.level]}`}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block break-words text-xs text-ink-primary">{item.title}</span>
                    <span className="block text-2xs text-ink-muted">{item.at}</span>
                  </span>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </div>
  );
}
