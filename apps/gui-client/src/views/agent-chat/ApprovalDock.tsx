// The consequential-action gate: the AI has stopped, and nothing moves until
// the customer decides.
//
// Stage 5 of the AI-view rebuild (spec §3.6). Stage 0 lifted this out of
// AgentChatView.tsx byte-identical; here it becomes the thing the whole view is
// built around — the ONE moment a customer is asked to trust an automation with
// their money. Three properties survived the rewrite unchanged because they are
// the safety contract, not the styling:
//
//   · `role="alert"`. A screen-reader user sitting in the composer must HEAR
//     that a purchase is waiting (audit 2026-07-09), or they cannot approve or
//     deny something they never knew about.
//   · `Deny` and `Approve`, under exactly those names, in that order.
//   · Approve/Deny still do what the hook does. Nothing here changes approval
//     semantics: the halted turn has SETTLED (`chat.sending` is false), the
//     composer stays mounted and usable beneath this card, and Approve re-sends
//     as a NEW turn carrying the accumulated approvals.
//
// WHAT THE REWRITE ADDS, and why each piece is a sentence rather than a label:
//
//   · A category-specific VOICE line ("The AI wants to make a purchase."). The
//     old line read "The agent wants to perform a purchase: “Place order ·
//     $104.00”" — one sentence carrying the category, the matched text and the
//     quoting, at 12px, beside the buttons that spend the money.
//   · The matched text as a REPLICA of the control on the phone, so the eye can
//     match it to the button in the live view above.
//   · A CALM line. The question a customer actually has at this moment is "has
//     it already happened?", and the honest answer — nothing has been bought,
//     the page has not moved — is the difference between a considered decision
//     and a panicked Deny.
//   · The buttons each get ONE line saying what they do, because "Deny" alone
//     does not say whether the task resumes afterwards. It does not.
//
// ⛔ THE CLOCK IS `aria-hidden`. `role="alert"` is an assertive live region with
// implicit `aria-atomic="true"`: a text node that rewrites itself once a second
// inside it would re-announce this entire card every second. It is hidden from
// the accessibility tree and kept in its own leaf component, so a tick rewrites
// one hidden text node and nothing else. (Stage 3 learned this on the live
// turn's elapsed clock; the rule is the same one.)

import { useEffect, useRef, useState, type RefObject } from 'react';
import type { AgentIntent } from '@driftstack/sdk';
import type { ChatTurn } from '../../lib/use-agent-chat';
import { elapsedSince } from './durations';
import { IconShield } from './icons';

/** How often the "paused m:ss" readout is rewritten. One text node, hidden from
 *  assistive technology, inside a leaf that re-renders nothing else. */
const PAUSED_TICK_MS = 1000;

/**
 * The sentence at the top of the card, by category.
 *
 * ⛔ IT NAMES THE CONSEQUENCE, NOT THE MECHANISM. "The AI wants to make a
 * purchase." is a thing a customer can decide about; "confirmation_required on
 * category purchase" is a thing the server said. An unknown category — one this
 * build has never heard of, sent by a newer server — must still produce a
 * sentence, so the fallback carries the raw category as the OBJECT of a
 * readable clause rather than pasting it in as if it were English.
 */
export function approvalVoice(category: string): string {
  switch (category) {
    case 'purchase':
      return 'The AI wants to make a purchase.';
    case 'payment':
      return 'The AI wants to make a payment.';
    case 'account_deletion':
      return 'The AI wants to delete an account.';
    default:
      return `The AI wants to do something that needs your OK: ${categoryLabel(category)}.`;
  }
}

/**
 * The bold half of the calm line — what has NOT happened yet.
 *
 * Every arm is in the perfect tense and negative, because that is the fact the
 * customer is looking for. An unknown category cannot claim "nothing has been
 * bought" (it may not be a purchase at all), so it falls to the weakest true
 * statement there is.
 */
export function approvalCalm(category: string): string {
  switch (category) {
    case 'purchase':
      return 'Nothing has been bought.';
    case 'payment':
      return 'Nothing has been paid.';
    case 'account_deletion':
      return 'Nothing has been deleted.';
    default:
      return 'Nothing has happened yet.';
  }
}

/**
 * The step the gate is holding, for the turn that halted — or undefined when
 * this build cannot find it.
 *
 * Used for ONE word: whether the next step "taps" something (so the replica
 * below reads as a button on the page) or is described neutrally. Everything
 * else about the step stays out of the dock: the SELECTOR never appears here,
 * and neither does the intent's raw kind.
 */
export function gatedIntent(
  turns: ReadonlyArray<ChatTurn>,
  turnId: number,
): AgentIntent | undefined {
  for (const turn of turns) {
    if (turn.id !== turnId || turn.role !== 'agent') continue;
    const response = turn.response;
    if (response === undefined || response.kind !== 'plan-executed') return undefined;
    for (const result of response.results) {
      if (result.kind === 'confirmation_required') return result.intent;
    }
    return undefined;
  }
  return undefined;
}

/** Whether the held step presses something on the page — the only thing the
 *  dock says about HOW the step acts, and only because "Its next step taps
 *  <button>" is what makes the replica legible as a control. */
export function gatedStepTaps(turns: ReadonlyArray<ChatTurn>, turnId: number): boolean {
  const intent = gatedIntent(turns, turnId);
  if (intent === undefined || intent.kind !== 'interact') return false;
  return intent.action === 'tap' || intent.action === 'press';
}

/**
 * The site the phone is sitting on: the host of the last navigation anywhere in
 * this chat — undefined when nothing this build can parse was ever navigated
 * to.
 *
 * ⛔ UNDEFINED MEANS THE WHOLE CLAUSE IS DROPPED, never guessed. "on
 * shop.example.com" beside a purchase is a claim about where the customer's
 * money is going; a wrong one is worse than none. It scans BACKWARDS across
 * turns because a chat can navigate in one turn and check out in the next.
 *
 * ⛔ AND ONLY A NAVIGATION THAT SUCCEEDED COUNTS (review repair, stage 5). An
 * `IntentResult` has three kinds, and two of them describe a page the phone is
 * NOT on: a `failure` is a navigation that did not arrive (the browser is still
 * on the page before it), and a `confirmation_required` is one that was never
 * dispatched at all. A turn genuinely continues past a failure — the server
 * re-plans after a replannable one — so "the last navigate intent in the
 * transcript" and "where the phone is" come apart exactly when a step went
 * wrong, which is the moment this clause is read next to an Approve button.
 */
export function confirmationHost(turns: ReadonlyArray<ChatTurn>): string | undefined {
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const turn = turns[i];
    const response = turn?.response;
    if (response === undefined || response.kind !== 'plan-executed') continue;
    for (let j = response.results.length - 1; j >= 0; j -= 1) {
      const result = response.results[j];
      if (result === undefined || result.kind !== 'success') continue;
      if (result.intent.kind !== 'navigate') continue;
      try {
        const host = new URL(result.intent.url).hostname;
        if (host !== '') return host;
      } catch {
        // An unparseable URL yields nothing rather than the raw string.
      }
    }
  }
  return undefined;
}

/** How long the customer has been asked to wait. Its own component so a tick
 *  re-renders ONE hidden text node — see the header note on `role="alert"`. */
function PausedClock({ since }: { since: number }): JSX.Element | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => {
      setNow(Date.now());
    }, PAUSED_TICK_MS);
    return () => {
      clearInterval(id);
    };
  }, []);
  const text = elapsedSince(since, now);
  return text === null ? null : (
    <span className="ai-dock-wait mono" aria-hidden="true">
      paused <b>{text}</b>
    </span>
  );
}

export function ApprovalDock({
  category,
  matchedText,
  taps,
  host,
  sessionActive,
  sending,
  composerRef,
  onDeny,
  onApprove,
}: {
  category: string;
  matchedText: string;
  /** The held step presses something — `gatedStepTaps` above. */
  taps: boolean;
  /** `confirmationHost` above; the whole "on <host>" clause is dropped when
   *  undefined. */
  host?: string;
  /** False once the session is gone: the phone is no longer sitting on the
   *  page, so the second half of the calm line would be a lie. */
  sessionActive: boolean;
  sending: boolean;
  /** Read, never focused, by the focus rule below. */
  composerRef?: RefObject<HTMLTextAreaElement>;
  onDeny: () => void;
  onApprove: () => void;
}): JSX.Element {
  const dockRef = useRef<HTMLDivElement>(null);
  // The gate appeared NOW: this component mounts exactly when
  // `pendingConfirmation` becomes non-null and unmounts when it clears, so its
  // own mount is the moment to count from and no hook field is needed.
  const [pausedSince] = useState(() => Date.now());

  // ⛔ THE FOCUS RULE (spec §3.6). Focus moves to the CARD, never to Approve —
  // a gate that lands the caret on the button that spends the money is a gate
  // that can be dismissed by a keystroke already in flight. And it only moves
  // at all from two places: nowhere (`<body>`, which is where focus sits after
  // a Send), and an EMPTY composer. A customer part-way through typing keeps
  // their caret and their draft; the `role="alert"` above has already told a
  // screen-reader user that this card is here.
  useEffect(() => {
    const dock = dockRef.current;
    if (dock === null) return;
    const active = document.activeElement;
    const composer = composerRef?.current ?? null;
    const idle = active === null || active === document.body;
    const inEmptyComposer = active === composer && composer !== null && composer.value === '';
    if (idle || inEmptyComposer) dock.focus();
  }, [composerRef]);

  return (
    // a11y: announce the "confirm before continuing" gate — a screen-reader user
    // on the composer must hear that the agent is waiting to run a consequential
    // action (audit 2026-07-09), or they can't approve/deny something they never
    // knew about.
    <div
      ref={dockRef}
      role="alert"
      tabIndex={-1}
      data-component="ai-approval-dock"
      className="ai-dock ai-dock-in"
    >
      {/* Motion #16 — the halo flashes exactly twice and then rests for good.
          It is `display: none` under reduced motion (a halo frozen mid-flash is
          the wrong still), so NOTHING may be gated on its animationend. */}
      <span className="ai-halo" aria-hidden="true" />
      <div className="ai-dock-h">
        <span className="ai-dock-ico" aria-hidden="true">
          <IconShield />
        </span>
        <span className="section-label ai-dock-label">Confirm before continuing</span>
        <PausedClock since={pausedSince} />
      </div>
      <p className="ai-voice ai-voice-lg ai-dock-say">{approvalVoice(category)}</p>
      <p className="ai-dock-next">
        <span>{taps ? 'Its next step taps' : 'Its next step:'}</span>
        {/* A replica of the control on the phone: it LOOKS like the button the
            step is about to press, so the eye can find it in the live view. It
            is not a control — `cursor: default`, no handler — and it carries a
            `title` because it is allowed to ellipsis. */}
        <span className="ai-replica" title={matchedText}>
          {matchedText}
        </span>
        {host !== undefined && (
          <span className="ai-dock-site">
            on <span className="mono">{host}</span>
          </span>
        )}
      </p>
      <p className="ai-dock-calm">
        <b>{approvalCalm(category)}</b>
        {sessionActive && ' The iPhone stays on this page until you decide.'}
      </p>
      <div className="ai-dock-a">
        <span className="ai-dock-hint">
          Approve runs this one step and carries on. Deny stops the task here.
        </span>
        <button
          type="button"
          onClick={onDeny}
          disabled={sending}
          className="btn-secondary ai-dock-btn disabled:opacity-50"
        >
          Deny
        </button>
        <button
          type="button"
          onClick={onApprove}
          disabled={sending}
          className="btn-primary ai-dock-btn disabled:opacity-50"
        >
          Approve
        </button>
      </div>
    </div>
  );
}

export function categoryLabel(category: string): string {
  switch (category) {
    case 'purchase':
      return 'purchase';
    case 'payment':
      return 'payment';
    case 'account_deletion':
      return 'account deletion';
    default:
      return category;
  }
}
