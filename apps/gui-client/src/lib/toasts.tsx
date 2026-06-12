// Toast notifications — the demo-concepts arc's session-event surface
// (previewed as the challenge-toast mock in the hub demo).
//
// Deliberately tiny: a context provider + hook, no portal library, no
// animation dependencies. Toasts stack bottom-right, auto-dismiss after
// 8s (cleared on unmount), and support one action button. The FIRST
// consumer is the session pause/crash transition watcher — when the
// fleet control plane goes live, challenge auto-pause arrives through
// the same paused transition, so the toast copy stays truthful today
// and gains meaning at go-live.

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

export interface Toast {
  id: number;
  title: string;
  body?: string;
  /** Optional action; clicking it dismisses the toast after running. */
  action?: { label: string; run: () => void };
  /** Visual emphasis: 'info' (default) | 'warn'. */
  tone?: 'info' | 'warn';
}

interface ToastContextValue {
  push: (toast: Omit<Toast, 'id'>) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const AUTO_DISMISS_MS = 8000;

export function useToasts(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (ctx === null) throw new Error('useToasts requires <ToastProvider>');
  return ctx;
}

export function ToastProvider({ children }: { children: ReactNode }): JSX.Element {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    setToasts((list) => list.filter((t) => t.id !== id));
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const push = useCallback(
    (toast: Omit<Toast, 'id'>) => {
      const id = nextId.current++;
      setToasts((list) => [...list.slice(-2), { ...toast, id }]); // max 3 visible
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), AUTO_DISMISS_MS),
      );
    },
    [dismiss],
  );

  // Clear all timers on unmount.
  useEffect(() => {
    const map = timers.current;
    return () => {
      for (const t of map.values()) clearTimeout(t);
      map.clear();
    };
  }, []);

  return (
    <ToastContext.Provider value={{ push }}>
      {children}
      {toasts.length > 0 && (
        <div
          data-component="toast-stack"
          className="fixed bottom-4 right-4 z-50 flex w-80 flex-col gap-2"
        >
          {toasts.map((t) => (
            <div
              key={t.id}
              role="status"
              className={`rounded-lg border bg-surface-raised p-3.5 shadow-xl ${
                t.tone === 'warn' ? 'border-accent' : 'border-surface-divider'
              }`}
            >
              <div className="flex items-start gap-2">
                <p className="flex-1 text-sm font-semibold text-ink-primary">{t.title}</p>
                <button
                  type="button"
                  aria-label="Dismiss"
                  className="text-xs text-ink-muted hover:text-ink-primary"
                  onClick={() => dismiss(t.id)}
                >
                  ✕
                </button>
              </div>
              {t.body ? <p className="mt-1 text-xs text-ink-secondary">{t.body}</p> : null}
              {t.action ? (
                <button
                  type="button"
                  className="btn-primary mt-2.5 px-2.5 py-1 text-xs"
                  onClick={() => {
                    const { run } = t.action!;
                    dismiss(t.id);
                    run();
                  }}
                >
                  {t.action.label}
                </button>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </ToastContext.Provider>
  );
}
