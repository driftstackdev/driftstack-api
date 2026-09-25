import { z } from 'zod';
import { AgentModelSchema } from './agent-models.js';
import { LiveKitInfoSchema } from './livekit.js';

const AGENT_PAGE_STATE_ID_MAX_LENGTH = 256;
const AGENT_PAGE_STATE_URL_MAX_LENGTH = 8192;
const AGENT_PAGE_STATE_TEXT_MAX_LENGTH = 4096;

/**
 * An AI session, as returned by `POST /v1/agent-sessions` (201), by each
 * row of `GET /v1/agent-sessions`, and by `GET /v1/agent-sessions/{id}`.
 *
 * `model` is one of the values in {@link AgentModelSchema}, so a newly
 * offered model appears here without a change to this shape. `livekit` is
 * the live-view connection described by {@link LiveKitInfoSchema}; it is
 * filled in when the session is created if live view is available, and
 * absent otherwise.
 */
export const AgentSessionSchema = z.object({
  id: z.string(),
  account_id: z.string(),
  driftstack_session_id: z.string().nullable(),
  status: z.string(),
  closed_reason: z.string().nullable(),
  /** Which step the session is on while it is still starting, as a
   *  snake_case token — `vpn_egress_bringing_up`, `vpn_egress_active` (the
   *  VPN tunnel is up and the browser has not attached yet) or
   *  `egress_geo_resolving`. Null once the session is active or closed, and
   *  when no step was reported. Treat an absent key as null. */
  provisioning_detail: z.string().nullable().optional(),
  token_budget_total: z.number().int(),
  token_budget_remaining: z.number().int(),
  transcript_length: z.number().int(),
  closed_at: z.string().nullable(),
  created_by_user_id: z.string().nullable(),
  mode: z.enum(['manual', 'ai', 'pair']),
  model: AgentModelSchema,
  // T-26 — the per-session "stop the session if its exit IP changes" policy, set
  // at create-time. Always present (server column default false).
  stop_on_exit_ip_change: z.boolean(),
  pair_mode_state: z.object({ kind: z.string() }).passthrough().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  livekit: LiveKitInfoSchema.optional(),
  // W2679 — worker-reported per-session liveness, re-based onto the fleet
  // Heartbeat.activeSessionStates map (NOT the `status` lifecycle, which stays
  // 'active' until DELETE/sweep even when the worker crashed). `state` is the
  // latest worker state (or null = "store wired + session seen but no live
  // state"); `fresh` is whether the owning node's beat is recent enough to
  // trust. OMITTED entirely when the liveness store isn't wired (prod has no
  // fleet control plane) OR no beat has reported the session — meaning
  // "unknown → trust the binding", NEVER "dead". Optional so older clients
  // ignore it.
  liveness: z
    .object({
      state: z.enum(['active', 'provisioning', 'idle', 'terminating']).nullable(),
      fresh: z.boolean(),
    })
    .optional(),
  /** The most recent capability report for this live session. Omitted until
   * one arrives, and on closed sessions. */
  capability_report: z
    .object({
      timestamp: z.string(),
      manual_input_available: z.boolean().nullable(),
      /** ⛔ `permission_denied` is a DISTINCT state, not a flavour of `failed`:
       *  the device reports it when the machine running the phone has had its
       *  screen-capture permission revoked. The video is guaranteed black, no
       *  retry helps, and nothing the customer controls is involved — so it must
       *  reach a customer as its own sentence rather than a generic failure. */
      streaming_state: z
        .enum(['provisioning', 'live', 'blank', 'failed', 'permission_denied'])
        .nullable(),
      /** Whether the session's traffic is getting out. `dead_proxy`: the
       *  session's own proxy stopped carrying traffic while it ran.
       *  `default_connection_down`: the session has no proxy of its own and the
       *  connection Driftstack provides stopped carrying traffic — nothing for
       *  the customer to fix, and a session on one of their own proxies runs. */
      egress_state: z.enum(['live', 'dead_proxy', 'default_connection_down']).nullable(),
      proxy_kind: z.enum(['socks5', 'openvpn', 'wireguard']),
      proxy_udp_supported: z.boolean(),
      transport_mode_requested: z.enum(['h2-only', 'h2-and-h3']),
      transport_mode_active: z.enum(['h2-only', 'h2-and-h3']),
      safeguards_passed: z.boolean(),
      /** Whether this session ACTUALLY carried an HTTP/3 connection. `true`
       *  once a real QUIC handshake completed; `null` means NOT OBSERVED and
       *  must not be read as "no HTTP/3" — the two modes above describe the
       *  transport that was CONFIGURED, not what carried. */
      h3_connection_observed: z.boolean().nullable(),
      /** How many HTTP/3 connections this session has made. `null` means NOT
       *  REPORTED — nothing has been sent yet — and must never be read as
       *  zero. It is not a nicer form of the flag above: that flag latches on
       *  and never returns to false, so it says HTTP/3 was reached once and
       *  nothing about whether it still is. This count only rises, so the rate
       *  it rises at is what tells you the connection is live. The key may be
       *  absent as well as null. */
      h3_connection_count: z.number().int().nonnegative().nullable().optional(),
      /** The address this session's traffic currently leaves through, and the
       *  addresses its WebRTC candidates expose. Each is `null` until it has
       *  been observed — that means NOT YET KNOWN, never "no exit". */
      exit_ip: z.string().nullable(),
      exit_country: z.string().nullable(),
      exit_timezone: z.string().nullable(),
      webrtc_candidate_ips: z.array(z.string()).nullable(),
      observed_at: z.string().nullable(),
      /** The last OS reading Driftstack took of this session's exit proxy, and how
       *  it was taken — the same reading the proxy's `os_fingerprint` carries, with
       *  `at` for when it was taken (a stored reading of any age, not a live one).
       *  `observed_via` and the two path flags say whether an OS that differs from
       *  the phone's describes the path a website sees: read a missing or false
       *  flag as "this reading does not describe that path". `direct_reading` and
       *  `website_like_reading` are the customer names of `single_host_vantage` and
       *  `web_port_vantage`; they always agree. `null` means not measured, never
       *  "no OS". Optional: an older server sends neither the key nor the method
       *  fields. */
      os_fingerprint: z
        .object({
          os: z.string(),
          confidence: z.string(),
          at: z.string(),
          observed_via: z.enum(['proxy_host', 'exit_ip']).optional(),
          single_host_vantage: z.boolean().optional(),
          web_port_vantage: z.boolean().optional(),
          direct_reading: z.boolean().optional(),
          website_like_reading: z.boolean().optional(),
        })
        .nullable()
        .optional(),
    })
    .optional(),
  /** The largest file, in bytes, that one upload to this session can carry right
   *  now. Each device takes a file up to its own size, so this can be smaller
   *  than the 64 MiB per-file maximum, and it can change while the session runs.
   *  Only on `GET /v1/agent-sessions/{id}`, and only while the session is
   *  running on a connected device; absent means not known. */
  upload_max_file_bytes: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe(
      'The largest file, in bytes, one upload to this session can carry right now. Absent when not known.',
    ),
  /** The most recent start-up or runtime failure for this session. */
  error_event: z
    .object({
      timestamp: z.string().min(1).max(64),
      code: z.string().regex(/^[a-z][a-z0-9_]{0,127}$/),
      severity: z.enum(['info', 'warn', 'error', 'fatal']),
      summary: z.string().max(4096),
      detail: z
        .string()
        .max(16 * 1024)
        .nullable()
        .describe('Null when the server has nothing to add beyond `summary`.'),
      customer_actionable: z
        .boolean()
        .describe('Whether a human can do anything about this failure.'),
      retryable: z.boolean().describe('Whether repeating the same call is worth trying.'),
    })
    .nullable()
    .optional()
    .describe(
      'The most recent failure recorded for this session, at launch or while running. Null when none has been reported.',
    ),
});

export type AgentSession = z.infer<typeof AgentSessionSchema>;

/**
 * What the page in an AI session is doing right now — the body of
 * `GET /v1/agent-sessions/{id}/page-state`.
 *
 * This is a different thing from a driver session's `state.page_state`
 * ({@link import('./sessions.js').PageStateSchema}), which has three states.
 * This one has a fourth, `stalled`: the page is still alive but has stopped
 * rendering.
 *
 * `title` is always present and may be null, because a title can change on
 * its own in any state. `tabId` identifies which tab the state belongs to
 * and is null until it is reported, so read it as optional. `error`
 * describes the last failure, if any.
 */
export const AgentPageStateSchema = z.object({
  state: z.enum(['loading', 'loaded', 'errored', 'stalled']),
  url: z.string().max(AGENT_PAGE_STATE_URL_MAX_LENGTH).nullable(),
  title: z.string().max(AGENT_PAGE_STATE_TEXT_MAX_LENGTH).nullable(),
  tabId: z.string().min(1).max(AGENT_PAGE_STATE_ID_MAX_LENGTH).nullable().optional(),
  // T-25 — the box's editable-input focus state (true on focus, false on blur).
  // The store always normalizes an absent wire field to null, so the response key
  // is present; nullable when nothing has been reported. Drives the GUI on-screen
  // keyboard from the polled page-state path with the data-channel handler's
  // authority rules.
  input_focused: z.boolean().nullable(),
  error: z
    .object({
      kind: z.string().min(1).max(AGENT_PAGE_STATE_ID_MAX_LENGTH),
      message: z.string().max(AGENT_PAGE_STATE_TEXT_MAX_LENGTH),
    })
    .nullable(),
});
export type AgentPageState = z.infer<typeof AgentPageStateSchema>;

/**
 * The `GET /v1/agent-sessions/{id}/page-state` response. `page_state` is
 * null until the session has reported one; that is not an error, only a
 * session that has nothing to report yet.
 */
export const AgentPageStateResponseSchema = z.object({
  page_state: AgentPageStateSchema.nullable(),
});
export type AgentPageStateResponse = z.infer<typeof AgentPageStateResponseSchema>;

/**
 * The body of `POST /v1/agent-sessions/:id/resume` — resume a session that
 * was paused automatically when a bot challenge appeared, once you have
 * solved it.
 *
 * Send `challenge_id` with the id from the `session.challenge_detected`
 * event you are answering: it is checked against the challenge that is
 * actually active, and an out-of-date id leaves the session paused. Omit it
 * to resume regardless.
 */
export const ResumeSessionRequestSchema = z
  .object({
    challenge_id: z.string().min(1).optional(),
  })
  .strict();
export type ResumeSessionRequest = z.infer<typeof ResumeSessionRequestSchema>;

/**
 * The `POST /v1/agent-sessions/:id/resume` response. Resuming is a request,
 * not a result: the route answers 202 Accepted to say the request was
 * taken, so read the session afterwards to see whether it is running again.
 */
export const ResumeSessionResponseSchema = z
  .object({
    status: z.literal('resume_requested'),
    session_id: z.string(),
  })
  .strict();
export type ResumeSessionResponse = z.infer<typeof ResumeSessionResponseSchema>;

/**
 * B2 — POST /v1/agent-sessions/:id/stop body. Empty: the route stops whatever
 * turn is running for the session, and there is only ever one. Strict, so a
 * field a client expects to mean something is refused rather than ignored.
 */
export const StopAgentTurnRequestSchema = z.strictObject({});
export type StopAgentTurnRequest = z.infer<typeof StopAgentTurnRequestSchema>;

/**
 * B2 — POST /v1/agent-sessions/:id/stop response. The route REQUESTS the stop and
 * returns at once; it does not wait for the turn to wind down.
 *
 *   · `stop_requested` (202) — a turn was running and has been asked to stop. It
 *     ends on its own response: the message request that started it returns a
 *     `kind: 'stopped'` result (or, if it was already finishing, its ordinary
 *     result), and the session then accepts the next message.
 *   · `no_turn_running` (200) — nothing was running, so there was nothing to
 *     stop. Stopping is idempotent: asking again is always safe.
 */
export const StopAgentTurnResponseSchema = z
  .object({
    status: z.enum(['stop_requested', 'no_turn_running']),
    session_id: z.string(),
  })
  .strict();
export type StopAgentTurnResponse = z.infer<typeof StopAgentTurnResponseSchema>;

/**
 * The one-line title a customer reads when a session stops with an error — the
 * `session.errored` notification's `errorClass`, as the desktop app's
 * notification centre and the dashboard's banner both show it.
 *
 * ⛔ WHY IT LIVES HERE. Both surfaces used to print the code itself
 * (`A session stopped: ${errorClass}`), so a customer read tokens such as
 * `default_egress_unavailable` or `proxy_connection_failed` that name how the
 * product is built. They are two apps in two frameworks — the desktop app is
 * React, the dashboard banner is an inline script in an Astro layout that cannot
 * import a module — and both already depend on this package. The dashboard
 * hands this table to its inline script through `define:vars` (serialised at
 * build time), the desktop app imports it, and one table means the two cannot
 * say different things about the same stop.
 *
 * Keys are the codes a stopped session reports: the device's error codes (and
 * the server's corrections of them, such as `default_egress_unavailable`), and
 * the `/v1/sessions` failure names (`DriverError`, …). An unknown code — one
 * added later, or anything malformed — reads as {@link SESSION_STOPPED_FALLBACK_TITLE},
 * never as the raw token. Look codes up as OWN keys only
 * ({@link sessionStoppedTitle}); `titles[code]` would answer `constructor`
 * with a function.
 *
 * Titles say WHAT happened, in the customer's words.
 */
export const SESSION_STOPPED_FALLBACK_TITLE = 'A session stopped';

export const SESSION_STOPPED_TITLES: Readonly<Record<string, string>> = {
  // ── The connection the session's traffic runs through ────────────────────
  /** A session with no proxy of its own: the connection Driftstack provides failed. */
  default_egress_unavailable: "A session stopped: Driftstack's connection failed",
  /** The customer's proxy refused the username or password saved for it. */
  proxy_auth_failed: 'A session stopped: your proxy refused its sign-in',
  proxy_connection_failed: 'A session stopped: it could not connect through its proxy',
  egress_verification_unavailable: 'A session stopped: we could not confirm its proxy was in use',
  egress_unreachable: "A session stopped: its proxy's location could not be confirmed",
  egress_invariant_violation: 'A session stopped to keep its traffic on its proxy',
  proxy_udp_unsupported: 'A session stopped: its proxy cannot carry HTTP/3',
  egress_bind_failed: 'A session stopped: its VPN could not be started',
  /** Ours: the local half of the connection stopped or did not start. */
  egress_lost: 'A session stopped: its connection dropped on our side',
  proxy_boot_failed: 'A session stopped: its connection could not start on our side',
  network_shim_boot_failed: 'A session stopped: its connection could not start on our side',
  /** Refused: started with no proxy where sessions run only through the customer's. */
  proxy_required: 'A session could not start: it needs a proxy of your own',
  exit_ip_changed: 'A session stopped: its exit IP changed',
  // ── The browser and the session itself ─────────────────────────────────────
  launch_timeout: 'A session stopped: it did not start in time',
  render_failed: 'A session stopped: the browser did not start',
  webkit_spawn_failed: 'A session stopped: the browser did not start',
  webdriver_connect_failed: 'A session stopped: the browser did not start',
  browser_crashed: 'A session stopped: the browser stopped unexpectedly',
  session_resource_overuse: 'A session stopped: a page used too much memory',
  provisioning_interrupted: 'A session stopped before it finished starting',
  archetype_lookup_failed: 'A session stopped: its device is not available',
  session_config_invalid: 'A session stopped: its configuration could not be used',
  session_refused_at_capacity: 'A session could not start: no device was free',
  unknown_error: 'A session stopped unexpectedly',
  // ── `/v1/sessions` failures ────────────────────────────────────────────────
  SessionTimeoutError: 'A session stopped: an operation took too long',
  DriverError: 'A session stopped: a browser operation failed',
  DriverNotIntegratedError: 'A session stopped: the browser was not available',
};

/** The title for a stopped session's code — own-key lookup, exact token after
 *  trimming, and {@link SESSION_STOPPED_FALLBACK_TITLE} for anything else. */
export function sessionStoppedTitle(code: string | null | undefined): string {
  const token = typeof code === 'string' ? code.trim() : '';
  if (token !== '' && Object.prototype.hasOwnProperty.call(SESSION_STOPPED_TITLES, token)) {
    const title = SESSION_STOPPED_TITLES[token];
    if (typeof title === 'string') return title;
  }
  return SESSION_STOPPED_FALLBACK_TITLE;
}
