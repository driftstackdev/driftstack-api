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
  /** Force a fresh subscription WITHOUT changing settings. The bounded
   *  subscriber gives up after a run of errors and latches 'closed'; the
   *  only way back used to be changing baseUrl / signing out+in (re-saving
   *  the SAME key doesn't change the effect deps, so React bailed and the
   *  stream stayed dead). Call this from a Reconnect button so the user has
   *  a real recovery path. Also fired automatically on network-restore +
   *  tab-visible so a Mac sleep/wake or Wi-Fi blip self-heals. */
  reconnect: () => void;
}

export function useNotifications(opts: UseNotificationsOpts = {}): UseNotificationsResult {
  const { settings } = useSettings();
  const [events, setEvents] = useState<readonly NotificationEvent[]>([]);
  const [connection, setConnection] = useState<NotificationConnectionState>('idle');
  // Bump to force the subscribe effect to re-run against the SAME settings
  // (manual Reconnect + network/visibility self-heal). Included in the effect
  // deps below so a change tears down the dead source and opens a fresh one.
  const [reconnectNonce, setReconnectNonce] = useState(0);
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
  }, [
    settings.apiKey,
    settings.baseUrl,
    opts.disabled,
    opts.eventSourceFactory,
    ringSize,
    reconnectNonce,
  ]);

  const reconnect = (): void => {
    setReconnectNonce((n) => n + 1);
  };

  // Self-heal on network-restore + tab-visible. After a Mac sleep/wake or a
  // Wi-Fi flap the bounded subscriber may have already latched 'closed'; these
  // listeners bump the nonce so the effect re-subscribes the moment the host
  // is plausibly reachable again — no user action needed. Guarded for non-DOM
  // (test / SSR) runtimes where window/document are absent.
  useEffect(() => {
    if (opts.disabled === true) return;
    if (typeof window === 'undefined') return;
    const onOnline = (): void => {
      setReconnectNonce((n) => n + 1);
    };
    const onVisible = (): void => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
        setReconnectNonce((n) => n + 1);
      }
    };
    window.addEventListener('online', onOnline);
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisible);
    }
    return () => {
      window.removeEventListener('online', onOnline);
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisible);
      }
    };
  }, [opts.disabled]);

  const dismiss = (): void => {
    setEvents([]);
  };

  return { events, connection, dismiss, reconnect };
}
