// AI-chat S7 — AgentChatView (Console look).
//
// The headline AI surface: the customer types a natural-language task, Driftstack
// decomposes it (Claude) into a plan and runs it against an agent session, and
// the transcript renders each turn as a plan checklist / clarify / refuse — with
// the W443/W445 consequential-action Approve/Deny safety gate surfaced inline and
// a per-turn cost/usage badge. Data layer: useAgentChat (S6) over the SDK
// agentSessions resource (S5).
//
// Honest scope: the Claude PLAN is real; the browser ACTIONS are simulated in
// this deployment until the live webkit driver is enabled (driver:mock). The
// banner says so — no pretending.

import { useEffect, useRef, useState } from 'react';
import type {
  AgentIntent,
  AgentIntentResult,
  AgentMessageResponse,
  AgentUsage,
  LiveKitInfo,
} from '@driftstack/sdk';
import { useSettings } from '../lib/SettingsContext';
import { AgentSessionPanel } from '../components/AgentSessionPanel';
import { useToasts } from '../lib/toasts';
import { useAgentChat, type ChatModel, type ChatTurn } from '../lib/use-agent-chat';
import { DEFAULT_ASSISTANT_TEMPLATES } from '../lib/assistant-templates';
import {
  loadChats,
  upsertChat,
  deleteChat,
  deriveChatTitle,
  type StoredChat,
} from '../lib/chat-history';
import { RelativeTime } from '../components/RelativeTime';

const MODELS: ReadonlyArray<{ id: ChatModel; label: string }> = [
  { id: 'claude-opus-4-8', label: 'Opus 4.8' },
  { id: 'claude-opus-4-7', label: 'Opus 4.7' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5' },
];

export function AgentChatView({
  initialProfileId,
}: {
  /** F1c — preselect the profile the assistant works on (deep-linked from a
   *  profile card's "Assist"). Locks once a chat starts, like the picker. */
  initialProfileId?: string;
} = {}): JSX.Element {
  const { client, settings } = useSettings();
  const toasts = useToasts();
  // AI-ready status surfaced before you send: the agent needs a connected API
  // key. (The server-side LLM config can't be probed from here; an API key is
  // the necessary + honest precondition the GUI can assert.)
  const aiReady = settings.apiKey !== null;
  const [model, setModel] = useState<ChatModel>('claude-opus-4-8');
  const [profileId, setProfileId] = useState<string>(initialProfileId ?? '');
  const [profiles, setProfiles] = useState<ReadonlyArray<{ id: string; name: string }>>([]);
  const [draft, setDraft] = useState('');
  const chat = useAgentChat({ model, ...(profileId !== '' ? { profileId } : {}) });
  const started = chat.turns.length > 0;

  // Save-as-recipe — snapshot this chat's executed steps into a replayable
  // recipe. The SDK recipes.create has had zero GUI callers until now; this
  // closes the chat → reusable-flow loop. Only meaningful once at least one
  // turn actually executed a plan (clarify/refuse turns contribute no intents).
  const canSaveRecipe =
    chat.session !== null &&
    chat.turns.some((t) => t.role === 'agent' && t.response?.kind === 'plan-executed');
  const [saveOpen, setSaveOpen] = useState(false);
  const [recipeLabel, setRecipeLabel] = useState('');
  const [recipeDesc, setRecipeDesc] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Multi-chat history (memory): each chat is persisted as its own transcript
  // so the customer can keep several conversations and reopen past ones.
  const [chats, setChats] = useState<ReadonlyArray<StoredChat>>([]);
  const [activeChatId, setActiveChatId] = useState<string>(() => crypto.randomUUID());
  const createdAtRef = useRef<Record<string, number>>({});
  useEffect(() => {
    void loadChats().then(setChats);
  }, []);
  // Persist the active chat whenever its transcript changes (skip the empty
  // pre-first-message state). createdAt is sticky per chat id.
  useEffect(() => {
    if (chat.turns.length === 0) return;
    const now = Date.now();
    const createdAt = createdAtRef.current[activeChatId] ?? now;
    createdAtRef.current[activeChatId] = createdAt;
    void upsertChat(
      {
        id: activeChatId,
        title: deriveChatTitle(chat.turns),
        profileId,
        model,
        turns: [...chat.turns],
        createdAt,
        updatedAt: now,
      },
      now,
    ).then(setChats);
  }, [chat.turns, activeChatId, profileId, model]);

  // The rail's new/select/delete are LOCKED while a turn is in flight: switching
  // chats mid-send would otherwise strand (or, pre-fix, misattach) the in-flight
  // reply. The user hits Stop first. Mirrors the header New-chat button's guard.
  // (audit wja3dfl5t — the surface that made the P0 wrong-chat-attach reachable.)
  function handleNewChat(): void {
    if (chat.sending) return;
    chat.reset();
    setActiveChatId(crypto.randomUUID());
    setProfileId(initialProfileId ?? '');
  }
  function handleSelectChat(c: StoredChat): void {
    if (chat.sending || c.id === activeChatId) return;
    createdAtRef.current[c.id] = c.createdAt;
    setActiveChatId(c.id);
    setProfileId(c.profileId);
    setModel(c.model);
    chat.restore(c.turns);
  }
  function handleDeleteChat(id: string): void {
    if (chat.sending) return;
    void deleteChat(id).then(setChats);
    if (id === activeChatId) handleNewChat();
  }

  // Close the save dialog AND clear its draft, so reopening starts fresh
  // instead of showing the previous (un-saved or just-saved) name/description.
  function closeSaveDialog(): void {
    setSaveOpen(false);
    setRecipeLabel('');
    setRecipeDesc('');
    setSaveError(null);
  }

  // a11y: Escape closes the save dialog (matches ConfirmProvider / the create
  // modal). The backdrop already closes on click; keyboard users need a key path.
  useEffect(() => {
    if (!saveOpen) return undefined;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !saving) closeSaveDialog();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [saveOpen, saving]);

  async function saveRecipe(): Promise<void> {
    if (!client || chat.session === null) return;
    const label = recipeLabel.trim();
    if (label.length === 0) {
      setSaveError('Give the task a name.');
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const recipe = await client.recipes.create({
        agent_session_id: chat.session.id,
        label,
        ...(recipeDesc.trim() !== '' ? { description: recipeDesc.trim() } : {}),
      });
      setSaveOpen(false);
      setRecipeLabel('');
      setRecipeDesc('');
      toasts.push({
        title: 'Task saved',
        body: `“${recipe.label}” captured from this chat — replay it from Saved tasks.`,
        tone: 'success',
      });
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Could not save the task.');
    } finally {
      setSaving(false);
    }
  }

  // S16 — load the account's profiles for the "where the AI works" picker.
  useEffect(() => {
    if (!client) return undefined;
    let cancelled = false;
    void (async () => {
      const acc: Array<{ id: string; name: string }> = [];
      try {
        for await (const p of client.profiles.iterate({ limit: 100 })) {
          acc.push({ id: p.id, name: p.name });
          if (acc.length >= 100) break;
        }
      } catch {
        /* leave what we have; the picker still offers "No profile" */
      }
      if (!cancelled) setProfiles(acc);
    })();
    return () => {
      cancelled = true;
    };
  }, [client]);

  function submit(): void {
    const text = draft.trim();
    if (text.length === 0 || chat.sending) return;
    setDraft('');
    // Retry-friendly: if the send fails, restore the draft so the user can
    // re-send without retyping (don't clobber a draft they've since started).
    void chat.send(text).then((ok) => {
      if (!ok) setDraft((d) => (d.length === 0 ? text : d));
    });
  }

  return (
    <div className="flex h-full bg-surface-base">
      <ChatRail
        chats={chats}
        activeId={activeChatId}
        busy={chat.sending}
        onNew={handleNewChat}
        onSelect={handleSelectChat}
        onDelete={handleDeleteChat}
      />
      <div
        className="flex h-full min-w-0 flex-1 flex-col"
        data-component="ai-automation-chat-column"
      >
        {/* Header */}
        <header className="flex items-center justify-between gap-3 border-b border-surface-divider px-4 py-2.5">
          <div className="flex items-center gap-2">
            <span className="flex h-6 w-6 items-center justify-center rounded bg-accent-subtle text-accent">
              <IconSparkle />
            </span>
            <div className="flex flex-col">
              <span className="text-sm font-medium text-ink-primary">AI Browser Automation</span>
              <span className="text-2xs text-ink-muted">natural-language automation</span>
            </div>
            <span
              className={`ml-1 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-2xs font-medium ${
                aiReady
                  ? 'bg-status-ready/15 text-status-ready'
                  : 'bg-status-error/15 text-status-error'
              }`}
              title={
                aiReady
                  ? 'Connected — the assistant is ready.'
                  : 'No API key — connect one in Settings before sending.'
              }
            >
              <span
                className={`h-1.5 w-1.5 rounded-full ${aiReady ? 'bg-status-ready' : 'bg-status-error'}`}
              />
              {aiReady ? 'AI ready' : 'Not connected'}
            </span>
          </div>
          <div className="flex items-center gap-2">
            {chat.session !== null && (
              <BudgetMeter
                remaining={chat.session.token_budget_remaining}
                total={chat.session.token_budget_total}
              />
            )}
            <select
              aria-label="Profile"
              value={profileId}
              disabled={started}
              onChange={(e) => setProfileId(e.target.value)}
              className="max-w-[10rem] truncate rounded border border-surface-divider bg-surface-inset px-2 py-1 text-xs text-ink-secondary disabled:opacity-60"
              title={
                started
                  ? 'Profile is locked for this chat — start a new chat to change it'
                  : 'Which profile the agent works on. Temporary = a throwaway session that saves nothing.'
              }
            >
              <option value="">Temporary profile (saves nothing)</option>
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <select
              aria-label="Model"
              value={model}
              disabled={started}
              onChange={(e) => setModel(e.target.value as ChatModel)}
              className="rounded border border-surface-divider bg-surface-inset px-2 py-1 text-xs text-ink-secondary disabled:opacity-60"
              title={
                started
                  ? 'Model is locked for the current chat — start a new chat to change it'
                  : 'Model'
              }
            >
              {MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => {
                setSaveError(null);
                setSaveOpen(true);
              }}
              disabled={!canSaveRecipe || chat.sending}
              className="btn-secondary px-2 py-1 text-xs disabled:opacity-50"
              title={
                canSaveRecipe
                  ? 'Save this chat as a replayable task you can re-run later'
                  : 'Run at least one task first, then save it to replay later'
              }
            >
              Save as task
            </button>
            <button
              type="button"
              onClick={handleNewChat}
              disabled={!started || chat.sending}
              className="btn-secondary px-2 py-1 text-xs disabled:opacity-50"
            >
              New chat
            </button>
          </div>
        </header>

        {/* Honest execution-mode banner */}
        <div className="border-b border-surface-divider bg-surface-inset px-4 py-1.5">
          <span className="text-2xs text-ink-muted">
            Plans are generated by Claude in real time. Browser actions are simulated in this
            deployment until the live device driver is enabled.
          </span>
        </div>

        {/* Transcript */}
        <div className="flex-1 overflow-auto px-4 py-4">
          {!started ? (
            <EmptyState onPick={(t) => setDraft(t)} />
          ) : (
            <ol className="mx-auto flex max-w-3xl flex-col gap-3">
              {chat.turns.map((turn) => (
                <TurnRow key={turn.id} turn={turn} />
              ))}
              {chat.sending && <TypingRow />}
            </ol>
          )}
        </div>

        {/* Consequential-action confirmation gate */}
        {chat.pendingConfirmation !== null && (
          <div className="border-t border-status-busy/40 bg-status-busy/10 px-4 py-3">
            <div className="mx-auto flex max-w-3xl items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-xs font-semibold text-ink-primary">Confirm before continuing</p>
                <p className="truncate text-xs text-ink-secondary">
                  The agent wants to perform a {categoryLabel(chat.pendingConfirmation.category)}:{' '}
                  <span className="font-medium text-ink-primary">
                    “{chat.pendingConfirmation.matchedText}”
                  </span>
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  onClick={chat.deny}
                  disabled={chat.sending}
                  className="btn-secondary px-3 py-1 text-xs disabled:opacity-50"
                >
                  Deny
                </button>
                <button
                  type="button"
                  onClick={() => void chat.approve()}
                  disabled={chat.sending}
                  className="btn-primary px-3 py-1 text-xs disabled:opacity-50"
                >
                  Approve
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Error */}
        {chat.error !== null && (
          <div className="border-t border-status-error/40 bg-status-error/10 px-4 py-2">
            <p className="mx-auto max-w-3xl text-xs text-status-error">{chat.error}</p>
          </div>
        )}

        {/* Composer */}
        <div className="border-t border-surface-divider px-4 py-3">
          <div className="mx-auto flex max-w-3xl items-end gap-2">
            <textarea
              aria-label="Message Driftstack AI"
              rows={1}
              value={draft}
              placeholder="Describe a task — e.g. “open example.com and take a screenshot”"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  submit();
                }
              }}
              className="form-input max-h-40 min-h-[2.25rem] flex-1 resize-none"
            />
            {chat.sending ? (
              <button
                type="button"
                onClick={() => chat.cancel()}
                title="Stop waiting for this reply"
                className="rounded border border-surface-divider px-3 py-2 text-sm hover:bg-surface-elevated"
              >
                Stop
              </button>
            ) : (
              <button
                type="button"
                onClick={submit}
                disabled={draft.trim().length === 0}
                className="btn-primary px-3 py-2 text-sm disabled:opacity-50"
              >
                Send
              </button>
            )}
          </div>
          <p className="mx-auto mt-1 max-w-3xl text-2xs text-ink-muted">
            Enter to send · Shift+Enter for a new line
          </p>
        </div>
      </div>
      {/* end main column */}

      {/* Live iPhone watch pane (founder 2026-06-24: "a visual iPhone here showing
          in realtime what is happening" when a task is dispatched). The chat runs
          against a normal streamable agent session (chat.session.id), the same
          LiveKit-backed session the simulator streams — so this mirrors the
          simulator's live-video path: fetch the per-session LiveKit token via the
          SDK (client.agentSessions.livekitToken), then render <AgentSessionPanel>.
          READ-ONLY: interactive is left false (the default) so NO tap/scroll/key
          input is captured here — the agent drives the phone, the user only
          watches; clicking the view can never interfere with the automation. */}
      <LiveAutomationPanel sessionId={chat.session?.id ?? null} />

      {/* Save-as-recipe dialog */}
      {saveOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
          onClick={() => {
            if (!saving) closeSaveDialog();
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Save chat as task"
            className="w-full max-w-md rounded-lg border border-surface-divider bg-surface-raised p-4 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="section-label">Save as task</p>
            <p className="mt-1 text-xs text-ink-muted">
              Snapshot this chat&apos;s executed steps into a replayable task you can run again from
              Saved tasks.
            </p>
            <label className="mt-3 block text-xs text-ink-secondary">
              Name
              <input
                autoFocus
                value={recipeLabel}
                maxLength={120}
                onChange={(e) => setRecipeLabel(e.target.value)}
                placeholder="e.g. Add 3 items to cart"
                className="form-input mt-1 w-full"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void saveRecipe();
                }}
              />
            </label>
            <label className="mt-3 block text-xs text-ink-secondary">
              Description <span className="text-ink-muted">(optional)</span>
              <textarea
                value={recipeDesc}
                maxLength={2000}
                rows={2}
                onChange={(e) => setRecipeDesc(e.target.value)}
                placeholder="What this flow does…"
                className="form-input mt-1 w-full resize-none"
              />
            </label>
            {saveError !== null && <p className="mt-2 text-xs text-status-error">{saveError}</p>}
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={closeSaveDialog}
                disabled={saving}
                className="btn-secondary px-3 py-1 text-xs disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void saveRecipe()}
                disabled={saving || recipeLabel.trim().length === 0}
                className="btn-primary px-3 py-1 text-xs disabled:opacity-50"
              >
                {saving ? 'Saving…' : 'Save task'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── live iPhone watch pane ───────────────────────────────────────

/** The canonical iPhone screen aspect (402×874 logical ≡ 1206×2622 px) the
 *  simulator locks to. Passing it here keeps the watch pane the same true
 *  device proportions (and reuses AgentSessionPanel's bezel-black letterbox so
 *  there's no white-space border). */
const IPHONE_WATCH_ASPECT_RATIO = 402 / 874;

type WatchState =
  | { kind: 'idle' } // no chat session dispatched yet
  | { kind: 'loading' } // fetching the LiveKit token
  | { kind: 'live'; info: LiveKitInfo } // token in hand → stream
  | { kind: 'error'; message: string }; // token fetch failed

/**
 * Read-only live iPhone view bound to the chat's agent session. When a task is
 * dispatched the chat lazily creates an agent session (useAgentChat) — a normal
 * LiveKit-streamable Driftstack session, exactly like the simulator's. This pane
 * fetches that session's LiveKit token (POST /v1/agent-sessions/:id/livekit-token
 * via the SDK) and renders the live stream so the user watches the automation
 * drive the phone in realtime.
 *
 * READ-ONLY by design: AgentSessionPanel is mounted with `interactive` left at
 * its default (false), so the LK.6.d input-capture is NOT wired — taps / scrolls
 * / keystrokes on this video never reach the device. The agent is the sole
 * driver; the user only watches and cannot interfere by clicking the view.
 */
function LiveAutomationPanel({ sessionId }: { sessionId: string | null }): JSX.Element {
  const { client } = useSettings();
  const [watch, setWatch] = useState<WatchState>({ kind: 'idle' });

  useEffect(() => {
    // No session dispatched yet → the placeholder ("Dispatch a task…").
    if (sessionId === null) {
      setWatch({ kind: 'idle' });
      return undefined;
    }
    // Defensive: the SDK client (or its livekitToken method) may be absent in a
    // partial harness / before connect — degrade to a calm error rather than
    // throwing in render. The real client always carries agentSessions.
    if (client === null || typeof client.agentSessions?.livekitToken !== 'function') {
      setWatch({ kind: 'error', message: 'Live view unavailable — not connected.' });
      return undefined;
    }
    let cancelled = false;
    setWatch({ kind: 'loading' });
    void client.agentSessions
      .livekitToken(sessionId)
      .then((info) => {
        if (!cancelled) setWatch({ kind: 'live', info });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // A session with no Mac/LiveKit registered yet (503) or a not-yet-ready
        // worker is the common case here — keep the copy reassuring, not alarming.
        const msg = err instanceof Error ? err.message : 'Could not start the live view.';
        setWatch({ kind: 'error', message: msg });
      });
    return () => {
      cancelled = true;
    };
  }, [client, sessionId]);

  return (
    <aside
      data-component="ai-automation-live-pane"
      className="hidden w-[300px] shrink-0 flex-col border-l border-surface-divider bg-surface-raised/60 lg:flex"
    >
      <div className="flex items-center gap-2 border-b border-surface-divider px-3 py-2.5">
        <span className="text-xs font-medium text-ink-primary">Live view</span>
        <span className="text-2xs text-ink-muted">read-only — the agent is driving</span>
      </div>
      <div className="flex flex-1 items-center justify-center overflow-hidden p-3">
        {watch.kind === 'idle' && (
          <WatchPlaceholder
            title="Nothing running yet"
            body="Dispatch a task to watch it run live on the phone."
          />
        )}
        {watch.kind === 'loading' && (
          <div
            data-component="ai-automation-live-connecting"
            className="flex flex-col items-center gap-3 text-center text-xs text-ink-muted"
          >
            <span
              className="h-7 w-7 animate-spin rounded-full border-2 border-surface-divider border-t-accent"
              aria-hidden="true"
            />
            <span>Starting the live view…</span>
          </div>
        )}
        {watch.kind === 'error' && (
          <WatchPlaceholder title="Live view unavailable" body={watch.message} tone="muted" />
        )}
        {watch.kind === 'live' && (
          // READ-ONLY: `interactive` omitted (defaults false) → no input capture.
          // coverChromeBand reuses the simulator's bezel-black letterbox so there
          // is no white-space border around the stream.
          <AgentSessionPanel
            info={watch.info}
            interactive={false}
            coverChromeBand
            aspectRatio={IPHONE_WATCH_ASPECT_RATIO}
          />
        )}
      </div>
    </aside>
  );
}

function WatchPlaceholder({
  title,
  body,
  tone = 'default',
}: {
  title: string;
  body: string;
  tone?: 'default' | 'muted';
}): JSX.Element {
  return (
    <div className="flex max-w-[14rem] flex-col items-center gap-2 text-center">
      <span
        className={`flex h-10 w-10 items-center justify-center rounded-xl ${
          tone === 'muted' ? 'bg-surface-inset text-ink-muted' : 'bg-accent-subtle text-accent'
        }`}
        aria-hidden="true"
      >
        <IconPhone />
      </span>
      <p className="text-xs font-medium text-ink-secondary">{title}</p>
      <p className="text-2xs text-ink-muted">{body}</p>
    </div>
  );
}

function IconPhone(): JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="4.25" y="1.75" width="7.5" height="12.5" rx="1.6" />
      <path d="M7 3.25h2" />
    </svg>
  );
}

// ─── chat history rail ────────────────────────────────────────────

function ChatRail({
  chats,
  activeId,
  busy,
  onNew,
  onSelect,
  onDelete,
}: {
  chats: ReadonlyArray<StoredChat>;
  activeId: string;
  busy: boolean;
  onNew: () => void;
  onSelect: (c: StoredChat) => void;
  onDelete: (id: string) => void;
}): JSX.Element {
  return (
    <aside className="flex w-52 shrink-0 flex-col border-r border-surface-divider bg-surface-raised/60">
      <div className="border-b border-surface-divider p-2">
        <button
          type="button"
          onClick={onNew}
          disabled={busy}
          title={busy ? 'Finish or stop the current reply first' : undefined}
          className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-xs font-semibold text-white hover:bg-accent-hover disabled:opacity-40"
        >
          + New chat
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-1.5">
        {chats.length === 0 ? (
          <p className="px-2 py-3 text-2xs text-ink-muted">
            Your chats are saved here so you can pick one back up later.
          </p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {chats.map((c) => (
              <li key={c.id}>
                <div
                  className={`group flex items-center gap-1 rounded-md px-2 py-1.5 transition-colors ${
                    c.id === activeId ? 'bg-accent-subtle' : 'hover:bg-surface-elevated'
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => onSelect(c)}
                    disabled={busy}
                    title={busy ? 'Finish or stop the current reply first' : undefined}
                    className="min-w-0 flex-1 text-left disabled:cursor-not-allowed"
                  >
                    <span className="block truncate text-xs text-ink-primary">{c.title}</span>
                    <span className="block text-2xs text-ink-muted">
                      <RelativeTime
                        iso={new Date(c.updatedAt).toISOString()}
                        tooltipPrefix="Updated"
                      />
                    </span>
                  </button>
                  <button
                    type="button"
                    aria-label={`Delete chat ${c.title}`}
                    title={busy ? 'Finish or stop the current reply first' : 'Delete chat'}
                    onClick={() => onDelete(c.id)}
                    disabled={busy}
                    className="shrink-0 px-1 text-ink-muted opacity-0 transition-opacity hover:text-status-error group-hover:opacity-100 disabled:hover:text-ink-muted"
                  >
                    ✕
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}

// ─── turn rendering ───────────────────────────────────────────────

function TurnRow({ turn }: { turn: ChatTurn }): JSX.Element {
  if (turn.role === 'user') {
    return (
      <li className="flex justify-end">
        <div className="max-w-[80%] rounded-lg rounded-br-sm bg-accent-subtle px-3 py-2 text-sm text-ink-primary">
          {turn.text}
        </div>
      </li>
    );
  }
  return (
    <li className="flex justify-start">
      <div className="max-w-[85%] rounded-lg rounded-bl-sm border border-surface-divider bg-surface-raised px-3 py-2">
        {turn.response !== undefined && <AgentResponseBody response={turn.response} />}
      </div>
    </li>
  );
}

function AgentResponseBody({ response }: { response: AgentMessageResponse }): JSX.Element {
  switch (response.kind) {
    case 'plan-executed':
      return (
        <div className="flex flex-col gap-1.5">
          <p className="section-label">Plan</p>
          <ol className="flex flex-col gap-1">
            {response.results.map((r, i) => (
              <PlanStep key={i} result={r} />
            ))}
          </ol>
          {response.usage !== undefined && <UsageBadge usage={response.usage} />}
        </div>
      );
    case 'clarify':
      return (
        <div className="flex flex-col gap-1.5">
          <p className="text-sm text-ink-primary">{response.clarifying_question}</p>
          {response.usage !== undefined && <UsageBadge usage={response.usage} />}
        </div>
      );
    case 'refuse':
      return (
        <div className="flex flex-col gap-1.5">
          <p className="text-sm text-status-error">{response.refuse_reason}</p>
          {response.usage !== undefined && <UsageBadge usage={response.usage} />}
        </div>
      );
    case 'logged-manual':
      return <p className="text-xs italic text-ink-muted">Logged (manual mode — no AI turn).</p>;
  }
}

function PlanStep({ result }: { result: AgentIntentResult }): JSX.Element {
  const { glyph, cls, text } = describeResult(result);
  return (
    <li className="flex items-start gap-1.5 text-xs">
      <span className={`mt-px shrink-0 ${cls}`} aria-hidden="true">
        {glyph}
      </span>
      <span className="text-ink-secondary">{text}</span>
    </li>
  );
}

function describeResult(result: AgentIntentResult): { glyph: string; cls: string; text: string } {
  switch (result.kind) {
    case 'success':
      return { glyph: '✓', cls: 'text-status-ready', text: result.summary };
    case 'failure':
      return {
        glyph: '✗',
        cls: 'text-status-error',
        text: `${intentLabel(result.intent)} — ${result.reason}`,
      };
    case 'confirmation_required':
      return {
        glyph: '⏸',
        cls: 'text-status-busy',
        text: `${intentLabel(result.intent)} — confirmation required (“${result.matchedText}”)`,
      };
  }
}

function intentLabel(intent: AgentIntent): string {
  switch (intent.kind) {
    case 'navigate':
      return `navigate ${intent.url}`;
    case 'interact':
      return `${intent.action}${intent.selector !== undefined ? ` ${intent.selector}` : ''}`;
    case 'wait':
      return `wait (${intent.condition})`;
    case 'capture':
      return `capture ${intent.capture}`;
    case 'scroll':
      return `scroll ${intent.direction}`;
    case 'behavioral_pause':
      return 'behavioural pause';
  }
}

function UsageBadge({ usage }: { usage: AgentUsage }): JSX.Element {
  const parts: string[] = [];
  if (usage.cost_usd_cents !== undefined) parts.push(`$${(usage.cost_usd_cents / 100).toFixed(4)}`);
  const tokens = (usage.anthropic_input_tokens ?? 0) + (usage.anthropic_output_tokens ?? 0);
  if (tokens > 0) parts.push(`${tokens} tok`);
  if (usage.model !== undefined) parts.push(usage.model);
  if (parts.length === 0)
    return <span className="mono text-2xs text-ink-muted">{usage.decomposer_kind}</span>;
  return <span className="mono text-2xs text-ink-muted">{parts.join(' · ')}</span>;
}

function TypingRow(): JSX.Element {
  return (
    <li className="flex justify-start">
      <div className="flex items-center gap-1 rounded-lg rounded-bl-sm border border-surface-divider bg-surface-raised px-3 py-2.5">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-ink-muted" />
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-ink-muted [animation-delay:150ms]" />
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-ink-muted [animation-delay:300ms]" />
      </div>
    </li>
  );
}

function EmptyState({ onPick }: { onPick: (text: string) => void }): JSX.Element {
  return (
    <div className="mx-auto flex max-w-xl flex-col items-center gap-4 py-12 text-center">
      <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-accent-subtle text-accent">
        <IconSparkle />
      </span>
      <div className="flex flex-col gap-1">
        <p className="text-base font-medium text-ink-primary">
          Start from a template or describe a task
        </p>
        <p className="text-sm text-ink-muted">
          Pick a template below, or describe what you want in plain language. Driftstack plans the
          steps and runs them on a session — pausing for your approval before anything
          consequential.
        </p>
      </div>
      <div className="flex w-full flex-col gap-1.5">
        {DEFAULT_ASSISTANT_TEMPLATES.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => onPick(t.prompt)}
            className="flex flex-col gap-0.5 rounded-md border border-surface-divider bg-surface-raised px-3 py-2 text-left transition-colors hover:border-accent/50"
          >
            <span className="text-xs font-medium text-ink-primary">{t.label}</span>
            <span className="text-2xs text-ink-muted">{t.description}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function BudgetMeter({ remaining, total }: { remaining: number; total: number }): JSX.Element {
  const pct = total > 0 ? Math.max(0, Math.min(100, (remaining / total) * 100)) : 0;
  return (
    <div className="flex items-center gap-1.5" title={`${remaining} / ${total} tokens remaining`}>
      <span className="section-label">budget</span>
      <span className="h-1.5 w-16 overflow-hidden rounded-full bg-surface-inset">
        <span
          className={`block h-full rounded-full ${pct < 15 ? 'bg-status-error' : 'bg-status-ready'}`}
          style={{ width: `${pct}%` }}
        />
      </span>
    </div>
  );
}

function categoryLabel(category: string): string {
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

function IconSparkle(): JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M8 1.75 9.4 5.6 13.25 7 9.4 8.4 8 12.25 6.6 8.4 2.75 7 6.6 5.6Z" />
      <path d="M12.75 11.25v2.5M11.5 12.5h2.5" />
    </svg>
  );
}
