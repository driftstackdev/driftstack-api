// Billing is managed on the WEB DASHBOARD ONLY.
//
// The desktop app used to host its own billing hub (usage & cost, crypto
// top-up, order history). Two surfaces owning the same billing state is how
// a customer ends up reading a different answer depending on where they
// look, and it duplicated a payment path — a checkout started in the app and
// a checkout started on the web produce two independent orders against one
// account, which is exactly the "a pending and a cancelled order" confusion
// this removal is meant to end.
//
// The web dashboard is a strict superset of what the app offered: Stripe
// checkout (/v1/billing/checkout-session), the Stripe customer portal
// (/v1/billing/portal-session), crypto checkout (/v1/billing/crypto-checkout)
// and order history (/v1/billing/crypto-orders). Nothing was lost by
// removing the in-app copy, so this view points at the one place that owns it
// rather than leaving the destination missing and the customer hunting.

const BILLING_URL = 'https://app.driftstack.io/billing/';

export function BillingMovedView(): JSX.Element {
  return (
    <div className="flex h-full flex-col gap-4 p-6">
      <header>
        <h1 className="text-xl font-semibold">Billing</h1>
        <p className="text-sm text-ink-secondary">Billing is managed on the web dashboard.</p>
      </header>

      <div className="max-w-prose rounded-lg border border-surface-divider p-5">
        <p className="text-sm text-ink-secondary">
          Your plan, payment method, invoices, crypto top-ups and order history all live in the web
          dashboard, so there is one place that owns them and one answer to what you are paying for.
        </p>
        <a
          href={BILLING_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="btn-primary mt-4 inline-flex"
        >
          Open billing in the browser
        </a>
        <p className="mt-3 text-2xs text-ink-muted">{BILLING_URL}</p>
      </div>
    </div>
  );
}
