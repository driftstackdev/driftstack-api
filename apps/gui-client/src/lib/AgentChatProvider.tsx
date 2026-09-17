// B5 — one live AI chat, owned ABOVE the view switch.
//
// The bug this exists for: `App.tsx` renders `AgentChatView` only for the `ai`
// destination, so switching to Profiles (or Settings, or the chat's own "Use my
// own key" button, which navigates to Settings) UNMOUNTED the view. That ran
// `useAgentChat`'s teardown, which bumps the cancel generation and closes the
// server session — killing a task the customer was watching, mid-run, with no
// warning and no way back.
//
// Mounting the whole view permanently would have kept its polls and live media
// running behind the rail, which the view panel deliberately avoids. So only the
// CHAT — the thing that owns the server session — is lifted. The view still
// mounts and unmounts normally; the run does not.
//
// Session options (model / profile / proxy) stay where the customer picks them,
// in the view, and are pushed up through `setChatOptions`. The provider holds
// them in state so the hook sees the same values it did before the lift.

import {
  createContext,
  useContext,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode,
} from 'react';
import {
  useAgentChat,
  type ChatModel,
  type UseAgentChatOpts,
  type UseAgentChatResult,
} from './use-agent-chat';

interface AgentChatContextValue {
  chat: UseAgentChatResult;
  /**
   * Publish the session options the view RESOLVES rather than the customer
   * picks — today just the egress proxy the selected profile must exit through,
   * which needs a network round-trip the view already owns. Ignores an
   * identical payload, so a view effect can call it on every render without
   * churning the hook.
   */
  setChatOptions: (opts: UseAgentChatOpts) => void;
  /**
   * ⛔ The chat's IDENTITY and the picks it ran with live HERE, with the chat —
   * not in the view.
   *
   * The view still unmounts on every switch away, and once the conversation
   * started outliving it, view-local `activeChatId` / `model` / `profileId`
   * re-seeded themselves on the way back: a fresh uuid, the default model, no
   * profile. The persist effect then wrote the SAME conversation into the
   * history rail a second time under a new id with wrong metadata (and a third
   * on the next trip), while the nulled profile id propagated into the hook and
   * left the Profiles hub stuck showing a profile as running.
   */
  chatId: string;
  setChatId: (id: string) => void;
  model: ChatModel;
  setModel: (model: ChatModel) => void;
  /** '' means a temporary profile — the same sentinel the picker uses. */
  profileId: string;
  setProfileId: (profileId: string) => void;
  /** createdAt per chat id; sticky across view switches for the same reason. */
  createdAtRef: MutableRefObject<Record<string, number>>;
}

const AgentChatContext = createContext<AgentChatContextValue | null>(null);

/** Stable comparison for the small, flat options record. */
function sameOptions(a: UseAgentChatOpts, b: UseAgentChatOpts): boolean {
  return (
    a.model === b.model &&
    a.tokenBudget === b.tokenBudget &&
    a.profileId === b.profileId &&
    a.proxyId === b.proxyId
  );
}

export function AgentChatProvider({ children }: { children: ReactNode }): JSX.Element {
  const [resolved, setResolved] = useState<UseAgentChatOpts>({});
  const [model, setModel] = useState<ChatModel>('claude-opus-5');
  const [profileId, setProfileId] = useState<string>('');
  const [chatId, setChatId] = useState<string>(() => crypto.randomUUID());
  const createdAtRef = useRef<Record<string, number>>({});
  // The picks and the resolved extras are one options record again by the time
  // the hook sees them, so nothing below this line changed shape.
  const options = useMemo<UseAgentChatOpts>(
    () => ({ ...resolved, model, ...(profileId !== '' ? { profileId } : {}) }),
    [resolved, model, profileId],
  );
  const chat = useAgentChat(options);
  const value = useMemo<AgentChatContextValue>(
    () => ({
      chat,
      setChatOptions: (next) => {
        setResolved((prev) => (sameOptions(prev, next) ? prev : next));
      },
      chatId,
      setChatId,
      model,
      setModel,
      profileId,
      setProfileId,
      createdAtRef,
    }),
    [chat, chatId, model, profileId],
  );
  return <AgentChatContext.Provider value={value}>{children}</AgentChatContext.Provider>;
}

/**
 * The app-wide chat.
 *
 * ⛔ Throws when there is no provider rather than falling back to a local hook.
 * A silent fallback would look identical on screen and quietly restore the exact
 * bug this file exists to fix — a chat whose session dies on the next view
 * switch — and nothing would say so.
 */
export function useAgentChatSession(): AgentChatContextValue {
  const ctx = useContext(AgentChatContext);
  if (ctx === null) {
    throw new Error('useAgentChatSession must be used inside an AgentChatProvider');
  }
  return ctx;
}
