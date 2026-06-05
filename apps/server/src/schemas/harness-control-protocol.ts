// Harness control-plane wire protocol — server↔harness intent dispatch.
//
// This schema is **server-internal only**. Like gui-input.ts (L-001),
// it never appears on the customer-facing surface (`@driftstack/api-types`):
// the harness is internal fleet infrastructure, not a customer. The
// customer-facing decomposer vocabulary lives in api-types/agent-intents.ts;
// THIS file is the lower-level transport contract the AgentExecutor uses to
// drive a session's harness node over the control-plane WebSocket.
//
// Canonical source: driftstack/docs/internal/harness-intent-contract.md
// (Agent-3, grounded in harness IntentExecutor.swift). Mirror exactly —
// any divergence is a server↔harness wire bug. The cross-agent contract
// mirror lives at docs/internal/cross-agent-control-plane-contract.md.
//
// Transport: the server sends ONE ControlInbound.intentDispatch(IntentDispatch)
// per intent over the control-plane WSS (`/v1/fleet/events`, V-820); the
// harness routes by `intentName` and returns a HarnessOutbound.IntentResult.
//
// ⚠️ Drive-bridge gate (ORCHESTRATOR item 9): the harness→fork WebDriver
// drive path isn't wired on Mac yet (cocoa WD server, founder Option-1
// sign-off pending). Dispatched intents REACH the harness now; end-to-end
// execution against the fork goes live when item 9 lands. The control-path
// schema + wiring is safe to build now.
//
// Wire codec (RESOLVED 2026-06-05 by Agent-3): IntentDispatch.inputParams and
// IntentResult.outputData are Swift `Data` and cross the wire as a BASE64
// STRING of the UTF-8 JSON (Swift Codable's default `Data` encoding). So both
// are typed `z.string()` here — the base64 envelope. The decoded LOGICAL
// payload is the per-intent params object (above) / per-intent result JSON;
// encode/decode lives in `harness-control-codec.ts` (serializeIntentDispatch /
// parseIntentResult). Envelope keys are camelCase (also A3-confirmed).

import { z } from 'zod';

// ── Intent vocabulary ────────────────────────────────────────────────
// The 11 intentNames the harness IntentExecutor dispatches. The 3 JSBridge
// intents (fill_form / login / search) are reserved but currently return
// `intent_not_implemented` (JSBridge channel unwired), so the server must
// not emit them — they are intentionally excluded from the dispatchable set.
export const HARNESS_INTENT_NAMES = [
  'navigate',
  'back',
  'forward',
  'click',
  'send_keys',
  'scroll',
  'behavioral_pause',
  'wait_for',
  'execute_script',
  'screenshot',
  'get_page_source',
] as const;

export const HarnessIntentNameSchema = z.enum(HARNESS_INTENT_NAMES);
export type HarnessIntentName = z.infer<typeof HarnessIntentNameSchema>;

// JSBridge intents the harness recognises but does NOT implement yet
// (returns intent_not_implemented). Reserved for forward-compat; the
// server must not dispatch these.
export const HARNESS_RESERVED_INTENT_NAMES = ['fill_form', 'login', 'search'] as const;

// ── Caps + defaults (harness-enforced; documented here for the sender) ──
// The harness clamps these server-side and reports `capped` / `timeout_capped`
// in the result. The sender passes values through; do NOT pre-clamp (that
// would suppress the flag the customer should see).
export const HARNESS_BEHAVIORAL_PAUSE_CAP_MS = 300_000;
export const HARNESS_WAIT_FOR_CAP_SECONDS = 300;
export const HARNESS_SCROLL_DEFAULT_DISTANCE_PX = 600;
export const HARNESS_SCROLL_DEFAULT_DIRECTION = 'down' as const;
export const HARNESS_WAIT_FOR_DEFAULT_TIMEOUT_SECONDS = 30;

// ── Per-intent param schemas (the `inputParams` JSON object) ──────────
// snake_case field names: these are the dict the Swift IntentExecutor case
// reads, not the camelCase envelope below.

const NoParamsSchema = z.object({}).strict();

export const NavigateParamsSchema = z.object({ url: z.string().min(1) }).strict();

// back / forward take no params.
export const HistoryNavParamsSchema = NoParamsSchema;

// click: target by element_id OR by (strategy, value).
export const ClickParamsSchema = z.union([
  z.object({ element_id: z.string().min(1) }).strict(),
  z.object({ strategy: z.string().min(1), value: z.string() }).strict(),
]);

// send_keys: all three required (field located by strategy+value, text typed).
export const SendKeysParamsSchema = z
  .object({
    strategy: z.string().min(1),
    value: z.string(),
    text: z.string(),
  })
  .strict();

// scroll: all optional (harness defaults direction='down', distance_px=600,
// and a per-direction start point). SDK surfaces direction + distance_px
// ONLY; start_x/start_y are server/harness internals (omit on the SDK).
export const ScrollParamsSchema = z
  .object({
    direction: z.enum(['up', 'down']).optional(),
    distance_px: z.number().int().positive().optional(),
    start_x: z.number().int().optional(),
    start_y: z.number().int().optional(),
  })
  .strict();

// behavioral_pause: explicit ms, OR reading-time by word_count, OR idle (none).
// duration_ms is clamped to HARNESS_BEHAVIORAL_PAUSE_CAP_MS by the harness
// (capped:true reported) — sender passes through.
export const BehavioralPauseParamsSchema = z.union([
  z.object({ duration_ms: z.number().int().nonnegative() }).strict(),
  z.object({ kind: z.literal('reading'), word_count: z.number().int().nonnegative() }).strict(),
  NoParamsSchema,
]);

// wait_for: predicate (JS returning truthy) required; timeout clamped to
// HARNESS_WAIT_FOR_CAP_SECONDS by the harness (timeout_capped:true reported).
export const WaitForParamsSchema = z
  .object({
    predicate: z.string().min(1),
    timeout_seconds: z.number().int().positive().optional(),
  })
  .strict();

export const ExecuteScriptParamsSchema = z
  .object({
    script: z.string().min(1),
    args: z.array(z.unknown()).optional(),
  })
  .strict();

// screenshot / get_page_source take no params.
export const ScreenshotParamsSchema = NoParamsSchema;
export const GetPageSourceParamsSchema = NoParamsSchema;

// intentName → param schema. The AgentExecutor validates the logical params
// it builds against this map before serialising into inputParams, so a wrong
// shape is caught server-side rather than surfacing as an opaque harness
// intent_missing_parameter / intent_dispatch_error.
export const HARNESS_INTENT_PARAM_SCHEMAS: Record<HarnessIntentName, z.ZodTypeAny> = {
  navigate: NavigateParamsSchema,
  back: HistoryNavParamsSchema,
  forward: HistoryNavParamsSchema,
  click: ClickParamsSchema,
  send_keys: SendKeysParamsSchema,
  scroll: ScrollParamsSchema,
  behavioral_pause: BehavioralPauseParamsSchema,
  wait_for: WaitForParamsSchema,
  execute_script: ExecuteScriptParamsSchema,
  screenshot: ScreenshotParamsSchema,
  get_page_source: GetPageSourceParamsSchema,
};

// ── Dispatch envelope (ControlInbound.intentDispatch) ─────────────────
// Mirrors the Swift IntentDispatch struct. `inputParams` is the BASE64 string
// of the UTF-8 JSON params object (A3-confirmed wire codec). Build it with
// serializeIntentDispatch() in harness-control-codec.ts, which validates the
// logical params against HARNESS_INTENT_PARAM_SCHEMAS[intentName] first.
export const IntentDispatchSchema = z.object({
  sessionId: z.string().min(1),
  intentId: z.string().min(1),
  intentName: HarnessIntentNameSchema,
  inputParams: z.string(),
});
export type IntentDispatch = z.infer<typeof IntentDispatchSchema>;

// ── Result envelope (HarnessOutbound.IntentResult) ────────────────────
export const HARNESS_ERROR_CODES = [
  'intent_session_not_established',
  'intent_not_implemented',
  'intent_missing_parameter',
  'intent_webdriver_failed',
  'intent_dispatch_error',
] as const;

export const HarnessErrorCodeSchema = z.enum(HARNESS_ERROR_CODES);
export type HarnessErrorCode = z.infer<typeof HarnessErrorCodeSchema>;

// Mirrors the Swift IntentResult struct. `outputData` is the BASE64 string of
// the per-intent result JSON (same A3-confirmed codec as inputParams); decode
// it with parseIntentResult() in harness-control-codec.ts.
export const IntentResultEnvelopeSchema = z.object({
  sessionId: z.string().min(1),
  intentId: z.string().min(1),
  success: z.boolean(),
  durationMs: z.number().int().nonnegative(),
  outputData: z.string().optional(),
  errorCode: HarnessErrorCodeSchema.optional(),
  errorMessage: z.string().optional(),
});
export type IntentResultEnvelope = z.infer<typeof IntentResultEnvelopeSchema>;
