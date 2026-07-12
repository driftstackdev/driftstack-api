import { useEffect, useSyncExternalStore, type ReactNode } from 'react';
import {
  useConnectionStats,
  useTransportTelemetry,
  type ConnectionStats,
} from '../lib/livekit-connection-stats';
import type { ControlAuth } from '../lib/agent-session-control';
import type { Room } from '../lib/livekit';

const EMPTY_STATS: ConnectionStats = {
  transport: null,
  relayed: null,
  rttMs: null,
  packetLossPct: null,
  packetLossRecentPct: null,
  packetsLost: null,
  packetsReceived: null,
  jitterMs: null,
  decodeFps: null,
  freezeCount: null,
};

export interface LiveConnectionStatsStore {
  getSnapshot: () => ConnectionStats;
  subscribe: (listener: () => void) => () => void;
  set: (stats: ConnectionStats) => void;
}

export function createLiveConnectionStatsStore(): LiveConnectionStatsStore {
  let value = EMPTY_STATS;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => value,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set: (stats) => {
      value = stats;
      for (const listener of listeners) listener();
    },
  };
}

/** Owns the 3s RTC stats poll and throttled telemetry below SimulatorWindow. */
export function LiveConnectionStatsBridge({
  room,
  sessionId,
  auth,
  enabled,
  store,
}: {
  room: Room | null;
  sessionId: string;
  auth: ControlAuth;
  enabled: boolean;
  store: LiveConnectionStatsStore;
}): null {
  const stats = useConnectionStats({ room, enabled });
  useTransportTelemetry({ stats, sessionId, auth, enabled });
  useEffect(() => store.set(stats), [stats, store]);
  return null;
}

export function LiveConnectionStatsSubscriber({
  store,
  children,
}: {
  store: LiveConnectionStatsStore;
  children: (stats: ConnectionStats) => ReactNode;
}): JSX.Element {
  const stats = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return <>{children(stats)}</>;
}
