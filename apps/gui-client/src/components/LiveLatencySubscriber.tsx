import { useEffect, useSyncExternalStore, type ReactNode } from 'react';
import { useLatencyPing, type LatencyState } from '../lib/livekit-latency-ping';
import type { Room } from '../lib/livekit';

const EMPTY_LATENCY: LatencyState = { rttMs: null, lastSeenAt: null };

export interface LiveLatencyStore {
  getSnapshot: () => LatencyState;
  subscribe: (listener: () => void) => () => void;
  set: (state: LatencyState) => void;
}

export function createLiveLatencyStore(): LiveLatencyStore {
  let value = EMPTY_LATENCY;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => value,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set: (state) => {
      if (value.rttMs === state.rttMs && value.lastSeenAt === state.lastSeenAt) return;
      value = state;
      for (const listener of listeners) listener();
    },
  };
}

/** Owns the ping hook below SimulatorWindow. Echo/staleness updates rerender
 * this bridge and metric subscribers, never the video/tab/browser host. */
export function LiveLatencyBridge({
  room,
  enabled,
  store,
}: {
  room: Room | null;
  enabled: boolean;
  store: LiveLatencyStore;
}): null {
  const latency = useLatencyPing({ room, enabled });
  useEffect(() => store.set(latency), [latency, store]);
  return null;
}

export function LiveLatencySubscriber({
  store,
  children,
}: {
  store: LiveLatencyStore;
  children: (latency: LatencyState) => ReactNode;
}): JSX.Element {
  const latency = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return <>{children(latency)}</>;
}
