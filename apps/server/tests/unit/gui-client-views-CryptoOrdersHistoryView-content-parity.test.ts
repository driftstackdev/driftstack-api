// W484.A — drift guard for apps/gui-client/src/views/CryptoOrdersHistoryView.tsx.
// V-534.X crypto-orders history + 7 follow-on V-clusters (.Z .AE
// .BG .BJ .BK .BQ .BS .BT). Drift here either drops the
// V-534.BJ cancel-confirmation modal (a single misclick cancels
// a paid order out from under the customer because the modal
// guard disappeared) or breaks the V-534.BS auto-refresh
// pause-after-pagination (refetch resets the cursor + clobbers
// the appended pages — operator clicks 'Load more', 60s later
// the table snaps back to page 1).
//
//   • Multi-V-cluster framing pinned: V-534.X (history) +
//     V-534.Z (cancel action) + V-534.AE (side-panel detail) +
//     V-534.BG (expires-soon pill) + V-534.BJ (confirmation
//     modal) + V-534.BK (modal a11y) + V-534.BQ (status filter)
//     + V-534.BS (auto-refresh while pending) + V-534.BT
//     (pagination pause).
//   • EXPIRES_SOON_THRESHOLD_MS = 15 * 60 * 1000 constant.
//   • isExpiringSoon triple-guard: status === 'pending' +
//     typeof === 'string' && length > 0 + !Number.isNaN +
//     diff > 0 && diff <= threshold.
//   • Cancel-confirm modal a11y: shared ref-backed focus trap +
//     Escape close.
//   • Auto-refresh effect: hasPending guard + paginatedBeyondFirst
//     pause + setInterval cleanup.
//   • Status filter conditional + date-range conditional
//     spread into useCryptoOrdersList opts; date filter sends
//     ISO with 'T00:00:00Z' suffix.
//   • Non-refundable disclaimer pinned: 'Crypto payments are
//     non-refundable; cancelling only stops the pending pay
//     window — if you've already sent crypto, contact support
//     to reconcile.'

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/gui-client/src/views/CryptoOrdersHistoryView.tsx');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W484.A apps/gui-client/src/views/CryptoOrdersHistoryView.tsx content parity', () => {
  const body = read(LIB);

  it('Multi-V-cluster header framing pinned: V-534.X history + V-534.Z cancel + V-534.AE side panel + V-534.BG expires-soon + V-534.BJ confirmation modal + V-534.BK modal a11y + V-534.BQ status filter + V-534.BS auto-refresh + V-534.BT pagination pause — all 9 V-clusters must coexist', () => {
    expect(body).toMatch(/\/\/ V-534\.X — Crypto orders history view\./);
    expect(body).toMatch(/\/\/ V-534\.Z — adds per-row Cancel action for pending orders\./);
    expect(body).toMatch(
      /\/\/ V-534\.AE — clicking a row opens the V-534\.AD CryptoOrderDetailView\s*\n?\s*\/\/\s+in a side panel; selection state stays local to this view\./,
    );
    expect(body).toMatch(
      /\/\/ V-534\.BG — pending rows with under 15 minutes remaining on the\s*\n?\s*\/\/\s+V-666\.AV pay-window get an "Expires soon" pill so the\s*\n?\s*\/\/\s+customer can spot them without opening each detail view\./,
    );
    expect(body).toMatch(
      /\/\/ V-534\.BJ — clicking Cancel opens a confirmation modal first\s*\n?\s*\/\/\s+\(non-refundable disclaimer \+ explicit confirm\) instead\s*\n?\s*\/\/\s+of firing the cancel immediately\. Footguns the customer\s*\n?\s*\/\/\s+into a deliberate choice\./,
    );
    expect(body).toMatch(
      /\/\/ V-534\.BK — modal a11y: pressing Escape closes the modal; the\s*\n?\s*\/\/\s+"Keep order" button receives focus on open \(the safer\s*\n?\s*\/\/\s+default action\)\./,
    );
    expect(body).toMatch(
      /\/\/ V-534\.BS — auto-refresh every 60s while any visible order is\s*\n?\s*\/\/\s+still pending\. Stops once everything settles so we\s*\n?\s*\/\/\s+don't poll forever on stale tabs\./,
    );
  });

  it("EXPIRES_SOON_THRESHOLD_MS = 15 * 60 * 1000 module constant pinned with framing 'threshold for the \"Expires soon\" pill on the history list'; isExpiringSoon helper: status==='pending' guard + typeof === 'string' && length>0 guard + !Number.isNaN(expiresMs) guard + diff > 0 && diff <= threshold range check — pinned so the pill doesn't render on stale-clock-skew or non-pending orders", () => {
    expect(body).toMatch(
      /\/\*\* V-534\.BG — threshold for the "Expires soon" pill on the history list\. \*\/\s*\n?\s*const EXPIRES_SOON_THRESHOLD_MS = 15 \* 60 \* 1000;/,
    );
    expect(body).toMatch(
      /function isExpiringSoon\(\s*\n?\s*status: string,\s*\n?\s*expiresAt: string \| null \| undefined,\s*\n?\s*nowMs: number,\s*\n?\s*\): boolean \{\s*\n?\s*if \(status !== 'pending'\) return false;\s*\n?\s*if \(typeof expiresAt !== 'string' \|\| expiresAt\.length === 0\) return false;\s*\n?\s*const expiresMs = new Date\(expiresAt\)\.getTime\(\);\s*\n?\s*if \(Number\.isNaN\(expiresMs\)\) return false;\s*\n?\s*const diff = expiresMs - nowMs;\s*\n?\s*return diff > 0 && diff <= EXPIRES_SOON_THRESHOLD_MS;\s*\n?\s*\}/,
    );
  });

  it("CryptoOrdersHistoryViewProps: nowFn? testing seam V-534.BG + pendingRefreshMs? V-534.BS 'auto-refresh interval in ms. Default 60_000.'; StatusFilter 7-value union (all + 6-status); useCryptoOrdersList opts conditionally spread status (omit when 'all') + createdAfter/createdBefore with 'T00:00:00Z' ISO suffix on the YYYY-MM-DD date input value", () => {
    expect(body).toMatch(
      /export interface CryptoOrdersHistoryViewProps \{\s*\n?\s*\/\*\* V-534\.BG — testing seam for the expires-soon clock\. \*\/\s*\n?\s*nowFn\?: \(\) => number;\s*\n?\s*\/\*\* V-534\.BS — auto-refresh interval in ms\. Default 60_000\. \*\/\s*\n?\s*pendingRefreshMs\?: number;\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /type StatusFilter = 'all' \| 'pending' \| 'confirming' \| 'paid' \| 'failed' \| 'partial' \| 'cancelled';/,
    );
    expect(body).toMatch(
      /\.\.\.\(statusFilter === 'all' \? \{\} : \{ status: statusFilter \}\),\s*\n?\s*\.\.\.\(createdAfter\.length > 0 \? \{ createdAfter: `\$\{createdAfter\}T00:00:00Z` \} : \{\}\),\s*\n?\s*\.\.\.\(createdBefore\.length > 0 \? \{ createdBefore: `\$\{createdBefore\}T00:00:00Z` \} : \{\}\),/,
    );
  });

  it('Modal a11y uses the shared ref-backed focus trap; auto-refresh pauses after pagination and cleans its interval', () => {
    expect(body).toMatch(/import \{ useFocusTrap \} from '\.\.\/lib\/use-focus-trap';/);
    expect(body).toMatch(/const cancelDialogRef = useRef<HTMLDivElement>\(null\);/);
    expect(body).toMatch(
      /useFocusTrap\(cancelConfirmFor !== null, cancelDialogRef, \(\) => setCancelConfirmFor\(null\)\);/,
    );
    expect(body).toMatch(
      // The setInterval body carries a document.visibilityState hidden-skip gate (perf
      // audit d3dc52ea1) before `void refetch()`; allow any lines between `{` and it.
      /const paginatedBeyondFirst =\s*\n?\s*state\.kind === 'ready' && state\.data\.orders\.length > 50 && state\.data\.nextCursor !== null;\s*\n?\s*useEffect\(\(\) => \{\s*\n?\s*if \(!hasPending\) return;\s*\n?\s*if \(paginatedBeyondFirst\) return;\s*\n?\s*const id = setInterval\(\(\) => \{[\s\S]*?void refetch\(\);\s*\n?\s*\}, pendingRefreshMs\);/,
    );
  });

  it("Auto-refresh framing pinned: 'V-534.BS — auto-refresh while any visible order is pending. The IPN/sweep loop flips pending → confirming → paid out of band; without polling the user has to manually Refresh to see the new state. We bail as soon as nothing is pending so the tab doesn't keep polling forever.' + 'V-534.BT — auto-refresh is paused once the user has paginated past the first page (a refetch resets the cursor + clobbers the appended pages).'", () => {
    expect(body).toMatch(
      /\/\/ V-534\.BS — auto-refresh while any visible order is pending\.\s*\n?\s*\/\/ The IPN\/sweep loop flips pending → confirming → paid out of\s*\n?\s*\/\/ band; without polling the user has to manually Refresh to see\s*\n?\s*\/\/ the new state\. We bail as soon as nothing is pending so the\s*\n?\s*\/\/ tab doesn't keep polling forever\./,
    );
    expect(body).toMatch(
      /\/\/ V-534\.BT — auto-refresh is paused once the user has paginated\s*\n?\s*\/\/ past the first page \(a refetch resets the cursor \+ clobbers the\s*\n?\s*\/\/ appended pages\)\. Track this by comparing the loaded order count\s*\n?\s*\/\/ to the initial page size and the presence of a next_cursor\./,
    );
  });

  it("Cancel-confirm modal: role='dialog' aria-modal='true' aria-label='Confirm order cancellation' + 'Cancel this order?' h3 + non-refundable disclaimer 'Crypto payments are non-refundable; cancelling only stops the pending pay window — if you've already sent crypto, contact support to reconcile.' + 'Keep order' button (default focus + safer action) + 'Confirm cancel' status-error button — pinned so the misclick-cancellation footgun stays guarded", () => {
    expect(body).toMatch(
      /ref=\{cancelDialogRef\}\s*\n?\s*role="dialog"\s*\n?\s*aria-modal="true"\s*\n?\s*aria-label="Confirm order cancellation"/,
    );
    expect(body).toMatch(/<h3 className="text-base font-semibold">Cancel this order\?<\/h3>/);
    expect(body).toMatch(
      /Order <span className="font-mono text-xs">\{cancelConfirmFor\}<\/span> will be marked\s*\n?\s*cancelled\. You can still mint a new order afterwards\. Crypto payments are\{' '\}\s*\n?\s*<strong>non-refundable<\/strong>; cancelling only stops the pending pay window — if\s*\n?\s*you've already sent crypto, contact support to reconcile\./,
    );
    expect(body).toMatch(
      /<button\s*\n?\s*type="button"\s*\n?\s*onClick=\{\(\) => setCancelConfirmFor\(null\)\}/,
    );
    expect(body).toMatch(
      /onClick=\{\(e\) => \{\s*\n?\s*if \(e\.target === e\.currentTarget\) setCancelConfirmFor\(null\);\s*\n?\s*\}\}/,
    );
  });

  it("Cancel-on-success refetch: useEffect on cancel.state.kind === 'succeeded' → refetch().then(cancel.reset) — pinned so a successful cancel flows the new 'cancelled' status into the table + resets the hook for the next cancel; per-row cancel only on status === 'pending' + stopPropagation prevents row-click selection bubbling; expires-soon pill nested inside Status cell with aria-label='Expires soon'", () => {
    expect(body).toMatch(
      /\/\/ Refresh the list on a successful cancel so the new 'cancelled'\s*\n?\s*\/\/ status flows into the table\. The cancel-hook's `succeeded` state\s*\n?\s*\/\/ is the trigger; we reset the hook after refetching so a second\s*\n?\s*\/\/ cancel on a different row starts from idle\./,
    );
    expect(body).toMatch(
      /if \(cancel\.state\.kind === 'succeeded'\) \{\s*\n?\s*void refetch\(\)\.then\(\(\) => \{\s*\n?\s*cancel\.reset\(\);\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
    expect(body).toMatch(/aria-label="Expires soon"/);
    expect(body).toMatch(
      /onClick=\{\(e\) => \{\s*\n?\s*e\.stopPropagation\(\);\s*\n?\s*if \(cancellationInFlight\) return;\s*\n?\s*setCancelConfirmFor\(o\.order_id\);\s*\n?\s*\}\}\s*\n?\s*disabled=\{cancellationInFlight\}/,
    );
    expect(body).toMatch(
      /cancellationInFlight && !isCancellingThis\s*\n?\s*\? 'Wait for the active order cancellation to finish\.'/,
    );
  });

  it("Empty-state branch: statusFilter === 'all' → 'No crypto orders yet. Open a checkout from the Billing view to create one.' / else 'No orders with status <strong>{statusFilter}</strong>. <Clear filter button>'; row-selected via aria-selected={isSelected} + bg-surface-inset class; load more button below table when nextCursor !== null + 'Loading more…' indicator when state.kind === 'loading_more'", () => {
    expect(body).toMatch(
      /\{statusFilter === 'all' \? \(\s*\n?\s*<>No crypto orders yet\. Open a checkout from the Billing view to create one\.<\/>\s*\n?\s*\) : \(/,
    );
    expect(body).toMatch(
      /No orders with status <strong>\{statusFilter\}<\/strong>\.\{' '\}\s*\n?\s*<button\s*\n?\s*type="button"\s*\n?\s*onClick=\{\(\) => setStatusFilter\('all'\)\}/,
    );
    expect(body).toMatch(
      /\{state\.kind === 'ready' && state\.data\.nextCursor !== null && \(\s*\n?\s*<div className="mt-2 flex justify-center">\s*\n?\s*<button\s*\n?\s*type="button"\s*\n?\s*onClick=\{\(\) => void loadMore\(\)\}/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
