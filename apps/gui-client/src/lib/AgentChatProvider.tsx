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
import { DEFAULT_AGENT_MODEL } from '@driftstack/api-types';
import {
  useAgentChat,
  type ChatModel,
  type UseAgentChatOpts,
  type UseAgentChatResult,
} from './use-agent-chat';

export interface AgentChatContextValue {
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
  /**
   * GALLERY SEAM (spec §8) — what the live view's screen shows INSTEAD of
   * fetching a stream token. Undefined everywhere in the app; a visual-harness
   * scene sets it so the text-quality and privacy gates can measure the running
   * / approval / done states, which otherwise need a real iPhone on a real
   * fleet to reach.
   *
   * ⛔ It is an IMAGE, not markup with text in it. Text drawn inside the phone
   * would be measured by the gate as the app's own copy — its 9px floor, its
   * contrast rule, its truncation rule — and a stand-in web page legitimately
   * has small grey type on it. `aria-hidden` does not exempt size.
   */
  standIn?: ReactNode;
  /**
   * GALLERY SEAM (spec §8) — the image every `CaptureThumbnail` in the view
   * shows INSTEAD of fetching the capture it names. Undefined in the app.
   *
   * It is one image for the whole view rather than a lookup by capture id
   * because a scene has one screenshot in it; a map would be a second thing to
   * keep in step with the fixture for no state the gates can reach.
   */
  captureSrc?: string;
  /**
   * GALLERY SEAM (spec §8) — the frame rate the live view's HUD chip SHOWS,
   * instead of measuring one off the video element. Undefined in the app: the
   * chip's number always comes from `lib/use-presented-frame-rate.ts` there.
   *
   * ⛔ A SCENE CANNOT MEASURE A PICTURE. Every scene mounts a drawn page in the
   * phone's screen (`standIn`), and a still image presents no frames, so
   * without this the chip would be absent from the only state it exists in and
   * both gates would measure a stage that has never shown it. The value is a
   * FIXTURE and is labelled as one where it is written, in the scene file —
   * never in the DOM, where a customer would read it.
   */
  frameRate?: number;
}

const AgentChatContext = createContext<AgentChatContextValue | null>(null);

/** The override's DEFINED entries only — see the `value` prop below. A plain
 *  spread of a `Partial` copies its explicit `undefined`s over real values. */
function definedOnly(
  override: Partial<AgentChatContextValue> | undefined,
): Partial<AgentChatContextValue> {
  if (override === undefined) return {};
  return Object.fromEntries(Object.entries(override).filter(([, v]) => v !== undefined));
}

/** Stable comparison for the small, flat options record. */
function sameOptions(a: UseAgentChatOpts, b: UseAgentChatOpts): boolean {
  return (
    a.model === b.model &&
    a.tokenBudget === b.tokenBudget &&
    a.profileId === b.profileId &&
    a.proxyId === b.proxyId
  );
}

export function AgentChatProvider({
  children,
  value: override,
}: {
  children: ReactNode;
  /**
   * GALLERY SEAM (spec §8) — fields to publish INSTEAD of the ones this
   * provider computes, so a fixture `UseAgentChatResult` can drive the REAL
   * `AgentChatView` through its real context. Undefined in the app: `App.tsx`
   * mounts this with children only, and nothing in `src/` outside the visual
   * harness passes it.
   *
   * ⛔ It overrides, it does not replace: the hook below still runs, so a scene
   * that overrides only `chat` keeps a real `setChatOptions` / `setModel` /
   * `createdAtRef` and the view's effects behave as they do in the app. And
   * only DEFINED keys are taken — `{ chat: undefined }` would otherwise publish
   * a context whose `chat` is missing, and every read in the view would throw
   * one render later, a long way from the cause.
   */
  value?: Partial<AgentChatContextValue>;
}): JSX.Element {
  const [resolved, setResolved] = useState<UseAgentChatOpts>({});
  // ⛔ FROM THE SHARED CONSTANT, NOT A LITERAL. The app sends its pick on every
  // session it creates, so a literal here overrode the server's default for every
  // desktop customer — moving DEFAULT_AGENT_MODEL alone would have changed nothing
  // anyone using the app sees. One constant, one default, wherever it is read.
  const [model, setModel] = useState<ChatModel>(DEFAULT_AGENT_MODEL);
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
      ...definedOnly(override),
    }),
    [chat, chatId, model, profileId, override],
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
