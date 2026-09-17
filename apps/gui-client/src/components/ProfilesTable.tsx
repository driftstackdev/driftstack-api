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
import { ProxyOsChip, agedChipAge } from './ProxyCapabilities';
import {
  agedOsFingerprintVerdict,
  agedReadingHint,
  type OsFingerprint,
  type OsVerdict,
} from '../lib/os-fingerprint-verdict';
import type { AgedReading, AgedRowReadings } from '../lib/proxy-probe-cache';
import {
  CHECK_VPN_ACTION,
  CHECK_VPN_TITLE,
  ENDPOINT_UNRESOLVED,
  ENDPOINT_UNRESOLVED_EXIT_TITLE,
  EXIT_GEO_UNAVAILABLE_SHORT,
  EXIT_GEO_UNAVAILABLE_TITLE,
  VPN_NO_EXIT_YET,
  VPN_NO_EXIT_YET_TITLE,
  VPN_UDP_MEASURED_NONE_TITLE,
  VPN_UDP_MEASURED_OK_TITLE,
  VPN_UDP_NOT_MEASURED_TITLE,
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
   *  tooltip, so the list never claims "QUIC ✓" while the card shows "~".
   *  'aged' — nothing CURRENT was measured, but a Test did measure it more than
   *  thirty minutes ago: the tooltip then prints `quicAgedHint` (the card's QUIC
   *  chip's own sentence, age first) instead of "not yet measured", which is
   *  false of a proxy the customer tested this morning. */
  quic?: 'ok' | 'inferred' | 'fail' | 'unknown' | 'aged';
  /** The aged QUIC reading's sentence — `proxyCapabilities`' hint for the same
   *  cap the card renders, so the list and the card say one thing. Only read
   *  beside `quic: 'aged'`. */
  quicAgedHint?: string;
  /** The bound proxy's AGED readings, the SAME slice the grid card takes
   *  (`agedReadingsFor(probeView.aged, px.id)`). This table reads two of them,
   *  each only where the current value beside it is absent: the OS reading (the
   *  chip below would otherwise VANISH thirty minutes after every Test — a cell
   *  that shows nothing is what "never measured" looks like here) and a VPN
   *  row's UDP reading. Display only; the sort and the actions never read it. */
  aged?: AgedRowReadings;
  /** Whether the app will re-take an aged reading by itself, asked of the
   *  automatic check's own planner. ⛔ Absent = FALSE: the hover names the
   *  button rather than promising a recheck that may never come. */
  autoRecheck?: boolean;
  /** C4 (2026-09-12) — the bound proxy's passive OS fingerprint, the SAME value
   *  the grid card takes (`probeView.osFingerprints[px.id]`, ProfilesView). The
   *  owner, on the release that shipped the card's OS chip: *"i dont see OS
   *  currently at profile grid either"* — and this row had no such field at all,
   *  so the list could not show one however the grid was fixed. Absent = this
   *  client holds no reading; the cell then shows a chip ONLY where an absence
   *  is a FACT it can state (a VPN tunnel, whose cause the control plane reports
   *  for every ovpn/wg row — apps/server/src/routes/account-me.ts, the
   *  `os_fingerprint_unavailable: 'vpn_tunnel'` arm). ⛔ It must never render the
   *  '—' placeholder for a row that simply was not passed a value: on this
   *  surface that would read as "measured: nothing", which is a claim, and it
   *  would be false for every proxy that HAS a reading. */
  osFingerprint?: OsFingerprint;
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
  /** Reference moment for an aged reading's age; injected by tests so the
   *  rendered output is deterministic. Production passes nothing. */
  nowMs?: number;
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
const QUIC_CLAUSE: Record<Exclude<NonNullable<ProfileTableRow['quic']>, 'aged'>, string> = {
  ok: 'QUIC ✓',
  inferred: 'QUIC likely (not yet measured)',
  fail: 'QUIC ✗ (HTTP/2 on last measure)',
  unknown: 'QUIC not tested',
};

/** How an aged reading looks in this table: the recessed ground of a non-verdict
 *  and a dashed edge no current chip has (the grid card's CHIP_AGED_CLASS). ⛔ An
 *  OUTLINE drawn inside the box, not the border the Proxies tab's AGED_CHIP_CLASS
 *  uses: a border is 2px of layout, and this column has none to give (see
 *  AgedOsCellChip). */
const AGED_CELL_CHIP_CLASS =
  'bg-surface-inset text-ink-muted outline-dashed outline-1 -outline-offset-1 outline-ink-muted/60';

/**
 * The verdict of an aged OS reading ON THIS ROW — `agedOsFingerprintVerdict`,
 * with the hover naming the button the row actually has. Shared with the grid
 * card, which imports it from here (the card already depends on this file).
 *
 * ⛔ The shared verdict words its hint with `agedReadingHint`'s DEFAULT action, so
 * on a VPN row it said "Run Test to check it again" beside two chips that said
 * "Run Check VPN" — and a VPN row has no Test button, which is the defect that
 * function's own `manualAction` parameter exists to prevent. The shared verdict
 * takes no such parameter, so the row's sentence is swapped in here, by PREFIX:
 * if the hint ever stops leading with that sentence the swap does nothing and
 * the shared wording stands, rather than a second sentence being bolted on.
 * (Nothing to swap when the recheck is automatic — that sentence names no
 * button — or on a cause / the in-flight sentinel, which do not age.)
 */
export function agedOsVerdictFor(
  aged: AgedReading<OsFingerprint>,
  nowMs: number,
  autoRecheck: boolean,
  vpn: boolean,
): OsVerdict {
  const v = agedOsFingerprintVerdict(aged.value, aged.atMs, nowMs, autoRecheck);
  const shared = agedReadingHint(aged.atMs, nowMs, autoRecheck);
  if (!vpn || v.aged !== true || !v.hint.startsWith(shared)) return v;
  return {
    ...v,
    hint: `${agedReadingHint(aged.atMs, nowMs, autoRecheck, CHECK_VPN_ACTION)}${v.hint.slice(shared.length)}`,
  };
}

/**
 * The OS cell's AGED chip: what the last Test read, a while ago — the glyph and
 * the label of that reading, muted and dashed, never in a verdict's colour
 * (`agedOsFingerprintVerdict` gives up the tone for exactly that reason).
 *
 * ⛔ NOT the shared ProxyOsChip, which prints the age beside the label, and the
 * reason is MEASURED, not assumed (2026-09-17, live harness, this table mounted
 * at the `profiles-list` composition's 1526px): a current '✓ iOS/macOS' is
 * 73.34px; '✓ iOS/macOS · 59 min ago' is 136.17px and widens the table by 62px
 * more than the current chip does — horizontal scroll, for every customer,
 * thirty minutes after any Test. No dated form fits the current chip's width
 * either (that reading's shortest, '✓ Apple · 23 h', is 76.98px, and it gives up
 * the full label to get there). So an aged chip here is EXACTLY as wide as the current
 * one it stands in for (the dashed edge is an outline, so not even 2px wider),
 * and the age is printed on a line of its OWN beneath the chips, where it costs
 * the column nothing: the UDP column measured 119.05px with that line and
 * 119.05px without it.
 */
function AgedOsCellChip({
  aged,
  autoRecheck,
  nowMs,
  vpn,
}: {
  aged: AgedReading<OsFingerprint>;
  autoRecheck: boolean;
  nowMs: number;
  vpn: boolean;
}): JSX.Element | null {
  // The card's verdict for the same reading: a VPN row's hover names Check VPN,
  // the button that row has, where the shared one says Test.
  const v = agedOsVerdictFor(aged, nowMs, autoRecheck, vpn);
  // A cause or the in-flight sentinel is not a reading and does not age; this
  // cell never paints a placeholder for a row that holds no reading.
  if (v.aged !== true) return null;
  return (
    <span
      title={v.hint}
      data-component="proxy-os-fingerprint"
      data-os-tone={v.tone}
      data-ok="aged"
      className={`inline-flex cursor-help items-center gap-0.5 whitespace-nowrap rounded-sm px-1 py-px text-[10px] ${AGED_CELL_CHIP_CLASS}`}
    >
      <span aria-hidden="true">{v.glyph}</span>
      {v.label}
    </span>
  );
}

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
  // The aged readings this row may show — the card's rule and the Proxies tab's:
  // never while a test is running (the answer is on its way) and never beside a
  // failure sentence, where a dated tick would read as a second opinion.
  const aged = r.vpnFailure === undefined && !r.testing ? r.aged : undefined;
  const agedNowMs = p.nowMs ?? Date.now();
  const agedUdp = r.vpn === true && r.udp === 'unknown' ? aged?.udpProbe : undefined;
  const agedOs = r.osFingerprint === undefined ? aged?.osFingerprint : undefined;
  // The age the cell PRINTS under its dashed chips. One line for the cell, so
  // when its two aged chips were read at different moments it states the OLDER:
  // "as of" is then true of both, and each hover still leads with its own age.
  // ⛔ Only a chip that really renders counts — an aged OS value that is a cause
  // or the in-flight sentinel paints nothing (AgedOsCellChip), and a date under
  // an empty cell would be the age of nothing.
  const agedOsShown =
    agedOs !== undefined &&
    agedOsVerdictFor(agedOs, agedNowMs, r.autoRecheck === true, r.vpn === true).aged === true;
  const agedShownAt = [agedUdp?.atMs, agedOsShown ? agedOs.atMs : undefined].filter(
    (at): at is number => at !== undefined,
  );
  const agedAsOfMs = agedShownAt.length > 0 ? Math.min(...agedShownAt) : undefined;
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
                // Contrast (2026-09-12): the accent AS 10px TEXT is the mode-aware
                // token (dark: the accent itself measured 2.37 on the raised
                // surface); the hue is unchanged.
                className="mt-0.5 text-[10px] font-medium text-accent-text"
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
                  r.vpn === true
                    ? CHECK_VPN_TITLE
                    : 'Test proxy — connection, response time, exit IP'
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
                      ? 'Measured by Driftstack'
                      : 'Measured from this computer'
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
      {/* UDP + OS (collapses below md) */}
      <td className={`px-3 py-2 ${HIDE_MED}`}>
        <div className="flex items-center gap-1">
          {agedUdp !== undefined ? (
            // Nothing current, but this tunnel's UDP WAS measured a while ago. The
            // pill below says "not measured", which is false of it; this states
            // what was found, muted and dashed like every aged chip — never the
            // green of a current verdict — and its hover leads with the age.
            <span
              data-udp="aged"
              data-ok="aged"
              data-aged-value={agedUdp.value ? 'true' : 'false'}
              className={`inline-flex cursor-help items-center gap-0.5 whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] font-bold ${AGED_CELL_CHIP_CLASS}`}
              title={`${agedReadingHint(agedUdp.atMs, agedNowMs, r.autoRecheck === true, CHECK_VPN_ACTION)} ${
                agedUdp.value
                  ? 'UDP worked through this VPN then.'
                  : 'UDP did not work through this VPN then.'
              }`}
            >
              <span aria-hidden="true">{agedUdp.value ? '✓' : '⤵'}</span>
              UDP
            </span>
          ) : r.vpn === true && r.udp === 'unknown' ? (
            // (n) N18 — nothing probes a UDP grant on a tunnel: UDP rides inside
            // it. The card's chip has said so since (h); the list showed a dash,
            // which reads as "not measured" for something that is not measurable.
            //
            // ⛔ (V6 2026-09-16) ITEM 3 — and it is the NOT-MEASURED arm ONLY now.
            // The node's three-state `udp_associate` is contracted, so "not
            // measurable" stops being true of a tunnel: a VPN row with a MEASURED
            // verdict falls through to the chip below and renders it, green for a
            // relay and muted-⤵ for a measured fall-back. An unconditional pill
            // here would have swallowed that verdict — the row would keep saying
            // "UDP via tunnel" over a tunnel a Mac had just measured as carrying
            // none. The sentence is shared with the grid and the card
            // (`VPN_UDP_NOT_MEASURED_TITLE`), which is the only state it describes.
            <span
              data-udp="tunnel"
              // 2026-09-12 (review) — secondary ink, not muted: muted on the
              // divider/60 wash over the raised row is 3.88:1 in dark (the one
              // profiles-list finding the gate still reported); secondary is 6.71
              // dark / 5.51 light there.
              className="inline-block cursor-help rounded bg-surface-divider/60 px-1.5 py-0.5 text-[10px] font-bold text-ink-secondary"
              title={VPN_UDP_NOT_MEASURED_TITLE}
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
              // (V6 2026-09-16) ITEM 3 — a VPN row reaches this chip only with a
              // MEASURED verdict, and it gets the tunnel's own wording: the SOCKS5
              // sentences talk about an exit and a UDP-ASSOCIATE grant, neither of
              // which exists on a tunnel. Both halves are shared with the grid and
              // the card so one measurement cannot be described three ways.
              title={
                r.vpn === true
                  ? r.udp === 'ok'
                    ? VPN_UDP_MEASURED_OK_TITLE
                    : VPN_UDP_MEASURED_NONE_TITLE
                  : r.udp === 'ok'
                    ? r.quic === 'aged' && r.quicAgedHint !== undefined
                      ? // An aged QUIC reading: its own sentence, age first. "QUIC
                        // likely (not yet measured)" told a customer to test a
                        // proxy they had tested that morning.
                        `UDP works — WebRTC ✓. QUIC — ${r.quicAgedHint}`
                      : `UDP works — WebRTC ✓; ${QUIC_CLAUSE[r.quic === undefined || r.quic === 'aged' ? 'unknown' : r.quic]}`
                    : 'UDP not supported — WebRTC and QUIC fall back to slower connections'
              }
            >
              {r.udp === 'ok' ? '✓' : '⤵'}
            </span>
          )}
          {/* C4 — the OS row the owner could not find, on the surface they read
            beside the grid. Rendered from the SHARED ProxyOsChip so the list and
            the card cannot disagree about what a fingerprint means, and ONLY
            where this client actually holds a reading.
            ⛔ Two things it deliberately does NOT do:
            • it never paints the '—' placeholder for a row that was simply not
              passed a value. On this surface that reads as "measured: nothing",
              which is a claim, and it is false for every proxy that HAS a
              reading — the card can state the absence because the card is
              rendered from a view that always knows; a table cell is not;
            • it does not synthesise the VPN-tunnel cause the card synthesises.
              This cell ALREADY says "UDP via tunnel", with the whole sentence in
              its title, so a second chip repeating "this row is a VPN tunnel"
              buys no fact — and it is not free: it measured +27px on the table
              shell, which overflows the marketing capture's 1526px
              (scripts/marketing-screens.mjs `profiles-list`, verified 2026-09-12
              by running it). The card has a row of its own to spend; this column
              does not.
            ⚠️ WIDTH BUDGET. ProfilesView now DOES pass `osFingerprint` — the
            same `probeView.osFingerprints[px.id]` the card is handed — so this
            cell is live and the owner's "i dont see OS" is no longer true on the
            list. The renderer had shipped without its feed, which is the worst
            of the two halves to ship alone: every row rendered an empty cell and
            nothing anywhere said why.
            ⚠️ AND THE CAPTURE CANNOT TELL YOU IF IT OVERFLOWS. The marketing
            `profiles-list` scene builds its rows directly and carries no
            fingerprint, so the chip never renders there and the shell's measured
            0px of slack at 1526px was never tested against it. The widest chip
            here ('✓ iOS/macOS' at ProxyOsChip `sm`) is 73.34px plus a 4px gap.
            Before widening this cell, or adding a fingerprint to
            MARKETING_TABLE_ROWS, measure the shell in the live harness — the
            capture will pass either way until something actually paints one. */}
          {/* …and an AGED reading, where no current one exists: the chip used to
            vanish thirty minutes after every Test, and an empty cell is exactly
            what a never-measured proxy shows. Still nothing at all for a row with
            no reading of either kind — the rule above is unchanged. */}
          {r.osFingerprint !== undefined ? (
            <ProxyOsChip fingerprint={r.osFingerprint} />
          ) : agedOs !== undefined ? (
            <AgedOsCellChip
              aged={agedOs}
              autoRecheck={r.autoRecheck === true}
              nowMs={agedNowMs}
              vpn={r.vpn === true}
            />
          ) : null}
        </div>
        {/* The age of the dashed chips above, on a line of its own: beside the
          label it scrolls the whole table sideways (see AgedOsCellChip). Under
          the chips it is free — 'as of 59 min ago', the widest it prints,
          measured 80.48px, narrower than the '✓' + '✓ iOS/macOS' pair a current
          row already lays out above it (99px) and than the 'UDP via tunnel' pill
          an aged VPN chip replaces (87.13px) — and it adds no height either: the
          Exit IP cell beside it is two lines tall already (a row with the
          line and a current row without it both measured 55px). */}
        {agedAsOfMs !== undefined ? (
          <div
            data-component="aged-reading-age"
            className="mt-0.5 whitespace-nowrap text-[10px] leading-[14px] text-ink-muted"
          >
            as of {agedChipAge(agedAsOfMs, agedNowMs)}
          </div>
        ) : null}
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
              className="rounded bg-accent px-2 py-1 text-[11px] font-semibold text-white hover:bg-accent-fill-hover disabled:opacity-50"
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
