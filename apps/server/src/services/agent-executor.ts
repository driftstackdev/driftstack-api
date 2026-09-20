// AI-B2 — intent executor. Maps a DecomposeResult `plan` onto calls
// against the existing /v1/sessions/:id/{navigate,interact,wait,
// capture} surface so the dashboard chat UI can run an end-to-end
// turn (decompose → execute → append transcript → debit tokens →
// repeat) without hand-wiring the dispatch.
//
// Two executors live here and BOTH are shipped: `StubAgentExecutor`
// (every intent returns a synthetic success — a production-capable
// no-fleet fallback and the integration-test substrate) and
// `RealAgentExecutor`, which dispatches against the in-process
// SessionsService. `ControlPlaneAgentExecutor` in
// agent-executor-control-plane.ts is a third.
//
// Both real executors halt BEFORE dispatching an unapproved consequential
// action (W443/W445). They do NOT agree on what halts a plan otherwise:
//
//   RealAgentExecutor          halts on ANY failing intent —
//                              `if (result.kind === 'failure') return
//                              { results, ok: false }`
//   ControlPlaneAgentExecutor  halts on a failing intent EXCEPT a `wait`
//                              (#139) — `if (result.result.kind ===
//                              'failure' && intent.kind !== 'wait') break`
//
// V-1099 — this block read "Both real executors halt on the first failing
// intent" and quoted only the first line, which is true of one of the two.
// A `wait` is best-effort: timing out means the condition was not observed,
// not that the plan is void, and an action that actually depended on the
// awaited state fails on its own with a clearer reason. Losing the rest of
// the plan to a wait timeout is the failure #139 fixed, and the header said
// the opposite.
//
// V-808 — this header used to say the slice shipped only the stub and
// that a later follow-up would replace it. RealAgentExecutor is exported
// from this same file, so the promise had already been kept and the
// header was describing a state of the world that no longer existed.
//
// Why not call the HTTP routes directly via fetch: the agent layer
// runs in the same process as the routes; round-tripping through
// HTTP would double the latency budget + lose typed-error context.
// AI-B2.b dispatches against the in-process SessionsService instead.

import type {
  AgentIntent,
  CredentialBag,
  DecomposeResult,
  TranscriptEntry,
} from './agent-decomposer.js';
import { resolveCredential } from './agent-decomposer.js';
import type { AccountContext } from './auth.js';
import type {
  CaptureKind,
  FailureDiagnosis,
  InteractAction,
  WaitCondition,
} from '@driftstack/api-types';
import {
  classifyConsequentialAction,
  type ConsequentialActionCategory,
} from './agent-consequential-action.js';
import {
  COMMITMENT_NO_SURFACE,
  amountValueOf,
  classifyCommitTap,
  commitmentPageIdentity,
  commitmentPromptAllowed,
  commitmentReleasedByApproval,
  declaredCommitVerdict,
  declaredSurfaceIdentity,
  noteCommitmentApproved,
  selectorKeysForTap,
  type CommitmentBudget,
  type CommitmentVerdict,
  type PageCommitFacts,
} from './agent-page-commitment.js';
import { redactText } from '../lib/redact-url.js';
import { sliceWithoutSplittingSurrogate } from '../lib/bounded-text.js';
// Type only: the counts' shape and their closed enums live beside the metric
// that emits them. Erased at build time, so this is not a runtime cycle with
// agent-turn-telemetry.ts (which imports IntentResult from here, also as a type).
import type { AgentActionPathCounts } from './agent-turn-telemetry.js';

// Re-exported: the transcript sanitiser below is this module's contract, and
// its bound is only correct because of this helper.
export { sliceWithoutSplittingSurrogate };

const EXECUTOR_DIAGNOSTIC_INPUT_MAX_LENGTH = 4096;
const EXECUTOR_DIAGNOSTIC_MAX_LENGTH = 512;

function safeExecutorDiagnostic(value: string, fallback: string): string {
  const bounded = sliceWithoutSplittingSurrogate(value, EXECUTOR_DIAGNOSTIC_INPUT_MAX_LENGTH);
  return sliceWithoutSplittingSurrogate(
    redactText(bounded) || fallback,
    EXECUTOR_DIAGNOSTIC_MAX_LENGTH,
  );
}

/**
 * Per-intent execution result. The discriminated union lets callers
 * branch on success vs failure without throwing — the dashboard chat
 * UI renders each result inline so customers see WHICH intent failed
 * if a plan halts partway.
 */
export type IntentResult =
  | {
      kind: 'success';
      intent: AgentIntent;
      /** Free-form summary string for the transcript log. AI-B2.b
       *  populates this with the underlying SessionsService response
       *  (e.g. "navigated to {url}; status 200") so the agent's next
       *  turn can reason about real page state. */
      summary: string;
      /** Optional capture id (sets when intent.kind === 'capture'). */
      captureId?: string;
    }
  | {
      kind: 'failure';
      intent: AgentIntent;
      /** Customer-facing failure reason. Comes from the SessionsService
       *  problem-type response in the wired variant. */
      reason: string;
      /** doc-132 §5.3 — machine-readable failure diagnosis (mirrors the
       *  api-types IntentResult failure variant). Optional: only the
       *  control-plane executor populates it today (via intentResultToCustomer);
       *  the driver-path variants omit it. */
      diagnosis?: FailureDiagnosis;
    }
  | {
      // W443/W445 — the executor halted BEFORE dispatching a consequential
      // action (purchase / payment / account-deletion) that needs human
      // confirmation. The customer approves, then the plan re-runs with this
      // action's signature in `approvedConsequentialActions`.
      kind: 'confirmation_required';
      intent: AgentIntent;
      category: ConsequentialActionCategory;
      /** The matched consequential phrase — surfaced in the confirmation prompt. */
      matchedText: string;
    };

export interface ExecutorRunResult {
  results: ReadonlyArray<IntentResult>;
  /** True iff every intent in the plan returned `kind: success`.
   *  False if any intent failed OR the plan halted awaiting confirmation. */
  ok: boolean;
  /** True when the plan halted awaiting human confirmation of a consequential
   *  action (the last result is `kind: confirmation_required`) — distinct from
   *  a plain failure; the customer approves then the plan re-runs. */
  awaitingConfirmation?: boolean;
  /** Internal control-authority halt. Any listed results settled before the
   * fence failed; no undispatched suffix was started. The runtime suppresses
   * transcript publication and returns an honest authority conflict. */
  authorityLost?: boolean;
  /**
   * B2 — the customer pressed Stop and this run honoured it: nothing was
   * dispatched after the stop was observed. Every listed result settled — a step
   * that was already on its way to the device when Stop arrived is waited for
   * and recorded (see {@link STOP_IN_FLIGHT_GRACE_MS}), because a click whose
   * outcome is unknown must never be reported as a click that did not happen.
   *
   * Distinct from `authorityLost`: that is control changing hands and the turn's
   * words must not be published; this is the owner of the turn asking it to
   * stop, and the turn reports exactly what ran.
   */
  stopped?: boolean;
  /**
   * The turn's hard stop ({@link ExecuteArgs.turnHardStopAtMs}) was reached and
   * this run ended BETWEEN steps: the step that had started ran to its own end
   * and was recorded, nothing further was announced or dispatched, and nothing
   * was left in flight.
   *
   * Distinct from `stopped`, which is the customer asking. Nobody asked for
   * this one, so the turn owes the customer a sentence saying why it ended — the
   * runtime reads this and ends the loop with the wall-clock sentence, on a
   * re-plan exactly as on a `continue`, because this run ends on no ✗ row of its
   * own and silence over a column of ticks is the failure the sentences exist
   * to prevent.
   */
  hardStopped?: true;
  /**
   * P1 — this result is the MERGE of a run that failed and a re-planned run that
   * then finished the job. No single `execute()` ever sets it; only
   * `mergeExecutorRuns` does.
   *
   * It exists because `ok` and "a failure row is present" stopped being
   * mutually exclusive the moment a turn could recover. The transcript builder
   * reads it to say "a step failed, the page was read, the rest was re-planned"
   * instead of "(plan halted on failure)" — which would be a false claim
   * replayed into the NEXT turn's model context as history.
   */
  recoveredAfterReplan?: boolean;
  /**
   * What the DEVICE says each successful tap actually landed on — its canonical
   * selector for the element — keyed by the result object in `results`.
   *
   * ⛔ WHY IT IS NOT A FIELD ON THE RESULT. A result is handed to the customer
   * as it stands (the message response and every streamed step frame project it
   * without dropping fields), so anything put on it is public API. This is the
   * repeat guard's evidence and nobody else's: the runtime reads it to compare
   * two taps by the element they hit rather than by how the plan spelled them.
   * Absent for every tap the device could not identify (an older device, a look
   * that failed) — the guard then compares spellings exactly as before.
   */
  tapTargets?: ReadonlyMap<IntentResult, ReadonlyArray<string>>;
  /**
   * The run stopped BEFORE dispatching a tap the repeat guard
   * ({@link ExecuteArgs.repeatGuard}) refused: the device identified it as an
   * element an earlier segment of this turn already tapped, on a page that has
   * not moved. Nothing was sent for it and no result was recorded; the runtime
   * ends the turn with the matching stop sentence.
   */
  repeatRefused?: 'no_progress' | 'repeat_refused';
  /**
   * HOW THE DEVICE PERFORMED THIS RUN'S ACTIONS, and how each step's selector
   * was resolved before the tap — counts only, by the closed enums in
   * services/agent-turn-telemetry.ts.
   *
   * ⛔ WHY IT IS HERE AND NOT ONLY IN THE METRICS. Production has no scraper, so
   * the registry's copy is read by nothing. The turn's telemetry collector reads
   * this and writes ONE log line per turn (`agent_turn_action_paths`), which is
   * the durable record an operator greps. The two are the same numbers from one
   * source: the executor increments both at the same site.
   *
   * ⛔ NOT PUBLIC, AND NOT ON AN IntentResult. Like {@link tapTargets} this is
   * evidence for the server, and an IntentResult is projected to the customer
   * whole. Absent from executors that do not dispatch (the stub, the legacy
   * driver path), which simply report nothing.
   */
  actionPaths?: AgentActionPathCounts;
}

/** Stable signature of a consequential action, for the approve → re-run carry
 *  (the confirmation_required result echoes back as an approved signature). */
export function consequentialSignature(
  category: ConsequentialActionCategory,
  matchedText: string,
): string {
  return `${category}:${matchedText.toLowerCase()}`;
}

/**
 * What the PAGE calls the element a tap addresses, from the names read off the
 * page the planner was last shown — or '' when the page has no name for it.
 *
 * Looked up the way the planner may have respelled it: as written, then by the
 * id or test id in its last compound (`button#pay` and `#pay` are one element).
 *
 * ⛔ THE KEYS COME FROM ONE PLACE. `selectorKeysForTap` is shared with the
 * commitment arm's own fact lookup, so the names and the structural facts can
 * never end up keyed differently for the same tap — a drift nothing would fail
 * on, and one that would silently leave the newer arm looking at no element.
 */
function pageLabelForTap(intent: AgentIntent, pageLabels: ReadonlyMap<string, string>): string {
  if (intent.kind !== 'interact' || intent.action !== 'tap' || intent.selector === undefined) {
    return '';
  }
  const found: string[] = [];
  for (const key of selectorKeysForTap(intent.selector)) {
    const label = pageLabels.get(key);
    if (label !== undefined) found.push(label);
  }
  return found.join(' ');
}

/**
 * P4 — what the executor knows about the page a tap is about to be made on, and
 * the turn's own commitment budget. Absent for every executor that does not read
 * pages, which is what keeps the structural arm out of their gate entirely.
 */
export interface CommitmentArm {
  /** The page's structural facts, or null when none could be read. */
  facts: PageCommitFacts | null;
  /** The TURN's budget — arming, the read allowance and the prompt ceiling. */
  budget: CommitmentBudget;
  /** What the device said the tap target is, from the look before the tap. */
  targetType?: string;
  /** Where the device's focus is believed to be — the last control this run
   *  typed into or tapped — for a key press that submits the focused form. */
  focusSelector?: string;
  /**
   * ⛔ THE PLANNER'S OWN DECLARATION for this step, when it made one: that
   * carrying it out commits a purchase, a payment or an account deletion.
   *
   * A THIRD arm, never the only one. The structural arm cannot see a commit
   * behind a script handler on a `<div>` or a link, an iframed payment form, or
   * account deletion in a language the caption arm does not read — and in every
   * one of those the model usually knows what the step is, because the customer
   * asked for it. It is consulted after the other two, so it can only ADD
   * halts, and a page that talks the model out of declaring changes nothing
   * about what they do.
   */
  declared?: ConsequentialActionCategory;
}

/** Which arm of the gate raised a halt. A closed set: it is a metric label. */
export type ConsequentialHaltArm = 'caption' | 'structure' | 'declared';

/** If `intent` is a consequential action not yet approved, returns the
 *  confirmation_required result to halt on. A matching approval is consumed
 *  before returning null, so one human decision releases one action only. Exported so every
 *  AgentExecutor implementation (Stub / Real / ControlPlane) applies the SAME
 *  human-confirmation gate — swapping executors must never drop it (#139/#130).
 *
 *  ⛔ `pageLabels` MAKES THE GATE INDEPENDENT OF THE PLANNER. The classifier reads
 *  the tap's selector and its `value`, and `value` is written by the model — the
 *  one party a hostile page is trying to steer, and free to leave it out. With a
 *  turn that plans from the page's own selector list, `#cta-primary` is how a
 *  "Confirm purchase" button is addressed, and nothing in that says purchase. So an
 *  executor that has read the page passes what the PAGE calls each element, and
 *  the tap is classified on all three. It can only ever ADD a halt.
 *
 *  `deviceLabels` — what the DEVICE says is at the tap, read just before it:
 *  the element the selector resolves to and the element its hit test returns at
 *  the tap point. The digest's names are keyed by the selector the digest wrote,
 *  so an id-less element the planner spelled its own way has no name there; the
 *  device resolves ANY spelling, and the hit element is what a native tap would
 *  actually activate. Same rule: more text to classify, so only ever more halts. */
export function consequentialHalt(
  intent: AgentIntent,
  approved: Set<string>,
  pageLabels?: ReadonlyMap<string, string>,
  deviceLabels?: ReadonlyArray<string>,
  commitment?: CommitmentArm,
  /** Called with the arm that raised a halt, for the counter. Best-effort and
   *  never consulted: a gate whose telemetry throws still gates. */
  onHalt?: (arm: ConsequentialHaltArm) => void,
): Extract<IntentResult, { kind: 'confirmation_required' }> | null {
  const halted = (
    arm: ConsequentialHaltArm,
    result: Extract<IntentResult, { kind: 'confirmation_required' }>,
  ): Extract<IntentResult, { kind: 'confirmation_required' }> => {
    try {
      onHalt?.(arm);
    } catch {
      /* a broken counter must never change a verdict */
    }
    return result;
  };
  const withLabels = (labels: ReadonlyArray<string>): AgentIntent => {
    const text = labels.filter((label) => label.length > 0).join(' ');
    return text.length > 0 && intent.kind === 'interact'
      ? { ...intent, value: `${intent.value ?? ''} ${text}` }
      : intent;
  };
  const pageLabel = pageLabels !== undefined ? pageLabelForTap(intent, pageLabels) : '';
  const deviceText =
    intent.kind === 'interact' && intent.action === 'tap' ? (deviceLabels ?? []) : [];
  // The plan's words and the digest's name FIRST, the device's labels only when
  // those say nothing. Both readings can only add halts; ordering them keeps the
  // phrase a halt is raised on — and so its approval signature — the same
  // whether or not the device was asked, so an approval releases the tap it
  // was given for instead of meeting a new phrase found in a longer text.
  const planned = classifyConsequentialAction(withLabels([pageLabel]));
  const v =
    planned.requiresConfirmation || deviceText.length === 0
      ? planned
      : classifyConsequentialAction(withLabels([pageLabel, ...deviceText]));
  if (!v.requiresConfirmation || v.category === undefined || v.matchedText === undefined) {
    // ⛔ THE COMMITMENT ARM, AND ONLY WHERE THE WORDS SAID NOTHING. Reading it
    // second is what keeps every halt that happens today byte-identical: the
    // phrase a halt is raised on, and therefore its approval signature, is
    // still the phrase one of the fourteen patterns matched. This arm can only
    // ADD halts — it is never consulted for a tap the words already halt, and
    // it never releases one.
    if (commitment === undefined) return null;
    const structuralOrDeclared = commitmentHalt(intent, approved, commitment);
    return structuralOrDeclared === null
      ? null
      : halted(structuralOrDeclared.arm, structuralOrDeclared.result);
  }
  const signature = consequentialSignature(v.category, v.matchedText);
  // ⛔ AN APPROVAL RELEASES THE KIND OF ACTION IT WAS GIVEN FOR, NOT THE TAP.
  // When the plan's own words raised the halt, the device's labels were not
  // read above — and an approval for a purchase must not release a tap the
  // device says lands on deleting the account. So each device label is read on
  // its own: one that names a DIFFERENT kind of consequential action halts
  // under that kind unless it was approved too. The same kind in other words
  // (a purchase worded differently from the approved one) is the approved
  // action, and re-asking for it would re-prompt forever.
  if (v === planned && approved.has(signature)) {
    const crossKind: Array<{
      category: ConsequentialActionCategory;
      matchedText: string;
      signature: string;
    }> = [];
    for (const label of deviceText) {
      // The label ALONE: with the plan's words beside it, the planned kind
      // would match first and hide the one the device names.
      const d = classifyConsequentialAction({ kind: 'interact', action: 'tap', value: label });
      if (!d.requiresConfirmation || d.category === undefined || d.matchedText === undefined) {
        continue;
      }
      if (d.category === v.category) continue;
      crossKind.push({
        category: d.category,
        matchedText: d.matchedText,
        signature: consequentialSignature(d.category, d.matchedText),
      });
    }
    const unapproved = crossKind.find((d) => !approved.has(d.signature));
    if (unapproved !== undefined) {
      // Nothing is released, so the plan's approval is NOT consumed.
      return halted('caption', {
        kind: 'confirmation_required',
        intent,
        category: unapproved.category,
        matchedText: unapproved.matchedText,
      });
    }
    for (const d of crossKind) approved.delete(d.signature);
  }
  if (approved.delete(signature)) return null;
  return halted('caption', {
    kind: 'confirmation_required',
    intent,
    category: v.category,
    matchedText: v.matchedText,
  });
}

/**
 * The commitment arm's half of the gate: a tap whose WORDS say nothing, on a
 * control the page's own markup says submits a form that commits value, on a
 * page (or in a turn) with money on the table.
 *
 * ⛔ IT RIDES THE EXISTING APPROVAL RAILS. Same `confirmation_required` result,
 * same two published categories, same `consequentialSignature` echo — the SDKs
 * and the desktop app switch on nothing new.
 *
 * ⛔ AND IT IS BOUNDED, because a page that can raise prompts can farm them. At
 * most {@link COMMITMENT_PROMPT_CEILING} commitment prompts per turn; past that
 * the budget is marked and the caller STOPS the turn rather than asking a third
 * time. A ceiling that keeps asking is a consent treadmill; one that stops is
 * not. Nothing is dispatched either way.
 */
function commitmentHalt(
  intent: AgentIntent,
  approved: Set<string>,
  commitment: CommitmentArm,
): {
  arm: ConsequentialHaltArm;
  result: Extract<IntentResult, { kind: 'confirmation_required' }>;
} | null {
  const structural = classifyCommitTap({
    intent,
    facts: commitment.facts,
    budget: commitment.budget,
    ...(commitment.targetType !== undefined ? { targetType: commitment.targetType } : {}),
    ...(commitment.focusSelector !== undefined ? { focusSelector: commitment.focusSelector } : {}),
  });
  // ⛔ THE STRUCTURAL ARM IS ASKED FIRST, so every halt that happens today keeps
  // the phrase — and therefore the approval signature — it has always had. The
  // declaration is the arm that reaches what the structure cannot see.
  const verdict: CommitmentVerdict | null =
    structural ?? declaredCommitVerdict(intent, commitment.declared);
  if (verdict === null) return null;
  const control = verdict.control;
  // WHICH COMMITMENT SURFACE this prompt belongs to, for the ceiling.
  //
  // ⛔ AND WHEN THE PAGE OFFERS NOTHING TO KEY ON, THE DECLARATION IS THE
  // SURFACE. Every page the declared arm exists for is one the structural arm
  // cannot read, so keying them all by the page gave all of them the SAME
  // identity — and the per-page ceiling, which no approval refunds, then read
  // three different purchases the customer asked for as one page asking three
  // times and handed the third back. See `declaredSurfaceIdentity` for why
  // this loosens nothing a page can reach without the customer's own answer.
  const pageSurface = commitmentPageIdentity(commitment.facts);
  const pageId =
    pageSurface === COMMITMENT_NO_SURFACE && verdict.arm === 'declared'
      ? declaredSurfaceIdentity(verdict)
      : pageSurface;
  const signature = consequentialSignature(verdict.category, verdict.matchedText);
  if (approved.delete(signature)) {
    // The customer approved this exact commitment, so it no longer counts
    // toward the per-task ceiling: asking for a second purchase is not a page
    // asking twice. The per-PAGE count is untouched — see
    // COMMITMENT_PROMPT_CEILING.
    noteCommitmentApproved(commitment.budget, pageId);
    // What the customer said yes to, so the SECOND step of a two-step confirm
    // is the same decision rather than a second interrogation. Bound to the
    // destination, the amount, and ⛔ to being a control the approved page was
    // NOT already offering; see `commitmentReleasedByApproval`. Only a
    // STRUCTURAL verdict can release a later step: a declaration names no
    // destination and no amount to bound one with.
    commitment.budget.approved =
      verdict.arm === 'structure'
        ? {
            category: verdict.category,
            action: control?.action ?? '',
            amount: verdict.amount,
            value: verdict.amount === null ? null : amountValueOf(verdict.amount),
            siblings: new Set(
              [...(commitment.facts?.controls.values() ?? [])].map((candidate) => candidate.key),
            ),
          }
        : null;
    return null;
  }
  if (control !== undefined && commitmentReleasedByApproval(commitment.budget, verdict, control)) {
    return null;
  }
  commitmentPromptAllowed(commitment.budget, pageId);
  return {
    arm: verdict.arm,
    result: {
      kind: 'confirmation_required',
      intent,
      category: verdict.category,
      matchedText: verdict.matchedText,
    },
  };
}

/**
 * P3 — a mutable element-wait ceiling, shared by every plan run in one turn.
 *
 * `remainingMs: null` is the UNSEEDED state (see {@link ExecuteArgs.elementWaitBudget});
 * an executor that supports element waits replaces it with its own configured
 * run budget on first use and debits from there.
 */
export interface ElementWaitBudget {
  remainingMs: number | null;
}

export interface ExecuteArgs {
  /** /v1/sessions (driftstack `ses_…`) session id the plan runs against. Used by
   *  the legacy driver-path RealAgentExecutor. NULL/`unattached` for a pure
   *  /v1/agent-sessions run (no attached driftstack session) — the fleet path
   *  keys on `agentSessionId` instead. */
  sessionId: string;
  /**
   * #139 — the AGENT session id (`agt_…`). This is the id the fleet control plane
   * dispatched the session to the box under (sessionAssign) AND the key on
   * `agent_sessions.node_id`, so it is THE routing key for the control-plane
   * executor. The runtime always sets it; ControlPlaneAgentExecutor dispatches on
   * it. Optional on the interface so the legacy driver-path executors + existing
   * callers keep compiling (they use `sessionId`).
   */
  agentSessionId?: string;
  /** The plan to execute. Refuse + clarify results are no-ops here —
   *  the caller (agent runtime) handles those before reaching the
   *  executor. The narrowing happens at the type level. */
  plan: Extract<DecomposeResult, { kind: 'plan' }>;
  /**
   * AI-B2.b — the caller's AccountContext, required by RealAgentExecutor
   * for ownership-scoped SessionsService dispatch. Optional on the
   * interface so StubAgentExecutor (which ignores it) + existing callers
   * keep working; RealAgentExecutor surfaces a typed failure if it's
   * absent. The runtime threads it once the bootstrap swap (increment
   * 1.5) wires the real executor.
   */
  account?: AccountContext;
  /** W443/W445 — signatures (consequentialSignature) of consequential actions
   *  the customer has already approved this run. Executors copy and consume
   *  one signature per matching action so a repeated target re-prompts. */
  approvedConsequentialActions?: ReadonlySet<string>;
  /** Internal terminal fence. Executors await it immediately before each
   * intent dispatch; false/throw stops the undispatched suffix fail-closed. */
  shouldContinue?: () => boolean | Promise<boolean>;
  /**
   * B2 — aborts when the customer presses Stop.
   *
   * Checked before every dispatch, so nothing new reaches the device once the
   * stop is observed. It does NOT abandon a dispatch already in flight when the
   * step can change the page: that step's result is awaited, bounded by
   * {@link STOP_IN_FLIGHT_GRACE_MS}, and recorded — outcome-unknown if the bound
   * runs out. A step that changes nothing on the page (a wait, a capture, an
   * element wait, a behavioural pause) is cut short at once, since abandoning it
   * cannot leave the page in a state nobody knows. The result then carries
   * `stopped: true`.
   *
   * Kept apart from `shouldContinue` on purpose: a false `shouldContinue` means
   * control changed hands and ends the run as `authorityLost`, which the runtime
   * publishes nothing for. A stop is the turn's owner asking, and the turn must
   * say what ran.
   */
  signal?: AbortSignal;
  /**
   * P2 — the session's credential bag, for resolving the plan's
   * `{{credential:name}}` placeholders at dispatch time.
   *
   * ⛔ IN-MEMORY, FOR THE LENGTH OF THIS CALL. It is never logged, never put on
   * a result, and never persisted — the whole reason the plan carries
   * placeholders is so the resolved value exists only inside the dispatch that
   * uses it. See {@link substituteCredentials}.
   */
  credentials?: CredentialBag;
  /**
   * P3 — the element-wait ceiling this run SHARES with the rest of the turn.
   *
   * ⛔ WHY THE CALLER OWNS IT. The ceiling exists so extra patience cannot
   * multiply: a plan of twenty missing selectors must not spend twenty waits.
   * A budget built inside `execute()` enforced that per RUN, which was the same
   * thing as per turn until P1 made one turn run up to three plans — at which
   * point the documented ceiling silently became three times itself. The runtime
   * now builds ONE of these per turn and threads it through every run, so the
   * number in the comment is the number the customer's turn can actually spend.
   *
   * `remainingMs: null` means NOT YET SEEDED: the executor fills it from its own
   * configured run budget the first time it uses it. That keeps the caller from
   * having to know an executor-private number, and keeps a stub executor that
   * ignores the field costing nothing. Omitted entirely → the executor uses a
   * private per-run budget, exactly as before.
   */
  elementWaitBudget?: ElementWaitBudget;
  /**
   * P4 — the TURN's commitment budget: what stakes it has seen, how many extra
   * page reads the commitment arm has spent, and how many commitment prompts it
   * has raised.
   *
   * ⛔ OWNED BY THE CALLER FOR THE REASON `elementWaitBudget` IS. Arming has to
   * span the turn, not the plan: a basket page prints the total and the checkout
   * that follows it often prints nothing at all, and those are two segments of
   * one turn. A budget built inside `execute()` would forget the total between
   * them, and the order button on the second page would be unarmed.
   *
   * Omitted → the commitment arm is off and the gate is exactly the caption
   * matcher, which is what the stub and legacy executors and every pre-existing
   * caller get.
   */
  commitmentBudget?: CommitmentBudget;
  /**
   * ⛔ THE PLANNER'S OWN DECLARATIONS for this plan's steps, by index into
   * `plan.intents`: that carrying this step out commits a purchase, a payment
   * or an account deletion.
   *
   * NOT A FIELD ON THE INTENT. `AgentIntent` is published — it is what a turn
   * response lists back to the customer — and a declaration is the gate's
   * business, not the customer's API. It travels beside the plan, inside this
   * process, exactly as the page's own structural facts do.
   *
   * Omitted → the third arm is off and the gate is the two arms that shipped,
   * which is what every caller that does not plan with a model gets.
   */
  declaredCommitments?: ReadonlyArray<{ at: number; category: ConsequentialActionCategory }>;
  /**
   * The instant, on the executor's own monotonic clock, past which the step loop
   * starts no further step — the turn's HARD stop.
   *
   * ⛔ AN INSTANT, NOT A DURATION, for the reason `elementWaitBudget` is shared
   * rather than rebuilt: a turn runs up to three plans, and a per-run duration
   * would be three hard stops. The runtime computes it ONCE at the top of the
   * turn (`turnStartedAtMs + TURN_HARD_STOP_MS`) and threads the same instant
   * through every run, so what the comment promises is what a turn can spend.
   *
   * ⛔ ONE CLOCK. The runtime's `nowMs` and the executor's `now` are both
   * `performance.now()` by default and a test that injects one must inject the
   * other; comparing an instant from one monotonic clock against another is how
   * a bound reads as "already exceeded" on a turn that just started.
   *
   * Checked at the TOP of the step loop beside the Stop check, so the run ends
   * BETWEEN steps with nothing in flight, carrying
   * {@link ExecutorRunResult.hardStopped} — and again before a step's own retry
   * budget starts another dispatch, because a step is not one dispatch and the
   * claim TTL derived from this bound assumes only one is left in flight past
   * it. Omitted → no hard stop, which is what the stub and legacy executors and
   * every pre-existing caller get.
   */
  turnHardStopAtMs?: number;
  /**
   * Live-progress hook (step streaming). Called once per intent AS its result
   * lands — BEFORE the whole run finishes — so a streaming caller can surface
   * per-step progress instead of only the final ExecutorRunResult. `index` is
   * the 0-based position of the result in `ExecutorRunResult.results`. It is
   * best-effort and MUST NOT affect the run: executors call it inside a
   * try/catch and a throwing/slow handler neither aborts nor blocks execution.
   * Optional, so non-streaming callers and the stub/legacy executors are
   * unaffected (they simply never call it).
   */
  onStep?: (result: IntentResult, index: number) => void;
  /**
   * Live-progress hook fired BEFORE an intent is dispatched, as the mirror of
   * `onStep` (which only fires once the result has landed). A single intent can
   * occupy the customer for tens of seconds, so "step 2 of 5 is starting" is the
   * difference between visible progress and a frozen list. Same best-effort
   * contract as `onStep`: wrapped in try/catch, never affects the run, and
   * optional so existing executors/callers are unaffected.
   */
  onStepStart?: (intent: AgentIntent, index: number) => void;
  /**
   * B1 — the turn's repeat guard, asked again at the moment a tap's TARGET is
   * known.
   *
   * The runtime admits a segment by comparing selectors as the planner wrote
   * them, which cannot see that `form > button.primary` and `[aria-label="Send"]`
   * are one id-less button. An executor that has asked the device what a tap
   * resolves to calls this with that answer (the device's canonical selectors
   * for the element) before dispatching the tap; a non-null verdict stops the
   * run there with nothing sent (see {@link ExecutorRunResult.repeatRefused}).
   * Optional: an executor that cannot identify targets never calls it, and a
   * caller that does not pass it gets no extra refusals.
   */
  repeatGuard?: (
    intent: AgentIntent,
    targets: ReadonlyArray<string>,
  ) => 'no_progress' | 'repeat_refused' | null;
}

/**
 * P2 — resolve a plan's credential placeholders into the values the DEVICE
 * receives, at the last possible moment.
 *
 * ⛔ THE RETURNED INTENT IS FOR THE DISPATCH ONLY. Callers keep the ORIGINAL
 * (placeholder-bearing) intent on the IntentResult, so the transcript, the
 * message response and the next turn's model context all carry
 * `{{credential:password}}` and never the password. That asymmetry is the
 * feature; collapsing it — putting the resolved intent on the result "so the log
 * matches" — would write the customer's password into encrypted-at-rest history
 * and then replay it into the next prompt.
 *
 * Returns `unresolved` naming the placeholder when no such credential is held.
 * Typing the literal `{{credential:otp}}` into a login form would be a
 * confident, silent failure: the form accepts it, the step goes green, and the
 * site rejects the login for a reason nothing in the turn explains.
 */
export type CredentialSubstitution =
  | { ok: true; intent: AgentIntent; substituted: boolean }
  /**
   * The step cannot be dispatched, naming the credential and WHY:
   *  · `not_held` — the plan asked for a credential this chat does not have.
   *  · `unsupported_field` — the placeholder is somewhere a credential cannot be
   *    resolved safely (a url, a selector), so it would have gone to the device
   *    as literal text. Both fail the step; only the sentence differs.
   */
  | { ok: false; unresolved: string; why: 'not_held' | 'unsupported_field' };

const CREDENTIAL_PLACEHOLDER_RE = /\{\{credential:([A-Za-z0-9_.-]{1,64})\}\}/g;

/**
 * The first credential name a placeholder mentions ANYWHERE in an intent, or
 * null. Scans the serialized intent rather than a list of fields, because the
 * list of fields is what drifts: a verb gains a `url` or a `script` and the
 * scanner silently stops covering it.
 */
function firstPlaceholderAnywhere(intent: AgentIntent): string | null {
  CREDENTIAL_PLACEHOLDER_RE.lastIndex = 0;
  return CREDENTIAL_PLACEHOLDER_RE.exec(JSON.stringify(intent))?.[1] ?? null;
}

export function substituteCredentials(
  intent: AgentIntent,
  credentials: CredentialBag | undefined,
): CredentialSubstitution {
  if (intent.kind !== 'interact' || typeof intent.value !== 'string') {
    // ⛔ NOT SUBSTITUTED IS NOT THE SAME AS FINE. Only an interact VALUE is a
    // place a credential may be resolved into — that is the one field the
    // device treats as text to type, and the one the `sensitive` flag protects.
    // A placeholder in a url, a selector or anywhere else is a plan we cannot
    // carry out safely, and dispatching it verbatim is the confident silent
    // failure this whole mechanism exists to prevent: the device navigates to
    // `https://api.test/?token={{credential:api_token}}`, the step goes green,
    // and the site rejects it for a reason nothing in the turn explains.
    const stray = firstPlaceholderAnywhere(intent);
    return stray === null
      ? { ok: true, intent, substituted: false }
      : { ok: false, unresolved: stray, why: 'unsupported_field' };
  }
  const value = intent.value;
  CREDENTIAL_PLACEHOLDER_RE.lastIndex = 0;
  if (!CREDENTIAL_PLACEHOLDER_RE.test(value)) return { ok: true, intent, substituted: false };
  let unresolved: string | null = null;
  CREDENTIAL_PLACEHOLDER_RE.lastIndex = 0;
  const resolved = value.replace(CREDENTIAL_PLACEHOLDER_RE, (whole, name: string) => {
    const secret = resolveCredential(credentials, name);
    if (secret === undefined) {
      unresolved ??= name;
      return whole;
    }
    return secret;
  });
  if (unresolved !== null) return { ok: false, unresolved, why: 'not_held' };
  return {
    intent: {
      ...intent,
      value: resolved,
      // A substituted value IS a secret, whatever the selector looks like, so
      // the device must not apply behavioural typo correction to it and must not
      // log it. Set here rather than trusted from the plan: the model does not
      // know which of its placeholders resolve to a password.
      sensitive: true,
    },
    ok: true,
    substituted: true,
  };
}

/**
 * B2 — how long, AFTER the customer presses Stop, a step that was already on its
 * way to the device is waited for before it is recorded as outcome-unknown.
 *
 * WHY WAIT AT ALL. A tap, a typed value or a navigation that has left the server
 * may already have happened on the page. Abandoning it would report "stopped
 * before step 4" over a form that was in fact submitted, and the customer — told
 * it did not happen — would send it again.
 *
 * WHY FIFTEEN SECONDS. A healthy gesture answers in one to three seconds and a
 * navigation inside the page-load threshold the element wait already uses (see
 * the control-plane executor's DEFAULT_ELEMENT_APPEAR_WAIT_MS: "poor" starts at
 * 4s) plus the round trip, so fifteen seconds covers a slow-but-alive step with
 * room to spare. Past it the step is not answering, and the customer watching
 * "Stopping…" is better served by an honest "I could not confirm whether this
 * happened — check the page" than by waiting out the dispatch's own ceiling,
 * which for a navigation is over a minute.
 */
export const STOP_IN_FLIGHT_GRACE_MS = 15_000;

/**
 * B2 — the sentence a step carries when Stop arrived while it was running and its
 * result did not come back within {@link STOP_IN_FLIGHT_GRACE_MS}. Customer-visible:
 * it says what is known (the step was sent) and what is not (whether it landed),
 * and the one thing to do about it.
 */
export const STOPPED_OUTCOME_UNKNOWN_REASON =
  'this step was already running when the task was stopped, and I could not confirm whether it happened — check the page before doing it again';

/**
 * B2 — the sentence a step carries when Stop cut it short and nothing on the
 * page depended on its outcome. Reading the page, waiting for something to
 * appear, or pausing the way a person would changes nothing on the site, so "it
 * did not finish" is the whole truth — and it is the whole truth about a pause
 * too, where the outcome-unknown sentence's "check the page before doing it
 * again" would be asking the customer to inspect a page for the effects of
 * waiting.
 */
export const STOPPED_BEFORE_FINISHING_REASON = 'the task was stopped before this step finished';

/**
 * Whether the customer has pressed Stop. A function rather than an inline
 * `signal?.aborted` because the answer changes across every `await`, and an
 * inline read after an earlier one is narrowed by the compiler to its old value.
 */
export function stopRequested(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/**
 * `work`, or the abort of `signal` if that comes first. The work itself is NOT
 * cancelled — the caller decides whether abandoning it is safe — and the abort
 * listener is removed as soon as either settles, so a long turn that races many
 * dispatches against one signal does not accumulate listeners on it.
 */
export async function raceAbort<T>(
  work: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<{ aborted: false; value: T } | { aborted: true }> {
  if (signal === undefined) return { aborted: false, value: await work };
  if (signal.aborted) return { aborted: true };
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<{ aborted: true }>((resolve) => {
    onAbort = () => {
      resolve({ aborted: true });
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([
      work.then((value) => ({ aborted: false as const, value })),
      aborted,
    ]);
  } finally {
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort);
  }
}

export async function executionMayContinue(check: ExecuteArgs['shouldContinue']): Promise<boolean> {
  if (check === undefined) return true;
  try {
    return await check();
  } catch {
    return false;
  }
}

export interface AgentExecutor {
  /**
   * Run a plan's intents in order. Halts on first failure (returns
   * partial results), with one implementation-level exception: the
   * control-plane executor continues past a failed `wait` (#139), since a
   * wait that times out means the condition was not observed rather than
   * that the plan is void. Never throws — failures surface as
   * IntentResult discriminants instead.
   *
   * AI-B2.b will accept an optional cancellation signal and
   * propagate it to the underlying SessionsService dispatch.
   */
  execute(args: ExecuteArgs): Promise<ExecutorRunResult>;

  /**
   * #140 read-and-report — read the current page's text for the answer pass.
   * Dispatches a `get_page_source` against the live session and returns the
   * source text (or null if unavailable / the session can't be read). OPTIONAL:
   * only the control-plane executor implements it; the runtime feature-detects
   * (`if (executor.observe)`) before use. Best-effort — never throws (returns
   * null on any failure); the read-back is additive, it must never fail a turn.
   */
  observe?(
    sessionId: string,
    shouldContinue?: ExecuteArgs['shouldContinue'],
    /** B2 — Stop cuts the read short: it changes nothing on the page, so
     *  abandoning it is safe, and it resolves null like any other failed read. */
    signal?: AbortSignal,
  ): Promise<string | null>;

  /**
   * P1 perceive — read the current page as a BOUNDED digest of its interactive
   * elements, for PLANNING. Same dispatch as {@link observe}; different
   * consumer, and therefore a different shape: the answer pass wants the page's
   * text, the planner wants selectors it can target.
   *
   * OPTIONAL and feature-detected by the runtime for the same reason `observe`
   * is: an executor that cannot see the page still runs plans, it just plans
   * them blind — which is the behaviour every executor had before this. Returns
   * null on any failure; perceiving is additive and must never fail a turn.
   */
  observeDigest?(
    sessionId: string,
    shouldContinue?: ExecuteArgs['shouldContinue'],
    /** B2 — same as {@link observe}'s. */
    signal?: AbortSignal,
    /**
     * P4 — the TURN's commitment budget. The digest is where a page's stakes
     * are read, and arming has to span the turn, so the read folds what it
     * finds into the budget the executor's gate will later judge against.
     * Omitted → the read is exactly what it was.
     */
    commitmentBudget?: CommitmentBudget,
  ): Promise<string | null>;
}

/**
 * Stub executor — returns synthetic success for every intent. Useful
 * for end-to-end tests of the decompose → execute → append-transcript
 * loop, and for the dashboard chat-UI to render a believable
 * turn-by-turn flow during pre-launch demos.
 */
export class StubAgentExecutor implements AgentExecutor {
  async execute(args: ExecuteArgs): Promise<ExecutorRunResult> {
    const results: IntentResult[] = [];
    // Record + surface each result as live progress in one place, so the stub
    // exercises the same step-streaming contract as the control-plane executor.
    const emitStep = (r: IntentResult): void => {
      results.push(r);
      try {
        args.onStep?.(r, results.length - 1);
      } catch {
        /* a broken progress handler must not affect execution */
      }
    };
    // Treat approvals as one-shot capabilities. Copy so execution consumes its
    // local grant without mutating the caller-owned set.
    const approved = new Set(args.approvedConsequentialActions ?? []);
    for (const [planIndex, intent] of args.plan.intents.entries()) {
      // B2 — the same stop contract as the control-plane executor: nothing is
      // started once Stop has been observed.
      if (args.signal?.aborted === true) return { results, ok: false, stopped: true };
      if (!(await executionMayContinue(args.shouldContinue))) {
        return { results, ok: false, authorityLost: true };
      }
      const halt = consequentialHalt(intent, approved);
      if (halt) {
        emitStep(halt);
        return Promise.resolve({ results, ok: false, awaitingConfirmation: true });
      }
      // Same before-dispatch progress contract as the control-plane executor —
      // including its position AFTER the safety gate, so a halted intent is
      // never announced as the step in progress.
      try {
        args.onStepStart?.(intent, planIndex);
      } catch {
        /* a broken progress handler must not affect execution */
      }
      emitStep({
        kind: 'success',
        intent,
        summary: stubSummary(intent),
        ...(intent.kind === 'capture'
          ? { captureId: `cap_stub_${args.sessionId}_${results.length + 1}` }
          : {}),
      });
    }
    return Promise.resolve({ results, ok: true });
  }
}

/**
 * The narrow slice of SessionsService the executor dispatches against.
 * Declared as a port (not the whole SessionsService) so the executor stays
 * decoupled + unit-testable with a mock; the real SessionsService satisfies
 * it structurally.
 */
export interface ExecutorSessionsPort {
  navigate(
    ctx: AccountContext,
    sessionId: string,
    body: { url: string },
  ): Promise<{ finalUrl: string; status: number }>;
  interact(
    ctx: AccountContext,
    sessionId: string,
    body: { action: InteractAction },
  ): Promise<{ durationMs: number }>;
  wait(
    ctx: AccountContext,
    sessionId: string,
    body: { condition: WaitCondition },
  ): Promise<{ satisfied: boolean }>;
  capture(
    ctx: AccountContext,
    sessionId: string,
    body: { kind: CaptureKind },
  ): Promise<{ kind: CaptureKind; byteSize: number }>;
}

export interface RealAgentExecutorDeps {
  sessions: ExecutorSessionsPort;
}

/**
 * AI-B2.b increment 1 — real intent executor. Dispatches each plan intent
 * against the in-process SessionsService (the /v1/sessions/:id/{navigate,
 * interact,capture} surface), halting on first failure, never throwing.
 * Replaces StubAgentExecutor's synthetic success.
 *
 * SCOPE: dispatches navigate / interact:tap / interact:type / interact:scroll /
 * wait / capture against the driver, reconciling the AgentIntent vocab onto the
 * driver's shapes (AI-B2.c): wait.condition selector_visible→{kind:selector},
 * idle→{kind:time} (no driver idle predicate — a bounded time wait is the closest
 * honest mapping); scroll (no AgentIntent delta) → one-viewport vertical scroll,
 * direction/magnitude from the optional `value`. Only `interact:swipe` returns a
 * typed failure — it has no driver gesture AND no direction in AgentIntent
 * (genuinely underspecified; resolved in the customer-schema increment).
 *
 * NOT wired into bootstrap — nothing in `lib/` imports this class — pending the
 * real-session-provisioning check (it 400s without a real /v1/sessions session;
 * agent-runtime uses 'unattached' when none). The default driver is `mock`, so
 * once wired, dispatch hits the deterministic mock until the webkit driver lands.
 *
 * V-840 — this said the runtime "still uses StubAgentExecutor", full stop. It
 * does not: bootstrap picks `ControlPlaneAgentExecutor` when
 * `fleetControlPlaneEnabled` is set and the stub only otherwise. V-808 corrected
 * the same staleness in this file's HEADER and left this copy of it on the class,
 * which is the shape V-826 found in the vitest pin: the header gets read, the
 * declaration two hundred lines down does not.
 */
export class RealAgentExecutor implements AgentExecutor {
  constructor(private readonly deps: RealAgentExecutorDeps) {}

  // ⛔ STEP STREAMING: this legacy driver-path executor does NOT call
  // `args.onStep` — it predates step streaming and is not wired in production
  // (bootstrap instantiates only ControlPlaneAgentExecutor or StubAgentExecutor,
  // both of which route every push through an emitStep helper). If this class is
  // ever re-wired, route every `results.push(...)` through an emitStep helper
  // (mirror StubAgentExecutor above) or its live steps will silently never
  // stream while the final result still lands. Kept as bare pushes to avoid
  // churning a dead path.
  async execute(args: ExecuteArgs): Promise<ExecutorRunResult> {
    const account = args.account;
    if (!account) {
      // The real executor requires the caller's AccountContext for
      // ownership-scoped dispatch. Surface as failure(s) rather than
      // throwing (the never-throw contract).
      const results: IntentResult[] = [];
      for (const intent of args.plan.intents) {
        if (!(await executionMayContinue(args.shouldContinue))) {
          return { results, ok: false, authorityLost: true };
        }
        results.push({ kind: 'failure', intent, reason: 'executor missing account context' });
      }
      return { results, ok: results.length === 0 };
    }
    const results: IntentResult[] = [];
    const approved = new Set(args.approvedConsequentialActions ?? []);
    for (const intent of args.plan.intents) {
      // B2 — never dispatch after Stop. (Not wired in production; kept honest so a
      // re-wire does not quietly ignore the customer's Stop.)
      if (args.signal?.aborted === true) return { results, ok: false, stopped: true };
      if (!(await executionMayContinue(args.shouldContinue))) {
        return { results, ok: false, authorityLost: true };
      }
      // W443/W445 — halt BEFORE dispatching an unapproved consequential action
      // so the harness never executes it until the customer confirms.
      const halt = consequentialHalt(intent, approved);
      if (halt) {
        results.push(halt);
        return { results, ok: false, awaitingConfirmation: true };
      }
      const result = await this.dispatch(account, args.sessionId, intent);
      results.push(result);
      if (!(await executionMayContinue(args.shouldContinue))) {
        return { results, ok: false, authorityLost: true };
      }
      if (result.kind === 'failure') return { results, ok: false };
    }
    return { results, ok: true };
  }

  private async dispatch(
    account: AccountContext,
    sessionId: string,
    intent: AgentIntent,
  ): Promise<IntentResult> {
    try {
      switch (intent.kind) {
        case 'navigate': {
          const r = await this.deps.sessions.navigate(account, sessionId, { url: intent.url });
          return {
            kind: 'success',
            intent,
            summary: `navigated → ${r.finalUrl} (status ${r.status})`,
          };
        }
        case 'interact':
          return await this.dispatchInteract(account, sessionId, intent);
        case 'capture': {
          const r = await this.deps.sessions.capture(account, sessionId, { kind: intent.capture });
          return { kind: 'success', intent, summary: `captured ${r.kind} (${r.byteSize} bytes)` };
        }
        case 'wait':
          return await this.dispatchWait(account, sessionId, intent);
        case 'scroll': {
          // Directional viewport scroll → the driver's delta-based scroll
          // (this superseded local-driver path; the harness control-plane
          // executes the persona-shaped flick). amount_px omitted → 600px.
          const delta = (intent.direction === 'up' ? -1 : 1) * (intent.amount_px ?? 600);
          await this.deps.sessions.interact(account, sessionId, {
            action: { kind: 'scroll', delta_x: 0, delta_y: delta },
          });
          return {
            kind: 'success',
            intent,
            summary: `scrolled ${intent.direction}${intent.amount_px !== undefined ? ` ${intent.amount_px}px` : ''}`,
          };
        }
        case 'behavioral_pause':
          // The local driver has no persona-timing; the real persona-shaped
          // pause runs harness-side over the control plane. Acknowledge here.
          return {
            kind: 'success',
            intent,
            summary: 'behavioural pause (executed harness-side; no-op in local-driver executor)',
          };
      }
    } catch (err) {
      return {
        kind: 'failure',
        intent,
        reason:
          err instanceof Error
            ? safeExecutorDiagnostic(err.message, 'dispatch failed')
            : 'dispatch failed',
      };
    }
  }

  private async dispatchInteract(
    account: AccountContext,
    sessionId: string,
    intent: Extract<AgentIntent, { kind: 'interact' }>,
  ): Promise<IntentResult> {
    switch (intent.action) {
      case 'tap': {
        if (intent.selector === undefined) {
          return { kind: 'failure', intent, reason: 'tap requires a selector' };
        }
        await this.deps.sessions.interact(account, sessionId, {
          action: { kind: 'tap', selector: intent.selector },
        });
        return { kind: 'success', intent, summary: `tapped ${intent.selector}` };
      }
      case 'type': {
        if (intent.selector === undefined || intent.value === undefined) {
          return { kind: 'failure', intent, reason: 'type requires a selector and value' };
        }
        await this.deps.sessions.interact(account, sessionId, {
          action: { kind: 'type', selector: intent.selector, text: intent.value },
        });
        return { kind: 'success', intent, summary: `typed into ${intent.selector}` };
      }
      case 'scroll': {
        // AgentIntent scroll carries no delta — map to a one-viewport vertical
        // scroll (down by default; 'up' via value), honoring an optional
        // selector + a non-negative integer `value` as the pixel magnitude.
        const direction = intent.value === 'up' ? -1 : 1;
        const magnitude =
          intent.value !== undefined && /^\d+$/.test(intent.value) ? Number(intent.value) : 600;
        await this.deps.sessions.interact(account, sessionId, {
          action: {
            kind: 'scroll',
            ...(intent.selector !== undefined ? { selector: intent.selector } : {}),
            delta_x: 0,
            delta_y: direction * magnitude,
          },
        });
        return {
          kind: 'success',
          intent,
          summary: `scrolled ${intent.value === 'up' ? 'up' : 'down'}`,
        };
      }
      case 'press': {
        // W540 (A3-W677) — key press. `value` carries the key name (e.g.
        // "Enter", "Escape"); driver InteractAction press caps it at 20 chars.
        if (intent.value === undefined || intent.value.length === 0) {
          return { kind: 'failure', intent, reason: 'press requires a value (the key name)' };
        }
        if (intent.value.length > 20) {
          return { kind: 'failure', intent, reason: 'press key name must be ≤20 characters' };
        }
        await this.deps.sessions.interact(account, sessionId, {
          action: { kind: 'press', key: intent.value },
        });
        return { kind: 'success', intent, summary: `pressed ${intent.value}` };
      }
      case 'swipe':
        // No driver gesture maps to swipe (the driver has scroll, not swipe) and
        // AgentIntent.swipe carries no direction — genuinely underspecified.
        // Resolved in the customer-schema increment (drop or replace with scroll).
        return {
          kind: 'failure',
          intent,
          reason: 'swipe is not supported — use scroll (no driver swipe gesture)',
        };
    }
  }

  private async dispatchWait(
    account: AccountContext,
    sessionId: string,
    intent: Extract<AgentIntent, { kind: 'wait' }>,
  ): Promise<IntentResult> {
    // Reconcile the AgentIntent wait vocab (idle | selector_visible) onto the
    // driver's WaitCondition union. selector_hidden / url_matches aren't
    // reachable from AgentIntent today.
    let condition: WaitCondition;
    if (intent.condition === 'selector_visible') {
      if (intent.selector === undefined) {
        return { kind: 'failure', intent, reason: 'wait selector_visible requires a selector' };
      }
      condition = { kind: 'selector', selector: intent.selector };
    } else {
      // 'idle' has no driver predicate → bounded time wait (clamped to the
      // driver's 0–60_000ms range; defaults to 1s when no timeout given).
      const ms = Math.min(60_000, Math.max(0, intent.timeoutMs ?? 1000));
      condition = { kind: 'time', ms };
    }
    const r = await this.deps.sessions.wait(account, sessionId, { condition });
    return {
      kind: 'success',
      intent,
      summary: `waited (${intent.condition}) → ${r.satisfied ? 'satisfied' : 'timed out'}`,
    };
  }
}

function stubSummary(intent: AgentIntent): string {
  switch (intent.kind) {
    case 'navigate':
      return safeExecutorDiagnostic(
        `stub navigate → ${intent.url} (returns 200; no real fetch)`,
        'stub navigate completed',
      );
    case 'interact':
      // Typed text can be a password, OTP, card value, or other secret. The
      // stub is a production-capable no-fleet fallback and its summary is
      // persisted into the transcript, so never copy the value even when the
      // caller forgot/misclassified `sensitive`. Selector-only matches the real
      // executors' value-blind "typed into <selector>" summaries.
      if (intent.action === 'type') {
        return `stub type${intent.selector ? ' on ' + intent.selector : ''}`;
      }
      return `stub ${intent.action}${intent.selector ? ' on ' + intent.selector : ''}${intent.value !== undefined ? ' with value ' + intent.value : ''}`;
    case 'wait':
      return `stub wait ${intent.condition}${intent.selector ? ' on ' + intent.selector : ''}${intent.timeoutMs !== undefined ? ' (' + intent.timeoutMs + 'ms)' : ''}`;
    case 'capture':
      return `stub captured ${intent.capture}`;
    case 'scroll':
      return `stub scroll ${intent.direction}${intent.amount_px !== undefined ? ' ' + intent.amount_px + 'px' : ''}`;
    case 'behavioral_pause':
      return `stub behavioural pause${intent.reading_word_count !== undefined ? ' (reading ' + intent.reading_word_count + ' words)' : intent.duration_ms !== undefined ? ' (' + intent.duration_ms + 'ms)' : ''}`;
  }
}

/**
 * Neutralize an executor-derived free-text field before it becomes a line in
 * the transcript body that the decomposer replays to the model as history
 * (buildMessages sends `entry.body` verbatim). Two defense-in-depth properties,
 * both behaviour-preserving for legitimate content (summaries/reasons never
 * legitimately contain control characters, and a real URL/selector is well
 * under the cap):
 *  - STRUCTURAL: strip C0/C1 control characters (chiefly CR/LF) so a
 *    page-influenced string — most notably a `navigate` result URL
 *    (agent-intent-result summarize(): `navigated to ${outputData.url}`) or a
 *    harness/webdriver error message that reflects page text — cannot inject a
 *    raw newline and FORGE an extra transcript line (e.g. a fake "(plan
 *    approved)" the next turn would read as its own prior assistant output).
 *    The #139 go-live wired the real ControlPlaneAgentExecutor, so these fields
 *    now carry page-influenced text that was latent under the StubAgentExecutor
 *    (project_agent_runloop_prompt_injection_frame_surfaced). The SYSTEM_PROMPT
 *    already frames history observations as UNTRUSTED and the consequential-gate
 *    still bounds blast radius; this closes the structural line-forging channel
 *    the prose-level framing doesn't cover. The full fix — a distinct
 *    `observation` transcript role so buildMessages delimits these as untrusted
 *    DATA rather than assistant output — is a coordinated, prompt-eval-gated
 *    change; this is the safe interim.
 *  - BLOAT: cap length so a pathological multi-KB URL can't balloon the
 *    transcript / token spend. Mirrors the 200-char cap already applied to the
 *    failure reason in agent-intent-result.ts.
 */
export const MAX_TRANSCRIPT_FIELD_LEN = 512;
export function sanitizeTranscriptText(s: string): string {
  // Results from every executor implementation meet here before durable
  // history. Keep this credential scrub even though the live result mapper and
  // legacy executor sanitize at their customer-response boundaries: future
  // executors and synthetic test/demo paths must not be able to bypass it.
  const redacted = redactText(
    sliceWithoutSplittingSurrogate(s, EXECUTOR_DIAGNOSTIC_INPUT_MAX_LENGTH),
  );
  // eslint-disable-next-line no-control-regex
  const stripped = redacted.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim();
  return stripped.length > MAX_TRANSCRIPT_FIELD_LEN
    ? `${sliceWithoutSplittingSurrogate(stripped, MAX_TRANSCRIPT_FIELD_LEN)}…`
    : stripped;
}

/**
 * Helper for the dashboard chat-UI: render an ExecutorRunResult as a
 * TranscriptEntry the agent's next turn can read. Keeps the
 * serialization rule in one place — every consumer that wants to
 * append executor results to a transcript must use this so the
 * decomposer sees consistent output formatting in `history`.
 */
export function runResultToTranscriptEntry(
  runResult: ExecutorRunResult,
  at: string,
): TranscriptEntry {
  const lines: string[] = [];
  for (const r of runResult.results) {
    // `r.intent.kind` / `r.category` are fixed enums (safe); the free-text
    // fields (summary — carries the navigate result URL; reason — carries the
    // harness/webdriver message; matchedText — the matched consequential phrase)
    // are page-influenced now that the real executor is live, so neutralize them
    // before they join the transcript body the model replays as history.
    if (r.kind === 'success') {
      lines.push(`✓ ${sanitizeTranscriptText(r.summary)}`);
    } else if (r.kind === 'confirmation_required') {
      lines.push(
        `⏸ ${r.intent.kind} — confirmation required (${r.category}: "${sanitizeTranscriptText(r.matchedText)}")`,
      );
    } else {
      lines.push(`✗ ${r.intent.kind} — ${sanitizeTranscriptText(r.reason)}`);
    }
  }
  if (runResult.stopped === true) {
    // B2 — FIRST, because a stop can leave a ✗ row behind (a step Stop cut short)
    // and "(plan halted on failure)" would tell the next turn's planner a step
    // FAILED when the customer asked it to stop. The next planner reads this line
    // as history: the task is unfinished, and nothing past these steps ran.
    lines.push(
      '(stopped by the customer — nothing after the steps above was sent to the page; the task is NOT finished)',
    );
  } else if (runResult.awaitingConfirmation) {
    lines.push('(plan paused — awaiting your confirmation of a consequential action)');
  } else if (runResult.recoveredAfterReplan === true && runResult.ok) {
    // P1 — a failure row is present and the turn still finished, because the
    // agent looked at the page and planned the rest. Saying "halted" here would
    // contradict the ✓ lines directly above it AND tell the next turn's model
    // that the previous turn stopped, which is exactly the history that makes it
    // plan defensively.
    lines.push('(a step failed — read the page, worked out the rest, and carried on)');
  } else if (runResult.results.some((r) => r.kind === 'failure' && r.intent.kind !== 'wait')) {
    // #139 — a best-effort `wait` failure no longer halts the plan (later steps
    // still run), so `!ok` alone no longer implies a halt. Only a NON-wait failure
    // actually breaks the run; a wait-only failure means the plan ran to completion
    // (its own ✗ line above already records the wait fault). Claiming "halted" when
    // a later step succeeded would contradict the transcript + mislead the next turn.
    lines.push('(plan halted on failure)');
  }
  return {
    at,
    role: 'agent',
    body: lines.join('\n'),
    ...(runResult.awaitingConfirmation === true ? { awaitingConfirmation: true } : {}),
  };
}
