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

import { useEffect, useRef, useState, type JSX, type ReactNode } from 'react';
import { ProxyOsChip, proxyCapabilities } from './ProxyCapabilities';
import { RelativeTime } from './RelativeTime';
import { proxyVerdict, type ProxyTestResult } from '../lib/proxies';
import type { OsFingerprint } from '../lib/os-fingerprint-verdict';

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
  /** doc-150 item 5 — already-formatted per-profile storage size (e.g. "2.4 MiB"
   *  or "—" when never saved). The parent formats it via fmtBytes so the card
   *  stays purely presentational. */
  sizeLabel?: string;
  /** Existing save metadata proves this profile has a persisted browser-state
   *  blob. The exact tab count stays encrypted inside ProfileBlob.openTabs, so
   *  the card truthfully promises restore without inventing a number. */
  savedTabsReopen?: boolean;
  folder: string;
  tags: ReadonlyArray<string>;
  /** Free-text note (F3 — now editable in the grid card too, not just the table).
   *  Empty string = no note. */
  note?: string;
  /** Save the trimmed note (Enter / Save / blur in the inline editor); empty
   *  clears it. Omitted → the "Edit note" affordance isn't offered. */
  onSaveNote?: (note: string) => string | null | void | Promise<string | null | void>;
  // proxy / egress
  hasProxy: boolean;
  /** The proxy's own LABEL, so the card says WHICH proxy it is using.
   *  The card previously received only `hasProxy`, a boolean — the resolved
   *  ProxyConfig carrying `label` was in scope at the call site and dropped
   *  there, so a customer with several proxies could see that a profile had one
   *  and never which. Null when unbound or unnamed. */
  proxyName?: string | null;
  /**
   * Whether this profile is bound to that proxy DELIBERATELY, or merely inherits it.
   *
   * With no explicit binding a profile resolves to the first saved proxy, so the
   * moment one proxy exists every card starts showing its country and exit IP —
   * reported as "suddenly all profiles are linked to this proxy". Nothing was
   * written; the display simply could not tell a choice from a default. The edit
   * modal already distinguishes them ("First available saved proxy"); this makes
   * the card agree.
   */
  proxyExplicit: boolean;
  flag: string; // emoji or '🌍'
  countryCode: string | null; // exit country code (e.g. 'NL') for the badge
  exitIp: string | null; // real exit IP, or null = untested
  latencyMs: number | null;
  latencyFillPct: number;
  latencyGood: boolean;
  probed: boolean;
  capabilities: ProxyTestResult | null;
  /** N-2 — passive OS fingerprint of the proxy's own stack, when the control
   *  plane observed one. Undefined = never measured. */
  osFingerprint?: OsFingerprint;
  checkedAtIso: string | null;
  // actions
  busy: boolean;
  /** This row is specifically creating a session. `busy` also covers stop,
   *  reopen, clone, trim, and delete, so it cannot safely drive launch copy. */
  launching: boolean;
  /** True when SOME OTHER profile is busy (a global single-flight is held, e.g.
   *  another row launching through the ~12s server probe). The mutate actions
   *  (Duplicate / Trim / Delete) early-return on that global guard, so they're
   *  disabled here with a tooltip rather than no-op'ing silently on a click. */
  anyBusy: boolean;
  testing: boolean;
  testDisabled: boolean;
  launchDisabled: boolean;
  launchDisabledReason?: string;
  onToggleSelect: () => void;
  onPrimary: () => void; // Launch (idle) / Open session (running)
  onWatch: () => void;
  onTest: () => void;
  onAssist?: () => void;
  /** Stop the running session (founder Track A) — close the bound agent/driver
   *  session so the card flips back to Launch. The Stop affordance renders ONLY
   *  when the profile is running AND this handler is provided (idle cards never
   *  show Stop); guarded by `busy` so a double-click can't double-close. */
  onStop?: () => void;
  /** Management actions in the ⋯ menu (grid view) — edit metadata, duplicate,
   *  export a portable copy, delete the profile. Omitted → that action isn't
   *  offered. */
  onEdit?: () => void;
  /** Duplicate this profile into a fresh one (server clone). Disabled at the
   *  tier cap (the caller passes `cloneDisabled` + a reason). */
  onClone?: () => void;
  cloneDisabled?: boolean;
  cloneDisabledReason?: string;
  onExport?: () => void;
  /** doc-150 §8 — "Clear cache, keep logins". Trims the profile's re-fetchable
   *  caches while keeping logins/storage/tabs. Omitted → the action isn't
   *  offered. Disabled while busy (a launch/clone/trim in flight). */
  /**
   * Clear a scope of this profile's stored data. Typed with a local union rather
   * than the SDK's TrimProfileScope so this presentational component keeps no
   * dependency on the API client.
   */
  onTrim?: (scope: 'cache' | 'cookies' | 'history' | 'all') => void;
  onDelete?: () => void;
}

export function ProfilePhoneCard(p: ProfilePhoneCardProps): JSX.Element {
  // Secondary actions (Watch/Test/Assist) live behind a ⋯ button in the dock so
  // they're tap-discoverable on a trackpad, not hover-only (founder 2026-06-16,
  // matching the visual-demo dock). Mouse hover still reveals them too.
  const [actionsOpen, setActionsOpen] = useState(false);
  // F3 — inline note editor (opened from the ⋯ menu's "Edit note" row). Lives
  // here so the small <textarea> overlays the card body without leaving the grid.
  const [editingNote, setEditingNote] = useState(false);
  const [noteDraft, setNoteDraft] = useState(p.note ?? '');
  const [noteSaving, setNoteSaving] = useState(false);
  const [noteError, setNoteError] = useState<string | null>(null);
  const noteSaveInFlightRef = useRef(false);
  const commitNote = async (): Promise<void> => {
    if (p.onSaveNote === undefined || noteSaveInFlightRef.current) return;
    noteSaveInFlightRef.current = true;
    setNoteSaving(true);
    setNoteError(null);
    try {
      const error = await p.onSaveNote(noteDraft.trim());
      if (typeof error === 'string' && error.length > 0) {
        setNoteError(error.slice(0, 240));
        return;
      }
      setEditingNote(false);
    } catch {
      setNoteError("Couldn't save the note. Check your connection and try again.");
    } finally {
      noteSaveInFlightRef.current = false;
      setNoteSaving(false);
    }
  };
  // Dismiss the tap-opened ⋯ menu on an outside pointer-down or Escape — a
  // toggle-opened dropdown that can only be re-toggled shut reads as stuck.
  const footerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!actionsOpen) return;
    const onPointerDown = (e: PointerEvent): void => {
      if (footerRef.current !== null && !footerRef.current.contains(e.target as Node)) {
        setActionsOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setActionsOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [actionsOpen]);
  // UDP badge state + the WebRTC/QUIC detail shown on hover. proxyCapabilities
  // gates WebRTC/QUIC on reachable+auth+udp_associate (they ride UDP).
  const caps = p.capabilities !== null ? proxyCapabilities(p.capabilities) : null;
  const webrtc = caps?.find((c) => c.key === 'webrtc')?.ok ?? false;
  const quic = caps?.find((c) => c.key === 'quic')?.ok ?? false;
  const udpOk = webrtc; // WebRTC ok === UDP relay verified
  // The overall verdict, from the ONE shared definition rather than a local
  // spelling of it — a card that disagreed with the proxies page about whether
  // a proxy works is the whole failure this helper exists to prevent.
  const verdict = p.capabilities !== null ? proxyVerdict(p.capabilities) : null;
  const proxyOk = verdict === null || verdict.ok;
  const proxyLabel = verdict?.label ?? '';
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
          ? 'border-accent shadow-[0_0_0_1.5px_rgb(var(--accent-rgb)),0_10px_26px_rgba(0,0,0,0.5)]'
          : p.running
            ? 'border-[#0a0d12] shadow-[0_10px_26px_rgba(0,0,0,0.5)]'
            : 'border-[#0a0d12] shadow-[0_8px_20px_rgba(0,0,0,0.38)]'
      }`}
      style={{ background: 'linear-gradient(160deg,#161b24,#0a0e14)' }}
    >
      {/* SCREEN — taller (height-only bump) so the body has room. */}
      <div className="relative flex aspect-[9/18.5] flex-col overflow-hidden rounded-[17px] bg-surface-raised">
        {/* F3 — inline note editor overlay. Floats over the screen so it never
            reshapes the card; stops propagation so typing/saving never toggles
            selection. Enter saves, Shift+Enter newlines, Escape cancels. */}
        {editingNote ? (
          <div
            className="absolute inset-0 z-40 flex flex-col gap-2 bg-surface-raised/95 p-3 backdrop-blur-sm"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          >
            <span className="text-[11px] font-semibold text-ink-secondary">Note</span>
            <textarea
              autoFocus
              aria-label={`Note for ${p.name}`}
              value={noteDraft}
              disabled={noteSaving}
              maxLength={280}
              rows={5}
              placeholder="Add a note…"
              onChange={(e) => setNoteDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void commitNote();
                } else if (e.key === 'Escape') {
                  setNoteDraft(p.note ?? '');
                  setEditingNote(false);
                }
              }}
              className="min-h-0 flex-1 resize-none rounded-lg border border-surface-divider bg-surface-inset px-2 py-1.5 text-[11.5px] text-ink-primary placeholder:text-ink-muted focus:border-accent focus:outline-none"
            />
            {noteError !== null ? (
              <p role="alert" className="text-[10px] text-status-error">
                {noteError}
              </p>
            ) : null}
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                disabled={noteSaving}
                onClick={() => {
                  setNoteDraft(p.note ?? '');
                  setNoteError(null);
                  setEditingNote(false);
                }}
                className="rounded-lg border border-surface-divider px-2.5 py-1 text-[11px] font-medium text-ink-secondary transition-colors hover:text-ink-primary"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={noteSaving}
                aria-busy={noteSaving}
                onClick={() => void commitNote()}
                className="btn-primary text-[11px]"
              >
                {noteSaving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        ) : null}
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
          <span className="truncate rounded bg-black/35 px-1.5 py-0.5 text-[11px] font-semibold tracking-tight text-ink-primary">
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
            <p className="line-clamp-1 text-center text-sm font-semibold leading-tight text-ink-primary">
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
                  {!p.proxyExplicit && (
                    // An inherited default, not a choice. Saying so is what stops a
                    // second proxy silently moving every profile that never picked one.
                    <span
                      data-component="proxy-inherited-badge"
                      title="No proxy chosen for this profile — it uses the first saved proxy, and will follow whichever that is."
                      className="rounded bg-surface-divider/40 px-1 text-[9px] font-medium uppercase tracking-wide text-ink-muted"
                    >
                      default
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
                {/* WHICH proxy. Its own row rather than squeezed beside the exit
                    IP: with several saved proxies the name is the thing that
                    tells two otherwise-identical cards apart. */}
                {p.proxyName !== null && p.proxyName !== undefined && p.proxyName !== '' && (
                  <div
                    className="flex items-center gap-1.5"
                    data-component="profile-card-proxy-name"
                  >
                    <span className="text-[9px] font-semibold uppercase tracking-wide text-ink-muted">
                      via
                    </span>
                    <span
                      className="min-w-0 flex-1 truncate text-[11.5px] text-ink-secondary"
                      title={p.proxyName}
                    >
                      {p.proxyName}
                    </span>
                  </div>
                )}
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
                  {p.hasProxy && <ProxyOsChip fingerprint={p.osFingerprint} size="xs" />}
                </div>
                {/* A proxy that FAILED its last test says so, in place, with the
                    reason and a one-click retest.
                    Before this the card rendered a broken proxy almost exactly
                    like an untested one — "no exit IP" and a blank latency —
                    which reads as "not checked yet", not "this will not work".
                    The only retest lived in the overflow menu, so the customer
                    had to already suspect the proxy to find out it was dead. */}
                {caps !== null && !proxyOk && (
                  <div
                    data-component="proxy-broken-banner"
                    role="status"
                    className="flex items-center gap-1.5 rounded-[8px] border border-status-error/40 bg-status-error/10 px-1.5 py-1"
                  >
                    <span
                      className="text-[10px] font-semibold text-status-error"
                      title={p.capabilities?.message}
                    >
                      {proxyLabel}
                    </span>
                    <button
                      type="button"
                      data-action="retest-proxy"
                      disabled={p.testing || p.testDisabled}
                      onClick={(e) => {
                        // The card body is itself clickable (select/expand), so a
                        // bare click here would also toggle the row.
                        e.stopPropagation();
                        p.onTest();
                      }}
                      className="ml-auto rounded bg-status-error/20 px-1.5 py-px text-[9.5px] font-semibold text-status-error hover:bg-status-error/30 disabled:opacity-50"
                    >
                      {p.testing ? 'Testing…' : 'Retest'}
                    </button>
                    {p.onEdit !== undefined && (
                      // Straight to the edit modal, which is where the proxy is
                      // chosen — "retest or change more conveniently" needs both
                      // to be one click from the card that reports the problem.
                      <button
                        type="button"
                        data-action="change-proxy"
                        disabled={p.anyBusy}
                        onClick={(e) => {
                          e.stopPropagation();
                          p.onEdit?.();
                        }}
                        className="rounded bg-surface-divider/60 px-1.5 py-px text-[9.5px] font-semibold text-ink-secondary hover:bg-surface-divider disabled:opacity-50"
                      >
                        Change
                      </button>
                    )}
                  </div>
                )}
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

          {/* F3 — note line. Editable in-place (click) when onSaveNote is wired;
              clicking opens the same overlay editor as the ⋯ "Edit note" row. */}
          {p.onSaveNote && p.note && p.note.trim() !== '' ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setNoteDraft(p.note ?? '');
                setNoteError(null);
                setEditingNote(true);
              }}
              title="Click to edit note"
              className="line-clamp-2 rounded-md border border-surface-divider/70 bg-surface-inset/60 px-1.5 py-1 text-left text-[9.5px] italic text-ink-secondary transition-colors hover:text-ink-primary"
            >
              🗒 {p.note}
            </button>
          ) : null}

          <div className="mt-auto flex flex-col items-center gap-1">
            {p.savedTabsReopen === true && !p.running ? (
              <span
                data-component="saved-tabs-reopen"
                title="This profile's saved tabs reopen when you launch it"
                className="inline-flex items-center gap-1 rounded-full border border-accent/25 bg-accent-subtle px-2 py-0.5 text-[9.5px] font-medium text-accent"
              >
                <span aria-hidden="true">↻</span>
                Saved tabs reopen
              </span>
            ) : null}
            <span className="flex items-center justify-center gap-1.5 text-center text-[9.5px] text-ink-muted">
              {p.lastUsedIso !== null ? (
                <RelativeTime iso={p.lastUsedIso} tooltipPrefix="Last used" />
              ) : (
                'never launched'
              )}
              {/* doc-150 item 5 — per-profile sealed-store size. "—" = never saved. */}
              {p.sizeLabel !== undefined && (
                <>
                  <span aria-hidden="true">·</span>
                  <span title="Stored profile size (encrypted browser state)">{p.sizeLabel}</span>
                </>
              )}
            </span>
          </div>
        </div>

        {/* footer: the Launch dock + a hover action strip that floats ABOVE it
            (bottom-full) so the secondary actions never overlap Launch. */}
        <div ref={footerRef} className="relative z-10">
          {/* action menu — a clean VERTICAL DROPDOWN of labelled rows (founder
              2026-06-17), anchored above the dock so it never collides with
              Launch/Open.
              ⛔ Opened ONLY by the ⋯ toggle. It also opened on card HOVER
              (group-hover:opacity-100), so moving the pointer across the grid unfurled
              every action — the destructive ones included — over whatever card the
              cursor passed (owner 2026-08-30: "hover over profile currently expands all
              options, but it should just happen when clicking the … dots"). Same
              correction as the Clear group in V-2149, one level up.
              Rows stay in the DOM (opacity-toggled) so the
              accessible labels are always queryable. */}
          <div
            data-component="card-actions-menu"
            role="menu"
            className={`absolute bottom-full right-1.5 z-20 mb-1.5 w-44 overflow-hidden rounded-xl border border-surface-divider bg-surface-raised py-1 shadow-[0_12px_30px_rgba(0,0,0,0.5)] transition-opacity duration-150 ${
              actionsOpen ? 'pointer-events-auto opacity-100' : 'pointer-events-none opacity-0'
            }`}
          >
            {p.onAssist ? (
              <MenuRow
                glyph="✦"
                caption="Assist"
                label={`Ask the AI assistant about ${p.name}`}
                onClick={() => {
                  setActionsOpen(false);
                  p.onAssist?.();
                }}
              />
            ) : null}
            <MenuRow
              glyph={p.running ? '◉' : '▶'}
              caption={p.running ? 'View live' : 'Watch'}
              label={p.running ? 'Open the live view' : 'Launch and watch live'}
              onClick={() => {
                setActionsOpen(false);
                p.onWatch();
              }}
              disabled={p.busy || (!p.running && p.launchDisabled)}
            />
            {/* Stop — only for a RUNNING profile with a stop handler (idle cards
                never show it). Reuses `busy` so a double-click can't double-close
                (founder Track A). */}
            {p.running && p.onStop ? (
              <MenuRow
                glyph={p.busy ? '…' : '◼'}
                caption={p.busy ? 'Stopping…' : 'Stop session'}
                label={`Stop ${p.name}'s running session`}
                tone="danger"
                onClick={() => {
                  setActionsOpen(false);
                  p.onStop?.();
                }}
                disabled={p.busy}
              />
            ) : null}
            {p.hasProxy ? (
              <MenuRow
                glyph={p.testing ? '…' : '⟳'}
                caption="Test proxy"
                label="Test proxy — reachability, latency, exit IP"
                onClick={() => {
                  setActionsOpen(false);
                  p.onTest();
                }}
                disabled={p.testDisabled}
              />
            ) : null}
            {p.onEdit ? (
              <MenuRow
                glyph="✎"
                caption="Edit"
                label={`Edit ${p.name}`}
                onClick={() => {
                  setActionsOpen(false);
                  p.onEdit?.();
                }}
              />
            ) : null}
            {p.onSaveNote ? (
              <MenuRow
                glyph="🗒"
                caption={p.note && p.note.trim() !== '' ? 'Edit note' : 'Add note'}
                label={`Edit note for ${p.name}`}
                onClick={() => {
                  setActionsOpen(false);
                  setNoteDraft(p.note ?? '');
                  setNoteError(null);
                  setEditingNote(true);
                }}
              />
            ) : null}
            {p.onClone ? (
              <MenuRow
                glyph="⧉"
                caption="Duplicate"
                label={`Duplicate ${p.name}`}
                title={
                  p.cloneDisabled
                    ? p.cloneDisabledReason
                    : p.anyBusy && !p.busy
                      ? 'Another profile is busy — wait for it to finish'
                      : undefined
                }
                disabled={p.cloneDisabled || p.busy || p.anyBusy}
                onClick={() => {
                  setActionsOpen(false);
                  p.onClone?.();
                }}
              />
            ) : null}
            {p.onExport ? (
              <MenuRow
                glyph="⤓"
                caption="Export"
                label={`Export ${p.name} as a portable JSON copy`}
                onClick={() => {
                  setActionsOpen(false);
                  p.onExport?.();
                }}
              />
            ) : null}
            {/* doc-150 §8 — Trim: clear re-fetchable caches, keep logins. The
                title spells out exactly what's kept so the customer knows
                nothing identity-bearing is dropped. Disabled while busy. */}
            {p.onTrim ? (
              <MenuGroup glyph="🧹" caption="Clear…" label={`Clearing options for ${p.name}`}>
                <MenuRow
                  glyph="🧹"
                  caption="Clear cache"
                  label={`Clear cache for ${p.name}`}
                  title={
                    p.anyBusy && !p.busy
                      ? 'Another profile is busy — wait for it to finish'
                      : 'Free re-fetchable files. Logins, site data and tabs are kept'
                  }
                  disabled={p.busy || p.anyBusy}
                  onClick={() => {
                    setActionsOpen(false);
                    p.onTrim?.('cache');
                  }}
                />
                {/* W3120 (doc-150 §8.4). These three DESTROY state the customer
                    cannot get back, unlike a cache clear which simply refetches,
                    so each title says plainly what goes before the confirm does. */}
                <MenuRow
                  glyph="🍪"
                  caption="Clear cookies"
                  label={`Clear cookies for ${p.name}`}
                  title={
                    p.anyBusy && !p.busy
                      ? 'Another profile is busy — wait for it to finish'
                      : 'Signs this profile out everywhere. Cached files and tabs are kept'
                  }
                  disabled={p.busy || p.anyBusy}
                  onClick={() => {
                    setActionsOpen(false);
                    p.onTrim?.('cookies');
                  }}
                />
                <MenuRow
                  glyph="🕘"
                  caption="Clear history"
                  label={`Clear history for ${p.name}`}
                  title={
                    p.anyBusy && !p.busy
                      ? 'Another profile is busy — wait for it to finish'
                      : 'Forgets the remembered tabs — the only page record a profile keeps'
                  }
                  disabled={p.busy || p.anyBusy}
                  onClick={() => {
                    setActionsOpen(false);
                    p.onTrim?.('history');
                  }}
                />
                <MenuRow
                  glyph="🧨"
                  caption="Clear everything"
                  label={`Clear all browsing data for ${p.name}`}
                  title={
                    p.anyBusy && !p.busy
                      ? 'Another profile is busy — wait for it to finish'
                      : 'Cookies, site data, cache and tabs. The profile and its fingerprint stay'
                  }
                  disabled={p.busy || p.anyBusy}
                  onClick={() => {
                    setActionsOpen(false);
                    p.onTrim?.('all');
                  }}
                />
              </MenuGroup>
            ) : null}
            {p.onDelete ? (
              <>
                <div className="my-1 h-px bg-surface-divider" aria-hidden="true" />
                {/* Delete is rejected by the server for a RUNNING session, so
                    disable it (matching ProfilesTable) and explain via the
                    tooltip rather than letting the click 409. Also disable while
                    BUSY (a launch/clone in flight) so a delete can't race an
                    in-flight launch before `running` is set — w410wv3eq #4. */}
                <MenuRow
                  glyph="🗑"
                  caption="Delete"
                  label={`Delete ${p.name}`}
                  title={
                    p.running
                      ? 'Stop the session first before deleting'
                      : p.anyBusy && !p.busy
                        ? 'Another profile is busy — wait for it to finish'
                        : undefined
                  }
                  tone="danger"
                  disabled={p.busy || p.running || p.anyBusy}
                  onClick={() => {
                    setActionsOpen(false);
                    p.onDelete?.();
                  }}
                />
              </>
            ) : null}
          </div>

          {/* dock — Launch/Open (flex-1) + a persistent ⋯ for the secondary
              actions, mirroring the visual-demo dock (founder 2026-06-16). */}
          <div className="flex items-center gap-2 border-t border-surface-divider bg-white/[0.03] px-2.5 py-2">
            <button
              type="button"
              className={`flex-1 rounded-[10px] py-1.5 text-[11.5px] font-semibold transition-colors disabled:opacity-50 ${
                p.running
                  ? 'border border-surface-divider bg-surface-elevated text-ink-primary hover:bg-surface-divider'
                  : 'bg-accent text-white shadow-[0_3px_10px_rgba(0,0,0,0.4),inset_0_1px_0_rgba(255,255,255,0.18)] hover:bg-accent-hover'
              }`}
              disabled={p.busy || (!p.running && p.launchDisabled)}
              aria-busy={!p.running && p.launching}
              title={!p.running && p.launchDisabled ? p.launchDisabledReason : undefined}
              onClick={(e) => {
                e.stopPropagation();
                p.onPrimary();
              }}
            >
              {p.running ? (
                'Open session'
              ) : p.launching ? (
                <span className="inline-flex items-center justify-center gap-1.5">
                  <span
                    aria-hidden="true"
                    data-component="launch-spinner"
                    className="h-3 w-3 animate-spin rounded-full border-2 border-white/35 border-t-white"
                  />
                  Starting…
                </span>
              ) : (
                'Launch'
              )}
            </button>
            <button
              type="button"
              aria-label="More actions"
              aria-expanded={actionsOpen}
              title="More actions"
              className={`flex h-[30px] w-[34px] shrink-0 items-center justify-center rounded-[10px] border text-[15px] leading-none transition-colors ${
                actionsOpen
                  ? 'border-accent bg-accent-subtle text-ink-primary'
                  : 'border-surface-divider bg-surface-elevated text-ink-secondary hover:text-ink-primary'
              }`}
              onClick={(e) => {
                e.stopPropagation();
                setActionsOpen((v) => !v);
              }}
            >
              ⋯
            </button>
          </div>
          {/* iOS home indicator — sells the phone metaphor; below the dock row. */}
          <div className="bg-white/[0.03] pb-2">
            <span
              aria-hidden="true"
              className="mx-auto block h-1 w-10 rounded-full bg-ink-muted/40"
            />
          </div>
        </div>
      </div>
    </article>
  );
}

// MenuRow — one labelled row in the grid-card ⋯ dropdown menu (founder
// 2026-06-17: "the dots should be a cleaner vertical dropdown with labels").
// glyph + caption are visible; `label` is the descriptive aria-label/title
// (kept stable so the harness queries by it).
/**
 * A collapsible group of menu rows.
 *
 * ⭐ Four "Clear …" rows sat inline in a thirteen-item card menu, so the two
 * actions a customer reaches for daily were buried under variants of one they use
 * rarely. Owner-reported: they "take up too many items".
 *
 * ⚠️ Opens on hover AND on click/focus, deliberately. Hover alone is what a mouse
 * user asks for and it is unreachable by keyboard and unusable on touch — the
 * disclosure would simply never open.
 *
 * ⛔ CLICK ONLY — hover-to-open was removed (owner 2026-08-30: "the clear
 * shouldn't be hover but click to expand"). Opening a group of DESTRUCTIVE rows
 * because a pointer crossed the word "Clear…" pushes those rows under the cursor
 * without the customer choosing to look at them. `onFocus` went with it: tabbing
 * to a disclosure should not expand it either. Click (or Enter/Space on the
 * focused button) toggles, which is what a disclosure button is expected to do.
 *
 * Stays open once opened rather than closing on mouseleave: the rows below are
 * destructive, and a submenu that retracts while the pointer travels toward it
 * turns a careful click into a mis-click on whatever moves into its place.
 */
function MenuGroup({
  glyph,
  caption,
  label,
  children,
}: {
  glyph: ReactNode;
  caption: string;
  label: string;
  children: ReactNode;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div data-component="menu-group" data-open={open ? 'true' : 'false'}>
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        title={label}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[11.5px] font-medium text-ink-secondary transition-colors hover:bg-surface-elevated hover:text-ink-primary"
      >
        <span className="w-4 shrink-0 text-center text-[13px] leading-none" aria-hidden="true">
          {glyph}
        </span>
        <span className="leading-none">{caption}</span>
        <span className="ml-auto text-[10px] leading-none text-ink-muted" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
      </button>
      {open ? <div className="border-l border-surface-divider pl-1.5">{children}</div> : null}
    </div>
  );
}

function MenuRow({
  glyph,
  caption,
  label,
  title,
  onClick,
  disabled,
  tone,
}: {
  glyph: ReactNode;
  caption: string;
  label: string;
  /** Optional hover title; falls back to `label` (e.g. a disabled-reason). */
  title?: string;
  onClick: () => void;
  disabled?: boolean;
  tone?: 'danger';
}): JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      title={title ?? label}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={`flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[11.5px] font-medium transition-colors disabled:opacity-40 ${
        tone === 'danger'
          ? 'text-status-error/90 hover:bg-status-error/15 hover:text-status-error'
          : 'text-ink-secondary hover:bg-surface-elevated hover:text-ink-primary'
      }`}
    >
      <span className="w-4 shrink-0 text-center text-[13px] leading-none" aria-hidden="true">
        {glyph}
      </span>
      <span className="leading-none">{caption}</span>
    </button>
  );
}
