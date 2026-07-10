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
  /** Visual emphasis: 'info' (default) | 'success' | 'warn' | 'error'. */
  tone?: 'info' | 'success' | 'warn' | 'error';
}

/** Per-tone styling: border + a leading status dot + the a11y live-region role
 *  ('alert' for warn/error so screen readers announce assertively). 'warn'
 *  keeps the historical accent border. */
const TONE_STYLE: Record<
  NonNullable<Toast['tone']>,
  { border: string; dot: string; role: 'alert' | 'status' }
> = {
  info: { border: 'border-surface-divider', dot: 'bg-ink-muted', role: 'status' },
  success: { border: 'border-status-ready/50', dot: 'bg-status-ready', role: 'status' },
  warn: { border: 'border-accent', dot: 'bg-status-busy', role: 'alert' },
  error: { border: 'border-status-error/60', dot: 'bg-status-error', role: 'alert' },
};

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
      setToasts((list) => {
        // Cap at 3 visible; release the auto-dismiss timers of any toasts we
        // slice off so evicted toasts don't leave dangling setTimeout entries
        // firing dismiss() against ids no longer in state (#17 leak).
        const kept = list.slice(-2);
        for (const dropped of list.slice(0, -2)) {
          const timer = timers.current.get(dropped.id);
          if (timer) {
            clearTimeout(timer);
            timers.current.delete(dropped.id);
          }
        }
        return [...kept, { ...toast, id }];
      });
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
          aria-live="polite"
          aria-relevant="additions"
          className="fixed bottom-4 right-4 z-50 flex w-80 flex-col gap-2"
        >
          {toasts.map((t) => {
            const ts = TONE_STYLE[t.tone ?? 'info'];
            return (
              <div
                key={t.id}
                role={ts.role}
                className={`rounded-lg border bg-surface-raised p-3.5 shadow-xl ${ts.border}`}
              >
                <div className="flex items-start gap-2">
                  <span
                    className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${ts.dot}`}
                    aria-hidden="true"
                  />
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
            );
          })}
        </div>
      )}
    </ToastContext.Provider>
  );
}
