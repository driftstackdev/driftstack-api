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
import { useSettings } from '../../lib/SettingsContext';
import { useAgentChatSession } from '../../lib/AgentChatProvider';
import type { SessionMode } from '../../lib/agent-session-control';
import { ApprovalDock, confirmationHost, gatedStepTaps } from '../agent-chat/ApprovalDock';
import { Composer, growComposerToFit } from '../agent-chat/Composer';
import { REATTACHING_NOTICE } from '../agent-chat/notices';
import {
  LiveTurnRow,
  RestoredHistoryDivider,
  TurnRow,
  TypingRow,
  type TurnActions,
} from '../agent-chat/Turn';
import { simulatorMissionLine } from './mission-line';

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
  const { settings } = useSettings();
  const aiReady = settings.apiKey !== null;
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
  useEffect(() => {
    if (sessionId === '') return;
    chat.adopt(sessionId);
    // ⚠️ `chat.adopt` deliberately not in the deps array: it is a stable
    // `useCallback` ([] deps in use-agent-chat.ts), so only `sessionId`
    // should ever re-trigger the reattach. (No eslint-disable: this repo does
    // not load the react-hooks plugin, and a disable for a rule that is not
    // configured is itself an error — use-stick-to-bottom.ts's own note.)
  }, [sessionId]);

  function submit(): void {
    const text = draft.trim();
    if (text.length === 0 || chat.sending || !aiReady) return;
    if (chat.adopting) {
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
                turn={turn}
                denied={chat.deniedTurnIds.has(turn.id)}
                approved={chat.approvedTurnIds?.has(turn.id) ?? false}
                sessionId={chat.session?.id ?? chat.restoredSessionId ?? null}
                baseUrl={settings.baseUrl}
                apiKey={settings.apiKey}
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
                baseUrl={settings.baseUrl}
                apiKey={settings.apiKey}
                captureSrc={captureSrc}
              />
            ) : (
              <TypingRow
                label={chat.session === null ? 'Starting a session…' : 'Working on your request…'}
              />
            ))}
          {chat.adopting && !chat.sending && chat.adoptError === null && (
            <TypingRow label={REATTACHING_NOTICE} />
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
      />
    </div>
  );
}
