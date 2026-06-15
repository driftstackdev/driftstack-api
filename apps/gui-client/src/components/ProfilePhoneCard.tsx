// GX (2026-06-15) — phone-framed profile card. Founder: the grid was too large
// + generic; we're a mobile product, so the CARD is now a stylised phone with
// all data ON its screen (mirrors the approved profile-phone-card.html demo).
// Narrow → many fit per row. Pure presentational: ProfilesView computes the
// data + display strings (avoids a circular import for the in-ProfilesView
// helpers FolderPicker/flagEmoji/monogram) and passes them + handlers; the
// organize popover is injected as a slot. The LIST view is the untouched
// fallback.

import type { JSX, ReactNode } from 'react';
import { ProxyCapabilityChips } from './ProxyCapabilities';
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
  exitIp: string | null; // real exit IP, or null = untested
  latencyMs: number | null;
  latencyFillPct: number;
  latencyGood: boolean;
  probed: boolean; // a probe exists (drives stale/healthy + chips)
  capabilities: ProxyTestResult | null; // probe result for the chips, or null
  checkedAtIso: string | null;
  // actions
  busy: boolean;
  testing: boolean;
  testDisabled: boolean;
  launchDisabled: boolean;
  launchDisabledReason?: string;
  organizeOpen: boolean;
  organizeSlot: ReactNode; // the folder/tag popover (FolderPicker lives in ProfilesView)
  onToggleSelect: () => void;
  onPrimary: () => void; // Launch (idle) / Open session (running)
  onWatch: () => void; // 💬 live view / launch & watch
  onOrganizeToggle: () => void;
  onTest: () => void;
  /** F1c — open the AI assistant scoped to this profile. Omitted = hidden. */
  onAssist?: () => void;
}

export function ProfilePhoneCard(p: ProfilePhoneCardProps): JSX.Element {
  return (
    <article
      className={`group relative rounded-[26px] border border-[#0a0d12] p-1.5 transition-all hover:-translate-y-0.5 hover:shadow-xl ${
        p.running
          ? 'shadow-[0_0_0_1.5px_rgb(var(--accent-rgb)/0.5),0_12px_28px_rgba(0,0,0,0.5)]'
          : 'shadow-[0_8px_22px_rgba(0,0,0,0.4)]'
      } ${p.selected ? 'ring-2 ring-accent' : ''}`}
      style={{ background: 'linear-gradient(160deg,#11151c,#05070b)' }}
    >
      {/* SCREEN */}
      <div className="relative flex aspect-[9/16] flex-col overflow-hidden rounded-[18px] bg-surface-raised">
        {/* per-profile identity wash */}
        <div
          aria-hidden="true"
          className="absolute inset-0 opacity-[0.16]"
          style={{
            background: `linear-gradient(160deg, hsl(${p.hue} 44% 30%), hsl(${(p.hue + 38) % 360} 42% 16%))`,
          }}
        />
        {/* dynamic island */}
        <span
          aria-hidden="true"
          className="absolute left-1/2 top-2 z-30 h-[13px] w-[46px] -translate-x-1/2 rounded-[9px] bg-[#05070b]"
        />

        {/* faux status bar */}
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

        {/* F1c — "Assist with AI" — top-right, hover-reveal so it stays clean. */}
        {p.onAssist ? (
          <button
            type="button"
            aria-label={`Ask the AI assistant about ${p.name}`}
            title="Ask Driftstack AI to work on this profile"
            onClick={(e) => {
              e.stopPropagation();
              p.onAssist?.();
            }}
            className="absolute right-2.5 top-1.5 z-30 grid h-5 w-5 place-items-center rounded-full bg-black/30 text-[11px] text-white/85 opacity-0 transition-opacity hover:text-white group-hover:opacity-100"
          >
            ✦
          </button>
        ) : null}

        {/* selection checkbox — top-left on hover/selected */}
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

        {/* body */}
        <div className="relative z-10 flex flex-1 flex-col gap-1.5 px-2.5 pb-2 pt-1">
          {/* identity */}
          <div className="flex flex-col items-center gap-1 pt-0.5">
            <span
              className="grid h-8 w-8 place-items-center rounded-full text-[12px] font-bold text-white/95 ring-1 ring-white/15"
              style={{ background: 'rgba(255,255,255,0.1)' }}
            >
              {p.monogram}
            </span>
            <p className="line-clamp-1 text-center text-[11.5px] font-semibold leading-tight text-ink-primary">
              {p.name}
            </p>
          </div>

          {/* egress widget */}
          <div className="flex flex-col gap-1.5 rounded-[13px] border border-surface-divider bg-surface-inset px-2 py-1.5">
            {p.hasProxy ? (
              <>
                <div className="flex items-center gap-1.5">
                  <span aria-hidden="true" className="text-[12px] leading-none">
                    {p.flag}
                  </span>
                  <span
                    className={`min-w-0 truncate text-[10px] ${
                      p.exitIp !== null ? 'mono text-ink-secondary' : 'italic text-ink-muted'
                    }`}
                  >
                    {p.exitIp ?? 'run Test for exit IP'}
                  </span>
                  <span className="ml-auto flex items-center gap-1 text-[9px] text-ink-muted">
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
                      <span className="mono opacity-60">{p.probed ? 'stale' : '—'}</span>
                    )}
                  </span>
                </div>
                {p.capabilities !== null ? (
                  <ProxyCapabilityChips result={p.capabilities} size="xs" />
                ) : (
                  <span className="w-fit rounded-sm bg-surface-divider/60 px-1 py-px text-[9px] text-ink-muted">
                    untested
                  </span>
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

        {/* faux dock */}
        <div className="relative z-10 flex items-center gap-1.5 border-t border-surface-divider bg-white/[0.03] px-2.5 py-2">
          <button
            type="button"
            className={`flex-1 rounded-[10px] py-1.5 text-[11px] font-semibold disabled:opacity-50 ${
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
            {p.running ? 'Open' : p.busy ? 'Launching…' : 'Launch'}
          </button>
          <button
            type="button"
            aria-label={p.running ? 'Live view' : 'Launch and watch'}
            title={p.running ? 'Live view' : 'Launch & watch'}
            disabled={p.busy || (!p.running && p.launchDisabled)}
            onClick={(e) => {
              e.stopPropagation();
              p.onWatch();
            }}
            className="grid h-[30px] w-[30px] place-items-center rounded-[10px] border border-surface-divider bg-surface-elevated text-[12px] text-ink-secondary transition-colors hover:text-accent disabled:opacity-50"
          >
            💬
          </button>
          {p.hasProxy ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                p.onTest();
              }}
              disabled={p.testDisabled}
              title="Test proxy — reachability, latency, exit IP"
              className="grid h-[30px] w-[30px] place-items-center rounded-[10px] border border-surface-divider bg-surface-elevated text-[11px] text-ink-muted transition-colors hover:text-accent disabled:opacity-50"
            >
              {p.testing ? '…' : '⟳'}
            </button>
          ) : null}
          <button
            type="button"
            aria-label="Organize"
            title="Organize (folder + tags)"
            onClick={(e) => {
              e.stopPropagation();
              p.onOrganizeToggle();
            }}
            className="grid h-[30px] w-[30px] place-items-center rounded-[10px] border border-surface-divider bg-surface-elevated text-[13px] text-ink-secondary transition-colors hover:text-accent"
          >
            ⋯
          </button>
        </div>
      </div>
    </article>
  );
}
