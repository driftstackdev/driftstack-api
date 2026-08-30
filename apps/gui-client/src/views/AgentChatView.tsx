// AI-chat S7 — AgentChatView (Console look).
//
// The headline AI surface: the customer types a natural-language task, Driftstack
// decomposes it (Claude) into a plan and runs it against an agent session, and
// the transcript renders each turn as a plan checklist / clarify / refuse — with
// the W443/W445 consequential-action Approve/Deny safety gate surfaced inline and
// a per-turn cost/usage badge. Data layer: useAgentChat (S6) over the SDK
// agentSessions resource (S5).
//
// Honest scope: #139 go-live — the Claude PLAN is real AND the browser ACTIONS
// now execute for real on a fleet device (ControlPlaneAgentExecutor over the
// fleet control plane). The banner reflects /version `agent_execution`: 'live'
// when the fleet path is wired (prod), 'simulated' only on a stub deployment.

import { Fragment, memo, useCallback, useEffect, useRef, useState } from 'react';
import {
  type AgentIntent,
  type AgentIntentResult,
  type AgentSession,
  type AgentMessageResponse,
  type AgentUsage,
  type LiveKitInfo,
} from '@driftstack/sdk';
import { describeAgentSessionState } from '../lib/session-liveness';
import type { SessionStateDescriptor } from '../lib/session-liveness';
import { useSettings } from '../lib/SettingsContext';
import { useConnectionStatus } from '../lib/use-connection-status';
import { AgentSessionPanel } from '../components/AgentSessionPanel';
import { useConfirm } from '../components/ConfirmProvider';
import { useFocusTrap } from '../lib/use-focus-trap';
import { humanizeError } from '../lib/humanize-error';
import { useToasts } from '../lib/toasts';
import { useAgentChat, type ChatModel, type ChatTurn } from '../lib/use-agent-chat';
import { DEFAULT_ASSISTANT_TEMPLATES } from '../lib/assistant-templates';
import {
  loadChats,
  upsertChat,
  deleteChat,
  deriveChatTitle,
  chatTurnCount,
  summariseTurn,
  type StoredChat,
} from '../lib/chat-history';
import { RelativeTime } from '../components/RelativeTime';
import { listProxies, setProxyServerId, type ProxyConfig } from '../lib/proxies';
import { listBindings } from '../lib/profile-bindings';
import {
  createProxy as createAccountProxy,
  updateProxy as updateAccountProxy,
} from '../lib/account-proxies';

const MODELS: ReadonlyArray<{ id: ChatModel; label: string }> = [
  { id: 'claude-opus-5', label: 'Opus 5' },
  { id: 'claude-sonnet-5', label: 'Sonnet 5' },
  { id: 'claude-opus-4-8', label: 'Opus 4.8' },
  { id: 'claude-opus-4-7', label: 'Opus 4.7' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5' },
];

/** #31 — map a usage model id (e.g. `claude-opus-4-8`) to its human label
 *  ("Opus 4.8") for the per-turn usage badge; falls back to the raw id for a
 *  model not in the picker (older transcript / server-chosen model). */
function modelLabel(id: string): string {
  return MODELS.find((m) => m.id === id)?.label ?? id;
}

// ─── egress: resolve a profile's bound proxy → server proxy_id ─────
//
// Egress-leak fix. The AI-browser session-create only ever forwarded `profile_id`
// — never a proxy — so a session on a profile with a bound residential proxy
// silently exited via the OPERATOR-DEFAULT IP (the opposite of what an
// anti-detect tool promises). The manual launch (ProfilesView.handleLaunch) does
// real proxy work — pickProxy(profile) → ensureServerProxy() (sync the GUI-local
// proxy into an account_proxies row) → pass proxy_id on create. We MIRROR that
// here so the two launch paths can't diverge. Proxy bindings are LOCAL-ONLY
// (Tauri stores), so this reads them directly rather than via ProfilesView state.

/** Mirror of ProfilesView.pickProxy: the proxy a profile launches through.
 *  An EXPLICIT default binding to a now-deleted proxy returns null (do NOT
 *  silently reroute through proxies[0] — that would leak a different IP/country
 *  for an anti-detect tool); no explicit binding → the first saved proxy. */
function pickProxyFor(
  profileId: string,
  bindings: ReadonlyArray<{ profileId: string; defaultProxyId: string | null }>,
  proxies: ReadonlyArray<ProxyConfig>,
): ProxyConfig | null | 'missing' {
  const binding = bindings.find((b) => b.profileId === profileId);
  if (binding?.defaultProxyId !== undefined && binding.defaultProxyId !== null) {
    // An EXPLICIT binding whose proxy is gone is 'missing', never 'none': the
    // customer chose an exit for this profile, so launching on the operator
    // default instead would leak their real IP under a setting they believe is
    // active. Collapsing both into null is what let that through.
    return proxies.find((p) => p.id === binding.defaultProxyId) ?? 'missing';
  }
  return proxies[0] ?? null;
}

/** Mirror of ProfilesView.ensureServerProxy: ensure the picked local proxy has a
 *  server-side account_proxies row (encrypted under the account TMK) and return
 *  its id to pass as proxy_id. Creates on first use (caching the id on the local
 *  proxy), refreshes on later launches so an edited host/credential stays current.
 *  Returns undefined when there's no API key (caller launches without proxy_id →
 *  operator-default egress, same as today). */
async function ensureServerProxyId(
  p: ProxyConfig,
  baseUrl: string,
  apiKey: string | null,
): Promise<string | undefined> {
  if (apiKey === null || apiKey.length === 0) return undefined;
  const input = {
    label: p.label,
    scheme: p.scheme ?? ('socks5' as const),
    host: p.host,
    port: p.port,
    username: p.username,
    password: p.password,
    ...(p.openvpn !== undefined ? { openvpn: p.openvpn } : {}),
    ...(p.wireguard !== undefined ? { wireguard: p.wireguard } : {}),
  };
  if (p.serverId !== undefined) {
    try {
      await updateAccountProxy(baseUrl, apiKey, p.serverId, input);
      return p.serverId;
    } catch (err) {
      // Stale cached serverId (the account_proxies row was deleted server-side):
      // the PUT 404s. Self-heal by re-creating below instead of failing forever.
      // Any other error is real — re-throw it.
      if ((err as { status?: number }).status !== 404) throw err;
    }
  }
  const created = await createAccountProxy(baseUrl, apiKey, input);
  await setProxyServerId(p.id, created.id);
  return created.id;
}

/** Outcome of resolving a profile's egress proxy.
 *
 *  `undefined` used to carry BOTH "this profile has no proxy, operator-default
 *  egress is correct" AND "this profile HAS a proxy but we could not resolve
 *  it" — and the second silently launched the session unproxied. These are
 *  opposite outcomes and must not share a representation. */
type ProxyResolution =
  | { kind: 'none' }
  | { kind: 'ready'; proxyId: string }
  | { kind: 'blocked'; reason: string };

/** Resolve the server proxy_id an AI session for `profileId` must exit through,
 *  by reading the LOCAL proxy + binding stores and mirroring the manual-launch
 *  resolution.
 *
 *  FAILS CLOSED, matching ProfilesView.handleLaunch since the 2026-07-08 sweep.
 *  This function used to swallow a sync failure and resolve `undefined` so the
 *  chat could proceed — the comment even claimed that mirrored ProfilesView. It
 *  no longer does: ProfilesView was hardened precisely because the server treats
 *  an ABSENT proxy_id as operator-default egress, so omitting it sends the
 *  session out through Driftstack's shared IP instead of the customer's proxy.
 *  That is an egress-identity leak — the one thing an anti-detect product must
 *  never do — and the server's own fail-closed guard only covers a
 *  present-but-unresolvable proxy_id, never an omitted one. A bound-but-
 *  unresolvable proxy therefore BLOCKS the send rather than downgrading it. */
async function resolveProfileProxyId(
  profileId: string,
  baseUrl: string,
  apiKey: string | null,
): Promise<ProxyResolution> {
  let proxy: ReturnType<typeof pickProxyFor> = null;
  try {
    const [bindings, proxies] = await Promise.all([listBindings(), listProxies()]);
    proxy = pickProxyFor(profileId, bindings, proxies);
  } catch (err) {
    // We cannot even tell whether a proxy is bound, so we cannot prove this
    // profile is meant to exit on the operator default. Fail closed.
    console.warn('[ai-chat] proxy binding read failed; blocking send to avoid an egress leak', err);
    return {
      kind: 'blocked',
      reason:
        'Couldn’t read this profile’s proxy settings, so the chat was not started — ' +
        'running it could have sent traffic through Driftstack’s default IP instead of your proxy.',
    };
  }
  if (proxy === 'missing') {
    return {
      kind: 'blocked',
      reason:
        'This profile is set to use a proxy that no longer exists, so the chat was not ' +
        'started — running it would have sent traffic through Driftstack’s default IP. ' +
        'Re-select a proxy for this profile in Profiles.',
    };
  }
  if (proxy === null) return { kind: 'none' }; // genuinely no proxy bound
  try {
    const proxyId = await ensureServerProxyId(proxy, baseUrl, apiKey);
    if (proxyId === undefined) {
      return {
        kind: 'blocked',
        reason:
          `Couldn’t set up the proxy “${proxy.label}” for this chat, so it was not started — ` +
          'connect your API key in Settings and try again.',
      };
    }
    return { kind: 'ready', proxyId };
  } catch (err) {
    console.warn('[ai-chat] proxy account-sync failed; blocking send to avoid an egress leak', err);
    return {
      kind: 'blocked',
      reason:
        `Couldn’t set up the proxy “${proxy.label}” for this chat, so it was not started — ` +
        'starting it would have sent traffic through Driftstack’s default IP instead of your ' +
        'proxy. Check the proxy and try again.',
    };
  }
}

function formatUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/* Written out in full rather than composed, because Tailwind's scanner only
   sees class names that appear literally in the source. */
const STATUS_PILL_TONE: Record<SessionStateDescriptor['tone'], string> = {
  running: 'bg-accent/15 text-accent',
  starting: 'bg-status-busy/15 text-status-busy',
  stopping: 'bg-status-idle/15 text-status-idle',
  ready: 'bg-status-ready/15 text-status-ready',
  error: 'bg-status-error/15 text-status-error',
};
const STATUS_DOT_TONE: Record<SessionStateDescriptor['tone'], string> = {
  running: 'bg-accent',
  starting: 'bg-status-busy',
  stopping: 'bg-status-idle',
  ready: 'bg-status-ready',
  error: 'bg-status-error',
};

export function AgentChatView({
  initialProfileId,
  onGoToSettings,
}: {
  /** F1c — preselect the profile the assistant works on (deep-linked from a
   *  profile card's "Assist"). Locks once a chat starts, like the picker. */
  initialProfileId?: string;
  /** Founder report (2026-07-01) — the bundled-LLM consent/budget error banner
   *  needs a real one-click way into the AI & billing settings section. */
  onGoToSettings?: () => void;
} = {}): JSX.Element {
  const { client, settings } = useSettings();
  // #139 — the "browser actions are simulated" note is only true while the server
  // runs the StubAgentExecutor. Drive it off /version `agent_execution` (the fleet
  // control-plane gate), NOT `driver` — in prod `driver` stays 'mock' even though
  // automation executes for real over the fleet correlator (the go-live path), so
  // keying on driver:webkit wrongly showed "preview mode". `agent_execution:'live'`
  // → real; 'simulated' → stub; null (older server / not yet probed) → treat as
  // live so a transient probe gap doesn't flash the stale mock disclaimer.
  const agentExecution = useConnectionStatus(settings.baseUrl).agentExecution;
  const actionsAreLive = agentExecution !== 'simulated';
  const toasts = useToasts();
  const confirm = useConfirm();
  // AI-ready status surfaced before you send: the agent needs a connected API
  // key. (The server-side LLM config can't be probed from here; an API key is
  // the necessary + honest precondition the GUI can assert.)
  const aiReady = settings.apiKey !== null;
  /**
   * Server-reported lifecycle status of the open session, or null when there is
   * no session. Distinct from `watch.kind`, which describes whether WE are
   * watching the video — a session runs perfectly well with the pane closed.
   */
  const [liveSession, setLiveSession] = useState<AgentSession | null>(null);
  const [model, setModel] = useState<ChatModel>('claude-opus-5');
  const [profileId, setProfileId] = useState<string>(initialProfileId ?? '');
  const [profiles, setProfiles] = useState<ReadonlyArray<{ id: string; name: string }>>([]);
  const [draft, setDraft] = useState('');
  // #20 — the composer textarea, so picking a template can focus it, drop the
  // caret at the end, and grow it to fit the inserted prompt (mirrors the
  // onChange auto-grow) instead of leaving a cramped, unfocused box.
  const composerRef = useRef<HTMLTextAreaElement>(null);
  // Bundled-LLM one-click consent CTA (error banner). Local, not part of the
  // chat hook — this is a settings mutation, not a chat turn.
  const [bundledLlmEnabling, setBundledLlmEnabling] = useState(false);
  const [bundledLlmEnableError, setBundledLlmEnableError] = useState<string | null>(null);
  const [bundledLlmEnabled, setBundledLlmEnabled] = useState(false);
  // Egress-leak fix — the server proxy_id the selected profile must exit through,
  // resolved from its LOCAL proxy binding the SAME way ProfilesView's manual launch
  // does (resolveProfileProxyId). Threaded into the chat session create so an AI
  // session on a proxied profile uses the configured residential exit instead of
  // silently leaking the operator/datacenter IP. undefined → no bound proxy →
  // operator-default egress (unchanged). Resolved BEFORE the first send creates the
  // session (the resolution effect runs while the picker is still editable); the
  // profile + session are locked together once a chat starts.
  // 'pending' until the resolution settles, so a send cannot race ahead of it —
  // the create used to fire with whatever proxyId happened to be set, which for a
  // deep-linked proxied profile was still undefined while the network round-trip
  // was in flight.
  const [proxyState, setProxyState] = useState<ProxyResolution | { kind: 'pending' }>({
    kind: 'none',
  });
  const proxyId = proxyState.kind === 'ready' ? proxyState.proxyId : undefined;
  const chat = useAgentChat({
    model,
    ...(profileId !== '' ? { profileId } : {}),
    ...(proxyId !== undefined ? { proxyId } : {}),
  });
  const started = chat.turns.length > 0;

  /**
   * V-1611 — the badge polls HERE rather than reusing the lifecycle poll in
   * `LiveAutomationPanel`.
   *
   * ⚠️ That poll looks like the natural home and is not: the panel is a memo'd
   * child that mounts only when the video pane is open, which is exactly the
   * case where the customer can already SEE the session running. A background
   * session — the one a badge exists for — never mounts it, so no amount of
   * widening its guard would have worked. The line reference alone did not say
   * that; the scope did.
   *
   * 10s rather than the panel's 5s: this drives a text label, not an end latch,
   * so it is deliberately the cheaper of the two when both are live.
   */
  const liveSessionId = chat.session?.id ?? null;
  const sessionState = describeAgentSessionState(liveSession ?? chat.session, aiReady);
  useEffect(() => {
    if (liveSessionId === null) {
      setLiveSession(null);
      return undefined;
    }
    if (client === null || typeof client.agentSessions?.get !== 'function') return undefined;
    let cancelled = false;
    const poll = (): void => {
      void client.agentSessions
        .get(liveSessionId)
        .then((s) => {
          if (cancelled) return;
          // Store the WHOLE session: the badge needs `liveness` as well as
          // `status`, and deciding between them is `describeAgentSessionState`'s
          // job, not the fetcher's.
          setLiveSession(s);
        })
        // A transient GET failure is not evidence the session ended. Leaving the
        // last known status is more honest than flipping the badge off and back.
        .catch(() => undefined);
    };
    poll();
    const handle = setInterval(poll, 10_000);
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
  }, [client, liveSessionId]);
  // Below the lg breakpoint the live-view pane is hidden inline; this toggles it
  // as a slide-over so a narrow window can still open it (it used to vanish with
  // no affordance). Ignored at lg+ where the pane is a permanent column.
  const [liveOpen, setLiveOpen] = useState(false);
  // Perf — stable onClose so the memoized LiveAutomationPanel (which owns a live
  // WebRTC video subtree) doesn't reconcile on every composer keystroke. This
  // component owns the composer `draft` state and re-renders ~10+/sec while the
  // user types; without a stable handler an inline `() => setLiveOpen(false)`
  // would defeat the panel's React.memo. setLiveOpen is a stable state setter → no deps.
  const closeLiveView = useCallback(() => setLiveOpen(false), []);

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
  const saveDialogRef = useRef<HTMLDivElement>(null);
  const savingRecipeRef = useRef(false);
  const saveDiscardConfirmOpenRef = useRef(false);

  // Multi-chat history (memory): each chat is persisted as its own transcript
  // so the customer can keep several conversations and reopen past ones.
  const [chats, setChats] = useState<ReadonlyArray<StoredChat>>([]);
  const [activeChatId, setActiveChatId] = useState<string>(() => crypto.randomUUID());
  const createdAtRef = useRef<Record<string, number>>({});
  // Set when we've just restored a chat for READING (handleSelectChat). The
  // persist effect skips the single turns-change the restore itself causes, so
  // merely opening an old chat to re-read it does NOT bump its updatedAt or
  // re-sort it to the top of the rail (sweep2). A real new turn afterwards clears
  // it and persists normally.
  const justRestoredRef = useRef(false);
  useEffect(() => {
    void loadChats().then(setChats);
  }, []);
  // P2 #6 — sync profileId when a re-deep-link changes initialProfileId. profileId
  // is seeded from initialProfileId via useState (mount-only), so opening the agent
  // chat again for a DIFFERENT profile (the deep-link arrives while the component
  // stays mounted) left the previous profile selected. Update on a REAL change only
  // (a defined, different value) so a user's manual in-session selection isn't
  // clobbered by an unchanged/absent prop on every render. Skips undefined (no
  // deep-link context → keep the current selection).
  const prevInitialProfileIdRef = useRef(initialProfileId);
  useEffect(() => {
    if (initialProfileId !== undefined && initialProfileId !== prevInitialProfileIdRef.current) {
      setProfileId(initialProfileId);
    }
    prevInitialProfileIdRef.current = initialProfileId;
  }, [initialProfileId]);
  // Egress-leak fix — resolve the selected profile's bound proxy to a server
  // proxy_id BEFORE the first send creates the session, so the AI session exits
  // through the configured proxy (not the operator default). Re-runs when the
  // selected profile changes WHILE the chat is still un-started (the picker locks
  // once a chat begins, so the resolved proxy can't drift from the live session).
  // Temporary profile (profileId === '') → clear it (no proxy). Best-effort: a
  // sync failure resolves to undefined and the chat proceeds without proxy_id
  // (resolveProfileProxyId already warns + falls back, matching ProfilesView).
  useEffect(() => {
    if (started) return undefined; // locked to the live session — don't re-resolve
    if (profileId === '') {
      setProxyState({ kind: 'none' }); // temporary profile → no proxy to honour
      return undefined;
    }
    let cancelled = false;
    setProxyState({ kind: 'pending' });
    void resolveProfileProxyId(profileId, settings.baseUrl, settings.apiKey).then((resolution) => {
      if (!cancelled) setProxyState(resolution);
    });
    return () => {
      cancelled = true;
    };
  }, [profileId, started, settings.baseUrl, settings.apiKey]);
  // Persist the active chat whenever its transcript changes (skip the empty
  // pre-first-message state). createdAt is sticky per chat id.
  useEffect(() => {
    if (chat.turns.length === 0) return;
    // A read-only restore is not an edit: don't rewrite updatedAt / re-sort the
    // rail just because the customer opened a chat to look at it.
    if (justRestoredRef.current) {
      justRestoredRef.current = false;
      return;
    }
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
        // The handle that makes reopening this chat able to rejoin its session
        // rather than silently starting a new one.
        sessionId: chat.session?.id ?? null,
      },
      now,
    ).then(setChats);
  }, [chat.turns, activeChatId, profileId, model]);

  // #32 — an unsent draft must not bleed across chats. draft lives at this
  // component (shared by every chat in the rail), so switching to another chat —
  // or starting a new one — while the composer holds un-sent text carried that
  // text into the other conversation. Clear it on any activeChatId change so each
  // chat opens with an empty composer. (Runs once on mount too, where draft is
  // already ''.) Not keyed on draft: this fires only on a chat switch.
  useEffect(() => {
    setDraft('');
  }, [activeChatId]);

  // The rail's new/select/delete are LOCKED while a turn is in flight: switching
  // chats mid-send would otherwise strand (or, pre-fix, misattach) the in-flight
  // reply. The user hits Stop first. Mirrors the header New-chat button's guard.
  // (audit wja3dfl5t — the surface that made the P0 wrong-chat-attach reachable.)
  function handleNewChat(): void {
    if (chat.sending) return;
    // A new chat is a clean slate — never carry a pending restore-suppression
    // into it (defensive: a restore that loaded 0 turns would otherwise leave
    // the flag set and skip the first real persist).
    justRestoredRef.current = false;
    chat.reset();
    setActiveChatId(crypto.randomUUID());
    setProfileId(initialProfileId ?? '');
  }
  function handleSelectChat(c: StoredChat): void {
    if (chat.sending || c.id === activeChatId) return;
    createdAtRef.current[c.id] = c.createdAt;
    // Opening a chat to read it is not an edit — suppress the persist that the
    // restore's turns-change would otherwise trigger (which bumped updatedAt and
    // jumped the chat to the top of the rail).
    justRestoredRef.current = true;
    setActiveChatId(c.id);
    setProfileId(c.profileId);
    setModel(c.model);
    // Hand over the session this chat last ran on. If it is still LIVE the adopt
    // below takes it and clears this; if it is CLOSED — the ordinary case, since
    // leaving the view closes it — the next send continues from it and the agent
    // keeps the conversation (V-2161).
    chat.restore(c.turns, c.sessionId ?? null);
    // Reopening a chat whose session is still running should REJOIN it, not
    // abandon a live session and start a second one against the same profile.
    // restore() has just bumped the cancel generation, so this call is bound to
    // THIS selection and drops its answer if the customer moves again.
    if (typeof c.sessionId === 'string' && c.sessionId !== '') chat.adopt(c.sessionId);
  }
  function handleDeleteChat(id: string): void {
    if (chat.sending) return;
    void (async () => {
      // Deleting a saved chat is immediate + unrecoverable — confirm first.
      if (
        !(await confirm('Delete this saved chat? Its messages are removed for good.', {
          confirmLabel: 'Delete chat',
          tone: 'danger',
        }))
      )
        return;
      await deleteChat(id).then(setChats);
      if (id === activeChatId) handleNewChat();
    })();
  }

  // Successful saves and confirmed discards reset the dialog. Ordinary exit
  // requests go through requestCloseSaveDialog below so an accidental backdrop
  // click or Escape cannot erase a typed task name/description.
  const resetSaveDialog = useCallback((): void => {
    saveDiscardConfirmOpenRef.current = false;
    setSaveOpen(false);
    setRecipeLabel('');
    setRecipeDesc('');
    setSaveError(null);
  }, []);

  const requestCloseSaveDialog = useCallback((): void => {
    if (savingRecipeRef.current || saveDiscardConfirmOpenRef.current) return;
    if (recipeLabel.trim().length === 0 && recipeDesc.trim().length === 0) {
      resetSaveDialog();
      return;
    }

    saveDiscardConfirmOpenRef.current = true;
    void confirm('Discard this unsaved task draft?', {
      confirmLabel: 'Discard draft',
      tone: 'danger',
    }).then((discard) => {
      saveDiscardConfirmOpenRef.current = false;
      if (discard) resetSaveDialog();
    });
  }, [confirm, recipeDesc, recipeLabel, resetSaveDialog]);

  // Keep focus inside the modal, restore it to the trigger, and route Escape
  // through the same dirty-draft guard as backdrop/Cancel.
  useFocusTrap(saveOpen, saveDialogRef, requestCloseSaveDialog);

  async function saveRecipe(): Promise<void> {
    if (!client || chat.session === null || savingRecipeRef.current) return;
    const label = recipeLabel.trim();
    if (label.length === 0) {
      setSaveError('Give the task a name.');
      return;
    }
    // React's disabled state is not an admission lock: the Name input keeps an
    // Enter handler while the request is pending, and two key events can reach
    // this function before a render. Claim the save synchronously.
    savingRecipeRef.current = true;
    setSaving(true);
    setSaveError(null);
    try {
      const recipe = await client.recipes.create({
        agent_session_id: chat.session.id,
        label,
        ...(recipeDesc.trim() !== '' ? { description: recipeDesc.trim() } : {}),
      });
      resetSaveDialog();
      toasts.push({
        title: 'Task saved',
        body: `“${recipe.label}” captured from this chat — replay it from Saved tasks.`,
        tone: 'success',
      });
    } catch (err) {
      setSaveError(humanizeError(err, "Couldn't save the task. Try again."));
    } finally {
      savingRecipeRef.current = false;
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

  function handleEnableBundledLlm(): void {
    if (!client || bundledLlmEnabling) return;
    setBundledLlmEnabling(true);
    setBundledLlmEnableError(null);
    client.account
      .updateBundledLlmSettings({ consent: true })
      .then(() => {
        setBundledLlmEnabled(true);
        toasts.push({
          tone: 'success',
          title: 'AI features enabled',
          body: 'Send your message again to continue.',
        });
      })
      .catch((err: unknown) => {
        setBundledLlmEnableError(humanizeError(err, "Couldn't enable AI features. Try again."));
      })
      .finally(() => setBundledLlmEnabling(false));
  }

  // #20 — filling the composer from a template should hand off to it: focus,
  // caret at the end, and grow to fit (same cap as the onChange auto-grow) so the
  // customer can immediately edit + send instead of a cramped, unfocused box.
  function handlePickTemplate(text: string): void {
    setDraft(text);
    const el = composerRef.current;
    if (el === null) return;
    // Defer to after React commits the new value so scrollHeight reflects it.
    requestAnimationFrame(() => {
      el.focus();
      const end = el.value.length;
      el.setSelectionRange(end, end);
      el.style.height = 'auto';
      el.style.height = `${Math.min(el.scrollHeight, 288)}px`;
    });
  }

  function submit(): void {
    const text = draft.trim();
    // Don't fire a doomed request when there's no API key connected — it would
    // dead-air then surface a server error. The Send button is disabled too;
    // this also guards the Enter-to-send path.
    if (text.length === 0 || chat.sending || !aiReady) return;
    // Egress gate. Only a settled resolution may start a session: 'pending'
    // means the proxy round-trip is still in flight, and 'blocked' means this
    // profile HAS a proxy we could not resolve. Sending in either state would
    // create the session with no proxy_id, which the server reads as
    // operator-default egress — the customer's real exit IP.
    if (proxyState.kind === 'pending' || proxyState.kind === 'blocked') return;
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
        {/* Header — #139: flex-wrap + min-w-0 so the dense control cluster (live
            toggle, budget, profile, model, save, new chat) WRAPS to a second row
            at narrow widths instead of pushing the rightmost buttons off the
            panel edge (founder: "buttons cut off / run outside the panel"). */}
        <header className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-surface-divider px-4 py-2.5">
          <div className="flex min-w-0 items-center gap-2">
            <span className="flex h-6 w-6 items-center justify-center rounded bg-accent-subtle text-accent">
              <IconSparkle />
            </span>
            <div className="flex flex-col">
              <span className="text-sm font-medium text-ink-primary">AI Browser Automation</span>
              <span className="text-2xs text-ink-muted">natural-language automation</span>
            </div>
            {/* V-1611 — this pill reported API-KEY PRESENCE and called it "AI
                ready": a claim about CONFIGURATION worn as a claim about STATE.
                A customer with a key and no session, and one with a session
                running right now, saw the identical pill. The freshest session
                we hold wins — the poll's copy if it has answered, else the one
                the chat hook created. */}
            <span
              data-component="agent-status-pill"
              className={`ml-1 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-2xs font-medium ${STATUS_PILL_TONE[sessionState.tone]}`}
              title={sessionState.title}
            >
              <span
                className={`h-1.5 w-1.5 rounded-full ${STATUS_DOT_TONE[sessionState.tone]} ${
                  sessionState.tone === 'running' ? 'animate-pulse' : ''
                }`}
              />
              {sessionState.label}
            </span>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            {/* Below lg the live-view pane is hidden; this button reveals it as a
                slide-over (hidden at lg+, where the pane is always inline). */}
            <button
              type="button"
              aria-label="Toggle live view"
              onClick={() => setLiveOpen((v) => !v)}
              className="rounded border border-surface-divider px-2 py-1 text-2xs font-medium text-ink-secondary hover:text-ink-primary lg:hidden"
            >
              {liveOpen ? 'Hide live' : 'Live view'}
            </button>
            {chat.session !== null && (
              <BudgetMeter
                remaining={chat.session.token_budget_remaining}
                total={chat.session.token_budget_total}
              />
            )}
            <select
              aria-label="Profile"
              value={profileId}
              // Lock once started OR while the FIRST send is in flight: during the
              // first send `started` is still false (turns.length===0 until the
              // reply lands), so without `|| chat.sending` the customer could change
              // the profile after Send — the session is created with the OLD value
              // while the header shows the new one and the persist writes the new
              // one, desyncing saved chat metadata from the actual session (audit).
              disabled={started || chat.sending}
              onChange={(e) => setProfileId(e.target.value)}
              className="max-w-[10rem] truncate rounded border border-surface-divider bg-surface-inset px-2 py-1 text-xs text-ink-secondary disabled:opacity-60"
              title={
                started || chat.sending
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
              // Same first-send race as the Profile select above — lock on
              // `started || chat.sending` so the model can't change after Send
              // creates the session with the prior value.
              disabled={started || chat.sending}
              onChange={(e) => setModel(e.target.value as ChatModel)}
              className="rounded border border-surface-divider bg-surface-inset px-2 py-1 text-xs text-ink-secondary disabled:opacity-60"
              title={
                started || chat.sending
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

        {/* Honest execution-mode banner — auto-updates with /version
            agent_execution (#139): shows the live indicator when AI-automation
            executes for real over the fleet control plane (prod), and only says
            "preview mode" on a genuine stub (agent_execution:'simulated'). */}
        <div className="border-b border-surface-divider bg-surface-inset px-4 py-1.5">
          {actionsAreLive ? (
            <span className="text-2xs text-ink-muted">
              <span className="mr-1 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-accent align-middle"></span>
              Live device — Claude plans each step and runs it on a real iPhone.
            </span>
          ) : (
            <span className="text-2xs text-ink-muted">
              Claude plans each step in real time; browser actions run in preview mode on this
              deployment until the live device driver is switched on for your account.
            </span>
          )}
        </div>

        {!aiReady && (
          <div
            role="status"
            data-component="ai-api-key-gate"
            className="border-b border-accent/35 bg-accent-subtle px-4 py-3"
          >
            <div className="mx-auto flex max-w-3xl flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-ink-primary">
                  Connect your API key to run automations
                </p>
                <p className="mt-0.5 text-xs text-ink-secondary">
                  You can explore templates and draft a task now. Add your key in Settings before
                  sending it to the browser.
                </p>
              </div>
              {onGoToSettings !== undefined && (
                <button
                  type="button"
                  onClick={onGoToSettings}
                  className="btn-primary shrink-0 px-3 py-1.5 text-xs"
                >
                  Connect in Settings
                </button>
              )}
            </div>
          </div>
        )}

        {/* Transcript */}
        <div className="flex-1 overflow-auto px-4 py-4">
          {!started ? (
            <EmptyState onPick={handlePickTemplate} />
          ) : (
            <ol
              className="mx-auto flex max-w-3xl flex-col gap-3"
              // a11y: announce streaming assistant replies to a screen reader — focus stays
              // in the composer after Send, so without a live region the reply arrives
              // silently and the chat is unusable without sight (audit 2026-07-09).
              aria-live="polite"
              aria-relevant="additions"
            >
              {chat.turns.map((turn, i) => (
                <Fragment key={turn.id}>
                  <TurnRow turn={turn} denied={chat.deniedTurnIds.has(turn.id)} />
                  {/* Honest history boundary: the turns above were restored from
                      saved history and are NOT in a live agent session. Continuing
                      the chat starts a fresh session that won't remember them — so
                      say so, rather than presenting one seamless conversation the
                      agent silently has amnesia about (sweep2). */}
                  {chat.session === null &&
                    // Held back while an adoption is in flight: until the GET
                    // answers, "continuing starts a fresh session" is a claim we
                    // cannot yet make.
                    !chat.adopting &&
                    chat.restoredHistoryCount > 0 &&
                    i === chat.restoredHistoryCount - 1 && <RestoredHistoryDivider />}
                </Fragment>
              ))}
              {chat.sending && (
                <TypingRow
                  label={chat.session === null ? 'Starting a session…' : 'Working on your request…'}
                />
              )}
            </ol>
          )}
        </div>

        {/* Consequential-action confirmation gate */}
        {chat.pendingConfirmation !== null && (
          // a11y: announce the "confirm before continuing" gate — a screen-reader user on
          // the composer must hear that the agent is waiting to run a consequential action
          // (audit 2026-07-09), or they can't approve/deny something they never knew about.
          <div role="alert" className="border-t border-status-busy/40 bg-status-busy/10 px-4 py-3">
            <div className="mx-auto flex max-w-3xl items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-xs font-semibold text-ink-primary">Confirm before continuing</p>
                <p className="text-xs text-ink-secondary [overflow-wrap:anywhere]">
                  The agent wants to perform a {categoryLabel(chat.pendingConfirmation.category)}:{' '}
                  <span className="font-medium text-ink-primary">
                    “{chat.pendingConfirmation.matchedText}”
                  </span>
                </p>
                <p className="mt-0.5 text-2xs text-ink-muted">
                  Approve to let this step run, or Deny to stop the task here.
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    chat.deny();
                    // Deny ends the task (the gated step won't run and nothing after it
                    // continues); say so instead of leaving the user waiting on a
                    // continuation that never comes (audit 2026-07-08).
                    toasts.push({
                      title: 'Task stopped',
                      body: 'You denied a step — the task won’t continue. Send a new instruction to keep going.',
                      tone: 'info',
                    });
                  }}
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
        {chat.error !== null && chat.error.kind === 'bundled_llm_consent' && (
          <div className="border-t border-accent/40 bg-accent-subtle px-4 py-3">
            <div className="mx-auto flex max-w-3xl flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium text-ink">{chat.error.message}</p>
                <p className="mt-0.5 text-2xs text-ink-muted">
                  {bundledLlmEnabled
                    ? 'Enabled — send your message again to continue.'
                    : 'This deployment offers bundled AI usage billed to your account, or you can use your own Anthropic key instead.'}
                </p>
                {bundledLlmEnableError !== null && (
                  <p className="mt-0.5 text-2xs text-status-error">{bundledLlmEnableError}</p>
                )}
              </div>
              {!bundledLlmEnabled && (
                <div className="flex shrink-0 items-center gap-2">
                  <button
                    type="button"
                    onClick={onGoToSettings}
                    className="btn-secondary px-3 py-1.5 text-xs"
                  >
                    Use my own key
                  </button>
                  <button
                    type="button"
                    onClick={handleEnableBundledLlm}
                    disabled={bundledLlmEnabling}
                    className="btn-primary px-3 py-1.5 text-xs disabled:opacity-50"
                  >
                    {bundledLlmEnabling ? 'Enabling…' : 'Enable AI features'}
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
        {chat.error !== null && chat.error.kind === 'bundled_llm_budget' && (
          <div className="border-t border-status-error/40 bg-status-error/10 px-4 py-3">
            <div className="mx-auto flex max-w-3xl flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium text-ink">{chat.error.message}</p>
                <p className="mt-0.5 text-2xs text-ink-muted">
                  {chat.error.spentCents !== undefined && chat.error.capCents !== undefined
                    ? `You've used ${formatUsd(chat.error.spentCents)} of your ${formatUsd(chat.error.capCents)} monthly limit.`
                    : 'Raise your monthly limit, or use your own Anthropic key to keep going.'}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  onClick={onGoToSettings}
                  className="btn-secondary px-3 py-1.5 text-xs"
                >
                  Use my own key
                </button>
                <button
                  type="button"
                  onClick={onGoToSettings}
                  className="btn-primary px-3 py-1.5 text-xs"
                >
                  Raise my limit
                </button>
              </div>
            </div>
          </div>
        )}
        {chat.error !== null && chat.error.kind === undefined && (
          <div
            role="alert"
            className="border-t border-status-error/40 bg-status-error/10 px-4 py-2"
          >
            <p className="mx-auto max-w-3xl text-sm text-status-error">{chat.error.message}</p>
          </div>
        )}

        {/* Composer */}
        <div className="border-t border-surface-divider px-4 py-3">
          <div className="mx-auto flex max-w-3xl items-end gap-2">
            <textarea
              ref={composerRef}
              aria-label="Message Driftstack AI"
              rows={3}
              value={draft}
              placeholder="Describe a task in plain English — e.g. “Go to example.com, accept the cookie banner, then search for ‘pricing’ and screenshot the result.”  ⏎ to send · ⇧⏎ for a new line"
              onChange={(e) => {
                setDraft(e.target.value);
                // #139 — LLM-composer feel: grow with the content up to a cap.
                e.target.style.height = 'auto';
                e.target.style.height = `${Math.min(e.target.scrollHeight, 288)}px`;
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  submit();
                }
              }}
              className="form-input max-h-72 min-h-[5.5rem] flex-1 resize-none text-sm leading-relaxed"
            />
            {chat.sending ? (
              <button
                type="button"
                onClick={() => {
                  chat.cancel();
                  // Stop is a UI-only stop — the server turn may still complete on the
                  // device (audit 2026-07-08); say so instead of implying the agent halted.
                  toasts.push({
                    title: 'Stopped waiting',
                    body: 'The task may still be finishing on the device.',
                    tone: 'info',
                  });
                }}
                title="Stop waiting for this reply"
                className="shrink-0 rounded border border-surface-divider px-3 py-2 text-sm hover:bg-surface-elevated"
              >
                Stop
              </button>
            ) : (
              <button
                type="button"
                onClick={submit}
                disabled={
                  draft.trim().length === 0 ||
                  !aiReady ||
                  proxyState.kind === 'pending' ||
                  proxyState.kind === 'blocked'
                }
                title={
                  !aiReady
                    ? 'Connect your API key in Settings first'
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
            {aiReady ? (
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
      <LiveAutomationPanel
        sessionId={chat.session?.id ?? null}
        open={liveOpen}
        onClose={closeLiveView}
      />

      {/* Save-as-recipe dialog */}
      {saveOpen && (
        <div
          ref={saveDialogRef}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
          onClick={(e) => {
            if (e.target === e.currentTarget) requestCloseSaveDialog();
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
                onClick={requestCloseSaveDialog}
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
  // The deployment runs simulated (no live device driver): the token fetch 503s
  // with DriverNotIntegrated and ALWAYS will here, so this is a calm STEADY-STATE
  // that mirrors the chat's "actions are simulated" banner — NOT a transient error,
  // and Retry would just 503 forever, so it carries no Retry. (finding #2)
  | { kind: 'simulated' }
  | { kind: 'error'; message: string }; // transient token fetch failure (Retry-able)

/**
 * Read-only live iPhone view bound to the chat's agent session. When a task is
 * dispatched the chat lazily creates an agent session (useAgentChat) — a normal
 * LiveKit-streamable Driftstack session, exactly like the simulator's. This pane
 * fetches that session's LiveKit token (POST /v1/agent-sessions/:id/livekit-token
 * via the SDK) and renders the live stream so the user watches the automation
 * drive the phone in realtime.
 *
 * READ-ONLY by design: AgentSessionPanel is mounted with an explicit
 * `interactive={false}`, so the LK.6.d input-capture is NOT wired — taps /
 * scrolls / keystrokes on this video never reach the device. The agent is the
 * sole driver; the user only watches and cannot interfere by clicking the view.
 * Stated explicitly rather than relying on the prop's default, so the guarantee
 * survives a change to that default (V-859).
 */
// Perf — memoized so a composer-keystroke re-render of AgentChatView (which owns
// the `draft` state and re-renders ~10+/sec while typing) does NOT reconcile this
// live-video subtree (LiveKit room + poll + AgentSessionPanel). All three props
// are referentially stable across such a parent render: `sessionId` and `open` are
// primitives; `onClose` is a useCallback (closeLiveView) with no deps.
const LiveAutomationPanel = memo(function LiveAutomationPanel({
  sessionId,
  open,
  onClose,
}: {
  sessionId: string | null;
  /** Below the lg breakpoint the pane is hidden inline; `open` reveals it as a
   *  slide-over overlay so a narrower window doesn't silently drop the headline
   *  'watch the agent' feature. At lg+ the pane is always inline (open ignored). */
  open: boolean;
  onClose: () => void;
}): JSX.Element {
  const { client } = useSettings();
  const [watch, setWatch] = useState<WatchState>({ kind: 'idle' });
  // The token fetch's common failure is a 503: the chat session has no Mac/
  // LiveKit worker yet (driver:mock, or the dispatch is still spinning up). The
  // effect only re-runs on a sessionId/client change, so without a manual retry
  // the user was stranded on the error with no way to re-attempt short of
  // switching chats. Bumping this re-runs the fetch on the Retry button.
  const [retryNonce, setRetryNonce] = useState(0);

  // Only do the expensive work (livekit token fetch → room connect → 5s poll) when the
  // pane is actually VISIBLE: at lg+ it's always the inline column; below lg it's hidden
  // until opened. Without this, a narrow window with the pane closed kept a hidden WebRTC
  // room + poll alive for the whole chat (audit 2026-07-08). matchMedia may be absent in a
  // test/headless env → default to active so behavior is unchanged there.
  const [isLg, setIsLg] = useState(
    () =>
      typeof window === 'undefined' ||
      typeof window.matchMedia !== 'function' ||
      window.matchMedia('(min-width: 1024px)').matches,
  );
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
    const mq = window.matchMedia('(min-width: 1024px)');
    const onChange = (): void => setIsLg(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  const active = isLg || open;

  useEffect(() => {
    // Pane not visible (narrow window, closed) → don't open a live stream nobody can see.
    if (!active) {
      setWatch({ kind: 'idle' });
      return undefined;
    }
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
        // finding #2 — a 503/DriverNotIntegrated means this deployment has NO live
        // device driver: the token fetch 503s now and ALWAYS will, so a Retry loops
        // forever. Surface it as the calm "simulated deployment" steady-state that
        // mirrors the chat's banner (no Retry), NOT a transient error. A genuine
        // network/transport failure stays the Retry-able 'error' branch.
        setWatch(classifyLiveViewError(err));
      });
    return () => {
      cancelled = true;
    };
  }, [client, sessionId, retryNonce, active]);

  // finding #3 — react to the agent session ending. The token fetch above is
  // one-shot (it only re-runs on a sessionId/client/retry change), so a session
  // reaped server-side mid-chat (idle reaper / worker browser closed) left the
  // pane holding a DEAD token: AgentSessionPanel then fell into its publisher-lost
  // / disconnected branch and surfaced the scary "Couldn't start the session — the
  // proxy or connection may be down" overlay, implying broken infra when the
  // session merely ended normally. Poll the chat's agent-session lifecycle (the
  // SAME ~5s GET the simulator runs) and latch the terminal end so AgentSessionPanel
  // shows its honest "Session ended" overlay instead. Only polls while a live
  // stream is up and stops once ended (a closed session never un-closes).
  const [sessionEnded, setSessionEnded] = useState<{ reason: string | null } | null>(null);
  // A fresh session id (or no session) clears any prior terminal-end latch.
  useEffect(() => {
    setSessionEnded(null);
  }, [sessionId]);
  useEffect(() => {
    if (sessionId === null || watch.kind !== 'live' || sessionEnded !== null) return undefined;
    if (client === null || typeof client.agentSessions?.get !== 'function') return undefined;
    let cancelled = false;
    const poll = (): void => {
      void client.agentSessions
        .get(sessionId)
        .then((s) => {
          if (cancelled) return;
          // Terminal when the lifecycle status is 'closed' OR a close timestamp /
          // reason is set (worker browser closed / destroyed / orphan-swept). A
          // transient transport drop stays status='active' so the panel's own
          // bounded reconnect still runs — we only latch a REAL end.
          const ended =
            s.status === 'closed' ||
            (typeof s.closed_at === 'string' && s.closed_at.length > 0) ||
            (typeof s.closed_reason === 'string' && s.closed_reason.length > 0);
          if (ended) setSessionEnded({ reason: s.error_event?.code ?? s.closed_reason });
        })
        .catch(() => undefined); // a transient GET failure is not a terminal end
    };
    poll();
    const handle = setInterval(poll, 5_000);
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
  }, [client, sessionId, watch.kind, sessionEnded]);

  return (
    <aside
      data-component="ai-automation-live-pane"
      // lg+: always an inline right column (flex). Below lg: hidden UNLESS
      // toggled open, then a fixed full-height slide-over on the right edge so
      // the feature stays reachable on a narrow window. (audit)
      className={`w-[300px] shrink-0 flex-col border-l border-surface-divider bg-surface-raised/60 lg:flex ${
        open
          ? 'fixed inset-y-0 right-0 z-40 flex shadow-2xl lg:static lg:z-auto lg:shadow-none'
          : 'hidden'
      }`}
    >
      <div className="flex items-center gap-2 border-b border-surface-divider px-3 py-2.5">
        <span className="text-xs font-medium text-ink-primary">Live view</span>
        {/* finding #2 — only claim "the agent is driving" once a stream is actually
            up. Before that (and in the simulated deployment) say what the pane IS so
            it doesn't over-promise a live iPhone the deployment can't show. */}
        <span className="text-2xs text-ink-muted">
          {watch.kind === 'live' ? 'read-only — the agent is driving' : 'read-only'}
        </span>
        {/* Close affordance for the below-lg overlay (no-op visual at lg+ where
            the pane is a permanent column). */}
        <button
          type="button"
          aria-label="Close live view"
          onClick={onClose}
          className="ml-auto rounded px-1 text-sm leading-none text-ink-muted hover:text-ink-primary lg:hidden"
        >
          ×
        </button>
      </div>
      <div className="flex flex-1 items-center justify-center overflow-hidden p-3">
        {watch.kind === 'idle' && (
          <WatchPlaceholder
            title="Nothing running yet"
            body="Dispatch a task — the live device view turns on when the live driver is enabled for this deployment."
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
        {/* Simulated deployment: a calm steady-state that mirrors the chat banner.
            NO Retry (it would 503 forever); this is a deployment capability, not a
            transient failure the user can act on. */}
        {watch.kind === 'simulated' && (
          <WatchPlaceholder
            title="Live view unavailable"
            body="Browser actions are simulated in this deployment, so no live device stream is available."
            tone="muted"
          />
        )}
        {watch.kind === 'error' && (
          <WatchPlaceholder
            title="Live view unavailable"
            body={watch.message}
            tone="muted"
            onRetry={() => setRetryNonce((n) => n + 1)}
          />
        )}
        {watch.kind === 'live' && (
          // READ-ONLY: `interactive` omitted (defaults false) → no input capture.
          // coverChromeBand reuses the simulator's bezel-black letterbox so there
          // is no white-space border around the stream.
          // finding #3 — sessionEnded latches the chat's agent-session terminal end
          // so AgentSessionPanel shows its honest "Session ended" overlay instead of
          // the scary "proxy may be down" / endless-reconnect overlays once a reaped
          // or worker-closed session leaves this pane holding a dead token.
          <AgentSessionPanel
            info={watch.info}
            interactive={false}
            coverChromeBand
            aspectRatio={IPHONE_WATCH_ASPECT_RATIO}
            sessionEnded={sessionEnded}
          />
        )}
      </div>
    </aside>
  );
});

/** finding #2 — classify a live-view token-fetch failure into the right WATCH
 *  STATE, not just copy. The dominant failure here is the 503/DriverNotIntegrated a
 *  chat session returns when the deployment runs simulated (no live device driver):
 *  that NEVER recovers, so a Retry button loops 503 forever. Map it to the calm
 *  `simulated` steady-state (mirrors the chat banner, no Retry). Genuine auth,
 *  session, rate, service, and transport failures stay Retry-able with bounded,
 *  actionable copy. Raw exception text never reaches WatchPlaceholder. */
function classifyLiveViewError(
  err: unknown,
): { kind: 'simulated' } | { kind: 'error'; message: string } {
  const status = (err as { status?: number } | null)?.status;
  const msg = err instanceof Error ? err.message : '';
  if (
    status === 503 ||
    /driver\s*not\s*integrated|live driver (?:is )?(?:disabled|not enabled)/i.test(msg)
  ) {
    return { kind: 'simulated' };
  }
  if (status === 401) {
    return {
      kind: 'error',
      message: 'Your sign-in or API key was not accepted. Check Settings, then retry.',
    };
  }
  if (status === 403) {
    return {
      kind: 'error',
      message:
        "This live view isn't available for the current session or API key. Start a new session or check Settings, then retry.",
    };
  }
  if (status === 404) {
    return {
      kind: 'error',
      message: 'This live session is no longer available. Start a new session and try again.',
    };
  }
  if (status === 429) {
    return {
      kind: 'error',
      message: 'The server is receiving too many requests. Wait a moment, then retry.',
    };
  }
  if (status !== undefined && status >= 500) {
    return {
      kind: 'error',
      message: 'The live-stream service is temporarily unavailable. Try again shortly.',
    };
  }
  if (/load failed|network|fetch|ECONN|getaddrinfo|timeout|unreachable/i.test(msg)) {
    return {
      kind: 'error',
      message: "Couldn't reach the live-stream server — check your connection, then retry.",
    };
  }
  return {
    kind: 'error',
    message: humanizeError(err, 'Could not start the live view. Try again.'),
  };
}

function WatchPlaceholder({
  title,
  body,
  tone = 'default',
  onRetry,
}: {
  title: string;
  body: string;
  tone?: 'default' | 'muted';
  /** When set, a small Retry button re-attempts the live-view token fetch. */
  onRetry?: () => void;
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
      {onRetry !== undefined && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-1 rounded border border-surface-divider px-2 py-1 text-2xs font-medium text-ink-secondary transition-colors hover:text-ink-primary"
        >
          Retry
        </button>
      )}
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
  // Which chats are showing their turn breakdown. Local and deliberately not
  // persisted: it is a reading position, not a preference.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const toggleExpanded = useCallback((id: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }, []);
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
                      {/* V-1611 — the rail showed a title and a timestamp and
                          discarded the rest. `turns` has been persisted in full
                          all along, so the count costs nothing to show and is
                          the first thing that distinguishes two same-named
                          chats. */}
                      {chatTurnCount(c) > 0 && (
                        <>
                          {chatTurnCount(c)} turn{chatTurnCount(c) === 1 ? '' : 's'}
                          {' · '}
                        </>
                      )}
                      <RelativeTime
                        iso={new Date(c.updatedAt).toISOString()}
                        tooltipPrefix="Updated"
                      />
                    </span>
                  </button>
                  {c.turns.length > 0 && (
                    <button
                      type="button"
                      aria-expanded={expanded.has(c.id)}
                      aria-controls={`chat-turns-${c.id}`}
                      aria-label={`${expanded.has(c.id) ? 'Hide' : 'Show'} what happened in ${c.title}`}
                      title={expanded.has(c.id) ? 'Hide details' : 'Show what happened'}
                      onClick={() => toggleExpanded(c.id)}
                      className="shrink-0 px-1 text-ink-muted transition-colors hover:text-ink-primary"
                    >
                      <span
                        aria-hidden="true"
                        className={`inline-block transition-transform ${expanded.has(c.id) ? 'rotate-90' : ''}`}
                      >
                        ›
                      </span>
                    </button>
                  )}
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
                {expanded.has(c.id) && (
                  <ol id={`chat-turns-${c.id}`} className="flex flex-col gap-1 py-1 pl-3 pr-1">
                    {c.turns.map((t) => {
                      const summary = summariseTurn(t);
                      return (
                        <li key={t.id} className="flex gap-1.5 text-2xs leading-snug">
                          <span
                            aria-hidden="true"
                            className={`mt-1 h-1 w-1 shrink-0 rounded-full ${
                              summary.role === 'user'
                                ? 'bg-ink-muted'
                                : summary.ok === false
                                  ? 'bg-status-error'
                                  : 'bg-accent'
                            }`}
                          />
                          <span
                            className={
                              summary.ok === false
                                ? 'break-words text-status-error'
                                : 'break-words text-ink-secondary'
                            }
                          >
                            <span className="sr-only">
                              {summary.role === 'user' ? 'You: ' : 'Agent: '}
                            </span>
                            {summary.headline}
                          </span>
                        </li>
                      );
                    })}
                  </ol>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}

// ─── turn rendering ───────────────────────────────────────────────

/** Honest boundary between restored (read-only) history and a fresh session.
 *  Reopening a saved chat does NOT reattach the old agent session — the run-loop
 *  rebuilds context from the server transcript, which for a brand-new session is
 *  empty. So tell the customer plainly that continuing won't carry the above as
 *  memory, instead of pretending it's one seamless conversation. */
function RestoredHistoryDivider(): JSX.Element {
  return (
    <li data-component="ai-chat-restored-history-divider" className="flex items-center gap-2 py-1">
      <span className="h-px flex-1 bg-surface-divider" aria-hidden="true" />
      <span className="text-2xs text-ink-muted">
        Saved history above · continuing starts a new session — the agent won&apos;t remember it
      </span>
      <span className="h-px flex-1 bg-surface-divider" aria-hidden="true" />
    </li>
  );
}

// Memoized: the transcript is mapped in the same component that owns the composer
// `draft` state, so without this EVERY keystroke re-rendered every turn row (input lag
// in a long chat — audit 2026-07-08). Props are a stable turn ref + a boolean, so memo
// bails on a keystroke and only the changed/added row re-renders.
const TurnRow = memo(function TurnRow({
  turn,
  denied,
}: {
  turn: ChatTurn;
  denied: boolean;
}): JSX.Element {
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
        {turn.response !== undefined && (
          <AgentResponseBody response={turn.response} denied={denied} />
        )}
      </div>
    </li>
  );
});

function AgentResponseBody({
  response,
  denied,
}: {
  response: AgentMessageResponse;
  denied: boolean;
}): JSX.Element {
  switch (response.kind) {
    case 'plan-executed':
      return (
        <div className="flex flex-col gap-1.5">
          {response.results.length === 0 ? (
            // A plan that executed ZERO steps — the decomposer produced no runnable
            // browser actions for this request (the #139 "responds without steps" /
            // "it did nothing" class). Render an honest, actionable message instead of a
            // bare empty "Plan" heading, which reads as a silent bug (server also now
            // converts an empty plan to a clarify, so this is defence-in-depth).
            <p className="text-sm text-ink-primary">
              I couldn’t turn that into browser actions to run. Try rephrasing it as a concrete step
              — e.g. “go to example.com and take a screenshot.”
            </p>
          ) : (
            <>
              <p className="section-label">Plan</p>
              <ol className="flex flex-col gap-1">
                {response.results.map((r, i) => (
                  <PlanStep key={i} result={r} denied={denied} />
                ))}
              </ol>
            </>
          )}
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
    default:
      // Robustness (#14): a persisted chat rehydrated from a newer/older build, or a
      // server that ships a response.kind this build doesn't know, must not render a
      // bare empty bubble (an unhandled switch returns undefined → blank React node).
      // Fall back to a neutral, honest message instead.
      return <p className="text-sm text-ink-muted">This step can’t be shown in this version.</p>;
  }
}

function PlanStep({ result, denied }: { result: AgentIntentResult; denied: boolean }): JSX.Element {
  const { glyph, cls, text } = describeResult(result, denied);
  // doc-132 §5.3 — the server's structured diagnosis (optional; older servers
  // omit it). Only the retryable hint is surfaced as a chip: the category's
  // human framing already lives in the reason text, but "worth retrying" vs
  // "change the request" is a real decision the customer makes per failed step.
  const retryable = result.kind === 'failure' && result.diagnosis?.retryable === true;
  return (
    <li className="flex items-start gap-1.5 text-xs">
      <span className={`mt-px shrink-0 ${cls}`} aria-hidden="true">
        {glyph}
      </span>
      <span className="text-ink-secondary">
        {text}
        {retryable && (
          <span className="ml-1.5 rounded-full bg-status-busy/10 px-1.5 py-px text-2xs text-status-busy">
            worth retrying
          </span>
        )}
      </span>
    </li>
  );
}

function describeResult(
  result: AgentIntentResult,
  denied: boolean,
): { glyph: string; cls: string; text: string } {
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
      // Once the customer has DENIED this turn, the paused step is resolved — show it
      // as skipped/denied (muted) rather than the ⏸ busy framing, which reads as still
      // waiting for a decision that will never come (#135 GUI sweep).
      return denied
        ? {
            glyph: '🚫',
            cls: 'text-ink-muted',
            text: `${intentLabel(result.intent)} — denied, skipped (“${result.matchedText}”)`,
          }
        : {
            glyph: '⏸',
            cls: 'text-status-busy',
            text: `${intentLabel(result.intent)} — confirmation required (“${result.matchedText}”)`,
          };
    default:
      // Robustness (#14): an unknown result.kind from a newer server / rehydrated chat
      // must not fall through to `undefined` — PlanStep destructures { glyph, cls, text }
      // from this and would throw on undefined. Render a neutral, honest step instead.
      return {
        glyph: '•',
        cls: 'text-ink-muted',
        text: 'This step can’t be shown in this version.',
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
    default:
      // Robustness (#14): a newer server (or a rehydrated persisted chat) may carry an
      // intent.kind this build doesn't model. Surface the raw kind rather than letting
      // the switch fall through to `undefined`, which would render literal 'undefined —
      // <reason>' inside describeResult's failure/confirmation text.
      return (intent as { kind?: string }).kind ?? 'action';
  }
}

function UsageBadge({ usage }: { usage: AgentUsage }): JSX.Element {
  const parts: string[] = [];
  if (usage.cost_usd_cents !== undefined) parts.push(`$${(usage.cost_usd_cents / 100).toFixed(4)}`);
  const tokens = (usage.anthropic_input_tokens ?? 0) + (usage.anthropic_output_tokens ?? 0);
  if (tokens > 0) parts.push(`${tokens} tok`);
  if (usage.model !== undefined) parts.push(modelLabel(usage.model));
  // Nothing customer-meaningful to show (no cost/tokens/model) — render nothing
  // rather than leaking the internal decomposer_kind enum (journey audit L5).
  if (parts.length === 0) return <></>;
  return <span className="mono text-2xs text-ink-muted">{parts.join(' · ')}</span>;
}

function TypingRow({ label }: { label: string }): JSX.Element {
  return (
    <li className="flex justify-start">
      <div
        role="status"
        aria-label={label}
        className="flex items-center gap-2 rounded-lg rounded-bl-sm border border-surface-divider bg-surface-raised px-3 py-2.5"
      >
        <span aria-hidden="true" className="flex items-center gap-1">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-ink-muted" />
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-ink-muted [animation-delay:150ms]" />
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-ink-muted [animation-delay:300ms]" />
        </span>
        {/* Coarse phase so a multi-second run isn't one opaque dot (journey H3):
            "Starting a session…" while create() is in flight (no session yet),
            "Working on your request…" once the message is running server-side. */}
        <span className="text-xs text-ink-muted">{label}</span>
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
      {/* Show the percentage inline — a bare bar with no number read as
          meaningless (journey audit L5); the hover title keeps the exact ratio. */}
      <span className="text-2xs tabular-nums text-ink-muted">{Math.round(pct)}%</span>
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
