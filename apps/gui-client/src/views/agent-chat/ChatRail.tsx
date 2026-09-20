// The saved-chat history rail.
//
// Stage 0 of the AI-view rebuild (spec §9): lifted out of AgentChatView.tsx with
// the DOM byte-identical — same classes, same accessible names, same copy. Only
// the file it lives in changed.
//
// ⛔ Two source-text pins now read THIS file rather than the view
// (apps/gui-client/tests/unit/theme-token-parity.test.ts):
//   • `+ New chat` is the view's one `bg-accent … text-white` fill, so it must
//     hover to `hover:bg-accent-fill-hover` (7.11:1 on white) and never back to
//     the rose `hover:bg-accent-hover` (3.92:1, an AA failure that shipped once);
//   • the saved-chat title span truncates, so it carries `title={c.title}` —
//     the class string is pinned byte-for-byte there.
// Changing either class string means updating that test in the same commit.

import { useCallback, useState } from 'react';
import { RelativeTime } from '../../components/RelativeTime';
import { chatTurnCount, type StoredChat } from '../../lib/chat-history';
import { summariseChatTurn } from './chat-turn-summary';

export function ChatRail({
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
          className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-xs font-semibold text-white hover:bg-accent-fill-hover disabled:opacity-40"
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
                    <span className="block truncate text-xs text-ink-primary" title={c.title}>
                      {c.title}
                    </span>
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
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}
