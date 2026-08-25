// Chat history (2026-06-15) — persists the AI chats so the customer can keep
// multiple conversations and reopen past ones (memory), like Claude. Each chat
// is its own transcript + metadata; the most-recently-updated sorts first.
//
// Same store-isolation rationale as profiles-meta / proxy-probe-cache: its own
// file, out of settings.json's blast radius; corrupt/missing entries degrade to
// "no history" rather than breaking the AI view. Transcripts are our own data
// (ChatTurn) so validation is shallow — enough to survive a corrupt root.

import { LazyStore } from '@tauri-apps/plugin-store';
import { makeWriteLock } from './store-write-lock';
import type { ChatModel, ChatTurn } from './use-agent-chat';

/**
 * One line of history for a stored turn — everything the rail can show without
 * a network call, derived from what is already persisted.
 *
 * ⚠️ `AgentMessageResponse` is a FOUR-member discriminated union and only
 * `plan-executed` carries `intents`. A summariser that reaches for `.intents`
 * unconditionally is `undefined` on three of four turn kinds, which is exactly
 * the class of bug that took the Settings tab down today (a shape assumed
 * rather than read). Every member is handled explicitly below and the compiler
 * enforces exhaustiveness.
 */
export interface TurnSummary {
  role: 'user' | 'agent';
  /** One-line description, safe to render directly. */
  headline: string;
  /** Present only for a plan-executed turn. */
  intentCount?: number;
  /** True/false only for plan-executed; undefined where the notion is absent. */
  ok?: boolean;
}

/** Trim to a readable single line without cutting mid-word where avoidable. */
function oneLine(text: string, max = 90): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut}\u2026`;
}

/**
 * Summarise one persisted turn. PURE — no React, no clock, no I/O — so the
 * union handling is unit-testable on its own, which is the point of splitting
 * it out from the rail.
 */
export function summariseTurn(turn: ChatTurn): TurnSummary {
  if (turn.role === 'user') {
    return { role: 'user', headline: oneLine(turn.text ?? '') };
  }
  const r = turn.response;
  if (r === undefined) {
    // An agent turn with no response is a turn that never completed — a stop,
    // a transport failure, or a crash mid-stream. Saying so is more useful than
    // rendering an empty row.
    return { role: 'agent', headline: 'no response recorded' };
  }
  switch (r.kind) {
    case 'plan-executed': {
      const verbs = r.intents.map((i) => i.kind);
      const unique = [...new Set(verbs)];
      const head =
        r.intents.length === 0
          ? 'no actions'
          : `${String(r.intents.length)} action${r.intents.length === 1 ? '' : 's'} \u00b7 ${unique.join(', ')}`;
      return {
        role: 'agent',
        headline: r.ok ? head : `${head} \u2014 failed`,
        intentCount: r.intents.length,
        ok: r.ok,
      };
    }
    case 'clarify':
      return { role: 'agent', headline: `asked: ${oneLine(r.clarifying_question, 70)}` };
    case 'refuse':
      return { role: 'agent', headline: `declined: ${oneLine(r.refuse_reason, 70)}` };
    case 'logged-manual':
      return { role: 'agent', headline: 'manual mode \u2014 you drove this turn' };
  }
}

/** Count of completed exchanges, for the collapsed row. */
export function chatTurnCount(chat: StoredChat): number {
  return chat.turns.length;
}

export interface StoredChat {
  id: string;
  /** Display title — derived from the first user message (deriveChatTitle). */
  title: string;
  /** Bound profile id; '' = temporary (stateless) chat. */
  profileId: string;
  model: ChatModel;
  /** The transcript. Append-only ChatTurn list, persisted verbatim. */
  turns: ChatTurn[];
  createdAt: number;
  updatedAt: number;
  /**
   * The server session these turns were produced by, when there was one.
   *
   * OPTIONAL on purpose: every chat persisted before this field existed has
   * none, and `loadChats` validation is shallow. A missing value means "no
   * handle to reattach with" — it must never be read as "the session is gone",
   * because those are different facts and only one of them is knowable here.
   */
  sessionId?: string | null;
}

const STORE_FILE = 'agent-chats.json';
const KEY = 'chats';
const MAX_TITLE_CHARS = 60;
const MAX_CHATS = 100; // keep the freshest 100; older ones are pruned on save

let store: LazyStore | null = null;
function getStore(): LazyStore {
  if (store === null) store = new LazyStore(STORE_FILE);
  return store;
}

// Serialize read-modify-write mutations so a delete can't interleave with the
// active chat's persist-on-turn and resurrect a just-deleted chat.
const serialize = makeWriteLock();

/** First user message → a short title; 'New chat' when there's nothing yet. */
export function deriveChatTitle(turns: ReadonlyArray<ChatTurn>): string {
  for (const t of turns) {
    if (t.role === 'user' && typeof t.text === 'string' && t.text.trim().length > 0) {
      const s = t.text.trim().replace(/\s+/g, ' ');
      return s.length > MAX_TITLE_CHARS ? `${s.slice(0, MAX_TITLE_CHARS - 1)}…` : s;
    }
  }
  return 'New chat';
}

function cleanChat(raw: unknown): StoredChat | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (
    typeof r.id !== 'string' ||
    r.id.length === 0 ||
    typeof r.profileId !== 'string' ||
    typeof r.model !== 'string' ||
    !Array.isArray(r.turns) ||
    typeof r.createdAt !== 'number' ||
    typeof r.updatedAt !== 'number'
  ) {
    return null;
  }
  return {
    id: r.id,
    title: typeof r.title === 'string' && r.title.length > 0 ? r.title : 'New chat',
    profileId: r.profileId,
    model: r.model as ChatModel,
    turns: r.turns as ChatTurn[],
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

/** All chats, most-recently-updated first. */
export async function loadChats(): Promise<StoredChat[]> {
  try {
    const raw = await getStore().get<unknown[]>(KEY);
    if (!Array.isArray(raw)) return [];
    const out: StoredChat[] = [];
    for (const entry of raw) {
      const clean = cleanChat(entry);
      if (clean !== null) out.push(clean);
    }
    out.sort((a, b) => b.updatedAt - a.updatedAt);
    return out;
  } catch {
    return [];
  }
}

/** Insert or update a chat (matched by id), then persist. Returns the new list
 *  (sorted, pruned to MAX_CHATS). `at` is injected so the fn stays testable. */
export function upsertChat(chat: StoredChat, at: number): Promise<StoredChat[]> {
  return serialize(async () => {
    const all = await loadChats();
    const idx = all.findIndex((c) => c.id === chat.id);
    const merged: StoredChat = { ...chat, updatedAt: at };
    if (idx >= 0) all[idx] = merged;
    else all.push(merged);
    all.sort((a, b) => b.updatedAt - a.updatedAt);
    const pruned = all.slice(0, MAX_CHATS);
    // Best-effort persistence — a store/IO failure must not crash the chat view;
    // the returned list still drives the UI in-memory.
    try {
      await getStore().set(KEY, pruned);
      await getStore().save();
    } catch {
      /* ignore — persistence is a convenience layer */
    }
    return pruned;
  });
}

/** Remove a chat by id; returns the new list. Idempotent. */
export function deleteChat(id: string): Promise<StoredChat[]> {
  return serialize(async () => {
    const all = await loadChats();
    const next = all.filter((c) => c.id !== id);
    if (next.length === all.length) return all;
    try {
      await getStore().set(KEY, next);
      await getStore().save();
    } catch {
      /* ignore — best-effort */
    }
    return next;
  });
}
