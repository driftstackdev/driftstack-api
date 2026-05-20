// W475.C — drift guard for apps/gui-client/src/components/TitleBar.tsx.
// V-261 shared TitleBar component. Drift here either drops the
// macOS pl-20 traffic-light clearance (in-app title text slides
// under the close/min/max buttons on Mac — looks like a broken
// layout) or breaks the `data-tauri-drag-region` attribute (the
// title bar stops being a draggable window-move handle and the
// frameless window becomes immovable).
//
//   • V-261 framing pinned: 'shared TitleBar component for the GUI
//     client.' + 'Replaces the two duplicated TitleBar functions
//     previously inlined in `App.tsx` and `views/FirstRunWizard.
//     tsx`. Single source of truth for: brand mark (proper inline
//     D-badge SVG, not a flat colour box) / macOS traffic-light
//     clearance (titleBarStyle: 'Overlay' in tauri.conf.json puts
//     the close/min/max buttons over the top-left of the window;
//     without left padding the in-app title text sits under them)
//     / drag region (`data-tauri-drag-region` makes the bar a
//     draggable handle for window movement)'
//   • isMac platform sniff: navigator.platform.startsWith('Mac')
//     with typeof navigator !== 'undefined' guard for SSR safety.
//   • TitleBar root: data-tauri-drag-region + Mac→pl-20 / non-Mac
//     → pl-3 ternary clearance + h-9 + border-b.
//   • DBadge inline SVG: oxblood-700 #722F37 rect rx=12 + white
//     Georgia serif 'D' text — pinned mirrors marketing-site
//     favicon, not a flat colour box.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/gui-client/src/components/TitleBar.tsx');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W475.C apps/gui-client/src/components/TitleBar.tsx content parity', () => {
  const body = read(LIB);

  it("V-261 framing pinned: 'V-261 — shared TitleBar component for the GUI client.' + 'Replaces the two duplicated TitleBar functions previously inlined in `App.tsx` and `views/FirstRunWizard.tsx`. Single source of truth for: brand mark (proper inline D-badge SVG, not a flat colour box) / macOS traffic-light clearance (titleBarStyle: 'Overlay' in tauri.conf.json puts the close/min/max buttons over the top-left of the window; without left padding the in-app title text sits under them) / drag region (`data-tauri-drag-region` makes the bar a draggable handle for window movement)'", () => {
    expect(body).toMatch(/\/\/ V-261 — shared TitleBar component for the GUI client\./);
    expect(body).toMatch(
      /\/\/ Replaces the two duplicated TitleBar functions previously inlined in\s*\n?\s*\/\/ `App\.tsx` and `views\/FirstRunWizard\.tsx`\. Single source of truth for:\s*\n?\s*\/\/\s+- the brand mark \(proper inline D-badge SVG, not a flat colour box\)\s*\n?\s*\/\/\s+- macOS traffic-light clearance \(titleBarStyle: 'Overlay' in\s*\n?\s*\/\/\s+tauri\.conf\.json puts the close\/min\/max buttons over the top-left\s*\n?\s*\/\/\s+of the window; without left padding the in-app title text sits\s*\n?\s*\/\/\s+under them\)\s*\n?\s*\/\/\s+- drag region \(`data-tauri-drag-region` makes the bar a draggable\s*\n?\s*\/\/\s+handle for window movement\)/,
    );
  });

  it("2026-05-20 — isMac sniff widened to navigator.platform.startsWith('Mac') OR /Mac OS X|Macintosh/ regex against userAgent (per the deprecated-platform-fallback explainer comment). Keeps typeof navigator !== 'undefined' SSR guard.", () => {
    expect(body).toMatch(
      /const isMac =\s*\n?\s*typeof navigator !== 'undefined' &&\s*\n?\s*\(navigator\.platform\.startsWith\('Mac'\) \|\| \/Mac OS X\|Macintosh\/\.test\(navigator\.userAgent\)\);/,
    );
  });

  it("2026-05-20 — Mac clearance bumped pl-20→pl-24 (founder reported overlap with the 'driftstack' wordmark; lights span ~70px + 12px right margin → 82px → round up to pl-24 / 96px for retina rounding + future-chrome headroom). Props + drag-region + h-9 + border-b unchanged.", () => {
    expect(body).toMatch(
      /interface Props \{\s*\n?\s*subtitle\?: string;\s*\n?\s*right\?: ReactNode;\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /<div\s*\n?\s*data-tauri-drag-region="true"\s*\n?\s*className=\{`flex h-9 select-none items-center justify-between border-b border-surface-divider bg-surface-raised pr-3 \$\{\s*\n?\s*isMac \? 'pl-24' : 'pl-3'\s*\n?\s*\}`\}\s*\n?\s*>/,
    );
  });

  it("TitleBar inner: nested data-tauri-drag-region on the title group + <DBadge /> + 'driftstack' wordmark + subtitle fragment with mono dot separator + right slot when truthy", () => {
    expect(body).toMatch(
      /<div className="flex items-center gap-2" data-tauri-drag-region="true">\s*\n?\s*<DBadge \/>\s*\n?\s*<span className="text-sm font-medium text-ink-primary">driftstack<\/span>\s*\n?\s*\{subtitle \? \(\s*\n?\s*<>\s*\n?\s*<span className="mono text-ink-muted">·<\/span>\s*\n?\s*<span className="mono text-ink-secondary">\{subtitle\}<\/span>\s*\n?\s*<\/>\s*\n?\s*\) : null\}\s*\n?\s*<\/div>\s*\n?\s*\{right \? <div className="flex items-center gap-2 text-ink-muted">\{right\}<\/div> : null\}/,
    );
  });

  it("2026-05-20 — DBadge re-tinted to a near-black (#0b0f14, matches surface-base) rounded-square with a glow-red (#e23847, marketing-site CTA colour) 'D'. Founder feedback: prior oxblood-on-white washed out + clashed with the surface-raised dark chrome.", () => {
    expect(body).toMatch(
      /\/\/ 2026-05-20 — DBadge re-tinted to a near-black rounded-square with a\s*\n?\s*\/\/ glow-red "D" per founder feedback \(the earlier oxblood-on-white\s*\n?\s*\/\/ felt washed out \+ clashed with the surface-raised title-bar fill\)\.\s*\n?\s*\/\/ #0b0f14 matches surface-base from globals\.css so the badge reads\s*\n?\s*\/\/ as one continuous element with the dark chrome; #e23847 is the\s*\n?\s*\/\/ marketing site's glow-red CTA colour for visual continuity\./,
    );
    expect(body).toMatch(
      /<svg\s*\n?\s*width="18"\s*\n?\s*height="18"\s*\n?\s*viewBox="0 0 64 64"\s*\n?\s*xmlns="http:\/\/www\.w3\.org\/2000\/svg"\s*\n?\s*aria-hidden="true"\s*\n?\s*>\s*\n?\s*<rect width="64" height="64" rx="12" fill="#0b0f14" \/>\s*\n?\s*<text\s*\n?\s*x="32"\s*\n?\s*y="42"\s*\n?\s*textAnchor="middle"\s*\n?\s*fill="#e23847"\s*\n?\s*fontFamily="Georgia,serif"\s*\n?\s*fontSize="34"\s*\n?\s*fontWeight="700"\s*\n?\s*>\s*\n?\s*D\s*\n?\s*<\/text>\s*\n?\s*<\/svg>/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
