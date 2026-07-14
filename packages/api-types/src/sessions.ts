import { z } from 'zod';
import {
  ApiKeyIdSchema,
  AccountIdSchema,
  Iso8601Schema,
  SessionEventIdSchema,
  SessionIdSchema,
} from './common.js';
import { EgressCapabilitiesSchema } from './egress.js';

// ───────────────────────────────────────────────────────────────────────────
// Session resource
// ───────────────────────────────────────────────────────────────────────────

export const SessionStatusSchema = z.enum(['creating', 'ready', 'busy', 'destroyed', 'errored']);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

export const ArchetypeSchema = z
  .string()
  .regex(/^[a-z0-9_]+$/, { message: 'archetype slug is lowercase alphanumeric + underscores' })
  .min(3)
  .max(60);

/**
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
export const SessionPurposeSchema = z.enum([
  'production_customer',
  'cumulative_rig_validation',
  'test_domain_probe',
]);
export type SessionPurpose = z.infer<typeof SessionPurposeSchema>;
export const DEFAULT_SESSION_PURPOSE: SessionPurpose = 'production_customer';

/**
 * 2026-06-05 — per-session behavioural persona (file 05 §"Persona model").
 * Selects the human-behaviour profile the harness drives the session with:
 * touch/scroll/typing cadence + dwell distributions. The values mirror the
 * canonical persona catalogue in `@driftstack/behavioural-simulation`
 * (`PersonaId`); a cross-source guard pins them in lockstep. The control
 * plane passes the chosen persona to the driver at create-time; the harness
 * (single source of truth for the behavioural model) consumes it. Optional
 * on session-create; the service defaults it to the middle persona.
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
  /** V-169 — harness purpose; defaults to `production_customer`. */
  purpose: SessionPurposeSchema,
  label: z.string().nullable(),
  metadata: SessionMetadataSchema.nullable(),
  /**
   * Harness-reported SOCKS5 egress capabilities (migration 0045 +
   * cross-agent contract 7d5992d9). Null until the harness emits the
   * `egress.capability_report` event after proxy wire-up; non-SOCKS5
   * sessions stay null permanently. Shape pinned by
   * `EgressCapabilitiesSchema` in `./egress.ts`.
   */
  egress_capabilities: EgressCapabilitiesSchema.nullable(),
  /**
   * Arc 5 EGRESS eg.1 — RAW harness-emitted event payload (migration
   * 0054). Stored alongside `egress_capabilities` (the derived view)
   * for forensics + schema-evolution safety. Opaque JSON; consumers
   * should prefer `egress_capabilities` for typed access. Null until
   * the harness emits.
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

export const CreateSessionRequestSchema = z.object({
  archetype: ArchetypeSchema.optional(),
  /** V-169 — harness purpose; defaults to `production_customer`. */
  purpose: SessionPurposeSchema.optional(),
  label: z.string().max(120).optional(),
  metadata: SessionMetadataSchema.optional(),
  /**
   * 2026-05-20 — profile binding. When supplied, the server records
   * the session as belonging to this profile (cookies, localStorage,
   * archetype inherited from the profile by default) + bumps the
   * profile's `last_used_at`. Server validates that the profile
   * belongs to the calling account; cross-account profile_id returns
   * 404 to avoid leaking existence. Optional so ephemeral sessions
   * (no persistent state) still work as before. Accepts the canonical
   * `prof_<uuid>` id the profiles API returns OR a bare uuid (the server
   * normalizes); kept loose here so the prefixed form validates client-side too.
   */
  profile_id: z.string().optional(),
  /**
   * 2026-06-05 — behavioural persona for this session. When supplied, the
   * harness drives touch/scroll/typing with the selected persona's profile;
   * omitted → the server applies DEFAULT_BEHAVIORAL_PROFILE. Set once for the
   * session's lifetime (file 05 §"Persona consistency").
   */
  behavioral_profile: BehavioralProfileSchema.optional(),
});

export type CreateSessionRequest = z.infer<typeof CreateSessionRequestSchema>;

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
  url: z
    .string()
    .url()
    .refine((u) => /^https?:\/\//i.test(u), {
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
    // ms between keystrokes; mock driver respects bounds, real driver clamps.
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
  /** Batch of named extractions (harness bound: ≤100). */
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
  query: z.string().min(1),
  /** Explicit search-input selector; omit → harness heuristic detection. */
  search_selector: z.string().optional(),
  /** Submit (Return) after typing. Defaults to true. */
  submit: z.boolean().default(true),
  /** Optional selector to wait for after submit (results loaded); omit → a
   *  brief idle settle. When present, drives `results_visible` in the response. */
  wait_for_results_selector: z.string().optional(),
  /** Caps the `wait_for_results_selector` wait (seconds). Omit → harness
   *  default (10s). A timeout is `results_visible: false`, not an error. */
  timeout_seconds: z.number().int().min(1).max(120).optional(),
});
export type SearchRequest = z.infer<typeof SearchRequestSchema>;
/** Caller-side shape: fields with server-side defaults are optional. */
export type SearchRequestInput = z.input<typeof SearchRequestSchema>;

export const SearchResponseSchema = z.object({
  /** Whether the query was submitted (Return pressed / submit control clicked). */
  submitted: z.boolean(),
  /** Present only when `wait_for_results_selector` was given: whether that
   *  selector became visible before the wait timed out (timeout → false, not
   *  an error). */
  results_visible: z.boolean().optional(),
});
export type SearchResponse = z.infer<typeof SearchResponseSchema>;

// ───────────────────────────────────────────────────────────────────────────
// Login (heuristic credential login) — harness intent, A3 (bus W244/W245).
// POST /v1/sessions/:id/login. The password is SENSITIVE: it flows to the
// harness send-keys path but is never logged (the service records only the
// operation label on failure). Recipe-based login is the separate
// execute_recipe surface, not this intent.
// ───────────────────────────────────────────────────────────────────────────

// Named SessionLogin* (not Login*) — the auth module already owns
// LoginRequest/LoginResponse for the account-login (email+password → session
// token); this is the distinct in-browser credential-login driver op.
export const SessionLoginRequestSchema = z.object({
  username: z.string().min(1),
  /** SENSITIVE — typed via the behavioural send-keys path; never logged. */
  password: z.string().min(1),
  /** Explicit username/email field selector; omit → harness heuristic detection. */
  username_selector: z.string().optional(),
  /** Explicit password field selector; omit → heuristic. */
  password_selector: z.string().optional(),
  /** Explicit submit control; omit → Return on the password field. */
  submit_selector: z.string().optional(),
  /** Optional selector whose post-submit presence means success; omit → the
   *  password-field-gone + URL heuristic. Robust for known / multi-step logins. */
  success_selector: z.string().optional(),
  /** Caps the post-submit success wait (seconds). Omit → harness default (10s). */
  timeout_seconds: z.number().int().min(1).max(120).optional(),
});
export type SessionLoginRequest = z.infer<typeof SessionLoginRequestSchema>;

export const SessionLoginResponseSchema = z.object({
  /** Post-submit assessment: true only when login is judged successful (never a
   *  false positive — a captcha / 2FA / login-required landing yields false). */
  logged_in: z.boolean(),
  /** The URL after the submit settled (lets the caller drive challenge/pause). */
  post_login_url: z.string().optional(),
});
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
