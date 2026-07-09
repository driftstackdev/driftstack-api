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
//   • V-534.BL note-modal a11y (Escape + textarea autofocus).
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
      /\/\/ V-534\.AL — adds inline internal-note editor \(admin-only field, never\s*\n?\s*\/\/\s+shown to the customer\)\./,
    );
    expect(body).toMatch(
      /\/\/ V-534\.AM — clicking an order row opens a detail drawer with the full\s*\n?\s*\/\/\s+envelope; action buttons stop propagation so they don't\s*\n?\s*\/\/\s+also open the drawer\./,
    );
    expect(body).toMatch(
      /\/\/ V-534\.AW — wires the V-666\.AM cursor pagination: when the server\s*\n?\s*\/\/\s+returns next_cursor, a "Load more" button appears below\s*\n?\s*\/\/\s+the table and appends the next page in place\./,
    );
    expect(body).toMatch(
      /\/\/ V-534\.AX — adds a "Download CSV" button that hits\s*\n?\s*\/\/\s+\/v1\/admin\/crypto-orders\.csv \(V-666\.AC\) with the current\s*\n?\s*\/\/\s+status \+ search filters and triggers a browser download\s*\n?\s*\/\/\s+via blob \+ synthesized anchor\./,
    );
    expect(body).toMatch(
      /\/\/ V-534\.BC — adds an exact-match payment_id input \(V-666\.AS\) used by\s*\n?\s*\/\/\s+support to reverse-look-up an order from a NowPayments\s*\n?\s*\/\/\s+payment id the customer sent over\./,
    );
    expect(body).toMatch(
      /\/\/ Crypto payments are non-refundable\. The view intentionally does\s*\n?\s*\/\/ NOT surface refund actions; customer cancellation stops future\s*\n?\s*\/\/ billing periods but does not refund the current period\./,
    );
  });

  it("Admin-scope framing pinned: 'Admin-only counterpart to CryptoOrdersHistoryView. Calls /v1/admin/crypto-orders (V-666.D + V-666.T) and renders the full cross-account list with status + free-text-search filter controls. Caller must hold an API key with the `driftstack_internal_admin` scope; without it the API returns 403 which surfaces as an error banner.' + 'V-666.D returns account_id in the public envelope so each row surfaces the owning account (helpful for support drilling into a customer's order).'", () => {
    expect(body).toMatch(
      /\/\/ Admin-only counterpart to CryptoOrdersHistoryView\. Calls\s*\n?\s*\/\/ \/v1\/admin\/crypto-orders \(V-666\.D \+ V-666\.T\) and renders the full\s*\n?\s*\/\/ cross-account list with status \+ free-text-search filter controls\.\s*\n?\s*\/\/ Caller must hold an API key with the `driftstack_internal_admin`\s*\n?\s*\/\/ scope; without it the API returns 403 which surfaces as an error\s*\n?\s*\/\/ banner\./,
    );
    expect(body).toMatch(
      /\/\/ V-666\.D returns account_id in the public envelope so each row\s*\n?\s*\/\/ surfaces the owning account \(helpful for support drilling into a\s*\n?\s*\/\/ customer's order\)\./,
    );
  });

  it("STATUS_OPTIONS 7-entry (all + 6 statuses): [{value:'', label:'All statuses'}, pending, confirming, paid, failed, partial, cancelled] — pinned so a status added server-side prompts a deliberate dropdown update", () => {
    expect(body).toMatch(
      /const STATUS_OPTIONS: Array<\{ value: AdminCryptoOrder\['status'\] \| ''; label: string \}> = \[\s*\n?\s*\{ value: '', label: 'All statuses' \},\s*\n?\s*\{ value: 'pending', label: 'Pending' \},\s*\n?\s*\{ value: 'confirming', label: 'Confirming' \},\s*\n?\s*\{ value: 'paid', label: 'Paid' \},\s*\n?\s*\{ value: 'failed', label: 'Failed' \},\s*\n?\s*\{ value: 'partial', label: 'Partial' \},\s*\n?\s*\{ value: 'cancelled', label: 'Cancelled' \},\s*\n?\s*\];/,
    );
  });

  it("Hook wiring: useAdminCryptoOrdersList opts with status (empty→null) + search + paymentId (empty→null) + createdAfter/Before with 'T00:00:00Z' ISO suffix; useAdminCsvExport shares the same filter shape (except paymentId — CSV scopes to status+search+date only by design)", () => {
    expect(body).toMatch(
      /const \{ state, refetch, loadMore \} = useAdminCryptoOrdersList\(\{\s*\n?\s*status: status === '' \? null : status,\s*\n?\s*search,\s*\n?\s*paymentId: paymentIdFilter\.length > 0 \? paymentIdFilter : null,\s*\n?\s*createdAfter: createdAfter\.length > 0 \? `\$\{createdAfter\}T00:00:00Z` : null,\s*\n?\s*createdBefore: createdBefore\.length > 0 \? `\$\{createdBefore\}T00:00:00Z` : null,\s*\n?\s*\}\);/,
    );
    expect(body).toMatch(
      /const csvExport = useAdminCsvExport\(\{\s*\n?\s*status: status === '' \? null : status,\s*\n?\s*search,\s*\n?\s*createdAfter: createdAfter\.length > 0 \? `\$\{createdAfter\}T00:00:00Z` : null,\s*\n?\s*createdBefore: createdBefore\.length > 0 \? `\$\{createdBefore\}T00:00:00Z` : null,\s*\n?\s*\}\);/,
    );
  });

  it("Internal-note save flow: useEffect on internalNote.state.kind === 'succeeded' → refetch().then(reset + setNoteTarget(null) + setNoteInput('')) — pinned so the new note flows into the table + dialog state clears for the next edit; V-534.BL modal a11y: Escape closes + clears note state + textarea autofocus on open", () => {
    expect(body).toMatch(
      /if \(internalNote\.state\.kind === 'succeeded'\) \{\s*\n?\s*void refetch\(\)\.then\(\(\) => \{\s*\n?\s*internalNote\.reset\(\);\s*\n?\s*setNoteTarget\(null\);\s*\n?\s*setNoteInput\(''\);\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /\/\/ V-534\.BL — modal a11y: escape closes the note dialog; the textarea\s*\n?\s*\/\/ receives focus on open\./,
    );
    expect(body).toMatch(
      /if \(e\.key === 'Escape'\) \{\s*\n?\s*setNoteTarget\(null\);\s*\n?\s*setNoteInput\(''\);\s*\n?\s*\}\s*\n?\s*\};\s*\n?\s*window\.addEventListener\('keydown', onKey\);\s*\n?\s*noteTextareaRef\.current\?\.focus\(\);/,
    );
  });

  it("Filter row + Reset filters button: 5 filter inputs (Status select + Search + Payment ID + From + To) + Reset filters button visible only when any filter is active (status !== '' || search.length > 0 || paymentIdFilter.length > 0 || createdAfter.length > 0 || createdBefore.length > 0) — pinned so 'Reset filters' doesn't show on first mount with no filters set", () => {
    expect(body).toMatch(
      /\{\(status !== '' \|\|\s*\n?\s*search\.length > 0 \|\|\s*\n?\s*paymentIdFilter\.length > 0 \|\|\s*\n?\s*createdAfter\.length > 0 \|\|\s*\n?\s*createdBefore\.length > 0\) && \(\s*\n?\s*<button\s*\n?\s*type="button"\s*\n?\s*onClick=\{\(\) => \{\s*\n?\s*setStatus\(''\);\s*\n?\s*setSearch\(''\);\s*\n?\s*setPaymentIdFilter\(''\);\s*\n?\s*setCreatedAfter\(''\);\s*\n?\s*setCreatedBefore\(''\);\s*\n?\s*\}\}/,
    );
    expect(body).toMatch(/aria-label="Filter by NowPayments payment id"/);
  });

  it("Note dialog: maxLength 2000 + rows 5 + placeholder 'VIP — manual outreach scheduled / fraud signal / etc.' + framing 'Admin-only context for order ... This note is never shown to the customer. Leave empty + save to clear.' + save normalization noteInput.trim().length === 0 ? null : noteInput (empty saves null, not empty string) — pinned so empty-input clears the note correctly", () => {
    expect(body).toMatch(
      /<textarea\s*\n?\s*ref=\{noteTextareaRef\}\s*\n?\s*value=\{noteInput\}\s*\n?\s*onChange=\{\(e\) => setNoteInput\(e\.target\.value\)\}\s*\n?\s*rows=\{5\}\s*\n?\s*maxLength=\{2000\}\s*\n?\s*placeholder="VIP — manual outreach scheduled \/ fraud signal \/ etc\."/,
    );
    expect(body).toMatch(
      /Admin-only context for order\{' '\}\s*\n?\s*<span className="font-mono text-xs">\{noteTarget\.order_id\}<\/span>\. This note is never\s*\n?\s*shown to the customer\. Leave empty \+ save to clear\./,
    );
    expect(body).toMatch(
      /const next = noteInput\.trim\(\)\.length === 0 \? null : noteInput;\s*\n?\s*void internalNote\.save\(noteTarget\.order_id, next\);/,
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
      /onClick=\{\(e\) => \{\s*\n?\s*e\.stopPropagation\(\);\s*\n?\s*setNoteTarget\(o\);\s*\n?\s*setNoteInput\(o\.internal_note \?\? ''\);\s*\n?\s*\}\}/,
    );
    expect(body).toMatch(
      /\{o\.internal_note != null && o\.internal_note\.length > 0\s*\n?\s*\? 'Edit note'\s*\n?\s*: 'Add note'\}/,
    );
    expect(body).toMatch(/aria-label="Download CSV of current filter"/);
    expect(body).toMatch(
      /\{csvExport\.state\.kind === 'downloading' \? 'Downloading…' : 'Download CSV'\}/,
    );
  });

  it('Detail-drawer delegation: detailOrder !== null → <CryptoOrderAdminDetailDrawer order + onClose + onEditNote (drawer closes + opens note modal in one chord)> — pinned so admin can pivot from row-detail to note-edit without re-opening the drawer', () => {
    expect(body).toMatch(
      /\{detailOrder !== null && \(\s*\n?\s*<CryptoOrderAdminDetailDrawer\s*\n?\s*order=\{detailOrder\}\s*\n?\s*onClose=\{\(\) => setDetailOrder\(null\)\}\s*\n?\s*onEditNote=\{\(o\) => \{\s*\n?\s*setNoteTarget\(o\);\s*\n?\s*setNoteInput\(o\.internal_note \?\? ''\);\s*\n?\s*setDetailOrder\(null\);\s*\n?\s*\}\}\s*\n?\s*\/>\s*\n?\s*\)\}/,
    );
  });

  it("Error surfaces: top-of-view ErrorBanner for list error / internalNote.state.kind === 'failed' / csvExport.state.kind === 'failed' → 'CSV download failed: ${message}' format — pinned so 3 independent failure paths surface separately, not stomp each other", () => {
    expect(body).toMatch(
      /\{internalNote\.state\.kind === 'failed' && \(\s*\n?\s*<ErrorBanner message=\{internalNote\.state\.message\} onDismiss=\{\(\) => internalNote\.reset\(\)\} \/>\s*\n?\s*\)\}/,
    );
    expect(body).toMatch(
      /\{csvExport\.state\.kind === 'failed' && \(\s*\n?\s*<ErrorBanner\s*\n?\s*message=\{`CSV download failed: \$\{csvExport\.state\.message\}`\}\s*\n?\s*onDismiss=\{\(\) => csvExport\.reset\(\)\}\s*\n?\s*\/>\s*\n?\s*\)\}/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
