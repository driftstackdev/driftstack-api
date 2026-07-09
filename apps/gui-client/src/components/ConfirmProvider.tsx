// 2026-05-29 — branded confirmation dialog for the desktop client.
// Replaces native window.confirm(), which is FLAKY in the Tauri
// WKWebView: it was silently swallowing the customer's sign-out clicks
// (see App.tsx handleSignOut comment), so a native confirm guarding a
// destructive action could either no-op or be dismissed by accident.
// A React-rendered modal is reliable AND on-brand.
//
// Usage: const confirm = useConfirm(); ... if (!(await confirm(msg))) return;
// Resolves true on Confirm, false on Cancel / backdrop / Escape.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';

export interface ConfirmOptions {
  /** Label for the affirmative button (default 'Confirm'). */
  confirmLabel?: string;
  /**
   * Visual + focus intent. 'danger' renders the affirmative button in the
   * destructive style AND moves initial keyboard focus to Cancel, so a
   * reflexive Enter cancels rather than executing the destructive action.
   * Default 'default' preserves prior behavior (affirmative focused).
   */
  tone?: 'default' | 'danger';
}

type ConfirmFn = (message: string, opts?: ConfirmOptions) => Promise<boolean>;

interface PendingConfirm {
  message: string;
  confirmLabel: string;
  tone: 'default' | 'danger';
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
      setPending((current) => {
        // A second confirm() opened while one is already pending: resolve the
        // PREVIOUS one as `false` (cancelled) before replacing it. Without this,
        // overwriting `pending` orphaned the first resolve — the first
        // `await confirm(...)` hung forever and its caller's loading state never
        // cleared. Fail-safe to false (the dropped action does NOT proceed). (audit)
        if (current !== null) current.resolve(false);
        return {
          message,
          confirmLabel: opts?.confirmLabel ?? 'Confirm',
          tone: opts?.tone ?? 'default',
          resolve,
        };
      });
    });
  }, []);

  const settle = useCallback((result: boolean): void => {
    setPending((current) => {
      if (current) current.resolve(result);
      return null;
    });
  }, []);

  const dialogRef = useRef<HTMLDivElement>(null);
  const confirmBtnRef = useRef<HTMLButtonElement>(null);
  const cancelBtnRef = useRef<HTMLButtonElement>(null);

  // Full WCAG 2.4.3 dialog focus management while the dialog is open
  // (mirrors the web DashboardLayout/AdminLayout branded modals): move
  // focus into the dialog on open, trap Tab/Shift+Tab within it, and
  // restore focus to the trigger on close. Escape cancels.
  useEffect(() => {
    if (pending === null) return;
    const prevFocus = document.activeElement as HTMLElement | null;
    // Destructive confirms focus Cancel so a reflexive Enter cancels rather
    // than executing the delete/remove/sign-out; benign confirms keep the
    // affirmative focused for a fast keyboard "yes".
    if (pending.tone === 'danger') cancelBtnRef.current?.focus();
    else confirmBtnRef.current?.focus();
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        e.preventDefault();
        settle(false);
        return;
      }
      if (e.key === 'Tab') {
        const focusables = dialogRef.current?.querySelectorAll<HTMLElement>('button');
        if (!focusables || focusables.length === 0) return;
        const first = focusables[0]!;
        const last = focusables[focusables.length - 1]!;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      if (prevFocus && prevFocus.focus) prevFocus.focus();
    };
  }, [pending, settle]);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {pending !== null && (
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="confirm-dialog-message"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4"
          onClick={(e) => {
            if (e.target === e.currentTarget) settle(false);
          }}
        >
          <div className="w-full max-w-md rounded-xl border border-white/10 bg-surface-raised p-6 shadow-2xl">
            <p id="confirm-dialog-message" className="whitespace-pre-line text-sm text-ink-primary">
              {pending.message}
            </p>
            <div className="mt-6 flex justify-end gap-3">
              <button
                ref={cancelBtnRef}
                type="button"
                className="btn-secondary"
                onClick={() => settle(false)}
              >
                Cancel
              </button>
              <button
                ref={confirmBtnRef}
                type="button"
                className={pending.tone === 'danger' ? 'btn-danger' : 'btn-primary'}
                onClick={() => settle(true)}
              >
                {pending.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  );
}
