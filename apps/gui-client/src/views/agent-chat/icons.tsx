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
