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
//
// ─── what lives where (stage 0 of the AI-view rebuild, spec §9) ───
//
// This file used to be ~2,500 lines: the state wiring AND every piece of the
// picture. The pieces now live in `views/agent-chat/`, one per thing the
// customer looks at — `ChatRail`, `MissionBar`, `Stage` (over the memo'd
// `LiveAutomationPanel`), `Turn`, `PlanTimeline`, `AnswerCard`, `ApprovalDock`,
// `Composer`, `IdleHero`, plus `icons`, `notices` and the pure `mission-phase`.
// The split moved NO DOM: stage 0's whole proof is that the rendered pixels and
// the whole suite are unchanged.
//
// What stayed here is the wiring that has to be in one place: the chat session
// from the provider, the egress-proxy resolution, the saved-chat list, the
// save-as-task dialog, and the effects that keep those in step. And the
// re-exports below, so nothing that imported `describeResult`,
// `summariseChatTurn` or a notice constant FROM THIS FILE had to change.

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type AgentSession } from '@driftstack/sdk';
import { describeAgentSessionState } from '../lib/session-liveness';
import { useSettings } from '../lib/SettingsContext';
import { useConnectionStatus } from '../lib/use-connection-status';
import { useConfirm } from '../components/ConfirmProvider';
import { useFocusTrap } from '../lib/use-focus-trap';
import { humanizeError } from '../lib/humanize-error';
import { useToasts } from '../lib/toasts';
import { modelNeedsOwnKey } from '../lib/chat-models';
import { DEFAULT_AGENT_MODEL } from '@driftstack/api-types';
import { useAgentChatSession } from '../lib/AgentChatProvider';
import {
  loadChats,
  upsertChat,
  deleteChat,
  deriveChatTitle,
  type StoredChat,
} from '../lib/chat-history';
import { listProxies, type ProxyConfig } from '../lib/proxies';
import { listBindings } from '../lib/profile-bindings';
import { ensureAccountProxyRow } from '../lib/proxy-server-test';
import { ApprovalDock, confirmationHost, gatedStepTaps } from './agent-chat/ApprovalDock';
import { ChatRail } from './agent-chat/ChatRail';
import { Composer, growComposerToFit } from './agent-chat/Composer';
import { GateCard, IdleHero } from './agent-chat/IdleHero';
import { IconEye, IconKey } from './agent-chat/icons';
import { MissionBar } from './agent-chat/MissionBar';
import { REATTACHING_NOTICE } from './agent-chat/notices';
import { Stage } from './agent-chat/Stage';
import {
  LiveTurnRow,
  RestoredHistoryDivider,
  TurnRow,
  TypingRow,
  type TurnActions,
} from './agent-chat/Turn';
import { missionPhase } from './agent-chat/mission-phase';
import { liveChatStatus } from './agent-chat/mission-status';
import { useShortView } from './agent-chat/use-short-view';
import { useViewTier } from './agent-chat/use-view-width';
import { useStickToBottom } from './agent-chat/use-stick-to-bottom';

// ─── re-exports: the view's public surface is unchanged by the split ───
//
// `describeResult` and `summariseChatTurn` have unit tests that import them from
// HERE, and the notice constants are read by the reattach test the same way.
// Their bodies moved; the import path did not.
export { describeResult } from './agent-chat/PlanTimeline';
export { summariseChatTurn } from './agent-chat/chat-turn-summary';
export {
  REATTACHING_NOTICE,
  SEND_HELD_SUFFIX,
  STILL_FINISHING_NOTICE,
  STOPPING_NOTICE,
  STOP_AGAIN_LABEL,
} from './agent-chat/notices';

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
 *  operator-default egress, same as today).
 *
 *  (q) Items 2 / 13(a) — no longer a copy: the SAME step the Profiles launch
 *  runs (lib/proxy-server-test.ensureAccountProxyRow), which normalises a
 *  STORED refusable OpenVPN blob before the PUT. The chat launch of an unopened
 *  legacy `script-security 2` row used to block identically to the grid's
 *  (`Line 46: …` from the server), because this copy forwarded `p.openvpn`
 *  verbatim too. */
async function ensureServerProxyId(
  p: ProxyConfig,
  baseUrl: string,
  apiKey: string | null,
): Promise<string | undefined> {
  const ensured = await ensureAccountProxyRow(p, baseUrl, apiKey);
  return ensured?.id;
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
  const [profiles, setProfiles] = useState<ReadonlyArray<{ id: string; name: string }>>([]);
  // null = unknown; see the effect that reads it.
  const [hasOwnKey, setHasOwnKey] = useState<boolean | null>(null);
  const [draft, setDraft] = useState('');
  // (l) #8 — the customer pressed Enter while a reopened chat was still
  // reattaching: the send is held, and the caption says so until it settles.
  const [sendHeldByAdopt, setSendHeldByAdopt] = useState(false);
  // #20 — the composer textarea, so picking a template can focus it, drop the
  // caret at the end, and grow it to fit the inserted prompt (mirrors the
  // onChange auto-grow) instead of leaving a cramped, unfocused box.
  const composerRef = useRef<HTMLTextAreaElement>(null);
  // The scrolling column the transcript lives in. Stage 2 follows the newest
  // content in it — but only for a customer who was already at the bottom.
  const logRef = useRef<HTMLDivElement>(null);
  // The mission column. Stage 5 measured its HEIGHT for the short tier; stage 6
  // moved that measurement to the view root (the bar left the column, so the two
  // boxes stopped being the same one — see `shortView` below). The ref stays:
  // stage 4 makes this element the container spec §1's tiers are written
  // against, and nothing else in the view can point at it.
  const columnRef = useRef<HTMLDivElement>(null);
  // The WHOLE view — the box spec §1's width tiers are written against (the
  // rail is inside it, so the chat column alone cannot answer "is the rail a
  // strip?"). Stage 4 is where this becomes a real container.
  const viewRef = useRef<HTMLDivElement>(null);
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
  // B5 — the chat lives ABOVE the view switch, so leaving this view no longer
  // tears the hook down and closes a running session. Its identity and the
  // customer's picks live up there too: this view re-mounts on every switch
  // back, and anything seeded by `useState` here would reset while the
  // conversation carried on (a second copy of it in the history rail, under a
  // new id and a default model, per round trip). Only the proxy — which the
  // view resolves over the network — is pushed up.
  const {
    chat,
    setChatOptions,
    chatId,
    setChatId,
    model,
    setModel,
    profileId,
    setProfileId,
    createdAtRef,
    // GALLERY SEAM (spec §8): both undefined in the app — only a visual-harness
    // scene ever sets them, so the gates can measure this view in states that
    // otherwise need a live device on the other end of a stream.
    standIn,
    captureSrc,
  } = useAgentChatSession();
  useEffect(() => {
    setChatOptions(proxyId !== undefined ? { proxyId } : {});
  }, [setChatOptions, proxyId]);
  const started = chat.turns.length > 0;
  // (l) #8 — the "held" caption belongs to ONE reattach: it goes when that settles.
  useEffect(() => {
    if (!chat.adopting) setSendHeldByAdopt(false);
  }, [chat.adopting]);

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
  const toggleLiveView = useCallback(() => setLiveOpen((v) => !v), []);
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
  // `activeChatId` and `createdAtRef` come from the provider (see the chat
  // destructure above): they identify the CONVERSATION, which now outlives this
  // component.
  const activeChatId = chatId;
  const setActiveChatId = setChatId;
  // Set when we've just restored a chat for READING (handleSelectChat). The
  // persist effect skips the single turns-change the restore itself causes, so
  // merely opening an old chat to re-read it does NOT bump its updatedAt or
  // re-sort it to the top of the rail (sweep2). A real new turn afterwards clears
  // it and persists normally.
  const justRestoredRef = useRef(false);
  useEffect(() => {
    void loadChats().then(setChats);
  }, []);
  // P2 #6 — adopt the deep-linked profile, and re-adopt it when a later
  // deep-link names a DIFFERENT one while this view stays mounted. Applied on a
  // REAL change only (a defined, different value) so a manual in-session
  // selection isn't clobbered by an unchanged/absent prop on every render, and
  // never over a conversation that has already started — the picker is locked by
  // then, and the profile the chat actually ran with is the one to keep. The ref
  // starts UNSET (not seeded with the prop) because `profileId` now lives in the
  // provider: this effect is the seeding, not just the sync.
  const prevInitialProfileIdRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    const changed = initialProfileId !== prevInitialProfileIdRef.current;
    prevInitialProfileIdRef.current = initialProfileId;
    if (initialProfileId === undefined || !changed) return;
    if (chat.turns.length > 0) return;
    setProfileId(initialProfileId);
  }, [initialProfileId, chat.turns.length, setProfileId]);
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
    // A new chat never starts on a model this account cannot run. Reopening an
    // Opus chat puts Opus in the picker (it has to show what that chat ran on),
    // and a New chat from there would otherwise sit on a disabled option and
    // send straight into the own-key refusal. Only a KNOWN "no key" moves it.
    if (hasOwnKey === false && modelNeedsOwnKey(model)) setModel(DEFAULT_AGENT_MODEL);
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
  /** (l) #12 — retry the reattach of the ACTIVE chat's session after a GET that
   *  failed for a non-404 reason (the hook keeps `adopting` true meanwhile). */
  function retryAdopt(): void {
    const active = chats.find((c) => c.id === activeChatId);
    const sid = active?.sessionId;
    if (typeof sid === 'string' && sid !== '') chat.adopt(sid);
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

  // Whether the account has its own Anthropic key, read once per mount of this
  // view (it re-mounts on every visit, so coming back from Settings refreshes
  // it) — never polled. Only a KNOWN `false` marks the own-key-only models in
  // the picker: unknown (no answer yet, an older client with no account API, a
  // member who may not read it, any failure) leaves every model selectable, and
  // the turn's own refusal explains itself if the key is missing after all. A
  // stored key can also have expired while still reading `has_key: true`, which
  // is the same refusal path.
  useEffect(() => {
    setHasOwnKey(null);
    if (client === null || typeof client.account?.getByokAnthropicKey !== 'function') {
      return undefined;
    }
    let cancelled = false;
    let pending: Promise<{ has_key: boolean }>;
    try {
      pending = client.account.getByokAnthropicKey();
    } catch {
      return undefined;
    }
    void pending.then(
      (k) => {
        if (!cancelled) setHasOwnKey(typeof k?.has_key === 'boolean' ? k.has_key : null);
      },
      () => undefined,
    );
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
      growComposerToFit(el);
    });
  }

  /** Put text in the composer and leave the caret in it — the suggestion under
   *  a failed step, and the same hand-off a template makes. Nothing is sent. */
  function fillComposer(text: string): void {
    handlePickTemplate(text);
  }

  /**
   * "Continue from here" — the honest action under a failure. There is no
   * step-retry API: the server carries on from the page the browser is already
   * on when it is sent "continue", so that is exactly what this sends. It runs
   * the SAME guards Send does, because it reaches the same place.
   */
  function continueFromHere(): void {
    if (chat.sending || !aiReady || chat.adopting || chat.stoppedTurnStillRunning) return;
    if (proxyState.kind === 'pending' || proxyState.kind === 'blocked') return;
    void chat.send('continue');
  }

  /** Focus the composer for a follow-up, without putting words in it. */
  function askFollowUp(): void {
    composerRef.current?.focus();
  }

  /** Open the save-as-task dialog — the same one the bar's button opens. */
  function openSaveDialog(): void {
    setSaveError(null);
    setSaveOpen(true);
  }

  // ⛔ THIS OBJECT'S IDENTITY IS LOAD-BEARING. `TurnRow` is `React.memo` so that
  // a keystroke in the composer — whose `draft` state lives in THIS component —
  // does not re-render every turn in the transcript (the 2026-07-08 input-lag
  // audit). `memo` compares props shallowly, so a fresh `{…}` here would make
  // that compare fail for every row on every keystroke and silently undo it.
  // The handlers are read through a ref that is refreshed on every render, so
  // they always call the newest closure while the object handed down changes
  // only when one of the two things a turn can SEE changes.
  // (typing-a-message-does-not-re-render-the-turns-above-it.test.tsx counts it.)
  const live = useRef({ continueFromHere, fillComposer, askFollowUp, openSaveDialog });
  live.current = { continueFromHere, fillComposer, askFollowUp, openSaveDialog };
  const sessionActive = chat.session !== null;
  const turnActions: TurnActions = useMemo(
    () => ({
      onContinue: () => {
        live.current.continueFromHere();
      },
      onSuggest: (text: string) => {
        live.current.fillComposer(text);
      },
      onSaveAsTask: canSaveRecipe
        ? () => {
            live.current.openSaveDialog();
          }
        : undefined,
      onAskFollowUp: () => {
        live.current.askFollowUp();
      },
      sessionActive,
    }),
    [canSaveRecipe, sessionActive],
  );

  // Follow the newest content — and only for a customer who is already at the
  // bottom. While a turn RUNS the newest step is the thing to look at; once it
  // settles with an answer, the answer is, so the log anchors on the card
  // rather than on the last row of a plan that pushed it off the screen.
  useStickToBottom(
    logRef,
    [chat.turns.length, chat.liveSteps?.length ?? 0, chat.liveAnswer, chat.sending, started],
    { anchorSelector: chat.sending ? null : '.ai-result', enabled: started },
  );

  // What the AI is doing, as ONE word (spec §3.1). Stage 4 hangs the room light,
  // the device rim and the stage caption off it; stage 5 needs it for one thing
  // the approval gate promises — while the gate is up NOTHING in the view moves,
  // and "nothing" is a rule the CSS can only apply if it knows the phase.
  const phase = missionPhase(chat);
  // D6 — measured, not guessed, and false where nothing can measure. It buys the
  // empty composer's fifth row back for the templates at the 600px-tall minimum.
  // ⛔ THE VIEW'S BOX, NOT THE COLUMN'S — and it used to be the same box. Stage
  // 5 measured `columnRef` because the column was full height; stage 6 lifted
  // the bar out of it into the deck, so the column is now 52px shorter than the
  // view. Spec §1 writes this tier as `@container aiview (max-height: 620px)` —
  // the VIEW — so pointing it at the view root keeps the number stage 5
  // measured (564px at the 960x600 minimum) instead of silently moving the
  // short tier 52px up the window.
  const shortView = useShortView(viewRef);
  // Spec §1's width tiers, measured on the view's own box. `narrow` turns the
  // rail into the 44px strip and the bar into its 44px form; `wide` only
  // spells the budget out, and is CSS-only.
  const tier = useViewTier(viewRef);
  // What the chat being worked on is doing, in the words the rail's active row
  // shows (spec §3.2). One derivation, shared by the row and the strip's dot.
  const liveStatus = liveChatStatus(chat);

  function submit(): void {
    const text = draft.trim();
    // Don't fire a doomed request when there's no API key connected — it would
    // dead-air then surface a server error. The Send button is disabled too;
    // this also guards the Enter-to-send path.
    //
    // `chat.adopting`: reopening a chat fires a background adopt() that reattaches to
    // its still-live server session. Sending before it settles would instead create a
    // NEW session "continuing from" that still-active id, which the server rejects with
    // a 409 surfaced as "The item changed or is busy." Once adopt settles, an active
    // session is adopted (the send messages it) and a closed one is continued cleanly.
    if (text.length === 0 || chat.sending || !aiReady) return;
    // (l) #8 — Enter while the reattach is in flight used to be a silent no-op
    // whose only explanation was the disabled Send button's hover title. Say
    // so where the customer is looking: the composer caption (and the notice
    // row above it) name the hold; the draft is kept for when it settles.
    if (chat.adopting) {
      setSendHeldByAdopt(true);
      return;
    }
    // P6 — the SAME guard as the Send button's `disabled`, here, because this
    // function is also what ⏎ calls and the composer's own placeholder tells the
    // customer to press it. Guarding only the button left the doomed send one
    // keystroke away — it would reach a session that is still finishing the
    // stopped turn and come back refused, which is the 409 this item exists to
    // remove. The draft is deliberately NOT cleared: the customer keeps what
    // they typed, and the composer caption above already says why nothing
    // happened.
    if (chat.stoppedTurnStillRunning) return;
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
      // A failed turn now KEEPS the customer's message in the transcript (with
      // an interrupted agent turn beside it), so putting it back in the composer
      // too would show the same sentence twice. A soft Stop still removes the
      // bubble, and there the draft restore is exactly right.
      if (!ok && !chat.lastSendKeptMessage()) setDraft((d) => (d.length === 0 ? text : d));
    });
  }

  return (
    // `data-ai-phase` is the one word the whole view is keyed on (spec §3.1).
    // Stage 5 uses it for a single promise: while the approval gate is up, the
    // calm is LITERAL — every infinite animation in the view stops.
    <div
      ref={viewRef}
      className="flex h-full bg-surface-base"
      data-ai-phase={phase}
      /* ⛔ VALUELESS OR ABSENT, never `false`. React renders `data-x={false}`
         as the STRING "false", which a `[data-ai-narrow]` selector matches —
         the whole view would wear the strip layout at every width. */
      data-ai-narrow={tier.narrow ? '' : undefined}
      data-ai-wide={tier.wide ? '' : undefined}
    >
      <ChatRail
        chats={chats}
        activeId={activeChatId}
        busy={chat.sending}
        narrow={tier.narrow}
        liveStatus={liveStatus}
        onNew={handleNewChat}
        onSelect={handleSelectChat}
        onDelete={handleDeleteChat}
      />
      {/* THE DECK — the bar, and under it everything the bar is about.
          ⛔ THIS WRAPPER IS WHY THE BAR CAN BE ONE ROW. Until stage 6 the header
          lived INSIDE the chat column, so at the 1280px default window it was
          laid out in 572px (the column, after the 300px live pane took its
          share) and wrapped to two rows — three at the 960px minimum. The bar
          is about the whole mission, not about the transcript, so it spans the
          deck: 872px at 1280, 692 at 960, which is what spec §1's table says.
          Stage 4 re-cuts what is UNDER it (order stage → mission, container
          queries, the device frame); this is only the box the bar sits in, and
          nothing inside either half moved. */}
      <div className="ai-deck">
        <MissionBar
          chat={chat}
          sessionState={sessionState}
          session={chat.session}
          liveOpen={liveOpen}
          onToggleLiveView={toggleLiveView}
          profileId={profileId}
          profiles={profiles}
          onProfileChange={setProfileId}
          model={model}
          onModelChange={setModel}
          hasOwnKey={hasOwnKey}
          started={started}
          sending={chat.sending}
          canSaveRecipe={canSaveRecipe}
          onSaveAsTask={() => {
            setSaveError(null);
            setSaveOpen(true);
          }}
        />
        <div className="ai-deck-body">
          <div
            ref={columnRef}
            className="flex h-full min-w-0 flex-1 flex-col"
            data-component="ai-automation-chat-column"
          >
            {/* Honest execution-mode banner — auto-updates with /version
            agent_execution (#139): shows the live indicator when AI-automation
            executes for real over the fleet control plane (prod). The PREVIEW
            half of this strip is now a gate card in the column below (spec §10);
            stage 4 replaces this live half with the stage's LIVE chip. */}
            {actionsAreLive && (
              <div className="border-b border-surface-divider bg-surface-inset px-4 py-1.5">
                <span className="text-2xs text-ink-muted">
                  <span className="mr-1 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-accent align-middle"></span>
                  Live device — Claude plans each step and runs it on a real iPhone.
                </span>
              </div>
            )}

            {/* Transcript */}
            <div ref={logRef} className="ai-log flex-1 overflow-auto px-4 py-4">
              {/* The gates that stand between the customer and a working chat, as
              cards at the top of the column (spec §3.8). ⛔ Exactly ONE
              `role="status"` may exist in the idle no-key state, and it is this
              one — the preview card beside it is a plain div. */}
              {!aiReady && (
                <GateCard
                  status
                  component="ai-api-key-gate"
                  icon={<IconKey />}
                  title="Connect your API key to run automations"
                  body="You can explore templates and draft a task now. Add your key in Settings before sending it to the browser."
                  action={
                    onGoToSettings !== undefined ? (
                      <button
                        type="button"
                        onClick={onGoToSettings}
                        className="btn-primary shrink-0 px-3 py-1.5 text-xs"
                      >
                        Connect in Settings
                      </button>
                    ) : undefined
                  }
                />
              )}
              {!actionsAreLive && (
                <GateCard
                  icon={<IconEye />}
                  title="Preview mode"
                  body="The AI plans each step, but browser actions are not carried out on a real iPhone yet."
                />
              )}
              {!started ? (
                <IdleHero
                  onPick={handlePickTemplate}
                  preview={!actionsAreLive}
                  // §3.8: the gate card above takes the beats' place, so the first
                  // screen still ends at the templates rather than below the fold.
                  gated={!aiReady}
                />
              ) : (
                <ol
                  className="mx-auto flex max-w-3xl flex-col"
                  // a11y: announce streaming assistant replies to a screen reader — focus stays
                  // in the composer after Send, so without a live region the reply arrives
                  // silently and the chat is unusable without sight (audit 2026-07-09).
                  aria-live="polite"
                  aria-relevant="additions"
                >
                  {chat.turns.map((turn, i) => (
                    <Fragment key={turn.id}>
                      <TurnRow
                        turn={turn}
                        denied={chat.deniedTurnIds.has(turn.id)}
                        // optional-chained: a partial useAgentChat double in a test may omit
                        // this newer field; the real hook always provides it. An approved
                        // consequential step renders past-tense instead of "confirmation
                        // required" forever.
                        approved={chat.approvedTurnIds?.has(turn.id) ?? false}
                        // A reopened chat has no live session, so fetch its persisted captures
                        // from the continue-from id the server still serves (LOW #9). The live
                        // id wins once the chat is live again.
                        sessionId={chat.session?.id ?? chat.restoredSessionId ?? null}
                        baseUrl={settings.baseUrl}
                        apiKey={settings.apiKey}
                        captureSrc={captureSrc}
                        // The first row in the log draws no separator above it, and
                        // an earlier brief clamps to one line: the thing to read now
                        // is the newest turn, not the question that started it.
                        first={i === 0}
                        past={i < chat.turns.length - 2}
                        actions={turnActions}
                      />
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
                  {chat.sending &&
                    // B2 — the progress the server streams BEFORE any step has
                    // completed. Until this landed, Send produced three dots for 10
                    // to 30 seconds (up to ~150s at worst) with nothing to read.
                    // Each source is independently optional: a server that sends no
                    // progress falls through to exactly the old spinner.
                    (chat.livePlan !== null ||
                    chat.liveSteps.length > 0 ||
                    chat.livePhase !== null ? (
                      <LiveTurnRow
                        livePhase={chat.livePhase}
                        liveAnswer={chat.liveAnswer}
                        liveSteps={chat.liveSteps}
                        livePlan={chat.livePlan}
                        liveStepIndex={chat.liveStepIndex}
                        // §7 (stage 3) — the elapsed clock, the per-step durations
                        // and the "not finished yet" notice, each OPTIONAL on the
                        // hook's contract so the dozen tests that mock this module
                        // with a hand-built object keep type-checking and simply
                        // render a turn with no clock and no durations.
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
                        label={
                          chat.session === null ? 'Starting a session…' : 'Working on your request…'
                        }
                      />
                    ))}
                  {/* (l) #8 — the reattach in flight is visible without hovering the
                  disabled Send: the same slot the "Starting a session…" row
                  uses. A failed reattach is a notice with a retry, below. */}
                  {chat.adopting && !chat.sending && chat.adoptError === null && (
                    <TypingRow label={REATTACHING_NOTICE} />
                  )}
                </ol>
              )}
            </div>

            {/* Consequential-action confirmation gate */}
            {chat.pendingConfirmation !== null && (
              <ApprovalDock
                category={chat.pendingConfirmation.category}
                matchedText={chat.pendingConfirmation.matchedText}
                // Two facts derived from the transcript, not from the gate: whether
                // the held step presses something (one word of the next-step line)
                // and where the phone is (the "on <host>" clause, dropped entirely
                // when nothing this build can parse was navigated to).
                taps={gatedStepTaps(chat.turns, chat.pendingConfirmation.turnId)}
                host={confirmationHost(chat.turns)}
                sessionActive={sessionActive}
                sending={chat.sending}
                composerRef={composerRef}
                onDeny={() => {
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
                onApprove={() => void chat.approve()}
              />
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
                        : 'You can use bundled AI usage billed to your account, or your own Anthropic key.'}
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
            <Composer
              chat={chat}
              draft={draft}
              onDraftChange={setDraft}
              onSubmit={submit}
              composerRef={composerRef}
              aiReady={aiReady}
              proxyState={proxyState}
              sendHeldByAdopt={sendHeldByAdopt}
              short={shortView}
              onRetryAdopt={retryAdopt}
              onGoToSettings={onGoToSettings}
            />
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
          <Stage
            sessionId={chat.session?.id ?? null}
            open={liveOpen}
            onClose={closeLiveView}
            standIn={standIn}
          />
        </div>
      </div>
      {/* end deck */}

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
              Save the steps from this chat as a task you can run again from Saved tasks.
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
