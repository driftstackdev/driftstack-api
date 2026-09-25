import { z } from 'zod';

/**
 * One step the AI decided to take, from a closed list of verbs: navigate,
 * interact, wait, capture, scroll and behavioral_pause. The first four are
 * the same actions as `/v1/sessions/:id/{navigate,interact,wait,capture}`;
 * scroll and behavioral_pause move and pause the way a person would. The
 * AI cannot invent a verb that is not here.
 *
 * These appear in the `intents` array of a plan-executed turn returned by
 * `POST /v1/agent-sessions/{id}/message`, so you can see exactly what was
 * done on your behalf.
 */
export const AgentIntentSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('navigate'), url: z.string() }),
  z.object({
    kind: z.literal('interact'),
    // W540 — 'press' (W677): value carries the key name (e.g. "Enter").
    action: z.enum(['tap', 'type', 'scroll', 'swipe', 'press']),
    selector: z.string().optional(),
    value: z.string().optional(),
    /** Type actions only. Marks the value as sensitive — a card number, a
     *  one-time code, a PIN — so it is typed straight through without the
     *  visible typing mistakes and corrections a person would make. */
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
  // Behavioural intents (harness API gap; shapes confirmed against the harness in W140) — map
  // server-side onto the harness scroll / behavioral_pause control-plane intents
  // (ScrollParamsSchema / BehavioralPauseParamsSchema). Distinct from
  // `interact:scroll` (bare, persona-default) — this carries explicit direction.
  z.object({
    kind: z.literal('scroll'),
    direction: z.enum(['up', 'down']),
    /** How far to scroll, in pixels. Omit for the default of 600px. */
    amount_px: z.number().int().positive().optional(),
  }),
  z.object({
    kind: z.literal('behavioral_pause'),
    /** How long to pause, in milliseconds. Omit both fields for the pause the
     *  session's behaviour profile would take on its own. */
    duration_ms: z.number().int().nonnegative().optional(),
    /** Pause for as long as a person would take to read this many words,
     *  scaled to the session's reading speed. Takes precedence over
     *  `duration_ms` when both are given. */
    reading_word_count: z.number().int().nonnegative().optional(),
  }),
]);

export type AgentIntent = z.infer<typeof AgentIntentSchema>;

/**
 * The kinds of action the agent asks you to approve before it carries them
 * out, when it recognises one: a purchase, a payment, or deleting an account.
 *
 * Recognition is best-effort. It works from what the page shows, so a site
 * that presents such a step in an unusual way may not be recognised. Treat the
 * approval step as a safeguard, not as a guarantee that one of these actions
 * can never happen without it — and do not give a task more authority (saved
 * payment methods, logged-in accounts) than you would give an assistant you
 * were not watching.
 *
 * A step that stops this way comes back as a `confirmation_required` result
 * carrying the category and the text it matched on. Send the next message
 * with the approval to let that step through; send anything else and it is
 * not carried out.
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

/** The category set is OPEN: a turn can fail a way this version has never
 *  heard of, so the type admits any string. The `z.string()` arm is what lets
 *  a program built before a category existed still parse a response carrying
 *  it; the enum arm keeps the known values in the published spec, so the SDKs
 *  still list them. Match the categories you know and treat anything else as
 *  `unknown`. */
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

/**
 * Something worth knowing about a step that SUCCEEDED. Absent means there is
 * nothing to report.
 *
 * `http_error_status` — a navigation reached the site and the site answered
 * with an HTTP status of 400 or above; `status` is that number. What loaded may
 * be the site's own error page, a page asking the visitor to sign in or to
 * complete a verification step first, or — on some sites — the whole page,
 * served under an error status. The step's `summary` says the same in words.
 *
 * Like the failure category, the warning KIND this server emits is a closed
 * list, and the kind a reader may receive is not: see
 * `PublishedIntentResultWarningSchema`.
 */
export const IntentResultWarningKindSchema = z.enum(['http_error_status']);
export type IntentResultWarningKind = z.infer<typeof IntentResultWarningKindSchema>;

export const IntentResultWarningSchema = z.object({
  kind: z.literal('http_error_status'),
  status: z.number().int(),
});
export type IntentResultWarning = z.infer<typeof IntentResultWarningSchema>;

/** A warning kind as a reader receives it: a known one, or one newer than the reader. */
export type PublishedIntentResultWarningKind = IntentResultWarningKind | (string & {});

/** The kind set is OPEN, for the reason the failure category is: a generated
 *  SDK that listed the kinds as a closed set would reject the whole turn
 *  response the day a new one is added. The enum arm keeps the known kinds in
 *  the published spec, so the SDKs still list them. */
export const PublishedIntentResultWarningKindSchema: z.ZodType<PublishedIntentResultWarningKind> = z
  .union([IntentResultWarningKindSchema, z.string()])
  .describe(
    'What there is to know about this step. `http_error_status`: the site answered the navigation with an HTTP status of 400 or above — the page that loaded may be an error page, a page asking to sign in or to complete a verification step, or the whole page served under that status. New kinds are added over time; treat one you do not recognise as a note, and read `summary` for what it says.',
  );

export const PublishedIntentResultWarningSchema = z
  .object({
    kind: PublishedIntentResultWarningKindSchema,
    status: z
      .number()
      .int()
      .optional()
      .describe('For `http_error_status`: the HTTP status the site answered with.'),
  })
  .describe(
    'Something worth knowing about a step that succeeded. Absent means there is nothing to report.',
  );
export type PublishedIntentResultWarning = z.infer<typeof PublishedIntentResultWarningSchema>;

export const IntentResultSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('success'),
    intent: AgentIntentSchema,
    summary: z.string(),
    captureId: z.string().optional(),
    warning: PublishedIntentResultWarningSchema.optional(),
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
