// ProfilesTable (2026-06-15, v2) — the list view as a clean, sortable,
// professional table. Surfaces the SAME probe-derived data the grid card uses.
// Pure presentational: ProfilesView computes the row view-models + passes
// handlers.
//
// v2 (founder batch #2):
//  - Keyboard-selectable: a real checkbox column (+ header select-all) so AT /
//    keyboard users can select rows for the bulk bar; row-click still selects
//    for mouse (the checkbox stops propagation so the two don't cancel out).
//  - Exit IP cell consolidates everything egress: flag + IP + location
//    (city · region · country when known) + latency + an inline Test button —
//    so Test/latency are no longer separate columns crowding Actions.
//  - Overflow fixed: auto layout + overflow-x-auto, so action buttons never
//    spill outside the table; wide content scrolls within the bordered box.
//  - More useful columns: Tags, Created, Last used, Notes.
//
// T-19 (2026-09-07, owner #5 "it should be able to select easier"): a visible
// selected state (accent left rail + tint), a hover tint, a tooltip that says
// what a click does, and stopPropagation only on REAL controls — never on a
// cell. See the <tr> in Row for the reasoning.

import { useRef, useState, type JSX } from 'react';
import { RelativeTime } from './RelativeTime';
import {
  CHECK_VPN_ACTION,
  CHECK_VPN_TITLE,
  ENDPOINT_UNRESOLVED,
  ENDPOINT_UNRESOLVED_EXIT_TITLE,
  EXIT_GEO_UNAVAILABLE_SHORT,
  EXIT_GEO_UNAVAILABLE_TITLE,
  VPN_NO_EXIT_YET,
  VPN_NO_EXIT_YET_TITLE,
} from '../lib/proxy-check-copy';

export type ProfilesTableSortKey = 'name' | 'status' | 'country' | 'created' | 'lastUsed';

export interface ProfileTableRow {
  id: string;
  name: string;
  icon?: string;
  deviceLabel: string;
  running: boolean;
  /** Worktimer — ISO start time of the bound running session (null when idle
   *  or the start time isn't known). Drives the live "running for" elapsed. */
  runningSinceIso?: string | null;
  hasProxy: boolean;
  flag: string;
  countryCode: string | null;
  exitIp: string | null;
  proxyAddress: string | null; // host:port of the bound proxy (hover detail)
  locationLabel: string | null; // resolved city · region · country (or country)
  probed: boolean;
  udp: 'ok' | 'fail' | 'unknown';
  /** Canonical QUIC verdict (same source as the card's chip) for the UDP-column
   *  tooltip, so the list never claims "QUIC ✓" while the card shows "~". */
  quic?: 'ok' | 'inferred' | 'fail' | 'unknown';
  latencyMs: number | null;
  /** True when latencyMs is the fleet/server number (matches the grid card),
   *  false/absent when it is the native this-Mac probe. Drives the source hint. */
  latencyFromServer?: boolean;
  folder: string;
  tags: ReadonlyArray<string>;
  note: string;
  /** doc-150 item 5 — already-formatted per-profile storage size (e.g. "2.4 MiB"
   *  or "—" when never saved). The parent formats it via fmtBytes. */
  sizeLabel: string;
  /** True when existing profile save metadata proves saved browser state is
   *  available. The tab count itself is encrypted and intentionally not guessed. */
  savedTabsReopen?: boolean;
  createdAtIso: string | null;
  lastUsedIso: string | null;
  selected: boolean;
  busy: boolean;
  /** True only while this row is creating a session. */
  launching: boolean;
  testing: boolean;
  testDisabled: boolean;
  launchDisabled: boolean;
  launchDisabledReason?: string;
  /** (n) N18 — the bound proxy is an OpenVPN/WireGuard TUNNEL. The grid card has
   *  carried this since (h); the list row did not, so the SAME profile showed
   *  'Test proxy — reachability, latency, exit IP' here and 'Check VPN' there,
   *  'no exit IP' here and 'no exit measured yet — run Check VPN' there, and a
   *  tunnel the fleet could not bring up rendered exactly like an untested row.
   *  The click was already routed correctly (ProfilesView onTest → resolve +
   *  fleet); only the rendering diverged. Same four props the card takes, from
   *  the same parent state, so the two surfaces cannot drift again. */
  vpn?: boolean;
  /** The fleet's sentence for a tunnel that did not come up (the red banner). */
  vpnFailure?: string;
  /** The fleet's sentence for a check that did not RUN (muted; nothing failed). */
  vpnNotice?: string;
  /** (o) — the resolver's message when the row's endpoint pre-flight did NOT
   *  resolve (a VPN/HTTP row's check is a DNS resolve of its host). Absent when
   *  it resolved or no pre-flight ran. The exit cell then says "unresolved"
   *  rather than promising that Check VPN will measure an exit. */
  endpointUnresolved?: string;
  /** Phase C (C8) — V-857's third exit state, the one the grid card already
   *  carries (`exitProbeFailed`): the proxy is usable and the last test's echo
   *  round-trip did not complete, so there is no exit to show and the reason
   *  is not "never tested". Derived at the call site exactly as the card's:
   *  `px !== null && probeView.exitResults[px.id] === null`. */
  exitProbeFailed?: boolean;
  /** When the fleet last answered for this row — for a VPN row that is the
   *  fleet's own stamp, never the DNS pre-flight that precedes a refused test. */
  checkedAtIso?: string | null;
}

export interface ProfilesTableProps {
  rows: ReadonlyArray<ProfileTableRow>;
  sortKey: ProfilesTableSortKey;
  sortDir: 'asc' | 'desc';
  onSort: (key: ProfilesTableSortKey) => void;
  allSelected: boolean;
  onToggleSelectAll: () => void;
  onToggleSelect: (id: string) => void;
  /** True when SOME profile is busy (a global single-flight is held — e.g.
   *  another row launching through the ~12s server probe). The mutate actions
   *  (Duplicate / Trim / Delete) early-return on that global guard, so they're
   *  disabled with a tooltip rather than silently no-op'ing on a click. */
  anyBusy?: boolean;
  onPrimary: (id: string) => void; // Launch (idle) / Open session (running)
  onWatch: (id: string) => void;
  onStop: (id: string) => void;
  onTest: (id: string) => void;
  onEdit: (id: string) => void;
  /** Duplicate a profile (server clone). Disabled at the tier cap. Optional —
   *  when omitted (founder 2026-06-20 CLONE_ENABLED=false) the Duplicate action
   *  is hidden entirely; the handler is kept so it can be re-enabled. */
  onClone?: (id: string) => void;
  cloneDisabled?: boolean;
  cloneDisabledReason?: string;
  /** doc-150 §8 — "Clear cache, keep logins". Trims the profile's re-fetchable
   *  caches. Disabled while the row is busy. */
  onTrim: (id: string) => void;
  onDelete: (id: string) => void;
  // Inline note editing (founder batch #2 "Add note"). Called with the trimmed
  // note on commit (Enter / blur); empty string clears the note.
  onSaveNote: (id: string, note: string) => string | null | void | Promise<string | null | void>;
}

interface Col {
  key: ProfilesTableSortKey | null;
  label: string;
  align?: 'right';
  hideSmall?: boolean;
  hideMed?: boolean;
}

const COLS: ReadonlyArray<Col> = [
  { key: 'name', label: 'Profile' },
  { key: null, label: 'Tags', hideSmall: true },
  { key: 'status', label: 'Status', hideMed: true },
  { key: 'country', label: 'Exit IP' },
  { key: null, label: 'UDP', hideMed: true },
  { key: 'created', label: 'Created', hideSmall: true },
  { key: 'lastUsed', label: 'Last used', hideSmall: true },
  // doc-150 item 5 — per-profile sealed-store size. Collapses on narrow widths
  // with the other secondary columns.
  { key: null, label: 'Storage', hideSmall: true, align: 'right' },
  { key: null, label: 'Notes', hideSmall: true },
  { key: null, label: 'Actions', align: 'right' },
];

// Two responsive tiers so the table fits narrow windows without assuming a
// full-width viewport (founder 2026-06-16). These are CONTAINER queries
// (see .ds-table-shell + @container in styles/index.css), NOT viewport
// breakpoints: the table area is the window minus the nav sidebar AND the
// folder/tag rail, so md:/lg: misfired and the table scrolled instead of
// fitting. Keyed off the card's own width: under 1000px the secondary
// columns (Tags/Created/Last used/Notes) collapse; under 720px Status + UDP
// also collapse, leaving the essentials — select · Profile · Exit IP · Actions.
const HIDE_SMALL = 'ds-col-l';
const HIDE_MED = 'ds-col-m';

// The QUIC clause of the UDP-column tooltip — the canonical verdict wording,
// so the list agrees with the card's QUIC chip instead of asserting "QUIC ✓"
// from UDP relay alone (which only means WebRTC, never that HTTP/3 carries).
const QUIC_CLAUSE: Record<'ok' | 'inferred' | 'fail' | 'unknown', string> = {
  ok: 'QUIC ✓',
  inferred: 'QUIC likely (not yet measured)',
  fail: 'QUIC ✗ (HTTP/2 on last measure)',
  unknown: 'QUIC not tested',
};

export function ProfilesTable(p: ProfilesTableProps): JSX.Element {
  return (
    <div className="ds-table-shell overflow-x-auto rounded-lg border border-surface-divider bg-surface-raised">
      <table className="w-full border-collapse text-left text-xs">
        <thead>
          <tr className="border-b border-surface-divider text-ink-muted">
            <th scope="col" className="w-9 px-3 py-2">
              <input
                type="checkbox"
                className="h-3.5 w-3.5 cursor-pointer accent-accent"
                checked={p.allSelected}
                onChange={p.onToggleSelectAll}
                aria-label="Select all profiles"
                title="Select all"
              />
            </th>
            {COLS.map((c) => (
              <th
                key={c.label}
                scope="col"
                className={`px-3 py-2 font-medium ${c.align === 'right' ? 'text-right' : ''} ${c.hideSmall ? HIDE_SMALL : ''} ${c.hideMed ? HIDE_MED : ''}`}
              >
                {c.key !== null ? (
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 uppercase tracking-wide transition-colors hover:text-ink-primary"
                    onClick={() => p.onSort(c.key as ProfilesTableSortKey)}
                  >
                    {c.label}
                    <SortCaret active={p.sortKey === c.key} dir={p.sortDir} />
                  </button>
                ) : (
                  <span className="uppercase tracking-wide">{c.label}</span>
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {p.rows.map((r) => (
            <Row key={r.id} r={r} p={p} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

const OTHER_BUSY_HINT = 'Another profile is busy — wait for it to finish';

function Row({ r, p }: { r: ProfileTableRow; p: ProfilesTableProps }): JSX.Element {
  // T-19 — stop() belongs on REAL controls only (the buttons below and the
  // checkbox), never on a container cell: the whole row is the select target,
  // and a cell that swallows clicks shrinks that target below what the row
  // visibly promises. Audited 2026-09-07: every stop() site is a <button>, the
  // checkbox, or the OPEN note editor's wrapper — a control while it is open,
  // never the cell; the one td-level stop (Notes) moved there.
  const stop = (fn: () => void) => (e: React.MouseEvent) => {
    e.stopPropagation();
    fn();
  };
  // A global single-flight (busyId) makes the mutate handlers early-return; when
  // ANOTHER row holds it, disable this row's mutate actions with a hint so the
  // click gives feedback instead of silently no-op'ing. `r.busy` is THIS row.
  const otherBusy = (p.anyBusy ?? false) && !r.busy;
  const [editingNote, setEditingNote] = useState(false);
  const [noteDraft, setNoteDraft] = useState(r.note);
  const [noteSaving, setNoteSaving] = useState(false);
  const [noteError, setNoteError] = useState<string | null>(null);
  const noteSaveInFlightRef = useRef(false);
  const commitNote = async (): Promise<void> => {
    if (noteSaveInFlightRef.current) return;
    noteSaveInFlightRef.current = true;
    setNoteSaving(true);
    setNoteError(null);
    try {
      const error = await p.onSaveNote(r.id, noteDraft.trim());
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
  const exitHover = [r.proxyAddress, r.locationLabel].filter((x) => x !== null).join(' · ');
  return (
    // T-19 — the owner (#5) asked for selection to be "easier" than the small
    // checkbox. Whole-row click has selected since 0.1.0; what was missing was
    // anything SAYING so, and a selected state you could see beyond a faint
    // wash. The read is DISCOVERABILITY: an accent left rail + tinted background
    // when selected, a hover tint otherwise, a tooltip on the name cell. A
    // single-select-to-launch model was deliberately NOT introduced — selection
    // is a Set feeding ProfilesActionBar and every bulk action.
    // `last:border-b-0`, not `last:border-0`: the latter erased the rail on the
    // last row. `border-l-transparent` reserves the rail's 2px so selecting a
    // row shifts nothing.
    <tr
      onClick={() => p.onToggleSelect(r.id)}
      className={`cursor-pointer border-b border-l-2 border-surface-divider/60 align-top transition-colors last:border-b-0 ${
        r.selected
          ? 'border-l-accent bg-accent-subtle'
          : 'border-l-transparent hover:bg-surface-elevated'
      }`}
    >
      {/* select checkbox — keyboard path; stopPropagation so it doesn't double-
          toggle with the row click. */}
      <td className="px-3 py-2">
        <input
          type="checkbox"
          className="mt-0.5 h-3.5 w-3.5 cursor-pointer accent-accent"
          checked={r.selected}
          onClick={(e) => e.stopPropagation()}
          onChange={() => p.onToggleSelect(r.id)}
          aria-label={`Select ${r.name}`}
          title={r.selected ? 'Selected' : 'Select'}
        />
      </td>
      {/* Profile: status dot + icon + name + device subtitle + folder. T-19 —
          the select tooltip lives here, not on the <tr>: a row-level title would
          leak onto the untitled action buttons (Edit, Open session) as their hover
          text. */}
      <td
        className="px-3 py-2"
        title={r.selected ? 'Selected — click to deselect' : 'Click to select'}
      >
        <div className="flex items-start gap-2">
          <span
            aria-hidden="true"
            className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${r.running ? 'bg-status-ready' : 'bg-ink-muted/40'}`}
          />
          <div className="min-w-0">
            <p className="flex items-center gap-1.5 truncate font-medium text-ink-primary">
              {r.icon ? (
                <span aria-hidden="true" className="text-[13px] leading-none">
                  {r.icon}
                </span>
              ) : null}
              <span className="truncate">{r.name}</span>
            </p>
            <p className="truncate text-[10px] text-ink-muted">
              {r.deviceLabel}
              {r.folder !== '' ? ` · 📁 ${r.folder}` : ''}
            </p>
            {r.savedTabsReopen === true && !r.running ? (
              <p
                data-component="saved-tabs-reopen"
                title="This profile's saved tabs reopen when you launch it"
                className="mt-0.5 text-[10px] font-medium text-accent"
              >
                ↻ Saved tabs reopen
              </p>
            ) : null}
          </div>
        </div>
      </td>
      {/* Tags */}
      <td className={`px-3 py-2 ${HIDE_SMALL}`}>
        {r.tags.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {r.tags.map((t) => (
              <span
                key={t}
                className="rounded border border-surface-divider px-1 py-px text-[10px] text-ink-muted"
              >
                {t}
              </span>
            ))}
          </div>
        ) : (
          <span className="text-ink-muted">—</span>
        )}
      </td>
      {/* Status (collapses below md) — running rows show a live worktimer. */}
      <td className={`px-3 py-2 ${HIDE_MED}`}>
        <span
          className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
            r.running ? 'bg-status-ready/15 text-status-ready' : 'bg-surface-inset text-ink-muted'
          }`}
        >
          {r.running ? 'Live' : 'Idle'}
        </span>
        {r.running && r.runningSinceIso != null && r.runningSinceIso.length > 0 && (
          <span
            className="mono mt-0.5 block text-[10px] text-ink-muted"
            title={`Running since ${new Date(r.runningSinceIso).toLocaleString()}`}
          >
            {formatRunningFor(r.runningSinceIso)}
          </span>
        )}
      </td>
      {/* Exit IP — flag + IP + location + latency + inline Test */}
      <td className="px-3 py-2">
        {r.hasProxy ? (
          <div className="flex flex-col gap-0.5">
            <div
              className="flex items-center gap-1.5"
              title={exitHover.length > 0 ? exitHover : undefined}
            >
              <span aria-hidden="true">{r.flag}</span>
              {r.exitIp !== null ? (
                // shrink-0, never truncate: the address is the cell's fact. As a
                // shrinkable flex item its min-width was 0, so the column sized
                // itself to the OTHER rows' content and a VPN row — whose wider
                // "Check VPN" control shares the line — showed "203.0.11…"
                // (seen in the 2026-09-11 marketing capture). The column now
                // grows for it; the shell already scrolls sideways when needed.
                <span
                  data-component="profile-row-exit-ip"
                  className="mono shrink-0 text-ink-primary"
                >
                  {r.exitIp}
                </span>
              ) : r.endpointUnresolved !== undefined ? (
                // (o) — nothing was measured through an endpoint that does not
                // resolve; the grid's word, the resolver's message as the title.
                <span
                  data-component="profile-row-endpoint-unresolved"
                  className="italic text-status-error"
                  title={
                    r.endpointUnresolved.length > 0
                      ? r.endpointUnresolved
                      : ENDPOINT_UNRESOLVED_EXIT_TITLE
                  }
                >
                  {ENDPOINT_UNRESOLVED}
                </span>
              ) : r.vpn === true ? (
                // (n) N18 — a VPN row's empty exit says WHY and names the check,
                // exactly as the card and the Proxies grid do (one constant).
                <span className="italic text-ink-muted" title={VPN_NO_EXIT_YET_TITLE}>
                  {VPN_NO_EXIT_YET}
                </span>
              ) : r.exitProbeFailed === true ? (
                // Phase C (C8) — V-857's THIRD exit state: the proxy is usable
                // and the last test's echo round-trip did NOT complete. The card
                // shows this SHORT with this title for the same cache entry
                // (`exitProbeFailed` there too); "no exit IP" here would have
                // read like a test that measured nothing at all.
                <span
                  data-component="profile-row-exit-probe-failed"
                  className="italic text-ink-muted"
                  title={EXIT_GEO_UNAVAILABLE_TITLE}
                >
                  {EXIT_GEO_UNAVAILABLE_SHORT}
                </span>
              ) : (
                <span className="text-ink-muted">{r.probed ? 'no exit IP' : 'untested'}</span>
              )}
              <button
                type="button"
                className="ml-1 shrink-0 rounded bg-surface-elevated px-1.5 py-0.5 text-[10px] font-medium text-ink-secondary hover:bg-surface-divider hover:text-ink-primary disabled:opacity-50"
                onClick={stop(() => p.onTest(r.id))}
                disabled={r.testDisabled}
                // (n) N18 — a tunnel's check is not a SOCKS5 reachability probe,
                // and it has ONE name on every surface (proxy-check-copy).
                title={
                  r.vpn === true ? CHECK_VPN_TITLE : 'Test proxy — reachability, latency, exit IP'
                }
              >
                {r.testing ? '…' : r.vpn === true ? CHECK_VPN_ACTION : 'Test'}
              </button>
            </div>
            {/* (n) N18 — the fleet's verdict for this tunnel, on the row that
                shows it. A failure is the red sentence the card banners; a
                not-run is muted, because nothing failed — it was not tested. */}
            {r.vpn === true && r.vpnFailure !== undefined && (
              <div
                data-component="profile-row-vpn-failure"
                className="text-[10px] font-medium text-status-error"
                title={r.vpnFailure}
              >
                VPN tunnel down — {r.vpnFailure}
              </div>
            )}
            {r.vpn === true && r.vpnNotice !== undefined && (
              <div
                data-component="profile-row-vpn-notice"
                className="text-[10px] text-ink-muted"
                title={r.vpnNotice}
              >
                {r.vpnNotice}
              </div>
            )}
            {r.vpn === true && r.checkedAtIso != null && r.checkedAtIso !== '' && (
              <div
                data-component="profile-row-checked-at"
                data-checked-at={r.checkedAtIso}
                className="flex items-center gap-1 text-[10px] text-ink-muted"
              >
                <span className="uppercase tracking-wide">checked</span>
                <RelativeTime iso={r.checkedAtIso} tooltipPrefix="Checked" />
              </div>
            )}
            <div className="flex items-center gap-2 text-[10px] text-ink-muted">
              {r.locationLabel !== null && <span className="truncate">{r.locationLabel}</span>}
              {r.latencyMs !== null && (
                <span
                  className={`mono ${r.latencyMs <= 100 ? '' : 'text-status-busy'}`}
                  title={
                    r.latencyFromServer === true
                      ? 'Measured from the fleet that runs the profile'
                      : 'Measured from this Mac'
                  }
                >
                  {r.latencyMs}ms
                </span>
              )}
            </div>
          </div>
        ) : (
          <span className="text-ink-muted">no proxy</span>
        )}
      </td>
      {/* UDP (collapses below md) */}
      <td className={`px-3 py-2 ${HIDE_MED}`}>
        {r.vpn === true ? (
          // (n) N18 — nothing probes a UDP grant on a tunnel: UDP rides inside
          // it. The card's chip has said so since (h); the list showed a dash,
          // which reads as "not measured" for something that is not measurable.
          <span
            data-udp="tunnel"
            className="inline-block cursor-help rounded bg-surface-divider/60 px-1.5 py-0.5 text-[10px] font-bold text-ink-muted"
            title={`UDP travels inside the VPN tunnel — not a probed grant. WebRTC and QUIC use the tunnel’s own UDP; run ${CHECK_VPN_ACTION} to measure QUIC through it.`}
          >
            UDP via tunnel
          </span>
        ) : r.udp === 'unknown' ? (
          <span className="text-ink-muted">–</span>
        ) : (
          <span
            className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-bold ${
              r.udp === 'ok'
                ? 'bg-status-ready/20 text-status-ready'
                : 'bg-surface-divider/60 text-ink-muted'
            }`}
            title={
              r.udp === 'ok'
                ? `UDP relay verified — WebRTC ✓; ${QUIC_CLAUSE[r.quic ?? 'unknown']}`
                : 'No UDP relay — WebRTC/QUIC fall back to TCP'
            }
          >
            {r.udp === 'ok' ? '✓' : '⤵'}
          </span>
        )}
      </td>
      {/* Created */}
      <td className={`whitespace-nowrap px-3 py-2 text-ink-muted ${HIDE_SMALL}`}>
        {r.createdAtIso !== null ? (
          <RelativeTime iso={r.createdAtIso} tooltipPrefix="Created" />
        ) : (
          '—'
        )}
      </td>
      {/* Last used */}
      <td className={`whitespace-nowrap px-3 py-2 text-ink-muted ${HIDE_SMALL}`}>
        {r.lastUsedIso !== null ? (
          <RelativeTime iso={r.lastUsedIso} tooltipPrefix="Last used" />
        ) : (
          'never'
        )}
      </td>
      {/* Storage — per-profile sealed-store size ("—" = never saved). */}
      <td
        className={`mono whitespace-nowrap px-3 py-2 text-right text-ink-muted ${HIDE_SMALL}`}
        title="Stored profile size (encrypted browser state)"
      >
        {r.sizeLabel}
      </td>
      {/* Notes — click to edit inline (founder batch #2 "Add note"). T-19 — the
          CELL no longer stops propagation: it swallowed every click across the
          whole column, so the row's real select target was narrower than the row
          it painted. Only the open editor and the two buttons stop. The stop
          sits on the editor's WRAPPER (input, "Saving…", error text) — the same
          container stop the card's note overlay uses — because a click on the
          text beside the input blurs it (commits the note) and, with only the
          input stopped, ALSO reached the row and flipped selection in one
          gesture. A click beside the note still selects the row like anywhere
          else. */}
      <td className={`px-3 py-2 ${HIDE_SMALL}`}>
        {editingNote ? (
          <div
            aria-busy={noteSaving}
            className="flex max-w-[16rem] flex-col gap-1"
            onClick={(e) => e.stopPropagation()}
          >
            <input
              autoFocus
              aria-label={`Note for ${r.name}`}
              value={noteDraft}
              disabled={noteSaving}
              maxLength={280}
              placeholder="Add a note…"
              onChange={(e) => setNoteDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void commitNote();
                else if (e.key === 'Escape' && !noteSaving) {
                  setNoteDraft(r.note);
                  setNoteError(null);
                  setEditingNote(false);
                }
              }}
              onBlur={() => void commitNote()}
              className="w-full rounded border border-surface-divider bg-surface-inset px-1.5 py-0.5 text-xs text-ink-primary placeholder:text-ink-muted focus:border-accent focus:outline-none disabled:opacity-60"
            />
            {noteSaving ? <span className="text-[10px] text-ink-muted">Saving…</span> : null}
            {noteError !== null ? (
              <span role="alert" className="text-[10px] text-status-error">
                {noteError}
              </span>
            ) : null}
          </div>
        ) : r.note.trim() !== '' ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setNoteDraft(r.note);
              setNoteError(null);
              setEditingNote(true);
            }}
            className="block max-w-[16rem] truncate text-left text-ink-secondary hover:text-ink-primary"
            title="Click to edit note"
          >
            {r.note}
          </button>
        ) : (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setNoteDraft('');
              setNoteError(null);
              setEditingNote(true);
            }}
            className="text-ink-muted transition-colors hover:text-ink-primary"
            title="Add a note"
          >
            + note
          </button>
        )}
      </td>
      {/* Actions */}
      <td className="whitespace-nowrap px-3 py-2 text-right">
        <div className="inline-flex items-center gap-1.5">
          {r.running ? (
            <>
              <button
                type="button"
                className="rounded bg-surface-elevated px-2 py-1 text-[11px] font-medium text-ink-primary hover:bg-surface-divider disabled:opacity-50"
                onClick={stop(() => p.onWatch(r.id))}
                disabled={r.busy}
                // Phase C (C9) — the grid card's dock says 'Open session' for
                // the same handler on the same running profile; the list said
                // 'Live view'. One word for one action on both surfaces.
                title="Open the running session"
              >
                Open session
              </button>
              <button
                type="button"
                className="rounded border border-status-error/40 bg-status-error/10 px-2 py-1 text-[11px] font-medium text-status-error hover:bg-status-error/20 disabled:opacity-50"
                onClick={stop(() => p.onStop(r.id))}
                disabled={r.busy}
              >
                {r.busy ? 'Stopping…' : 'Stop'}
              </button>
            </>
          ) : (
            <button
              type="button"
              className="rounded bg-accent px-2 py-1 text-[11px] font-semibold text-white hover:bg-accent-hover disabled:opacity-50"
              onClick={stop(() => p.onPrimary(r.id))}
              disabled={r.busy || r.launchDisabled}
              aria-busy={r.launching}
              title={r.launchDisabled ? r.launchDisabledReason : undefined}
            >
              {r.launching ? (
                <span className="inline-flex items-center justify-center gap-1.5">
                  <span
                    aria-hidden="true"
                    data-component="launch-spinner"
                    className="h-3 w-3 animate-spin rounded-full border-2 border-white/35 border-t-white"
                  />
                  Launching…
                </span>
              ) : (
                'Launch'
              )}
            </button>
          )}
          <button
            type="button"
            className="text-[11px] text-ink-muted hover:text-ink-primary disabled:opacity-50"
            onClick={stop(() => p.onEdit(r.id))}
            disabled={r.busy}
          >
            Edit
          </button>
          {p.onClone && (
            <button
              type="button"
              className="text-[11px] text-ink-muted hover:text-ink-primary disabled:opacity-50"
              onClick={stop(() => p.onClone?.(r.id))}
              disabled={r.busy || p.cloneDisabled || otherBusy}
              title={
                p.cloneDisabled ? p.cloneDisabledReason : otherBusy ? OTHER_BUSY_HINT : undefined
              }
            >
              Duplicate
            </button>
          )}
          {/* doc-150 §8 — Trim: clear re-fetchable caches, keep logins. */}
          <button
            type="button"
            className="text-[11px] text-ink-muted hover:text-ink-primary disabled:opacity-50"
            onClick={stop(() => p.onTrim(r.id))}
            disabled={r.busy || otherBusy}
            title={otherBusy ? OTHER_BUSY_HINT : 'Clear cache, keep logins'}
          >
            Trim
          </button>
          <button
            type="button"
            className="text-[11px] text-ink-muted hover:text-status-error disabled:opacity-50"
            onClick={stop(() => p.onDelete(r.id))}
            disabled={r.busy || r.running || otherBusy}
            title={
              r.running
                ? 'Stop the profile before deleting'
                : otherBusy
                  ? OTHER_BUSY_HINT
                  : undefined
            }
          >
            Delete
          </button>
        </div>
      </td>
    </tr>
  );
}

/** Worktimer — compact elapsed since an ISO start ("12s" / "4m" / "1h 2m" /
 *  "2d 3h"). Recomputed on each render; the parent's poll re-renders it.
 *  Phase B (2026-09-11) — exported: the grid card's "when" row renders the same
 *  `running 12m` from the same function, so the two views cannot count
 *  differently for the same session. (p) D2 — named for what it prints: the
 *  simulator's `formatStopwatch(elapsedMs)` (LiveElapsed) takes a duration and
 *  prints "M:SS"; this takes a start instant and prints "12m" / "1h 2m". */
export function formatRunningFor(startIso: string): string {
  const start = new Date(startIso).getTime();
  if (Number.isNaN(start)) return '';
  const sec = Math.max(0, Math.floor((Date.now() - start) / 1000));
  if (sec < 60) return `${sec.toString()}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min.toString()}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr.toString()}h ${(min % 60).toString()}m`;
  return `${Math.floor(hr / 24).toString()}d ${(hr % 24).toString()}h`;
}

function SortCaret({ active, dir }: { active: boolean; dir: 'asc' | 'desc' }): JSX.Element {
  if (!active) return <span className="text-ink-muted/40">↕</span>;
  return <span className="text-accent">{dir === 'asc' ? '↑' : '↓'}</span>;
}
