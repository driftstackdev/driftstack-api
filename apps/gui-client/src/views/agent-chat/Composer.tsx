// The composer: the box the customer describes a task in, and the one line
// under it that says why Send is or is not available.
//
// Stage 0 of the AI-view rebuild (spec §9): lifted out of AgentChatView.tsx with
// the DOM byte-identical — the same `aria-label="Message Driftstack AI"`, the
// same placeholder, the same `rows={COMPOSER_ROWS}` and `max-h-[420px]`, the
// same Send / Stop / Stopping… names and positions, and the caption's pinned
// text node "Enter to send · Shift+Enter for a new line" (ONE text node — a
// `<kbd>` split would break `getByText`, which reads own text nodes).
//
// ⛔ The composer-sizing pin now reads THIS file
// (apps/gui-client/tests/unit/the-ai-composer-is-sized-for-the-prompts-it-invites.test.ts):
// `COMPOSER_ROWS`, `rows={COMPOSER_ROWS}`, `max-h-[420px]`, and BOTH autogrow
// sites going through `COMPOSER_MAX_HEIGHT_PX`. The second site is
// `growComposerToFit` below — the view calls it when a template fills the box.
// That is the whole point of the pin: the two sites must not drift apart again.

import type { RefObject } from 'react';
import { CONNECT_API_KEY_IN_SETTINGS } from '../../lib/proxy-check-copy';
import { type UseAgentChatResult } from '../../lib/use-agent-chat';
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

/** Grow the composer to fit what is in it, up to the shared ceiling.
 *
 *  The SECOND autogrow site. #20 — filling the composer from a template hands
 *  off to it: focus, caret at the end, and grow to fit, so the customer can
 *  immediately edit + send instead of staring at a cramped box. It lives here,
 *  beside the onChange path, because the two used to be independent pixel
 *  literals and the box grew to a different size depending on how the customer
 *  got there. */
export function growComposerToFit(el: HTMLTextAreaElement): void {
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight, COMPOSER_MAX_HEIGHT_PX)}px`;
}

/** What the view knows about this profile's egress proxy, as the composer reads
 *  it: only 'pending' and 'blocked' change what Send does and what it says. */
export type ComposerProxyState =
  | { kind: 'none' | 'ready' }
  | { kind: 'pending' }
  | { kind: 'blocked'; reason: string };

export function Composer({
  chat,
  draft,
  onDraftChange,
  onSubmit,
  composerRef,
  aiReady,
  proxyState,
  sendHeldByAdopt,
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
  onRetryAdopt: () => void;
  onGoToSettings?: () => void;
}): JSX.Element {
  return (
    <div className="border-t border-surface-divider px-4 py-3">
      <div className="mx-auto flex max-w-3xl items-end gap-2">
        <textarea
          ref={composerRef}
          aria-label="Message Driftstack AI"
          rows={COMPOSER_ROWS}
          value={draft}
          placeholder="Describe a task in plain English — e.g. “Go to example.com, accept the cookie banner, then search for ‘pricing’ and screenshot the result.”  ⏎ to send · ⇧⏎ for a new line"
          onChange={(e) => {
            onDraftChange(e.target.value);
            // #139 — LLM-composer feel: grow with the content up to a cap.
            e.target.style.height = 'auto';
            e.target.style.height = `${Math.min(e.target.scrollHeight, COMPOSER_MAX_HEIGHT_PX)}px`;
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              onSubmit();
            }
          }}
          className="form-input max-h-[420px] min-h-[5.5rem] flex-1 resize-none text-sm leading-relaxed"
        />
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
            className="shrink-0 rounded border border-surface-divider px-3 py-2 text-sm hover:bg-surface-elevated disabled:opacity-50"
          >
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
            className="btn-primary px-3 py-2 text-sm disabled:opacity-50"
          >
            Send
          </button>
        )}
      </div>
      <p className="mx-auto mt-1 flex max-w-3xl items-center gap-2 text-2xs text-ink-muted">
        {chat.sending && chat.stopping === true ? (
          <span role="status" data-component="chat-stopping-notice">
            {STOPPING_NOTICE}
          </span>
        ) : chat.stoppedTurnStillRunning ? (
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
        ) : aiReady && chat.adopting ? (
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
        ) : aiReady ? (
          'Enter to send · Shift+Enter for a new line'
        ) : (
          <>
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
          </>
        )}
      </p>
    </div>
  );
}
