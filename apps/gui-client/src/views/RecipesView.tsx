// Recipes browser — master-detail over the vendor recipe library
// (AI-B4). A recipe snapshots a finished agent-session's intent_log so a
// flow can later be replayed without re-paying the LLM decomposition
// cost. This view is READ-ONLY: it lists the account's recipes (label +
// metadata, with a client-side search over the loaded page) and, on
// selection, fetches the full RecipeDetail to show its fields + the
// replayable intent_log steps. Create / delete live elsewhere; recipe
// execution is v1.1 (harness-executor-gated).
//
// Mirrors the SessionsHistoryView state-machine shape (poll-on-mount,
// refresh button, friendly error banner) and the shared Skeleton /
// EmptyState / ErrorBanner / RelativeTime building blocks.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ErrorBanner } from '../components/ErrorBanner';
import { EmptyState } from '../components/EmptyState';
import { Skeleton, SkeletonRegion, SkeletonRows } from '../components/Skeleton';
import { RelativeTime } from '../components/RelativeTime';
import { useSettings } from '../lib/SettingsContext';
import { DriftstackError, type DriftstackClient } from '../lib/client';
import type { AgentIntent, Recipe } from '@driftstack/sdk';

// RecipeDetail (Recipe + the replayable intent_log) is not re-exported
// from @driftstack/sdk, so derive it from the resource method's return
// type — keeps this strict-typed without an `any` or a deep import.
type RecipeDetail = Awaited<ReturnType<DriftstackClient['recipes']['get']>>;

interface ListState {
  recipes: Recipe[];
  refreshedAt: number | null;
  loading: boolean;
  error: string | null;
}

interface DetailState {
  recipe: RecipeDetail | null;
  loading: boolean;
  error: string | null;
}

const SEARCH_ICON = (
  <svg
    viewBox="0 0 24 24"
    width="20"
    height="20"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.75"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M5 7h14M5 12h14M5 17h9" />
    <circle cx="17.5" cy="17.5" r="3.5" />
    <path d="m21.5 21.5-1.5-1.5" />
  </svg>
);

const RECIPES_SPLIT_LAYOUT_CLASS = 'flex min-h-0 flex-1 gap-4';

export interface RecipesViewProps {
  onGoToAI: () => void;
  onGoToSettings: () => void;
}

export function RecipesView({ onGoToAI, onGoToSettings }: RecipesViewProps): JSX.Element {
  const { client } = useSettings();
  const [list, setList] = useState<ListState>({
    recipes: [],
    refreshedAt: null,
    loading: false,
    error: null,
  });
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<DetailState>({
    recipe: null,
    loading: false,
    error: null,
  });

  const refresh = useCallback(async (): Promise<void> => {
    if (!client) {
      setList({ recipes: [], refreshedAt: null, loading: false, error: null });
      return;
    }
    setList((s) => ({ ...s, loading: true }));
    try {
      const page = await client.recipes.list();
      setList({
        recipes: page.data,
        refreshedAt: Date.now(),
        loading: false,
        error: null,
      });
    } catch (err) {
      setList((s) => ({ ...s, loading: false, error: friendly(err) }));
    }
  }, [client]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Fetch the full RecipeDetail (adds the intent_log) when a recipe is
  // selected. Keyed on selectedId so re-selecting the same row is a no-op;
  // the list metadata is shown immediately while the detail loads.
  useEffect(() => {
    if (!client || selectedId === null) {
      setDetail({ recipe: null, loading: false, error: null });
      return;
    }
    let cancelled = false;
    setDetail({ recipe: null, loading: true, error: null });
    client.recipes
      .get(selectedId)
      .then((recipe) => {
        if (!cancelled) setDetail({ recipe, loading: false, error: null });
      })
      .catch((err: unknown) => {
        if (!cancelled) setDetail({ recipe: null, loading: false, error: friendly(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [client, selectedId]);

  // Client-side search over the loaded page — matches label + description.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length === 0) return list.recipes;
    return list.recipes.filter(
      (r) =>
        r.label.toLowerCase().includes(q) || (r.description?.toLowerCase().includes(q) ?? false),
    );
  }, [list.recipes, query]);

  if (!client) {
    return (
      <div className="flex h-full flex-col justify-center p-6">
        <EmptyState
          title="Connect to browse saved tasks"
          description="Add your API key in Settings to browse and replay tasks saved from AI chats."
          action={
            <button type="button" className="btn-primary" onClick={onGoToSettings}>
              Open Settings
            </button>
          }
        />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      <header className="flex items-center justify-between gap-4">
        <div>
          <span className="section-label">Library</span>
          <h2 className="mt-1 text-lg font-medium tracking-tight text-ink-primary">
            Saved tasks
            <span className="ml-2 mono text-ink-muted">{list.recipes.length}</span>
          </h2>
          <p className="mt-1 text-xs text-ink-muted">
            Tasks you saved from a finished AI chat — each replays the steps without re-running the
            planning, so you can repeat a job in one click.
          </p>
        </div>
        <button
          type="button"
          className="btn-secondary"
          onClick={() => void refresh()}
          disabled={list.loading}
        >
          {list.loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </header>

      {list.error !== null && (
        <ErrorBanner
          message={list.error}
          onRetry={() => void refresh()}
          retrying={list.loading}
          onDismiss={() => setList((s) => ({ ...s, error: null }))}
        />
      )}

      {list.loading && list.recipes.length === 0 ? (
        <RecipesInitialSkeleton />
      ) : list.recipes.length === 0 && list.error === null ? (
        <EmptyState
          icon={SEARCH_ICON}
          title="No saved tasks yet"
          description="Saved tasks come from finished AI chats. Once you save a chat as a task, it shows up here ready to browse and replay."
          action={
            <button type="button" className="btn-primary" onClick={onGoToAI}>
              Open AI Browser Automation
            </button>
          }
        />
      ) : (
        <div className={RECIPES_SPLIT_LAYOUT_CLASS}>
          {/* Master — searchable list */}
          <div className="flex w-80 shrink-0 flex-col gap-3">
            <input
              type="search"
              className="form-input"
              placeholder="Search saved tasks…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Search saved tasks"
            />
            {filtered.length === 0 ? (
              <p className="rounded border border-surface-divider bg-surface-raised px-4 py-8 text-center text-sm text-ink-muted">
                No saved tasks match &ldquo;{query.trim()}&rdquo;.
              </p>
            ) : (
              <ul className="min-h-0 flex-1 divide-y divide-surface-divider overflow-auto rounded border border-surface-divider bg-surface-raised">
                {filtered.map((r) => (
                  <li key={r.id}>
                    <button
                      type="button"
                      aria-pressed={selectedId === r.id}
                      onClick={() => setSelectedId(r.id)}
                      className={`flex w-full flex-col items-start gap-1 px-4 py-3 text-left transition-colors ${
                        selectedId === r.id ? 'bg-accent-subtle' : 'hover:bg-surface-inset/60'
                      }`}
                    >
                      <span
                        className={`truncate text-sm font-medium ${
                          selectedId === r.id ? 'text-accent' : 'text-ink-primary'
                        }`}
                      >
                        {r.label}
                      </span>
                      <span className="flex items-center gap-2 text-2xs text-ink-muted">
                        <span className="mono">
                          {r.intent_count} {r.intent_count === 1 ? 'step' : 'steps'}
                        </span>
                        <span aria-hidden="true">·</span>
                        <RelativeTime iso={r.created_at} tooltipPrefix="Created" />
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Detail — selected recipe fields + intent_log */}
          <div className="min-w-0 flex-1 overflow-auto rounded border border-surface-divider bg-surface-raised">
            {selectedId === null ? (
              <div className="flex h-full items-center justify-center px-8 py-16 text-center">
                <p className="max-w-xs text-sm text-ink-muted">
                  Select a saved task to view its details and replayable steps.
                </p>
              </div>
            ) : (
              <DetailPanel state={detail} />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function RecipesInitialSkeleton(): JSX.Element {
  return (
    <SkeletonRegion
      label="Loading saved tasks"
      className={RECIPES_SPLIT_LAYOUT_CLASS}
      contentClassName="contents"
    >
      <div className="flex w-80 shrink-0 flex-col gap-3">
        <Skeleton className="h-9 w-full" />
        <div
          className="min-h-0 flex-1 divide-y divide-surface-divider overflow-hidden rounded border border-surface-divider bg-surface-raised"
          data-component="recipes-skeleton-master"
        >
          {Array.from({ length: 6 }).map((_, index) => (
            <div
              key={index}
              className="flex flex-col gap-1 px-4 py-3"
              data-component="recipes-skeleton-row"
            >
              <Skeleton className="h-3.5 w-3/4" />
              <Skeleton className="h-2.5 w-1/2" />
            </div>
          ))}
        </div>
      </div>
      <div
        className="min-w-0 flex-1 overflow-hidden rounded border border-surface-divider bg-surface-raised p-6"
        data-component="recipes-skeleton-detail"
      >
        <div className="flex flex-col gap-5">
          <div className="flex flex-col gap-2">
            <Skeleton className="h-2.5 w-20" />
            <Skeleton className="h-5 w-48" />
            <Skeleton className="h-2.5 w-32" />
          </div>
          <div className="grid grid-cols-3 gap-6">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
          <Skeleton className="h-32 w-full" />
        </div>
      </div>
    </SkeletonRegion>
  );
}

function DetailPanel({ state }: { state: DetailState }): JSX.Element {
  if (state.loading) {
    return (
      <div className="p-6">
        <SkeletonRows rows={6} label="Loading saved task" />
      </div>
    );
  }
  if (state.error !== null) {
    return (
      <div className="p-6">
        <p className="rounded border border-status-error/30 bg-status-error/10 px-3 py-2 text-sm text-ink-primary">
          {state.error}
        </p>
      </div>
    );
  }
  const r = state.recipe;
  if (r === null) return <div className="p-6" />;

  return (
    <div className="flex flex-col gap-5 p-6">
      <div className="flex flex-col gap-1">
        <span className="section-label">Saved task</span>
        <h3 className="text-base font-medium text-ink-primary">{r.label}</h3>
        <p className="mono text-2xs text-ink-muted">{r.id}</p>
        {r.description !== null && r.description.length > 0 && (
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-ink-secondary">
            {r.description}
          </p>
        )}
      </div>

      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3">
        <Fact label="Steps">
          <span className="mono">{r.intent_count}</span>
        </Fact>
        <Fact label="Source session">
          {r.agent_session_id !== null ? (
            <span className="mono truncate text-ink-secondary">{r.agent_session_id}</span>
          ) : (
            <span className="text-ink-muted">— removed</span>
          )}
        </Fact>
        <Fact label="Created">
          <RelativeTime iso={r.created_at} tooltipPrefix="Created" />
        </Fact>
        <Fact label="Updated">
          <RelativeTime iso={r.updated_at} tooltipPrefix="Updated" />
        </Fact>
      </dl>

      <div className="flex flex-col gap-2">
        <span className="section-label">Intent log</span>
        {r.intent_log.length === 0 ? (
          <p className="rounded border border-dashed border-surface-divider px-4 py-6 text-center text-sm text-ink-muted">
            This saved task has no recorded steps.
          </p>
        ) : (
          <ol className="flex flex-col divide-y divide-surface-divider rounded border border-surface-divider bg-surface-inset">
            {r.intent_log.map((intent, i) => (
              <li key={i} className="flex items-start gap-3 px-4 py-2.5">
                <span className="mono mt-0.5 w-6 shrink-0 text-2xs text-ink-muted">
                  {(i + 1).toString().padStart(2, '0')}
                </span>
                <div className="min-w-0 flex-1">
                  <span className="inline-block rounded-full bg-surface-raised px-2 py-0.5 text-2xs font-medium uppercase tracking-wide text-ink-secondary">
                    {intentKind(intent)}
                  </span>
                  <p className="mt-1 text-sm text-ink-primary">{intentSummary(intent)}</p>
                </div>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-2xs uppercase tracking-wide text-ink-muted">{label}</dt>
      <dd className="truncate text-sm text-ink-primary">{children}</dd>
    </div>
  );
}

/** Short uppercase tag for an intent's discriminant. */
function intentKind(intent: AgentIntent): string {
  if (intent.kind === 'interact') return `interact · ${intent.action}`;
  return intent.kind;
}

/** Human-readable one-liner for an intent's payload. The AgentIntent union
 *  is exhaustive — each arm reads only its own fields, so this stays
 *  type-safe with no `any` and no fallthrough. */
function intentSummary(intent: AgentIntent): string {
  switch (intent.kind) {
    case 'navigate':
      return intent.url;
    case 'interact': {
      const target = intent.selector !== undefined ? ` ${intent.selector}` : '';
      const value =
        intent.value !== undefined && intent.value.length > 0 ? ` = “${intent.value}”` : '';
      return `${intent.action}${target}${value}`.trim();
    }
    case 'wait': {
      const target = intent.selector !== undefined ? ` ${intent.selector}` : '';
      const timeout = intent.timeoutMs !== undefined ? ` (${intent.timeoutMs}ms)` : '';
      return `until ${intent.condition}${target}${timeout}`;
    }
    case 'capture':
      return intent.capture;
    case 'scroll':
      return intent.amount_px !== undefined
        ? `${intent.direction} ${intent.amount_px}px`
        : intent.direction;
    case 'behavioral_pause': {
      if (intent.duration_ms !== undefined) return `pause ${intent.duration_ms}ms`;
      if (intent.reading_word_count !== undefined)
        return `read ~${intent.reading_word_count} words`;
      return 'pause';
    }
  }
}

function friendly(err: unknown): string {
  if (err instanceof DriftstackError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}
