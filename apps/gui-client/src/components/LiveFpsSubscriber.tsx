import { useSyncExternalStore, type ReactNode } from 'react';

export interface LiveFpsStore {
  getSnapshot: () => number | null;
  subscribe: (listener: () => void) => () => void;
  set: (value: number | null) => void;
}

/** A tiny external store keeps the video-frame callback's 1Hz metric updates
 * outside SimulatorWindow state. Only mounted FPS readouts subscribe/repaint. */
export function createLiveFpsStore(initial: number | null = null): LiveFpsStore {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => value,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set: (next) => {
      if (Object.is(value, next)) return;
      value = next;
      for (const listener of listeners) listener();
    },
  };
}

export function LiveFpsSubscriber({
  store,
  children,
}: {
  store: LiveFpsStore;
  children: (fps: number | null) => ReactNode;
}): JSX.Element {
  const fps = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return <>{children(fps)}</>;
}
