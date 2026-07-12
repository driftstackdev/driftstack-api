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
 * A single logical browser tab (doc-150 §7.2 — the TabDescriptor the harness
 * defines as a Swift struct): `{ url, scrollY, title }` + a stable `id` for GUI
 * reorder/close correlation. The harness may also retain a bounded live background
 * browsing context for this id; the descriptor remains the persistence/fallback
 * state when that context is cold or evicted.
 *
 * `scrollY` is a finite, non-negative number (a scroll offset can't be
 * negative; NaN/Infinity are rejected).
 */
export const TabDescriptorSchema = z.object({
  id: z.string().min(1).max(MAX_ID_LENGTH),
  url: z.string().max(MAX_TAB_URL_LENGTH),
  scrollY: z.number().finite().nonnegative(),
  title: z.string().max(MAX_TAB_TITLE_LENGTH),
});
export type TabDescriptor = z.infer<typeof TabDescriptorSchema>;

/**
 * `tabListUpdate` — GUI → box FIRE-AND-FORGET state push (doc-150 §7.2);
 * NO correlated reply. The GUI sends the FULL ordered tab list on every
 * new / close / switch / reorder; the harness reconciles last-write-wins.
 * `activeTabId` is the tab currently published into the video stream.
 */
export const TabListUpdateSchema = z.object({
  sessionId: z.string().min(1).max(MAX_ID_LENGTH),
  tabs: z.array(TabDescriptorSchema).max(MAX_TABS),
  activeTabId: z.string().min(1).max(MAX_ID_LENGTH),
});
export type TabListUpdate = z.infer<typeof TabListUpdateSchema>;

/**
 * `activateTab` — GUI → box CORRELATED request (doc-150 §7.3). Carries a
 * `requestId` so the harness's `activateTabResult` reply can be matched for
 * revert-on-reject, plus the optional outgoing `prevTabId` needed to cache the
 * first live context before an optimistic switch. The harness re-validates `url`
 * through the navigate allowlist (customer-controlled → SSRF gate) before any
 * first-touch/eviction cold-load fallback.
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
 * `activateTabResult` — box → GUI reply to `activateTab`, correlated by the
 * echoed `requestId`. SUCCESS → `ok:true`; FAILURE (unknown/inactive session,
 * disallowed url, WD error) → `error` set. Shape is identical to the
 * NavigateHistoryResult idiom (a plain lenient object, `ok?` / `error?`); A3
 * reuses the same drain/requeue plumbing. The GUI reverts its optimistic
 * switch on `ok:false` / `error`.
 */
export const ActivateTabResultSchema = z.object({
  ok: z.boolean().optional(),
  error: z.string().optional(),
  wasWarm: z.boolean().optional(),
});
export type ActivateTabResult = z.infer<typeof ActivateTabResultSchema>;

/**
 * `tabListRestore` — box → GUI FIRE-AND-FORGET push on profile reopen
 * (doc-150 §7.5, the reopen direction). The harness is the only party that
 * can decrypt `ProfileBlob.openTabs` (server-opaque), so on `ProfileSession.
 * prepare` it pushes the restored tab set to the GUI over the EXISTING
 * page_state data channel; the GUI repopulates the tab bar and sets the
 * active tab's url. Same `{ tabs, activeTabId }` shape as `tabListUpdate`
 * minus `sessionId` (the restore is scoped to the channel's own session).
 * The active tab is restored live by the harness; background tabs stay inert
 * until switched via `activateTab` (§7.3) — restoring all at once would be a
 * bot tell (§1.5). Frame on the wire is `{ type: 'tabListRestore', ...this }`.
 */
export const TabListRestoreSchema = z.object({
  tabs: z.array(TabDescriptorSchema).max(MAX_TABS),
  activeTabId: z.string().min(1).max(MAX_ID_LENGTH),
});
export type TabListRestore = z.infer<typeof TabListRestoreSchema>;
