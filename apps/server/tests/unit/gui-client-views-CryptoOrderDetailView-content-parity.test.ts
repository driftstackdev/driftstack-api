// W479.C — drift guard for apps/gui-client/src/views/CryptoOrderDetailView.tsx.
// V-534.AD single-order detail view + V-534.AF
// CryptoOrderSummaryCard delegation + V-534.BE V-666.AU events
// timeline. Drift here either drops the cancellable=pending
// guard (a customer with a 'confirming' order sees a Cancel
// button — they click, server rejects, customer thinks Driftstack
// is broken; meanwhile the on-chain transfer continues to settle)
// or breaks the EventsTimeline empty-state ('No events recorded
// yet.' instead of an empty <ol>).
//
//   • V-534.AD/.AF/.BE triple-framing pinned.
//   • 'Combines useCryptoOrder (poll), useCancelOrder (V-534.Y),
//     and CryptoReceiptView (V-534.AB) on one page.' framing
//     pinned.
//   • 'Cancel is only offered while status === pending; a
//     confirming/partial/paid/failed order shows an explanatory
//     note instead.' framing pinned.
//   • EventsTimeline subcomponent: empty-state 'No events
//     recorded yet.' + non-empty <ol> aria-label='Order events
//     timeline' with CryptoOrderStatusBadge size='sm' + 'via
//     {source}' + font-mono timestamp.
//   • orderId null → 'Pick an order to view its details.';
//     loading|idle → 'Loading order…'; error → <ErrorBanner>;
//     ready → CryptoOrderSummaryCard with footer.
//   • Cancel button: disabled while submitting + 'Cancelling…'
//     label; on 'failed' state surfaces cancel.state.message
//     inline; non-cancellable non-terminal copy: 'Payment
//     activity has been detected on-chain. Cancellation is no
//     longer self-service — contact support to reconcile or
//     refund.'

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/gui-client/src/views/CryptoOrderDetailView.tsx');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W479.C apps/gui-client/src/views/CryptoOrderDetailView.tsx content parity', () => {
  const body = read(LIB);

  it("V-534.AD/.AF/.BE triple-framing pinned: 'V-534.AD — single-order detail view.' + 'V-534.AF — body now rendered via CryptoOrderSummaryCard.' + 'V-534.BE — renders the V-666.AU events timeline inline below the summary card so the customer can see when the order transitioned states (useful for proving payment in support tickets).'", () => {
    expect(body).toMatch(/\/\/ V-534\.AD — single-order detail view\./);
    expect(body).toMatch(/\/\/ V-534\.AF — body now rendered via CryptoOrderSummaryCard\./);
    expect(body).toMatch(
      /\/\/ V-534\.BE — renders the V-666\.AU events timeline inline below the\s*\n?\s*\/\/\s+summary card so the customer can see when the order\s*\n?\s*\/\/\s+transitioned states \(useful for proving payment in\s*\n?\s*\/\/\s+support tickets\)\./,
    );
  });

  it("Wiring framing pinned: 'Combines useCryptoOrder (poll), useCancelOrder (V-534.Y), and CryptoReceiptView (V-534.AB) on one page. Cancel is only offered while status === \\'pending\\'; a confirming/partial/paid/failed order shows an explanatory note instead. The receipt panel renders inline once the order reaches paid; before that we surface the polling status so the user knows we're waiting for on-chain confirmation.'", () => {
    expect(body).toMatch(
      /\/\/ Combines useCryptoOrder \(poll\), useCancelOrder \(V-534\.Y\), and\s*\n?\s*\/\/ CryptoReceiptView \(V-534\.AB\) on one page\. Cancel is only offered\s*\n?\s*\/\/ while status === 'pending'; a confirming\/partial\/paid\/failed order\s*\n?\s*\/\/ shows an explanatory note instead\. The receipt panel renders inline\s*\n?\s*\/\/ once the order reaches paid; before that we surface the polling\s*\n?\s*\/\/ status so the user knows we're waiting for on-chain confirmation\./,
    );
  });

  it("EventsTimeline subcomponent: events.length === 0 returns <p>'No events recorded yet.' inline + non-empty returns <ol> aria-label='Order events timeline' with CryptoOrderStatusBadge size='sm' + 'via {source}' + font-mono at timestamp; key uses ${e.at}-${i.toString()}", () => {
    expect(body).toMatch(
      /function EventsTimeline\(\{ events \}: \{ events: CryptoOrderEvent\[\] \}\): JSX\.Element \{\s*\n?\s*if \(events\.length === 0\) \{\s*\n?\s*return <p className="text-sm text-ink-secondary">No events recorded yet\.<\/p>;\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /<ol aria-label="Order events timeline" className="flex flex-col gap-1 text-sm">\s*\n?\s*\{events\.map\(\(e, i\) => \(\s*\n?\s*<li\s*\n?\s*key=\{`\$\{e\.at\}-\$\{i\.toString\(\)\}`\}/,
    );
    expect(body).toMatch(/<CryptoOrderStatusBadge status=\{e\.status\} size="sm" \/>/);
    expect(body).toMatch(/<span className="text-xs text-ink-secondary">via \{e\.source\}<\/span>/);
  });

  it("State-machine early returns: orderId === null → 'Pick an order to view its details.' empty state + loading|idle → 'Loading order…' + error → <ErrorBanner message + onDismiss={() => void refetch()}> (Dismiss retries the order fetch rather than dead-ending on a stale error); CryptoOrderDetailViewProps: orderId 'The order id to display. Pass null for the empty state.' nullable", () => {
    expect(body).toMatch(
      /export interface CryptoOrderDetailViewProps \{\s*\n?\s*\/\*\* The order id to display\. Pass null for the empty state\. \*\/\s*\n?\s*orderId: string \| null;\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /if \(props\.orderId === null\) \{\s*\n?\s*return \(\s*\n?\s*<div className="rounded-md border border-surface-divider bg-surface-inset p-4 text-sm text-ink-secondary">\s*\n?\s*Pick an order to view its details\.\s*\n?\s*<\/div>\s*\n?\s*\);\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /if \(state\.kind === 'loading' \|\| state\.kind === 'idle'\) \{\s*\n?\s*return \(\s*\n?\s*<div className="rounded-md border border-surface-divider bg-surface-inset p-4 text-sm text-ink-secondary">\s*\n?\s*Loading order…\s*\n?\s*<\/div>\s*\n?\s*\);\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /if \(state\.kind === 'error'\) \{\s*\n?\s*\/\/ Dismiss retries the order fetch rather than dead-ending on a stale error\.\s*\n?\s*return <ErrorBanner message=\{state\.message\} onDismiss=\{\(\) => void refetch\(\)\} \/>;\s*\n?\s*\}/,
    );
  });

  it("cancellable = status === 'pending' guard + isPaid = status === 'paid'; onCancel calls cancel.cancel(order_id) + then refetch() (refresh badge out of pending); pinned so a customer with a 'confirming' order doesn't see a Cancel button and click it to find Driftstack 'broken' while the on-chain transfer continues to settle", () => {
    expect(body).toMatch(/const cancellable = order\.status === 'pending';/);
    expect(body).toMatch(/const isPaid = order\.status === 'paid';/);
    expect(body).toMatch(
      /const onCancel = async \(\): Promise<void> => \{\s*\n?\s*await cancel\.cancel\(order\.order_id\);\s*\n?\s*\/\/ Refresh the order so the badge transitions out of "pending"\.\s*\n?\s*await refetch\(\);\s*\n?\s*\};/,
    );
  });

  it("Cancel button: only inside cancellable branch + disabled when cancel.state.kind === 'submitting' + label 'Cancelling…' during submit else 'Cancel order' + on 'failed' state surfaces cancel.state.message inline below the button; payment-seen non-terminal explanatory copy: 'Payment activity has been detected on-chain. Cancellation is no longer self-service — contact support to reconcile or refund.' (shown only for 'confirming'/'partial' — NOT 'cancelled', which is terminal with no payment received)", () => {
    expect(body).toMatch(
      /\{cancellable && \(\s*\n?\s*<div className="flex flex-col gap-2">\s*\n?\s*<button\s*\n?\s*type="button"\s*\n?\s*onClick=\{\(\) => setConfirmOpen\(true\)\}\s*\n?\s*disabled=\{cancel\.state\.kind === 'submitting'\}/,
    );
    expect(body).toMatch(
      /\{cancel\.state\.kind === 'submitting' \? 'Cancelling…' : 'Cancel order'\}/,
    );
    expect(body).toMatch(
      /\{cancel\.state\.kind === 'failed' && \(\s*\n?\s*<p className="text-xs text-status-error">\{cancel\.state\.message\}<\/p>\s*\n?\s*\)\}/,
    );
    expect(body).toMatch(
      /\{\(order\.status === 'confirming' \|\| order\.status === 'partial'\) && \(\s*\n?\s*<p className="text-xs text-ink-secondary">\s*\n?\s*Payment activity has been detected on-chain\. Cancellation is no longer self-service —\s*\n?\s*contact support to reconcile or refund\.\s*\n?\s*<\/p>\s*\n?\s*\)\}/,
    );
  });

  it("CRITICAL confirm-cancel dialog: the Cancel button now opens a confirm dialog (setConfirmOpen(true)) instead of calling onCancel() directly — a customer misclick no longer immediately fires a non-refundable on-chain cancellation. Dialog: role='dialog' aria-modal='true' aria-label='Confirm order cancellation', 'Keep order' closes without cancelling, 'Confirm cancel' closes THEN calls onCancel(). Drift back to a direct one-click onCancel would reopen the misclick-triggers-a-non-refundable-action risk this fix closed.", () => {
    expect(body).toMatch(/const \[confirmOpen, setConfirmOpen\] = useState\(false\);/);
    expect(body).toMatch(
      /\{confirmOpen && \(\s*\n?\s*<div\s*\n?\s*role="dialog"\s*\n?\s*aria-modal="true"\s*\n?\s*aria-label="Confirm order cancellation"/,
    );
    expect(body).toMatch(
      /onClick=\{\(\) => setConfirmOpen\(false\)\}\s*\n?\s*className="rounded border border-surface-divider px-3 py-1 text-sm hover:bg-surface-inset"\s*\n?\s*>\s*\n?\s*Keep order/,
    );
    expect(body).toMatch(
      /onClick=\{\(\) => \{\s*\n?\s*setConfirmOpen\(false\);\s*\n?\s*void onCancel\(\);\s*\n?\s*\}\}[\s\S]{0,200}Confirm cancel/,
    );
  });

  it('Final render: CryptoOrderSummaryCard order + footer + events !== undefined && events.length > 0 conditional EventsTimeline section + isPaid && <CryptoReceiptView orderId={order.order_id} /> (receipt panel renders only after status reaches paid)', () => {
    expect(body).toMatch(
      /<CryptoOrderSummaryCard order=\{order\} footer=\{footer\} \/>\s*\n?\s*\{order\.events !== undefined && order\.events\.length > 0 && \(\s*\n?\s*<section aria-label="Timeline" className="flex flex-col gap-2">\s*\n?\s*<h4 className="text-xs uppercase text-ink-secondary">Timeline<\/h4>\s*\n?\s*<EventsTimeline events=\{order\.events\} \/>\s*\n?\s*<\/section>\s*\n?\s*\)\}\s*\n?\s*\{isPaid && <CryptoReceiptView orderId=\{order\.order_id\} \/>\}/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
