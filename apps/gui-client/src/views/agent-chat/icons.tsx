// The AI view's inline icons.
//
// Stage 0 of the AI-view rebuild (spec §9): lifted out of AgentChatView.tsx with
// the markup UNCHANGED — same viewBox, same sizes, same stroke, same
// aria-hidden. Nothing here reads state; they are drawings, and keeping them in
// one file is what lets the view files below be read in one screen.

export function IconPhone(): JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="4.25" y="1.75" width="7.5" height="12.5" rx="1.6" />
      <path d="M7 3.25h2" />
    </svg>
  );
}

export function IconSparkle(): JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M8 1.75 9.4 5.6 13.25 7 9.4 8.4 8 12.25 6.6 8.4 2.75 7 6.6 5.6Z" />
      <path d="M12.75 11.25v2.5M11.5 12.5h2.5" />
    </svg>
  );
}

// ─── stage 2: the conversation column's icon set ───────────────────────────
//
// Every one is `aria-hidden` and sized by its container's font-size (the
// `.ai-i` rule is `width: 1em; height: 1em`), so a row, a chip and a card can
// share one drawing at three sizes without three copies of it. They carry NO
// text: the live plan's `li` textContent is pinned to exactly `'▶ ' + label`,
// and an icon with a `<title>` in it would break that.

function Glyph({ d, fill = false }: { d: string; fill?: boolean }): JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      className="ai-i"
      fill={fill ? 'currentColor' : 'none'}
      stroke={fill ? 'none' : 'currentColor'}
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={d} />
    </svg>
  );
}

export function IconCheck(): JSX.Element {
  return <Glyph d="M3.25 8.4 6.4 11.5 12.75 4.9" />;
}

export function IconX(): JSX.Element {
  return <Glyph d="M4.4 4.4 11.6 11.6 M11.6 4.4 4.4 11.6" />;
}

export function IconPause(): JSX.Element {
  return <Glyph d="M6.1 3.6v8.8 M9.9 3.6v8.8" />;
}

/** navigate — an arrow leaving the corner. */
export function IconGo(): JSX.Element {
  return <Glyph d="M5.2 10.8 10.8 5.2 M6.2 5.2h4.6v4.6" />;
}

/** tap — a target with a centre. */
export function IconTap(): JSX.Element {
  return (
    <Glyph d="M8 2.6a5.4 5.4 0 1 0 0 10.8A5.4 5.4 0 0 0 8 2.6Z M8 6.4a1.6 1.6 0 1 0 0 3.2 1.6 1.6 0 0 0 0-3.2Z" />
  );
}

/** type — an I-beam. */
export function IconType(): JSX.Element {
  return <Glyph d="M8 3.4v9.2 M5.6 3.4h4.8 M5.6 12.6h4.8" />;
}

/** scroll / swipe — up and down. */
export function IconScroll(): JSX.Element {
  return <Glyph d="M8 3v10 M5.2 5.8 8 3l2.8 2.8 M5.2 10.2 8 13l2.8-2.8" />;
}

/** press — a return key. */
export function IconEnter(): JSX.Element {
  return <Glyph d="M12.8 4.2v3.6a1.6 1.6 0 0 1-1.6 1.6H3.9 M6.4 6.5 3.6 9.4l2.8 2.9" />;
}

/** wait — a clock. */
export function IconClock(): JSX.Element {
  return <Glyph d="M8 2.6a5.4 5.4 0 1 0 0 10.8A5.4 5.4 0 0 0 8 2.6Z M8 5.3V8l2 1.5" />;
}

/** capture — a camera. */
export function IconCamera(): JSX.Element {
  return (
    <Glyph d="M2.4 6.1A1.5 1.5 0 0 1 3.9 4.6h1.3l.9-1.4h3.8l.9 1.4h1.3a1.5 1.5 0 0 1 1.5 1.5v5.3a1.5 1.5 0 0 1-1.5 1.5H3.9a1.5 1.5 0 0 1-1.5-1.5Z M8 6.7a2.2 2.2 0 1 0 0 4.4 2.2 2.2 0 0 0 0-4.4Z" />
  );
}

/** read — an eye. */
export function IconEye(): JSX.Element {
  return (
    <Glyph d="M1.8 8S4.3 3.9 8 3.9 14.2 8 14.2 8 11.7 12.1 8 12.1 1.8 8 1.8 8Z M8 6.2a1.8 1.8 0 1 0 0 3.6 1.8 1.8 0 0 0 0-3.6Z" />
  );
}

/** an unknown step kind — a hollow node, never a guess at what it did. */
export function IconDot(): JSX.Element {
  return <Glyph d="M8 5.7a2.3 2.3 0 1 0 0 4.6 2.3 2.3 0 0 0 0-4.6Z" />;
}

export function IconCopy(): JSX.Element {
  return (
    <Glyph d="M5.6 5.6V3.9a1.3 1.3 0 0 1 1.3-1.3h5.2a1.3 1.3 0 0 1 1.3 1.3v5.2a1.3 1.3 0 0 1-1.3 1.3h-1.7 M3.9 5.6h5.2a1.3 1.3 0 0 1 1.3 1.3v5.2a1.3 1.3 0 0 1-1.3 1.3H3.9a1.3 1.3 0 0 1-1.3-1.3V6.9a1.3 1.3 0 0 1 1.3-1.3Z" />
  );
}

export function IconExpand(): JSX.Element {
  return <Glyph d="M6.2 2.9H2.9v3.3 M9.8 2.9h3.3v3.3 M6.2 13.1H2.9V9.8 M9.8 13.1h3.3V9.8" />;
}

/** continue from here — an arrow that comes back around. */
export function IconRedo(): JSX.Element {
  return <Glyph d="M13 8a5 5 0 1 1-1.5-3.6 M13.1 2.7v3.2H9.9" />;
}

export function IconKey(): JSX.Element {
  return (
    <Glyph d="M9.8 2.9a3.3 3.3 0 1 0 2.5 5.5l.9.9 1.3-1.3-.9-.9A3.3 3.3 0 0 0 9.8 2.9Z M8 7.5 2.6 12.9v1.5h1.5l.7-.7v-1.2h1.2l.8-.8" />
  );
}

export function IconGlobe(): JSX.Element {
  return (
    <Glyph d="M8 2.4a5.6 5.6 0 1 0 0 11.2A5.6 5.6 0 0 0 8 2.4Z M2.6 8h10.8 M8 2.4c1.5 1.6 2.3 3.6 2.3 5.6S9.5 12 8 13.6C6.5 12 5.7 10 5.7 8S6.5 4 8 2.4Z" />
  );
}

export function IconSearch(): JSX.Element {
  return <Glyph d="M7.2 2.9a4.3 4.3 0 1 0 0 8.6 4.3 4.3 0 0 0 0-8.6Z M10.4 10.4 13.4 13.4" />;
}

export function IconCart(): JSX.Element {
  return (
    <Glyph d="M2.3 2.9h1.8l1.6 7.2h6l1.5-5.1H5 M6.6 13a.9.9 0 1 0 0-1.8.9.9 0 0 0 0 1.8Z M11.3 13a.9.9 0 1 0 0-1.8.9.9 0 0 0 0 1.8Z" />
  );
}

export function IconEmpty(): JSX.Element {
  return <Glyph d="M8 2.6a5.4 5.4 0 1 0 0 10.8A5.4 5.4 0 0 0 8 2.6Z" />;
}

// ─── stage 5: the trust moment and the composer ────────────────────────────
//
// Two more drawings, both `aria-hidden`, both sized by their container. The
// shield sits in the approval card's header tile; the square is the Stop
// button's mark. The Stop button's accessible name is pinned to exactly "Stop"
// (`/^stop$/i`), so this icon carries no text and no `<title>` — an icon inside
// a named button is a drawing, never a second word.

export function IconShield(): JSX.Element {
  return (
    <Glyph d="M8 2.1 3.2 4.2v3.5c0 3 2 5.4 4.8 6.2 2.8-.8 4.8-3.2 4.8-6.2V4.2Z M5.9 8.1 7.4 9.6l2.8-3" />
  );
}

export function IconStop(): JSX.Element {
  return <Glyph d="M4.4 4.4h7.2v7.2H4.4Z" fill />;
}

// ─── stage 6: the bar and the rail ─────────────────────────────────────────
//
// Four more drawings, all `aria-hidden`, all sized by their container. The lock
// marks a picker that this chat has settled; the bookmark sits inside the
// "Save as task" button; the plus and the history dial are the 44px strip's two
// buttons at the narrow tier, where the label beside them is visually hidden
// and the accessible name is carried by `aria-label` instead. None carries a
// `<title>`: an icon inside a named button is a drawing, never a second word.

export function IconLock(): JSX.Element {
  return <Glyph d="M4.6 7.2h6.8v6H4.6Z M6.1 7.2V5.4a1.9 1.9 0 0 1 3.8 0v1.8" />;
}

export function IconBookmark(): JSX.Element {
  return <Glyph d="M4.3 2.9h7.4v10.4L8 10.6l-3.7 2.7Z" />;
}

export function IconPlus(): JSX.Element {
  return <Glyph d="M8 4.1v7.8 M4.1 8h7.8" />;
}

export function IconHistory(): JSX.Element {
  return <Glyph d="M3 8a5 5 0 1 0 1.5-3.6 M2.9 2.7v3.2h3.2 M8 5.4V8l1.9 1.4" />;
}

// ─── stage 4: the stage ────────────────────────────────────────────────────
//
// Two more drawings, both `aria-hidden`, both sized by their container. The pin
// marks WHERE the phone is browsing from — the one fact under the phone that is
// about the customer's identity rather than about the task. The screen is the
// mark on the live-view toggle, whose accessible name is the pinned
// `Toggle live view`; the drawing carries no text and no `<title>`.

export function IconPin(): JSX.Element {
  return (
    <Glyph d="M8 1.9a4.4 4.4 0 0 0-4.4 4.4c0 3.3 4.4 7.8 4.4 7.8s4.4-4.5 4.4-7.8A4.4 4.4 0 0 0 8 1.9Z M8 4.8a1.6 1.6 0 1 0 0 3.2 1.6 1.6 0 0 0 0-3.2Z" />
  );
}

export function IconScreen(): JSX.Element {
  return <Glyph d="M4.6 1.9h6.8v12.2H4.6Z M6.9 3.4h2.2" />;
}

/** Three rising bars — the frame-rate chip's mark, as the mockup draws it. A
 *  drawing of "a signal is arriving", never a measurement of one: the number
 *  beside it is the measurement, and the bars do not move with it. */
export function IconSignal(): JSX.Element {
  return <Glyph d="M3.4 9.9v3.2 M8 6.6v6.5 M12.6 3.3v9.8" />;
}
