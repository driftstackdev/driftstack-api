// W477.C — drift guard for apps/gui-client/src/components/CryptoOrderAdminDetailDrawer.tsx.
// V-534.AM admin order-detail drawer + V-534.AN inline edit-
// note action + V-534.BD V-666.AT events timeline. Drift here
// either drops the read-only-mode framing (the onEditNote
// optional prop means callers can omit actions for ops
// dashboards — if hasAnyAction is always true, the read-only
// surface disappears and ops dashboards mount with stale action
// buttons that don't fire) or breaks the 'crypto payments are
// non-refundable' framing (a future refund button gets added to
// the drawer without the architectural reminder that refunds
// aren't supported).
//
//   • V-534.AM/.AN/.BD triple-framing pinned.
//   • 'Crypto payments are non-refundable.' framing pinned so
//     refund actions can't sneak in unannotated.
//   • Props 3-field: order + onClose + onEditNote? (optional —
//     read-only when omitted).
//   • hasAnyAction = onEditNote !== undefined; useAdminOrderEvents
//     called on mount with order.order_id.
//   • Customer note + Internal note (admin-only) sections with
//     null-or-empty → 'No customer/internal note.' fallback.
//   • Timeline render: 4-state branch (loading|idle → 'Loading
//     timeline…' / error → 'Timeline unavailable: ${message}' /
//     ready → <ol> of events).
//   • Action button label: internal_note present → 'Edit note',
//     absent → 'Add note'.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/gui-client/src/components/CryptoOrderAdminDetailDrawer.tsx');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W477.C apps/gui-client/src/components/CryptoOrderAdminDetailDrawer.tsx content parity', () => {
  const body = read(LIB);

  it("V-534.AM framing pinned: 'V-534.AM — admin order-detail drawer.' + V-534.AN framing 'adds inline action button (edit/add internal note) so an admin can act without first scrolling back to the table row.' + V-534.BD framing 'adds an event-timeline section below the envelope, sourced from V-666.AT (GET /events). Fetches on mount / orderId change; errors render an inline message but don't block the rest of the drawer.'", () => {
    expect(body).toMatch(/\/\/ V-534\.AM — admin order-detail drawer\./);
    expect(body).toMatch(
      /\/\/ V-534\.AN — adds inline action button \(edit\/add internal note\) so an\s*\/\/\s+admin can act without first scrolling back to the table\s*\/\/\s+row\./,
    );
    expect(body).toMatch(
      /\/\/ V-534\.BD — adds an event-timeline section below the envelope,\s*\/\/\s+sourced from V-666\.AT \(GET \/events\)\. Fetches on mount \/\s*\/\/\s+orderId change; errors render an inline message but\s*\/\/\s+don't block the rest of the drawer\./,
    );
  });

  it("'Crypto payments are non-refundable.' architectural framing pinned: 'The drawer intentionally does not surface refund actions; customer cancellation stops future billing periods but does not refund the current period.' — pinned so a future refund button can't sneak in without the no-refunds reminder", () => {
    expect(body).toMatch(
      /\/\/ Crypto payments are non-refundable\. The drawer intentionally does\s*\/\/ not surface refund actions; customer cancellation stops future\s*\/\/ billing periods but does not refund the current period\./,
    );
  });

  it('CryptoOrderAdminDetailDrawerProps: order: AdminCryptoOrder + onClose: () => void + onEditNote? (order: AdminCryptoOrder) => void \'Fires when admin clicks "Edit note". Optional — read-only when omitted.\' — pinned so callers can omit actions for read-only ops dashboards', () => {
    expect(body).toMatch(
      /export interface CryptoOrderAdminDetailDrawerProps \{\s*order: AdminCryptoOrder;\s*onClose: \(\) => void;\s*\/\*\* Fires when admin clicks "Edit note"\. Optional — read-only when omitted\. \*\/\s*onEditNote\?: \(order: AdminCryptoOrder\) => void;\s*\}/,
    );
  });

  it('hasAnyAction = onEditNote !== undefined gate + useAdminOrderEvents(order.order_id) called at top of component (V-534.BD V-666.AT fetch-on-mount/orderId-change); aside with role="complementary" + aria-label `Order detail for ${order.order_id}` + fixed inset-y-0 right-0 drawer layout', () => {
    expect(body).toMatch(/const hasAnyAction = onEditNote !== undefined;/);
    expect(body).toMatch(/const events = useAdminOrderEvents\(order\.order_id\);/);
    expect(body).toMatch(
      /<aside\s*role="complementary"\s*aria-label=\{`Order detail for \$\{order\.order_id\}`\}\s*className="fixed inset-y-0 right-0 z-40 flex w-full max-w-md flex-col gap-4 overflow-y-auto border-l border-surface-divider bg-surface-base p-6 shadow-xl"\s*>/,
    );
  });

  it("Envelope dl: Account (font-mono + ?? '—') + Product + Amount(formatCents) + Payment id (font-mono + ?? '—') + Created + Updated; close button with aria-label 'Close order detail'", () => {
    expect(body).toMatch(
      /<dl className="grid grid-cols-2 gap-y-1 text-sm">\s*<dt className="text-ink-secondary">Account<\/dt>\s*<dd className="font-mono text-xs">\{order\.account_id \?\? '—'\}<\/dd>/,
    );
    expect(body).toMatch(/<dd>\{formatCents\(order\.price_cents, order\.price_currency\)\}<\/dd>/);
    expect(body).toMatch(/<dd className="font-mono text-xs">\{order\.payment_id \?\? '—'\}<\/dd>/);
    expect(body).toMatch(/aria-label="Close order detail"/);
  });

  it("Customer note + Internal note (admin-only) sections: null-or-empty (!= null && length > 0 guard) → render note text else 'No customer note.' / 'No internal note.' fallback in muted text-ink-secondary", () => {
    expect(body).toMatch(
      /<section aria-label="Customer note">\s*<p className="text-xs uppercase text-ink-secondary">Customer note<\/p>\s*<p className="mt-1 whitespace-pre-wrap text-sm">\s*\{order\.customer_note != null && order\.customer_note\.length > 0 \? \(\s*order\.customer_note\s*\) : \(\s*<span className="text-ink-secondary">No customer note\.<\/span>\s*\)\}\s*<\/p>\s*<\/section>/,
    );
    expect(body).toMatch(
      /<section aria-label="Internal note">\s*<p className="text-xs uppercase text-ink-secondary">Internal note \(admin-only\)<\/p>\s*<p className="mt-1 whitespace-pre-wrap text-sm">\s*\{order\.internal_note != null && order\.internal_note\.length > 0 \? \(\s*order\.internal_note\s*\) : \(\s*<span className="text-ink-secondary">No internal note\.<\/span>\s*\)\}\s*<\/p>\s*<\/section>/,
    );
  });

  it("Timeline section <section aria-label='Order events timeline'>: 4-state branch (loading|idle → 'Loading timeline…' / error → 'Timeline unavailable: ${message}' / ready → <ol> of events with CryptoOrderStatusBadge size='sm' + 'via {source}' + font-mono at timestamp); errors render inline + don't block rest of drawer", () => {
    expect(body).toMatch(
      /<section aria-label="Order events timeline">\s*<p className="text-xs uppercase text-ink-secondary">Timeline<\/p>\s*\{events\.state\.kind === 'loading' \|\| events\.state\.kind === 'idle' \? \(\s*<p className="mt-1 text-sm text-ink-secondary">Loading timeline…<\/p>\s*\) : events\.state\.kind === 'error' \? \(\s*<p className="mt-1 text-sm text-status-error">\s*Timeline unavailable: \{events\.state\.message\}\s*<\/p>\s*\) : events\.state\.kind === 'ready' \? \(/,
    );
    expect(body).toMatch(
      /<CryptoOrderStatusBadge status=\{e\.status\} size="sm" \/>\s*<span className="text-xs text-ink-secondary">via \{e\.source\}<\/span>/,
    );
  });

  it("Action section: hasAnyAction gate + onEditNote !== undefined inner gate (defense-in-depth) + button label conditional 'Edit note' when internal_note present, 'Add note' when absent — pinned so the noun matches the verb (add vs edit)", () => {
    expect(body).toMatch(
      /\{hasAnyAction && \(\s*<section aria-label="Order actions" className="flex flex-wrap gap-2">\s*\{onEditNote !== undefined && \(\s*<button\s*type="button"\s*onClick=\{\(\) => onEditNote\(order\)\}\s*className="rounded border border-surface-divider px-3 py-1 text-sm font-medium hover:bg-surface-inset"\s*>\s*\{order\.internal_note != null && order\.internal_note\.length > 0\s*\? 'Edit note'\s*: 'Add note'\}\s*<\/button>\s*\)\}\s*<\/section>\s*\)\}/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
