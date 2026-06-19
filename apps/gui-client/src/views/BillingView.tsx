// W### — customer Billing hub.
//
// Wires the previously-unreachable customer billing/crypto cluster
// into one tabbed view so paid top-up / crypto checkout is actually
// reachable from the desktop GUI (it shipped built but unrouted — a
// revenue blocker). Hosts the three CUSTOMER-facing views only:
//   • Usage & cost → BillingCostView (metered cost by billing cycle)
//   • Top up / Pay → CryptoCheckoutFlowView (quote → mint → poll)
//   • Orders       → CryptoOrdersHistoryView (nests detail → receipt)
//
// The Crypto*Admin*/PendingAge views are staff-only (403 for customer
// keys + no is_staff flag on AccountSelfProfile to gate them on), so
// they belong in apps/admin-panel and are deliberately NOT routed here.

import { useState } from 'react';
import { useSettings } from '../lib/SettingsContext';
import { BillingCostView } from './BillingCostView';
import { CryptoCheckoutFlowView } from './CryptoCheckoutFlowView';
import { CryptoOrdersHistoryView } from './CryptoOrdersHistoryView';

// CryptoCheckoutFlowView.SUPPORTED_PRODUCTS (kept in sync intentionally
// — it is not exported). The checkout view requires a `defaultProduct`;
// FALLBACK_PRODUCT is the constant used when the account's tier isn't a
// purchasable product (e.g. free / enterprise / unauthenticated).
const SUPPORTED_PRODUCTS = [
  'solo_manual',
  'team_manual',
  'agency_manual',
  'api_starter',
  'api_builder',
  'api_scale',
] as const;
const FALLBACK_PRODUCT = 'api_starter';

/** Map the account tier to a purchasable product, falling back to a
 *  sensible default when the tier isn't itself a top-up product. */
function defaultProductForTier(tier: string | null | undefined): string {
  if (tier != null && (SUPPORTED_PRODUCTS as readonly string[]).includes(tier)) {
    return tier;
  }
  return FALLBACK_PRODUCT;
}

type BillingTab = 'cost' | 'checkout' | 'orders';

export function BillingView(): JSX.Element {
  const { accountMe } = useSettings();
  const [tab, setTab] = useState<BillingTab>('cost');
  const defaultProduct = defaultProductForTier(accountMe?.tier ?? null);

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      <header>
        <h1 className="text-xl font-semibold">Billing</h1>
        <p className="text-sm text-ink-secondary">
          Track usage &amp; cost, top up with crypto, and review your orders.
        </p>
      </header>

      {/* role=tablist keyboardable via the buttons (matches ProfilesView). */}
      <div
        role="tablist"
        aria-label="Billing"
        className="flex gap-1 border-b border-surface-divider"
      >
        {(
          [
            ['cost', 'Usage & cost'],
            ['checkout', 'Top up / Pay'],
            ['orders', 'Orders'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className={`-mb-px rounded-t border-b-2 px-3 py-1.5 text-xs ${
              tab === id
                ? 'border-accent font-medium text-ink-primary'
                : 'border-transparent text-ink-muted hover:text-ink-secondary'
            }`}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {tab === 'cost' && <BillingCostView />}
        {tab === 'checkout' && <CryptoCheckoutFlowView defaultProduct={defaultProduct} />}
        {tab === 'orders' && <CryptoOrdersHistoryView />}
      </div>
    </div>
  );
}
