// GX (2026-06-15) — phone-framed profile card v3. Founder feedback round 2:
// - taller screen (height only) so everything renders with room to breathe;
// - secondary controls are now a LABELLED hover strip (icon + caption) instead
//   of bare emoji you couldn't read;
// - UDP badge is explicitly red (no relay) / green (relay verified);
// - the device label is a readable chip, no longer colliding with the select
//   checkbox or washing out over the identity gradient.
// Pure presentational; ProfilesView passes data/display strings + handlers + an
// organize slot. flag covers every ISO country via flagEmoji (regional-indicator
// transform — no hardcoded list).

import type { JSX, ReactNode } from 'react';
import { proxyCapabilities } from './ProxyCapabilities';
import { RelativeTime } from './RelativeTime';
import type { ProxyTestResult } from '../lib/proxies';

export interface ProfilePhoneCardProps {
  name: string;
  monogram: string;
  /** Optional chosen emoji icon; when set, shown instead of the monogram. */
  icon?: string;
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
  onToggleSelect: () => void;
  onPrimary: () => void; // Launch (idle) / Open session (running)
  onWatch: () => void;
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
      role="button"
      tabIndex={0}
      aria-pressed={p.selected}
      aria-label={`Select ${p.name}`}
      onClick={p.onToggleSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          p.onToggleSelect();
        }
      }}
      className={`group relative cursor-pointer rounded-[24px] border p-1.5 transition-all hover:-translate-y-0.5 hover:shadow-xl ${
        p.selected
          ? 'border-accent shadow-[0_0_0_2px_rgb(var(--accent-rgb)),0_10px_26px_rgba(0,0,0,0.5)]'
          : p.running
            ? 'border-[#0a0d12] shadow-[0_0_0_1.5px_rgb(var(--accent-rgb)/0.5),0_0_18px_rgb(var(--accent-rgb)/0.3),0_10px_26px_rgba(0,0,0,0.45)]'
            : 'border-[#0a0d12] shadow-[0_8px_20px_rgba(0,0,0,0.38)]'
      }`}
      style={{ background: 'linear-gradient(160deg,#161b24,#0a0e14)' }}
    >
      {/* SCREEN — taller (height-only bump) so the body has room. */}
      <div className="relative flex aspect-[9/18.5] flex-col overflow-hidden rounded-[17px] bg-surface-raised">
        <div
          aria-hidden="true"
          className="absolute inset-0 opacity-[0.16]"
          style={{
            background: `linear-gradient(160deg, hsl(${p.hue} 44% 32%), hsl(${(p.hue + 38) % 360} 42% 18%))`,
          }}
        />
        {/* soft identity-hue wallpaper glow behind the avatar */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute left-1/2 top-[58px] z-[3] h-28 w-28 -translate-x-1/2 rounded-full opacity-50 blur-2xl"
          style={{
            background: `radial-gradient(circle, hsl(${p.hue} 70% 55% / 0.55), transparent 70%)`,
          }}
        />
        {/* top gloss */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-0 z-[5] h-1/3 bg-gradient-to-b from-white/[0.07] to-transparent"
        />
        {/* inner vignette — reads the screen as glass */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 z-[6] rounded-[17px] shadow-[inset_0_0_28px_rgba(0,0,0,0.32)]"
        />
        <span
          aria-hidden="true"
          className="absolute left-1/2 top-2 z-30 h-[12px] w-[42px] -translate-x-1/2 rounded-[8px] bg-[#05070b]"
        />

        {/* selection marker — the whole card toggles selection on click, so this
            is just a non-interactive indicator: accent check when selected, a
            faint hint ring on hover. */}
        <span
          aria-hidden="true"
          className={`pointer-events-none absolute left-1.5 top-[7px] z-30 grid h-4 w-4 place-items-center rounded-full text-[9px] font-bold transition-all ${
            p.selected
              ? 'bg-accent text-white opacity-100'
              : 'border border-white/45 text-transparent opacity-0 group-hover:opacity-100'
          }`}
        >
          ✓
        </span>

        {/* status bar — readable device chip (left) + Live/Idle (right). Sits
            BELOW the dynamic island (pt clears it) so neither overlaps the label. */}
        <div className="relative z-20 flex items-center justify-between gap-1 px-2.5 pb-1 pt-[26px]">
          <span className="truncate rounded bg-black/35 px-1.5 py-0.5 text-[10px] font-semibold tracking-tight text-ink-primary">
            {p.deviceLabel}
          </span>
          {p.running ? (
            <span className="inline-flex shrink-0 items-center gap-1 text-[9.5px] font-semibold uppercase tracking-wider text-status-ready">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-status-ready shadow-[0_0_6px_rgb(var(--status-ready-rgb))]" />
              Live
            </span>
          ) : (
            <span className="inline-flex shrink-0 items-center gap-1 text-[9.5px] font-semibold uppercase tracking-wider text-ink-muted">
              <span className="h-1.5 w-1.5 rounded-full border border-ink-muted" />
              Idle
            </span>
          )}
        </div>

        {/* body */}
        <div className="relative z-10 flex flex-1 flex-col gap-1.5 px-2.5 pb-2 pt-1.5">
          {/* identity */}
          <div className="flex flex-col items-center gap-1 pt-1">
            <span
              className={`grid h-11 w-11 place-items-center rounded-full font-bold text-white shadow-[0_4px_12px_rgba(0,0,0,0.35)] ring-1 ring-white/25 ${
                p.icon ? 'text-[22px]' : 'text-[15px]'
              }`}
              style={{
                background: `linear-gradient(145deg, hsl(${p.hue} 58% 54%), hsl(${(p.hue + 34) % 360} 52% 38%))`,
              }}
            >
              {p.icon ? p.icon : p.monogram}
            </span>
            <p className="line-clamp-1 text-center text-[12.5px] font-semibold leading-tight text-ink-primary">
              {p.name}
            </p>
          </div>

          {/* egress widget */}
          <div className="flex flex-col gap-1.5 rounded-[12px] border border-surface-divider bg-surface-inset px-2 py-2">
            {p.hasProxy ? (
              <>
                {/* country + exit IP */}
                <div className="flex items-center gap-1.5">
                  <span aria-hidden="true" className="text-[15px] leading-none">
                    {p.flag}
                  </span>
                  {p.countryCode !== null && (
                    <span className="rounded bg-surface-divider/70 px-1 text-[9px] font-semibold uppercase tracking-wide text-ink-secondary">
                      {p.countryCode}
                    </span>
                  )}
                  <span
                    className={`min-w-0 flex-1 truncate text-right text-[11.5px] ${
                      p.exitIp !== null ? 'mono text-ink-primary' : 'italic text-ink-muted'
                    }`}
                    title={p.exitIp ?? undefined}
                  >
                    {p.exitIp ?? (p.probed ? 'no exit IP' : 'run Test')}
                  </span>
                </div>
                {/* latency + UDP badge (red/green) */}
                <div className="flex items-center gap-1.5">
                  <span className="flex items-center gap-1 text-[9.5px] text-ink-muted">
                    {p.latencyMs !== null ? (
                      <>
                        <span className="mono">{p.latencyMs}ms</span>
                        <span className="inline-block h-1 w-[26px] overflow-hidden rounded-[2px] bg-surface-divider">
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
                    className={`ml-auto inline-flex cursor-help items-center gap-0.5 rounded px-1.5 py-px text-[9.5px] font-bold ${
                      caps === null
                        ? 'bg-surface-divider/60 text-ink-muted'
                        : udpOk
                          ? 'bg-status-ready/20 text-status-ready'
                          : 'bg-status-error/20 text-status-error'
                    }`}
                  >
                    UDP {caps === null ? '?' : udpOk ? '✓' : '✗'}
                  </span>
                </div>
                {/* WebRTC/QUIC detail — on hover (founder: hover shows them) */}
                {caps !== null && (
                  <div className="hidden gap-1 group-hover:flex">
                    <span
                      className={`rounded px-1 text-[8.5px] ${webrtc ? 'bg-status-ready/15 text-status-ready' : 'bg-status-error/15 text-status-error'}`}
                    >
                      WebRTC {webrtc ? '✓' : '✗'}
                    </span>
                    <span
                      className={`rounded px-1 text-[8.5px] ${quic ? 'bg-status-ready/15 text-status-ready' : 'bg-status-error/15 text-status-error'}`}
                    >
                      QUIC {quic ? '✓' : '✗'}
                    </span>
                  </div>
                )}
              </>
            ) : (
              <div className="flex items-center gap-1.5">
                <span aria-hidden="true" className="text-[13px]">
                  🚫
                </span>
                <span className="text-[10.5px] text-ink-muted">no proxy bound</span>
              </div>
            )}
          </div>

          {(p.folder !== '' || p.tags.length > 0) && (
            <div className="flex flex-wrap justify-center gap-1">
              {p.folder !== '' && (
                <span className="rounded-full border border-surface-divider bg-surface-inset px-1.5 py-0.5 text-[9px] text-ink-secondary">
                  📁 {p.folder}
                </span>
              )}
              {p.tags.map((tag) => (
                <span
                  key={tag}
                  className="rounded-full border border-surface-divider px-1.5 py-0.5 text-[9px] text-ink-muted"
                >
                  {tag}
                </span>
              ))}
            </div>
          )}

          <span className="mt-auto text-center text-[9.5px] text-ink-muted">
            {p.lastUsedIso !== null ? (
              <RelativeTime iso={p.lastUsedIso} tooltipPrefix="Last used" />
            ) : (
              'never launched'
            )}
          </span>
        </div>

        {/* footer: the Launch dock + a hover action strip that floats ABOVE it
            (bottom-full) so the secondary actions never overlap Launch. */}
        <div className="relative z-10">
          {/* hover action strip — LABELLED (icon + caption); floats just above
              the dock, so it can't collide with Launch/Open. */}
          <div className="pointer-events-none absolute inset-x-0 bottom-full z-20 mb-1.5 flex justify-center gap-1 px-1.5 opacity-0 transition-opacity duration-150 group-hover:pointer-events-auto group-hover:opacity-100">
            {p.onAssist ? (
              <ActionBtn
                glyph="✦"
                caption="Assist"
                label={`Ask the AI assistant about ${p.name}`}
                onClick={p.onAssist}
              />
            ) : null}
            <ActionBtn
              glyph={p.running ? '◉' : '▶'}
              caption={p.running ? 'View' : 'Watch'}
              label={p.running ? 'Open the live view' : 'Launch and watch live'}
              onClick={p.onWatch}
              disabled={p.busy || (!p.running && p.launchDisabled)}
            />
            {p.hasProxy ? (
              <ActionBtn
                glyph={p.testing ? '…' : '⟳'}
                caption="Test"
                label="Test proxy — reachability, latency, exit IP"
                onClick={p.onTest}
                disabled={p.testDisabled}
              />
            ) : null}
          </div>

          {/* dock — Launch/Open ONLY, full width, always visible + prominent */}
          <div className="border-t border-surface-divider bg-white/[0.03] px-2.5 py-2">
            <button
              type="button"
              className={`w-full rounded-[10px] py-1.5 text-[11.5px] font-semibold transition-colors disabled:opacity-50 ${
                p.running
                  ? 'border border-surface-divider bg-surface-elevated text-ink-primary hover:bg-surface-divider'
                  : 'bg-accent text-white shadow-[0_3px_10px_rgba(0,0,0,0.4),inset_0_1px_0_rgba(255,255,255,0.18)] hover:bg-accent-hover'
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
            {/* iOS home indicator — sells the phone metaphor */}
            <span
              aria-hidden="true"
              className="mx-auto mt-2 block h-1 w-10 rounded-full bg-ink-muted/40"
            />
          </div>
        </div>
      </div>
    </article>
  );
}

function ActionBtn({
  glyph,
  caption,
  label,
  onClick,
  disabled,
}: {
  glyph: ReactNode;
  caption: string;
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
      className="flex min-w-[34px] flex-col items-center gap-0.5 rounded-lg bg-black/70 px-1.5 py-1 text-white/90 backdrop-blur-sm transition-colors hover:bg-black/85 hover:text-white disabled:opacity-40"
    >
      <span className="text-[12px] leading-none" aria-hidden="true">
        {glyph}
      </span>
      <span className="text-[8px] font-medium leading-none">{caption}</span>
    </button>
  );
}
