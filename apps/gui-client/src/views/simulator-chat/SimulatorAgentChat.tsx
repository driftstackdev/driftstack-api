// The simulator drawer's Agent/Pair conversation — round 2 stage B (design
// brief §2, the owner's "Love it!" on the mockup). The pane's Session section
// keeps `SessionControlSection`'s Mode switch/caption/take-over row exactly
// where they are; THIS component is what now renders below it, replacing the
// old one-line "Tell the agent…" composer, whenever the mode is Agent or
// Pair.
//
// ⛔ ONE SOURCE OF TRUTH, NOT A SECOND TRANSCRIPT STORE. Every piece here is
// the AI view's OWN component (Turn.tsx / PlanTimeline.tsx / ApprovalDock.tsx
// / AnswerCard.tsx / Composer.tsx), reading the SAME `useAgentChat` hook
// AgentChatView.tsx reads — `useAgentChatSession()`, published by the single
// `AgentChatProvider` `SimulatorWindow` now mounts (see that file's own
// header). `adopt()` attaches this hook instance to the session the
// simulator window was ALREADY opened for (its `sessionId`, the same
// `AgentSession.id` `agent-session-control.ts`'s raw-fetch transport already
// drives the Mode switch / take-over row from), so a message typed here
// continues that exact session rather than forking a second one. Sending
// through `chat.send()` — not the drawer's old `sendAgentMessage()` raw POST
// — is what makes the flight strip's live progress (the phase line, the
// steps landing one by one, the plan) possible at all: that POST is a single
// non-streaming request, and only `chat.send()`'s own streaming response
// updates `liveSteps`/`livePhase`/`liveAnswer` as the turn runs.
//
// Approvals and Stop are the same two: `chat.approve()`/`chat.deny()` and
// `chat.cancel()`, the exact functions ApprovalDock's/Composer's own buttons
// already call in the AI view — reused, not re-implemented.

import { useEffect, useMemo, useRef, useState } from 'react';
import { Fragment } from 'react';
import { AuthError } from '@driftstack/sdk';
import { useSettings } from '../../lib/SettingsContext';
import { useAgentChatSession } from '../../lib/AgentChatProvider';
import { interruptedTurnReason, type ChatTurn } from '../../lib/use-agent-chat';
import { SESSION_ACCESS_EXPIRED_NOTICE } from '../../lib/simulator-session-access';
import type { SessionMode } from '../../lib/agent-session-control';
import { ApprovalDock, confirmationHost, gatedStepTaps } from '../agent-chat/ApprovalDock';
import { Composer, growComposerToFit } from '../agent-chat/Composer';
import {
  LiveTurnRow,
  RestoredHistoryDivider,
  TurnRow,
  TypingRow,
  type TurnActions,
} from '../agent-chat/Turn';
import { simulatorMissionLine } from './mission-line';
import {
  useSimulatorChatAccess,
  useSimulatorChatCredential,
  useSimulatorChatKeyRefused,
} from './simulator-chat-access';

/** Owner item 5 — what the panel says when this window holds no control key for
 *  its session, IN PLACE of the composer. The composer's own "not connected"
 *  caption tells the customer to add an API key in Settings, which is wrong
 *  here twice over: this window never uses the account key, and no key a
 *  customer could add would reach it. Reopening the profile hands the window a
 *  fresh key. */
export const SIMULATOR_CHAT_UNAVAILABLE_NOTICE =
  "Chat isn't available in this window. Close it and open the profile again.";

/** Owner item 5 — the panel's own typing row while it attaches to the session
 *  this window shows. Not the AI view's "Reattaching to the previous session":
 *  nothing here is previous — it is the session on screen. */
export const SIMULATOR_CHAT_ATTACHING_NOTICE = 'Connecting to this session…';

/** Owner item 5 — the same panel when that attach could not be answered (the
 *  AI view's "Couldn't reattach to the previous session" is about a reopened
 *  chat; this is the session on screen). The composer offers Try again. */
export const SIMULATOR_CHAT_ATTACH_FAILED_NOTICE =
  'Couldn’t connect to this session — check your connection and try again.';

const SIMULATOR_ATTACH_NOTICES = {
  pending: SIMULATOR_CHAT_ATTACHING_NOTICE,
  failed: SIMULATOR_CHAT_ATTACH_FAILED_NOTICE,
};

/** The same panel when the attach failed because the server refused this
 *  window's session key: "check your connection" would be a wrong instruction. */
const SIMULATOR_ATTACH_NOTICES_KEY_REFUSED = {
  pending: SIMULATOR_CHAT_ATTACHING_NOTICE,
  failed: SESSION_ACCESS_EXPIRED_NOTICE,
};

/** What the chat writes on a turn stopped by a refused credential ("Your
 *  Driftstack API key was rejected. Check it in Settings…"), derived from the
 *  chat's own mapping so a rewording there cannot silently unhook this. In this
 *  window the only credential is the session key, so that sentence names the
 *  wrong key and a place the customer cannot fix it from. */
const KEY_REJECTED_TURN_REASON = interruptedTurnReason(
  new AuthError({
    type: 'https://errors.driftstack.dev/unauthorized',
    title: 'Unauthorized',
    status: 401,
  }),
);

/** The turn as this window shows it: a refused-key stop says what fixes it. */
export function simulatorTurn(turn: ChatTurn): ChatTurn {
  if (turn.interrupted?.reason !== KEY_REJECTED_TURN_REASON) return turn;
  return { ...turn, interrupted: { ...turn.interrupted, reason: SESSION_ACCESS_EXPIRED_NOTICE } };
}

const TONE_CLASS: Record<'live' | 'hold' | 'ready' | 'quiet', string> = {
  live: 'ai-chip-live',
  hold: 'ai-chip-hold',
  ready: 'ai-chip-open',
  quiet: 'ai-chip-quiet',
};

export function SimulatorAgentChat({
  sessionId,
  mode,
}: {
  /** The `AgentSession.id` the simulator window was opened for — the same id
   *  `SessionControlSection`'s Mode switch/take-over row already drive
   *  through `agent-session-control.ts`. */
  sessionId: string;
  mode: Extract<SessionMode, 'ai' | 'pair'>;
}): JSX.Element {
  const { chat, captureSrc } = useAgentChatSession();
  // ⛔ Owner item 5 — readiness is THIS SESSION's control key, never
  // `settings.apiKey`. A Simulator window cannot read the account key (the OS
  // credential store refuses every window but the main one), so gating on it
  // said "Not connected" to every customer. `client` here is the scoped
  // control-key client `SimulatorChatSettings` publishes, not the account one.
  const { settings, client } = useSettings();
  const access = useSimulatorChatAccess();
  // Item 5 — the capture thumbnails fetch with the session's control key, from
  // the same API origin the chat's client uses.
  const credential = useSimulatorChatCredential();
  const keyRefused = useSimulatorChatKeyRefused();
  const captureBaseUrl = credential.baseUrl ?? settings.baseUrl;
  // 'pending' counts as ready for the composer (the key is a native read away);
  // a send made in that instant is held, never dropped — see `submit`.
  const aiReady = access !== 'unavailable';
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState('');
  // (l) #8's own held-send caption, mirrored from AgentChatView: the reattach
  // this session's sessionId triggers on mount/change.
  const [sendHeldByAdopt, setSendHeldByAdopt] = useState(false);

  useEffect(() => {
    if (!chat.adopting) setSendHeldByAdopt(false);
  }, [chat.adopting]);

  // Reattach to the session this window already has open — a no-op unless
  // that session is still `active` (adoptionOutcome), and safe to call again
  // on every sessionId change (the standalone Simulator swaps sessionId IN
  // PLACE on a `ds-session` relaunch, without remounting this component).
  //
  // Owner item 5 — also re-run when the CLIENT arrives or changes. The control
  // key is loaded after mount (a native read on macOS), and `adopt` with no
  // client is a silent no-op, so an effect keyed on `sessionId` alone attached
  // to nothing and the first send had no session to go to. Deferred one tick:
  // a client change also runs the hook's own auth-boundary teardown (in the
  // provider ABOVE this component, whose effects run AFTER this one), and that
  // teardown bumps the chat's generation — an adopt started in the same commit
  // would be discarded as stale.
  useEffect(() => {
    // 'ready' is a client in the app; a gallery fixture's chat is 'ready' with
    // none, and its own `adopt` is what the scene observes.
    if (sessionId === '' || access !== 'ready') return undefined;
    const timer = setTimeout(() => chat.adopt(sessionId), 0);
    return () => clearTimeout(timer);
    // ⚠️ `chat.adopt` deliberately not in the deps array: it is a stable
    // `useCallback` ([] deps in use-agent-chat.ts), so only `sessionId`
    // and the client should ever re-trigger the reattach. (No eslint-disable:
    // this repo does not load the react-hooks plugin, and a disable for a rule
    // that is not configured is itself an error — use-stick-to-bottom.ts's own
    // note.)
  }, [sessionId, client, access]);

  // A FRESH key for the same session (reopened from the main window after the
  // old key was refused) keeps the same client — and so the conversation — but
  // an attach that failed on the refused key must be tried again with it. An
  // attached chat is left alone: the new key changes nothing it holds.
  const adoptKeyRef = useRef(credential.controlKey);
  useEffect(() => {
    if (adoptKeyRef.current === credential.controlKey) return;
    adoptKeyRef.current = credential.controlKey;
    if (credential.controlKey === null || sessionId === '' || access !== 'ready') return;
    if (chat.session !== null && chat.adoptError === null) return;
    setTimeout(() => chat.adopt(sessionId), 0);
    // ⚠️ Keyed on the key alone, on purpose (see the adopt effect above).
  }, [credential.controlKey]);

  function submit(): void {
    const text = draft.trim();
    if (text.length === 0 || chat.sending || !aiReady) return;
    if (chat.adopting) {
      setSendHeldByAdopt(true);
      return;
    }
    // Owner item 5 — this panel only ever CONTINUES the session on screen. With
    // no attached session a send would make the chat start a new one (a second
    // phone), which the scoped client refuses anyway; attach first and keep the
    // draft. A key still loading is the same wait.
    if (access === 'pending' || chat.session === null) {
      if (client !== null && sessionId !== '') chat.adopt(sessionId);
      setSendHeldByAdopt(true);
      return;
    }
    if (chat.stoppedTurnStillRunning) return;
    setDraft('');
    void chat.send(text).then((ok) => {
      if (!ok && !chat.lastSendKeptMessage()) setDraft((d) => (d.length === 0 ? text : d));
    });
  }

  function askFollowUp(): void {
    composerRef.current?.focus();
  }

  function fillComposer(text: string): void {
    setDraft(text);
    const el = composerRef.current;
    if (el === null) return;
    requestAnimationFrame(() => {
      el.focus();
      const end = el.value.length;
      el.setSelectionRange(end, end);
      growComposerToFit(el);
    });
  }

  function continueFromHere(): void {
    if (chat.sending || !aiReady || chat.adopting || chat.stoppedTurnStillRunning) return;
    if (chat.session === null) return;
    void chat.send('continue');
  }

  const sessionActive = chat.session !== null;
  const turnActions: TurnActions = useMemo(
    () => ({
      onContinue: continueFromHere,
      onSuggest: fillComposer,
      onAskFollowUp: askFollowUp,
      sessionActive,
      // onSaveAsTask deliberately omitted — the save-as-a-task dialog lives in
      // the AI view's own chrome (a picker + a name/description form); the
      // simulator's session already has its profile fixed by the launch that
      // opened this window, and duplicating that dialog here is out of scope
      // for the conversation panel itself.
    }),
    // ⚠️ `continueFromHere`/`fillComposer`/`askFollowUp` deliberately not in
    // the deps array: they close over `chat`/`aiReady`/`draft` by reference
    // each render, and re-deriving `turnActions` on every keystroke would
    // re-render every memoized `TurnRow` for nothing (Turn.tsx's own reason
    // this object's identity is load-bearing). No eslint-disable — see the
    // adopt effect above for why.
    [sessionActive, chat.sending, chat.adopting, chat.stoppedTurnStillRunning, aiReady],
  );

  const mission = simulatorMissionLine(chat, mode);

  return (
    <div data-component="simulator-agent-chat" className="flex flex-col gap-3.5">
      {/* ── Mission line — one word (an `.ai-chip` tone, reused byte-for-byte
          from the AI view's own HUD/status-pill vocabulary) + one plain
          sentence. Never a live region: every word here already lands in the
          transcript below, either as this turn's own brief/flight line or as
          the dock's voice line — the same "not a second announcement" rule
          the AI view's own stage caption follows. */}
      <div className="flex min-w-0 items-center gap-2">
        <span className={`ai-chip ai-chip-state sim-chip-halo ${TONE_CLASS[mission.tone]}`}>
          <i
            className={`ai-pip${mission.tone === 'ready' ? ' is-ready' : ''}${mission.beat ? ' ai-beat' : ''}`}
            aria-hidden="true"
          />
          {mission.word}
        </span>
        <span
          className="min-w-0 flex-1 truncate text-[12px] text-white/80"
          title={mission.sentence}
        >
          {mission.sentence}
        </span>
      </div>

      {/* ── The transcript. `aria-live="polite"` exactly like the AI view's
          own log — the panel is the one place in the drawer this session's
          reply is announced, so it must be, but its content updates settle
          (no per-second ticking text: Turn.tsx's own ElapsedClock/PausedClock
          are `aria-hidden` leaves for the same reason). */}
      {chat.turns.length === 0 && !chat.sending ? (
        <p className="text-[11.5px] text-white/50">
          Ask a question or describe a task below — the agent drives the phone above.
        </p>
      ) : (
        <ol className="flex flex-col" aria-live="polite" aria-relevant="additions">
          {chat.turns.map((turn, i) => (
            <Fragment key={turn.id}>
              <TurnRow
                turn={simulatorTurn(turn)}
                denied={chat.deniedTurnIds.has(turn.id)}
                approved={chat.approvedTurnIds?.has(turn.id) ?? false}
                sessionId={chat.session?.id ?? chat.restoredSessionId ?? null}
                baseUrl={captureBaseUrl}
                // ⛔ Owner item 5 — never the account key in this window (it
                // is unreadable here anyway): screenshots are fetched with
                // the session's control key.
                apiKey={null}
                controlKey={credential.controlKey}
                captureSrc={captureSrc}
                first={i === 0}
                past={i < chat.turns.length - 2}
                actions={turnActions}
              />
              {chat.session === null &&
                !chat.adopting &&
                chat.restoredHistoryCount > 0 &&
                i === chat.restoredHistoryCount - 1 && <RestoredHistoryDivider />}
            </Fragment>
          ))}
          {chat.sending &&
            (chat.livePlan !== null || chat.liveSteps.length > 0 || chat.livePhase !== null ? (
              <LiveTurnRow
                livePhase={chat.livePhase}
                liveAnswer={chat.liveAnswer}
                liveSteps={chat.liveSteps}
                livePlan={chat.livePlan}
                liveStepIndex={chat.liveStepIndex}
                liveStartedAt={chat.liveStartedAt}
                liveStepMs={chat.liveStepMs}
                liveNotice={chat.liveNotice}
                sessionId={chat.session?.id ?? null}
                baseUrl={captureBaseUrl}
                apiKey={null}
                controlKey={credential.controlKey}
                captureSrc={captureSrc}
              />
            ) : (
              <TypingRow
                label={chat.session === null ? 'Starting a session…' : 'Working on your request…'}
              />
            ))}
          {chat.adopting && !chat.sending && chat.adoptError === null && (
            <TypingRow label={SIMULATOR_CHAT_ATTACHING_NOTICE} />
          )}
        </ol>
      )}

      {/* ── The consequential-action gate — composer-stays-mounted rule kept:
          it renders ABOVE the composer, never in place of it. */}
      {chat.pendingConfirmation !== null && (
        <ApprovalDock
          category={chat.pendingConfirmation.category}
          matchedText={chat.pendingConfirmation.matchedText}
          taps={gatedStepTaps(chat.turns, chat.pendingConfirmation.turnId)}
          host={confirmationHost(chat.turns)}
          sessionActive={sessionActive}
          sending={chat.sending}
          composerRef={composerRef}
          onDeny={() => chat.deny()}
          onApprove={() => void chat.approve()}
        />
      )}

      {chat.error !== null && chat.error.kind === undefined && (
        <div role="alert" className="rounded-lg bg-status-error/10 px-3 py-2">
          <p className="text-[11.5px] text-status-error">{chat.error.message}</p>
        </div>
      )}

      {/* ── The AI view's own Composer — replaces the drawer's old one-line
          "Tell the agent…" box; same placeholder intent (a plain-English
          task), same Send/Stop slot, same optimistic clear-and-rollback
          (`submit` above mirrors AgentChatView's own). */}
      {access === 'unavailable' ? (
        <p
          data-component="simulator-chat-unavailable"
          role="status"
          className="text-[11.5px] text-white/70"
        >
          {SIMULATOR_CHAT_UNAVAILABLE_NOTICE}
        </p>
      ) : (
        <Composer
          chat={chat}
          draft={draft}
          onDraftChange={setDraft}
          onSubmit={submit}
          composerRef={composerRef}
          aiReady={aiReady}
          proxyState={{ kind: 'none' }}
          sendHeldByAdopt={sendHeldByAdopt}
          onRetryAdopt={() => chat.adopt(sessionId)}
          attachNotices={
            keyRefused ? SIMULATOR_ATTACH_NOTICES_KEY_REFUSED : SIMULATOR_ATTACH_NOTICES
          }
        />
      )}
    </div>
  );
}
