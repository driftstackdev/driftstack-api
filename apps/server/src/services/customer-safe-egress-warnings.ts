// The allowlist that governs `egress_capabilities.warnings` on every PUBLIC
// surface that carries it.
//
// ⛔ WHAT THIS FILE EXISTS TO CLOSE. `deriveWarnings` in
// `session-capability-report-relay.ts` builds the warning list from a device
// frame and it is stored, verbatim, as `sessions.egress_capabilities`. That
// stored list was echoed straight out on `GET /v1/sessions/:id`, `GET
// /v1/sessions`, `POST /v1/sessions`, `POST /v1/profiles/:id/launch` and the
// `session.egress_capability_changed` webhook. Two things rode that path:
//
//   1. `safeguard_failed:<layer>` and `safeguard_missing:<layer>`, where
//      `<layer>` is a DEVICE-SUPPLIED OPEN STRING — `z.string().min(1).max(64)`
//      on `safeguardChecks[].layer`, with nothing bounding what it can say.
//      A device could name any internal mechanism it liked, in 64 characters,
//      straight onto a customer response, and the only thing standing between
//      the two was the device team's choice of identifier.
//   2. Codes that describe HOW the product is built rather than WHAT the
//      customer can see — `h3_interpose_unavailable` names a dyld interpose
//      library; `safeguards_expectation_unreported` names our producer/consumer
//      protocol for declaring an expected layer set. Neither was documented,
//      and neither tells a customer anything they can act on.
//
// ⭐ THE DIRECTION IS THE WHOLE POINT, and it is the same direction as
// `customer-safe-egress-capability-report.ts` next door: an unrecognised code
// is PRIVATE. The public vocabulary is a CLOSED set declared in this file. An
// internal code nobody has classified is DROPPED from the customer list and
// reported, so it is noticed by us rather than published to them.
//
// ⛔ STORAGE IS UNCHANGED AND PERSISTED ROWS ARE NOT MIGRATED. The internal
// vocabulary is what `deriveWarnings` writes, what the database holds, and what
// the staff-only `GET /v1/admin/sessions` returns — operators keep the full
// list, including the layer name, because "the screen-recording check failed"
// and "a safeguard failed" send an operator to different places. The mapping
// happens ON THE WAY OUT, which is also why old rows are covered for free: a
// row written a year ago maps the same as one written this second.
//
// ⚠️ THIS IS A MAP, NOT A FILTER — the difference from the file next door.
// `customerSafeEgressCapabilityReport` only ever removes keys; this function
// also RENAMES (`h3_interpose_unavailable` → `quic_unavailable`) and MERGES
// (three distinct "we could not verify the safeguards" codes → one
// `safeguards_unverified`). Merging is deliberate: the three internal codes
// name three different places OUR reporting fell short, and a customer can do
// exactly one thing about all three.

/** A logger shaped like `request.log` / `app.log`, narrowed to what this file
 *  uses so neither pino nor Fastify types leak into the signature. */
export interface EgressWarningLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

// ───────────────────────────────────────────────────────────────────────────
// The closed layer map
// ───────────────────────────────────────────────────────────────────────────

/**
 * Internal safeguard layer → the customer's word for WHAT it protects.
 *
 * ⛔ CLOSED, AND CLOSED IS THE SAFETY PROPERTY. The keys are the layers the
 * producer actually emits — `HarnessCoordinator.expectedSafeguardLayers` in the
 * device repo declares exactly these four, and a test over there asserts the
 * declaration equals what the report builder emits. A layer that is not a key
 * here yields the BARE `safeguard_failed` code: the customer still learns a
 * safeguard failed, and the unrecognised name never reaches them.
 *
 * ⛔ THE VALUES SAY WHAT, NEVER HOW. `network_firewall` is a packet filter we
 * deploy; what the CUSTOMER bought is that nothing leaves outside their proxy,
 * which is the field they already set as `egress_safeguard.block_direct_internet`
 * — so that is the word. `webkit_gate` is a compile-time gate in a browser fork;
 * what the customer gets is a browser build we verified. `per_spawn_verification`
 * is an egress probe comparing two addresses; what the customer gets is proof
 * their traffic really left through their proxy. `screen_recording` is a macOS
 * TCC grant; what the customer gets is the live view of their session.
 *
 * ⚠️ ADDING A KEY IS A CUSTOMER-COPY DECISION, not a rename. The value becomes
 * a published string the moment it ships, and the vocabulary parity guard
 * (`tests/unit/a-public-egress-warning-cannot-ship-undocumented.test.ts`) will
 * fail until it is documented in all three places customers read.
 */
export const PUBLIC_SAFEGUARD_LAYERS: Readonly<Record<string, string>> = {
  /** Nothing leaves the session outside the proxy you configured. */
  network_firewall: 'direct_internet_block',
  /** The session ran the browser build we verify, not an arbitrary one. */
  webkit_gate: 'browser_integrity',
  /** The session's traffic was confirmed to leave through your proxy. */
  per_spawn_verification: 'proxy_egress_verification',
  /** The live view of the session could be captured. */
  screen_recording: 'live_view_capture',
};

/** The customer-facing layer words, as a set. Derived from the map above —
 *  never a second hand-maintained list. */
const PUBLIC_LAYER_WORDS: ReadonlySet<string> = new Set(Object.values(PUBLIC_SAFEGUARD_LAYERS));

// ───────────────────────────────────────────────────────────────────────────
// The closed public vocabulary
// ───────────────────────────────────────────────────────────────────────────

const SAFEGUARD_FAILED = 'safeguard_failed';
const SAFEGUARD_FAILED_PREFIX = `${SAFEGUARD_FAILED}:`;
const SAFEGUARD_MISSING_PREFIX = 'safeguard_missing:';
const SAFEGUARDS_UNVERIFIED = 'safeguards_unverified';

/**
 * Internal code → public code, for the codes that carry no parameter.
 *
 * `undefined` for a code means "not in this table"; the parameterised
 * `safeguard_*` forms are handled by `publicWarningFor` below.
 *
 * ⛔ RETIRED, 2026-09-21: `quic_disabled_fallback_http2` and
 * `dns_remote_resolve_unsupported_by_proxy` used to be listed here as
 * pass-through codes. Neither is emitted by anything device-side (confirmed
 * against the fork) and production holds zero stored rows carrying either —
 * they were documented promises nothing kept. Removed from the vocabulary,
 * the docs, and the fixtures that exercised them, rather than kept as dead
 * weight a customer could still be told to expect. If a real fallback path
 * for either is built later, it gets a new code documented against real
 * behaviour, not this one un-retired.
 */
const UNPARAMETERISED: Readonly<Record<string, string>> = {
  // ── Pass through unchanged: already WHAT, already documented ───────────
  udp_unsupported_by_proxy: 'udp_unsupported_by_proxy',
  dead_proxy: 'dead_proxy',
  /** `dead_proxy` on a session with no proxy of its own: the connection
   *  Driftstack provides stopped carrying traffic. Derived by the capability
   *  relay, which holds the agent session's proxyId; ours, not the customer's. */
  default_connection_down: 'default_connection_down',
  streaming_blank: 'streaming_blank',
  streaming_failed: 'streaming_failed',

  // ── Renamed: the internal name says HOW ────────────────────────────────
  /** "interpose" is a dyld mechanism of ours. What the customer sees is that
   *  QUIC did not carry for this session. */
  h3_interpose_unavailable: 'quic_unavailable',
  /** `udp_unsupported_by_proxy` on a session with no proxy of its own (the
   *  capability relay decides it, holding the agent session's proxyId): the
   *  connection Driftstack provides carried no UDP. There is no proxy of the
   *  customer's to have refused it; what they can see is that QUIC was not used. */
  udp_unsupported_by_default_connection: 'quic_unavailable',

  // ── Merged: three internal gaps, one customer fact ─────────────────────
  /** The device reported no safeguard checks at all. */
  safeguards_unreported: SAFEGUARDS_UNVERIFIED,
  /** The device did not declare which layers a healthy session reports, so
   *  completeness could not be checked. Names our producer/consumer protocol;
   *  the customer's half of the fact is identical to the two beside it. */
  safeguards_expectation_unreported: SAFEGUARDS_UNVERIFIED,

  // ── Generalised: the published layer word would blame a proxy ──────────
  /** `safeguard_failed:per_spawn_verification` on a session with no proxy of its
   *  own: the check that its traffic left through the connection Driftstack
   *  provides did not pass. The layer's published word
   *  (`proxy_egress_verification`) says "your proxy", which this session does
   *  not have, so the customer learns that a safeguard failed and contacts
   *  support — the same action either way. */
  default_connection_verification_failed: SAFEGUARD_FAILED,

  // ── Already-public codes, accepted so the map is IDEMPOTENT ────────────
  //
  // ⚠️ Nothing internal emits these; they are here so that applying the map
  // twice cannot silently empty a customer's warning list. Every string in
  // this block is one we already publish, so accepting it can disclose
  // nothing that was not already disclosed. `safeguard_failed:<word>` is
  // handled in `publicWarningFor`, which accepts the published layer words
  // for the same reason.
  quic_unavailable: 'quic_unavailable',
  safeguards_unverified: SAFEGUARDS_UNVERIFIED,
  [SAFEGUARD_FAILED]: SAFEGUARD_FAILED,
};

/**
 * ⛔ THE COMPLETE SET OF STRINGS A CUSTOMER CAN EVER SEE in
 * `egress_capabilities.warnings`, sorted so a failure message is stable to
 * read. Derived from the two tables above — never a third hand-maintained
 * list, because a third list is how a code ships undocumented.
 *
 * This is the set the documentation parity guard reads. Every member must be
 * documented in `packages/api-types/src/egress.ts`, in the OpenAPI description
 * generated from it, and on the customer docs page — and the guard fails until
 * it is.
 */
export const PUBLIC_EGRESS_WARNINGS: readonly string[] = [
  ...new Set([
    ...Object.values(UNPARAMETERISED),
    SAFEGUARD_FAILED,
    ...Object.values(PUBLIC_SAFEGUARD_LAYERS).map((word) => `${SAFEGUARD_FAILED_PREFIX}${word}`),
  ]),
].sort();

const PUBLIC_EGRESS_WARNING_SET: ReadonlySet<string> = new Set(PUBLIC_EGRESS_WARNINGS);

/** Whether a string is a member of the closed public vocabulary. Exported for
 *  the guards, which must be able to assert the containment invariant over an
 *  arbitrary input rather than over a list this file also produced. */
export function isPublicEgressWarning(code: string): boolean {
  return PUBLIC_EGRESS_WARNING_SET.has(code);
}

// ───────────────────────────────────────────────────────────────────────────
// Reporting an unmapped internal code, safely
// ───────────────────────────────────────────────────────────────────────────

/**
 * The shape every real code and layer has: lowercase, digits, underscore, at
 * most 64 characters (the device schema's own cap on `layer`).
 *
 * Exported so a second call site that needs to report a device-supplied
 * token safely (`session-capability-report-relay.ts`'s early notice of an
 * unworded `safeguardLayersExpected` / `safeguardChecks[].layer` name) reuses
 * the SAME shape check rather than restating it — a restated regex is a
 * second thing that can quietly stop agreeing with this one.
 */
export const SAFE_TOKEN_RE = /^[a-z0-9_]{1,64}$/;
/** What an operator sees instead of a token that is not of that shape. */
const UNPRINTABLE = 'unprintable';

export function safeToken(value: string): string {
  return SAFE_TOKEN_RE.test(value) ? value : UNPRINTABLE;
}

/**
 * ⛔ THE HOSTILE STRING NEVER LEAVES THIS FILE — not to the customer AND NOT
 * TO OUR OWN LOGS. `layer` is 64 free characters straight off a device, so a
 * report naming the offending code would put device-controlled text into a log
 * line, a Sentry title, or a metric label, which is the same disclosure problem
 * one hop to the side. A token of the shape every real code has is echoed
 * verbatim, because an operator needs to read the NEW layer's actual name to
 * classify it; anything else collapses to `unprintable`.
 *
 * ⚠️ THE SPLIT IS ONLY MADE FOR THE TWO KNOWN PREFIXES. Splitting on any colon
 * would echo the tail of a string that is not a parameterised code at all:
 * `relay-07.some.host:1080` would report as `unprintable:1080`, which keeps
 * exactly the half worth not keeping. For anything else the whole string is one
 * token, so it is echoed only if the WHOLE of it is of the safe shape.
 */
export function reportableEgressWarning(code: string): string {
  for (const prefix of [SAFEGUARD_FAILED_PREFIX, SAFEGUARD_MISSING_PREFIX]) {
    if (code.startsWith(prefix)) {
      return `${prefix}${safeToken(code.slice(prefix.length))}`;
    }
  }
  return safeToken(code);
}

/** Distinct codes a recorder remembers per process, so a malformed or hostile
 *  stored row cannot grow the set without bound. Past it, occurrences are still
 *  counted — under `UNMAPPED_OVERFLOW_KEY` — and simply not logged again. */
const MAX_TRACKED_CODES = 64;

/**
 * ⛔ WHERE OCCURRENCES GO ONCE THE MAP IS FULL, and why the map has to fill at
 * all. `reportableEgressWarning` echoes any `^[a-z0-9_]{1,64}$` token VERBATIM
 * — deliberately, so an operator can read a genuinely new layer's real name and
 * classify it — and that shape bounds each key's LENGTH, not the NUMBER of
 * distinct keys. The tokens come off `safeguardChecks[].layer`, 64 free
 * characters from a device, and this recorder is a MODULE-LEVEL singleton fed
 * on every public read (`GET /v1/sessions` walks a whole page of rows through
 * it). An unmapped map is therefore memory a device allocates on our side, one
 * permanent entry per layer name it invents, never pruned.
 *
 * ⚠️ THE COUNT IS THE HALF THAT MUST NOT GO MISSING. Dropping the overflow
 * would make a flood of unclassified codes — precisely the case worth
 * noticing — read quieter than a single one. Folding it into one bucket keeps
 * the total readable and stops the cardinality.
 */
export const UNMAPPED_OVERFLOW_KEY = 'unmapped_overflow';

export interface UnmappedEgressWarningRecorder {
  /**
   * Count every occurrence; log each distinct code at most once per process.
   * Never throws — a response must go out whether or not the report could be
   * made. `codes` are already reportable (this module produces them).
   */
  record(codes: readonly string[], logger?: EgressWarningLogger): void;
  /** Occurrences seen this process, by reportable code. The "counted" half:
   *  it survives the once-per-process log suppression. */
  counts(): ReadonlyMap<string, number>;
}

/**
 * A recorder with its own memory. Tests build their own rather than reaching
 * into process state, which is why this is a factory and not a module-level
 * `Map` with a reset hook.
 */
export function createUnmappedEgressWarningRecorder(): UnmappedEgressWarningRecorder {
  const counts = new Map<string, number>();
  const logged = new Set<string>();
  return {
    record(codes, logger) {
      for (const rawCode of codes) {
        // A code already tracked keeps counting under its own name: the cap
        // closes the map to NEW keys, it does not stop counting the ones an
        // operator is already looking at.
        const known = counts.has(rawCode);
        const code = known || counts.size < MAX_TRACKED_CODES ? rawCode : UNMAPPED_OVERFLOW_KEY;
        counts.set(code, (counts.get(code) ?? 0) + 1);
        if (logger === undefined) continue;
        if (logged.has(code) || logged.size >= MAX_TRACKED_CODES) continue;
        logged.add(code);
        try {
          logger.warn(
            {
              component: 'customer-safe-egress-warnings',
              code,
              occurrences: counts.get(code) ?? 1,
            },
            'dropped an internal egress warning with no public mapping; classify it in customer-safe-egress-warnings.ts or it stays invisible to customers',
          );
        } catch {
          // Fire-and-forget, like every report on a response path.
        }
      }
    },
    counts() {
      return counts;
    },
  };
}

/** The process-wide recorder every public surface reports through. */
export const unmappedEgressWarnings: UnmappedEgressWarningRecorder =
  createUnmappedEgressWarningRecorder();

// ───────────────────────────────────────────────────────────────────────────
// The mapping
// ───────────────────────────────────────────────────────────────────────────

/** `null` — this internal code has no public meaning and is dropped. */
interface MappedWarning {
  /** The public code. */
  readonly code: string;
  /** False when the code produced a public code only by GENERALISING away
   *  something we did not recognise (an unclassified safeguard layer), so the
   *  caller can still report it. */
  readonly recognised: boolean;
}

function publicWarningFor(internal: string): MappedWarning | null {
  const direct = Object.prototype.hasOwnProperty.call(UNPARAMETERISED, internal)
    ? UNPARAMETERISED[internal]
    : undefined;
  if (direct !== undefined) return { code: direct, recognised: true };

  // A missing layer is the same customer fact whichever layer it is, so the
  // layer name is discarded rather than mapped. Nothing to report: the code
  // itself IS classified.
  if (internal.startsWith(SAFEGUARD_MISSING_PREFIX)) {
    return { code: SAFEGUARDS_UNVERIFIED, recognised: true };
  }

  if (internal.startsWith(SAFEGUARD_FAILED_PREFIX)) {
    const layer = internal.slice(SAFEGUARD_FAILED_PREFIX.length);
    const word = Object.prototype.hasOwnProperty.call(PUBLIC_SAFEGUARD_LAYERS, layer)
      ? PUBLIC_SAFEGUARD_LAYERS[layer]
      : undefined;
    if (word !== undefined) return { code: `${SAFEGUARD_FAILED_PREFIX}${word}`, recognised: true };
    // Idempotence: a layer word we already publish maps to itself.
    if (PUBLIC_LAYER_WORDS.has(layer)) {
      return { code: `${SAFEGUARD_FAILED_PREFIX}${layer}`, recognised: true };
    }
    // ⛔ NEVER THE RAW STRING. The customer learns a safeguard failed; the
    // unclassified layer is reported to us instead of to them.
    return { code: SAFEGUARD_FAILED, recognised: false };
  }

  return null;
}

/** Bound on the reported list, so a malformed stored row cannot make one
 *  response allocate without limit. The public list needs no bound: it is
 *  de-duplicated against a closed vocabulary of 13 members. */
const MAX_REPORTED_CODES = 32;

export interface CustomerSafeEgressWarnings {
  /** The customer-visible list: members of `PUBLIC_EGRESS_WARNINGS` only,
   *  de-duplicated, in first-appearance order. */
  readonly warnings: string[];
  /**
   * Internal codes this function did not fully recognise, already reduced to a
   * reportable form (see `reportableEgressWarning`) — a code with no public
   * meaning at all, or a `safeguard_failed:` whose layer is not in the closed
   * map. De-duplicated and bounded. Hand these to a recorder; never to a
   * customer.
   */
  readonly unmapped: string[];
}

/**
 * The customer-visible view of a stored internal warning list.
 *
 * ⛔ TOTAL OVER ITS INPUT, on purpose, and the input is `unknown` for a reason:
 * this reads a `jsonb` column that has held whatever was written to it since
 * migration 0045, plus a live payload built from a device frame. A `null`, a
 * string, an object, an array with numbers in it and an array 10,000 long are
 * all things it must answer rather than throw on, because the alternative to an
 * answer here is a 500 on `GET /v1/sessions/:id`.
 *
 * ⛔ CLOSED OVER ITS OUTPUT. Every member of `warnings` is a member of
 * `PUBLIC_EGRESS_WARNINGS`. That is the property the tests assert over
 * arbitrary strings, and it is what makes the documented vocabulary a promise
 * rather than a description.
 *
 * Order is first-appearance and stable; duplicates collapse (three failed
 * safeguards on unclassified layers are one `safeguard_failed`, not three).
 */
export function customerSafeEgressWarnings(stored: unknown): CustomerSafeEgressWarnings {
  const warnings: string[] = [];
  const unmapped: string[] = [];
  if (!Array.isArray(stored)) return { warnings, unmapped };
  const seen = new Set<string>();
  const reported = new Set<string>();
  for (const entry of stored) {
    // A non-string member is a shape violation rather than a new code — there
    // is no token to classify and nothing safe to report — so it is dropped
    // silently. The array's declared type is string[] everywhere that writes it.
    if (typeof entry !== 'string') continue;
    const mapped = publicWarningFor(entry);
    if (mapped === null || !mapped.recognised) {
      const code = reportableEgressWarning(entry);
      if (!reported.has(code) && reported.size < MAX_REPORTED_CODES) {
        reported.add(code);
        unmapped.push(code);
      }
    }
    if (mapped === null) continue;
    if (seen.has(mapped.code)) continue;
    seen.add(mapped.code);
    warnings.push(mapped.code);
  }
  return { warnings, unmapped };
}

// ───────────────────────────────────────────────────────────────────────────
// The whole derived object, for the surfaces that carry one
// ───────────────────────────────────────────────────────────────────────────

export interface CustomerSafeEgressCapabilities {
  /** `null` in, `null` out — no report has arrived yet, which is not the same
   *  as a report with no warnings in it. */
  readonly capabilities: Record<string, unknown> | null;
  /** As `CustomerSafeEgressWarnings.unmapped`. */
  readonly unmapped: string[];
}

/**
 * The customer-visible view of a stored `egress_capabilities` object: every
 * other field is carried through exactly as it is today, and only `warnings`
 * is mapped.
 *
 * ⛔ ONE IMPLEMENTATION, AND IT IS THIS ONE. Every public surface that carries
 * `egress_capabilities` calls this — the four session responses through
 * `publicSession()` in `routes/sessions.ts`, and the
 * `session.egress_capability_changed` webhook through
 * `SessionsService.ingestEgressCapabilityReport`. A second copy is how two
 * vocabularies start drifting, and the drift is invisible because both copies
 * keep returning a list of strings.
 *
 * A non-object (a blob written by an older path, or an array) yields `null`
 * rather than being spread: a spread of an array produces index keys, which is
 * a confident answer from a shape nobody checked.
 */
export function customerSafeEgressCapabilities(stored: unknown): CustomerSafeEgressCapabilities {
  if (stored === null || stored === undefined) return { capabilities: null, unmapped: [] };
  if (typeof stored !== 'object' || Array.isArray(stored)) {
    return { capabilities: null, unmapped: [] };
  }
  const source = stored as Record<string, unknown>;
  const { warnings, unmapped } = customerSafeEgressWarnings(source['warnings']);
  return { capabilities: { ...source, warnings }, unmapped };
}

// ───────────────────────────────────────────────────────────────────────────
// The stored webhook payload, on its way out of the worker
// ───────────────────────────────────────────────────────────────────────────

/** The one event type whose payload carries `egress_capabilities`. */
export const EGRESS_CAPABILITY_EVENT_TYPE = 'session.egress_capability_changed';

export interface CustomerSafeWebhookPayload {
  /** The payload to send. The SAME REFERENCE as the input whenever nothing
   *  needed mapping, so an unrelated event is byte-identical on the wire. */
  readonly payload: unknown;
  /** As `CustomerSafeEgressWarnings.unmapped`. */
  readonly unmapped: string[];
}

/**
 * ⛔ A WEBHOOK PAYLOAD IS A STORED ROW, SO "MAP ON THE WAY OUT" HAS TO MEAN THE
 * WAY OUT OF THE WORKER — not the way out of the enqueue call.
 *
 * `sessions.egress_capabilities` is mapped on every read, which is what makes
 * "old rows are covered for free" true there. `webhook_deliveries.payload` is
 * not read that way: it is a SERIALIZED COPY written at enqueue time, and
 * `WebhookDeliveryWorker.deliverInner` sends it with `JSON.stringify(
 * delivery.payload)`. So every `session.egress_capability_changed` row enqueued
 * before the mapping landed still holds the INTERNAL list — device-supplied
 * `safeguard_failed:<layer>` included — and three paths re-send it: the
 * customer's own `POST /v1/webhook-deliveries/:id/replay`, an operator's
 * `POST /v1/admin/webhook-deliveries/:id/replay` (which posts to the CUSTOMER's
 * endpoint), and the ordinary retry of a row that was pending when the mapping
 * deployed. Mapping at the enqueue call site cannot reach any of them.
 *
 * ⭐ IT IS ALSO THE SECOND LINE FOR THE FIRST. The mapping today lives in
 * `SessionsService.ingestEgressCapabilityReport`; a future caller that enqueues
 * this event without it would publish the internal list with nothing in between.
 * This runs on the last hop, where every such path has to pass.
 *
 * ⛔ TOTAL, AND UNCHANGED BY DEFAULT. A payload this function does not
 * recognise — a different event type, a missing or malformed `data`, no
 * `egress_capabilities` key — comes back as THE SAME REFERENCE, so the only
 * bytes that can change are the ones in `warnings`. A projection that threw
 * here would strand a delivery in flight; one that rebuilt the envelope would
 * reshape an event customers already parse.
 */
export function customerSafeWebhookPayload(
  eventType: string,
  payload: unknown,
): CustomerSafeWebhookPayload {
  if (eventType !== EGRESS_CAPABILITY_EVENT_TYPE) return { payload, unmapped: [] };
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return { payload, unmapped: [] };
  }
  const envelope = payload as Record<string, unknown>;
  const data = envelope['data'];
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return { payload, unmapped: [] };
  }
  const dataRecord = data as Record<string, unknown>;
  // Absent means the event carries no capability object at all. Materialising
  // `egress_capabilities: null` here would turn "this payload never had the
  // field" into "the field is null", which is a different claim.
  if (!Object.prototype.hasOwnProperty.call(dataRecord, 'egress_capabilities')) {
    return { payload, unmapped: [] };
  }
  const { capabilities, unmapped } = customerSafeEgressCapabilities(
    dataRecord['egress_capabilities'],
  );
  return {
    payload: { ...envelope, data: { ...dataRecord, egress_capabilities: capabilities } },
    unmapped,
  };
}
