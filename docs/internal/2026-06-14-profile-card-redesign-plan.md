# Profile grid redesign — "phone-framed card" (founder 2026-06-14)

Founder: "I don't really like the profile grid yet… it's too large. We focus on mobile phones anyway —
why make it so big? Use unique stuff — perhaps fit all data inside a large phone instead. Do something
unique that might look beautiful. Plan it, do as recommended, just make it better." (Founder out →
all-night autopilot; build per this recommendation, demo-quality, gate-green.)

## Problem with today's card

Today each profile is a WIDE rectangle: a small CSS iPhone thumbnail (identity card) on top, then a
separate stacked meta column (name, device, proxy row, org chips, actions). It's big, generic, and the
phone is just a thumbnail — the device motif (our whole product) is decorative, not the card.

## Recommendation — make the CARD the phone

Turn each profile card INTO a single stylised large phone; all data lives **inside the screen**. The
grid becomes a tidy wall of phones — compact, on-brand (we're a mobile antidetect product), distinctive.

Layout inside one phone (top → bottom), within a device frame (rounded ~22px, notch/dynamic-island,
thin bezel ring, subtle screen gradient = the per-profile identity hue from `identityHue`):

- **Status bar (faux iOS):** left = a tiny carrier/clock motif or the device label (e.g. "iPhone 17");
  right = LIVE dot (status-ready, pulsing) or idle. Doubles as the real status.
- **Identity block:** the monogram avatar (existing `profileMonogram`/`identityHue`) + profile **name**
  (bold) + device chip. Selectable: the selection checkbox sits top-left in the status bar on hover.
- **Egress "widget" (home-screen card style):** flag + **real exit IP** (fixed in FIX3) + latency
  meter + the WebRTC/QUIC/HTTP-2 capability chips (G1) — laid out like an iOS widget. "untested → Test".
- **Folder + tag chips** as small app-label pills.
- **Last-active** ("2h ago") as subtle text.
- **Bottom action bar (faux dock):** Launch / Open session (primary) + a ⋯ for Organize/Chat/Delete —
  styled like the iOS dock so actions feel native to the phone.

Sizing: target a **narrower, taller** card (phone aspect, ~9:19.5) so more fit per row (the grid goes
from lg:grid-cols-3 wide rectangles to e.g. 4–6 slim phones per row on a wide window) → addresses "too
large". Hover lifts the phone slightly + reveals quick actions; LIVE phones get the accent glow.

## Build approach (low-risk despite blind-visual)

- New component `ProfilePhoneCard` (own file) — pure presentational, takes the same props the current
  grid card computes (profile, probe, running, selected, handlers). Reuse `ProfileIdentity` monogram
  helpers, `ProxyCapabilityChips`, `flagEmoji`, `RelativeTime`, folder/tag chips, `folderColor`.
- Swap it into the grid map in ProfilesView (replace the current `<article>` grid card) — keep the LIST
  view untouched (the dense operator view stays). So the redesign is grid-only; list is the fallback.
- Tests: render `ProfilePhoneCard` in isolation (name/exit-IP/status/actions present; selection toggles;
  Launch fires) — exported-pure-component pattern (like ProxyCapabilityChips/TagFilterRail).
- Demo-first option: since it's blind + the founder's taste matters, optionally drop a static HTML mock
  in `docs/internal/visual-demos/` first; but founder said "do as recommended" → can build directly,
  shipped behind the next rebuild for review, with the list view as the safe alternative.

## Sequencing

This is **GX**, the next GUI slice (founder actively wants it). Do it before/with the F-phase polish.
Keep each step gate-green; batch into the next Tauri rebuild for founder review. If the founder dislikes
the direction at rebuild, the list view is untouched and the phone-card is easily iterated.
