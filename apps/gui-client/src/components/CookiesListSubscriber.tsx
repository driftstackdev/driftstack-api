import { useSyncExternalStore, type ReactNode } from 'react';
import type { SessionCookie } from '../lib/agent-session-control';

export interface CookiesListStore {
  getSnapshot: () => SessionCookie[] | null;
  subscribe: (listener: () => void) => () => void;
  set: (cookies: SessionCookie[] | null) => void;
}

/** Stores successful cookie-poll snapshots outside SimulatorWindow state so
 * only the open Cookies pane repaints when a fresh jar arrives. */
export function createCookiesListStore(): CookiesListStore {
  let value: SessionCookie[] | null = null;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => value,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set: (cookies) => {
      value = cookies;
      for (const listener of listeners) listener();
    },
  };
}

export function CookiesListSubscriber({
  store,
  children,
}: {
  store: CookiesListStore;
  children: (cookies: SessionCookie[] | null) => ReactNode;
}): JSX.Element {
  const cookies = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return <>{children(cookies)}</>;
}
