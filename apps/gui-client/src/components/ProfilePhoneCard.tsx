// GX (2026-06-15) — phone-framed profile card v2. Founder feedback round:
// Launch must always be visible (the dock's flex Launch was being squeezed to
// nothing by 3 icon buttons at small widths) → dock is now Launch-only; the
// secondary actions (watch / test / organize / assist) moved to hover icons.
// One "UDP" badge (✓/✗) replaces the 3 capability chips; hover shows WebRTC +
// QUIC. Exit IP + country code are readable. Pure presentational; ProfilesView
// passes data/display strings + handlers + an organize slot.

import type { JSX, ReactNode } from 'react';
import { proxyCapabilities } from './ProxyCapabilities';
import { RelativeTime } from './RelativeTime';
import type { ProxyTestResult } from '../lib/proxies';

export interface ProfilePhoneCardProps {
  name: string;
  monogram: string;
  /** 0–359 identity hue (screen wash). */
  hue: number;
  deviceLabel: string;
  running: boolean;
  selected: boolean;
  lastUsedIso: string | null;
  folder: string;
  tags: ReadonlyArray<string>;
  // proxy / egress
  hasProxy: boolean;
  flag: string; // emoji or '🌍'
  countryCode: string | null; // exit country code (e.g. 'NL') for the badge
  exitIp: string | null; // real exit IP, or null = untested
  latencyMs: number | null;
  latencyFillPct: number;
  latencyGood: boolean;
  probed: boolean;
  capabilities: ProxyTestResult | null;
  checkedAtIso: string | null;
  // actions
  busy: boolean;
  testing: boolean;
  testDisabled: boolean;
  launchDisabled: boolean;
  launchDisabledReason?: string;
  organizeOpen: boolean;
  organizeSlot: ReactNode;
  onToggleSelect: () => void;
  onPrimary: () => void; // Launch (idle) / Open session (running)
  onWatch: () => void;
  onOrganizeToggle: () => void;
  onTest: () => void;
  onAssist?: () => void;
}

export function ProfilePhoneCard(p: ProfilePhoneCardProps): JSX.Element {
  // UDP badge state + the WebRTC/QUIC detail shown on hover. proxyCapabilities
  // gates WebRTC/QUIC on reachable+auth+udp_associate (they ride UDP).
  const caps = p.capabilities !== null ? proxyCapabilities(p.capabilities) : null;
  const webrtc = caps?.find((c) => c.key === 'webrtc')?.ok ?? false;
  const quic = caps?.find((c) => c.key === 'quic')?.ok ?? false;
  const udpOk = webrtc; // WebRTC ok === UDP relay verified
  const udpTitle =
    caps === null
      ? 'Run Test to check UDP (WebRTC + QUIC) support on this exit.'
      : udpOk
        ? 'UDP relay verified — WebRTC ✓ and QUIC ✓ tunnel through this exit.'
        : 'No UDP relay — WebRTC falls back to TURN-over-TCP and QUIC to HTTP/2.';

  return (
    <article
      className={`group relative rounded-[24px] border p-1.5 transition-all hover:-translate-y-0.5 hover:shadow-xl ${
        p.selected
          ? 'border-accent shadow-[0_0_0_2px_rgb(var(--accent-rgb)),0_10px_26px_rgba(0,0,0,0.5)]'
          : p.running
            ? 'border-[#0a0d12] shadow-[0_0_0_1.5px_rgb(var(--accent-rgb)/0.45),0_10px_26px_rgba(0,0,0,0.45)]'
            : 'border-[#0a0d12] shadow-[0_8px_20px_rgba(0,0,0,0.38)]'
      }`}
      style={{ background: 'linear-gradient(160deg,#161b24,#0a0e14)' }}
    >
      {/* SCREEN */}
      <div className="relative flex aspect-[9/16] flex-col overflow-hidden rounded-[17px] bg-surface-raised">
        <div
          aria-hidden="true"
          className="absolute inset-0 opacity-[0.16]"
          style={{
            background: `linear-gradient(160deg, hsl(${p.hue} 44% 32%), hsl(${(p.hue + 38) % 360} 42% 18%))`,
          }}
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-0 z-[5] h-1/3 bg-gradient-to-b from-white/[0.07] to-transparent"
        />
        <span
          aria-hidden="true"
          className="absolute left-1/2 top-2 z-30 h-[12px] w-[42px] -translate-x-1/2 rounded-[8px] bg-[#05070b]"
        />

        {/* status bar */}
        <div className="relative z-10 flex items-center justify-between px-3 pb-1 pt-2.5 text-[9.5px] font-semibold">
          <span className="text-ink-secondary">{p.deviceLabel}</span>
          {p.running ? (
            <span className="inline-flex items-center gap-1 uppercase tracking-wider text-status-ready">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-status-ready shadow-[0_0_6px_rgb(var(--status-ready-rgb))]" />
              Live
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 uppercase tracking-wider text-ink-muted">
              <span className="h-1.5 w-1.5 rounded-full border border-ink-muted" />
              Idle
            </span>
          )}
        </div>

        {/* selection checkbox — top-left (hover/selected). Reserved space + an
            opacity toggle only (never reflows the card). */}
        <label
          className={`absolute left-2.5 top-2 z-30 cursor-pointer transition-opacity ${
            p.selected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
          }`}
          title="Select for bulk actions"
        >
          <input
            type="checkbox"
            className="h-3.5 w-3.5 cursor-pointer accent-accent"
            checked={p.selected}
            onChange={p.onToggleSelect}
            aria-label={`Select ${p.name}`}
          />
        </label>

        {/* hover quick-actions — top-right; keep the dock free for a full-width
            Launch. assist / watch / test / organize. */}
        <div className="absolute right-2 top-1.5 z-30 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
          {p.onAssist ? (
            <QuickIcon label={`Ask the AI assistant about ${p.name}`} onClick={p.onAssist}>
              ✦
            </QuickIcon>
          ) : null}
          <QuickIcon
            label={p.running ? 'Live view' : 'Launch and watch'}
            onClick={p.onWatch}
            disabled={p.busy || (!p.running && p.launchDisabled)}
          >
            💬
          </QuickIcon>
          {p.hasProxy ? (
            <QuickIcon
              label="Test proxy — reachability, latency, exit IP"
              onClick={p.onTest}
              disabled={p.testDisabled}
            >
              {p.testing ? '…' : '⟳'}
            </QuickIcon>
          ) : null}
          <QuickIcon label="Organize (folder + tags)" onClick={p.onOrganizeToggle}>
            ⋯
          </QuickIcon>
        </div>

        {/* body */}
        <div className="relative z-10 flex flex-1 flex-col gap-1.5 px-2.5 pb-2 pt-1">
          {/* identity */}
          <div className="flex flex-col items-center gap-1 pt-0.5">
            <span
              className="grid h-9 w-9 place-items-center rounded-full text-[13px] font-bold text-white/95 ring-1 ring-white/15"
              style={{ background: 'rgba(255,255,255,0.1)' }}
            >
              {p.monogram}
            </span>
            <p className="line-clamp-1 text-center text-[12px] font-semibold leading-tight text-ink-primary">
              {p.name}
            </p>
          </div>

          {/* egress widget */}
          <div className="flex flex-col gap-1 rounded-[12px] border border-surface-divider bg-surface-inset px-2 py-1.5">
            {p.hasProxy ? (
              <>
                {/* country + exit IP */}
                <div className="flex items-center gap-1.5">
                  <span aria-hidden="true" className="text-[13px] leading-none">
                    {p.flag}
                  </span>
                  {p.countryCode !== null && (
                    <span className="rounded bg-surface-divider/70 px-1 text-[8.5px] font-semibold uppercase tracking-wide text-ink-secondary">
                      {p.countryCode}
                    </span>
                  )}
                  <span
                    className={`min-w-0 flex-1 truncate text-[11px] ${
                      p.exitIp !== null ? 'mono text-ink-primary' : 'italic text-ink-muted'
                    }`}
                    title={p.exitIp ?? undefined}
                  >
                    {p.exitIp ?? 'run Test for exit IP'}
                  </span>
                </div>
                {/* latency + UDP badge */}
                <div className="flex items-center gap-1.5">
                  <span className="flex items-center gap-1 text-[9px] text-ink-muted">
                    {p.latencyMs !== null ? (
                      <>
                        <span className="mono">{p.latencyMs}ms</span>
                        <span className="inline-block h-1 w-[24px] overflow-hidden rounded-[2px] bg-surface-divider">
                          <span
                            className="block h-full rounded-[2px]"
                            style={{
                              width: `${p.latencyFillPct.toFixed(0)}%`,
                              background: p.latencyGood
                                ? 'rgb(var(--status-ready-rgb))'
                                : 'rgb(var(--status-busy-rgb))',
                            }}
                          />
                        </span>
                      </>
                    ) : (
                      <span className="mono opacity-60">{p.probed ? 'stale' : 'untested'}</span>
                    )}
                  </span>
                  <span
                    title={udpTitle}
                    data-udp={udpOk ? 'true' : 'false'}
                    className={`ml-auto inline-flex cursor-help items-center gap-0.5 rounded px-1 py-px text-[9px] font-semibold ${
                      caps === null
                        ? 'bg-surface-divider/60 text-ink-muted'
                        : udpOk
                          ? 'bg-status-ready/15 text-status-ready'
                          : 'bg-surface-divider/60 text-ink-muted line-through'
                    }`}
                  >
                    UDP {caps === null ? '?' : udpOk ? '✓' : '✗'}
                  </span>
                </div>
                {/* WebRTC/QUIC detail — only on hover (founder: hover shows them) */}
                {caps !== null && (
                  <div className="hidden gap-1 group-hover:flex">
                    <span
                      className={`rounded px-1 text-[8px] ${webrtc ? 'bg-status-ready/15 text-status-ready' : 'bg-surface-divider/50 text-ink-muted'}`}
                    >
                      WebRTC {webrtc ? '✓' : '✗'}
                    </span>
                    <span
                      className={`rounded px-1 text-[8px] ${quic ? 'bg-status-ready/15 text-status-ready' : 'bg-surface-divider/50 text-ink-muted'}`}
                    >
                      QUIC {quic ? '✓' : '✗'}
                    </span>
                  </div>
                )}
              </>
            ) : (
              <div className="flex items-center gap-1.5">
                <span aria-hidden="true" className="text-[12px]">
                  🚫
                </span>
                <span className="text-[10px] text-ink-muted">no proxy bound</span>
              </div>
            )}
          </div>

          {(p.folder !== '' || p.tags.length > 0) && (
            <div className="flex flex-wrap justify-center gap-1">
              {p.folder !== '' && (
                <span className="rounded-full border border-surface-divider bg-surface-inset px-1.5 py-0.5 text-[8.5px] text-ink-secondary">
                  📁 {p.folder}
                </span>
              )}
              {p.tags.map((tag) => (
                <span
                  key={tag}
                  className="rounded-full border border-surface-divider px-1.5 py-0.5 text-[8.5px] text-ink-muted"
                >
                  {tag}
                </span>
              ))}
            </div>
          )}

          {p.organizeOpen ? <div>{p.organizeSlot}</div> : null}

          <span className="mt-auto text-center text-[9px] text-ink-muted">
            {p.lastUsedIso !== null ? (
              <RelativeTime iso={p.lastUsedIso} tooltipPrefix="Last used" />
            ) : (
              'never launched'
            )}
          </span>
        </div>

        {/* dock — Launch/Open ONLY, full width, always visible + prominent */}
        <div className="relative z-10 border-t border-surface-divider bg-white/[0.03] px-2.5 py-2">
          <button
            type="button"
            className={`w-full rounded-[10px] py-1.5 text-[11px] font-semibold disabled:opacity-50 ${
              p.running
                ? 'border border-surface-divider bg-surface-elevated text-ink-primary'
                : 'bg-accent text-white'
            }`}
            disabled={p.busy || (!p.running && p.launchDisabled)}
            title={!p.running && p.launchDisabled ? p.launchDisabledReason : undefined}
            onClick={(e) => {
              e.stopPropagation();
              p.onPrimary();
            }}
          >
            {p.running ? 'Open session' : p.busy ? 'Launching…' : 'Launch'}
          </button>
        </div>
      </div>
    </article>
  );
}

function QuickIcon({
  children,
  label,
  onClick,
  disabled,
}: {
  children: ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}): JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="grid h-5 w-5 place-items-center rounded-full bg-black/35 text-[10px] text-white/85 transition-colors hover:text-white disabled:opacity-40"
    >
      {children}
    </button>
  );
}
