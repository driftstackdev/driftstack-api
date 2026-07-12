import { useSyncExternalStore, type ReactNode } from 'react';
import type { SessionDownloadEntry } from '../lib/agent-session-control';

export interface DownloadsListStore {
  getSnapshot: () => SessionDownloadEntry[] | null;
  subscribe: (listener: () => void) => () => void;
  set: (downloads: SessionDownloadEntry[] | null) => void;
}

/** Keeps the polling download list out of SimulatorWindow state. A successful
 * poll may return a fresh array every few seconds; only count/list subscribers
 * should repaint for that, not the live video and browser host. */
export function createDownloadsListStore(): DownloadsListStore {
  let value: SessionDownloadEntry[] | null = null;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => value,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set: (downloads) => {
      value = downloads;
      for (const listener of listeners) listener();
    },
  };
}

export function DownloadsListSubscriber({
  store,
  children,
}: {
  store: DownloadsListStore;
  children: (downloads: SessionDownloadEntry[] | null) => ReactNode;
}): JSX.Element {
  const downloads = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return <>{children(downloads)}</>;
}
