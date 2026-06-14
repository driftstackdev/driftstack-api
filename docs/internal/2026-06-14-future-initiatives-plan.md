# Future initiatives — founder directives 2026-06-14 (PLAN ONLY, build later)

Founder (2026-06-14, "full autopilot all night"): finish the current GUI 5→10 arc **100%** first,
then take these on — "just plan it for now for very later." Captured here so nothing is lost; do NOT
start building these until the 5→10 arc + A–Z beauty sweep are done (or the founder greenlights one
sooner). "Do everything thorough and in the best way, make it beautiful; if you find even better ideas,
do them."

## F1 — Per-profile AI assistant with templates (right sidebar)

Like the visual demo: a right-hand assistant panel, scoped to the selected profile, offering **custom
templates** + **default templates** (e.g. "AI browser warming / browsing", "warm up this identity",
"add-to-cart dry run").

- UI: right sidebar/drawer in the profile context (grid card → "Assist" or a persistent rail). Template
  picker (defaults + user-saved customs) → fills the AI-chat composer / launches an agent run scoped to
  that profile_id. Reuses the existing AgentChatView + useAgentChat({profileId}) + recipes (save-as-
  recipe already wired) — templates are essentially named prompt presets + recipes.
- Data: a template store (defaults shipped in-app; customs in a local store like profile-templates.ts,
  or server-side later). Tie "AI browser warming" to a default template prompt.
- Sequencing: GUI-first (presets + the right rail); real execution rides the existing agent run-loop
  (StubExecutor until Agent-1's RealExecutor). Strong synergy with the current arc — likely the FIRST
  of these to build after the arc.

## F2 — Fancier UDP/WebRTC badge + exit WebRTC IP on the profile grid

Extend G1's proxy capability chips: when UDP is supported, show a richer badge AND the **exit WebRTC
IP** on the grid card (the IP a STUN/WebRTC probe sees through the proxy — may differ from the HTTP exit
IP, which is the fingerprinting-relevant signal).

- Needs an exit-WebRTC-IP probe (Agent-1 / egress?) — surface the value once available; the GUI already
  has ProxyCapabilityChips + the probe-cache pattern to render it. Small GUI slice once the probe exists.

## F3 — Marketing site restyle (too childish / too purple)

`apps/marketing-site` — founder: overall style too childish, too purple. Restyle to a more mature,
premium, credible aesthetic aligned with the Console design language (real tokens, restrained accent,
refined type/spacing). Part of the broader **A–Z beauty sweep**; this is the highest-priority external
surface in that sweep. Do a demo-first pass (like the GUI rework) for founder sign-off before applying.

## F4 — Profile marketplace (buy pre-warmed profiles) — NEW project

Sell profiles that were warmed up long ago (aged, trusted identities).

- Frontend-first (founder: "start making the frontend on the UI, backend when the time is right"). A
  marketplace surface — browse warmed profiles (age, archetype, warmth signals, price), buy → mint into
  the buyer's account (reuse profiles.import/transfer).
- In the GUI and/or the web dashboard. Backend later: a catalog, inventory of warmed profiles, purchase
  → transfer flow, pricing. Ties to F5 (balance pays for purchases).
- ⚠️ Founder-gated scope (new product line + pricing/ToS); plan the frontend, don't ship purchase wiring
  until backend + founder sign-off.

## F5 — Billing / balance top-up

An account **balance** customers top up, used to buy F4 marketplace profiles (and more later).

- Top-up flow (card / crypto — note existing cryptoOrders + billing resources in the SDK), balance
  ledger, spend against balance. The admin cockpit already has pricing-as-data + crypto charge paths
  (see [[project_admin_full_control_cockpit_buildout]]) — extend rather than reinvent.
- Backend-heavy (money) → careful, audited, founder-gated. Plan frontend (balance display, top-up UI)
  first; backend with full rigor when greenlit.

## F6 — Three proxy modes per profile: SOCKS5 · WireGuard · OpenVPN (A3 cross-agent)

A3 is building OpenVPN/WireGuard configs per profile (activatable, in progress). The profile's egress
will have **3 modes**: SOCKS5 (current), WireGuard VPN, OpenVPN VPN.

- GUI impact: the proxy binding UI (ProxiesView + the profile proxy row + create/bind flow) becomes a
  mode picker (SOCKS5 / WireGuard / OpenVPN) with mode-specific config (SOCKS5 host/port/auth vs a
  WG/OVPN config blob/upload). The capability chips (G1) + exit probes generalise across modes.
- Cross-agent: coordinate the config schema with A3 (planning file 133 egress spec + the control-plane
  contract). Surface, don't flip — wait for A3's schema + the activation path. Plan the GUI mode-picker;
  build when A3's per-profile VPN config API lands.

## Build order (proposed, after the 5→10 arc is 100% done)

1. **A–Z beauty sweep** incl. **F3 marketing restyle** (founder's standing "everything A-Z beautiful").
2. **F1 per-profile AI assistant + templates** (high synergy with the current AI-chat work).
3. **F2 WebRTC-IP badge** + **F6 proxy-mode picker** as A3's egress/probe APIs land (cross-agent gated).
4. **F4 marketplace frontend** → **F5 balance/top-up frontend**, then their backends with founder sign-off.
   Each: demo-first for visual sign-off where it's a new surface; gate-green slices; batched Tauri rebuilds.
