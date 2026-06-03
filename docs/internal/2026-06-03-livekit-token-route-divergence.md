# LiveKit token-route divergence (2026-06-03, Agent-2) — pre-launch finding

Two LiveKit access-token mint routes exist, both **wired** in `lib/app.ts` but gated on a fully-populated
`config.livekit` (apiKey + apiSecret + wsUrl) — absent in prod, so both are **stub-until-keyed / not live**.
They embody **different, inconsistent** designs. The newer one is the corrected pattern; the older one
diverges on two security/correctness points that should be reconciled **before `config.livekit` is keyed**.

Both routes are otherwise sound: `requireAuth` + `rateLimit`, ownership-checked (cross-account session id
→ 404 anti-enumeration), room scoped to the (owned) session id.

## Canonical (newer) — `routes/agent-sessions-livekit-token.ts` (LK.3)

`POST /v1/agent-sessions/:id/livekit-token`:

- **Subscriber-only:** `canPublish: false, canSubscribe: true`. Comment: _"gui-client is a subscriber.
  Mac-side BrowserController is the publisher (provisioned out-of-band on the Mac)."_ — i.e. the publisher
  is fleet infra, never minted via a customer-facing route.
- **Per-participant identity:** `identity: customer-<account-id>` — _"so the SFU can dedupe joins."_
- Picks a Mac with registered LiveKit creds, decrypts the per-Mac secret, 24h TTL.

## Older — `routes/sessions-livekit-token.ts` (V-531.B)

`POST /v1/sessions/:id/livekit-token  { role: 'publisher' | 'subscriber' }`:

- **Finding 1 — customer can mint a `publisher` token (over-grant).** The route is customer-facing
  (`requireAuth`, caller owns the session) yet lets the body select `role: 'publisher'` →
  `canPublish: true`. Per the canonical design the publisher is provisioned out-of-band (Mac-side), and
  customers are subscriber-only. The grant is self-scoped (the room is the caller's own session), so
  there's no cross-account exposure — but it's an unnecessary capability divergent from the established
  design (a customer could publish media into / disrupt their own session's capture room).
- **Finding 2 — identity collision (`identity: sessionId` for every participant).** LiveKit treats
  `identity` as a unique participant key and **disconnects** a duplicate-identity join. This route mints
  _both_ roles with `identity: sessionId`, so any two participants in the room (e.g. the capture publisher
  - the customer's preview subscriber, the documented use case) **kick each other out**. The canonical
    route avoids this precisely by using a per-participant identity. So the live-preview wouldn't actually
    work under the V-531.B scheme.

## Recommendation (maintainer / whoever wires LiveKit — not an autopilot change)

Before populating `config.livekit`, reconcile the V-531.B route to the canonical LK.3 pattern:

1. Make `/v1/sessions/:id/livekit-token` **subscriber-only** (drop the `publisher` role; the publisher is
   out-of-band Mac-side), and
2. use a **per-participant identity** (e.g. `customer-<account-id>`, matching LK.3), not `sessionId`.

…OR, if `/v1/agent-sessions/:id/livekit-token` supersedes `/v1/sessions/:id/livekit-token` for the
LiveKit surface, **deprecate/remove** the V-531.B route entirely. This is a realtime-infra API-shape +
route-canonicality decision (which surface is live at launch), so it is surfaced here rather than flipped
autonomously. Neither route is live today, so there is no current production impact.
