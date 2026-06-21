# GUI browser-chrome mode — plan + A3/A1 coordination (2026-06-21)

**Founder idea:** bring the URL bar + tabs _into the GUI_ as a separate "browser
mode" so the GUI has smooth, native control of the address bar instead of relying
on the rendered iOS-Safari chrome (which the page-touch path can't reach — the
founder keeps tapping the un-tappable rendered pill). Founder wants
investigation + a plan first, not a build. This is that plan.

Supersedes/extends the W605 plan (`gui-browser-ux-plan.md`, 2026-06-11), which
predates the LiveKit live-stream + rendered-Safari-chrome architecture.

## Why this is the right instinct

The rendered Safari chrome (the bottom address pill, `installDriftSafariBottomBar`)
is a fork-native NSView **above** the WKWebView — the customer's tap path
structurally **cannot** reach it (A3 confirmed). So a tap on the rendered pill
will _never_ work; no amount of polish fixes that. The GUI's own
`NavigateAddressBar` (data-channel `{type:'navigate'}` → WebDriver navigate) is
the only functional path. The founder's idea — make the GUI _be_ the browser
chrome — leans into the one path that works. It also makes URL entry a native
text field: instant, no video round-trip, no tap-coordinate mapping at all.

## ⭐ The one hard constraint: fingerprint-viewport coupling

`DRIFTSTACK_SAFARI_CHROME=1` is not cosmetic-only — the chrome **insets the
WKWebView's layout viewport** (~32px top band + ~92px bottom bar → content ≈
402×714, not 402×838). The **target website measures that inset viewport**
(`window.innerHeight`, `visualViewport`, safe-area). A real iPhone Safari reports
exactly this chrome-inset height. So:

- ❌ **Do NOT turn the device chrome off** to "make room" — that would set the
  WKWebView to the full height → the site sees `innerHeight≈838` → a fingerprint
  TELL that doesn't match real Safari.
- ✅ **Keep the device's authentic viewport.** The GUI chrome is **operator-side
  only** — the website never sees the operator's window. So we can hide/replace
  the _rendered_ chrome in the operator's view WITHOUT touching what the site
  measures, as long as the WKWebView stays sized to the inset viewport.

This is what makes the idea safe for anti-detection: **operator chrome ≠ device
viewport.** Confirm with A1, but the principle is sound.

## How to hide the rendered chrome (two clean options — A3 input needed)

The device must keep the inset viewport, but we don't want the confusing rendered
pill in the operator's video. Two ways:

- **(box-side, cleaner) "viewport-only chrome" mode (A3/A1):** keep the WKWebView
  sized to the inset viewport but **don't draw** the cosmetic chrome bars; stream
  content + an empty (or transparent) bar region. No wasted bandwidth on chrome
  pixels, exact content rect, no GUI clip math. Needs a fork/harness flag.
- **(GUI-side, no box dep) crop in the operator video (A2):** the device renders
  chrome as today; the GUI clips the video to the known content rect
  ({0,50,402,714}) and draws native chrome around it. Works with zero box change,
  but the GUI must own the content-rect geometry (which A3's reconcile already
  computed) and re-do it per archetype.

**Recommendation:** GUI-side crop for a fast Phase-1 (no cross-agent dep); migrate
to box-side viewport-only chrome if/when A3 adds the flag (cleaner long-term).

## Command surface gap (drives the phasing)

The LiveKit `InputEvent` protocol today has **only** `{type:'navigate', url}` —
**no back / forward / reload / tab** commands (lock-step with A1's Swift enum +
the harness decoder). So:

- URL bar + go + **reload-via-navigate** → shippable **now** (A2-only).
- **back / forward / true reload** → need new `InputEvent` variants (A1 enum +
  A3 harness decode) — this is the standing task #38 cross-agent gap.

## Phased plan

### Phase 1 — GUI browser-chrome bar (A2-only, no cross-agent dep) — RECOMMENDED START

A persistent, always-visible native browser bar at the top of the simulator
window: editable URL field (Enter → navigate; bare host → https), reload
(re-navigate current URL), page title/host. Crop the rendered Safari chrome from
the operator video (content rect) so there's exactly ONE address bar. A
**mode toggle**: default = the immersive iPhone look (rendered chrome, today's
view); "Browser mode" = GUI chrome + cropped content. Delivers the founder's core
ask (smooth URL control, no confusing pill) with zero A1/A3 dependency. The tap
mapping in browser mode targets the content rect explicitly → unifies with /
subsumes A3's coordinate-reconcile (one source of truth for the content rect).

### Phase 2 — back / forward / reload + loading/error (cross-agent)

- **A1 + A3:** add `back` / `forward` / `reload` to the `InputEvent` enum +
  harness decode (task #38). Then A2 adds the buttons.
- **A3 + A2:** `page_state` (loading/loaded/errored + error kind/status) on the
  session event stream (the W605 #3 ask, still pending A3) → A2 renders a loading
  bar + error overlay. High UX value; makes the chrome feel real.

### Phase 3 — tabs (deep, cross-agent) — defer

- **Pragmatic v1 (A2-only):** "tabs" = multiple concurrent sessions in a GUI tab
  strip (each tab is its own iPhone). Zero fork work; honest with how the product
  scales. (Shipped once for the old viewer — W609; re-applies to the new window.)
- **True multi-page-per-session** (one session, many WKWebView tabs) = Phase-4
  arc across A1 (multi-WKWebView) + A3 (multi-page session model + per-tab
  frame/input routing) + A2 (tab UI). A3 already lists this as deferred-by-design.
  Defer unless the founder specifically wants in-session tabs.

## Cross-agent split

- **A2 (me):** the browser-chrome bar, URL/reload, mode toggle, video crop,
  content-rect tap mapping, tab UI, loading/error rendering, the SDK/API field if
  page_state is added.
- **A3 (harness/box):** (optional) box-side viewport-only chrome flag; the
  `page_state` emit; harness decode for back/forward/reload; confirm the crop
  rect / reconcile interplay.
- **A1 (fork):** confirm hiding the _rendered_ chrome while keeping the inset
  viewport is fingerprint-safe; the `InputEvent` enum additions; multi-WKWebView
  only if true tabs are pulled forward.

## Recommendation to founder

**Yes — worth doing, and safe**, because the operator's GUI chrome is invisible to
the target website (only the device's inset viewport is, which we keep). Best as a
**toggleable "Browser mode"** so the immersive iPhone look stays the default.
**Start with Phase 1 (A2-only):** a real native URL bar + reload + cropped content
— it gives the smooth URL control you want with no dependency on A1/A3, and it
makes the rendered-pill confusion impossible. Back/forward + tabs are genuinely
useful but need the cross-agent command surface (#38) / a tab architecture —
phase them after Phase 1 proves the mode. Open question for A3/A1: do the chrome
crop box-side (viewport-only flag) or GUI-side (video clip) — I lean GUI-side for
speed, box-side later.
