// W1047 — routes/admin-crypto-orders V-666.D + V-666.F/L/N/O/T/V/AA/AC/AM/AS
// cross-source invariant. Pins apps/server/src/routes/admin-crypto-orders.ts:
//
//   V-666.D anchor — 'V-666.D — admin crypto-orders routes'.
//
//   Endpoint roster — 9 routes:
//     GET  /v1/admin/crypto-orders
//     GET  /v1/admin/crypto-orders/stats                  (V-666.N)
//     GET  /v1/admin/crypto-orders/daily                  (V-666.O)
//     GET  /v1/admin/crypto-orders/pending-age            (V-666.AC)
//     GET  /v1/admin/crypto-orders.csv                    (V-666.V)
//     GET  /v1/admin/crypto-orders/:order_id
//     POST /v1/admin/crypto-orders/:order_id/apply-ipn    (V-666.F)
//     PATCH /v1/admin/crypto-orders/:order_id/internal-note (V-666.AA)
//     POST /v1/admin/crypto-orders/sweep-expired          (V-666.L)
//
//   driftstack_internal_admin scope on every route.
//
//   Read-only framing — 'Read-only — order mutations happen via the
//   IPN pipeline (V-666 / B)'. The single exception is apply-ipn
//   (V-666.F) which mirrors the IPN state machine.
//
//   V-666.T list filter — status enum + search free-text + V-666.AS
//   exact-match payment_id (capped at 128).
//
//   V-666.AM cursor pagination — capped at 512 chars.
//
//   V-666.BY half-open created_at window (same shape as V-666.BX
//   customer endpoint).
//
//   V-666.F apply-ipn body — provider_status + payment_id.
//
//   V-666.L sweep body — older_than_hours (1..8760) + limit (1..500).
//
//   V-666.O daily days cap — 90.
//
//   V-666.V CSV ceiling — limit 1000 (higher than list ceiling 200).
//
// stays in lockstep across apps/server/src/routes/admin-crypto-orders.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  if (!existsSync(p)) throw new Error(`missing ${p}`);
  return readFileSync(p, 'utf8');
}

describe('W1047 routes/admin-crypto-orders V-666.D + family cross-source invariant', () => {
  // ─── V-666.D anchor + 9-endpoint roster ──────────────────────

  it("CRITICAL V-666.D anchor — 'V-666.D — admin crypto-orders routes'. The single-anchor design ties the admin surface to the V-666 NowPayments rail.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin-crypto-orders.ts'));
    expect(p).toMatch(/V-666\.D — admin crypto-orders routes\./);
  });

  it('CRITICAL endpoint roster — 9 routes covered (list / stats / daily / pending-age / .csv / single / apply-ipn / internal-note / sweep-expired). The exhaustive header comment is the canonical contract.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin-crypto-orders.ts'));
    expect(p).toMatch(/GET\s+\/v1\/admin\/crypto-orders\?account_id=acc_X&limit=N/);
    expect(p).toMatch(/GET\s+\/v1\/admin\/crypto-orders\/stats\s+\(V-666\.N\)/);
    expect(p).toMatch(/GET\s+\/v1\/admin\/crypto-orders\/daily\?days=N\s+\(V-666\.O\)/);
    expect(p).toMatch(/GET\s+\/v1\/admin\/crypto-orders\/pending-age\s+\(V-666\.AC\)/);
    expect(p).toMatch(/GET\s+\/v1\/admin\/crypto-orders\.csv\s+\(V-666\.V\)/);
    expect(p).toMatch(/GET\s+\/v1\/admin\/crypto-orders\/:order_id/);
    expect(p).toMatch(/POST \/v1\/admin\/crypto-orders\/:order_id\/apply-ipn\s+\(V-666\.F\)/);
    expect(p).toMatch(/PATCH \/v1\/admin\/crypto-orders\/:order_id\/internal-note \(V-666\.AA\)/);
    expect(p).toMatch(/POST \/v1\/admin\/crypto-orders\/sweep-expired\s+\(V-666\.L\)/);
  });

  it("CRITICAL admin auth framing — 'Auth: driftstack_internal_admin scope. Used by the founder dashboard + support ops to look up the order behind a customer's \"I sent the payment but the dashboard still says pending\" ticket'. The support-ops use-case is the load-bearing design driver.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin-crypto-orders.ts'));
    expect(p).toMatch(/Auth: driftstack_internal_admin scope\. Used by the founder dashboard/);
    expect(p).toMatch(/\+ support ops to look up the order behind a customer's/);
    expect(p).toMatch(/"I sent the payment but the dashboard still says pending" ticket\./);
  });

  it("CRITICAL read-only framing — 'Read-only — order mutations happen via the IPN pipeline (V-666 / B)'. The single mutation exception is apply-ipn which mirrors the IPN state machine.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin-crypto-orders.ts'));
    expect(p).toMatch(/Read-only — order mutations happen via the IPN pipeline/);
    expect(p).toMatch(/\(V-666 \/ B\)\./);
  });

  // ─── ListQuery filter knobs ──────────────────────────────────

  it('CRITICAL ListQuery status enum — same 6 values as customer endpoint (pending / confirming / paid / failed / partial / cancelled). The shared enum keeps customer + admin filter semantics aligned.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin-crypto-orders.ts'));
    expect(p).toMatch(
      /status: z\.enum\(\['pending', 'confirming', 'paid', 'failed', 'partial', 'cancelled'\]\)\.optional\(\),/,
    );
  });

  it('CRITICAL V-666.T search free-text — min 1, max 200 chars. The 200-char ceiling matches typical customer ticket reference fields.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin-crypto-orders.ts'));
    expect(p).toMatch(/V-666\.T — admin search\/filter knobs\./);
    expect(p).toMatch(/search: z\.string\(\)\.min\(1\)\.max\(200\)\.optional\(\),/);
  });

  it("CRITICAL V-666.AS payment_id exact-match — capped at 128. 'real NowPayments ids are ~20 chars; cap prevents query-log bloat from abuse'.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin-crypto-orders.ts'));
    expect(p).toMatch(/V-666\.AS — exact-match payment_id filter\. Capped at 128 so abuse/);
    expect(p).toMatch(/can't bloat the query log; real NowPayments ids are ~20 chars\./);
    expect(p).toMatch(/payment_id: z\.string\(\)\.min\(1\)\.max\(128\)\.optional\(\),/);
  });

  it('CRITICAL V-666.AM cursor — capped at 512 chars. The cap keeps abusive callers honest.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin-crypto-orders.ts'));
    expect(p).toMatch(/V-666\.AM — opaque cursor returned by a prior page's/);
    expect(p).toMatch(/`next_cursor`\. Length-bounded to keep abusive callers honest\./);
    expect(p).toMatch(/cursor: z\.string\(\)\.min\(1\)\.max\(512\)\.optional\(\),/);
  });

  it('CRITICAL V-666.BY created_after + created_before — same half-open shape as customer V-666.BX. The shared shape keeps customer + admin date-range semantics aligned.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin-crypto-orders.ts'));
    expect(p).toMatch(/V-666\.BY — half-open created_at window\. Same shape as the/);
    expect(p).toMatch(/customer endpoint \(V-666\.BX\)\./);
    expect(p).toMatch(/created_after: z\.string\(\)\.datetime\(\)\.optional\(\),/);
    expect(p).toMatch(/created_before: z\.string\(\)\.datetime\(\)\.optional\(\),/);
  });

  // ─── V-666.F apply-ipn ───────────────────────────────────────

  it("CRITICAL V-666.F apply-ipn framing — 'admin manual IPN application. Operator path: when NowPayments fails to deliver an IPN (rare), ops can advance an order by hand by posting the provider_status they observed in the NowPayments dashboard. The same state machine that the real IPN route uses applies (forward-only, reverse-to-pending rejected)'. The shared state-machine constraint is what keeps admin + IPN paths consistent.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin-crypto-orders.ts'));
    expect(p).toMatch(/V-666\.F — admin manual IPN application\. Operator path: when/);
    expect(p).toMatch(/NowPayments fails to deliver an IPN \(rare\), ops can advance an/);
    expect(p).toMatch(/order by hand by posting the provider_status they observed in/);
    expect(p).toMatch(/the NowPayments dashboard\. The same state machine that the real/);
    expect(p).toMatch(/IPN route uses applies \(forward-only, reverse-to-pending rejected\)\./);
  });

  it("CRITICAL ApplyIpnBody — provider_status string min(1).max(64) + payment_id string min(1).max(128). The 2-field shape matches NowPayments's IPN payload (subset); caps prevent query-log bloat from abuse.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin-crypto-orders.ts'));
    expect(p).toMatch(/provider_status: z\.string\(\)\.min\(1\)\.max\(64\),/);
    expect(p).toMatch(/payment_id: z\.string\(\)\.min\(1\)\.max\(128\),/);
  });

  // ─── V-666.L sweep-expired ───────────────────────────────────

  it("CRITICAL V-666.L SweepBody framing — older_than_hours 1..8760 (1 year ceiling) + limit 1..500 (matches service per-tick cap). The defaults '24h matching typical NowPayments payment window' + '500 matching service per-tick cap'.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin-crypto-orders.ts'));
    expect(p).toMatch(/V-666\.L — admin sweep-trigger body\. olderThanHours defaults to 24h/);
    expect(p).toMatch(/\(matching the typical NowPayments payment window\); limit defaults/);
    expect(p).toMatch(/to 500 \(matching the service's own per-tick cap\)\./);
    expect(p).toMatch(
      /older_than_hours: z\.number\(\)\.int\(\)\.min\(1\)\.max\(8760\)\.optional\(\)/,
    );
    expect(p).toMatch(/limit: z\.number\(\)\.int\(\)\.min\(1\)\.max\(500\)\.optional\(\)/);
  });

  // ─── V-666.O daily ───────────────────────────────────────────

  it("CRITICAL V-666.O daily days cap — 90 (rationale: 'longer reports should pull from a warehouse, not the live in-memory repo'). The 90-day cap is what keeps the daily-breakdown endpoint O(N orders) affordable.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin-crypto-orders.ts'));
    expect(p).toMatch(/V-666\.O — daily-breakdown query\. days bounded to 90 to keep the/);
    expect(p).toMatch(/O\(N orders\) scan affordable; longer reports should pull from a/);
    expect(p).toMatch(/warehouse, not the live in-memory repo\./);
  });

  // ─── V-666.V CSV ─────────────────────────────────────────────

  it("CRITICAL V-666.V CSV export — same shape as ListQuery but limit ceiling 1000 (vs ListQuery 200). The higher ceiling fits CSV's bulk-export use case.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin-crypto-orders.ts'));
    expect(p).toMatch(/V-666\.V — CSV export query\. Same shape as ListQuery but with a/);
    expect(p).toMatch(/higher limit ceiling \(1000\) since CSV is the export path\./);
  });

  // ─── Admin scope on every route ──────────────────────────────

  it('CRITICAL driftstack_internal_admin scope on every route. The 9-endpoint surface uniformly requires the admin scope; drift on any one would let normal customer keys hit admin tooling.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin-crypto-orders.ts'));
    const refs = p.match(/app\.requireScope\('driftstack_internal_admin'\)/g) ?? [];
    expect(refs.length, 'admin scope reference count').toBeGreaterThanOrEqual(9);
  });
});
