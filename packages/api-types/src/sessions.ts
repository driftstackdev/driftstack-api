import { z } from 'zod';
import {
  ApiKeyIdSchema,
  AccountIdSchema,
  Iso8601Schema,
  SelectableArchetypeIdSchema,
  SessionEventIdSchema,
  SessionIdSchema,
} from './common.js';
import { EgressCapabilitiesSchema } from './egress.js';
import { ProfileIdInputSchema } from './profiles.js';

// ───────────────────────────────────────────────────────────────────────────
// Session resource
// ───────────────────────────────────────────────────────────────────────────

export const SessionStatusSchema = z.enum(['creating', 'ready', 'busy', 'destroyed', 'errored']);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

export const ArchetypeSchema = z
  .string()
  .regex(/^[a-z0-9_]+$/, {
    message: 'device profile id is lowercase letters, digits and underscores',
  })
  .min(3)
  .max(60);

/*
 * V-169 — session purpose drives harness configuration in the WebKit
 * driver (per AFP Layer 1 design from Agent 1's Phase 3 work; see
 * `docs/architecture/afp-harness-configuration.md` once Agent 1 lands
 * the cross-reference doc).
 *
 * Semantics:
 * - `production_customer` (default): ephemeral context +
 *   `_resourceLoadStatisticsEnabled=YES`. ATFP fires per iOS per-site
 *   logic. This is what every paying-customer session uses.
 * - `cumulative_rig_validation`: persistent context, NOT ephemeral.
 *   ATFP doesn't fire (matches the V-179 baseline rig). Used by Agent 1
 *   to validate that the static-fingerprint surface remains
 *   bit-identical across releases.
 * - `test_domain_probe`: ephemeral context on tracker-context URLs.
 *   ATFP fires deterministically. Used by Agent 1 for adversarial
 *   validation against detection vendors.
 *
 * The MockDriver accepts the field but doesn't act on it (the WebKit
 * driver is where the harness branching lives). Production customer
 * sessions use the default; the other two purposes are reserved for
 * internal validation tools and not part of the customer-facing API
 * contract today.
 */
/**
 * What a session is for. Leave it unset unless you have been asked to set
 * it: `production_customer` is the value every customer session uses.
 *
 * - `production_customer` (the default) — a private browsing context that
 *   keeps nothing between sessions, with iOS tracking prevention active as
 *   it is on a real device.
 * - `cumulative_rig_validation` — a context that persists instead, used to
 *   check that a device's fingerprint stays identical across releases.
 * - `test_domain_probe` — a private context aimed at tracker-owned URLs,
 *   used for adversarial testing against detection vendors.
 *
 * The last two are validation purposes and are not part of the customer API
 * contract today.
 */
export const SessionPurposeSchema = z.enum([
  'production_customer',
  'cumulative_rig_validation',
  'test_domain_probe',
]);
export type SessionPurpose = z.infer<typeof SessionPurposeSchema>;
export const DEFAULT_SESSION_PURPOSE: SessionPurpose = 'production_customer';

/**
 * How a session behaves like a person: the pace of its touches, scrolling
 * and typing, and how long it pauses between them. `casual`, `regular` and
 * `power_user` run from slowest to fastest. Optional when you create a
 * session — omit it and the middle profile is used.
 */
export const BehavioralProfileSchema = z.enum(['casual', 'regular', 'power_user']);
export type BehavioralProfile = z.infer<typeof BehavioralProfileSchema>;
export const DEFAULT_BEHAVIORAL_PROFILE: BehavioralProfile = 'regular';

/**
 * Caller-supplied session metadata. Bounded at the API layer: the
 * serialized JSON must not exceed 8 KiB so a single create can't persist
 * an arbitrarily large blob (it is stored verbatim + echoed on every
 * read). The `.refine` makes the bound a schema-level contract — the
 * previous comment claimed a bound that no body-limit or schema actually
 * enforced. Free-form key/value object otherwise (opaque to the server).
 */
export const SESSION_METADATA_MAX_BYTES = 8192;
const sessionMetadataUtf8Encoder = new TextEncoder();
export const SessionMetadataSchema = z
  .record(z.unknown())
  .refine(
    (v) =>
      sessionMetadataUtf8Encoder.encode(JSON.stringify(v)).byteLength <= SESSION_METADATA_MAX_BYTES,
    {
      message: `metadata too large (max ${SESSION_METADATA_MAX_BYTES.toString()} bytes serialized)`,
    },
  );

export const SessionSchema = z.object({
  id: SessionIdSchema,
  account_id: AccountIdSchema,
  api_key_id: ApiKeyIdSchema,
  status: SessionStatusSchema,
  archetype: ArchetypeSchema,
  /** The session purpose; defaults to `production_customer`. */
  purpose: SessionPurposeSchema,
  label: z.string().nullable(),
  metadata: SessionMetadataSchema.nullable(),
  /**
   * What this session's SOCKS5 proxy turned out to support — see
   * `EgressCapabilitiesSchema`. Null until the report arrives, shortly
   * after the proxy is wired up, and permanently null for a session that
   * does not use SOCKS5.
   */
  egress_capabilities: EgressCapabilitiesSchema.nullable(),
  /**
   * The egress report exactly as it was reported, kept beside the typed
   * `egress_capabilities` view of it. Treat it as opaque JSON whose shape
   * can grow; read `egress_capabilities` unless you need something it does
   * not expose. Null until the report arrives.
   */
  egress_capability_report: z.record(z.unknown()).nullable(),
  created_at: Iso8601Schema,
  updated_at: Iso8601Schema,
  last_state_at: Iso8601Schema.nullable(),
  destroyed_at: Iso8601Schema.nullable(),
});

export type Session = z.infer<typeof SessionSchema>;

// ───────────────────────────────────────────────────────────────────────────
// Create session
// ───────────────────────────────────────────────────────────────────────────

export const SessionLabelSchema = z.string().max(120);

export const CreateSessionRequestSchema = z.object({
  archetype: SelectableArchetypeIdSchema.optional(),
  /** The session purpose; defaults to `production_customer`. */
  purpose: SessionPurposeSchema.optional(),
  label: SessionLabelSchema.optional(),
  metadata: SessionMetadataSchema.optional(),
  /*
   * 2026-05-20 — profile binding. When supplied, the server records
   * the session as belonging to this profile (cookies, localStorage,
   * archetype inherited from the profile by default) + bumps the
   * profile's `last_used_at`. Server validates that the profile belongs
   * to the EFFECTIVE account — your own, or the owner you are acting as
   * via `X-Driftstack-Account`; a profile_id outside it returns 404 to
   * avoid leaking existence.
   *
   * V-1101 — this said "belongs to the calling account", which inverts the
   * rule for exactly the callers who need it. `routes/sessions.ts` resolves
   * `ownerAccountId = effective.kind === 'team' ? effective.accountId :
   * ctx.account.id` and scopes the lookup to THAT, so a team admin acting
   * as an owner must pass one of the OWNER's profiles; passing their own
   * gets the 404 the sentence promised for someone else's.
   */
  /**
   * Start the session from a saved profile. It inherits that profile's
   * cookies, local storage and device, and the profile's `last_used_at` is
   * updated.
   *
   * The profile must belong to the account you are acting AS — your own, or
   * the owner named by `X-Driftstack-Account`. A profile outside that
   * account returns 404 rather than revealing that it exists, so acting for
   * an owner means passing one of the OWNER's profiles and not your own.
   *
   * Omit it for an ephemeral session that keeps nothing. Accepts either the
   * `prof_<uuid>` id the profiles API returns or a bare uuid, so the
   * prefixed form validates client-side too.
   */
  profile_id: ProfileIdInputSchema.optional(),
  /**
   * How this session should behave like a person — see
   * `BehavioralProfileSchema`. Omit it for the default. It is chosen once
   * and holds for the life of the session.
   */
  behavioral_profile: BehavioralProfileSchema.optional(),
});

export type CreateSessionRequest = z.infer<typeof CreateSessionRequestSchema>;

/**
 * One-shot profile launch accepts only the same bounded label override as
 * create-session. `.strict()` is intentional: silently stripping a future
 * transport-looking field would make the launch appear to honor behavior the
 * driver never received.
 */
export const LaunchProfileRequestSchema = CreateSessionRequestSchema.pick({ label: true }).strict();
export type LaunchProfileRequest = z.infer<typeof LaunchProfileRequestSchema>;

export const CreateSessionResponseSchema = SessionSchema;
export type CreateSessionResponse = z.infer<typeof CreateSessionResponseSchema>;

// ───────────────────────────────────────────────────────────────────────────
// Navigate
// ───────────────────────────────────────────────────────────────────────────

export const NavigateRequestSchema = z.object({
  // W487 — http/https only. A browser-automation navigate has no legitimate
  // file:// / ftp:// / data: use, in ANY egress architecture — rejecting other
  // schemes at the schema also shields the AI-agent path from prompt-injected
  // file:// navigates. (Internal-IP/metadata blocklisting is deliberately NOT
  // here: under the locked customer-SOCKS5-egress design, private IPs are the
  // CUSTOMER's own network — a server-side blocklist lands at driver wiring.)
  // V-1499 — a `regex`, not a `refine`, so the scheme allowlist reaches the
  // published document. A refine is a runtime predicate JSON Schema cannot
  // express, so `url` shipped as `{ type: string, format: uri }` and a generated
  // client had no way to know `file://` is refused — on the very field the
  // comment above calls a prompt-injection shield.
  //
  // Explicit character classes rather than the `/i` flag, which has no JSON
  // Schema expression: `HTTPS://x.com` and `HtTp://x.com` are both accepted
  // today (probed), so a lowercase-only pattern would advertise as invalid
  // something the server takes — the over-narrow direction V-1476 established as
  // the worse one. Same reasoning as `PROFILE_UUID_BODY` in V-1489.
  url: z
    .string()
    .url()
    .regex(/^[Hh][Tt][Tt][Pp][Ss]?:\/\//, {
      message: 'Only http:// and https:// URLs can be navigated.',
    }),
  // Per-call timeout (ms); default applied server-side.
  timeout_ms: z.number().int().min(1000).max(120_000).optional(),
  // Wait policy after navigation completes.
  wait_until: z.enum(['load', 'domcontentloaded', 'networkidle']).default('load'),
});

export type NavigateRequest = z.infer<typeof NavigateRequestSchema>;
/** Caller-side shape: fields with server-side defaults are optional. */
export type NavigateRequestInput = z.input<typeof NavigateRequestSchema>;

export const NavigateResponseSchema = z.object({
  url: z.string().url(),
  status: z.number().int().min(100).max(599),
  // Final URL (may differ from request after redirects).
  final_url: z.string().url(),
  duration_ms: z.number().int().nonnegative(),
});

export type NavigateResponse = z.infer<typeof NavigateResponseSchema>;

// ───────────────────────────────────────────────────────────────────────────
// Interact
// ───────────────────────────────────────────────────────────────────────────

// Customer-facing InteractAction is intent-only per L-001 — coordinate
// primitives (tap_at, tap.offset, etc.) live on the gui_control plane,
// not here. See docs/locked-decisions.md.
export const InteractActionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('tap'),
    selector: z.string().min(1),
  }),
  z.object({
    kind: z.literal('type'),
    selector: z.string().min(1),
    text: z.string().max(10_000),
    // Requested inter-key delay in ms; the public contract accepts only 0..500.
    delay_ms: z.number().int().min(0).max(500).optional(),
    // W1150 (A3 W1149) — mark the field sensitive (card number / OTP / PIN):
    // the harness suppresses visible typo-corrections while typing it (a
    // momentary wrong digit trips per-keystroke validation or auto-submit-
    // on-length). DOM type=password fields get this automatically; this flag
    // covers sensitive values in tel/text inputs the DOM can't reveal.
    sensitive: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal('scroll'),
    selector: z.string().min(1).optional(),
    delta_x: z.number().int().default(0),
    delta_y: z.number().int().default(0),
  }),
  z.object({
    kind: z.literal('press'),
    key: z.string().min(1).max(20),
  }),
]);

export type InteractAction = z.infer<typeof InteractActionSchema>;

export const InteractRequestSchema = z.object({
  action: InteractActionSchema,
  timeout_ms: z.number().int().min(100).max(60_000).optional(),
});

export type InteractRequest = z.infer<typeof InteractRequestSchema>;

export const InteractResponseSchema = z.object({
  ok: z.literal(true),
  duration_ms: z.number().int().nonnegative(),
});

export type InteractResponse = z.infer<typeof InteractResponseSchema>;

// ───────────────────────────────────────────────────────────────────────────
// Wait
// ───────────────────────────────────────────────────────────────────────────

export const WaitConditionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('selector'), selector: z.string().min(1) }),
  z.object({ kind: z.literal('selector_hidden'), selector: z.string().min(1) }),
  z.object({ kind: z.literal('url_matches'), pattern: z.string().min(1) }),
  z.object({ kind: z.literal('time'), ms: z.number().int().min(0).max(60_000) }),
]);

export type WaitCondition = z.infer<typeof WaitConditionSchema>;

export const WaitRequestSchema = z.object({
  condition: WaitConditionSchema,
  timeout_ms: z.number().int().min(100).max(120_000).optional(),
});

export type WaitRequest = z.infer<typeof WaitRequestSchema>;

export const WaitResponseSchema = z.object({
  satisfied: z.boolean(),
  duration_ms: z.number().int().nonnegative(),
});

export type WaitResponse = z.infer<typeof WaitResponseSchema>;

// ───────────────────────────────────────────────────────────────────────────
// Get state
// ───────────────────────────────────────────────────────────────────────────

// W615 (GUI-UX item 3, cross-agent contract Addendum 5/7) — page lifecycle
// as the harness sees it. The harness owns navigation, so only it knows
// "loading" vs "loaded" vs "errored (DNS / TLS / HTTP 503 / timeout)";
// a screenshot can't reveal these. Emitted by the harness on navigation
// lifecycle; relayed here so pollers (the GUI live view) can render a
// loading bar + an honest "this site couldn't be reached" overlay.
export const PageStateErrorKindSchema = z.enum(['http', 'tls', 'dns', 'net', 'timeout']);
export type PageStateErrorKind = z.infer<typeof PageStateErrorKindSchema>;

export const PageStateSchema = z.object({
  state: z.enum(['loading', 'loaded', 'errored']),
  /** Present only when state === 'errored'. */
  error: z
    .object({
      kind: PageStateErrorKindSchema,
      /** For kind 'http': the status the page navigation got (e.g. 503). */
      http_status: z.number().int().min(100).max(599).optional(),
      message: z.string().max(500),
    })
    .optional(),
});
export type PageState = z.infer<typeof PageStateSchema>;

export const SessionStateSchema = z.object({
  url: z.string().url().nullable(),
  title: z.string().nullable(),
  // Serialised cookies (driver-controlled shape).
  cookies: z.array(z.record(z.unknown())),
  // Local storage snapshot.
  local_storage: z.record(z.string()),
  // W615 — null until the driver/harness reports a lifecycle event (the
  // mock driver reports 'loaded' after navigate; the real harness emit is
  // the A3 side of the contract). Additive: pollers that ignore it are
  // unaffected.
  page_state: PageStateSchema.nullable().default(null),
  captured_at: Iso8601Schema,
});

export type SessionState = z.infer<typeof SessionStateSchema>;

// ───────────────────────────────────────────────────────────────────────────
// Capture (screenshot / DOM / etc.)
// ───────────────────────────────────────────────────────────────────────────

export const CaptureKindSchema = z.enum(['screenshot', 'dom_snapshot', 'pdf']);
export type CaptureKind = z.infer<typeof CaptureKindSchema>;

export const CaptureRequestSchema = z.object({
  kind: CaptureKindSchema,
  // For screenshots: full-page or viewport.
  full_page: z.boolean().default(false),
});

export type CaptureRequest = z.infer<typeof CaptureRequestSchema>;
/** Caller-side shape: fields with server-side defaults are optional. */
export type CaptureRequestInput = z.input<typeof CaptureRequestSchema>;

export const CaptureResponseSchema = z.object({
  kind: CaptureKindSchema,
  // base64 for binary captures, raw text for DOM snapshots.
  data: z.string(),
  encoding: z.enum(['base64', 'utf8']),
  byte_size: z.number().int().nonnegative(),
  duration_ms: z.number().int().nonnegative(),
});

export type CaptureResponse = z.infer<typeof CaptureResponseSchema>;

// ───────────────────────────────────────────────────────────────────────────
// Extract (read structured data from the page) — harness intent, A3 W456.
// POST /v1/sessions/:id/extract: a batch of named extractions, each a
// selector + how to read it. The harness selects injection-safely (selectors
// pass as a script arg, never interpolated) and returns the values keyed by
// `name`; the API layer unwraps the WebDriver `{value:…}` envelope.
// ───────────────────────────────────────────────────────────────────────────

export const ExtractionTypeSchema = z.enum(['text', 'attribute', 'list']);
export type ExtractionType = z.infer<typeof ExtractionTypeSchema>;

/** Per-field sub-extraction for a `type: 'list'` extraction — runs against
 *  each matched element. Nested lists are not supported (one level), so the
 *  sub-type is text | attribute only. */
export const ListFieldExtractionSchema = z.object({
  type: z.enum(['text', 'attribute']),
  /** Required when `type: 'attribute'` — which attribute to read. */
  attribute: z.string().optional(),
  /** Optional sub-selector relative to the matched list element. */
  selector: z.string().optional(),
});
export type ListFieldExtraction = z.infer<typeof ListFieldExtractionSchema>;

export const ExtractionSpecSchema = z.object({
  /** Result key in the response `value` map. */
  name: z.string().min(1),
  selector: z.string().min(1),
  type: ExtractionTypeSchema,
  /** Required when `type: 'attribute'` — which attribute to read. */
  attribute: z.string().optional(),
  /** `'number'` parses the extracted text as numeric. */
  transform: z.literal('number').optional(),
  /** For `type: 'list'`: per-field sub-extraction against each matched element. */
  extract: z.record(z.string(), ListFieldExtractionSchema).optional(),
});
export type ExtractionSpec = z.infer<typeof ExtractionSpecSchema>;

export const ExtractRequestSchema = z.object({
  /** Batch of named extractions, at most 100 per request. */
  extractions: z.array(ExtractionSpecSchema).min(1).max(100),
});
export type ExtractRequest = z.infer<typeof ExtractRequestSchema>;

export const ExtractResponseSchema = z.object({
  /** Extracted values keyed by each extraction's `name`. Heterogeneous by
   *  design: a `text` extraction yields a string (number when
   *  `transform: 'number'`), `attribute` a string, `list` an array (of strings
   *  or, with `extract`, per-element field objects). This is the customer's own
   *  page data, returned opaque. */
  value: z.record(z.string(), z.unknown()),
});
export type ExtractResponse = z.infer<typeof ExtractResponseSchema>;

// ───────────────────────────────────────────────────────────────────────────
// Search (find the search field, type the query realistically, submit) —
// harness intent, A3 (bus W244/W245). POST /v1/sessions/:id/search.
// ───────────────────────────────────────────────────────────────────────────

export const SearchRequestSchema = z.object({
  /** The search text, typed via the behavioural send-keys path. */
  query: z.string().min(1).max(10_000),
  /** Explicit search-input selector; omit and the field is found for you. */
  search_selector: z.string().min(1).max(262_144).optional(),
  /** Submit (Return) after typing. Defaults to true. */
  submit: z.boolean().default(true),
  /** Optional selector to wait for after submit (results loaded); omit → a
   *  brief idle settle. When present, drives `results_visible` in the response. */
  wait_for_results_selector: z.string().min(1).max(262_144).optional(),
  /** Caps the `wait_for_results_selector` wait (seconds). Omit for the
   *  default of 10s. A timeout is `results_visible: false`, not an error. */
  timeout_seconds: z.number().int().min(1).max(120).optional(),
});
export type SearchRequest = z.infer<typeof SearchRequestSchema>;
/** Caller-side shape: fields with server-side defaults are optional. */
export type SearchRequestInput = z.input<typeof SearchRequestSchema>;

const SearchDurationMsSchema = z.number().int().min(0).max(600_000);

const SearchCompletedResponseSchema = z
  .object({
    /** Whether the caller-requested submission occurred. A complete search
     *  may intentionally leave this false when `submit:false` was requested. */
    submitted: z
      .boolean()
      .describe(
        'Whether the search was submitted. False is not a failure here — it is what you get when the request asked for `submit: false`.',
      ),
    query_truncated: z.literal(false),
    /** Present only when `wait_for_results_selector` was given: whether that
     *  selector became visible before the wait timed out (timeout → false, not
     *  an error). */
    results_visible: z
      .boolean()
      .optional()
      .describe(
        'Present only when the request supplied `wait_for_results_selector`. False means the selector did not appear before the wait timed out, which is a result rather than an error.',
      ),
    /** Producer-observed duration under the activation-held 600-second fence. */
    duration_ms: SearchDurationMsSchema,
  })
  .strict();

const SearchTruncatedResponseSchema = z
  .object({
    /** Safe refusal: an incomplete query is never submitted. */
    submitted: z
      .literal(false)
      .describe('Always false on this branch: a truncated query is never submitted.'),
    query_truncated: z.literal(true),
    duration_ms: SearchDurationMsSchema,
  })
  .strict();

/** Query truncation is an exact zero-submit terminal and cannot carry a
 *  results assessment. */
export const SearchResponseSchema = z.discriminatedUnion('query_truncated', [
  SearchCompletedResponseSchema,
  SearchTruncatedResponseSchema,
]);
export type SearchResponse = z.infer<typeof SearchResponseSchema>;

// ───────────────────────────────────────────────────────────────────────────
// Login (heuristic credential login) — harness intent, A3 (bus W244/W245).
// POST /v1/sessions/:id/login. The password is SENSITIVE: it flows to the
// harness send-keys path but is never logged (the service records only the
// operation label on failure). Recipes are capture-only today — there is no
// recipe-execution surface — so this intent is the way to drive a login.
// ───────────────────────────────────────────────────────────────────────────

// Named SessionLogin* (not Login*) — the auth module already owns
// LoginRequest/LoginResponse for the account-login (email+password → session
// token); this is the distinct in-browser credential-login driver op.
export const SessionLoginRequestSchema = z.object({
  username: z.string().min(1).max(10_000),
  /** SENSITIVE — typed via the behavioural send-keys path; never logged. */
  password: z.string().min(1).max(10_000),
  /** Explicit username/email field selector; omit and the field is found for you. */
  username_selector: z.string().min(1).max(262_144).optional(),
  /** Explicit password field selector; omit → heuristic. */
  password_selector: z.string().min(1).max(262_144).optional(),
  /** Explicit submit control; omit → Return on the password field. */
  submit_selector: z.string().min(1).max(262_144).optional(),
  /** Optional selector whose post-submit presence means success; omit → the
   *  password-field-gone + URL heuristic. Robust for known / multi-step logins. */
  success_selector: z.string().min(1).max(262_144).optional(),
  /** Caps the post-submit success wait (seconds). Omit for the default of 10s. */
  timeout_seconds: z.number().int().min(1).max(120).optional(),
});
export type SessionLoginRequest = z.infer<typeof SessionLoginRequestSchema>;

const SessionLoginDurationMsSchema = z.number().int().min(0).max(600_000);

const SessionLoginSubmittedResponseSchema = z
  .object({
    submitted: z.literal(true),
    credentials_truncated: z.literal(false),
    /** Post-submit assessment. Callers must still handle a submitted login that
     *  honestly reaches a captcha, 2FA step, or login-required page. */
    logged_in: z
      .boolean()
      .describe(
        'Post-submit assessment, not a guarantee. False on a submitted login is a real outcome — the page may have reached a captcha, a 2FA step, or a login-required page — so handle it rather than treating it as an error.',
      ),
    /** The session URL after submit settled, when the browser supplied one.
     *  Not redacted or otherwise rewritten: an authorized `GET /state` already
     *  returns the same URL. Keep it out of logs like any other session URL. */
    post_login_url: z.string().optional(),
    /** How long the login took, measured where it ran. The public contract
     *  caps a whole login at 600 seconds. */
    duration_ms: SessionLoginDurationMsSchema,
  })
  .strict();

const SessionLoginTruncatedResponseSchema = z
  .object({
    submitted: z
      .literal(false)
      .describe(
        'Always false on this branch. Truncated credentials are refused before submission, so nothing was sent to the page.',
      ),
    credentials_truncated: z.literal(true),
    logged_in: z.literal(false),
    /** Time spent before the safe zero-submit truncation terminal, subject to
     *  the same activation-held 600-second result bound. */
    duration_ms: SessionLoginDurationMsSchema,
  })
  .strict();

/** A credential truncation is a safe refusal, never an ambiguous submitted
 *  result. The discriminator prevents callers from accepting contradictory
 *  combinations or a post-login URL on the zero-submit branch. */
export const SessionLoginResponseSchema = z.discriminatedUnion('credentials_truncated', [
  SessionLoginSubmittedResponseSchema,
  SessionLoginTruncatedResponseSchema,
]);
export type SessionLoginResponse = z.infer<typeof SessionLoginResponseSchema>;

// ───────────────────────────────────────────────────────────────────────────
// Session events (for audit / debugging)
// ───────────────────────────────────────────────────────────────────────────

export const SessionEventTypeSchema = z.enum([
  'created',
  'navigated',
  'interacted',
  'waited',
  'state_captured',
  'screenshot_captured',
  'destroyed',
  'errored',
]);

export const SessionEventSchema = z.object({
  id: SessionEventIdSchema,
  session_id: SessionIdSchema,
  type: SessionEventTypeSchema,
  payload: z.record(z.unknown()).nullable(),
  duration_ms: z.number().int().nonnegative().nullable(),
  created_at: Iso8601Schema,
});

export type SessionEvent = z.infer<typeof SessionEventSchema>;
