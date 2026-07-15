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
// Every intentName implemented by the live Swift IntentExecutor. This is an
// INTERNAL transport vocabulary, not a list of customer-advertised API
// capabilities: public routes expose only operations they can map faithfully.
export const HARNESS_INTENT_NAMES = [
  'navigate',
  'back',
  'forward',
  'click',
  'send_keys',
  'press_key',
  'execute_script',
  'detect_challenge',
  'extract',
  'screenshot',
  'get_page_source',
  'perceive',
  'wait_for',
  'scroll',
  'behavioral_pause',
  'fill_form',
  'search',
  'login',
] as const;

export const HarnessIntentNameSchema = z.enum(HARNESS_INTENT_NAMES);
export type HarnessIntentName = z.infer<typeof HarnessIntentNameSchema>;

// ── Caps + defaults (harness-enforced; documented here for the sender) ──
// The harness clamps these server-side and reports `capped` / `timeout_capped`
// in the result. The sender passes values through; do NOT pre-clamp (that
// would suppress the flag the customer should see).
export const HARNESS_BEHAVIORAL_PAUSE_CAP_MS = 300_000;
export const HARNESS_WAIT_FOR_CAP_SECONDS = 300;
export const HARNESS_SCROLL_DEFAULT_DISTANCE_PX = 600;
export const HARNESS_SCROLL_DEFAULT_DIRECTION = 'down' as const;
export const HARNESS_WAIT_FOR_DEFAULT_TIMEOUT_SECONDS = 30;
export const HARNESS_SCRIPT_MAX_CHARS = 262_144;
export const HARNESS_SEND_KEYS_MAX_CHARS = 10_000;
export const HARNESS_WAIT_ARG_MAX_CHARS = 4096;
export const HARNESS_EXTRACTIONS_MAX = 100;
export const HARNESS_PERCEIVE_MAX_ELEMENTS = 200;
export const HARNESS_FILL_FORM_MAX_FIELDS = 50;
export const HARNESS_FILL_FORM_MAX_TOTAL_VALUE_CHARS = 20_000;

// Security-audit hardening (2026-06-30) — hard cap on Heartbeat.
// activeSessionStates' key count. This map feeds the process-wide
// SessionLivenessStore (session-liveness-store.ts), a SINGLE Map shared by
// every fleet node and hard-capped at maxEntries=5_000. Without a schema-level
// bound, one node's oversized beat (still well within the 96 MiB frame cap)
// could declare 5000+ fabricated session ids and, via the store's size-cap
// eviction, threaten every OTHER node's real liveness entries. A node
// legitimately drives at most a handful of concurrent sessions (maxConcurrent
// is small — see the agent-sessions.ts / worker-disconnect-reaper.ts
// comments), so a few hundred is already generous headroom for spiky
// reconnect/migration windows.
export const HARNESS_HEARTBEAT_MAX_ACTIVE_SESSION_STATES = 500;

// The Swift producer folds excess rolling-outcome reasons into `other` at 32
// distinct keys. Mirror that producer bound at the trust boundary so a
// compromised authenticated node cannot turn the 96 MiB shared socket limit
// into a multi-megabyte JSONB/WAL write every heartbeat interval.
export const HARNESS_HEARTBEAT_MAX_OUTCOME_COUNTS = 32;
export const HARNESS_HEARTBEAT_OUTCOME_REASON_MAX_LENGTH = 128;

// A legitimate worst-case beat is small: 500 `agt_...` session ids plus the
// fixed telemetry fields is well below this with real ids. This aggregate
// budget is defense-in-depth for future additive fields and prevents many
// individually valid maximum-length values from composing into an oversized
// persisted/liveness payload. Unknown additive fields are stripped before this
// check and therefore cannot reach either consumer.
export const HARNESS_HEARTBEAT_MAX_SERIALIZED_BYTES = 64 * 1024;
export const HARNESS_HEARTBEAT_MAX_CONCURRENT = 512;

// Inbound fleet frames share a 96 MiB socket allowance, so every string that is
// retained or persisted must have its own much smaller semantic bound.
export const HARNESS_FRAME_ID_MAX_LENGTH = 256;
export const HARNESS_RESULT_ERROR_MAX_LENGTH = 4096;
export const HARNESS_ERROR_EVENT_SUMMARY_MAX_LENGTH = 4096;
export const HARNESS_ERROR_EVENT_DETAIL_MAX_LENGTH = 16 * 1024;
export const HARNESS_ERROR_EVENT_MAX_SERIALIZED_BYTES = 20 * 1024;
export const HARNESS_RESULT_FILENAME_MAX_LENGTH = 255;
export const HARNESS_RESULT_MIME_MAX_LENGTH = 255;
export const HARNESS_DOWNLOAD_MAX_FILES = 2000;
export const HARNESS_INTENT_OUTPUT_MAX_BYTES = 8 * 1024 * 1024;
export const HARNESS_DOWNLOAD_DATA_MAX_BYTES = 64 * 1024 * 1024;
export const PAGE_STATE_URL_MAX_LENGTH = 8192;
export const PAGE_STATE_TEXT_MAX_LENGTH = 4096;
export const PROFILE_SAVED_INLINE_MAX_BYTES = 256 * 1024;
// `size_bytes` is metadata for both inline and presigned saves, not retained
// frame content. Profiles can legitimately be multi-GiB; bound only to the
// largest integer JavaScript can represent exactly before writing bigint data.
export const PROFILE_SAVED_SIZE_MAX_BYTES = Number.MAX_SAFE_INTEGER;
const PROFILE_SAVED_INLINE_MAX_BASE64_LENGTH = 4 * Math.ceil(PROFILE_SAVED_INLINE_MAX_BYTES / 3);
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const HARNESS_INTENT_OUTPUT_MAX_BASE64_LENGTH = 4 * Math.ceil(HARNESS_INTENT_OUTPUT_MAX_BYTES / 3);
const HARNESS_DOWNLOAD_DATA_MAX_BASE64_LENGTH = 4 * Math.ceil(HARNESS_DOWNLOAD_DATA_MAX_BYTES / 3);

/** Exact decoded length for canonical base64, or null when the
 *  alphabet/padding is malformed. Arithmetic-only so large result validation
 *  never allocates a second decoded Buffer merely to enforce the limit. */
export function base64DecodedByteLength(value: string): number | null {
  if (value.length === 0) return 0;
  if (value.length % 4 !== 0) return null;
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const dataLength = value.length - padding;
  for (let i = 0; i < dataLength; i++) {
    const code = value.charCodeAt(i);
    const isAlphabet =
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      (code >= 48 && code <= 57) ||
      code === 43 ||
      code === 47;
    if (!isAlphabet) return null;
  }
  for (let i = dataLength; i < value.length; i++) {
    if (value.charCodeAt(i) !== 61) return null;
  }
  return (value.length / 4) * 3 - padding;
}

function boundedBase64Schema(maxEncodedLength: number, maxDecodedBytes: number) {
  return z
    .string()
    .max(maxEncodedLength)
    .refine((value) => {
      if (value.length > maxEncodedLength) return false;
      const decodedBytes = base64DecodedByteLength(value);
      return decodedBytes !== null && decodedBytes <= maxDecodedBytes;
    }, `base64 payload must decode to at most ${maxDecodedBytes} bytes`);
}

// ── Per-intent param schemas (the `inputParams` JSON object) ──────────
// snake_case field names: these are the dict the Swift IntentExecutor case
// reads, not the camelCase envelope below.

const NoParamsSchema = z.object({}).strict();

/**
 * V-820.sec — http(s) only. Rejects file:, javascript:, data:, chrome:, about:,
 * ftp:, etc. (and relative/non-absolute URLs). This is the chokepoint every
 * navigate dispatch passes through (serializeIntentDispatch + the (b) mapper
 * both validate params against NavigateParamsSchema before a dispatch leaves the
 * server), so a navigate URL — whether customer-supplied, model-hallucinated, or
 * prompt-injected via page content the decomposer reads — can't make the harness
 * browser read local files (file:) or execute script (javascript:/data:).
 */
function isHttpOrHttpsUrl(raw: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false; // not an absolute URL
  }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:';
}

export const NavigateParamsSchema = z
  .object({
    url: z.string().min(1).refine(isHttpOrHttpsUrl, {
      message:
        'navigate.url must be an absolute http(s) URL; file:, javascript:, data:, etc. are rejected',
    }),
  })
  .strict();

// back / forward take no params.
export const HistoryNavParamsSchema = NoParamsSchema;

export const HarnessLocatorStrategySchema = z.enum([
  'css selector',
  'xpath',
  'link text',
  'partial link text',
  'tag name',
]);

const WaitAfterSchema = z.number().nonnegative().optional();

// click: target by element_id, a W3C locator, or viewport coordinates.
export const ClickParamsSchema = z.union([
  z
    .object({
      element_id: z.string().min(1).max(HARNESS_SCRIPT_MAX_CHARS),
      wait_after: WaitAfterSchema,
    })
    .strict(),
  z
    .object({
      strategy: HarnessLocatorStrategySchema,
      value: z.string().min(1).max(HARNESS_SCRIPT_MAX_CHARS),
      wait_after: WaitAfterSchema,
    })
    .strict(),
  z.object({ x: z.number(), y: z.number(), wait_after: WaitAfterSchema }).strict(),
]);

export const SendKeysParamsSchema = z
  .object({
    strategy: HarnessLocatorStrategySchema,
    value: z.string().min(1).max(HARNESS_SCRIPT_MAX_CHARS),
    text: z.string().max(HARNESS_SEND_KEYS_MAX_CHARS),
    sensitive: z.boolean().optional(),
  })
  .strict();

export const PressKeyParamsSchema = z.object({ key: z.string().min(1).max(20) }).strict();

export const ExecuteScriptParamsSchema = z
  .object({
    script: z.string().min(1).max(HARNESS_SCRIPT_MAX_CHARS),
    args: z.array(z.unknown()).optional(),
  })
  .strict();

export const DetectChallengeParamsSchema = NoParamsSchema;

const ListFieldExtractionParamsSchema = z
  .object({
    type: z.enum(['text', 'attribute']),
    attribute: z.string().min(1).max(HARNESS_SCRIPT_MAX_CHARS).optional(),
    selector: z.string().max(HARNESS_SCRIPT_MAX_CHARS).optional(),
  })
  .strict();

const ListFieldExtractionMapSchema = z
  .record(ListFieldExtractionParamsSchema)
  .refine((value) => Object.keys(value).length <= HARNESS_EXTRACTIONS_MAX, {
    message: `nested extract map must contain at most ${HARNESS_EXTRACTIONS_MAX.toString()} fields`,
  });

const ExtractionParamsSchema = z
  .object({
    name: z.string().min(1).max(HARNESS_SCRIPT_MAX_CHARS),
    selector: z.string().min(1).max(HARNESS_SCRIPT_MAX_CHARS),
    type: z.enum(['text', 'attribute', 'list']),
    attribute: z.string().min(1).max(HARNESS_SCRIPT_MAX_CHARS).optional(),
    transform: z.literal('number').optional(),
    extract: ListFieldExtractionMapSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.type === 'attribute' && value.attribute === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['attribute'],
        message: 'attribute is required when type is attribute',
      });
    }
    if (value.type !== 'list' && value.extract !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['extract'],
        message: 'extract is valid only when type is list',
      });
    }
  });

export const ExtractParamsSchema = z
  .object({ extractions: z.array(ExtractionParamsSchema).min(1).max(HARNESS_EXTRACTIONS_MAX) })
  .strict();

export const ScreenshotParamsSchema = z
  .object({
    format: z.enum(['png', 'jpeg']).optional(),
    quality: z.number().min(1).max(100).optional(),
    full_page: z.boolean().optional(),
    annotate: z.boolean().optional(),
  })
  .strict();
export const GetPageSourceParamsSchema = NoParamsSchema;
export const PerceiveParamsSchema = z
  .object({ max_elements: z.number().int().min(1).max(HARNESS_PERCEIVE_MAX_ELEMENTS).optional() })
  .strict();

const WaitForStructuredSchema = z.union([
  z.object({ seconds: z.number().nonnegative() }).strict(),
  z
    .object({
      selector: z.string().min(1).max(HARNESS_WAIT_ARG_MAX_CHARS),
      appears: z.boolean().optional(),
    })
    .strict(),
  z.object({ text: z.string().max(HARNESS_WAIT_ARG_MAX_CHARS) }).strict(),
  z.object({ url_matches: z.string().max(HARNESS_WAIT_ARG_MAX_CHARS) }).strict(),
]);

export const WaitForParamsSchema = z.union([
  z
    .object({
      predicate: z.string().min(1).max(HARNESS_SCRIPT_MAX_CHARS),
      timeout_seconds: z.number().positive().optional(),
    })
    .strict(),
  z
    .object({
      for: WaitForStructuredSchema,
      timeout_seconds: z.number().positive().optional(),
    })
    .strict(),
]);

const ScrollAmountSchema = z.union([
  z.enum(['one_screen', 'to_bottom', 'to_top']),
  z.object({ pixels: z.number().nonnegative() }).strict(),
]);

export const ScrollParamsSchema = z
  .object({
    direction: z.enum(['up', 'down', 'left', 'right']).optional(),
    distance_px: z.number().nonnegative().optional(),
    amount: ScrollAmountSchema.optional(),
    start_x: z.number().int().optional(),
    start_y: z.number().int().optional(),
    pause_after_ms: z.number().nonnegative().optional(),
  })
  .strict();

export const BehavioralPauseParamsSchema = z.union([
  z.object({ duration_ms: z.number().nonnegative() }).strict(),
  z
    .object({
      kind: z.literal('reading'),
      word_count: z.number().nonnegative(),
      image_count: z.number().nonnegative().optional(),
      scroll_through: z.boolean().optional(),
    })
    .strict(),
  z.object({ kind: z.literal('decision') }).strict(),
  NoParamsSchema,
]);

const FillFormFieldParamsSchema = z
  .object({
    selector: z.string().min(1).max(HARNESS_SCRIPT_MAX_CHARS),
    value: z.string().max(HARNESS_SEND_KEYS_MAX_CHARS),
    sensitive: z.boolean().optional(),
  })
  .strict();

const FillFormSubmitTargetSchema = z.union([
  z.object({ selector: z.string().min(1).max(HARNESS_SCRIPT_MAX_CHARS) }).strict(),
  z.object({ x: z.number(), y: z.number() }).strict(),
  z.object({ text: z.string().min(1).max(HARNESS_SCRIPT_MAX_CHARS) }).strict(),
]);

export const FillFormParamsSchema = z
  .object({
    fields: z.array(FillFormFieldParamsSchema).min(1).max(HARNESS_FILL_FORM_MAX_FIELDS),
    submit: z.boolean().optional(),
    submit_target: FillFormSubmitTargetSchema.optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.fields.reduce((total, field) => total + field.value.length, 0) <=
      HARNESS_FILL_FORM_MAX_TOTAL_VALUE_CHARS,
    `field values must contain at most ${HARNESS_FILL_FORM_MAX_TOTAL_VALUE_CHARS.toString()} total characters`,
  );

export const SearchParamsSchema = z
  .object({
    query: z.string().min(1).max(HARNESS_SEND_KEYS_MAX_CHARS),
    search_selector: z.string().min(1).max(HARNESS_SCRIPT_MAX_CHARS).optional(),
    submit: z.boolean().optional(),
    wait_for_results_selector: z.string().min(1).max(HARNESS_SCRIPT_MAX_CHARS).optional(),
    timeout_seconds: z.number().positive().optional(),
  })
  .strict();

export const LoginParamsSchema = z
  .object({
    username: z.string().min(1).max(HARNESS_SEND_KEYS_MAX_CHARS),
    password: z.string().min(1).max(HARNESS_SEND_KEYS_MAX_CHARS),
    username_selector: z.string().min(1).max(HARNESS_SCRIPT_MAX_CHARS).optional(),
    password_selector: z.string().min(1).max(HARNESS_SCRIPT_MAX_CHARS).optional(),
    submit_selector: z.string().min(1).max(HARNESS_SCRIPT_MAX_CHARS).optional(),
    success_selector: z.string().min(1).max(HARNESS_SCRIPT_MAX_CHARS).optional(),
    timeout_seconds: z.number().positive().optional(),
  })
  .strict();

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
  press_key: PressKeyParamsSchema,
  execute_script: ExecuteScriptParamsSchema,
  detect_challenge: DetectChallengeParamsSchema,
  extract: ExtractParamsSchema,
  screenshot: ScreenshotParamsSchema,
  get_page_source: GetPageSourceParamsSchema,
  perceive: PerceiveParamsSchema,
  wait_for: WaitForParamsSchema,
  scroll: ScrollParamsSchema,
  behavioral_pause: BehavioralPauseParamsSchema,
  fill_form: FillFormParamsSchema,
  search: SearchParamsSchema,
  login: LoginParamsSchema,
};

// ── Per-intent result schemas (decoded `outputData` JSON) ────────────
// A successful envelope is not sufficient proof that the reply belongs to the
// dispatched operation: every decoded payload is checked against the expected
// intent below. Keep these exact mirrors of IntentExecutor.swift so a wrong or
// drifted result fails closed as intent_dispatch_error at the correlator.
const NavigateResultSchema = z.union([
  z.object({ url: z.string() }).strict(),
  z.object({ url: z.string(), loadedAtTimeout: z.literal(true) }).strict(),
]);

function historyNavResultSchema(action: 'back' | 'forward') {
  return z.union([
    z.object({ url: z.string(), action: z.literal(action) }).strict(),
    z.object({ action: z.literal(action), loadedAtTimeout: z.literal(true) }).strict(),
  ]);
}

const BackResultSchema = historyNavResultSchema('back');
const ForwardResultSchema = historyNavResultSchema('forward');

const ClickResultSchema = z
  .object({
    clicked: z.string(),
    behavioral: z.boolean(),
    activated: z.boolean().nullable(),
  })
  .strict();

const SendKeysResultSchema = z
  .object({
    typed_into: z.string(),
    length: z.number().int().nonnegative(),
    truncated: z.boolean(),
    behavioral: z.boolean(),
  })
  .strict();

const PressKeyResultSchema = z.object({ pressed: z.string().min(1).max(20) }).strict();

const ExecuteScriptResultSchema = z
  .object({ value: z.unknown() })
  .strict()
  .superRefine((value, ctx) => {
    // z.unknown() accepts undefined, so explicitly distinguish a present JSON
    // `value:null` from an object that omitted the required WebDriver key.
    if (!Object.prototype.hasOwnProperty.call(value, 'value')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['value'],
        message: 'execute_script result must contain value',
      });
    }
  });

const HARNESS_CHALLENGE_TYPES = [
  'recaptcha',
  'hcaptcha',
  'turnstile',
  'cloudflare_challenge',
  'email_verification',
  'sms_verification',
  'otp',
  'login_required',
  'arkose',
  'datadome',
  'press_and_hold',
  'access_blocked',
  'aws_waf',
  'geetest',
] as const;

const DetectChallengeResultSchema = z.discriminatedUnion('challenge_detected', [
  z.object({ challenge_detected: z.literal(false) }).strict(),
  z
    .object({
      challenge_detected: z.literal(true),
      type: z.enum(HARNESS_CHALLENGE_TYPES),
      confidence: z.number().min(0).max(1),
      detail: z.string(),
    })
    .strict(),
]);

const ExtractResultSchema = z.object({ value: z.record(z.unknown()) }).strict();

const ScreenshotResultSchema = z
  .object({
    screenshot_b64: z.string(),
    format: z.enum(['png', 'jpeg']),
    full_page: z.literal(false),
    annotated: z.boolean(),
  })
  .strict();

const GetPageSourceResultSchema = z.object({ source: z.string(), truncated: z.boolean() }).strict();

const PerceiveElementSchema = z
  .object({
    id: z.number().int().nonnegative(),
    type: z.enum([
      'button',
      'link',
      'select',
      'textarea',
      'checkbox',
      'radio',
      'input',
      'image',
      'other',
    ]),
    label: z.string(),
    selector: z.string(),
    bounds: z
      .object({
        x: z.number(),
        y: z.number(),
        width: z.number(),
        height: z.number(),
      })
      .strict(),
    state: z
      .object({
        visible: z.boolean(),
        enabled: z.boolean(),
        focused: z.boolean(),
        checked: z.boolean().optional(),
        selected: z.boolean().optional(),
      })
      .strict(),
    position_summary: z.string(),
  })
  .strict();

const PerceiveResultSchema = z
  .object({
    value: z
      .object({
        url: z.string(),
        title: z.string(),
        elements: z.array(PerceiveElementSchema).max(HARNESS_PERCEIVE_MAX_ELEMENTS),
        truncated: z.boolean(),
        total_matched: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();

const WaitForResultSchema = z
  .object({ waited: z.literal(true), timeout_capped: z.boolean() })
  .strict();

const ScrollResultSchema = z
  .object({
    scrolled: z.number(),
    requested: z.number(),
    scrolled_measured: z.boolean(),
    flicks: z.number().int().nonnegative(),
    steps: z.number().int().nonnegative(),
    behavioral: z.boolean(),
    distance_capped: z.boolean(),
  })
  .strict();

const BehavioralPauseResultSchema = z
  .object({
    paused_ms: z.number().int().nonnegative(),
    capped: z.boolean(),
    behavioral: z.boolean(),
  })
  .strict();

const FillFormResultSchema = z
  .object({
    fields_filled: z.number().int().nonnegative(),
    submitted: z.boolean(),
    truncated: z.boolean(),
    truncated_fields: z.array(z.number().int().nonnegative()).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.truncated !== (value.truncated_fields !== undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['truncated_fields'],
        message: 'truncated_fields must be present exactly when truncated is true',
      });
    }
  });

const SearchResultSchema = z
  .object({
    submitted: z.boolean(),
    query_truncated: z.boolean(),
    results_visible: z.boolean().optional(),
  })
  .strict();

const LoginResultSchema = z
  .object({
    logged_in: z.boolean(),
    post_login_url: z.string(),
    credentials_truncated: z.boolean(),
  })
  .strict();

export const HARNESS_INTENT_RESULT_SCHEMAS: Record<HarnessIntentName, z.ZodTypeAny> = {
  navigate: NavigateResultSchema,
  back: BackResultSchema,
  forward: ForwardResultSchema,
  click: ClickResultSchema,
  send_keys: SendKeysResultSchema,
  press_key: PressKeyResultSchema,
  execute_script: ExecuteScriptResultSchema,
  detect_challenge: DetectChallengeResultSchema,
  extract: ExtractResultSchema,
  screenshot: ScreenshotResultSchema,
  get_page_source: GetPageSourceResultSchema,
  perceive: PerceiveResultSchema,
  wait_for: WaitForResultSchema,
  scroll: ScrollResultSchema,
  behavioral_pause: BehavioralPauseResultSchema,
  fill_form: FillFormResultSchema,
  search: SearchResultSchema,
  login: LoginResultSchema,
};

// ── Wire envelope (A3 bus W122, commit 2a5639dc) ──────────────────────
// Both directions are a FLAT tagged union keyed on `type` (camelCase =
// the Swift enum case names): `{ "type": "<variant>", <payload fields flat…> }`.
// NO `_0` nesting (the prior Swift synthesized-Codable artifact — killed). Maps
// 1:1 to a Zod union of typed objects. `inputParams`/`outputData` are the
// BASE64 string of the UTF-8 JSON payload (A3-confirmed).
//   ControlInbound (server ENCODES → harness): sessionAssign / intentDispatch /
//     sessionEnd / ping.
//   HarnessOutbound (server DECODES ← harness): heartbeat / sessionStatus /
//     intentResult / capabilityReport / errorEvent.

// ── ControlInbound.intentDispatch (server → harness) ──────────────────
// Build it with serializeIntentDispatch() in harness-control-codec.ts (validates
// the logical params against HARNESS_INTENT_PARAM_SCHEMAS[intentName] first).
export const IntentDispatchSchema = z.object({
  type: z.literal('intentDispatch'),
  sessionId: z.string().min(1),
  intentId: z.string().min(1),
  intentName: HarnessIntentNameSchema,
  inputParams: z.string(),
});
export type IntentDispatch = z.infer<typeof IntentDispatchSchema>;

// ── ControlInbound.sessionAssign (server → harness) ───────────────────
// EG-API-1.6 — assigns a session (+ its egress + persona + transport + caps) to
// the connected fleet node. Shape empirically pinned by A3's round-trip decode
// test (bus W136, harness commit dc9e0a49). Build it with serializeSessionAssign()
// in harness-control-codec.ts. Wire notes (A3 W136 shape, W138 optionality):
//   - sessionId / archetype / behaviorProfile are REQUIRED (archetype +
//     behaviorProfile have no safe default — a wrong fingerprint / inert behaviour
//     would be a silent detection tell).
//   - transportMode (dash-cased, W118) / idleTimeoutSeconds / maxDurationSeconds are
//     OPTIONAL (A3 W138, harness commit e18de82f): omit → harness defaults
//     (h2-and-h3 / 300s idle / 1800s max). The minimal valid assign is
//     { type, sessionId, archetype, behaviorProfile }.
//   - inlineProxyConfig is a BASE64 string of the UTF-8 JSON SocksProxyConfig
//     (Swift `Data` default codec — same encoding as inputParams/outputData), NOT
//     a nested object or a raw JSON string. serializeSessionAssign base64-encodes it.
//   - initialUrl is http(s)-only (reuses the navigate scheme guard; the harness
//     W135 backstop drops a bad scheme, but we reject at the chokepoint too).
//   - livekit is the LONE snake_case wire object (GUI-streaming sessions only).
export const SessionAssignLivekitSchema = z
  .object({
    room: z.string().min(1),
    token: z.string().min(1),
    ws_url: z.string().min(1),
    expires_at: z.string().min(1),
  })
  .strict();

// Profile-backed sessions (A3 W177/W417): an optional `profile` block restores
// an encrypted per-profile store into the fork on assign + saves it on end.
// snake_case wire keys mirror the livekit block convention (A3's ProfileInfo
// CodingKeys: profile_id/dek/sealed_blob/sealed_blob_url/sealed_blob_put_url).
// `dek` rides JIT like the livekit token (KMS->TMK->DEK server-side, harness
// never stores it). `sealed_blob` inline (<=256KB) OR `sealed_blob_url` presigned
// GET (large); `sealed_blob_put_url` is the presigned PUT for the save-back path.
// Only profile_id + dek are required: a fresh profile (no prior state) ships
// neither blob + just saves on end. Absent block => today's stateless path.
export const SessionAssignProfileSchema = z
  .object({
    profile_id: z.string().min(1),
    dek: z.string().min(1),
    sealed_blob: z.string().min(1).optional(),
    sealed_blob_url: z.string().min(1).optional(),
    sealed_blob_put_url: z.string().min(1).optional(),
  })
  .strict();

// Per-session geolocation OVERRIDE (A3 bus verdict 2026-07-01, doc-146→07/47).
// The harness ALREADY derives lat/lon from the proxy-exit IP by default
// (EgressProbeResult.proxiedLoc → DRIFTSTACK_GEO_* env → the fork's
// WebGeolocationManagerProxy provider), so navigator.geolocation follows the
// exit geo-coherently with NO field. This block is the customer's EXPLICIT
// override of that auto-derive; absent ⇒ auto-derive (never regress the
// exit-coherent default). `accuracy` is meters; omitted → harness default 35.0
// (iPhone-faithful stationary CoreLocation). Coherence divergence (explicit geo
// ≠ exit country) is surfaced as a soft client-side warning, deliberately NOT
// enforced here — the customer may genuinely know their proxy's real location
// better than the ipinfo derive does.
export const SessionAssignGeolocationSchema = z
  .object({
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    accuracy: z.number().positive().max(100_000).optional(),
  })
  .strict();

// #128 new-tab IP panel (A2↔A3 bus 2026-07-06). The box serves the new-tab page
// LOCALLY (no proxy hop → instant, reliable even when the proxy can't reach
// driftstack.dev/newtab) and renders the IP/geo/tz/QUIC panel from THIS block —
// the CP-probed exit identity, authoritative because it's what the world sees
// through the customer's proxy — instead of a proxied /cdn-cgi/trace fetch that
// Cloudflare challenges. snake_case wire keys mirror the livekit/profile block
// convention (A3 matches this decoder byte-for-byte). Absent ⇒ box keeps today's
// behaviour (no local panel data / falls back). `country` is ISO-3166 alpha-2 or
// 'XX' (unknown); region/city/timezone are best-effort (null when the geo lookup
// can't resolve them); `quic_ok` is the CP UDP/QUIC pre-detection for the proxy
// (drives the panel's "HTTP/3" indicator); `probed_at` is ISO8601 freshness.
export const SessionAssignExitIdentitySchema = z
  .object({
    ip: z.string().min(1),
    country: z.string().length(2),
    region: z.string().min(1).nullable(),
    city: z.string().min(1).nullable(),
    timezone: z.string().min(1).nullable(),
    quic_ok: z.boolean(),
    probed_at: z.string().min(1),
  })
  .strict();

export const SessionAssignSchema = z
  .object({
    type: z.literal('sessionAssign'),
    sessionId: z.string().min(1),
    // archetype + behaviorProfile stay REQUIRED (A3 W138): no safe default — a
    // wrong-fingerprint or inert-behaviour fallback would be a silent detection tell.
    archetype: z.string().min(1),
    behaviorProfile: z.string().min(1),
    // A3 W138 (harness commit e18de82f) made these OPTIONAL on the wire: omit →
    // harness defaults (transportMode→h2-and-h3, idle→300s, max→1800s). We mirror
    // the canonical optional contract; serializeSessionAssign omits when not given.
    transportMode: z.enum(['h2-only', 'h2-and-h3']).optional(),
    idleTimeoutSeconds: z.number().int().positive().optional(),
    maxDurationSeconds: z.number().int().positive().optional(),
    // A3 W137: proxyConfigId is INFORMATIONAL to the harness (no DB to resolve a
    // saved-proxy id). The egress path acts on inlineProxyConfig ONLY — so when a
    // session uses a saved proxy, the emission wiring MUST resolve it server-side
    // into inlineProxyConfig; proxyConfigId may ride along for tracing, but sending
    // it WITHOUT inlineProxyConfig → the harness sees no proxy → refuses (REQUIRE_PROXY).
    proxyConfigId: z.string().min(1).optional(),
    /** BASE64 of utf8(JSON.stringify(SocksProxyConfig)) — see serializeSessionAssign. */
    inlineProxyConfig: z.string().min(1).optional(),
    initialUrl: z
      .string()
      .min(1)
      .refine(isHttpOrHttpsUrl, {
        message:
          'initialUrl must be an absolute http(s) URL; file:, javascript:, data:, etc. are rejected',
      })
      .optional(),
    livekit: SessionAssignLivekitSchema.optional(),
    // Profile-backed session restore/save (optional; absent ⇒ stateless).
    profile: SessionAssignProfileSchema.optional(),
    // Explicit geolocation override (optional; absent ⇒ harness auto-derives
    // from the proxy-exit IP — see SessionAssignGeolocationSchema above).
    geolocation: SessionAssignGeolocationSchema.optional(),
    // #128 new-tab IP panel: CP-probed exit identity for the box-local new-tab
    // page (optional; absent ⇒ box keeps today's behaviour).
    exit_identity: SessionAssignExitIdentitySchema.optional(),
  })
  .strict();
export type SessionAssign = z.infer<typeof SessionAssignSchema>;
export type SessionAssignGeolocation = z.infer<typeof SessionAssignGeolocationSchema>;
export type SessionAssignExitIdentity = z.infer<typeof SessionAssignExitIdentitySchema>;

// ── ControlInbound.sessionEnd (server → harness) ──────────────────────
// The trivial teardown envelope (W122 ControlInbound set: sessionAssign /
// intentDispatch / sessionEnd / ping). Sent when an agent-session is closed so
// the harness tears the session down (fork + proxy + capture) and frees its
// concurrency slot — A3 W420 confirms the harness drains/teardowns at the
// `sessionEnd` site. Keyed by sessionId alone (the universal envelope field the
// harness already decodes); no other field — a teardown needs only which session.
export const SessionEndSchema = z
  .object({
    type: z.literal('sessionEnd'),
    sessionId: z.string().min(1),
  })
  .strict();
export type SessionEnd = z.infer<typeof SessionEndSchema>;

// ── ControlInbound.pauseSession / resumeSession (server → harness; W393) ───
// Challenge-handling controls (A3 W725). The harness AUTO-pauses on
// detect_challenge (self-contained, immediate); these are the EXPLICIT CP
// triggers: pauseSession = manual override; resumeSession = recovery once the
// customer resolves the challenge (re-enables action intents). Pause halts
// action-intent execution via the harness pause-gate (observation still passes;
// idle-exempt). resumeSession.challengeId (optional) correlates to the
// session.challenge_detected the customer is responding to (anti-stale-resume);
// absent = a manual pause→resume with no specific challenge.
export const PauseSessionSchema = z
  .object({
    type: z.literal('pauseSession'),
    sessionId: z.string().min(1),
  })
  .strict();
export type PauseSession = z.infer<typeof PauseSessionSchema>;

export const ResumeSessionSchema = z
  .object({
    type: z.literal('resumeSession'),
    sessionId: z.string().min(1),
    challengeId: z.string().min(1).optional(),
  })
  .strict();
export type ResumeSession = z.infer<typeof ResumeSessionSchema>;

// ── ControlInbound.controlCommand (server → harness; fleet-admin §A5 control) ──
// NODE-level operator control for the admin Fleet panel (drain/cordon/restart).
// Unlike the session-scoped frames above, this targets the NODE — it's sent over
// that node's own authenticated WSS connection (the connection IS the node), so
// no node id rides the frame. A2's chosen control-signal path (A2-A3-BUS W2203:
// a command frame over the existing WSS, NOT an out-of-band SSH hook — keeps
// control on the one authenticated channel). The harness routes each command:
//   cordon   → refuse new assigns, keep active sessions (sets the cordoned bit)
//   uncordon → resume accepting assigns
//   drain    → cordon + shed: let active sessions finish, then idle (beginDrain)
//   restart  → drain then exit so launchd respawns a fresh daemon
// `reason` is operator-supplied free text for the node's logs + the audit trail.
// The enum is extensible (additive) as the control set grows.
export const CONTROL_COMMANDS = ['cordon', 'uncordon', 'drain', 'restart'] as const;
export type ControlCommandKind = (typeof CONTROL_COMMANDS)[number];
export const ControlCommandSchema = z
  .object({
    type: z.literal('controlCommand'),
    command: z.enum(CONTROL_COMMANDS),
    reason: z.string().min(1).max(512).optional(),
  })
  .strict();
export type ControlCommand = z.infer<typeof ControlCommandSchema>;

export const SESSION_ASSIGN_TRANSPORT_MODES = ['h2-only', 'h2-and-h3'] as const;
export type SessionAssignTransportMode = (typeof SESSION_ASSIGN_TRANSPORT_MODES)[number];

export const HARNESS_ERROR_CODES = [
  'intent_session_not_established',
  'intent_not_implemented',
  'intent_missing_parameter',
  // A3 W135 (commit dae8a50d) — distinct from intent_missing_parameter: the param
  // was PRESENT but invalid (e.g. the harness-side navigate scheme backstop
  // rejecting a non-http(s) url that slipped past the server filter — a hit here
  // is observable as a security event). Must be in the decode enum or an
  // intentResult carrying it fails IntentResultEnvelopeSchema → the correlator
  // silently drops the frame → the dispatch hangs to its timeout.
  'intent_invalid_parameter',
  'intent_webdriver_failed',
  'intent_script_failed',
  'intent_dispatch_error',
  // A3 W227 (harness f711840f) — inline outputData is capped at 8 MiB harness-side;
  // an over-cap result FAILS with this code (no outputData) rather than returning a
  // corrupt/truncated DOM/base64. Must be in the decode enum or the carrying
  // intentResult fails IntentResultEnvelopeSchema → the correlator drops the frame →
  // the dispatch hangs to its timeout (same reasoning as intent_invalid_parameter).
  'result_too_large',
  'session_paused',
  'session_intent_in_flight',
] as const;

export const HarnessErrorCodeSchema = z.enum(HARNESS_ERROR_CODES);
export type HarnessErrorCode = z.infer<typeof HarnessErrorCodeSchema>;

// ── HarnessOutbound.intentResult (harness → server) ───────────────────
// `outputData` is the BASE64 string of the per-intent result JSON; decode it
// with parseIntentResult() in harness-control-codec.ts.
const IntentResultIdentitySchema = {
  type: z.literal('intentResult'),
  sessionId: z.string().min(1).max(HARNESS_FRAME_ID_MAX_LENGTH),
  intentId: z.string().min(1).max(HARNESS_FRAME_ID_MAX_LENGTH),
  durationMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
};

/** Cheap routing header used before any full-envelope parse or base64 decode. */
export const IntentResultHeaderSchema = z
  .object({
    type: z.literal('intentResult'),
    sessionId: z.string().min(1).max(HARNESS_FRAME_ID_MAX_LENGTH),
    intentId: z.string().min(1).max(HARNESS_FRAME_ID_MAX_LENGTH),
  })
  .passthrough();

const IntentResultSuccessEnvelopeSchema = z
  .object({
    ...IntentResultIdentitySchema,
    success: z.literal(true),
    outputData: boundedBase64Schema(
      HARNESS_INTENT_OUTPUT_MAX_BASE64_LENGTH,
      HARNESS_INTENT_OUTPUT_MAX_BYTES,
    ),
  })
  .strict();

const IntentResultFailureEnvelopeSchema = z
  .object({
    ...IntentResultIdentitySchema,
    success: z.literal(false),
    errorCode: HarnessErrorCodeSchema,
    errorMessage: z.string().max(HARNESS_RESULT_ERROR_MAX_LENGTH).optional(),
  })
  .strict();

export const IntentResultEnvelopeSchema = z.discriminatedUnion('success', [
  IntentResultSuccessEnvelopeSchema,
  IntentResultFailureEnvelopeSchema,
]);
export type IntentResultEnvelope = z.infer<typeof IntentResultEnvelopeSchema>;

// ── HarnessOutbound.sessionStatus (harness → server) ──────────────────
// The router fast-fails an in-flight dispatch on the errored variant whose
// `detail` is `intent_dispatch_no_session: <intentName>` (A3 W106).
//
// Terminal close (A3 W2682): the worker emits a terminal frame whose `status`
// is EXACTLY `ended` (idle_timeout / max_duration / customer_closed /
// node_drain) or `errored` (egress_lost / session_resource_overuse /
// browser_crashed / node_shutting_down / reaped_during_provisioning), carrying
// a clean snake_case `reason`. The server closes the matching agent_sessions row
// on these (worker-CONNECTED orphan auto-close), keyed on `status` ∈
// TERMINAL_SESSION_STATUSES and using `reason` as the close reason. NOTE: a
// provisioning-failure errored frame has `reason: nil` (the cause is in
// `detail`), but those are assign-time rejections, NOT orphans — keying on the
// `status` set + a present-or-synthesized `reason` (never parsing `detail`)
// keeps the close to genuine terminal frames.
export const SessionStatusSchema = z.object({
  type: z.literal('sessionStatus'),
  sessionId: z.string().min(1).max(HARNESS_FRAME_ID_MAX_LENGTH),
  status: z.string().min(1).max(64),
  timestamp: z.string().min(1).max(64),
  // Bounded like every sibling `detail` in this file (.max(4096)) — a node
  // (already JWT-authed) must not be able to inject an unbounded string here.
  detail: z.string().max(4096).optional(),
  // A3 W2682 — clean snake_case close reason on a terminal frame (e.g.
  // idle_timeout / max_duration / browser_crashed). Optional: non-terminal
  // status frames omit it, and a provisioning-failure errored frame carries
  // `reason: nil` (cause in detail). The terminal-close consumer falls back to
  // a synthesized `session-<status>` when absent. This value is persisted
  // verbatim into customer-visible `closed_reason`, so accept only the emitted
  // snake_case token contract rather than arbitrary diagnostic text.
  reason: z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,127}$/)
    .optional(),
});
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

/**
 * Worker-CONNECTED orphan auto-close (A3 W2682) — the EXACT terminal-status
 * vocabulary the worker emits on a SessionStatus teardown frame: `ended`
 * (clean: idle_timeout / max_duration / customer_closed / node_drain) and
 * `errored` (failure: egress_lost / session_resource_overuse / browser_crashed
 * / node_shutting_down / reaped_during_provisioning). A frame whose status is in
 * this set closes the matching agent_sessions row. The set is the contract: a
 * mismatch silently no-ops the close, so a drift-guard test pins it.
 */
export const TERMINAL_SESSION_STATUSES = new Set<string>(['ended', 'errored']);

// ── HarnessOutbound payloads pinned (A3 bus W124) ─────────────────────
// Field-sets locked by the harness `testHarnessOutboundPayloadShapesPinned`
// test. Typed as plain objects (unknown keys STRIPPED, not .strict()-rejected):
// these are DECODE-side, so tolerating a future additive harness field is safer
// than rejecting the whole frame — A3 flags any change on the bus regardless.
// intentResult + sessionStatus (above) are the consumed variants; these three
// are accepted + currently ignored by the router (liveness/egress/error
// telemetry — wired when a consumer needs them).
const HeartbeatPercentSchema = z.number().finite().min(0).max(100);
const HeartbeatOutcomeCountsSchema = z
  .record(
    z.string().min(1).max(HARNESS_HEARTBEAT_OUTCOME_REASON_MAX_LENGTH),
    z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  )
  .refine((counts) => Object.keys(counts).length <= HARNESS_HEARTBEAT_MAX_OUTCOME_COUNTS, {
    message: `sessionOutcomeCounts must not exceed ${HARNESS_HEARTBEAT_MAX_OUTCOME_COUNTS} entries`,
  });

const HeartbeatPayloadSchema = z.object({
  type: z.literal('heartbeat'),
  macNodeId: z.string().min(1).max(HARNESS_FRAME_ID_MAX_LENGTH),
  timestamp: z.string().min(1).max(64),
  cpuPercent: HeartbeatPercentSchema,
  memoryPercent: HeartbeatPercentSchema,
  activeSessionCount: z.number().int().nonnegative().max(HARNESS_HEARTBEAT_MAX_CONCURRENT),
  // Fleet-admin-panel telemetry (file-48 §A5; A3 W2189/W2197/W2199*). All
  // OPTIONAL + omit-when-nil on the producer (ControlClient.swift Heartbeat),
  // so an older/quieter node's beat is byte-identical and these are simply
  // absent. DECLARED here (was silently .strip()ped) so the values survive
  // decode for the panel's resource columns, scheduler placement, and
  // staleness/uptime/drain signals. Field names mirror the Swift Codable 1:1.
  /** Configured session capacity — the running/max denominator (A3-1). */
  maxConcurrent: z.number().int().nonnegative().max(HARNESS_HEARTBEAT_MAX_CONCURRENT).optional(),
  /** Daemon uptime (s, monotonic from process start) — uptime + silent-restart detection (A3-3). */
  uptimeSeconds: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  /**
   * Per-PROCESS boot identity (A3 W2827 — `ProcessInfo.processInfo.globallyUniqueString`,
   * captured once per daemon process). A CHANGE for a node across beats = the daemon
   * RESTARTED (its prior in-memory sessions are gone) vs an unchanged value across a
   * connection gap = a mere reconnect. The CP's bootId consumer (A2 W2813) uses a change
   * to expire that node's previously-assigned sessions the new boot does NOT reaffirm.
   * OPTIONAL + omit-when-nil on the producer; DECLARED here (was silently .strip()ped)
   * so the consumer can read it.
   */
  bootId: z.string().min(1).max(HARNESS_FRAME_ID_MAX_LENGTH).optional(),
  /** "draining" when shedding (SIGUSR1 / scheduled restart), else absent = serving (A3-2). */
  drainState: z.literal('draining').optional(),
  /** Rolling-1h session-outcome tally (reason→count); A2 owns success/crash categorization (A3-5). */
  sessionOutcomeCounts: HeartbeatOutcomeCountsSchema.optional(),
  /**
   * Per-session worker-liveness map (agentSessionId → lifecycle state) — the
   * re-base source for open-session liveness (A2 W2679, A3 driftstack f52699c37).
   * OPTIONAL + omit-when-nil on the producer (ControlClient.swift Heartbeat), so
   * an older/quieter node's beat is byte-identical and this is simply absent.
   * DECLARED here (was silently .strip()ped) so the SessionLivenessStore can read
   * the real worker state — `activeSessionCount` is the scalar count of these.
   * Keyed by the sessionAssign.sessionId (== the agt_ agent-session id, A3 W1254).
   */
  activeSessionStates: z
    .record(
      z.string().min(1).max(HARNESS_FRAME_ID_MAX_LENGTH),
      z.enum(['active', 'provisioning', 'idle', 'terminating']),
    )
    .optional()
    .refine(
      (states) =>
        states === undefined ||
        Object.keys(states).length <= HARNESS_HEARTBEAT_MAX_ACTIVE_SESSION_STATES,
      {
        message: `activeSessionStates must not exceed ${HARNESS_HEARTBEAT_MAX_ACTIVE_SESSION_STATES} entries`,
      },
    ),
  // Host-health (A3-4) — proactive-placement signals; gated on the worker via
  // DRIFTSTACK_HEARTBEAT_HOST_HEALTH (flipped on, W2197).
  /** nominal | fair | serious | critical. */
  thermalState: z.enum(['nominal', 'fair', 'serious', 'critical']).optional(),
  /** normal | warn | critical. */
  memoryPressureLevel: z.enum(['normal', 'warn', 'critical']).optional(),
  /** Per-core max % (single-core saturation the box-wide cpuPercent hides). */
  busiestCorePercent: HeartbeatPercentSchema.optional(),
  /** Session-storage volume free % (disk-full drift / data-dir write-failure tell). */
  diskFreePercent: HeartbeatPercentSchema.optional(),
  /** Harness build identity (e.g. git sha) — "Harness version" column (A3 W2189). */
  harnessVersion: z.string().max(HARNESS_FRAME_ID_MAX_LENGTH).optional(),
});

export const HeartbeatSchema = HeartbeatPayloadSchema.transform((frame, ctx) => {
  const serializedBytes = Buffer.byteLength(JSON.stringify(frame), 'utf8');
  if (serializedBytes > HARNESS_HEARTBEAT_MAX_SERIALIZED_BYTES) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `heartbeat must serialize to at most ${HARNESS_HEARTBEAT_MAX_SERIALIZED_BYTES} bytes`,
    });
    return z.NEVER;
  }
  return frame;
});
export type Heartbeat = z.infer<typeof HeartbeatSchema>;

const ErrorEventPayloadSchema = z.object({
  type: z.literal('errorEvent'),
  sessionId: z.string().min(1).max(HARNESS_FRAME_ID_MAX_LENGTH).optional(),
  timestamp: z.string().min(1).max(64),
  code: z.string().regex(/^[a-z][a-z0-9_]{0,127}$/),
  severity: z.enum(['info', 'warn', 'error', 'fatal']),
  summary: z.string().max(HARNESS_ERROR_EVENT_SUMMARY_MAX_LENGTH),
  detail: z.string().max(HARNESS_ERROR_EVENT_DETAIL_MAX_LENGTH).optional(),
  customerActionable: z.boolean(),
  retryable: z.boolean(),
});

export const ErrorEventSchema = ErrorEventPayloadSchema.transform((frame, ctx) => {
  if (Buffer.byteLength(JSON.stringify(frame), 'utf8') > HARNESS_ERROR_EVENT_MAX_SERIALIZED_BYTES) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `errorEvent must serialize to at most ${HARNESS_ERROR_EVENT_MAX_SERIALIZED_BYTES} bytes`,
    });
    return z.NEVER;
  }
  return frame;
});
export type HarnessErrorEvent = z.infer<typeof ErrorEventSchema>;

const CapabilityReportPayloadSchema = z.object({
  type: z.literal('capabilityReport'),
  sessionId: z.string().min(1).max(HARNESS_FRAME_ID_MAX_LENGTH),
  timestamp: z.string().min(1).max(64),
  egressPhase: z.enum(['phase_1_socks5', 'phase_2_openvpn', 'phase_3_wireguard']),
  proxyKind: z.enum(['socks5', 'openvpn', 'wireguard']),
  proxyUdpSupported: z.boolean(),
  proxyIpv4Supported: z.boolean(),
  proxyIpv6Supported: z.boolean(),
  proxyGeoCountry: z.string().max(64).optional(),
  proxyGeoRegion: z.string().max(128).optional(),
  proxyIpType: z.enum(['residential', 'mobile', 'datacenter', 'isp']).optional(),
  transportModeRequested: z.enum(['h2-only', 'h2-and-h3']),
  transportModeActive: z.enum(['h2-only', 'h2-and-h3']),
  h3InterposeLoaded: z.boolean(),
  httpsSkipActive: z.boolean(),
  safeguardChecks: z
    .array(
      z.object({
        layer: z.string().min(1).max(64),
        passed: z.boolean(),
        detail: z.string().max(4096).optional(),
        timestamp: z.string().min(1).max(64),
      }),
    )
    .max(16),
  archetypeId: z.string().min(1).max(HARNESS_FRAME_ID_MAX_LENGTH),
  webkitForkBuild: z.string().max(HARNESS_FRAME_ID_MAX_LENGTH).optional(),
  // W1397/W2216/EGRESS-2 — these are the customer-visible state signals the
  // harness already emits. Keep optional for older nodes, but never strip them:
  // the registry relay drives the installed GUI and persistence from this data.
  manualInputAvailable: z.boolean().optional(),
  streamingState: z.enum(['provisioning', 'live', 'blank', 'failed']).optional(),
  egressState: z.enum(['live', 'dead_proxy']).optional(),
});

export const CapabilityReportSchema = CapabilityReportPayloadSchema.transform((frame, ctx) => {
  if (Buffer.byteLength(JSON.stringify(frame), 'utf8') > 64 * 1024) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'capabilityReport must serialize to at most 65536 bytes',
    });
    return z.NEVER;
  }
  return frame;
});
export type CapabilityReport = z.infer<typeof CapabilityReportSchema>;

// ── HarnessOutbound.profileSaved (harness → server; A3 W417) ──────────
// Emitted on session end for PROFILE-BACKED sessions only. Two shapes:
//   inline (small): { type, sessionId, profile_id, sealed_blob }
//   large (presigned-PUT): { type, sessionId, profile_id, stored: true }
//     — the harness already PUT the blob to the server-supplied
//       sealed_blob_put_url; `stored:true` is the ack.
// sessionId is camelCase (every outbound message); profile_id + sealed_blob
// snake_case (mirrors the inbound profile block). MUST-DELIVER on the harness
// side (queued across disconnects) — a dropped profileSaved loses the
// customer's saved storage. Consumed by the step-(d) consumer (persist).
export const ProfileSavedSchema = z
  .object({
    type: z.literal('profileSaved'),
    sessionId: z.string().min(1).max(HARNESS_FRAME_ID_MAX_LENGTH),
    profile_id: z.string().min(1).max(HARNESS_FRAME_ID_MAX_LENGTH),
    sealed_blob: z
      .string()
      .min(1)
      .max(PROFILE_SAVED_INLINE_MAX_BASE64_LENGTH)
      .regex(BASE64_RE)
      .refine(
        (value) => Buffer.byteLength(value, 'base64') <= PROFILE_SAVED_INLINE_MAX_BYTES,
        `sealed_blob must decode to at most ${PROFILE_SAVED_INLINE_MAX_BYTES} bytes`,
      )
      .optional(),
    stored: z.literal(true).optional(),
    // doc-150 item 5 (A3 emit) — byte size of the sealed store the harness just
    // saved (the LZFSE + AES-GCM-256 blob, before/independent of the inline-vs-
    // presigned transport). Optional/forward-compat: a pre-emit harness omits it
    // and the consumer leaves size_bytes NULL. The save-back persists it (plus
    // last_saved_at) on the profile row so the dashboard can surface per-profile
    // storage + an account total.
    size_bytes: z.number().int().nonnegative().max(PROFILE_SAVED_SIZE_MAX_BYTES).optional(),
  })
  .superRefine((frame, ctx) => {
    const inline = frame.sealed_blob !== undefined;
    const presigned = frame.stored === true;
    if (inline === presigned) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'profileSaved must carry exactly one of sealed_blob or stored:true',
      });
    }
  });

// ── HarnessOutbound.challengeDetected (harness → server; W393, A3 W717) ──
// Emitted when the harness ChallengeDetector flags a bot-check (DataDome /
// Arkose / PerimeterX / AWS-WAF / GeeTest / … — 14 types). The harness
// auto-pauses the session (A3 W725) and emits this; the server relays it as the
// customer-facing `session.challenge_detected` (transcript SSE + webhook event).
// challengeId = the harness-minted per-detection id the customer's resumeSession
// references once the challenge is solved (response correlation). Plain object
// (not .strict) like the other outbound frames — lenient forward-compat.
export const ChallengeDetectedSchema = z.object({
  type: z.literal('challengeDetected'),
  sessionId: z.string().min(1).max(HARNESS_FRAME_ID_MAX_LENGTH),
  challengeId: z.string().min(1).max(HARNESS_FRAME_ID_MAX_LENGTH),
  challenge: z.object({
    // Security-audit hardening (2026-06-30) — bounded like the sibling
    // hardened fields in this file (bootId 256, ControlCommand.reason 512):
    // this flows unfiltered into WebhooksService.enqueueEvent (challenge-
    // relay.ts) with no truncation, so an unbounded value becomes a stored
    // webhook-delivery row fanned out (with retries) to every subscriber.
    type: z.string().max(256),
    confidence: z.number(),
    detail: z.string().max(4096).optional(),
  }),
});
export type ChallengeDetected = z.infer<typeof ChallengeDetectedSchema>;

// ── HarnessOutbound.profileSaveFailed (harness → server; A3 W1364 / A2 decision 2026-06-12) ──
// Emitted on session TEARDOWN when a profile-backed session's save-back fails
// on any leg (serialize / seal / >256MiB / presigned-PUT) — the asymmetry fix:
// restore-failure was customer-visible (errored session) while save-failure was
// ops-stderr-only, so a customer relying on persisted state couldn't distinguish
// "saved" from "silently lost" until a stale NEXT-session restore. The session
// itself stays SUCCEEDED (this is an event, not a state change — A3 W966
// posture). TERMINAL by contract: the harness's internal one-shot PUT retry is
// exhausted before this emits, the outbound queue retries FRAMES not blobs, and
// teardown is one-shot — so there is deliberately NO will_retry field (A3
// confirmed it would always be false; add it back as an optional field if a
// save-retry path ever exists). `detail` is a short scrubbed ops-grade string
// (no secrets/paths). Relayed as the customer-facing
// `session.profile_save_failed` webhook. Plain object (lenient forward-compat),
// like the sibling frames.
export const ProfileSaveFailedSchema = z.object({
  type: z.literal('profileSaveFailed'),
  sessionId: z.string().min(1).max(HARNESS_FRAME_ID_MAX_LENGTH),
  profile_id: z.string().min(1).max(HARNESS_FRAME_ID_MAX_LENGTH),
  // `degenerate_dump` (A3 W2977/W2979, harness 2def1d39b2): the data-loss guard
  // DELIBERATELY skipped the save-back because a torn/empty fork dump would have
  // overwritten a known-good prior blob — the prior is PRESERVED (reassuring, NOT
  // data loss). Accept it so the strict enum doesn't reject the whole webhook.
  // `superseded` is the benign conditional-write guard: a newer profile write
  // won, so the stale save was refused without losing state. Preserve that
  // distinction instead of misreporting it to customers as `upload_failed`.
  // `.catch` keeps an unrecognised FUTURE reason from rejecting the frame too
  // (forward-compat; falls back to the generic 'upload_failed' bucket).
  reason: z
    .enum([
      'serialize_failed',
      'seal_failed',
      'too_large',
      'upload_failed',
      'degenerate_dump',
      'superseded',
    ])
    .catch('upload_failed'),
  // Security-audit hardening (2026-06-30) — bounded like the sibling hardened
  // fields in this file (bootId 256, ControlCommand.reason 512): this flows
  // unfiltered into WebhooksService.enqueueEvent (profile-save-failed-relay.ts)
  // with no truncation, so an unbounded value becomes a stored webhook-delivery
  // row fanned out (with retries) to every subscriber.
  detail: z.string().max(4096).optional(),
});
export type ProfileSaveFailed = z.infer<typeof ProfileSaveFailedSchema>;

// ── HarnessOutbound.pageState (harness → server; A3 W1238/W1240) ──
// Emitted on an AGENT-INITIATED navigate: loading → loaded | errored. Intended
// to drive the GUI loading-bar / error-overlay (W615/W616). `error.kind` is
// net|timeout ONLY (tls/dns/http-distinct + http_status need an A1 nav-error
// channel — A3 W1222); `http_status` is on the wire per the spec but the
// harness ALWAYS sends null. Recognized + typed here so the frame is no longer
// silently dropped at safeParse (was: unknown type → ignored). The CONSUMER
// (map → the session's REST page_state) is GATED on the agent↔driver session
// coupling: the harness emits pageState for the ControlPlaneAgentExecutor
// (agent / agt_) session, while GET /v1/sessions/:id/state.page_state is the
// DRIVER (ses_) session's `driver.getState`. Wiring pending A3 keying confirm
// (A2 bus W650). Plain object (lenient forward-compat), like the sibling frames.
export const PageStateFrameSchema = z.object({
  type: z.literal('pageState'),
  sessionId: z.string().min(1).max(HARNESS_FRAME_ID_MAX_LENGTH),
  // A3 W2845 — `stalled` added alongside loading/loaded/errored: the harness
  // `sweepStreamingHealth` watchdog detected a frozen-but-alive renderer (hung JS
  // / compositor deadlock — NOT a crash, so no crash-marker; the LiveKit pump
  // re-feeds the last frame forever so the stream still reports `live`). The
  // harness emits pageState{state:'stalled', url:<current>} on a sustained
  // zero-real-frame-delta + unresponsive-renderer probe, and pageState{state:
  // 'loaded'} when frames resume. The GUI renders a non-black "reconnecting —
  // page unresponsive" indicator OVER the last (frozen) frame, NOT the black
  // no-publisher overlay (that's 'never published'). Distinct from `errored` (a
  // hard page error) and `loading` (a navigation in flight).
  state: z.enum(['loading', 'loaded', 'errored', 'stalled']),
  // A3 W2730 (authoritative wire spec — Swift encodeIfPresent → nil keys are
  // OMITTED, not null): `url` is absent on reload, `error` only on 'errored', and
  // `http_status` is NEVER emitted. The previous REQUIRED url / error /
  // error.http_status therefore failed safeParse on EVERY real frame → it was
  // silently dropped → the page-state store stayed empty → no live URL in the
  // GUI. All three are now optional; `kind` is lenient (A3 emits net|timeout;
  // earlier docs listed http|tls|dns) so a frame is never dropped.
  //
  // `title` is accepted on ALL states (loading/loaded/stalled/errored), not just
  // 'loaded': the box may emit a title-only change frame (e.g. an in-page
  // document.title update with no navigation) and the GUI poll must be able to
  // self-heal the address-bar title from it. Top-level + optional, so it's never
  // required and a frame that omits it still validates.
  //
  // `tabId` (forward-compat plumbing — A3 contract pending, Q1 channel) lets the
  // box attribute a frame to a specific tab so the GUI can key live page-state
  // per tab instead of per session. Optional → backward-compatible (frames
  // without it validate + are carried as null downstream); the store stays a
  // per-session record until the per-tab keying contract is locked.
  url: z.string().max(PAGE_STATE_URL_MAX_LENGTH).nullable().optional(),
  title: z.string().max(PAGE_STATE_TEXT_MAX_LENGTH).nullable().optional(),
  tabId: z.string().min(1).max(HARNESS_FRAME_ID_MAX_LENGTH).optional(),
  error: z
    .object({
      kind: z.string().min(1).max(HARNESS_FRAME_ID_MAX_LENGTH),
      message: z.string().max(PAGE_STATE_TEXT_MAX_LENGTH),
      http_status: z.null().optional(),
    })
    .nullable()
    .optional(),
});
export type PageStateFrame = z.infer<typeof PageStateFrameSchema>;

// ── Cookies PULL (A2 W2816 / founder #48 "see all cookies, live") ─────
// CP→node REQUEST (`serializeCookiesRequest`): GET /v1/agent-sessions/:id/cookies
// issues this over the node's LIVE control WSS, keyed by `requestId`; A3's harness
// `getAllCookies` WD-extension (pending) returns the full jar via the `cookiesResult`
// below. NOT in HarnessOutbound (that's node→CP); this is CP→node like controlCommand.
export const CookiesRequestSchema = z
  .object({
    type: z.literal('cookiesRequest'),
    requestId: z.string().min(1),
    sessionId: z.string().min(1),
  })
  .strict();
export type CookiesRequest = z.infer<typeof CookiesRequestSchema>;

// One cookie from the session's WKWebsiteDataStore.httpCookieStore (incl. httpOnly).
// Exported so the cookie-import route can validate the customer's uploaded jar
// against the SAME shape the read/Export emits (no divergent Cookie definition).
// Security-audit hardening (2026-06-30) — real cookies are bounded to ~4KB
// total per RFC 6265; without a bound here a single cookie object (reused by
// the customer-facing write-path SetCookiesBodySchema, agent-sessions.ts,
// still under its own array .max(2000) + the 8 MiB body limit) could carry an
// ~8MB domain/name/value/path string. Bounds below are realistic per RFC 6265
// (domain/name/path ~512 bytes, value ~4096 bytes) with headroom.
export const CookieSchema = z.object({
  domain: z.string().max(512),
  name: z.string().max(512),
  value: z.string().max(4096),
  path: z.string().max(512).optional(),
  expires: z.number().nullable().optional(),
  httpOnly: z.boolean().optional(),
  secure: z.boolean().optional(),
  sameSite: z.enum(['Strict', 'Lax', 'None']).nullable().optional(),
});
export type Cookie = z.infer<typeof CookieSchema>;

// node→CP RESULT: echoes `requestId`. SUCCESS → `cookies` is the full jar; FAILURE
// (unknown/inactive session, fork-ext error) → `error` set, and the CP fast-fails the
// pending request. Plain object (lenient forward-compat), like the sibling frames.
export const CookiesResultSchema = z.object({
  type: z.literal('cookiesResult'),
  requestId: z.string().min(1).max(HARNESS_FRAME_ID_MAX_LENGTH),
  sessionId: z.string().min(1).max(HARNESS_FRAME_ID_MAX_LENGTH),
  // Security-audit hardening (2026-06-30) — matches the customer-facing
  // write-path's explicit z.array(CookieSchema).min(1).max(2000)
  // (SetCookiesBodySchema, agent-sessions.ts). Without this a compromised/
  // malformed harness node could return tens of thousands of cookies (up to
  // the 96 MiB frame cap), forwarded verbatim to any polling GUI/API client.
  cookies: z.array(CookieSchema).max(2000).optional(),
  error: z.string().max(HARNESS_RESULT_ERROR_MAX_LENGTH).optional(),
});
export type CookiesResult = z.infer<typeof CookiesResultSchema>;

// ── Cookies IMPORT / WRITE (founder cookie-import — the write-twin of the PULL) ──
// CP→node REQUEST (`serializeSetCookies`): POST /v1/agent-sessions/:id/cookies/set
// relays a customer's exported jar (the EXACT CookieSchema shape the PULL/Export
// emits — a cookies.json round-trips 1:1) over the node's LIVE control WSS, keyed by
// `requestId`; A3's harness `setCookies` WD-extension (pending) writes each cookie
// into the session's WKWebsiteDataStore.httpCookieStore and replies with the
// `setCookiesResult` below. NOT in HarnessOutbound (that's node→CP); this is CP→node
// like cookiesRequest / uploadFile. `cookies` REUSES CookieSchema verbatim (the
// import + the read share one jar shape — no divergent Cookie definition).
export const SetCookiesRequestSchema = z
  .object({
    type: z.literal('setCookies'),
    requestId: z.string().min(1),
    sessionId: z.string().min(1),
    cookies: z.array(CookieSchema),
  })
  .strict();
export type SetCookiesRequest = z.infer<typeof SetCookiesRequestSchema>;

// node→CP RESULT: echoes `requestId`. SUCCESS (full write) → `ok:true`; FAILURE
// (unknown/inactive session, write-fail) → `error` set, and the CP fast-fails the
// pending request. Plain object (lenient forward-compat), like the sibling frames.
export const SetCookiesResultSchema = z.object({
  type: z.literal('setCookiesResult'),
  requestId: z.string().min(1).max(HARNESS_FRAME_ID_MAX_LENGTH),
  sessionId: z.string().min(1).max(HARNESS_FRAME_ID_MAX_LENGTH),
  ok: z.boolean().optional(),
  error: z.string().max(HARNESS_RESULT_ERROR_MAX_LENGTH).optional(),
});
export type SetCookiesResult = z.infer<typeof SetCookiesResultSchema>;

// ── History NAVIGATION (sim browser back/forward — A3 W2870) ──────────
// CP→node REQUEST (`serializeNavigateHistory`): POST /v1/agent-sessions/:id/history
// drives the running session's WebKit back-forward list one step in `direction` over
// the node's LIVE control WSS (navigateHistory → navigateHistoryResult), keyed by
// `requestId`; A3's harness `navigateHistory` WD-extension (pending) calls goBack/
// goForward and replies with the `navigateHistoryResult` below. NOT in HarnessOutbound
// (that's node→CP); this is CP→node like cookiesRequest / setCookies / uploadFile.
// `direction` is the closed enum ['back','forward'] (the only two history steps).
export const NavigateHistoryRequestSchema = z
  .object({
    type: z.literal('navigateHistory'),
    requestId: z.string().min(1),
    sessionId: z.string().min(1),
    direction: z.enum(['back', 'forward']),
    // `tabId` (forward-compat plumbing — A3 harness contract pending, mirrors
    // PageStateFrame.tabId above): lets the CP tell the box WHICH tab's
    // back-forward list to step, instead of always the foreground tab. Optional
    // → backward-compatible (a step without it targets the session's current
    // tab, today's only behavior). Ships gated-inert like navigateHistory
    // itself already does: until A3's harness reads this field, it's ignored.
    tabId: z.string().optional(),
  })
  .strict();
export type NavigateHistoryRequest = z.infer<typeof NavigateHistoryRequestSchema>;

// node→CP RESULT: echoes `requestId`. SUCCESS (the step was applied) → `ok:true`;
// FAILURE (unknown/inactive session, no entry in that direction, WD error) → `error`
// set, and the CP fast-fails the pending request. Plain object (lenient forward-compat),
// like the sibling frames (setCookiesResult).
export const NavigateHistoryResultSchema = z.object({
  type: z.literal('navigateHistoryResult'),
  requestId: z.string().min(1).max(HARNESS_FRAME_ID_MAX_LENGTH),
  sessionId: z.string().min(1).max(HARNESS_FRAME_ID_MAX_LENGTH),
  ok: z.boolean().optional(),
  error: z.string().max(HARNESS_RESULT_ERROR_MAX_LENGTH).optional(),
});
export type NavigateHistoryResult = z.infer<typeof NavigateHistoryResultSchema>;

// ── File UPLOAD (A3 W2851 / founder "control files") ──────────────────
// CP→node REQUEST (`serializeUploadFile`): POST /v1/agent-sessions/:id/files relays
// the customer's file bytes (base64) over the node's LIVE control WSS, keyed by
// `requestId`; the harness writes them into the per-session 0o700 upload jail
// (DRIFTSTACK_UPLOAD_DIR, a hostile `name` reduced to a bare basename) and replies
// with the `uploadResult` below. NOT in HarnessOutbound (that's node→CP); this is
// CP→node like cookiesRequest. 64 MiB cap (enforced route-side + harness-side).
export const UploadFileRequestSchema = z
  .object({
    type: z.literal('uploadFile'),
    requestId: z.string().min(1),
    sessionId: z.string().min(1),
    name: z.string().min(1),
    mime: z.string().min(1),
    dataB64: z.string().min(1),
  })
  .strict();
export type UploadFileRequest = z.infer<typeof UploadFileRequestSchema>;

// The OPAQUE handle the harness returns — id maps (harness-side only) to the
// jailed on-disk path; a worker filesystem path is NEVER on the wire or exposed
// to the customer. The GUI drives a page's <input type=file> by `id`.
const UploadHandleSchema = z.object({
  id: z.string().min(1).max(HARNESS_FRAME_ID_MAX_LENGTH),
  name: z.string().max(HARNESS_RESULT_FILENAME_MAX_LENGTH),
  mime: z.string().max(HARNESS_RESULT_MIME_MAX_LENGTH),
  size: z.number().int().nonnegative().max(HARNESS_DOWNLOAD_DATA_MAX_BYTES),
});
export type UploadHandle = z.infer<typeof UploadHandleSchema>;

// node→CP RESULT: echoes `requestId`. SUCCESS → `handle`; FAILURE → `error` ∈
// {unknown or inactive session, invalid base64 payload, file too large (>64MiB),
// upload write failed}. Plain object (lenient forward-compat), like cookiesResult.
export const UploadResultSchema = z.object({
  type: z.literal('uploadResult'),
  requestId: z.string().min(1).max(HARNESS_FRAME_ID_MAX_LENGTH),
  sessionId: z.string().min(1).max(HARNESS_FRAME_ID_MAX_LENGTH),
  handle: UploadHandleSchema.optional(),
  error: z.string().max(HARNESS_RESULT_ERROR_MAX_LENGTH).optional(),
});
export type UploadResult = z.infer<typeof UploadResultSchema>;

// ── File DOWNLOAD (A3 W2856 / founder "control files") ────────────────
// Poll model (mirrors cookies — no push event). A page's download-delegate writes
// files strictly inside the per-session 0o700 download jail (DRIFTSTACK_DOWNLOAD_DIR,
// never ~/Downloads); these list + fetch them, keyed by `requestId`. CP→node REQUESTS
// (serialized by the codec) — NOT in HarnessOutbound (those are the node→CP results).
//   listDownloads → downloadsList ;  fetchDownload(name) → downloadData (64 MiB cap).
export const ListDownloadsRequestSchema = z
  .object({
    type: z.literal('listDownloads'),
    requestId: z.string().min(1),
    sessionId: z.string().min(1),
  })
  .strict();
export type ListDownloadsRequest = z.infer<typeof ListDownloadsRequestSchema>;

export const FetchDownloadRequestSchema = z
  .object({
    type: z.literal('fetchDownload'),
    requestId: z.string().min(1),
    sessionId: z.string().min(1),
    // A basename the customer picked from a prior downloadsList; the harness
    // re-sanitizes to a basename + confines it to the jail (defense in depth).
    name: z.string().min(1),
  })
  .strict();
export type FetchDownloadRequest = z.infer<typeof FetchDownloadRequestSchema>;

// One file in the session's download jail — `name` is a bare basename (never a path).
const DownloadEntrySchema = z.object({
  name: z.string().max(HARNESS_RESULT_FILENAME_MAX_LENGTH),
  size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  mime: z.string().max(HARNESS_RESULT_MIME_MAX_LENGTH).optional(),
});
export type DownloadEntry = z.infer<typeof DownloadEntrySchema>;

// node→CP RESULT: echoes `requestId`. SUCCESS → `files` (possibly empty = "no
// downloads yet"); FAILURE → `error`. Plain object (lenient), like cookiesResult.
export const DownloadsListResultSchema = z.object({
  type: z.literal('downloadsList'),
  requestId: z.string().min(1).max(HARNESS_FRAME_ID_MAX_LENGTH),
  sessionId: z.string().min(1).max(HARNESS_FRAME_ID_MAX_LENGTH),
  files: z.array(DownloadEntrySchema).max(HARNESS_DOWNLOAD_MAX_FILES).optional(),
  error: z.string().max(HARNESS_RESULT_ERROR_MAX_LENGTH).optional(),
});
export type DownloadsListResult = z.infer<typeof DownloadsListResultSchema>;

// node→CP RESULT: echoes `requestId`. SUCCESS → `mime` + `dataB64` (base64 bytes,
// 64 MiB cap, jail-confined); FAILURE → `error` (not found / too large / read failed).
export const DownloadDataResultSchema = z.object({
  type: z.literal('downloadData'),
  requestId: z.string().min(1).max(HARNESS_FRAME_ID_MAX_LENGTH),
  sessionId: z.string().min(1).max(HARNESS_FRAME_ID_MAX_LENGTH),
  name: z.string().max(HARNESS_RESULT_FILENAME_MAX_LENGTH),
  mime: z.string().max(HARNESS_RESULT_MIME_MAX_LENGTH).optional(),
  dataB64: boundedBase64Schema(
    HARNESS_DOWNLOAD_DATA_MAX_BASE64_LENGTH,
    HARNESS_DOWNLOAD_DATA_MAX_BYTES,
  ).optional(),
  error: z.string().max(HARNESS_RESULT_ERROR_MAX_LENGTH).optional(),
});
export type DownloadDataResult = z.infer<typeof DownloadDataResultSchema>;

// ── Profile TRIM / eviction (doc-150 §8.3 — storage cleanup) ──────────
// CP→node REQUEST (`serializeTrimProfile`): POST /v1/profiles/:id/trim issues this
// over ANY healthy node's LIVE control WSS, keyed by `requestId`; A3's harness opens
// the sealed blob with `dek`, drops the re-fetchable cache subtrees (NetworkCache /
// MediaCache + per-origin CacheStorage / ServiceWorkers) from `opaqueStorage` while
// KEEPING cookies / localStorage / IndexedDB / openTabs, re-seals under the SAME dek,
// PUTs the trimmed blob to `sealed_blob_put_url`, and replies with the `trimResult` below.
// UNLIKE the cookies/history frames this is OUT-OF-SESSION (a profile at rest in R2 has
// no live node), so it carries the JIT crypto envelope (the same fields
// SessionAssign.ProfileInfo carries) keyed by `profile_id` instead of a `sessionId`.
// NOT in HarnessOutbound (that's node→CP); this is CP→node like cookiesRequest.
// `sealed_blob_put_url` is REQUIRED (the trimmed blob must be written back); one of
// `sealed_blob` (inline ≤256KB) / `sealed_blob_url` (presigned GET) supplies the input.
// Field notes: `dek` = base64 of the 32-byte per-profile DEK (JIT, like
// SessionAssign.ProfileInfo.dek). One of `sealed_blob` (inline ≤256KB) / `sealed_blob_url`
// (presigned GET) supplies the input; `sealed_blob_put_url` (REQUIRED) is where the node
// PUTs the trimmed blob back.
// Wire keys mirror the SessionAssign.ProfileInfo convention exactly (A3's Swift
// Codable decoder is the source of truth): the envelope fields `type` + `requestId`
// stay camelCase like every other CP→node request frame, but the profile-payload
// fields are snake_case (`profile_id`, `dek`, `sealed_blob`, `sealed_blob_url`,
// `sealed_blob_put_url`) — the same CodingKeys SessionAssignProfileSchema emits. The
// previous camelCase emit (`profileId` / `sealedBlob…`) made the box's Codable decode
// fail with keyNotFound 'profile_id' so trim NEVER executed.
export const TrimProfileRequestSchema = z
  .object({
    type: z.literal('trimProfile'),
    requestId: z.string().min(1),
    profile_id: z.string().min(1),
    dek: z.string().min(1),
    sealed_blob: z.string().min(1).optional(),
    sealed_blob_url: z.string().min(1).optional(),
    sealed_blob_put_url: z.string().min(1),
  })
  .strict();
export type TrimProfileRequest = z.infer<typeof TrimProfileRequestSchema>;

// node→CP RESULT: echoes `requestId` + `profileId`. SUCCESS → `ok:true` +
// `newSizeBytes` (the re-sealed trimmed byte count, which A2 persists as the new
// size_bytes) + `bytesReclaimed` (oldSealed.count - newSizeBytes, for the "freed N
// MB" UI). FAILURE (open / seal / PUT) → `error` set + `ok` absent/false, and the CP
// fast-fails the pending request WITHOUT updating the row. Plain object (lenient
// forward-compat), like the sibling result frames.
export const TrimProfileResultSchema = z.object({
  type: z.literal('trimResult'),
  requestId: z.string().min(1).max(HARNESS_FRAME_ID_MAX_LENGTH),
  profileId: z.string().min(1).max(HARNESS_FRAME_ID_MAX_LENGTH),
  ok: z.boolean().optional(),
  newSizeBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  bytesReclaimed: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  error: z.string().max(HARNESS_RESULT_ERROR_MAX_LENGTH).optional(),
});
export type TrimProfileResult = z.infer<typeof TrimProfileResultSchema>;

// ── HarnessOutbound union (server DECODES) ────────────────────────────
// All 13 variants pinned. intentResult + sessionStatus are consumed precisely;
// heartbeat / capabilityReport / errorEvent / profileSaved / challengeDetected
// / pageState / profileSaveFailed are accepted (typed) + routed where a
// consumer is wired (profileSaved consumer = step (d); challengeDetected relay
// → session.challenge_detected W393; pageState → SessionPageStateStore W650;
// profileSaveFailed relay → session.profile_save_failed, A3 W1364). cookiesResult
// (founder #48) is correlated by `requestId` inside the connection's
// CookiesRequestCorrelator — it settles a pending GET /:id/cookies request.
// uploadResult (A3 W2851, file-control) is likewise correlated by `requestId`
// inside the connection's UploadRequestCorrelator — it settles a pending POST
// /:id/files request. setCookiesResult (cookie-import) is the write-twin of
// cookiesResult — correlated by `requestId` inside the connection's
// SetCookiesRequestCorrelator, settling a pending POST /:id/cookies/set.
// navigateHistoryResult (sim back/forward, A3 W2870) is likewise the write-twin of
// setCookiesResult — correlated by `requestId` inside the connection's
// NavigateHistoryRequestCorrelator, settling a pending POST /:id/history.
// trimResult (doc-150 §8.3, profile storage eviction) is the OUT-OF-SESSION sibling
// — correlated by `requestId` inside the connection's TrimProfileRequestCorrelator
// (keyed by `profileId`, not sessionId), settling a pending POST /:id/trim.
export const HarnessOutboundSchema = z.union([
  IntentResultEnvelopeSchema,
  SessionStatusSchema,
  HeartbeatSchema,
  CapabilityReportSchema,
  ErrorEventSchema,
  ProfileSavedSchema,
  ChallengeDetectedSchema,
  PageStateFrameSchema,
  ProfileSaveFailedSchema,
  CookiesResultSchema,
  SetCookiesResultSchema,
  NavigateHistoryResultSchema,
  UploadResultSchema,
  DownloadsListResultSchema,
  DownloadDataResultSchema,
  TrimProfileResultSchema,
]);
export type HarnessOutbound = z.infer<typeof HarnessOutboundSchema>;
export type ProfileSaved = z.infer<typeof ProfileSavedSchema>;
