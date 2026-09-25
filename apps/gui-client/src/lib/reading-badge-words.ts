// Owner item 9 (2026-09-24, verbatim): "they should all always show accurate
// stats" — and, gui-v0.1.72's release check found, they did not all say it in
// the same WORDS. One reading was spelled four ways across the five surfaces
// that show it (the profile card, its details sheet, the profiles list, the
// Proxies tab and the Simulator):
//   • the OS badge said "✓ Apple" on a compact card and "✓ iOS/macOS" everywhere
//     else;
//   • the Proxies tab put the mark first ("✓ UDP") while the card and the list put
//     it last ("UDP ✓");
//   • the Simulator said "HTTP/3" where every other surface said "QUIC";
//   • a reading nobody took was "— UDP" in the list, "UDP: not measured yet" in the
//     Simulator, "untested" / "QUIC untested" on the Proxies tab, and nothing at
//     all on the card.
//
// This is the one vocabulary every surface draws from:
//   • ONE WORD per reading: UDP, QUIC, and for the OS the family it read —
//     "Apple" for macOS-or-iOS (the family both members share, and the word the
//     owner uses), never "iOS/macOS" on one surface and "Apple" on another;
//   • ONE ORDER: the mark first, then the word — "✓ QUIC", "⤵ UDP", "— OS";
//   • ONE MISSING STATE: "— <word>" ("— UDP", "— QUIC", "— OS"), with its reason
//     (the plan, a VPN, nothing reported yet) in the hover or after a " · ";
//   • anything more a surface knows is DETAIL after " · " — the Simulator's live
//     HTTP/3 ("✓ QUIC · HTTP/3 live"), an age ("✓ QUIC · 4 h"), a confidence
//     ("✓ Apple · high") — never a different word for the same reading.
// A compact surface may shorten only the WORD, and only to a prefix of it
// ("✗ Win" for "✗ Windows"), with the mark still first.
//
// Import-free on purpose: the card, the list, the Proxies tab and the Simulator
// all reach it, and none of them may drag another's dependencies in to spell a
// word.

/** The word each reading's badge carries. The OS badge carries the OS family it
 *  read (see `OS_WORD`) and falls back to this "OS" only where it read none. */
export const READING_WORD = { udp: 'UDP', quic: 'QUIC', os: 'OS' } as const;
export type Reading = keyof typeof READING_WORD;

/** The marks, one meaning each, on every surface. */
export const READING_MARK = {
  /** Measured, and it works (UDP relays, HTTP/3 works) — or the OS matches. */
  works: '✓',
  /** Measured, and it does not: the traffic falls back. Muted, never red. */
  fallsBack: '⤵',
  /** Not measured — inferred (QUIC is likely because UDP relays). */
  likely: '~',
  /** A VPN tunnel: UDP rides inside it, and nothing measured it. */
  inTunnel: '⇢',
  /** No reading at all. */
  notMeasured: '—',
  /** The OS was measured and does not match the device (the one red state). */
  mismatch: '✗',
  /** The OS was measured and could not be pinned to one family. */
  undetermined: '?',
  /** A test this computer started is reading the OS right now. */
  measuring: '…',
} as const;
export type ReadingMark = (typeof READING_MARK)[keyof typeof READING_MARK];

/** The words an OS reading is badged with — the family, not the wire id. */
export const OS_WORD = {
  'macos-or-ios': 'Apple',
  windows: 'Windows',
  linux: 'Linux',
  bsd: 'BSD',
} as const;

/** What joins a badge to its detail: "✓ QUIC · HTTP/3 live". */
export const DETAIL_SEPARATOR = ' · ';

/** A badge's text: the MARK first, then the word — on every surface. */
export function badgeText(mark: ReadingMark, word: string): string {
  return `${mark} ${word}`;
}

/** A badge with its detail: "✓ QUIC · HTTP/3 live". An empty detail is none. */
export function badgeWithDetail(mark: ReadingMark, word: string, detail: string): string {
  return detail === ''
    ? badgeText(mark, word)
    : `${badgeText(mark, word)}${DETAIL_SEPARATOR}${detail}`;
}

/** The missing state's detail when the account's plan will never measure it. */
export const NOT_ON_PLAN_DETAIL = 'not on plan';

/**
 * ⛔ THE ONE EXCEPTION, stated so it is a decision and not a gap. The profile
 * card's TILE says a missing UDP or QUIC reading with its inline ACTION, not
 * with "— UDP" / "— QUIC", on exactly two of its rows (`capsMode`):
 *   • 'first'  — nothing measured yet: "Test" (a VPN: "Check VPN" / "Check");
 *   • 'repair' — the proxy was down on its last test: "Re-test" + "Change".
 * The row is 144px at the 178px card and the action takes 40–50 of it; "— UDP"
 * (40.22) + "— QUIC" (44.3) + "— OS" (33.33) do not fit the rest, and the
 * overflow would ride a "+N" pill — the thing the owner asked us never to hide
 * a reading behind. The action IS the statement ("nothing measured — run it"),
 * the health pill beside it names the state, and the card's details sheet, one
 * click away, says "— UDP" and "— QUIC" in these words like every other surface.
 * Pinned by every-badge-surface-shows-one-state-for-one-reading.test.tsx.
 */
export const CARD_TILE_STATES_MISSING_BY_ITS_ACTION = ['first', 'repair'] as const;
