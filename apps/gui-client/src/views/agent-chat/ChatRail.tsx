// The saved-chat history rail.
//
// Stage 6 of the AI-view rebuild (spec §3.2). What it adds to the list of
// titles and timestamps that shipped: a DAY GROUPING (Today / Yesterday /
// Earlier), an outcome dot per chat, a meta line that says what the chat is
// doing right now when it is the one running, and — at the narrow tier — a
// 44px strip that gives the mission column back 140px of width.
//
// Three rules the rail is written to:
//
//   1. ⛔ THE DOT IS NEVER THE ONLY SIGNAL. Every state it can show, the meta
//      line says in words: "Running · step 4 of 6", "Needs your approval",
//      "Didn’t finish". A colour is a nice second reading of something already
//      readable, never the message.
//   2. ⛔ THE EMPTY PATH TOUCHES NOTHING IN `lib/chat-history`. About a dozen
//      view tests `vi.mock` that module with three or four exports; a rail that
//      called `chatTurnCount` before it had a row to count would throw in every
//      one of them. `chatOutcome` exists for the same reason one level up — see
//      chat-turn-summary.ts.
//   3. ⛔ EXACTLY ONE BUTTON IS EVER NAMED `+ New chat`. The strip's `+` and the
//      full rail's button are the same command, and rendering both would make
//      `getByRole('button', { name: '+ New chat' })` ambiguous — the pin that
//      the model picker's own-key test clicks. The strip is rendered only in the
//      narrow tier, where CSS has taken the full rail off the screen.
//
// ⛔ Two source-text pins read THIS file rather than the view
// (apps/gui-client/tests/unit/theme-token-parity.test.ts):
//   • the saved-chat title span truncates, so it carries `title={c.title}` —
//     the class string is pinned byte-for-byte there;
//   • `+ New chat` is no longer an accent FILL (spec §3.2: Send and Approve are
//     the view's only two), so the positive arm that required
//     `hover:bg-accent-fill-hover` in this file moved with it — the sweep now
//     asserts the ABSENCE of a raw accent fill across the whole agent-chat
//     folder instead, and the rose-hover negative still covers this file.
//
// ⚠️ And do not spell the forbidden class sequence out in prose here. That
//    sweep reads this file as TEXT and does not strip comments: writing the
//    pattern in a sentence reds the guard, which is exactly what it did the
//    first time this header tried to explain itself.

import { useCallback, useEffect, useRef, useState } from 'react';
import { formatRelativeNarrow } from '../../components/RelativeTime';
import { chatTurnCount, type StoredChat } from '../../lib/chat-history';
import { chatOutcome, summariseChatTurn } from './chat-turn-summary';
import { IconHistory, IconPlus } from './icons';
import { useFocusTrap } from '../../lib/use-focus-trap';
import type { LiveChatStatus } from './mission-status';

/** Which day-heading a chat sits under (spec §3.2). */
export type RailGroup = 'Today' | 'Yesterday' | 'Earlier';

/**
 * The group a chat belongs to, by CALENDAR day in the customer's own timezone —
 * not by elapsed hours. A chat touched at 23:50 last night is "Yesterday" at
 * 00:10 even though it is twenty minutes old, because that is what the customer
 * means by yesterday. Both arguments are epoch ms so the function is pure.
 */
export function railGroup(updatedAt: number, now: number): RailGroup {
  const startOfDay = (ms: number): number => {
    const d = new Date(ms);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  };
  const today = startOfDay(now);
  if (updatedAt >= today) return 'Today';
  if (updatedAt >= today - 86_400_000) return 'Yesterday';
  return 'Earlier';
}

/** The dot's tone. `run` and `wait` belong to the chat being worked on now. */
type Dot = 'run' | 'wait' | 'ok' | 'bad' | 'idle';

const DOT_TONE: Record<Dot, string> = {
  run: 'ai-rail-dot-run ai-beat-slow',
  wait: 'ai-rail-dot-wait',
  ok: 'ai-rail-dot-ok',
  bad: 'ai-rail-dot-bad',
  idle: 'ai-rail-dot-idle',
};

interface RowMeta {
  text: string;
  title: string;
  dot: Dot;
}

/**
 * What one row says under its title.
 *
 * The live half wins: a chat that is running right now is described by what it
 * is doing, not by when it was last written to disk. Everything else reads the
 * stored turns — the count that has been persisted all along, and the outcome
 * of the last thing the AI did.
 */
function rowMeta(chat: StoredChat, live: LiveChatStatus | null, now: number): RowMeta {
  if (live !== null) {
    return { text: live.meta, title: live.meta, dot: live.dot === 'approval' ? 'wait' : 'run' };
  }
  const when = formatRelativeNarrow(new Date(chat.updatedAt).toISOString(), now);
  const absolute = new Date(chat.updatedAt).toLocaleString();
  const outcome = chatOutcome(chat.turns);
  if (outcome === 'bad') {
    // Said in words, because the red dot beside it must not be the whole
    // message. "Didn’t finish" covers every way a turn ends badly — stopped by
    // the customer, interrupted, declined, or a step that failed — without
    // claiming which one; the chat itself says that when it is opened.
    return {
      text: `Didn’t finish · ${when}`,
      title: `Didn’t finish · updated ${absolute}`,
      dot: 'bad',
    };
  }
  const turns = chatTurnCount(chat);
  // V-1611 — the rail showed a title and a timestamp and discarded the rest.
  // `turns` has been persisted in full all along, so the count costs nothing to
  // show and is the first thing that distinguishes two same-named chats.
  const counted = turns > 0 ? `${String(turns)} turn${turns === 1 ? '' : 's'} · ` : '';
  return {
    text: `${counted}${when}`,
    title: `${counted}updated ${absolute}`,
    dot: outcome === 'ok' ? 'ok' : 'idle',
  };
}

export function ChatRail({
  chats,
  activeId,
  busy,
  narrow,
  liveStatus,
  onNew,
  onSelect,
  onDelete,
}: {
  chats: ReadonlyArray<StoredChat>;
  activeId: string;
  busy: boolean;
  /** Spec §1's ≤ 900px tier: the rail is a 44px strip and the list is an
   *  overlay. Measured on the view's own box — see use-view-width.ts. */
  narrow: boolean;
  /** What the chat being worked on is doing, or null when nothing is. */
  liveStatus: LiveChatStatus | null;
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
  // The strip's overlay. Only ever open in the narrow tier: at any wider size
  // the list is on screen already, and an "open" flag left behind by a resize
  // would trap a keyboard user in a panel that is simply part of the page.
  const [open, setOpen] = useState(false);
  const closeOverlay = useCallback(() => {
    setOpen(false);
  }, []);
  useEffect(() => {
    if (!narrow && open) setOpen(false);
  }, [narrow, open]);
  const panelRef = useRef<HTMLDivElement>(null);
  useFocusTrap(narrow && open, panelRef, closeOverlay);
  // ⛔ REVIEW REPAIR — ANSWERING THE OVERLAY CLOSES IT. Measured before this:
  // picking a chat left the list open over 232px of a 692px mission column, so
  // the chat the customer had just asked for was behind the panel they asked
  // with — at the one width this whole stage exists to buy room at. Starting a
  // NEW chat from the strip's `+` is the same act, so it closes too; DELETING
  // is not (that is list housekeeping, and you stay in the list to do more of
  // it). Closing is also what keeps the keyboard honest: the row that was
  // focused is inside a panel that becomes `display: none`, which would drop
  // focus to <body> — `useFocusTrap`'s cleanup puts it back on `Show chats`,
  // where the customer opened the list from. `setOpen(false)` on an already
  // closed overlay is a no-op, so the full rail behaves exactly as before.
  const selectAndClose = useCallback(
    (c: StoredChat) => {
      onSelect(c);
      setOpen(false);
    },
    [onSelect],
  );
  const newAndClose = useCallback(() => {
    onNew();
    setOpen(false);
  }, [onNew]);

  // ONE clock read per render, shared by every row, so two rows can never land
  // either side of midnight and show two "Today" headings.
  const now = Date.now();
  let lastGroup: RailGroup | null = null;
  return (
    <aside className="ai-rail" aria-label="Chats" data-open={narrow && open ? '' : undefined}>
      {narrow && (
        <div className="ai-rail-mini">
          <button
            type="button"
            aria-label="+ New chat"
            onClick={newAndClose}
            disabled={busy}
            title={busy ? 'Finish or stop the current reply first' : 'New chat'}
            className="ai-rail-mini-btn ai-rail-mini-plus"
          >
            <IconPlus />
          </button>
          <button
            type="button"
            aria-label="Show chats"
            aria-expanded={open}
            aria-controls="ai-rail-panel"
            onClick={() => {
              setOpen((v) => !v);
            }}
            title={open ? 'Hide chats' : 'Show chats'}
            className="ai-rail-mini-btn"
          >
            <IconHistory />
            {chats.length > 0 && (
              <span className="ai-rail-count" aria-hidden="true">
                {chats.length}
              </span>
            )}
            {liveStatus !== null && (
              <span
                aria-hidden="true"
                className={`ai-rail-mini-dot ${liveStatus.dot === 'approval' ? 'ai-rail-dot-wait' : 'ai-rail-dot-run ai-beat-slow'}`}
              />
            )}
          </button>
        </div>
      )}
      <div className="ai-rail-panel" id="ai-rail-panel" ref={panelRef}>
        {/* ⛔ ONE `+ New chat` IN THE DOM, NOT ONE ON SCREEN. In the narrow tier
            the strip's `+` IS this button, so the full one is not rendered at
            all — rather than rendered and hidden by CSS. Two of them would be
            invisible to a browser (the panel is `display: none`) and perfectly
            visible to `getByRole`, which is where the pin lives. */}
        {!narrow && (
          <div className="ai-rail-top">
            {/* ⛔ THE PLUS IS NOT `aria-hidden`, AND THAT IS THE WHOLE NAME. The
              accessible name is computed from the contents and must stay
              exactly `+ New chat` — hiding the glyph would silently rename this
              button `New chat`, which is the name the bar's second button used
              to carry and the one `getByRole` matches EXACTLY. The `{' '}` is
              load-bearing for the same reason: JSX drops a newline next to a
              tag, so without it the name is `+New chat`. */}
            <button
              type="button"
              onClick={onNew}
              disabled={busy}
              title={busy ? 'Finish or stop the current reply first' : undefined}
              className="ai-rail-new"
            >
              <span className="ai-rail-plus">+</span> New chat
            </button>
          </div>
        )}
        <div className="ai-rail-list">
          {chats.length === 0 ? (
            <p className="ai-rail-empty">
              Your chats are saved here so you can pick one back up later.
            </p>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {chats.map((c) => {
                const active = c.id === activeId;
                const meta = rowMeta(c, active ? liveStatus : null, now);
                const group = railGroup(c.updatedAt, now);
                const heading = group === lastGroup ? null : group;
                lastGroup = group;
                return (
                  <li key={c.id}>
                    {/* A span, not a heading: these are section labels inside a
                        list, and a heading here would put six more stops in the
                        document outline of a panel that is one list. */}
                    {heading !== null && (
                      <span className="ai-rail-group section-label">{heading}</span>
                    )}
                    <div
                      className={`group ai-rail-row ${active ? 'is-active' : ''}`}
                      data-component="ai-chat-row"
                    >
                      <button
                        type="button"
                        onClick={() => {
                          selectAndClose(c);
                        }}
                        disabled={busy}
                        title={busy ? 'Finish or stop the current reply first' : undefined}
                        className="ai-rail-open"
                      >
                        <span aria-hidden="true" className={`ai-rail-dot ${DOT_TONE[meta.dot]}`} />
                        <span className="min-w-0">
                          <span className="block truncate text-xs text-ink-primary" title={c.title}>
                            {c.title}
                          </span>
                          <span className="ai-rail-meta" title={meta.title}>
                            {meta.text}
                          </span>
                        </span>
                      </button>
                      {c.turns.length > 0 && (
                        <button
                          type="button"
                          aria-expanded={expanded.has(c.id)}
                          aria-controls={`chat-turns-${c.id}`}
                          aria-label={`${expanded.has(c.id) ? 'Hide' : 'Show'} what happened in ${c.title}`}
                          title={expanded.has(c.id) ? 'Hide details' : 'Show what happened'}
                          onClick={() => {
                            toggleExpanded(c.id);
                          }}
                          className="ai-rail-act"
                        >
                          <span
                            aria-hidden="true"
                            className={`inline-block transition-transform ${expanded.has(c.id) ? 'rotate-90' : ''}`}
                          >
                            ›
                          </span>
                        </button>
                      )}
                      {/* :focus-within as well as hover — the ✕ was opacity-0
                          until the pointer arrived, so a keyboard user could
                          reach it and never see where they were. */}
                      <button
                        type="button"
                        aria-label={`Delete chat ${c.title}`}
                        title={busy ? 'Finish or stop the current reply first' : 'Delete chat'}
                        onClick={() => {
                          onDelete(c.id);
                        }}
                        disabled={busy}
                        className="ai-rail-act ai-rail-del"
                      >
                        ✕
                      </button>
                    </div>
                    {expanded.has(c.id) && (
                      <ol id={`chat-turns-${c.id}`} className="flex flex-col gap-1 py-1 pl-3 pr-1">
                        {c.turns.map((t) => {
                          const summary = summariseChatTurn(t);
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
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </aside>
  );
}
