// The AI view's seven extra audit scenes — every state a customer can be in.
//
// WHY THIS EXISTS. `audit-agent-chat` renders the view with no turns and no
// session, so until now the text-quality gate (scripts/gui-text-quality.mjs)
// and the privacy scan (tests/unit/marketing-scenes.test.tsx) had only ever
// measured the AI view EMPTY. Everything a customer actually looks at — a plan
// running, an approval waiting, an answer landing, a failure, a stop in flight
// — was unmeasured, and the first thing the gate found when these scenes
// existed was a status pill at 2.47:1 that had shipped for months.
//
// Reaching those states for real needs an account, a key, a server, a session
// and an iPhone on the other end of a live stream. So the view is driven
// through the three seams spec §8 defines, and NOTHING here is a replica:
//
//   • `AgentChatProvider value={…}` — a fixture `UseAgentChatResult` published
//     through the REAL context, so the REAL `AgentChatView` renders it;
//   • `standIn` — an IMAGE mounted in the live view's screen instead of a
//     LiveKit token, room and poll;
//   • `captureSrc` — an image for the screenshot a plan step captured.
//
// ⛔ THE STAND-INS ARE IMAGES, NOT MARKUP. A drawn page has 9px grey type on it
// — that is what a shop page looks like — and drawn as DOM it would be measured
// as the app's own copy: the gate's size floor, its contrast rule and its
// truncation rule would all fire on a picture of a web page. `aria-hidden` does
// not exempt size. Inside an `<img src="data:image/svg+xml,…">` the drawing is
// an image resource: no text nodes, no attributes, nothing for a scanner to
// read, and it still renders crisply at any device pixel ratio.
//
// PRIVACY (the scan reads every text node and the title/aria-label/placeholder/
// value/alt attributes of every scene): hosts are *.example.com, IPs are RFC
// 5737 TEST-NET, prices and product names are invented, and no copy here names
// how the product is built — no infrastructure words, no ports, no internal ids.
//
// DETERMINISM: every timestamp is derived from the `now` this module is handed
// (gallery.tsx's frozen clock), never from `Date.now()`. Nothing here imports
// gallery.tsx, so the import cycle that audit-scenes.tsx documents does not
// grow a third member.

import { type ReactNode } from 'react';
import type { AgentIntent, AgentIntentResult, AgentSession, AgentUsage } from '@driftstack/sdk';
import type { ChatTurn, PendingConfirmation, UseAgentChatResult } from '../lib/use-agent-chat';

/** The states, named for what the customer is doing — not for the hook field
 *  that produces them. `audit-agent-chat-<kind>` is the scene name.
 *
 *  ⛔ `small` IS NOT AN EIGHTH STATE, IT IS A WINDOW. It renders the RUNNING
 *  fixture at the 960x600 Tauri minimum (its stage size is declared in
 *  `auditDefaultSizes`), because stage 6 left the 44px narrow tier measured by
 *  nothing: `gui-text-quality.mjs` renders each scene at its OWN declared size
 *  and never passes `?stage=`, so a whole tier — the strip, the 44px bar, the
 *  count badge, the flat locked pickers, the 252px stage — was hand-checked
 *  once and then unguarded. A scene with its own small stage is what puts it in
 *  CI, and it costs one entry in each of the four registries. */
export type AgentChatSceneKind =
  | 'nokey'
  | 'planning'
  | 'running'
  | 'approval'
  | 'done'
  | 'trouble'
  | 'stopping'
  | 'small';

export const AGENT_CHAT_SCENE_KINDS: ReadonlyArray<AgentChatSceneKind> = [
  'nokey',
  'planning',
  'running',
  'approval',
  'done',
  'trouble',
  'stopping',
  'small',
];

/** What the live view's token fetch should do for a scene that has no stand-in.
 *  `pending` leaves the pane on its "Starting the live view…" state (a session
 *  is coming up); `failing` rejects the way a dropped connection does, which is
 *  the only way to render `WatchPlaceholder`'s error branch and its `Retry`
 *  button — a pinned accessible name no scene had ever shown. */
export type LiveTokenBehaviour = 'pending' | 'failing';

export interface AgentChatSceneFixture {
  /** Published through the real provider. Undefined for `nokey`, which is
   *  reachable with settings alone and must stay reachable that way: it is the
   *  state the `getByRole('status')` uniqueness pin is written against. */
  chat?: UseAgentChatResult;
  /** null puts the view behind its "Connect your API key" gate. */
  apiKey: string | null;
  standIn?: ReactNode;
  captureSrc?: string;
  liveToken?: LiveTokenBehaviour;
  /** Fixture strings that must be READ BACK off the render for the scene to
   *  count as loaded — see auditLoadedMarkers. Scene-specific ones first; the
   *  async ones (profiles, saved chats) are appended by the caller, so the wait
   *  ends on the slowest thing, not the fastest. */
  markers: ReadonlyArray<string>;
}

// ─── the drawn pages ─────────────────────────────────────────────────────────

/** An SVG drawing as an `<img>` source. Percent-encoded rather than base64 so
 *  the source in this file is the thing a reviewer reads, while the DOM still
 *  carries one opaque attribute value with no readable text in it. */
function svgDataUri(svg: string): string {
  return `data:image/svg+xml,${encodeURIComponent(svg.replace(/\s+/g, ' ').trim())}`;
}

/** The shop listing the AI is working on — what a customer sees on the phone
 *  while a task runs. 402x874 is the iPhone screen the stream really carries. */
function shopListingSvg(): string {
  const card = (x: number, y: number, fill: string, shoe: string, name: string, price: string) => `
    <g>
      <rect x="${String(x)}" y="${String(y)}" width="176" height="150" rx="10" fill="${fill}"/>
      <path d="M${String(x + 30)} ${String(y + 104)} c8 -24 28 -36 48 -31 l14 15 c17 6 36 13 47 23 c6 5 4 14 -4 14 l-105 0 z"
            fill="${shoe}" opacity="0.92"/>
      <rect x="${String(x + 28)}" y="${String(y + 118)}" width="112" height="7" rx="3.5" fill="${shoe}" opacity="0.45"/>
      <path d="M${String(x + 52)} ${String(y + 96)} l14 9 M${String(x + 62)} ${String(y + 88)} l14 9"
            stroke="#ffffff" stroke-width="2" stroke-linecap="round" opacity="0.65" fill="none"/>
      <text x="${String(x + 4)}" y="${String(y + 176)}" font-family="Helvetica,Arial" font-size="13"
            font-weight="600" fill="#1a1d23">${name}</text>
      <text x="${String(x + 4)}" y="${String(y + 195)}" font-family="Helvetica,Arial" font-size="12"
            fill="#b4820f">★ 4.7 <tspan fill="#6b7280">(1,284)</tspan></text>
      <text x="${String(x + 4)}" y="${String(y + 214)}" font-family="Helvetica,Arial" font-size="13"
            font-weight="600" fill="#1a1d23">${price}</text>
    </g>`;
  return `
<svg xmlns="http://www.w3.org/2000/svg" width="402" height="874" viewBox="0 0 402 874" role="presentation">
  <rect width="402" height="874" fill="#ffffff"/>
  <text x="34" y="46" font-family="Helvetica,Arial" font-size="15" font-weight="600" fill="#1a1d23">9:41</text>
  <rect x="318" y="34" width="26" height="12" rx="3" fill="#1a1d23" opacity="0.75"/>
  <rect x="352" y="32" width="22" height="14" rx="4" fill="none" stroke="#1a1d23" stroke-width="1.5" opacity="0.6"/>
  <rect x="0" y="66" width="402" height="52" fill="#f6f6f7"/>
  <rect x="20" y="84" width="20" height="2.5" rx="1.25" fill="#1a1d23"/>
  <rect x="20" y="91" width="20" height="2.5" rx="1.25" fill="#1a1d23"/>
  <rect x="20" y="98" width="20" height="2.5" rx="1.25" fill="#1a1d23"/>
  <text x="201" y="98" text-anchor="middle" font-family="Helvetica,Arial" font-size="13"
        letter-spacing="1.6" font-weight="700" fill="#1a1d23">EXAMPLE OUTFITTERS</text>
  <rect x="362" y="82" width="20" height="18" rx="3" fill="none" stroke="#1a1d23" stroke-width="1.5"/>
  <rect x="20" y="134" width="362" height="38" rx="10" fill="#f1f2f4"/>
  <circle cx="42" cy="153" r="6" fill="none" stroke="#6b7280" stroke-width="1.5"/>
  <text x="58" y="158" font-family="Helvetica,Arial" font-size="14" fill="#3f4652">trail running shoes</text>
  <rect x="20" y="186" width="84" height="28" rx="14" fill="#1a1d23"/>
  <text x="62" y="205" text-anchor="middle" font-family="Helvetica,Arial" font-size="12" fill="#ffffff">Top rated</text>
  <rect x="112" y="186" width="92" height="28" rx="14" fill="none" stroke="#d3d6db"/>
  <text x="158" y="205" text-anchor="middle" font-family="Helvetica,Arial" font-size="12" fill="#3f4652">Under $120</text>
  <rect x="212" y="186" width="56" height="28" rx="14" fill="none" stroke="#d3d6db"/>
  <text x="240" y="205" text-anchor="middle" font-family="Helvetica,Arial" font-size="12" fill="#3f4652">Size</text>
  <rect x="276" y="186" width="70" height="28" rx="14" fill="none" stroke="#d3d6db"/>
  <text x="311" y="205" text-anchor="middle" font-family="Helvetica,Arial" font-size="12" fill="#3f4652">Colour</text>
  <text x="20" y="240" font-family="Helvetica,Arial" font-size="12" fill="#6b7280">24 results</text>
  ${card(20, 254, '#eef1f7', '#3d4a6b', 'Ridgeline Trail 2', '$104.00')}
  ${card(206, 254, '#fbeee7', '#b4552c', 'Cinder Peak GT', '$118.00')}
  ${card(20, 478, '#eef4ee', '#3f6b45', 'Mossline Runner', '$89.00')}
  ${card(206, 478, '#efecf7', '#524a86', 'Switchback Lite', '$96.00')}
  <rect x="20" y="702" width="176" height="96" rx="10" fill="#f7f2e8"/>
  <rect x="206" y="702" width="176" height="96" rx="10" fill="#e9f1f3"/>
  <rect x="0" y="812" width="402" height="62" fill="#f6f6f7"/>
  <rect x="62" y="826" width="278" height="32" rx="9" fill="#ffffff" stroke="#e2e4e8"/>
  <text x="201" y="847" text-anchor="middle" font-family="Helvetica,Arial" font-size="13"
        fill="#3f4652">shop.example.com</text>
</svg>`;
}

/** The product page the AI captured on its screenshot step — what the thumbnail
 *  under a finished step shows. */
function productCaptureSvg(): string {
  return `
<svg xmlns="http://www.w3.org/2000/svg" width="402" height="874" viewBox="0 0 402 874" role="presentation">
  <rect width="402" height="874" fill="#ffffff"/>
  <rect x="0" y="0" width="402" height="56" fill="#f6f6f7"/>
  <text x="201" y="35" text-anchor="middle" font-family="Helvetica,Arial" font-size="12"
        letter-spacing="1.6" font-weight="700" fill="#1a1d23">EXAMPLE OUTFITTERS</text>
  <rect x="0" y="56" width="402" height="360" fill="#eef1f7"/>
  <path d="M92 306 c20 -58 68 -86 116 -75 l34 36 c41 15 87 32 113 56 c14 13 9 33 -10 33 l-253 0 z" fill="#3d4a6b"/>
  <rect x="88" y="336" width="272" height="16" rx="8" fill="#3d4a6b" opacity="0.45"/>
  <path d="M150 276 l34 22 M174 254 l34 22" stroke="#ffffff" stroke-width="5" stroke-linecap="round" opacity="0.6" fill="none"/>
  <text x="24" y="460" font-family="Helvetica,Arial" font-size="21" font-weight="700" fill="#1a1d23">Ridgeline Trail 2</text>
  <text x="24" y="490" font-family="Helvetica,Arial" font-size="14" fill="#b4820f">★ 4.7 <tspan fill="#6b7280">(1,284 reviews)</tspan></text>
  <text x="24" y="532" font-family="Helvetica,Arial" font-size="26" font-weight="700" fill="#1a1d23">$104.00</text>
  <text x="24" y="570" font-family="Helvetica,Arial" font-size="13" fill="#2f7a4e">In stock · US 10</text>
  <rect x="24" y="592" width="60" height="42" rx="8" fill="none" stroke="#d3d6db"/>
  <text x="54" y="619" text-anchor="middle" font-family="Helvetica,Arial" font-size="14" fill="#3f4652">9</text>
  <rect x="94" y="592" width="60" height="42" rx="8" fill="#1a1d23"/>
  <text x="124" y="619" text-anchor="middle" font-family="Helvetica,Arial" font-size="14" fill="#ffffff">10</text>
  <rect x="164" y="592" width="60" height="42" rx="8" fill="none" stroke="#d3d6db"/>
  <text x="194" y="619" text-anchor="middle" font-family="Helvetica,Arial" font-size="14" fill="#3f4652">11</text>
  <rect x="24" y="658" width="354" height="50" rx="10" fill="#1a1d23"/>
  <text x="201" y="689" text-anchor="middle" font-family="Helvetica,Arial" font-size="15"
        font-weight="600" fill="#ffffff">Add to cart</text>
  <rect x="24" y="732" width="250" height="10" rx="5" fill="#eceef1"/>
  <rect x="24" y="754" width="330" height="10" rx="5" fill="#eceef1"/>
  <rect x="24" y="776" width="188" height="10" rx="5" fill="#eceef1"/>
  <rect x="0" y="812" width="402" height="62" fill="#f6f6f7"/>
  <rect x="62" y="826" width="278" height="32" rx="9" fill="#ffffff" stroke="#e2e4e8"/>
  <text x="201" y="847" text-anchor="middle" font-family="Helvetica,Arial" font-size="13"
        fill="#3f4652">shop.example.com</text>
</svg>`;
}

/** The image mounted in the live view's screen. `alt=""` + `aria-hidden`: it is
 *  a picture of the page the log already describes in words, so announcing it
 *  again would be noise — and the caption under the phone (stage 4) is the real
 *  text for what the device is doing. */
function standInScreen(svg: string): ReactNode {
  return <img src={svgDataUri(svg)} alt="" aria-hidden="true" className="ai-standin" />;
}

// ─── the conversation ────────────────────────────────────────────────────────

const TASK =
  'Go to shop.example.com, search for trail running shoes, open the best-rated pair under $120, and tell me the price and whether US size 10 is in stock. Screenshot the product page.';
const CHECKOUT_TASK = 'Add the Ridgeline Trail 2 in US 10 to the cart and place the order.';

const PLAN_LABELS: ReadonlyArray<string> = [
  'Open the store',
  'Accept the cookie banner',
  'Search the store',
  'Open the best-rated pair under $120',
  'Read the price and size availability',
  'Screenshot the product page',
];

/** §7 — what each planned step IS, which is what puts a drawing on a row that
 *  has not run yet. Aligned with PLAN_LABELS; `null` would render the hollow
 *  node, and the scene deliberately has none so the gate measures the icons. */
const PLAN_KINDS: ReadonlyArray<string | null> = [
  'navigate',
  'tap',
  'type',
  'tap',
  'read',
  'capture',
];

/** §7 — the turn looked at the page after its third step and planned the rest
 *  from what it saw. The view draws "Looked at the page and updated the plan"
 *  at that boundary, which is what a turn of several segments really did. */
const REPLAN_AT: ReadonlyArray<number> = [3];

/** §7 — how long each step took, in ms, as a client watching the stream would
 *  have measured it. Deliberately UNEVEN: a real turn's steps are not the same
 *  length, and a fixture of identical numbers would hide a column that does not
 *  line up. The done scene's total (0:41) is the elapsed clock, not their sum —
 *  a turn also spends time planning and reading back. */
const STEP_MS: ReadonlyArray<number | null> = [3100, 1400, 5200, 14_600, 6000, 1200];

/** The done turn's whole wall time, matching the mockup's "Finished · 6 of 6
 *  steps · 0:41". */
const DONE_ELAPSED_MS = 41_000;

/** A step that finished. The INTENT matters as much as the summary now: stage 2
 *  derives the mono fact chip from it (a host for a navigation, the text that
 *  was typed, "1 image" for a capture), so a fixture whose every step is a
 *  `wait` would render a timeline with no facts on it and the gate would
 *  measure a chip that never appears. */
function ok(summary: string, captureId?: string): AgentIntentResult {
  return captureId === undefined
    ? { kind: 'success', intent: { kind: 'wait', condition: 'idle' }, summary }
    : {
        kind: 'success',
        intent: { kind: 'capture', capture: 'screenshot' },
        summary,
        captureId,
      };
}

/** A finished navigation — its chip is the host it landed on. */
function went(url: string, summary: string): AgentIntentResult {
  return { kind: 'success', intent: { kind: 'navigate', url }, summary };
}

/** A finished `type` step — its chip is the text that was typed, in quotes. */
function typed(value: string, summary: string): AgentIntentResult {
  return {
    kind: 'success',
    intent: { kind: 'interact', action: 'type', selector: '#q', value },
    summary,
  };
}

/** A step that was PLANNED and never ran, so the turn can say "N later steps
 *  didn't run" — `intents` is longer than `results` exactly when a plan was
 *  abandoned part-way, which is the shape a failed and a gated turn both have. */
const NOT_RUN: ReadonlyArray<AgentIntent> = [
  { kind: 'interact', action: 'tap', selector: '#confirm' },
  { kind: 'capture', capture: 'screenshot' },
];

const USAGE: AgentUsage = {
  decomposer_kind: 'claude',
  anthropic_input_tokens: 2140,
  anthropic_output_tokens: 610,
  cost_usd_cents: 2.3,
  model: 'claude-sonnet-5',
};

/** A session the view can describe honestly. `liveness` is what drives the
 *  header pill, so each scene names the beat it is really in rather than
 *  letting the status field speak for a browser that may be gone. */
function session(
  now: number,
  over: Partial<AgentSession> & Pick<AgentSession, 'id'>,
): AgentSession {
  return {
    account_id: 'acc_audit_fixture',
    driftstack_session_id: null,
    status: 'active',
    closed_reason: null,
    token_budget_total: 120_000,
    token_budget_remaining: 98_400,
    transcript_length: 4,
    closed_at: null,
    created_by_user_id: null,
    mode: 'ai',
    model: 'claude-sonnet-5',
    stop_on_exit_ip_change: false,
    pair_mode_state: null,
    created_at: new Date(now - 5 * 60_000).toISOString(),
    updated_at: new Date(now - 20_000).toISOString(),
    ...over,
  };
}

/** What a live session reports about the exit it is browsing through. Stage 4
 *  puts this under the phone ("Browsing from Frankfurt, DE"); today nothing
 *  reads it, and it rides along so the scene is already correct when that
 *  lands. The address is RFC 5737 documentation space. */
function capabilityReport(now: number): NonNullable<AgentSession['capability_report']> {
  return {
    timestamp: new Date(now - 20_000).toISOString(),
    manual_input_available: false,
    streaming_state: 'live',
    egress_state: 'live',
    proxy_kind: 'socks5',
    proxy_udp_supported: true,
    transport_mode_requested: 'h2-and-h3',
    transport_mode_active: 'h2-and-h3',
    safeguards_passed: true,
    exit_ip: '203.0.113.42',
    exit_country: 'DE',
    exit_timezone: 'Europe/Berlin',
    webrtc_candidate_ips: ['203.0.113.42'],
    observed_at: new Date(now - 20_000).toISOString(),
  };
}

/** Every field of the hook's contract, so a scene is a COMPLETE
 *  `UseAgentChatResult` and not a partial double. The view optional-chains the
 *  newer fields for the benefit of the ~12 unit tests that mock this module
 *  with partials; a scene that relied on that would be measuring a gentler tree
 *  than the app renders. */
function baseChat(): UseAgentChatResult {
  return {
    turns: [],
    session: null,
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
    send: () => Promise.resolve(false),
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
}

const CAPTURE_ID = 'cap_audit_product_page';

function pending(turnId: number): PendingConfirmation {
  return { turnId, category: 'purchase', matchedText: 'Place order · $104.00' };
}

const ANSWER =
  'The Ridgeline Trail 2 is the best-rated pair under $120 at $104.00, and US size 10 is in stock. I have saved a screenshot of the product page below.';

const RUNNING_STEPS: ReadonlyArray<AgentIntentResult> = [
  went('https://shop.example.com/', 'Opened the store'),
  ok('Accepted the cookie banner'),
  typed('trail running shoes', 'Searched the store'),
];

const DONE_STEPS: ReadonlyArray<AgentIntentResult> = [
  ...RUNNING_STEPS,
  ok('Opened Ridgeline Trail 2 — the best-rated pair under $120'),
  ok('Read the price ($104.00) and confirmed US size 10 is in stock'),
  ok('Captured a screenshot of the product page', CAPTURE_ID),
];

/** The captions the server wrote for the checkout plan — one per step, in the
 *  order they ran, plus the one that never did. */
const APPROVAL_LABELS: ReadonlyArray<string> = [
  'Opened the store',
  'Opened Ridgeline Trail 2 in US size 10',
  'Added it to the cart',
  'Opened the checkout and filled in the saved delivery address',
  'Place the order',
  'Read the order number',
];

const APPROVAL_STEPS: ReadonlyArray<AgentIntentResult> = [
  went('https://shop.example.com/checkout', 'Opened the store'),
  ok('Opened Ridgeline Trail 2 in US size 10'),
  ok('Added it to the cart'),
  ok('Opened the checkout and filled in the saved delivery address'),
  {
    kind: 'confirmation_required',
    intent: { kind: 'interact', action: 'tap', selector: '#place-order' },
    category: 'purchase',
    matchedText: 'Place order · $104.00',
  },
];

const TROUBLE_STEPS: ReadonlyArray<AgentIntentResult> = [
  went('https://shop.example.com/', 'Opened the store'),
  ok('Opened Ridgeline Trail 2 in US size 10'),
  {
    kind: 'failure',
    intent: { kind: 'interact', action: 'tap', selector: '#add-to-cart' },
    reason: 'A newsletter pop-up was covering the Add to cart button.',
    diagnosis: { category: 'element_covered', retryable: true },
  },
];

const INTERRUPTED_REASON =
  'The connection to the browser dropped before the task finished. The steps above are everything that ran.';

function turn(id: number, text: string): ChatTurn {
  return { id, role: 'user', text };
}

/** The fixture for one scene. `now` is the harness's frozen clock. */
export function agentChatSceneFixture(
  kind: AgentChatSceneKind,
  now: number,
): AgentChatSceneFixture {
  const chat = baseChat();
  switch (kind) {
    case 'nokey':
      // No chat override at all: an empty chat with no key is reachable from
      // settings alone, and keeping it that way is the point — it is the state
      // the "exactly one role=status" uniqueness pin is written against, and a
      // fixture chat could quietly add a second one.
      return { apiKey: null, markers: ['Connect your API key to run automations'] };

    case 'planning':
      return {
        apiKey: 'ds_live_example',
        liveToken: 'pending',
        chat: {
          ...chat,
          turns: [turn(1, TASK)],
          sending: true,
          livePhase: 'Planning…',
          session: session(now, {
            id: 'agt_audit_planning',
            status: 'provisioning',
            liveness: { state: 'provisioning', fresh: true },
          }),
        },
        markers: [TASK, 'Planning…', 'Starting the live view…'],
      };

    // ⛔ THE SAME FIXTURE AS `running`, AT ANOTHER WINDOW SIZE. It is a window,
    // not a state (see AgentChatSceneKind): what it measures is the 44px narrow
    // tier — the rail strip, the 44px bar, the count badge, the flat locked
    // pickers, the 252px stage and the place chip that moves up into the HUD —
    // which no gate could see before, because the text gate renders every scene
    // at its own declared size and `auditDefaultSizes` gave them all 1280x800.
    // Its stage is 960x600 there, so the default gate run covers it with no
    // flag and no script edit.
    case 'small':
    case 'running':
      return {
        apiKey: 'ds_live_example',
        standIn: standInScreen(shopListingSvg()),
        chat: {
          ...chat,
          turns: [turn(1, TASK)],
          sending: true,
          livePhase: 'Looking at the page…',
          livePlan: {
            labels: PLAN_LABELS,
            total: PLAN_LABELS.length,
            kinds: PLAN_KINDS,
            replanAt: REPLAN_AT,
          },
          liveSteps: RUNNING_STEPS,
          liveStepIndex: 3,
          // §7 — the clock reads 0:48 against the harness's frozen now, which
          // is what the mockup's running scene shows.
          liveStartedAt: now - 48_000,
          liveStepMs: STEP_MS.slice(0, RUNNING_STEPS.length),
          session: session(now, {
            id: 'agt_audit_running',
            liveness: { state: 'active', fresh: true },
            capability_report: capabilityReport(now),
          }),
        },
        markers: [
          TASK,
          'Looking at the page…',
          'Searched the store',
          'Looked at the page and updated the plan',
          // The live plan's glyph and its label are separate text nodes (the
          // pinned `'▶ ' + label` is a textContent, not one node), so the marker
          // is the label — what a customer reads — and never the glyph.
          'Open the best-rated pair under $120',
          'Screenshot the product page',
        ],
      };

    case 'approval':
      return {
        apiKey: 'ds_live_example',
        standIn: standInScreen(shopListingSvg()),
        chat: {
          ...chat,
          turns: [
            turn(1, CHECKOUT_TASK),
            {
              id: 2,
              role: 'agent',
              response: {
                kind: 'plan-executed',
                session: session(now, { id: 'agt_audit_approval' }),
                intents: [...APPROVAL_STEPS.map((r) => r.intent), ...NOT_RUN.slice(0, 1)],
                results: APPROVAL_STEPS,
                ok: false,
                usage: USAGE,
              },
              // §7 — the server's own captions, kept at settle. Without them
              // the gated row and the stage caption both fall back to
              // `humanIntentLabel`, which can only honestly say "Tap something
              // on the page": it may never name the selector, and the selector
              // is all the intent carries. The real server sends these, and the
              // whole point of a scene is to render what a customer sees.
              plan: { labels: [...APPROVAL_LABELS] },
            },
          ],
          pendingConfirmation: pending(2),
          session: session(now, {
            id: 'agt_audit_approval',
            liveness: { state: 'idle', fresh: true },
            capability_report: capabilityReport(now),
          }),
        },
        markers: [
          CHECKOUT_TASK,
          'Opened the checkout and filled in the saved delivery address',
          'Place the order',
          'Place order · $104.00',
        ],
      };

    case 'done':
      return {
        apiKey: 'ds_live_example',
        standIn: standInScreen(shopListingSvg()),
        captureSrc: svgDataUri(productCaptureSvg()),
        chat: {
          ...chat,
          turns: [
            turn(1, TASK),
            {
              id: 2,
              role: 'agent',
              response: {
                kind: 'plan-executed',
                session: session(now, { id: 'agt_audit_done' }),
                intents: DONE_STEPS.map((r) => r.intent),
                results: DONE_STEPS,
                ok: true,
                answer: ANSWER,
                usage: USAGE,
              },
              // §7 — the captions, the kinds, the re-plan boundary and the
              // timings the live turn announced, kept across the settle. This
              // is the scene that proves the WITH-timing render; every other
              // settled turn in this file deliberately carries none, which is
              // the WITHOUT-timing render measured in the same gate run.
              plan: { labels: PLAN_LABELS, kinds: PLAN_KINDS, replanAt: REPLAN_AT },
              timing: { elapsedMs: DONE_ELAPSED_MS, stepMs: STEP_MS },
            },
          ],
          session: session(now, {
            id: 'agt_audit_done',
            liveness: { state: 'idle', fresh: true },
            capability_report: capabilityReport(now),
          }),
        },
        markers: [
          TASK,
          ANSWER,
          'Captured a screenshot of the product page',
          'Looked at the page and updated the plan',
        ],
      };

    case 'trouble':
      return {
        apiKey: 'ds_live_example',
        liveToken: 'failing',
        chat: {
          ...chat,
          turns: [
            turn(1, CHECKOUT_TASK),
            {
              id: 2,
              role: 'agent',
              response: {
                kind: 'plan-executed',
                session: session(now, { id: 'agt_audit_trouble' }),
                intents: [...TROUBLE_STEPS.map((r) => r.intent), ...NOT_RUN],
                results: TROUBLE_STEPS,
                ok: false,
                usage: USAGE,
              },
            },
            turn(3, 'Try the cart again.'),
            {
              id: 4,
              role: 'agent',
              interrupted: {
                reason: INTERRUPTED_REASON,
                steps: [ok('Reopened the cart')],
              },
            },
          ],
          session: session(now, {
            id: 'agt_audit_trouble',
            status: 'closed',
            closed_reason: 'browser-closed',
            closed_at: new Date(now - 30_000).toISOString(),
          }),
        },
        markers: [
          CHECKOUT_TASK,
          'A newsletter pop-up was covering the Add to cart button.',
          'worth retrying',
          INTERRUPTED_REASON,
        ],
      };

    case 'stopping':
      return {
        apiKey: 'ds_live_example',
        standIn: standInScreen(shopListingSvg()),
        chat: {
          ...chat,
          turns: [turn(1, TASK)],
          sending: true,
          stopping: true,
          livePhase: 'Working on your request…',
          livePlan: { labels: PLAN_LABELS, total: PLAN_LABELS.length },
          liveSteps: RUNNING_STEPS.slice(0, 2),
          liveStepIndex: 2,
          session: session(now, {
            id: 'agt_audit_stopping',
            liveness: { state: 'terminating', fresh: true },
            capability_report: capabilityReport(now),
          }),
        },
        markers: [TASK, 'Stopping…', 'Search the store'],
      };
  }
}
