// V-534.AJ — combined admin dashboard view.
//
// Stitches together the V-534.AI stats card + V-534.AG admin orders
// list + V-534.AH daily-breakdown table into one page. Pure layout
// composition; each child view handles its own fetch lifecycle.
//
// V-534.BA — adds a small idempotency-metrics strip alongside the
// stats card. The numbers come from the V-666.AP route and answer
// "how often is the checkout button being double-clicked / retried"
// without forcing the admin to grep logs.
// V-534.BB — colour-codes the replay-share + surfaces the V-666.AR
// body-mismatch count when non-zero. Replay share thresholds:
//   <5%   neutral  ("normal background retry rate")
//   5-20% warning  ("worth a look")
//   >20%  alert    ("something is wrong")
// V-534.BH — small footer link to the live API spec (V-666.AY /
// V-666.AZ). Convenience for ops integrators reading codegen.

import { useContext } from 'react';
import { useAdminIdempotencyMetrics } from '../lib/use-admin-idempotency-metrics';
import { SettingsContext } from '../lib/SettingsContext';
import { DEFAULT_SETTINGS } from '../lib/settings';
import { CryptoOrdersAdminView } from './CryptoOrdersAdminView';
import { CryptoOrdersDailyBreakdownView } from './CryptoOrdersDailyBreakdownView';
import { CryptoOrdersStatsCard } from './CryptoOrdersStatsCard';

function IdempotencyMetricsStrip(): JSX.Element {
  const { state } = useAdminIdempotencyMetrics();
  if (state.kind === 'loading' || state.kind === 'idle') {
    return (
      <div className="rounded-md border border-surface-divider bg-surface-inset p-3 text-xs text-ink-secondary">
        Loading idempotency metrics…
      </div>
    );
  }
  if (state.kind === 'error') {
    return (
      <div className="rounded-md border border-surface-divider bg-surface-inset p-3 text-xs text-status-error">
        Idempotency metrics unavailable: {state.message}
      </div>
    );
  }
  const total = state.data.first_writes + state.data.replays;
  const replayShare = total === 0 ? 0 : Math.round((state.data.replays / total) * 100);
  const shareTone: 'neutral' | 'warning' | 'alert' =
    replayShare > 20 ? 'alert' : replayShare >= 5 ? 'warning' : 'neutral';
  const shareClass =
    shareTone === 'alert'
      ? 'text-status-error'
      : shareTone === 'warning'
        ? 'text-status-warning'
        : 'text-ink-primary';
  const bodyMismatches = state.data.body_mismatches ?? 0;
  return (
    <div
      role="status"
      aria-label="Idempotency metrics"
      data-replay-tone={shareTone}
      className="grid grid-cols-4 gap-4 rounded-md border border-surface-divider bg-surface-inset p-3 text-sm"
    >
      <div>
        <div className="text-ink-secondary text-xs">First writes</div>
        <div className="font-mono">{state.data.first_writes.toLocaleString()}</div>
      </div>
      <div>
        <div className="text-ink-secondary text-xs">Replays</div>
        <div className="font-mono">{state.data.replays.toLocaleString()}</div>
      </div>
      <div>
        <div className="text-ink-secondary text-xs">Replay share</div>
        <div className={`font-mono ${shareClass}`}>{replayShare}%</div>
      </div>
      <div>
        <div className="text-ink-secondary text-xs">Body mismatches</div>
        <div
          className={`font-mono ${bodyMismatches > 0 ? 'text-status-warning' : 'text-ink-primary'}`}
        >
          {bodyMismatches.toLocaleString()}
        </div>
      </div>
    </div>
  );
}

export function CryptoOrdersAdminDashboardView(): JSX.Element {
  // W212 — the API spec lives on the configured API host (Scalar UI
  // at `${baseUrl}/docs/`), NOT on the Tauri app's own origin.
  // `href="/docs"` from a Tauri WebView resolves to tauri://localhost/docs
  // (404). Pull baseUrl from SettingsContext when available; fall
  // back to the DEFAULT_SETTINGS baseUrl when the context is
  // unmounted (tests render this component in isolation without
  // <SettingsProvider>).
  const ctx = useContext(SettingsContext);
  const baseUrl = ctx?.settings.baseUrl ?? DEFAULT_SETTINGS.baseUrl;
  const docsUrl = `${baseUrl.replace(/\/+$/, '')}/docs/`;

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <header>
        <h1 className="text-xl font-semibold">Crypto orders — admin dashboard</h1>
        <p className="text-sm text-ink-secondary">
          At-a-glance summary, full order list with filters, and a daily breakdown.
        </p>
      </header>

      <CryptoOrdersStatsCard />

      <IdempotencyMetricsStrip />

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <section aria-label="Orders list" className="min-w-0">
          <CryptoOrdersAdminView />
        </section>

        <section aria-label="Daily breakdown" className="min-w-0">
          <CryptoOrdersDailyBreakdownView />
        </section>
      </div>

      <footer className="text-xs text-ink-secondary">
        <a
          href={docsUrl}
          target="_blank"
          rel="noreferrer"
          className="underline hover:text-ink-primary"
        >
          View API spec
        </a>{' '}
        &middot; admin + customer crypto endpoints documented at <code>/openapi.json</code>.
      </footer>
    </div>
  );
}
