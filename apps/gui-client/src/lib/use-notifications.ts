// 2026-05-20 — React hook wrapper around subscribeNotifications().
//
// Maintains a small in-memory ring of recent events + connection
// state for the panel UI. Auto-opens on mount when apiKey + baseUrl
// are present, auto-closes on unmount (or when those settings flip
// to null — e.g. after sign-out).
//
// v0 keeps the ring tiny (16 events) so a long-running session
// doesn't bloat memory; v0.2 will surface a "load more" path against
// the durable audit log if customers ask for one.

import { useEffect, useRef, useState } from 'react';
import { subscribeNotifications, type NotificationEvent } from './notifications';
import { notificationStreamUrl } from './notification-stream-url';
import { useSettings } from './SettingsContext';

const DEFAULT_RING_SIZE = 16;

export type NotificationConnectionState =
  | 'idle'
  | 'connecting'
  | 'open'
  | 'reconnecting'
  | 'closed';

export interface UseNotificationsOpts {
  /** Max events retained in the in-memory ring. Defaults to 16. */
  ringSize?: number;
  /** EventSource factory override for tests. */
  eventSourceFactory?: typeof EventSource;
  /** Disable auto-subscribe (useful for tests + opt-out flows). */
  disabled?: boolean;
}

export interface UseNotificationsResult {
  /** Most-recent events first; capped at `ringSize`. */
  events: readonly NotificationEvent[];
  /** Connection state for the UI banner. */
  connection: NotificationConnectionState;
  /** Drop the in-memory ring (e.g. after the customer reads a toast). */
  dismiss: () => void;
}

export function useNotifications(opts: UseNotificationsOpts = {}): UseNotificationsResult {
  const { settings } = useSettings();
  const [events, setEvents] = useState<readonly NotificationEvent[]>([]);
  const [connection, setConnection] = useState<NotificationConnectionState>('idle');
  const closeRef = useRef<(() => void) | null>(null);
  const ringSize = opts.ringSize ?? DEFAULT_RING_SIZE;

  useEffect(() => {
    if (opts.disabled === true) return;
    const apiKey = settings.apiKey;
    const baseUrl = settings.baseUrl;
    if (apiKey === null || apiKey.length === 0 || baseUrl.length === 0) {
      setConnection('idle');
      return;
    }
    const url = notificationStreamUrl(baseUrl, apiKey);
    const close = subscribeNotifications({
      url,
      onEvent: (event) => {
        setEvents((prev) => [event, ...prev].slice(0, ringSize));
      },
      onState: (state) => {
        setConnection(state);
      },
      ...(opts.eventSourceFactory !== undefined
        ? { eventSourceFactory: opts.eventSourceFactory }
        : {}),
    });
    closeRef.current = close;
    return () => {
      close();
      closeRef.current = null;
    };
  }, [settings.apiKey, settings.baseUrl, opts.disabled, opts.eventSourceFactory, ringSize]);

  const dismiss = (): void => {
    setEvents([]);
  };

  return { events, connection, dismiss };
}
