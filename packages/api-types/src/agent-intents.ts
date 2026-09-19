import { z } from 'zod';

/**
 * A single structured intent the agent decomposer emits — the closed
 * verb vocabulary (navigate / interact / wait / capture / scroll /
 * behavioral_pause). navigate/interact/wait/capture map onto the
 * `/v1/sessions/:id/{navigate,interact,wait,capture}` driver routes;
 * scroll + behavioral_pause (Agent-3 API-gap, W140) map server-side onto
 * the harness control-plane scroll / behavioral_pause intents. The agent
 * cannot invent new verbs. Mirrors the route's `AgentIntent` union
 * (apps/server/src/services/agent-decomposer.ts); a drift guard pins the
 * member `kind`s in lockstep.
 *
 * Surfaced on the typed `intents` array of the `POST /v1/agent-sessions/
 * {id}/message` plan-executed turn result (was `z.object({})`).
 */
export const AgentIntentSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('navigate'), url: z.string() }),
  z.object({
    kind: z.literal('interact'),
    // W540 — 'press' (A3-W677): value carries the key name (e.g. "Enter").
    action: z.enum(['tap', 'type', 'scroll', 'swipe', 'press']),
    selector: z.string().optional(),
    value: z.string().optional(),
    /** W1150 (A3 W1149) — type-action only: sensitive value (card/OTP/PIN);
     *  harness suppresses visible typo-corrections. Rides the dispatch wire
     *  as the send_keys `sensitive` param. */
    sensitive: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal('wait'),
    condition: z.enum(['idle', 'selector_visible']),
    selector: z.string().optional(),
    /** Optional wait budget in milliseconds. Negative time is not meaningful and
     * live decomposers/executors already omit or clamp it, so reject it at the
     * canonical public boundary too. */
    timeoutMs: z.number().int().nonnegative().optional(),
  }),
  z.object({
    kind: z.literal('capture'),
    capture: z.enum(['screenshot', 'dom_snapshot', 'pdf']),
  }),
  // Behavioural intents (Agent-3 API-gap, shapes A3-confirmed bus W140) — map
  // server-side onto the harness scroll / behavioral_pause control-plane intents
  // (ScrollParamsSchema / BehavioralPauseParamsSchema). Distinct from
  // `interact:scroll` (bare, persona-default) — this carries explicit direction.
  z.object({
    kind: z.literal('scroll'),
    direction: z.enum(['up', 'down']),
    /** Viewport scroll distance; omit → harness 600px persona default. */
    amount_px: z.number().int().positive().optional(),
  }),
  z.object({
    kind: z.literal('behavioral_pause'),
    /** Explicit pause; omit both → harness persona idle pause. */
    duration_ms: z.number().int().nonnegative().optional(),
    /** "Pause like a human reading N words" — scaled to the persona's reading speed
     *  (harness {kind:'reading', word_count}); wins over duration_ms when present. */
    reading_word_count: z.number().int().nonnegative().optional(),
  }),
]);

export type AgentIntent = z.infer<typeof AgentIntentSchema>;

/**
 * The executor's per-intent result. Mirrors the route's `IntentResult`
 * union (apps/server/src/services/agent-executor.ts). Surfaced on the
 * typed `results` array of the message plan-executed turn result.
 */
// W443/W445 — consequential-action categories for the human-confirm guardrail.
export const ConsequentialActionCategorySchema = z.enum([
  'purchase',
  'payment',
  'account_deletion',
]);
export type ConsequentialActionCategory = z.infer<typeof ConsequentialActionCategorySchema>;

// doc-132 §5.3 auto-debug — machine-readable failure diagnosis. `reason` stays
// the human-facing copy; `diagnosis` is the structured companion an automation
// (or the GUI) can branch on without string-matching the prose. Derived
// DETERMINISTICALLY control-plane-side from the harness error code + intent
// kind — never from parsing the harness message text. The `diagnosis` FIELD is
// optional, so a result without one (an older server, a stored row) still
// parses.
//
// The CATEGORY is a different matter, and this comment used to claim otherwise.
// The enum below is the set THIS server emits — closed, so the server's own code
// is type-checked against it. It is NOT the set a reader may assume: categories
// are added over time (element_covered, target_unverified), and while the
// published contract was this closed enum, every SDK generated from it rejected
// a category newer than itself. The Python SDK's generated `Diagnosis.category`
// was a closed Literal, so a new category raised a pydantic ValidationError on
// the WHOLE turn response — for every customer who had not upgraded. So the
// published schema (`PublishedFailureDiagnosisSchema`, which `IntentResultSchema`
// and the OpenAPI spec use) says "one of these, or any other string": generated
// SDKs keep the known values for autocomplete and accept the rest.
export const FailureDiagnosisCategorySchema = z.enum([
  /** interact failed — target element missing/hidden/not yet loaded. */
  'element_not_found',
  /** navigate failed — page didn't load (site down / blocking / bad URL). */
  'page_load_failed',
  /** wait failed — the awaited condition never became true. */
  'condition_not_met',
  /** capture failed — screenshot/DOM/PDF could not be produced. */
  'capture_failed',
  /** scroll failed. */
  'scroll_failed',
  /** session-level fault (not established / dispatch error) — not this intent's fault. */
  'session_error',
  /** the request itself was malformed (missing/invalid param, unsupported action). */
  'invalid_request',
  /** result exceeded the inline size cap — narrow the selector or paginate. */
  'result_too_large',
  /** something on the page (a banner, a dialog, a sticky bar) is covering the
   *  control, so nothing was tapped or typed. Not worth repeating as is — the
   *  cover is still there — but the page can be looked at again and the cover
   *  closed. */
  'element_covered',
  /** a tap was NOT made because it could not be confirmed, just before tapping,
   *  that it would land on the intended control. Not worth repeating as is,
   *  but the page can be looked at again and the step planned afresh. */
  'target_unverified',
  /** no more-specific category applies. */
  'unknown',
]);
export type FailureDiagnosisCategory = z.infer<typeof FailureDiagnosisCategorySchema>;

export const FailureDiagnosisSchema = z.object({
  category: FailureDiagnosisCategorySchema,
  /** True only when automatically replaying the same step is considered safe.
   *  False means never auto-replay: the request may need correction, or the
   *  prior action's outcome may be unknown and require state inspection. */
  retryable: z
    .boolean()
    .describe(
      'True only when replaying the same step automatically is safe. False means do not auto-replay: the request may need correcting, or the prior action may have succeeded without reporting it.',
    ),
});
export type FailureDiagnosis = z.infer<typeof FailureDiagnosisSchema>;

/** A category as a reader receives it: a known one, or one newer than the reader. */
export type PublishedFailureDiagnosisCategory = FailureDiagnosisCategory | (string & {});

/** Open on purpose — see the comment above FailureDiagnosisCategorySchema. The
 *  `z.string()` arm is what lets a reader built before a category existed still
 *  parse a response carrying it; the enum arm keeps the known values in the
 *  published spec, so generated SDKs still list them. */
export const PublishedFailureDiagnosisCategorySchema: z.ZodType<PublishedFailureDiagnosisCategory> =
  z
    .union([FailureDiagnosisCategorySchema, z.string()])
    .describe(
      'What kind of failure this was. New categories are added over time, so treat a value you do not recognise as "unknown".',
    );

export const PublishedFailureDiagnosisSchema = FailureDiagnosisSchema.extend({
  category: PublishedFailureDiagnosisCategorySchema,
});
export type PublishedFailureDiagnosis = z.infer<typeof PublishedFailureDiagnosisSchema>;

export const IntentResultSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('success'),
    intent: AgentIntentSchema,
    summary: z.string(),
    captureId: z.string().optional(),
  }),
  z.object({
    kind: z.literal('failure'),
    intent: AgentIntentSchema,
    reason: z.string(),
    diagnosis: PublishedFailureDiagnosisSchema.optional(),
  }),
  // W443/W445 — the executor halted before dispatching a consequential action
  // (purchase / payment / account-deletion) that needs human confirmation.
  z.object({
    kind: z.literal('confirmation_required'),
    intent: AgentIntentSchema,
    category: ConsequentialActionCategorySchema,
    matchedText: z.string(),
  }),
]);

export type IntentResult = z.infer<typeof IntentResultSchema>;
