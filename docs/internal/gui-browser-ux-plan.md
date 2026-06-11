# GUI browser UX — plan, recommendations + agent assignment (W605)

**2026-06-11.** Founder asked to make the GUI's session viewer feel like a real
browser/phone instead of a bare fixed image: (1) an iOS-simulator device frame
beside a resizable window, (2) multiple tabs, (3) loading state + web-error
display, (4) generally more user-friendly. Founder wanted **recommendations
first** before building. This is the plan.

## Scope correction (who actually owns this)

The founder guessed "probably A3/A1 source code." Most of it is **A2**: the
desktop GUI client (`apps/gui-client`, Tauri) is Agent-2 scope. Today
`LiveSessionView.tsx` polls a screenshot every ~500ms, renders the base64 PNG
in an `<img>`, and forwards tap/scroll/press/type as intents. The chrome around
that image is pure A2 frontend.

- **A2 (GUI client):** device frame, resizable window, URL bar + nav buttons,
  loading/error _rendering_, tab _UI_. Most of the ask.
- **A3 (harness):** must _emit_ the signals A2 renders — page load-state
  (navigation started/committed/finished) + page errors (HTTP 4xx/5xx, TLS,
  DNS, net). The harness drives navigation; only it knows these. Today A2 can't
  infer "loading" or "errored" from a PNG.
- **A1 (WebKit fork):** only needed for _true_ multi-page tabs (multiple
  WKWebViews per session). Not needed for the recommended v1 tab approach.

## Item-by-item recommendations

### 1. iOS-simulator device frame + resizable window — ✅ DO (A2-only, v1)

Wrap the viewport `<img>` in a CSS iPhone bezel (rounded corners, notch/dynamic
island, status bar) sized to the active archetype's screen aspect ratio. The
`<img object-contain>` already scales to any container, so the window can be
resizable (`tauri.conf.json` resizable:true + a min size) with the frame
scaling responsively. **Pure A2, no cross-agent dep, medium effort.** Recommend
a "device-frame on/off" toggle (power users debugging want the bare image).
Caveat: the bezel is cosmetic — it must read the archetype dimensions (don't
hardcode iPhone 17), so it stays correct across the 81-archetype matrix.

### 2. Multiple tabs — ⚠️ SPLIT: recommend the pragmatic v1, defer the deep one

- **True multi-page-per-session** (one session, many WKWebView tabs) is a
  Phase-4 architecture arc across all three agents (A1 multi-WKWebView, A3
  multi-page session model + per-tab frame/input routing + tab control
  protocol, A2 session-model + API + tab strip). A3 already lists "multi-tab
  navigation (Phase-4)" as deferred-by-design. **Recommend deferring** past v1.
- **Pragmatic v1 (A2-only): "tabs" = multiple concurrent sessions** shown as a
  tab strip in the GUI. The control plane already supports concurrent sessions
  (tier caps), each fully independent. The GUI opens N sessions and renders one
  tab each — gives the multi-tab feel with **zero fork/harness work**.
  **Recommend this for v1**; it's honest (each tab is its own iPhone) and
  matches how the product actually scales (concurrency = parallel sessions).

### 3. Loading state + web errors — ✅ DO (cross-agent: A3 emits, A2 renders)

A2 can't tell loading/errored from a screenshot. Plan:

- **A3:** emit page lifecycle on the session event stream / state — `page_state:
loading|loaded|errored` + on error `{ http_status?, kind: http|tls|dns|net,
message }`. The harness owns navigation, so it's the source.
- **A2:** add the field to the session resource + SSE (additive), and render a
  top loading bar + an error overlay ("This site couldn't be reached — DNS")
  in LiveSessionView. **High UX value.** A2 will draft the exact wire shape and
  relay to A3 (same pattern as the scroll_through coordination).

### 4. Browser chrome (URL bar / back / forward / reload / title) — ✅ DO (A2-only)

`getState` already returns `url` + `title`; navigate/back/forward intents
exist. A2 adds a browser toolbar: editable URL bar (Enter → navigate), back /
forward / reload buttons, and the page title. **Pure A2, no cross-agent dep.**

## Recommended sequence (smallest-valuable-first, all founder-gated to start)

1. **A2:** browser chrome (URL bar + nav buttons + title) — pure A2, immediate.
2. **A2:** device frame + resizable window — pure A2, cosmetic-but-high-impact.
3. **A2:** multi-session tab strip (pragmatic tabs) — pure A2.
4. **Cross-agent:** loading/error display — A2 drafts the `page_state` wire
   shape → relays to A3 → A3 emits → A2 renders.
5. **Deferred (Phase-4):** true multi-page-per-session tabs — needs A1 + A3 + A2
   design; not v1.

## Cross-agent asks (to relay once founder greenlights)

- **→ A3:** emit `page_state` (loading/loaded/errored + error kind/status) on
  the session event stream; A2 will send the exact shape proposal.
- **→ A1:** none for v1 (true multi-WKWebView tabs only if Phase-4 is pulled
  forward).

## Bottom line / recommendation to founder

Items 1, 3-lite, 4 are **A2-ownable and high-value** — I can build them behind
your go-ahead with no dependency on A1/A3 except the load-state _signal_ (item
3, one A3 emit). Real multi-tab (item 2 deep) is a Phase-4 cross-agent arc;
recommend the **multi-session tab strip** as the v1 stand-in. Awaiting your
pick of which to start (I'd suggest #4 chrome → #1 frame → #3 loading, in that
order).
