// The composer: the box the customer describes a task in, and the one line
// under it that says why Send is or is not available.
//
// Stage 5 of the AI-view rebuild (spec §3.7). Stage 0 lifted this out of
// AgentChatView.tsx byte-identical; here it becomes an inset CONSOLE — a recess
// in the surface with an accent `›` prompt, its caption and its button inside
// the same box rather than loose under it. What did NOT change is everything a
// test or a customer's muscle memory holds on to: `aria-label="Message
// Driftstack AI"`, the placeholder's example prompt (still matching /Describe a
// task in plain English/i — only its duplicated keyboard tail went, see
// `EMPTY_CHAT_PROMPT`), `rows={COMPOSER_ROWS}`, `max-h-[420px]`, Enter sends and
// Shift+Enter inserts a newline, the Send / Stop / Stopping… names and their
// order after the textarea, and the caption's pinned text node "Enter to send ·
// Shift+Enter for a new line" (ONE text node — a `<kbd>` split would break
// `getByText`, which reads own text nodes).
//
// ⛔ THE REST HEIGHT IS STYLE, NOT `rows`. Coordinator's §12 D1: the composer
// rests at THREE rows once a chat has turns, FIVE in an empty chat, opens to
// FIVE on focus, and rests at FOUR in a short window (D6) so all four templates
// stay above the fold at the 600px-tall minimum. `rows={COMPOSER_ROWS}` stays 5
// for every one of them: `rows` is the fallback height a browser uses when CSS
// says nothing, and a test that reads it is reading the attribute, not the box.
// The heights are `min-height` on `[data-rest]`, so no JS runs per keystroke to
// maintain them and no layout property is animated.
//
// ⛔ AND THAT IS WHY AUTOGROW MEASURES FROM `0px`, NOT `auto`. `height: auto`
// on a textarea resolves to its `rows` height — five rows — so the first
// keystroke in a three-row composer would measure 5 rows of `scrollHeight` and
// snap the box open. From `0px` the measurement is the CONTENT, and the CSS
// `min-height` puts the floor back underneath the assignment.
//
// ⛔ The composer-sizing pin now reads THIS file
// (apps/gui-client/tests/unit/the-ai-composer-is-sized-for-the-prompts-it-invites.test.ts):
// `COMPOSER_ROWS`, `rows={COMPOSER_ROWS}`, `max-h-[420px]`, and BOTH autogrow
// sites going through `COMPOSER_MAX_HEIGHT_PX`. The second site is
// `growComposerToFit` below — the view calls it when a template fills the box.
// That is the whole point of the pin: the two sites must not drift apart again.

import { useEffect, type RefObject } from 'react';
import { CONNECT_API_KEY_IN_SETTINGS } from '../../lib/proxy-check-copy';
import { type UseAgentChatResult } from '../../lib/use-agent-chat';
import { IconEnter, IconStop } from './icons';
import {
  REATTACHING_NOTICE,
  SEND_HELD_SUFFIX,
  STILL_FINISHING_NOTICE,
  STOPPING_NOTICE,
  STOP_AGAIN_LABEL,
} from './notices';

/**
 * Composer autogrow ceiling.
 *
 * Owner 2026-08-31: "the text bar should be larger". The composer opened at 3
 * rows and capped at 288px, which is cramped for the thing it actually asks for
 * — its own placeholder is a two-clause task description, and the task the owner
 * typed ("go to X, create an account with this email, tell me when a code is
 * needed") does not fit in three rows. A prompt box smaller than the prompts it
 * invites reads as a search field.
 *
 * Named because TWO sites grow this textarea — onChange and the restore-focus
 * path — and they were separate literals that could drift apart silently.
 */
export const COMPOSER_MAX_HEIGHT_PX = 420;

/**
 * ⛔ THE CSS CAP MUST MATCH `COMPOSER_MAX_HEIGHT_PX`, and it did not.
 *
 * The textarea carried `max-h-72` — Tailwind for **288px**, the exact value
 * V-2183 believed it had raised. The inline `style.height` could be set to
 * 420px and `max-height: 18rem` still won, so the composer kept stopping at the
 * old height and the fix was invisible to the customer who reported it.
 *
 * Two caps that must agree, expressed in two languages, neither aware of the
 * other — the same drift the shared constant was introduced to prevent, one
 * layer down. Now `max-h-[420px]`, and pinned to this constant by a guard.
 */

/** Rows shown before any typing. */
export const COMPOSER_ROWS = 5;

/** The element the disabled Send points at with `aria-describedby` when this
 *  profile's proxy is why it is disabled. A constant rather than a `useId` so
 *  the reference is the same string in the button and in the paragraph, and so
 *  a test can read it. Only ONE composer renders at a time. */
const PROXY_REASON_ID = 'ai-composer-send-blocked';

/**
 * The Stop sentence (spec §3.7).
 *
 * ⛔ VERIFIED AGAINST THE SERVER, not assumed — the spec required it, and the
 * fallback wording existed for the case where it was wrong. The executor checks
 * `signal.aborted` at the TOP of each step in the plan loop
 * (apps/server/src/services/agent-executor.ts: "nothing is started once Stop has
 * been observed"), so a step already dispatched finishes and the NEXT one never
 * starts; the accumulated results come back as the stopped turn's receipt, which
 * the transcript keeps. Both clauses are exact.
 */
const STOP_SENTENCE =
  'Stop ends the task after the current step. What already ran stays in the chat.';

/**
 * The first screen's prompt.
 *
 * ⛔ THE KEYBOARD HINT IS NOT IN HERE TWICE (review repair, stage 5). Today's
 * string ended `…screenshot the result.”  ⏎ to send · ⇧⏎ for a new line`, and it
 * was written when the foot had no caption of its own. The foot now says `Enter
 * to send · Shift+Enter for a new line` thirty pixels below it, in words, so the
 * console gave the same instruction twice in two notations — plainly visible in
 * every idle and no-key frame at every window size.
 *
 * §3.7's prose says "empty chat = today's string verbatim"; the MOCKUP, which is
 * the decided design and the stage's visual target, ends this placeholder at
 * `result.”` and leaves the hint to the foot alone (`final/idle-dark.png`,
 * `final/idle-light.png`). The example prompt — the part that sentence was
 * protecting — is byte-identical. The pin six test files hold is
 * `/Describe a task in plain English/i`, which is untouched; nothing asserted
 * the tail. Restoring it is one edit here if the coordinator disagrees.
 */
const EMPTY_CHAT_PROMPT =
  'Describe a task in plain English — e.g. “Go to example.com, accept the cookie banner, then search for ‘pricing’ and screenshot the result.”';

/** Once there is a transcript above it, the box is for the next thing — and the
 *  first screen's long example would be repeating a lesson already learned. */
const FOLLOW_UP_PROMPT = 'Ask a follow-up, or describe a task in plain English…';

/** Grow the composer to fit what is in it, up to the shared ceiling.
 *
 *  The SECOND autogrow site. #20 — filling the composer from a template hands
 *  off to it: focus, caret at the end, and grow to fit, so the customer can
 *  immediately edit + send instead of staring at a cramped box. It lives here,
 *  beside the onChange path, because the two used to be independent pixel
 *  literals and the box grew to a different size depending on how the customer
 *  got there.
 *
 *  Measured from `0px` rather than `auto` — see the header note. */
export function growComposerToFit(el: HTMLTextAreaElement): void {
  el.style.height = '0px';
  el.style.height = `${Math.min(el.scrollHeight, COMPOSER_MAX_HEIGHT_PX)}px`;
}

/** What the view knows about this profile's egress proxy, as the composer reads
 *  it: only 'pending' and 'blocked' change what Send does and what it says. */
export type ComposerProxyState =
  | { kind: 'none' | 'ready' }
  | { kind: 'pending' }
  | { kind: 'blocked'; reason: string };

/** How tall the box rests. `watch` is "the customer is watching, not writing";
 *  `idle` is an empty chat, where the composer IS the page; `chat` is a
 *  conversation, where the transcript above it matters more. */
export type ComposerRest = 'idle' | 'watch' | 'chat';

/**
 * Which caption the foot is showing — ONE ordered decision, made once.
 *
 * ⛔ IT IS A VALUE, NOT A CHAIN OF TERNARIES IN THE JSX, because two things read
 * it: the paragraph, and the disabled Send's `aria-describedby`. When those were
 * separate conditions the id could point at a branch the chain had skipped, and
 * a screen reader would be told to read an element that is not there. Now the
 * caption decides, and the button asks it.
 *
 * The first four arms are today's precedence, unchanged; the new ones sit where
 * they cannot displace a notice that is more urgent than they are.
 */
export type ComposerCaption =
  | { kind: 'stopping' }
  | { kind: 'still-finishing' }
  | { kind: 'adopting' }
  | { kind: 'not-connected' }
  | { kind: 'stop-sentence' }
  | { kind: 'proxy-blocked'; reason: string }
  | { kind: 'proxy-pending' }
  | { kind: 'approval' }
  | { kind: 'enter-to-send' };

export function composerCaption(s: {
  sending: boolean;
  stopping: boolean;
  stoppedTurnStillRunning: boolean;
  adopting: boolean;
  aiReady: boolean;
  confirmationPending: boolean;
  proxy: ComposerProxyState;
}): ComposerCaption {
  if (s.sending && s.stopping) return { kind: 'stopping' };
  if (s.stoppedTurnStillRunning) return { kind: 'still-finishing' };
  if (s.aiReady && s.adopting) return { kind: 'adopting' };
  if (!s.aiReady) return { kind: 'not-connected' };
  // A run in flight: say what Stop does, next to the Stop button.
  if (s.sending) return { kind: 'stop-sentence' };
  // ⛔ A BLOCKER OUTRANKS AN INVITATION (review repair, stage 5). These two sit
  // ABOVE `approval`, next to `not-connected`, because all three describe a Send
  // button that is DISABLED — `proxyState.kind === 'blocked' | 'pending'` is in
  // the button's own disabled list. "Or send a new instruction instead of
  // approving." under a Send that refuses is the composer inviting the customer
  // to do something the product will not let them do, with the reason available
  // only in a hover title. One decision, read twice: the caption the eye reads
  // is the same one the disabled Send points `aria-describedby` at.
  if (s.proxy.kind === 'blocked') return { kind: 'proxy-blocked', reason: s.proxy.reason };
  if (s.proxy.kind === 'pending') return { kind: 'proxy-pending' };
  // Halted on a consequential step, with nothing in the way. The composer is NOT
  // disabled here — sending a new instruction instead of approving is a real
  // path, and this is the only place that says so.
  if (s.confirmationPending) return { kind: 'approval' };
  return { kind: 'enter-to-send' };
}

/** Which rest height applies (spec §3.7, coordinator's §12 D1). */
export function composerRest(s: {
  sending: boolean;
  confirmationPending: boolean;
  hasTurns: boolean;
  draftEmpty: boolean;
}): ComposerRest {
  if ((s.sending || s.confirmationPending) && s.draftEmpty) return 'watch';
  return s.hasTurns ? 'chat' : 'idle';
}

export function Composer({
  chat,
  draft,
  onDraftChange,
  onSubmit,
  composerRef,
  aiReady,
  proxyState,
  sendHeldByAdopt,
  short,
  onRetryAdopt,
  onGoToSettings,
}: {
  chat: UseAgentChatResult;
  draft: string;
  onDraftChange: (text: string) => void;
  onSubmit: () => void;
  composerRef: RefObject<HTMLTextAreaElement>;
  aiReady: boolean;
  proxyState: ComposerProxyState;
  sendHeldByAdopt: boolean;
  /** D6 — the view is ≤ 620px tall, so the empty composer gives a row back to
   *  the templates. Measured, never guessed: see `use-view-width.ts` (stage 4
   *  merged `use-short-view.ts` into it, so all five tiers come off one
   *  observer reading one box). */
  short?: boolean;
  onRetryAdopt: () => void;
  onGoToSettings?: () => void;
}): JSX.Element {
  const confirmationPending = chat.pendingConfirmation !== null;
  const caption = composerCaption({
    sending: chat.sending,
    stopping: chat.stopping === true,
    stoppedTurnStillRunning: chat.stoppedTurnStillRunning,
    adopting: chat.adopting,
    aiReady,
    confirmationPending,
    proxy: proxyState,
  });
  const rest = composerRest({
    sending: chat.sending,
    confirmationPending,
    hasTurns: chat.turns.length > 0,
    draftEmpty: draft.trim().length === 0,
  });
  const describesSend = caption.kind === 'proxy-blocked' || caption.kind === 'proxy-pending';

  // ⛔ AN EMPTY BOX ALWAYS RESTS AT ITS REST HEIGHT. The autogrow writes an
  // inline `style.height`, and the draft is cleared PROGRAMMATICALLY — by Send,
  // by Discard draft, by switching chats — which fires no `onChange`, so without
  // this the box kept the height of the message it just sent and "rests at three
  // rows once a chat has turns" would have been true only until the first send.
  // Clearing the inline height hands the decision back to `[data-rest]`.
  useEffect(() => {
    const el = composerRef.current;
    if (el !== null && draft === '') el.style.height = '';
  }, [draft, composerRef]);
  // ⛔ Rendered only when TRUE. `data-short={false}` renders as the string
  // 'false', which a valueless `[data-short]` selector still matches.
  const shortAttr = short === true ? '' : undefined;

  return (
    <div className="ai-cmd" data-rest={rest} data-short={shortAttr}>
      <div className="ai-cmd-box">
        <span className="ai-cmd-caret mono" aria-hidden="true">
          ›
        </span>
        <textarea
          ref={composerRef}
          aria-label="Message Driftstack AI"
          rows={COMPOSER_ROWS}
          value={draft}
          placeholder={chat.turns.length === 0 ? EMPTY_CHAT_PROMPT : FOLLOW_UP_PROMPT}
          onChange={(e) => {
            onDraftChange(e.target.value);
            // #139 — LLM-composer feel: grow with the content up to a cap.
            e.target.style.height = '0px';
            e.target.style.height = `${Math.min(e.target.scrollHeight, COMPOSER_MAX_HEIGHT_PX)}px`;
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              onSubmit();
            }
          }}
          className="ai-cmd-input max-h-[420px]"
        />
        <div className="ai-cmd-foot">
          {/* ⛔ THE REASON A SEND IS BLOCKED IS NOT A HOVER TITLE. A profile whose
              proxy can no longer be resolved disables Send, and until stage 2 the
              only place that said so was the disabled button's `title` — invisible
              to a touch device, to a keyboard user and to anyone who does not think
              to hover a control that looks broken. It is a plain paragraph, not a
              `role="status"`: the idle no-key state must contain exactly one live
              region and that one is the API-key gate. */}
          <p
            {...(describesSend ? { id: PROXY_REASON_ID } : {})}
            className={
              caption.kind === 'proxy-blocked' ? 'ai-cmd-cap ai-cmd-cap-bad' : 'ai-cmd-cap'
            }
          >
            {caption.kind === 'stopping' ? (
              <span role="status" data-component="chat-stopping-notice">
                {STOPPING_NOTICE}
              </span>
            ) : caption.kind === 'still-finishing' ? (
              // P6 — said in the composer, not only in a hover title. The customer
              // who pressed Stop is looking right here when they decide whether to
              // type the next thing.
              <span
                role="status"
                data-component="chat-still-finishing-notice"
                className="flex flex-wrap items-center gap-2"
              >
                <span>{STILL_FINISHING_NOTICE}</span>
                {/* B2 — a Stop that could not be confirmed is not the last chance
                    to stop the agent: the customer can ask again from here. */}
                {chat.stopAgain !== undefined && (
                  <button
                    type="button"
                    onClick={chat.stopAgain}
                    disabled={chat.stopping === true}
                    data-component="chat-stop-again"
                    className="btn-secondary px-2 py-0.5 text-2xs disabled:opacity-50"
                  >
                    {chat.stopping === true ? STOPPING_NOTICE : STOP_AGAIN_LABEL}
                  </button>
                )}
              </span>
            ) : caption.kind === 'adopting' ? (
              // (l) #8 / #12 — the held send says why, here, not only in a hover
              // title; a reattach that could not be answered offers the retry
              // (adopt() again on the same session) instead of a dead end.
              <span
                role="status"
                data-component="chat-adopt-notice"
                data-held={sendHeldByAdopt ? 'true' : 'false'}
                className="flex flex-wrap items-center gap-2"
              >
                <span>
                  {chat.adoptError ?? REATTACHING_NOTICE}
                  {sendHeldByAdopt && ` ${SEND_HELD_SUFFIX}`}
                </span>
                {chat.adoptError !== null && (
                  <button
                    type="button"
                    onClick={onRetryAdopt}
                    className="btn-secondary px-2 py-0.5 text-2xs"
                  >
                    Try again
                  </button>
                )}
              </span>
            ) : caption.kind === 'not-connected' ? (
              <span className="flex flex-wrap items-center gap-2">
                <span>Not connected — add your API key in Settings to run automations.</span>
                {onGoToSettings !== undefined && (
                  <button
                    type="button"
                    onClick={onGoToSettings}
                    className="btn-secondary px-2 py-0.5 text-2xs"
                  >
                    Open Settings
                  </button>
                )}
              </span>
            ) : caption.kind === 'stop-sentence' ? (
              STOP_SENTENCE
            ) : caption.kind === 'approval' ? (
              'Or send a new instruction instead of approving.'
            ) : caption.kind === 'proxy-blocked' ? (
              caption.reason
            ) : caption.kind === 'proxy-pending' ? (
              'Checking this profile’s proxy…'
            ) : (
              'Enter to send · Shift+Enter for a new line'
            )}
          </p>
          {/* ⛔ THE BUTTON IS KEYED ON `sending` AND NOTHING ELSE — the same
              condition as before this stage, deliberately.

              Spec §3.7 says "never Stop while a confirmation is pending", and I
              wrote that as `sending && !confirmationPending` before finding the
              state that makes it wrong. "Or send a new instruction instead of
              approving" is a DESIGNED path: the composer stays usable while the
              gate is up, and during that send the halted turn is still the last
              AGENT turn, so `pendingConfirmation` is still set. `sending` is
              true and a real turn is running. Suppressing Stop there takes away
              the only way to stop it.

              The spec's sentence is still true where it was aimed: while the
              turn is HALTED, `chat.sending` is false and this renders Send. */}
          {chat.sending ? (
            <button
              type="button"
              onClick={() => {
                // B2 — Stop reaches the server: the task stops, the steps that
                // ran stay in the chat, and the composer returns when the
                // server says the turn is over. No toast — the button and the
                // caption below say "Stopping…" where the customer is looking.
                chat.cancel();
              }}
              // Pressing it again changes nothing, so it does not pretend it could.
              disabled={chat.stopping === true}
              title={chat.stopping === true ? STOPPING_NOTICE : 'Stop this task'}
              className="ai-btn-stop disabled:opacity-50"
            >
              <IconStop />
              {chat.stopping === true ? STOPPING_NOTICE : 'Stop'}
            </button>
          ) : (
            <button
              type="button"
              onClick={onSubmit}
              disabled={
                draft.trim().length === 0 ||
                !aiReady ||
                chat.adopting ||
                // P6 — the stopped turn is still running, so this send would be
                // refused. Holding the button is the honest state; offering it
                // and failing is what produced the 409s.
                chat.stoppedTurnStillRunning ||
                proxyState.kind === 'pending' ||
                proxyState.kind === 'blocked'
              }
              title={
                !aiReady
                  ? `${CONNECT_API_KEY_IN_SETTINGS} first`
                  : chat.adopting
                    ? (chat.adoptError ?? REATTACHING_NOTICE)
                    : chat.stoppedTurnStillRunning
                      ? STILL_FINISHING_NOTICE
                      : proxyState.kind === 'pending'
                        ? 'Checking this profile’s proxy…'
                        : proxyState.kind === 'blocked'
                          ? proxyState.reason
                          : undefined
              }
              aria-describedby={describesSend ? PROXY_REASON_ID : undefined}
              className="btn-primary ai-btn-send disabled:opacity-50"
            >
              Send
              <IconEnter />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
