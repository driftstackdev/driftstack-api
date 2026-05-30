// 2026-05-29 — branded confirmation dialog for the desktop client.
// Replaces native window.confirm(), which is FLAKY in the Tauri
// WKWebView: it was silently swallowing the customer's sign-out clicks
// (see App.tsx handleSignOut comment), so a native confirm guarding a
// destructive action could either no-op or be dismissed by accident.
// A React-rendered modal is reliable AND on-brand.
//
// Usage: const confirm = useConfirm(); ... if (!(await confirm(msg))) return;
// Resolves true on Confirm, false on Cancel / backdrop / Escape.

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

export interface ConfirmOptions {
  /** Label for the affirmative button (default 'Confirm'). */
  confirmLabel?: string;
}

type ConfirmFn = (message: string, opts?: ConfirmOptions) => Promise<boolean>;

interface PendingConfirm {
  message: string;
  confirmLabel: string;
  resolve: (value: boolean) => void;
}

// Default (no provider mounted): resolve false so a destructive guard
// fails safe rather than firing without confirmation.
const ConfirmContext = createContext<ConfirmFn>(() => Promise.resolve(false));

export function useConfirm(): ConfirmFn {
  return useContext(ConfirmContext);
}

export function ConfirmProvider({ children }: { children: ReactNode }): JSX.Element {
  const [pending, setPending] = useState<PendingConfirm | null>(null);

  const confirm = useCallback<ConfirmFn>((message, opts) => {
    return new Promise<boolean>((resolve) => {
      setPending({ message, confirmLabel: opts?.confirmLabel ?? 'Confirm', resolve });
    });
  }, []);

  const settle = useCallback((result: boolean): void => {
    setPending((current) => {
      if (current) current.resolve(result);
      return null;
    });
  }, []);

  // Escape cancels while the dialog is open.
  useEffect(() => {
    if (pending === null) return;
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        e.preventDefault();
        settle(false);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pending, settle]);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {pending !== null && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4"
          onClick={(e) => {
            if (e.target === e.currentTarget) settle(false);
          }}
        >
          <div className="w-full max-w-md rounded-xl border border-white/10 bg-surface-raised p-6 shadow-2xl">
            <p className="whitespace-pre-line text-sm text-ink-primary">{pending.message}</p>
            <div className="mt-6 flex justify-end gap-3">
              <button type="button" className="btn-secondary" onClick={() => settle(false)}>
                Cancel
              </button>
              <button type="button" className="btn-primary" onClick={() => settle(true)}>
                {pending.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  );
}
