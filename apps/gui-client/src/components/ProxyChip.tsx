// Proxy chip — compact label that expands to a click-popover with
// host / port / auth / proxy-id detail. Used in ProfilesView rows so
// the profile<->proxy binding is glanceable without sacrificing the
// detail-on-demand surface customers need when debugging connectivity.
//
// 2026-05-21 — operator-UI polish wave. The inline <select> for
// setDefaultProxy still lives in the row (binding
// edits keep the same UX); this chip is the read-only surface that
// announces "this is the proxy that will be used on Launch".
//
// Click toggles the popover; click outside closes it. Auth credentials
// are NEVER rendered — we surface "auth: yes / no" only. The full
// password is in the Tauri store and not needed in the GUI surface;
// surfacing it here would be a screen-share leak.

import { useEffect, useRef, useState } from 'react';
import type { ProxyConfig } from '../lib/proxies';

export interface ProxyChipProps {
  proxy: ProxyConfig | null;
  /** When true, signals that the chip's value is the binding's
   *  defaulted-first proxy rather than an explicit pick. The row will
   *  hint with a "defaulting to" suffix elsewhere. */
  defaulted?: boolean;
}

export function ProxyChip({ proxy, defaulted = false }: ProxyChipProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onClickOutside(e: MouseEvent): void {
      if (ref.current !== null && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKeyDown(e: KeyboardEvent): void {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onClickOutside);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onClickOutside);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  if (proxy === null) {
    return (
      <span className="inline-flex items-center gap-1 rounded border border-dashed border-surface-divider px-1.5 py-0.5 text-xs text-ink-muted">
        <ProxyIcon dim />
        no proxy
      </span>
    );
  }

  const auth = proxy.username !== null && proxy.username.length > 0;
  return (
    <div ref={ref} className="relative inline-block">
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={
          'inline-flex items-center gap-1.5 rounded border px-1.5 py-0.5 text-xs ' +
          'transition-colors ' +
          (open
            ? 'border-accent bg-accent-subtle text-ink-primary'
            : 'border-surface-divider bg-surface-base text-ink-secondary hover:border-ink-muted hover:text-ink-primary')
        }
        title={defaulted ? 'No explicit binding — using the first saved proxy.' : undefined}
      >
        <ProxyIcon />
        <span className="mono">
          {proxy.host}:{proxy.port}
        </span>
        {defaulted && <span className="text-2xs text-ink-muted">(default)</span>}
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Proxy details"
          className="absolute left-0 top-full z-20 mt-1 w-64 rounded
                     border border-surface-divider bg-surface-elevated
                     p-3 text-xs shadow-lg"
        >
          <div className="mb-2 flex items-center justify-between">
            <span className="section-label">SOCKS5</span>
            <span className="mono text-2xs text-ink-muted">{proxy.id.slice(0, 8)}…</span>
          </div>
          <DetailRow label="Label" value={proxy.label} />
          <DetailRow label="Host" value={proxy.host} mono />
          <DetailRow label="Port" value={String(proxy.port)} mono />
          <DetailRow label="Auth" value={auth ? 'yes' : 'no'} />
          <DetailRow label="Added" value={new Date(proxy.createdAt).toLocaleDateString()} muted />
        </div>
      )}
    </div>
  );
}

function DetailRow({
  label,
  value,
  mono = false,
  muted = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
  muted?: boolean;
}): JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-3 py-0.5">
      <span className="text-2xs uppercase tracking-wide text-ink-muted">{label}</span>
      <span
        className={
          'truncate ' + (mono ? 'font-mono ' : '') + (muted ? 'text-ink-muted' : 'text-ink-primary')
        }
        title={value}
      >
        {value}
      </span>
    </div>
  );
}

function ProxyIcon({ dim = false }: { dim?: boolean }): JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      width="12"
      height="12"
      aria-hidden="true"
      className={dim ? 'opacity-60' : undefined}
    >
      <circle cx="8" cy="8" r="5.25" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M2.75 8h10.5M8 2.75c1.4 1.7 2.1 3.4 2.1 5.25S9.4 11.55 8 13.25"
        stroke="currentColor"
        strokeWidth="1.4"
        fill="none"
      />
    </svg>
  );
}
