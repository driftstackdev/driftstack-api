// doc-150 §7.2 / §7.3 / §7.5 — the browser-style multi-tab wire contract
// (the A2↔A3 multi-tab redesign). These three ops ride the LiveKit DATA
// CHANNEL directly between the GUI (Tauri shell) and the box (Mac harness) —
// they are NOT a REST route and NOT part of the SDK-exposed `InputEvent`
// union (agent-input-event.ts). A3's harness defines the matching Swift
// structs; A2 mirrors them HERE as the canonical typed contract so the
// gui-client encoder + the harness decoder share one source of truth.
//
// Layering (why these live in api-types but stay off the SDKs):
//   - `tabListUpdate`  : GUI → box, FIRE-AND-FORGET state push (no reply).
//     The GUI owns the tab LIST; it re-publishes the full set on every
//     new / close / switch / reorder so the harness reconciles its per-tab
//     pages. Last-write-wins; consumed at session-end tab-set assembly.
//   - `activateTab`    : GUI → box, CORRELATED request (`requestId`); the
//     harness brings a cached live target to front without navigation; a first-touch
//     or evicted target takes the bounded cold-load fallback. Replies
//     `activateTabResult { ok?, error?, wasWarm? }`.
//   - `tabListRestore` : box → GUI, FIRE-AND-FORGET push over the SAME
//     page_state data channel on profile reopen; the harness is the only
//     party that can decrypt `ProfileBlob.openTabs` (server-opaque, AES-GCM
//     under the per-profile DEK), so it pushes the restored set to the GUI
//     to repopulate the tab bar (§7.5).
//
// Everything here is gated behind `DRIFTSTACK_TAB_RESTORE` on the harness
// side; gate-off ⇒ no frames emitted (byte-identical legacy behaviour).
//
// `tabs` (semi-trusted GUI input, §7.2) is capped at 64 entries with bounded
// per-field string lengths — a hostile GUI can't JSON-bloat the box/wire.
//
// NOT SDK-exposed: the SDK surface (sdk-{typescript,go,python}) mirrors only
// `InputEventSchema`; the tab ops are a GUI↔box transport detail, so they do
// NOT propagate to the SDKs (mirrors the harness-control-protocol posture:
// internal infra is not a customer surface).

import { z } from 'zod';

/** Max tabs in a single session's tab set (§7.2 — semi-trusted GUI input).
 *  iOS Safari caps open tabs well below this; 64 is a generous DoS backstop
 *  that still keeps the wire payload small. */
const MAX_TABS = 64;

/** Per-tab URL cap. Matches the profile `description` cap (api-types/profiles.ts)
 *  for consistency; real iOS URLs are far shorter. The harness re-validates
 *  every restore/activate url through the navigate allowlist (SSRF gate), so
 *  this is purely a length backstop, not the security boundary. */
const MAX_TAB_URL_LENGTH = 2048;

/** Per-tab title cap (semi-trusted — derived from the page's <title>). */
const MAX_TAB_TITLE_LENGTH = 512;

/** Tab / session / request id cap. Matches the OAuth client_id cap (128) the
 *  sibling input-event file uses; the GUI's ids are `tab_<uuid>` (~40 chars). */
const MAX_ID_LENGTH = 128;

/**
 * One browser tab: its `url`, how far down it is scrolled, its `title`, and a
 * stable `id` you can use to reorder or close it. The tab may also be live in
 * the background; this descriptor is what persists either way.
 *
 * `scrollY` is a finite number and never negative — NaN and Infinity are
 * refused.
 */
export const TabDescriptorSchema = z.object({
  id: z.string().min(1).max(MAX_ID_LENGTH),
  url: z.string().max(MAX_TAB_URL_LENGTH),
  scrollY: z.number().finite().nonnegative(),
  title: z.string().max(MAX_TAB_TITLE_LENGTH),
});
export type TabDescriptor = z.infer<typeof TabDescriptorSchema>;

/**
 * `tabListUpdate` — tells the session what the tab bar now looks like. There
 * is no reply: send the FULL ordered list every time a tab is opened,
 * closed, switched or moved, and the last message received wins.
 * `activeTabId` is the tab whose video is being streamed.
 */
export const TabListUpdateSchema = z.object({
  sessionId: z.string().min(1).max(MAX_ID_LENGTH),
  tabs: z.array(TabDescriptorSchema).max(MAX_TABS),
  activeTabId: z.string().min(1).max(MAX_ID_LENGTH),
});
export type TabListUpdate = z.infer<typeof TabListUpdateSchema>;

/**
 * `activateTab` — asks the session to switch to a tab, and expects a reply.
 * `requestId` is echoed back on `activateTabResult`, so a switch that is
 * refused can be undone. `prevTabId` names the tab being left, so it can be
 * kept warm. The `url` is checked again before it is loaded, exactly as a
 * navigate would be.
 */
export const ActivateTabRequestSchema = z.object({
  requestId: z.string().min(1).max(MAX_ID_LENGTH),
  sessionId: z.string().min(1).max(MAX_ID_LENGTH),
  tabId: z.string().min(1).max(MAX_ID_LENGTH),
  // Optional for compatibility with older GUI bundles. The current GUI sends the tab it was showing before
  // its optimistic local flip so the harness can cache that outgoing live window even when the first list
  // update is already active on the target.
  prevTabId: z.string().min(1).max(MAX_ID_LENGTH).optional(),
  url: z.string().max(MAX_TAB_URL_LENGTH),
  scrollY: z.number().finite().nonnegative(),
});
export type ActivateTabRequest = z.infer<typeof ActivateTabRequestSchema>;

/**
 * `activateTabResult` — the reply to `activateTab`, matched by the echoed
 * `requestId`. A switch that worked answers `ok: true`; one that did not
 * sets `error` — an unknown or closed session, a url that is not allowed, or
 * a browser failure. Undo the switch in your own UI when `ok` is false or
 * `error` is present.
 */
export const ActivateTabResultSchema = z.object({
  ok: z.boolean().optional(),
  error: z.string().optional(),
  wasWarm: z.boolean().optional(),
});
export type ActivateTabResult = z.infer<typeof ActivateTabResultSchema>;

/**
 * `tabListRestore` — sent to you when a profile reopens, carrying the tabs it
 * had. Repopulate your tab bar from it and show the active tab's url. Only
 * the session can read a profile's saved tabs; the server cannot.
 *
 * Same `{ tabs, activeTabId }` shape as `tabListUpdate`, without
 * `sessionId`, because a restore belongs to the session it arrives on. Only
 * the active tab is loaded — the rest stay dormant until you switch to one
 * with `activateTab`, because loading a row of tabs at once is not something
 * a person does.
 */
export const TabListRestoreSchema = z.object({
  tabs: z.array(TabDescriptorSchema).max(MAX_TABS),
  activeTabId: z.string().min(1).max(MAX_ID_LENGTH),
});
export type TabListRestore = z.infer<typeof TabListRestoreSchema>;
