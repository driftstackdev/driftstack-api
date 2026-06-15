// Chat history (2026-06-15) — persists the AI chats so the customer can keep
// multiple conversations and reopen past ones (memory), like Claude. Each chat
// is its own transcript + metadata; the most-recently-updated sorts first.
//
// Same store-isolation rationale as profiles-meta / proxy-probe-cache: its own
// file, out of settings.json's blast radius; corrupt/missing entries degrade to
// "no history" rather than breaking the AI view. Transcripts are our own data
// (ChatTurn) so validation is shallow — enough to survive a corrupt root.

import { LazyStore } from '@tauri-apps/plugin-store';
import type { ChatModel, ChatTurn } from './use-agent-chat';

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
export async function upsertChat(chat: StoredChat, at: number): Promise<StoredChat[]> {
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
}

/** Remove a chat by id; returns the new list. Idempotent. */
export async function deleteChat(id: string): Promise<StoredChat[]> {
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
}
