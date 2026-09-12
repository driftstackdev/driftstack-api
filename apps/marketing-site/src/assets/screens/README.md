# Marketing screens — real captures of the desktop app

Every image here is a **real render of the shipped GUI components** (same React
code, same CSS as the Tauri app), not an illustration. They come from the
gui-client visual harness (`apps/gui-client/visual-harness.html` →
`src/visual-harness/gallery.tsx`) with `?scene=<name>`, which composes one
screen inside the app's real window chrome (TitleBar + Sidebar, dark theme,
oxblood accent) at a fixed stage — 1280×800, except the list view at 1800×880
so its full-width table (Actions column included) fits in frame — captured at
2× by Playwright.

| file                        | pixels    | CSS px   | what it shows                                                                             |
| --------------------------- | --------- | -------- | ----------------------------------------------------------------------------------------- |
| `profiles-grid.{png,webp}`  | 2560×1600 | 1280×800 | Profiles view — grid of 8 profile tiles (idle / live / VPN / untested / selected …)       |
| `profiles-grid-hero.*`      | 2064×1010 | 1032×505 | the tile grid alone, cropped from `profiles-grid` (hero image)                            |
| `profiles-list.{png,webp}`  | 3600×1760 | 1800×880 | Profiles view — list mode: the grid's same 8 profiles as rows, sorted by name             |
| `proxies.{png,webp}`        | 2560×1600 | 1280×800 | Proxies view — the SOCKS5 / WireGuard / OpenVPN editors, each holding its saved config    |
| `simulator.{png,webp}`      | 2560×1600 | 1280×800 | the desktop app + the floating device window over it — example shop page, Egress readouts |
| `billing.{png,webp}`        | 2560×1600 | 1280×800 | Billing — Usage & cost for one billing cycle                                              |
| `command-center.{png,webp}` | 2560×1600 | 1280×800 | Command Center — header band + KPI strip                                                  |

`manifest.json` lists the same sizes (regenerated with the images) — read it
from a page rather than hard-coding widths.

Use the `.webp` with the `.png` as fallback (`astro:assets` `<Picture>` /
`<Image>`), with explicit `width`/`height` from the table above, and an `alt`
that says what the screen shows.

## Privacy

Nothing here is a real session, proxy, exit or account. The scenes are
fixtures: `*.example.com` hosts, RFC 5737 TEST-NET exit addresses
(`192.0.2.*`, `198.51.100.*`, `203.0.113.*`), `ops@example.com`. The jsdom
guard `apps/gui-client/tests/unit/marketing-scenes.test.tsx` renders every
scene and fails on any vendor host or non-TEST-NET IPv4 in the rendered text,
titles, labels or input values.

## Regenerate

From the repo root, on macOS (see "Fonts" below):

```sh
# the GUI dev server must serve the harness (the script starts one if :5199 is down)
cd apps/gui-client && npx vite --port 5199 --strictPort --host 127.0.0.1 &
cd -
node scripts/marketing-screens.mjs            # writes every png/webp + manifest.json
node scripts/marketing-screens.mjs --verify   # re-renders and diffs pixel-for-pixel; exit 1 on drift
node scripts/marketing-screens.mjs --scenes=proxies,simulator   # a subset (manifest untouched)
```

The captures are deterministic: the page clock is frozen at
`2026-06-15T06:42:00Z` (both by Playwright's `page.clock.setFixedTime` and by
the harness itself, so a browser opened at
`http://127.0.0.1:5199/visual-harness.html?scene=profiles-grid` shows the same
frame — the harness freezes its clock at module load, before its fixtures
compute any relative time), motion is disabled (reduced-motion), locale/timezone
are pinned, and each scene carries a DOM guard (8 tiles in ≥ 3 columns; 8 rows
AND the table fits its shell without horizontal scroll and the pane without vertical scroll; 3 editors AND both
tunnel editors show a saved config; for the simulator BOTH windows, the eight
profile cards still in the app's pane behind it, a phone screen that actually
renders a page — ≥ 150 characters, measured, because the page's own chrome is
54 and a lower floor passes with every product gone — and the observed Egress
readouts) so an empty or clipped stage fails instead of shipping. A guard or
`also` entry whose keys assert nothing (a `minChars` for `minText`) throws
rather than reading as "checked, fine".

The simulator adds `geometry` facts a screenshot cannot prove about itself and
jsdom cannot measure at all: the device window really overlaps the app window
(≥ 80px on both axes, so it is over it and not beside it) and does not swallow
it (≤ 70% of the pane's area, 54% today — `overlaps` is only a lower bound, and a window
grown to fill the stage passes every count, text and overflow guard, because
none of them can see what is painted over); it sits wholly inside the stage
(which clips, and scroll extent only ever grows right and down — a window
pushed off the top or left edge is cropped with nothing to measure it), and so
does the drawer's last Egress readout inside the floating window, which clips
the same way around a fixed-height body; and the drawn page sits ABOVE the
on-screen keyboard — ordered, not merely clear of it, since "they do not
overlap" is equally true of a keyboard moved above the screen. The script also
reads `data-frozen-now` / `data-stage-width` / `data-stage-height` off every
stage and stops when they differ from its own mirror. `--verify` passing twice
in a row is the proof.

**Fonts.** The app does not bundle Geist Sans / Berkeley Mono; it renders
with its fallback stack, which on macOS is the system font — exactly what the
shipped macOS app shows. Regenerating on Linux/Windows picks a different
fallback and `--verify` will report every pixel changed; that is a font
difference, not a regression.

## Changing what is shown

Edit the marketing-scene block at the end of
`apps/gui-client/src/visual-harness/gallery.tsx` (`MARKETING_CARDS`,
`MARKETING_TABLE_ROWS` — the same eight profiles, kept equal by the guard —
`MARKETING_PROXIES` with their fleet verdicts, from which the Proxies header
tallies are derived, and the `MarketingScene` compositions).

⛔ The simulator scene is ONE story, and the guard test pins it: the floating
window IS a session, so the profile its toolbar names must be the profile the
grid behind shows RUNNING (its dock reads `Open session`, never `Launch`, and
the header tally counts that one). A Live window over a card offering Launch is
a frame the app cannot produce, and a stranger reads it as a broken screenshot.

The card states
are the gallery's own `STATES` entries with example hosts laid over them, so
every tile is one the geometry gate (`scripts/gui-visual-check.mjs`) already
proves. Then run the script, the guard test
(`npx vitest run apps/gui-client/tests/unit/marketing-scenes.test.tsx`), and
commit the regenerated images together with the change.
