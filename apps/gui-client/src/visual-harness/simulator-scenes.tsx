// The simulator window's own gallery scenes — "Bringing The Stage everywhere"
// stage 1 (design brief §2, §5 stage 1), extended by round-2 stage B (the
// owner's "Love it!" on the mockup) with the Agent/Pair conversation states.
// Mounts the REAL `<SimulatorWindow>`, not a replica: the query-string +
// `standIn` seam `SimulatorWindow.tsx` itself defines (`galleryPhase`, the
// `standIn` prop) drives it into a session state it did not reach over the
// network — connecting, live & healthy, degraded/reconnecting, ended — the
// same seam BUILD-SPEC §8 built for the AI view, one level down: `standIn` is
// an IMAGE (never DOM text — the gate's 9px floor / contrast rule /
// truncation rule would fire on a drawn page's own small grey type), and the
// fixture is an explicit `?fixture=` value no real launch (lib/open-
// simulator.ts) ever sets.
//
// Round-2 stage B adds FOUR more states — agent-running / agent-approval /
// agent-done / pair — through a SECOND, independent seam, because they are a
// second, independent axis from the four above (NOTES.md §4: "a session can
// be live AND paused at once" — `data-mission`, what the agent is doing, is
// not the same question as `data-sim-state`, whether the stream is healthy).
// Every one of them rides the SAME healthy `live` stream fixture — the phone
// genuinely is live while the agent drives it — via `simulatorSceneSimState`
// below, and carries its OWN fixture `chat` (a full `UseAgentChatResult`,
// `AGENT_CHAT_SCENE_KINDS`' 'running'/'approval' REUSED VERBATIM — same task,
// same plan, same shop — because the mockup's own conversation IS that
// scenario) through `SimulatorWindow`'s `agentChatOverride`/`settingsOverride`
// props — the same `AgentChatProvider value={…}` pattern `audit-scenes.tsx`
// uses for the AI view, one level down, PROPS rather than the query string
// because a `chat` object cannot travel through a URL the way a state name
// can (`standIn`, already a prop for the identical reason).
//
// Before this, `?scene=simulator` (gallery.tsx's `SimulatorScene`) was a
// HAND-BUILT static mirror — close enough for a chrome-and-lighting critique,
// but not proof of the live component's exact pixels (its own doc comment
// says so). This scene closes that gap: the text-quality and visual-check
// gates now measure the actual `SimulatorWindow.tsx`.
//
// WHY NO TAURI STUB. SimulatorWindow's own network/IPC surface already no-ops
// cleanly in gallery mode: `isGalleryFixture` skips the diagnostics flight-
// recorder's LazyStore (its store file is not one the shared audit stub
// answers, and the recorder is a crash-report writer nobody screenshots), the
// fixture query omits `session=` so every control-plane poll (already guarded
// on `sessionId === ''`, read `SimulatorWindow.tsx`'s own comments beside
// `galleryPhase` for the full list) never fires, and `AgentSessionPanel`'s own
// `gallery` prop means no LiveKit Room is ever created — no WebRTC, no signal
// socket. Every OTHER Tauri call in that file (`withCurrentWindow`,
// `applyDockTile`, the `ds-session` relaunch listener) already checks
// `'__TAURI_INTERNALS__' in window` and no-ops outside Tauri — the same guard
// that keeps the component renderable in its own vitest suite with no Tauri at
// all. `RecordingsProvider` (required — `useRecordings()` throws without it,
// matching `main.tsx`'s own wrapper) is pure React state; its disk-backed
// `loadIndex()` catches its own failure and resolves to no recordings.
// `SettingsProvider` (SimulatorWindow's own self-mounted default, round-2
// stage B) is likewise inert with no Tauri — its `loadSettings()` failure
// path degrades to `DEFAULT_SETTINGS` — but the four agent-mission scenes
// bypass it anyway (`settingsOverride`) for a deterministic `apiKey`/`baseUrl`.
//
// PRIVACY (tests/unit/marketing-scenes.test.tsx scans this scene the way it
// scans every other): hosts are *.example.com, the proxy label names no real
// exit, and the stand-in page is the AI view's own `shopListingSvg` — already
// audited (*.example.com, invented prices, no vendor names) — reused rather
// than drawing a second fixture page, so the simulator and the AI view show
// literally the same phone content. The order-confirmation screenshot
// (`orderConfirmedSvg`) follows the identical discipline: a drawn image, no
// text nodes, an invented order number.
//
// A FIDELITY LIMIT, WRITTEN DOWN: `sessionId` stays '' (no `session=` in the
// query) so the control-plane polls above never fire — a deliberate trade for
// zero live network calls in a screenshot gate. `DeviceToolbar`'s own "Live"
// pulsing dot reads `sessionId !== ''` (SimulatorWindow.tsx, unrelated to this
// stage's CSS work and not touched by it), so it does not light up in the
// `live`/agent-mission scenes here the way a real live session's toolbar
// would. The device bezel, the room's light and the drawer's headline chip —
// everything the round-2 stages actually restyle — are driven by
// `data-sim-state`, which reads `galleryPhase` directly and does not depend
// on `sessionId` at all.

import { useMemo } from 'react';
import type { AgentIntentResult, AgentSession } from '@driftstack/sdk';
import type { ContextType } from 'react';
import { RecordingsProvider } from '../lib/recordings';
import type { SettingsContext } from '../lib/SettingsContext';
import { DEFAULT_SETTINGS } from '../lib/settings';
import { SimulatorWindow } from '../views/SimulatorWindow';
import type { AgentChatContextValue } from '../lib/AgentChatProvider';
import type { UseAgentChatResult } from '../lib/use-agent-chat';
import {
  agentChatSceneFixture,
  shopListingSvg,
  standInScreen,
  svgDataUri,
} from './agent-chat-scenes';

export const SIMULATOR_SCENE_KINDS = [
  'connecting',
  'live',
  'degraded',
  'ended',
  // Round-2 stage B — the mission axis (see this file's header). Named for
  // the mockup's own `?state=` values, not for the hook field that produces
  // them, matching `AgentChatSceneKind`'s own naming rule one level down.
  'agent-running',
  'agent-approval',
  'agent-done',
  'pair',
  // gui-v0.1.72 follow-up — `agent-running` at the Simulator's MINIMUM window
  // with the Session pane open (SIMULATOR_SCENE_SIZE_SMALL): the size where the
  // phone is narrowest and the agent-driving pill and the rail labels have the
  // least room. A window, not a state — like the AI view's own `-small`.
  'agent-small',
] as const;
export type SimulatorSceneKind = (typeof SIMULATOR_SCENE_KINDS)[number];

/** Round-2 stage B — is `kind` one of the four ORIGINAL connectivity-axis
 *  states, or one of the new mission-axis ones? Pure and exported so
 *  `scripts/gui-visual-check.mjs`'s Phase E sweep (which discovers every
 *  `audit-simulator-*` scene generically by name — see that script's own
 *  header) can ask "what should `data-sim-state` read here" without the
 *  scene's NAME suffix being the answer any more, now that a suffix like
 *  `agent-running` names a mission, not a connectivity state. */
export function isAgentMissionKind(
  kind: SimulatorSceneKind,
): kind is 'agent-running' | 'agent-approval' | 'agent-done' | 'pair' | 'agent-small' {
  return (
    kind === 'agent-running' ||
    kind === 'agent-approval' ||
    kind === 'agent-done' ||
    kind === 'pair' ||
    kind === 'agent-small'
  );
}

/** The `data-sim-state` (connectivity axis) a scene of this kind renders
 *  with. The four original kinds ARE the state they are named for; every
 *  mission-axis kind rides a healthy, live stream — the phone genuinely is
 *  live while the agent drives it, exactly like a customer's real session. */
export function simulatorSceneSimState(
  kind: SimulatorSceneKind,
): 'connecting' | 'live' | 'degraded' | 'ended' {
  return isAgentMissionKind(kind) ? 'live' : kind;
}

/** The window size a scene of this kind opens at — `scripts/gui-visual-
 *  check.mjs`'s Phase E reads this PER SCENE (not once for all eight, the
 *  way it read the single `SIMULATOR_SCENE_SIZE` before round-2 stage B):
 *  a mission scene's Session pane is open at the WIDE conversation width,
 *  so its window is wider than the four connectivity scenes'. */
export function simulatorSceneSize(kind: SimulatorSceneKind): { width: number; height: number } {
  if (kind === 'agent-small') return SIMULATOR_SCENE_SIZE_SMALL;
  return isAgentMissionKind(kind) ? SIMULATOR_SCENE_SIZE_WIDE : SIMULATOR_SCENE_SIZE;
}

/** The window size WITH the drawer open at the ORDINARY pane width — this
 *  scene's default for the four original kinds (see `SimulatorStateScene`
 *  below for why the drawer opens by default). The closed default is
 *  `src-tauri/tauri.conf.json`'s simulator `.inner_size(330.0, 718.0)`;
 *  SimulatorWindow.tsx itself widens the REAL window by `PANE_W` (252)
 *  whenever a drawer pane opens (`RAIL_W` (48) is already inside the closed
 *  330 — the rail is always docked) — this scene opens the "Session" pane on
 *  mount to show the headline chip, so its viewport must be 330 + 252 too, or
 *  the phone would be squeezed into less width than the real app ever gives
 *  it once a pane is open (measured: at 330 with the pane forced open, the
 *  bezel visibly clips).
 *
 *  SimulatorWindow's root is `h-screen w-screen` (it fills a dedicated OS
 *  window, not a box inside a page), so the gate must set the BROWSER
 *  VIEWPORT to this exact size for the scene to render at the size a
 *  customer actually sees, the same way it already does for every `audit-*`
 *  scene's declared width/height. */
export const SIMULATOR_SCENE_SIZE = { width: 582, height: 718 } as const;

/** Round-2 stage B — the same window, with the Session pane open at the WIDE
 *  Agent/Pair conversation width (330 + CONVO_PANE_W's 512 — SimulatorWindow.
 *  tsx's own constant; not imported here to avoid a third cross-module import
 *  for one literal, the same trade `SIMULATOR_SCENE_SIZE` above already
 *  makes for `PANE_W`). Height stays the phone's own natural 718: the panel's
 *  content scrolls inside `sim-drawer-pane` exactly like the Diagnostics/
 *  Cookies panes already do at this height in the four original scenes — the
 *  drawer's width is not sacred, the phone's box is, but neither is the
 *  window's height sacred to the drawer's content; only to the phone. */
export const SIMULATOR_SCENE_SIZE_WIDE = { width: 842, height: 718 } as const;

/** The Simulator's MINIMUM window with the Session pane open at the wide
 *  conversation width: `src-tauri/src/lib.rs`'s `.min_inner_size(280.0, 560.0)`
 *  (RAIL_W inside it, as in the 330 above) plus CONVO_PANE_W's 512. The phone is
 *  at its narrowest here — 232px — so this is where anything laid over it, or
 *  labelled beside it, runs out of room first. */
export const SIMULATOR_SCENE_SIZE_SMALL = { width: 792, height: 560 } as const;

/** The one line of copy each scene must show once loaded — what
 *  `scripts/gui-text-quality.mjs`'s readiness wait looks for (mirrors
 *  `auditLoadedMarkers`'s per-scene marker). For the four original kinds:
 *  the headline chip's own word, present the instant `data-sim-state`
 *  resolves, on the FIRST render (no network round-trip decides it), so
 *  waiting for it never races anything. For the four mission kinds: the NEW
 *  mission-line's own word (`simulatorMissionLine`'s `word`, mission-
 *  line.ts) — the same discipline, one level down: it is a snapshot of the
 *  fixture `chat`, present from the very first render too. */
export function simulatorSceneLoadedMarker(kind: SimulatorSceneKind): string {
  switch (kind) {
    case 'connecting':
      return 'CONNECTING';
    case 'live':
      return 'LIVE';
    case 'degraded':
      return 'RECONNECTING';
    case 'ended':
      return 'Session ended';
    case 'agent-running':
    case 'agent-small':
      return 'Running';
    case 'agent-approval':
      return 'Paused';
    case 'agent-done':
      return 'Done';
    case 'pair':
      return 'Pair';
  }
}

/** The window query a REAL launch (lib/open-simulator.ts) would pass, minus
 *  `session=` — see the file header for why that is what keeps every
 *  control-plane poll from firing. `*.example.com` / RFC 5737 discipline: no
 *  real host, no real exit. Every mission kind rides the SAME `fixture=live`
 *  query as the `live` scene itself (the connectivity axis, unrelated to
 *  which mission fixture drives the conversation) — see `simulatorSceneSimState`. */
function simulatorFixtureSearch(kind: SimulatorSceneKind): string {
  const params = new URLSearchParams({
    window: 'simulator',
    fixture: simulatorSceneSimState(kind),
    ws: 'wss://fixture.example.com/room',
    token: `fixture-token-${kind}`,
    name: 'iPhone 17',
    profile: 'tokyo sneakers',
    proxy: 'Residential JP #1',
    tz: 'Asia/Tokyo',
    cc: 'JP',
    base: 'https://api.example.com',
  });
  return `?${params.toString()}`;
}

// ─── round-2 stage B — the mission-axis fixtures ────────────────────────────

/** Fixture settings — apiKey/baseUrl only (the two fields `SimulatorAgentChat`
 *  actually reads: `aiReady`, and `baseUrl` for a capture fetch that never
 *  fires because every capture rides `captureSrc`). Matches `agent-chat-
 *  scenes.tsx`'s own `auditSettings()` shape one level down. */
function simulatorAgentSettings(): ContextType<typeof SettingsContext> {
  return {
    settings: {
      ...DEFAULT_SETTINGS,
      apiKey: 'ds_gallery_fixture',
      baseUrl: 'https://api.example.com',
    },
    loading: false,
    client: null,
    activeWorkspace: null,
    setActiveWorkspace: () => undefined,
    accountMe: null,
    refreshAccountMe: () => Promise.resolve(),
    authExpired: false,
    dismissAuthExpired: () => undefined,
    update: () => Promise.resolve(),
  };
}

/** A drawn "order confirmed" screenshot — the AnswerCard's figure in the
 *  `agent-done` scene, matching the mockup's own thumbnail: a checkmark, a
 *  brand mark, a couple of skeleton lines. `*.example.com` discipline: no
 *  text is drawn as DOM (an `<img>` resource only — see the AI view's own
 *  `productCaptureSvg`, which this mirrors one level down for the simulator's
 *  own purchase scenario). This is the SMALL thumbnail (AnswerCard's figure,
 *  `captureSrc`) — `orderConfirmedPageSvg` below is the FULL phone screen. */
function orderConfirmedThumbSvg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="520" viewBox="0 0 240 520">
    <rect width="240" height="520" fill="#ffffff"/>
    <text x="20" y="34" font-family="sans-serif" font-weight="800" font-size="11" letter-spacing="1" fill="#111111">EXAMPLE OUTFITTERS</text>
    <circle cx="120" cy="90" r="26" fill="#eafff2"/>
    <path d="M108 90l9 9 17-17" stroke="#0a7a4a" stroke-width="4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
    <text x="120" y="146" font-family="sans-serif" font-weight="800" font-size="15" fill="#111111" text-anchor="middle">Order confirmed</text>
    <rect x="20" y="176" width="200" height="8" rx="4" fill="#f0f0f0"/>
    <rect x="20" y="192" width="140" height="8" rx="4" fill="#f0f0f0"/>
  </svg>`;
}

/** The checkout page — the phone's own screen for `agent-approval`, matching
 *  the mockup's `.checkout-head`/`.order-card`×3/`.place-btn`. Same 402×874
 *  canvas and drawing style as `shopListingSvg`/`productCaptureSvg` above. */
function checkoutPageSvg(): string {
  const card = (y: number, h: number, eyebrow: string, body: string) => `
    <g>
      <rect x="20" y="${String(y)}" width="362" height="${String(h)}" rx="12" fill="#ffffff" stroke="#eeeeee"/>
      <text x="36" y="${String(y + 24)}" font-family="Helvetica,Arial" font-size="10" font-weight="700"
            letter-spacing="1" fill="#999999">${eyebrow}</text>
      ${body}
    </g>`;
  return `
<svg xmlns="http://www.w3.org/2000/svg" width="402" height="874" viewBox="0 0 402 874" role="presentation">
  <rect width="402" height="874" fill="#ffffff"/>
  <text x="34" y="46" font-family="Helvetica,Arial" font-size="15" font-weight="600" fill="#1a1d23">9:41</text>
  <rect x="0" y="66" width="402" height="46" fill="#ffffff"/>
  <text x="201" y="94" text-anchor="middle" font-family="Helvetica,Arial" font-size="12"
        letter-spacing="1.6" font-weight="700" fill="#1a1d23">EXAMPLE OUTFITTERS</text>
  <text x="20" y="152" font-family="Helvetica,Arial" font-size="21" font-weight="700" fill="#1a1d23">Checkout</text>
  ${card(
    178,
    92,
    'YOUR ORDER',
    `<rect x="36" y="${String(178 + 16)}" width="52" height="52" rx="8" fill="#eef1f7"/>
     <text x="102" y="${String(178 + 38)}" font-family="Helvetica,Arial" font-size="13" font-weight="600" fill="#1a1d23">Ridgeline Trail 2</text>
     <text x="102" y="${String(178 + 56)}" font-family="Helvetica,Arial" font-size="11" fill="#8a8f98">US 10 · Slate · Qty 1</text>
     <text x="346" y="${String(178 + 46)}" text-anchor="end" font-family="Helvetica,Arial" font-size="13" font-weight="700" fill="#1a1d23">$104.00</text>`,
  )}
  ${card(
    286,
    72,
    'DELIVER TO',
    `<rect x="36" y="${String(286 + 32)}" width="180" height="9" rx="4.5" fill="#eeeeee"/>
     <rect x="36" y="${String(286 + 48)}" width="120" height="9" rx="4.5" fill="#eeeeee"/>`,
  )}
  ${card(
    374,
    142,
    'PAY WITH',
    `<text x="36" y="${String(374 + 32)}" font-family="Helvetica,Arial" font-size="13" font-weight="600" fill="#1a1d23">Saved card •••• 4242</text>
     <text x="346" y="${String(374 + 32)}" text-anchor="end" font-family="Helvetica,Arial" font-size="12" font-weight="600" fill="#a83b4d">Change</text>
     <text x="36" y="${String(374 + 62)}" font-family="Helvetica,Arial" font-size="11" fill="#6b7280">Subtotal</text>
     <text x="346" y="${String(374 + 62)}" text-anchor="end" font-family="Helvetica,Arial" font-size="11" fill="#6b7280">$104.00</text>
     <text x="36" y="${String(374 + 82)}" font-family="Helvetica,Arial" font-size="11" fill="#6b7280">Delivery</text>
     <text x="346" y="${String(374 + 82)}" text-anchor="end" font-family="Helvetica,Arial" font-size="11" fill="#6b7280">Free</text>
     <text x="36" y="${String(374 + 110)}" font-family="Helvetica,Arial" font-size="14" font-weight="700" fill="#1a1d23">Total</text>
     <text x="346" y="${String(374 + 110)}" text-anchor="end" font-family="Helvetica,Arial" font-size="14" font-weight="700" fill="#1a1d23">$104.00</text>`,
  )}
  <rect x="20" y="534" width="362" height="50" rx="11" fill="#1a1d23"/>
  <text x="201" y="565" text-anchor="middle" font-family="Helvetica,Arial" font-size="14"
        font-weight="600" fill="#ffffff">Place order · $104.00</text>
  <rect x="0" y="812" width="402" height="62" fill="#f6f6f7"/>
  <rect x="62" y="826" width="278" height="32" rx="9" fill="#ffffff" stroke="#e2e4e8"/>
  <text x="201" y="847" text-anchor="middle" font-family="Helvetica,Arial" font-size="13"
        fill="#3f4652">shop.example.com/checkout</text>
</svg>`;
}

/** The order-confirmation page — the phone's own screen for `agent-done`,
 *  matching the mockup's `.done-head`/`.done-card`/`.track-btn`. */
function orderConfirmedPageSvg(): string {
  return `
<svg xmlns="http://www.w3.org/2000/svg" width="402" height="874" viewBox="0 0 402 874" role="presentation">
  <rect width="402" height="874" fill="#ffffff"/>
  <text x="34" y="46" font-family="Helvetica,Arial" font-size="15" font-weight="600" fill="#1a1d23">9:41</text>
  <circle cx="201" cy="146" r="30" fill="#eafff2"/>
  <path d="M188 146l10 10 20-20" stroke="#0a7a4a" stroke-width="4.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
  <text x="201" y="206" text-anchor="middle" font-family="Helvetica,Arial" font-size="19" font-weight="800" fill="#1a1d23">Order confirmed</text>
  <text x="201" y="230" text-anchor="middle" font-family="Helvetica,Arial" font-size="12" fill="#8a8f98">A receipt was sent to your account email.</text>
  <rect x="20" y="268" width="362" height="176" rx="12" fill="#ffffff" stroke="#eeeeee"/>
  <text x="36" y="300" font-family="Helvetica,Arial" font-size="12" fill="#3f4652">Order number</text>
  <text x="346" y="300" text-anchor="end" font-family="Helvetica,Arial" font-size="12" font-weight="700" fill="#1a1d23">DS-88214</text>
  <text x="36" y="330" font-family="Helvetica,Arial" font-size="12" fill="#3f4652">Ridgeline Trail 2 · US 10</text>
  <text x="346" y="330" text-anchor="end" font-family="Helvetica,Arial" font-size="12" font-weight="700" fill="#1a1d23">$104.00</text>
  <text x="36" y="360" font-family="Helvetica,Arial" font-size="12" fill="#3f4652">Delivery</text>
  <text x="346" y="360" text-anchor="end" font-family="Helvetica,Arial" font-size="12" font-weight="700" fill="#1a1d23">Free · 3–5 days</text>
  <text x="36" y="404" font-family="Helvetica,Arial" font-size="13" font-weight="700" fill="#1a1d23">Total</text>
  <text x="346" y="404" text-anchor="end" font-family="Helvetica,Arial" font-size="13" font-weight="700" fill="#1a1d23">$104.00</text>
  <rect x="20" y="470" width="362" height="48" rx="11" fill="#1a1d23"/>
  <text x="201" y="500" text-anchor="middle" font-family="Helvetica,Arial" font-size="13"
        font-weight="600" fill="#ffffff">Track order</text>
  <rect x="0" y="812" width="402" height="62" fill="#f6f6f7"/>
  <rect x="62" y="826" width="278" height="32" rx="9" fill="#ffffff" stroke="#e2e4e8"/>
  <text x="201" y="847" text-anchor="middle" font-family="Helvetica,Arial" font-size="13"
        fill="#3f4652">shop.example.com/order/88214</text>
</svg>`;
}

/** Session fixture the mission-axis kinds share — `mode`/`pair_mode_state`
 *  are the ONE field `SimulatorWindow`'s `controlModeOverride`/
 *  `pairKindOverride` read (see that file's own header on why one fixture
 *  object drives both the Mode switch and the conversation, never two that
 *  could disagree). */
function simulatorAgentSession(
  id: string,
  mode: AgentSession['mode'],
  pairKind: string | null,
): AgentSession {
  return {
    id,
    account_id: 'acc_gallery_fixture',
    driftstack_session_id: null,
    status: 'active',
    closed_reason: null,
    token_budget_total: 120_000,
    token_budget_remaining: 98_400,
    transcript_length: 4,
    closed_at: null,
    created_by_user_id: null,
    mode,
    model: 'claude-sonnet-5',
    stop_on_exit_ip_change: false,
    pair_mode_state: pairKind === null ? null : { kind: pairKind },
    created_at: '2026-06-15T06:37:00.000Z',
    updated_at: '2026-06-15T06:41:40.000Z',
  };
}

const DONE_TASK =
  'Buy the Ridgeline Trail 2 in US 10 from shop.example.com with my saved card, then tell me the order number.';
const DONE_ANSWER =
  'Your order is confirmed. Order number DS-88214, total $104.00, arriving free in 3–5 business days.';
const DONE_CAPTURE_ID = 'cap_sim_gallery_order_confirmed';
const DONE_LABEL_STORE = 'Opened the store';
const DONE_LABEL_CHECKOUT = 'Chose size US 10 and checked out';
const DONE_LABEL_PLACE = 'Place the order';
const DONE_LABEL_READ = 'Read the order number';
const DONE_LABELS: ReadonlyArray<string> = [
  DONE_LABEL_STORE,
  DONE_LABEL_CHECKOUT,
  DONE_LABEL_PLACE,
  DONE_LABEL_READ,
];
const DONE_STEPS: ReadonlyArray<AgentIntentResult> = [
  {
    kind: 'success',
    intent: { kind: 'navigate', url: 'https://shop.example.com/checkout' },
    summary: DONE_LABEL_STORE,
  },
  {
    kind: 'success',
    intent: { kind: 'interact', action: 'tap', selector: '#checkout' },
    summary: DONE_LABEL_CHECKOUT,
  },
  {
    kind: 'success',
    intent: { kind: 'interact', action: 'tap', selector: '#place-order' },
    summary: DONE_LABEL_PLACE,
  },
  {
    kind: 'success',
    intent: { kind: 'capture', capture: 'screenshot' },
    summary: DONE_LABEL_READ,
    captureId: DONE_CAPTURE_ID,
  },
];
const DONE_STEP_MS: ReadonlyArray<number | null> = [2900, 6100, 1100, 1600];
const DONE_ELAPSED_MS = 86_000; // matches the mockup's "Finished · 4 of 4 steps · 1:26"

/**
 * The fixture for one mission-axis scene.
 *
 * ⛔ TWO DIFFERENT "screens", NEVER CONFUSED. `phoneStandIn` is the PHONE's
 * own screen — `SimulatorWindow`'s pre-existing top-level `standIn` prop
 * (stage 1's own gallery seam), which `agentPanelGalleryFixture` mounts into
 * the video panel. `captureSrc` is the small screenshot a FINISHED STEP
 * captured — `AgentChatContextValue.captureSrc`, read by `AnswerCard`'s
 * figure inside the conversation panel, a world away from the phone. Handing
 * the phone's own screen to the wrong prop would put the AnswerCard's small
 * receipt drawing where the live video goes, or vice versa.
 *
 * `now` is the harness's frozen clock (`Date.now()`, already patched by
 * gallery.tsx before any scene renders — see that module's own
 * `freezeHarnessClock`).
 */
function simulatorAgentSceneFixture(
  kind: 'agent-running' | 'agent-approval' | 'agent-done' | 'pair' | 'agent-small',
  now: number,
): {
  chat: UseAgentChatResult;
  phoneStandIn: ReturnType<typeof standInScreen>;
  captureSrc?: string;
} {
  switch (kind) {
    case 'agent-running':
    case 'agent-small':
      return {
        chat: agentChatSceneFixture('running', now).chat as UseAgentChatResult,
        phoneStandIn: standInScreen(shopListingSvg()),
      };
    case 'agent-approval':
      return {
        chat: agentChatSceneFixture('approval', now).chat as UseAgentChatResult,
        phoneStandIn: standInScreen(checkoutPageSvg()),
      };
    case 'agent-done': {
      const session = simulatorAgentSession('agt_sim_gallery_done', 'ai', null);
      const chat: UseAgentChatResult = {
        turns: [
          { id: 1, role: 'user', text: DONE_TASK },
          {
            id: 2,
            role: 'agent',
            response: {
              kind: 'plan-executed',
              session,
              intents: DONE_STEPS.map((r) => r.intent),
              results: DONE_STEPS,
              ok: true,
              answer: DONE_ANSWER,
            },
            plan: { labels: DONE_LABELS },
            timing: { elapsedMs: DONE_ELAPSED_MS, stepMs: DONE_STEP_MS },
          },
        ],
        session,
        sending: false,
        liveSteps: [],
        livePhase: null,
        livePlan: null,
        liveStepIndex: null,
        liveAnswer: null,
        error: null,
        pendingConfirmation: null,
        deniedTurnIds: new Set<number>(),
        approvedTurnIds: new Set<number>(),
        send: () => Promise.resolve(true),
        lastSendKeptMessage: () => false,
        approve: () => Promise.resolve(),
        deny: () => undefined,
        reset: () => undefined,
        cancel: () => undefined,
        stopping: false,
        stoppedTurnStillRunning: false,
        restore: () => undefined,
        adopt: () => undefined,
        adopting: false,
        adoptError: null,
        restoredHistoryCount: 0,
        restoredSessionId: null,
      };
      return {
        chat,
        phoneStandIn: standInScreen(orderConfirmedPageSvg()),
        captureSrc: svgDataUri(orderConfirmedThumbSvg()),
      };
    }
    case 'pair': {
      // The SAME browsing task as `agent-running`, earlier in its run (the
      // mockup's own pair scene: "Step 2 of 6", "Searching the store…") —
      // one fixture, not a second transcript invented for this state.
      const runningChat = agentChatSceneFixture('running', now).chat as UseAgentChatResult;
      const session = simulatorAgentSession('agt_sim_gallery_pair', 'pair', 'ai-driving');
      const chat: UseAgentChatResult = {
        ...runningChat,
        session,
        liveStepIndex: 1,
        liveSteps: runningChat.liveSteps.slice(0, 1),
        livePhase: 'Searching the store…',
        liveStartedAt: now - 14_000,
        liveStepMs: runningChat.liveStepMs?.slice(0, 1),
      };
      return { chat, phoneStandIn: standInScreen(shopListingSvg()) };
    }
  }
}

/**
 * Mounts the real `<SimulatorWindow>` in one of its eight fixtures — the
 * four connectivity states (unchanged since stage 1) and the four round-2
 * stage B mission states. The query is set BEFORE `<SimulatorWindow>`
 * renders — this function's own body runs first; React does not call a
 * child component's function until after its parent's returns — exactly
 * like `simulator-window.test.tsx`'s own `pushState`-then-`render`.
 * `SimulatorWindow` reads `window.location.search` in a LAZY `useState`
 * initializer, which runs exactly once, at that first mount.
 */
export function SimulatorStateScene({ kind }: { kind: SimulatorSceneKind }): JSX.Element {
  const search = simulatorFixtureSearch(kind);
  if (window.location.search !== search) window.history.replaceState({}, '', search);
  const mission = isAgentMissionKind(kind);
  // One stand-in for the whole scene, like every AI-view audit scene: a phone
  // has one screenshot in it, not a lookup table. The four connectivity
  // scenes draw the plain shop page; each mission scene draws the page that
  // scene of the mockup shows (search results / checkout / order confirmed).
  const shopStandIn = useMemo(() => standInScreen(shopListingSvg()), []);
  const agentFixture = useMemo(
    () => (isAgentMissionKind(kind) ? simulatorAgentSceneFixture(kind, Date.now()) : null),
    [kind],
  );
  const agentChatOverride = useMemo<Partial<AgentChatContextValue> | undefined>(() => {
    if (agentFixture === null) return undefined;
    const value: Partial<AgentChatContextValue> = { chat: agentFixture.chat };
    if (agentFixture.captureSrc !== undefined) value.captureSrc = agentFixture.captureSrc;
    return value;
  }, [agentFixture]);
  const settingsOverride = useMemo(
    () => (mission ? simulatorAgentSettings() : undefined),
    [mission],
  );
  return (
    <RecordingsProvider>
      <SimulatorWindow
        standIn={agentFixture?.phoneStandIn ?? shopStandIn}
        agentChatOverride={agentChatOverride}
        settingsOverride={settingsOverride}
      />
    </RecordingsProvider>
  );
}
