// W484.B — drift guard for apps/gui-client/src/views/CryptoOrdersAdminView.tsx.
// V-534.AG admin crypto-orders view + 6 follow-on V-clusters
// (.AL .AM .AW .AX .BC .BL). Drift here either drops the 'crypto
// payments are non-refundable' architectural framing (a future
// refund button gets added without the reminder that refunds
// aren't supported) or breaks the V-534.BC payment_id reverse-
// lookup input (support can't drill from a NowPayments payment id
// the customer mentioned to the matching order envelope).
//
//   • V-534.AG framing pinned: 'admin crypto-orders view.' +
//     admin-scope framing.
//   • V-534.AL internal-note inline editor.
//   • V-534.AM detail-drawer click delegation + stopPropagation
//     on action buttons.
//   • V-534.AW cursor pagination wiring (V-666.AM 'Load more').
//   • V-534.AX 'Download CSV' button wired to V-666.AC.
//   • V-534.BC exact-match payment_id filter (V-666.AS).
//   • V-534.BL note-modal a11y through the shared focus trap, with
//     unsaved-note confirmation on every close path.
//   • 'Crypto payments are non-refundable' framing.
//   • STATUS_OPTIONS 7-entry (all + 6 statuses).
//   • Note dialog: maxLength 2000 + 'Leave empty + save to clear'
//     + noteInput.trim().length === 0 ? null : noteInput save
//     normalization.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/gui-client/src/views/CryptoOrdersAdminView.tsx');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W484.B apps/gui-client/src/views/CryptoOrdersAdminView.tsx content parity', () => {
  const body = read(LIB);

  it("V-534.AG/.AL/.AM/.AW/.AX/.BC 6-V-cluster framing pinned + non-refundable architectural framing pinned so refund actions can't sneak in unannotated", () => {
    expect(body).toMatch(/\/\/ V-534\.AG — admin crypto-orders view\./);
    expect(body).toMatch(
      /\/\/ V-534\.AL — adds inline internal-note editor \(admin-only field, never\s*\/\/\s+shown to the customer\)\./,
    );
    expect(body).toMatch(
      /\/\/ V-534\.AM — clicking an order row opens a detail drawer with the full\s*\/\/\s+envelope; action buttons stop propagation so they don't\s*\/\/\s+also open the drawer\./,
    );
    expect(body).toMatch(
      /\/\/ V-534\.AW — wires the V-666\.AM cursor pagination: when the server\s*\/\/\s+returns next_cursor, a "Load more" button appears below\s*\/\/\s+the table and appends the next page in place\./,
    );
    expect(body).toMatch(
      /\/\/ V-534\.AX — adds a "Download CSV" button that hits\s*\/\/\s+\/v1\/admin\/crypto-orders\.csv \(V-666\.AC\) with the current\s*\/\/\s+status \+ search filters and triggers a browser download\s*\/\/\s+via blob \+ synthesized anchor\./,
    );
    expect(body).toMatch(
      /\/\/ V-534\.BC — adds an exact-match payment_id input \(V-666\.AS\) used by\s*\/\/\s+support to reverse-look-up an order from a NowPayments\s*\/\/\s+payment id the customer sent over\./,
    );
    expect(body).toMatch(
      /\/\/ Crypto payments are non-refundable\. The view intentionally does\s*\/\/ NOT surface refund actions; customer cancellation stops future\s*\/\/ billing periods but does not refund the current period\./,
    );
  });

  it("Admin-scope framing pinned: 'Admin-only counterpart to CryptoOrdersHistoryView. Calls /v1/admin/crypto-orders (V-666.D + V-666.T) and renders the full cross-account list with status + free-text-search filter controls. Caller must hold an API key with the `driftstack_internal_admin` scope; without it the API returns 403 which surfaces as an error banner.' + 'V-666.D returns account_id in the public envelope so each row surfaces the owning account (helpful for support drilling into a customer's order).'", () => {
    expect(body).toMatch(
      /\/\/ Admin-only counterpart to CryptoOrdersHistoryView\. Calls\s*\/\/ \/v1\/admin\/crypto-orders \(V-666\.D \+ V-666\.T\) and renders the full\s*\/\/ cross-account list with status \+ free-text-search filter controls\.\s*\/\/ Caller must hold an API key with the `driftstack_internal_admin`\s*\/\/ scope; without it the API returns 403 which surfaces as an error\s*\/\/ banner\./,
    );
    expect(body).toMatch(
      /\/\/ V-666\.D returns account_id in the public envelope so each row\s*\/\/ surfaces the owning account \(helpful for support drilling into a\s*\/\/ customer's order\)\./,
    );
  });

  it("STATUS_OPTIONS 7-entry (all + 6 statuses): [{value:'', label:'All statuses'}, pending, confirming, paid, failed, partial, cancelled] — pinned so a status added server-side prompts a deliberate dropdown update", () => {
    expect(body).toMatch(
      /const STATUS_OPTIONS: Array<\{ value: AdminCryptoOrder\['status'\] \| ''; label: string \}> = \[\s*\{ value: '', label: 'All statuses' \},\s*\{ value: 'pending', label: 'Pending' \},\s*\{ value: 'confirming', label: 'Confirming' \},\s*\{ value: 'paid', label: 'Paid' \},\s*\{ value: 'failed', label: 'Failed' \},\s*\{ value: 'partial', label: 'Partial' \},\s*\{ value: 'cancelled', label: 'Cancelled' \},\s*\];/,
    );
  });

  it("Hook wiring: useAdminCryptoOrdersList opts with status (empty→null) + search + paymentId (empty→null) + createdAfter/Before with 'T00:00:00Z' ISO suffix; useAdminCsvExport shares the same filter shape (except paymentId — CSV scopes to status+search+date only by design)", () => {
    expect(body).toMatch(
      /const \{ state, refetch, loadMore \} = useAdminCryptoOrdersList\(\{\s*status: status === '' \? null : status,\s*search,\s*paymentId: paymentIdFilter\.length > 0 \? paymentIdFilter : null,\s*createdAfter: createdAfter\.length > 0 \? `\$\{createdAfter\}T00:00:00Z` : null,\s*createdBefore: createdBefore\.length > 0 \? `\$\{createdBefore\}T00:00:00Z` : null,\s*\}\);/,
    );
    expect(body).toMatch(
      /const csvExport = useAdminCsvExport\(\{\s*status: status === '' \? null : status,\s*search,\s*createdAfter: createdAfter\.length > 0 \? `\$\{createdAfter\}T00:00:00Z` : null,\s*createdBefore: createdBefore\.length > 0 \? `\$\{createdBefore\}T00:00:00Z` : null,\s*\}\);/,
    );
  });

  it('Internal-note save refreshes and clears state; every dirty close path uses one shared discard confirmation authority', () => {
    expect(body).toMatch(
      /if \(internalNote\.state\.kind === 'succeeded'\) \{\s*void refetch\(\)\.then\(\(\) => \{\s*internalNote\.reset\(\);\s*setNoteTarget\(null\);\s*setNoteInput\(''\);\s*\}\);\s*\}/,
    );
    expect(body).toMatch(/import \{ useConfirm \} from '\.\.\/components\/ConfirmProvider';/);
    expect(body).toMatch(/import \{ useFocusTrap \} from '\.\.\/lib\/use-focus-trap';/);
    expect(body).toMatch(/const noteDiscardConfirmOpenRef = useRef\(false\);/);
    expect(body).toMatch(
      /noteTarget === null \|\|\s*internalNote\.state\.kind === 'submitting' \|\|\s*noteDiscardConfirmOpenRef\.current/,
    );
    expect(body).toMatch(
      /if \(noteInput === \(noteTarget\.internal_note \?\? ''\)\) \{\s*closeNoteEditor\(\);\s*return;/,
    );
    expect(body).toMatch(
      /void confirm\('Discard this unsaved internal note\?', \{\s*confirmLabel: 'Discard note',\s*tone: 'danger',\s*\}\)\.then\(\(discard\) => \{/,
    );
    expect(body).toMatch(
      /useFocusTrap\(noteTarget !== null, noteDialogRef, requestCloseNoteEditor\);/,
    );
  });

  it("Filter row + Reset filters button: 5 filter inputs (Status select + Search + Payment ID + From + To) + Reset filters button visible only when any filter is active (status !== '' || search.length > 0 || paymentIdFilter.length > 0 || createdAfter.length > 0 || createdBefore.length > 0) — pinned so 'Reset filters' doesn't show on first mount with no filters set", () => {
    expect(body).toMatch(
      /\{\(status !== '' \|\|\s*search\.length > 0 \|\|\s*paymentIdFilter\.length > 0 \|\|\s*createdAfter\.length > 0 \|\|\s*createdBefore\.length > 0\) && \(\s*<button\s*type="button"\s*onClick=\{\(\) => \{\s*setStatus\(''\);\s*setSearch\(''\);\s*setPaymentIdFilter\(''\);\s*setCreatedAfter\(''\);\s*setCreatedBefore\(''\);\s*\}\}/,
    );
    expect(body).toMatch(/aria-label="Filter by NowPayments payment id"/);
  });

  it("Note dialog: maxLength 2000 + rows 5 + placeholder 'VIP — manual outreach scheduled / fraud signal / etc.' + framing 'Admin-only context for order ... This note is never shown to the customer. Leave empty + save to clear.' + save normalization noteInput.trim().length === 0 ? null : noteInput (empty saves null, not empty string) — pinned so empty-input clears the note correctly", () => {
    expect(body).toMatch(
      /<textarea\s*value=\{noteInput\}\s*onChange=\{\(e\) => setNoteInput\(e\.target\.value\)\}\s*disabled=\{internalNote\.state\.kind === 'submitting'\}\s*rows=\{5\}\s*maxLength=\{2000\}\s*placeholder="VIP — manual outreach scheduled \/ fraud signal \/ etc\."/,
    );
    expect(body).toMatch(
      /Admin-only context for order\{' '\}\s*<span className="font-mono text-xs">\{noteTarget\.order_id\}<\/span>\. This note is never\s*shown to the customer\. Leave empty \+ save to clear\./,
    );
    expect(body).toMatch(
      /const next = noteInput\.trim\(\)\.length === 0 \? null : noteInput;\s*void internalNote\.save\(noteTarget\.order_id, next\);/,
    );
    expect(body).toMatch(/if \(e\.target === e\.currentTarget\) requestCloseNoteEditor\(\);/);
    expect(body).toMatch(
      /onClick=\{requestCloseNoteEditor\}\s*disabled=\{internalNote\.state\.kind === 'submitting'\}/,
    );
  });

  it("Row-click delegation (V-534.AM): tr onClick=>setDetailOrder(o) + aria-selected={detailOrder?.order_id === o.order_id} + edit-note button stopPropagation so it doesn't trigger row-click; button label 'Edit note' / 'Add note' conditional on internal_note presence; CSV download button: disabled while downloading + aria-label='Download CSV of current filter'", () => {
    expect(body).toMatch(/onClick=\{\(\) => setDetailOrder\(o\)\}/);
    // a11y (audit 2026-07-09): the row is keyboard-operable — role="button" + tabIndex +
    // onKeyDown(Enter/Space) — and marks the selected row with aria-pressed (aria-selected
    // isn't valid on a non-grid <tr>).
    expect(body).toMatch(/role="button"/);
    expect(body).toMatch(/aria-pressed=\{detailOrder\?\.order_id === o\.order_id\}/);
    expect(body).toMatch(/onKeyDown=\{\(e\) => \{/);
    expect(body).toMatch(
      /onClick=\{\(e\) => \{\s*e\.stopPropagation\(\);\s*setNoteTarget\(o\);\s*setNoteInput\(o\.internal_note \?\? ''\);\s*\}\}/,
    );
    expect(body).toMatch(
      /\{o\.internal_note != null && o\.internal_note\.length > 0\s*\? 'Edit note'\s*: 'Add note'\}/,
    );
    expect(body).toMatch(/aria-label="Download CSV of current filter"/);
    expect(body).toMatch(
      /\{csvExport\.state\.kind === 'downloading' \? 'Downloading…' : 'Download CSV'\}/,
    );
  });

  it('Detail-drawer delegation: detailOrder !== null → <CryptoOrderAdminDetailDrawer order + onClose + onEditNote (drawer closes + opens note modal in one chord)> — pinned so admin can pivot from row-detail to note-edit without re-opening the drawer', () => {
    expect(body).toMatch(
      /\{detailOrder !== null && \(\s*<CryptoOrderAdminDetailDrawer\s*order=\{detailOrder\}\s*onClose=\{\(\) => setDetailOrder\(null\)\}\s*onEditNote=\{\(o\) => \{\s*setNoteTarget\(o\);\s*setNoteInput\(o\.internal_note \?\? ''\);\s*setDetailOrder\(null\);\s*\}\}\s*\/>\s*\)\}/,
    );
  });

  it("Error surfaces: top-of-view ErrorBanner for list error / internalNote.state.kind === 'failed' / csvExport.state.kind === 'failed' → 'CSV download failed: ${message}' format — pinned so 3 independent failure paths surface separately, not stomp each other", () => {
    expect(body).toMatch(
      /\{internalNote\.state\.kind === 'failed' && \(\s*<ErrorBanner message=\{internalNote\.state\.message\} onDismiss=\{\(\) => internalNote\.reset\(\)\} \/>\s*\)\}/,
    );
    expect(body).toMatch(
      /\{csvExport\.state\.kind === 'failed' && \(\s*<ErrorBanner\s*message=\{`CSV download failed: \$\{csvExport\.state\.message\}`\}\s*onDismiss=\{\(\) => csvExport\.reset\(\)\}\s*\/>\s*\)\}/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
