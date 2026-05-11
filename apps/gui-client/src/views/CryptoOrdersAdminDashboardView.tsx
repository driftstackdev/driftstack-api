// V-534.AJ — combined admin dashboard view.
//
// Stitches together the V-534.AI stats card + V-534.AG admin orders
// list + V-534.AH daily-breakdown table into one page. Pure layout
// composition; each child view handles its own fetch lifecycle.

import { CryptoOrdersAdminView } from './CryptoOrdersAdminView';
import { CryptoOrdersDailyBreakdownView } from './CryptoOrdersDailyBreakdownView';
import { CryptoOrdersStatsCard } from './CryptoOrdersStatsCard';

export function CryptoOrdersAdminDashboardView(): JSX.Element {
  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <header>
        <h1 className="text-xl font-semibold">Crypto orders — admin dashboard</h1>
        <p className="text-sm text-ink-secondary">
          At-a-glance summary, full order list with filters, and a daily breakdown.
        </p>
      </header>

      <CryptoOrdersStatsCard />

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <section aria-label="Orders list" className="min-w-0">
          <CryptoOrdersAdminView />
        </section>

        <section aria-label="Daily breakdown" className="min-w-0">
          <CryptoOrdersDailyBreakdownView />
        </section>
      </div>
    </div>
  );
}
