// W405.C — drift guard for apps/server/src/services/crypto-orders.ts.
// V-666.B crypto-orders state machine + NowPayments IPN
// fan-in. V-666.AT append-only event log + V-666.AO idempotency +
// V-666.J customer cancel + V-666.K bulk-sweep. Drift here either
// breaks the forward-only state machine (paid → pending reverse
// allowed) or scrambles V-666.AN failed-transition fan-out source
// labels.
//
//   • V-799: the store is the crypto_orders TABLE. `repo` is required
//     and bootstrap wires DrizzleCryptoOrdersRepo.
//   • CryptoOrderStatus: 6-literal union with V-666.J cancelled
//     terminal.
//   • V-666.AT CryptoOrderEvent: append-only event log; 5-source
//     union (create / ipn / cancel / expired / swept).
//   • V-666.Q customer_note (500-char cap at route) + V-666.AA
//     internal_note (2000-char cap at route).
//   • mapNowpaymentsStatus: 6-status-map (waiting→pending /
//     confirming|sending→confirming / partially_paid→partial /
//     finished→paid / failed|expired|refunded→failed).
//   • V-666.AM listForAdminPage opaque cursor codec: base64url JSON
//     of {ts: created_at, id: order_id} + tiebreak by order_id ASC.
//   • V-666.AO createIdempotent: per-account scope key
//     `${accountId ?? '_anon'}:${key}`; 24h TTL prune; V-666.AR
//     bodyFingerprint detect.
//   • V-666.J cancelOrder: only 'pending' cancellable; once paid is
//     seen (confirming/partial) → support handles refunds.
//   • V-666.K expireOrder + sweepExpiredOrders: pending older than
//     olderThanMs → failed; capped at limit (default 500).
//   • V-666.I crypto.order.paid + V-666.AN crypto.order.failed:
//     thin-seam emitter, prod wiring LIVE (migration 0064 added both
//     to the webhook_event_type enum; bootstrap wires the
//     WebhooksService sink); failed reason 3-source (ipn / expired /
//     swept).
//   • applyIpnStatus: forward-only state machine via
//     isTerminalForward; payment_id recorded even on no-op.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/services/crypto-orders.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W405.C apps/server/src/services/crypto-orders.ts content parity', () => {
  const body = read(LIB);

  it('V-666.B framing, corrected by V-799. This pinned "in-memory order store" and "no DB persistence yet", both false since the table landed: `repo` is a REQUIRED constructor field, bootstrap passes new DrizzleCryptoOrdersRepo(dbHandle), and cryptoOrders is a real pgTable. The operator runbook had inherited the same fiction and told on-call to expect every order to vanish on deploy.', () => {
    expect(body).toMatch(/V-666\.B — crypto-orders service\./);
    expect(body).toMatch(/Order store \+ state machine for the NowPayments IPN flow\./);
    expect(body, 'the in-memory framing must not return').not.toMatch(/In-memory order store/);
    expect(body).toMatch(/V-799 — this header used to say there was no DB persistence and that/);
    expect(body).not.toMatch(/no DB persistence yet/);
  });

  it('CryptoOrderStatus: 6-literal union (pending/confirming/paid/failed/partial + V-666.J cancelled terminal)', () => {
    expect(body).toMatch(/export type CryptoOrderStatus =/);
    expect(body).toMatch(/\| 'pending' \/\/ order created; awaiting payment/);
    expect(body).toMatch(/\| 'confirming' \/\/ payment seen; awaiting on-chain confirmations/);
    expect(body).toMatch(/\| 'paid' \/\/ confirmations received; goods unlocked/);
    expect(body).toMatch(/\| 'failed' \/\/ payment timeout \/ refund \/ expired/);
    expect(body).toMatch(/\| 'partial' \/\/ amount received < expected/);
    expect(body).toMatch(
      /\/\/ V-666\.J — customer-initiated abandonment of a pending order before\s*\/\/ any payment was received\. Terminal;/,
    );
    expect(body).toMatch(/\| 'cancelled';/);
  });

  it('V-666.AT CryptoOrderEvent: append-only event log + 5-source union (create/ipn/cancel/expired/swept)', () => {
    expect(body).toMatch(
      /V-666\.AT — append-only state-transition event\. Each entry records\s*\*\s*the status the order moved to \+ the source of that transition\./,
    );
    expect(body).toMatch(/export interface CryptoOrderEvent \{/);
    expect(body).toMatch(/source: 'create' \| 'ipn' \| 'cancel' \| 'expired' \| 'swept';/);
  });

  it('V-666.Q customer_note 500-char cap framing + V-666.AA internal_note 2000-char cap framing', () => {
    expect(body).toMatch(
      /V-666\.Q — customer-supplied free-text note for their own\s*\*\s*bookkeeping \(PO numbers, internal labels, etc\.\)\. Capped at 500\s*\*\s*chars at the route layer\./,
    );
    expect(body).toMatch(
      /V-666\.AA — admin-only internal note attached to the order\.[\s\S]+?Capped at 2000 chars at the route layer\s*\*\s*— twice the customer_note budget since these are internal/,
    );
  });

  it('mapNowpaymentsStatus: 6-status map (waiting→pending / confirming|sending→confirming / partially_paid→partial / finished→paid / failed|expired|refunded→failed); unknown→null', () => {
    expect(body).toMatch(
      /export function mapNowpaymentsStatus\(provider: string\): CryptoOrderStatus \| null \{/,
    );
    expect(body).toMatch(/case 'waiting':\s*return 'pending';/);
    expect(body).toMatch(/case 'confirming':\s*case 'sending':\s*return 'confirming';/);
    expect(body).toMatch(/case 'partially_paid':\s*return 'partial';/);
    expect(body).toMatch(/case 'finished':\s*return 'paid';/);
    expect(body).toMatch(/case 'failed':\s*case 'expired':\s*case 'refunded':\s*return 'failed';/);
    expect(body).toMatch(
      /default:\s*return null; \/\/ unknown provider status — caller decides what to do\./,
    );
  });

  it('V-666.AM cursor codec: base64url JSON of {ts: created_at, id: order_id} + decodeCursor null on malformed', () => {
    expect(body).toMatch(
      /V-666\.AM — opaque cursor codec used by listForAdminPage\. Encodes\s*\*\s*the \(created_at, order_id\) pair of the last row in the current\s*\*\s*page so the next call resumes immediately after it\./,
    );
    expect(body).toMatch(
      /export function encodeCursor\(cur: CryptoOrderCursor\): string \{\s*const json = JSON\.stringify\(cur\);\s*return Buffer\.from\(json, 'utf8'\)\.toString\('base64url'\);\s*\}/,
    );
    expect(body).toMatch(
      /if \(typeof obj\.ts !== 'number' \|\| typeof obj\.id !== 'string'\) return null;/,
    );
  });

  it('V-666.AR idempotencyBodyFingerprint: sha256-hex over structured args (not raw body — whitespace doesn’t false-mismatch)', () => {
    expect(body).toMatch(
      /V-666\.AR — body fingerprint for an idempotency-key request\. Hashed\s*\*\s*over the structured args \(not the raw request body\) so trivial\s*\*\s*differences like whitespace don't trigger a false mismatch\./,
    );
    expect(body).toMatch(
      /export function idempotencyBodyFingerprint\(args: \{\s*product: string;\s*price_cents: number;\s*price_currency: string;\s*\}\): string \{/,
    );
    expect(body).toMatch(
      /return nodeCreateHash\('sha256'\)\.update\(normalised\)\.digest\('hex'\);/,
    );
  });

  it("V-666.AO createIdempotent: per-account scope key `${accountId ?? '_anon'}:${key}` + 24h TTL prune", () => {
    expect(body).toMatch(/V-666\.AO — idempotency-key wrapper around create\(\)\./);
    expect(body).toMatch(
      /The key is scoped per-account \(or the literal '_anon' for\s*\*\s*pre-signup checkouts\)/,
    );
    expect(body).toMatch(/Records are pruned 24h\s*\*\s*after they were first stored/);
    expect(body).toMatch(
      /const scopeKey = `\$\{args\.account_id \?\? '_anon'\}:\$\{args\.idempotency_key\}`;/,
    );
    expect(body).toMatch(/private static readonly IDEMPOTENCY_TTL_MS = 24 \* 60 \* 60 \* 1000;/);
  });

  it('V-666.AP getIdempotencyMetrics: 3-counter snapshot (replays/firstWrites/V-666.AR bodyMismatches)', () => {
    expect(body).toMatch(
      /V-666\.AP — snapshot of the idempotency counters\. Exposed as a\s*\*\s*separate method \(rather than baked into getStatsForAdmin\) so\s*\*\s*that fast-firing metrics scrapers don't pay the full scan cost\./,
    );
    expect(body).toMatch(
      /getIdempotencyMetrics\(\): \{ replays: number; firstWrites: number; bodyMismatches: number \}/,
    );
  });

  it("V-666.J cancelOrder: only 'pending' cancellable; confirming/partial → support handles refunds; cross-account returns null (404-style)", () => {
    expect(body).toMatch(
      /V-666\.J — customer-initiated cancel on a pending order\. Only\s*\*\s*`pending` orders can be cancelled; once a payment has been seen\s*\*\s*\(confirming\/partial\) the cancellation must go through support/,
    );
    // #7 — cancelOrder is row-locked (withOrderLock) so a concurrent IPN can't clobber
    // it; the ownership + pending guards run against the LOCKED committed row.
    expect(body).toMatch(/return this\.opts\.repo\.withOrderLock</);
    expect(body).toMatch(
      /if \(order\.account_id !== args\.account_id\) \{\s*return \{ updated: null, result: null \};/,
    );
    expect(body).toMatch(
      /if \(order\.status !== 'pending'\) \{\s*return \{ updated: null, result: \{ ok: 'not_cancellable' as const, reason: order\.status \} \};/,
    );
    expect(body).toMatch(
      /events: \[\.\.\.order\.events, \{ status: 'cancelled', at: now, source: 'cancel' \}\],/,
    );
  });

  it('V-666.K expireOrder: only pending eligible; pending OR new states left alone; maps to failed; emitFailedTransition source=expired', () => {
    expect(body).toMatch(
      /V-666\.K — auto-expire a single pending order if it's older than\s*\*\s*`olderThanMs`\. Only `pending` orders are eligible/,
    );
    // #79 — expireOrder now re-checks + writes under the row lock (SELECT…FOR UPDATE)
    // so a concurrent IPN (pending→paid) can't be clobbered back to failed by an
    // unlocked read-modify-upsert; the guard reads the LOCKED committed row.
    expect(body).toMatch(
      /await this\.opts\.repo\.withOrderLock<CryptoOrder \| null>\(\s*args\.order_id,/,
    );
    expect(body).toMatch(
      /if \(order\.status !== 'pending' \|\| now - order\.created_at < args\.olderThanMs\) \{/,
    );
    expect(body).toMatch(
      /events: \[\.\.\.order\.events, \{ status: 'failed', at: now, source: 'expired' \}\],/,
    );
    expect(body).toMatch(/await this\.emitFailedTransition\(expiredOrder, 'expired'\);/);
  });

  it('V-666.K sweepExpiredOrders: default limit=500 + oldest-first listPendingOlderThan scan + capped=(scan filled limit) honest signal; per-row emitFailedTransition source=swept', () => {
    expect(body).toMatch(/V-666\.K — bulk-sweep pending orders older than `olderThanMs`,/);
    expect(body).toMatch(/const limit = opts\.limit \?\? 500;/);
    // Oldest-first scan via listPendingOlderThan — a newest-first
    // listAll scan would never reach stale old orders at scale.
    expect(body).toMatch(
      /this\.opts\.repo\.listPendingOlderThan\(\{ olderThan: cutoff, limit \}\)/,
    );
    // #79 — the sweep now re-checks + writes per-row under withOrderLock, not the stale
    // listPendingOlderThan snapshot, so a concurrent IPN that flipped the row pending→paid
    // is SEEN under the lock and the row is skipped (no blind clobber to failed).
    expect(body).toMatch(/this\.opts\.repo\.withOrderLock<CryptoOrder \| null>\(o\.order_id,/);
    expect(body).toMatch(
      /events: \[\.\.\.order\.events, \{ status: 'failed', at: now, source: 'swept' \}\],/,
    );
    expect(body).toMatch(/await this\.emitFailedTransition\(swept, 'swept'\);/);
    // `capped` keys off whether the scan filled the limit (more may
    // remain), not the flip count — so the cron re-runs correctly.
    expect(body).toMatch(/return \{ expired, capped: candidates\.length === limit \};/);
  });

  it('applyIpnStatus: forward-only state machine via isTerminalForward; same-state no-event-append (idempotent refresh); record payment_id on no-op', () => {
    expect(body).toMatch(
      /Idempotent: receiving the same paid IPN twice is a no-op\.\s*\*\s*Reverse transitions \(paid → pending\) are rejected/,
    );
    expect(body).toMatch(
      /\/\/ V-666\.AT — append an event only on an actual status change; a same-state\s*\/\/ refresh just bumps updated_at\./,
    );
    // The event append now carries the optional reconciliation amounts
    // (...reconcileFields) on an IPN transition (billing-integrity #1).
    expect(body).toMatch(
      /const events =\s*order\.status === mapped\s*\?\s*order\.events\s*:\s*\[\s*\.\.\.order\.events,\s*\{ status: mapped, at: now, source: 'ipn' as const, \.\.\.reconcileFields \},\s*\];/,
    );
    expect(body).toMatch(
      /\/\/ No-op transition: record the payment_id \+ crypto quote if we didn't have them yet\./,
    );
    // #3 — the read-modify-write is row-locked (SELECT … FOR UPDATE via withOrderLock)
    // so concurrent / re-delivered IPNs serialize + decide against the committed row.
    expect(body).toMatch(/await this\.opts\.repo\.withOrderLock\(args\.order_id,/);
    // Billing-integrity (#1 crypto-denominated reconciliation) — a short-pay
    // routes to partial; actually_paid + the owed quote are BOTH in pay_currency
    // (never compared against the FIAT price_amount).
    expect(body).toMatch(
      /const minAccepted = owed \* \(1 - AMOUNT_RECONCILE_TOLERANCE_FRACTION\);\s*if \(args\.actually_paid < minAccepted\) \{\s*mapped = 'partial';/,
    );
    // Billing-integrity (#1) — pay_currency-mismatch guard never unlocks the tier.
    expect(body).toContain("event: 'ipn_pay_currency_mismatch',");
    // Billing-integrity (#9 payment_id binding) — mismatch is rejected + alarmed.
    expect(body).toMatch(
      /if \(order\.payment_id !== null && order\.payment_id !== args\.payment_id\) \{/,
    );
    expect(body).toContain("event: 'ipn_payment_id_mismatch',");
  });

  it('recordPaymentId: binds the minted NowPayments payment_id + crypto quote at createPayment (#9/#1), one-time (no overwrite)', () => {
    expect(body).toMatch(
      /async recordPaymentId\(args: \{\s*order_id: string;\s*payment_id: string;[\s\S]*?pay_amount\?: number;[\s\S]*?pay_currency\?: string;\s*\}\): Promise<CryptoOrder \| null> \{/,
    );
    expect(body).toMatch(
      /if \(order\.payment_id !== null\) \{\s*\/\/[\s\S]*?return \{ updated: null, result: order \};/,
    );
  });

  it('V-666.I crypto.order.paid emission: only when transitioning INTO paid (skip re-deliver) + account_id non-null + payload 6-field', () => {
    expect(body).toMatch(
      /\/\/ V-666\.I\/R — crypto\.order\.paid webhook \+ receipt email on the →paid transition\./,
    );
    expect(body).toMatch(
      /firePaid: order\.status !== 'paid' && mapped === 'paid' && updated\.account_id !== null,/,
    );
    expect(body).toMatch(
      /await this\.opts\.webhooks\.enqueueEvent\(outcome\.order\.account_id, 'crypto\.order\.paid', \{\s*order_id: outcome\.order\.order_id,\s*product: outcome\.order\.product,\s*price_cents: outcome\.order\.price_cents,\s*price_currency: outcome\.order\.price_currency,\s*payment_id: outcome\.order\.payment_id,\s*paid_at: paidAtIso,/,
    );
  });

  it('V-666.AN emitFailedTransition: 3-reason union (ipn/expired/swept); account_id null → skip; emitter undefined → skip; best-effort swallow', () => {
    expect(body).toMatch(
      /V-666\.AN — fire crypto\.order\.failed when an order transitions\s*\*\s*INTO the failed state\. Shared by the three failed-transition\s*\*\s*paths \(applyIpnStatus, expireOrder, sweepExpiredOrders\)\./,
    );
    expect(body).toMatch(
      /private async emitFailedTransition\(\s*order: CryptoOrder,\s*reason: 'ipn' \| 'expired' \| 'swept',\s*\): Promise<void> \{\s*if \(order\.account_id === null\) return;\s*if \(this\.opts\.webhooks === undefined\) return;/,
    );
    expect(body).toMatch(
      /await this\.opts\.webhooks\.enqueueEvent\(order\.account_id, 'crypto\.order\.failed', \{[\s\S]+?reason,\s*failed_at: failedAtIso,/,
    );
  });

  it("CryptoOrderWebhookEmitter: thin-seam emitter accepts 'crypto.order.paid'|'crypto.order.failed' literals; prod wiring LIVE (migration 0064 added the enum values; bootstrap wires the WebhooksService sink)", () => {
    expect(body).toMatch(/Production wiring is LIVE: migration 0064 \(2026-05-22\) added/);
    expect(body).toMatch(/export interface CryptoOrderWebhookEmitter \{/);
    expect(body).toMatch(/eventType: 'crypto\.order\.paid' \| 'crypto\.order\.failed',/);
  });

  it('isTerminalForward state machine: paid/failed/cancelled terminal; partial → only paid|failed; current===next → idempotent true', () => {
    expect(body).toMatch(
      /function isTerminalForward\(current: CryptoOrderStatus, next: CryptoOrderStatus\): boolean \{/,
    );
    expect(body).toMatch(
      /\/\/ Same state — idempotent no-op, but caller wants the row touched\s*\/\/ \(updated_at refresh\)\.\s*if \(current === next\) return true;/,
    );
    expect(body).toMatch(
      /\/\/ Terminal statuses don't move\. V-666\.J — 'cancelled' joins\s*\/\/ 'paid'\/'failed' as terminal; a late IPN payment cannot revive\s*\/\/ an abandoned order\.\s*if \(current === 'paid' \|\| current === 'failed' \|\| current === 'cancelled'\) return false;/,
    );
    expect(body).toMatch(
      /\/\/ 'partial' is semi-terminal: only 'paid' or 'failed' overrides it\.\s*if \(current === 'partial'\) return next === 'paid' \|\| next === 'failed';/,
    );
  });

  it('listForAdminPage: cursor anchorIdx===-1 → empty page (ran off the end); page slice + nextCursor when hasMore', () => {
    expect(body).toMatch(
      /\/\/ If we can't find the anchor row in the scan window, behave\s*\/\/ conservatively and return an empty page rather than guessing\./,
    );
    expect(body).toMatch(
      /if \(anchorIdx === -1\) \{\s*return \{ orders: \[\], nextCursor: null \};\s*\}/,
    );
    expect(body).toMatch(
      /const nextCursor =\s*hasMore && last !== undefined\s*\?\s*encodeCursor\(\{ ts: last\.created_at, id: last\.order_id \}\)\s*:\s*null;/,
    );
  });

  it('V-666.AC getPendingAgeHistogram: 4-bucket (under_1h / h1_to_6h / h6_to_24h / over_24h); pending-only count + pendingValueCents by currency', () => {
    expect(body).toMatch(
      /V-666\.AC — pending-orders age histogram\. For each currently-\s*\*\s*pending order \(status === 'pending'\), bucket by age since\s*\*\s*created_at\. Buckets are: under_1h \/ 1h_to_6h \/ 6h_to_24h \/\s*\*\s*over_24h\./,
    );
    expect(body).toMatch(
      /if \(ageMs < 60 \* 60_000\) buckets\.under_1h \+= 1;\s*else if \(ageMs < 6 \* 60 \* 60_000\) buckets\.h1_to_6h \+= 1;\s*else if \(ageMs < 24 \* 60 \* 60_000\) buckets\.h6_to_24h \+= 1;\s*else buckets\.over_24h \+= 1;/,
    );
  });

  it('InMemoryCryptoOrdersRepo: Map<order_id, CryptoOrder>; listAll sorts created_at DESC; default limit=50; accountId filter optional', () => {
    expect(body).toMatch(/export class InMemoryCryptoOrdersRepo implements CryptoOrdersRepo \{/);
    expect(body).toMatch(/private readonly orders = new Map<string, CryptoOrder>\(\);/);
    expect(body).toMatch(/const limit = opts\.limit \?\? 50;/);
    expect(body).toMatch(
      /return filtered\.sort\(\(a, b\) => b\.created_at - a\.created_at\)\.slice\(0, limit\);/,
    );
  });

  it('imports: createHash aliased as nodeCreateHash from node:crypto', () => {
    expect(body).toMatch(/import \{ createHash as nodeCreateHash \} from 'node:crypto';/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
  // V-2014 — four methods here bound a scan window; three say so and one does not.
  //
  //   listForAdminPage           1_000    no `truncated`
  //   getDailyBreakdownForAdmin  10_000   truncated
  //   getStatsForAdmin           10_000   truncated
  //   getPendingAgeHistogram     10_000   truncated
  //
  // The published shapes agree: /v1/admin/crypto-orders returns
  // { orders, next_cursor } while its three siblings on the same resource
  // publish `truncated` (two also `scanned`).
  //
  // ⛔ The undisclosed one is the case where it matters most. The other three
  // return an aggregate — a truncated total is wrong but visibly a total. This
  // one PAGINATES, and when the cursor's anchor falls outside the scan window it
  // returns `{ orders: [], nextCursor: null }`, which is byte-identical to "you
  // have reached the end". Three states collapse into one response: no more rows,
  // a malformed cursor, and a list longer than the window.
  //
  // Not fixed here: adding a field to a published admin response is a contract
  // change and belongs with the owner (same disposition as W-10). This arm is the
  // unblocked half — it puts the exception on a list somebody had to look at, the
  // way V-1048 does for a route that can never succeed, so a FIFTH bounded scan
  // cannot land silently on the undisclosed side.
  it('CRITICAL every scan-bounded method discloses truncation, except the one listed. A bounded scan that does not say it was bounded reports a partial answer as a complete one.', () => {
    const src = readFileSync(LIB, 'utf8');
    const lines = src.split('\n');
    const UNDISCLOSED_BY_DECISION = new Set(['listForAdminPage']);

    const bounded: Array<{ method: string; discloses: boolean }> = [];
    lines.forEach((line, i) => {
      if (!/scanLimit\s*\?\?\s*[\d_]+/.test(line)) return;
      let owner = '<none>';
      for (let j = i; j >= 0; j -= 1) {
        const m = /^ {2}(?:async )?([A-Za-z_$][\w$]*)\(/.exec(lines[j] as string);
        if (m) {
          owner = m[1] as string;
          break;
        }
      }
      let end = i;
      while (
        end < lines.length &&
        !/^ {2}(?:async )?[A-Za-z_$][\w$]*\(/.test(lines[end] as string)
      ) {
        end += 1;
      }
      const start = lines.findIndex(
        (l, k) => k <= i && new RegExp(`^ {2}(?:async )?${owner.replace(/\$/g, '\\$')}\\(`).test(l),
      );
      bounded.push({
        method: owner,
        discloses: lines.slice(start, end).join('\n').includes('truncated:'),
      });
    });

    // Non-vacuity: an empty scan satisfies the emptiness assertion below.
    expect(bounded.length, 'methods establishing a scan bound').toBeGreaterThanOrEqual(4);
    expect(
      bounded
        .filter((b) => !b.discloses && !UNDISCLOSED_BY_DECISION.has(b.method))
        .map((b) => b.method),
      'a method bounds its scan without publishing a truncation flag — either return one, or add it to the list with a reason',
    ).toEqual([]);
    // And the exemption cannot rot: the file it names must still be bounded and still silent.
    const named = bounded.find((b) => b.method === 'listForAdminPage');
    expect(
      named,
      'listForAdminPage no longer bounds a scan — drop it from the exemption',
    ).toBeDefined();
    expect(
      named?.discloses,
      'listForAdminPage now discloses truncation — remove it from UNDISCLOSED_BY_DECISION',
    ).toBe(false);
  });
});
