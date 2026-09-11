# Marketing screens — real captures of the desktop app

Every image here is a **real render of the shipped GUI components** (same React
code, same CSS as the Tauri app), not an illustration. They come from the
gui-client visual harness (`apps/gui-client/visual-harness.html` →
`src/visual-harness/gallery.tsx`) with `?scene=<name>`, which composes one
screen inside the app's real window chrome (TitleBar + Sidebar, dark theme,
oxblood accent) at a fixed stage — 1280×800, except the list view at 1800×800
so its full-width table (Actions column included) fits in frame — captured at
2× by Playwright.

| file                        | pixels    | CSS px   | what it shows                                                                                   |
| --------------------------- | --------- | -------- | ----------------------------------------------------------------------------------------------- |
| `profiles-grid.{png,webp}`  | 2560×1600 | 1280×800 | Profiles view — grid of 8 profile tiles (idle / live / VPN / untested / selected …)             |
| `profiles-grid-hero.*`      | 2064×1010 | 1032×505 | the tile grid alone, cropped from `profiles-grid` (hero image)                                  |
| `profiles-list.{png,webp}`  | 3600×1600 | 1800×800 | Profiles view — list mode: the grid's same 8 profiles as rows, sorted by name                   |
| `proxies.{png,webp}`        | 2560×1600 | 1280×800 | Proxies view — the SOCKS5 / WireGuard / OpenVPN editors, each holding its saved config          |
| `simulator.{png,webp}`      | 2560×1600 | 1280×800 | the simulator window — live toolbar, phone screen host, on-screen iOS keyboard, Egress readouts |
| `billing.{png,webp}`        | 2560×1600 | 1280×800 | Billing — Usage & cost for one billing cycle                                                    |
| `command-center.{png,webp}` | 2560×1600 | 1280×800 | Command Center — header band + KPI strip                                                        |

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
AND the table fits its shell without horizontal scroll; 3 editors AND both
tunnel editors show a saved config; the observed Egress readouts) so an empty
or clipped stage fails instead of shipping. The script also reads
`data-frozen-now` / `data-stage-width` / `data-stage-height` off every stage
and stops when they differ from its own mirror. `--verify` passing twice in a
row is the proof.

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
tallies are derived, and the `MarketingScene` compositions). The card states
are the gallery's own `STATES` entries with example hosts laid over them, so
every tile is one the geometry gate (`scripts/gui-visual-check.mjs`) already
proves. Then run the script, the guard test
(`npx vitest run apps/gui-client/tests/unit/marketing-scenes.test.tsx`), and
commit the regenerated images together with the change.
