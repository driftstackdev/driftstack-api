// V-261 — shared TitleBar component for the GUI client.
//
// Replaces the two duplicated TitleBar functions previously inlined in
// `App.tsx` and `views/FirstRunWizard.tsx`. Single source of truth for:
//   - the brand mark (proper inline D-badge SVG, not a flat colour box)
//   - macOS traffic-light clearance (titleBarStyle: 'Overlay' in
//     tauri.conf.json puts the close/min/max buttons over the top-left
//     of the window; without left padding the in-app title text sits
//     under them)
//   - drag region (`data-tauri-drag-region` makes the bar a draggable
//     handle for window movement)
//
// Subtitle is optional; right-side slot is for version label / status
// pills / similar small chrome.

import type { ReactNode } from 'react';

// macOS traffic-light cluster sits 12px from the left edge, ~14px wide
// per pip, ~8px between pips → cluster spans ~12 + 14*3 + 8*2 = 70px.
// Plus a 12px right-margin before our content starts: ~82px. Round up
// to pl-24 (96px) for headroom against retina-rendering rounding and
// future macOS chrome changes. pl-20 (80px) was tight and the user
// reported the lights overlapping the "driftstack" wordmark.
//
// Detection: navigator.platform is deprecated and returns inconsistent
// values on newer macOS WebKit (sometimes 'MacIntel', sometimes empty
// in privacy-restricted contexts). Fall back to userAgent regex so the
// detection works across Big Sur / Monterey / Ventura / Sonoma / Sequoia.
const isMac =
  typeof navigator !== 'undefined' &&
  (navigator.platform.startsWith('Mac') || /Mac OS X|Macintosh/.test(navigator.userAgent));

interface Props {
  subtitle?: string;
  right?: ReactNode;
}

export function TitleBar({ subtitle, right }: Props): JSX.Element {
  return (
    <div
      data-tauri-drag-region="true"
      className={`flex h-9 select-none items-center justify-between border-b border-surface-divider bg-surface-raised pr-3 ${
        isMac ? 'pl-24' : 'pl-3'
      }`}
    >
      <div className="flex items-center gap-2" data-tauri-drag-region="true">
        <DBadge />
        <span className="text-sm font-medium text-ink-primary">driftstack</span>
        {subtitle ? (
          <>
            <span className="mono text-ink-muted">·</span>
            <span className="mono text-ink-secondary">{subtitle}</span>
          </>
        ) : null}
      </div>
      {right ? <div className="flex items-center gap-2 text-ink-muted">{right}</div> : null}
    </div>
  );
}

// 2026-05-20 — DBadge re-tinted to a near-black rounded-square with a
// glow-red "D" per founder feedback (the earlier oxblood-on-white
// felt washed out + clashed with the surface-raised title-bar fill).
// #0b0f14 matches surface-base from globals.css so the badge reads
// as one continuous element with the dark chrome; #e23847 is the
// marketing site's glow-red CTA colour for visual continuity.
function DBadge(): JSX.Element {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 64 64"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <rect width="64" height="64" rx="12" fill="#0b0f14" />
      <text
        x="32"
        y="42"
        textAnchor="middle"
        fill="#e23847"
        fontFamily="Georgia,serif"
        fontSize="34"
        fontWeight="700"
      >
        D
      </text>
    </svg>
  );
}
