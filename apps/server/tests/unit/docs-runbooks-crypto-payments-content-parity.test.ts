// W555.B — drift guard for /docs/runbooks/crypto-payments.md.
// V-675 ops reference for V-666 NowPayments IPN family. Drift
// here either weakens the in-memory-CryptoOrdersRepo caveat
// (would invite customer-facing assumption that orders survive
// deploys), drops the forward-only state-machine invariant
// (would re-permit terminal-paid reverting to non-terminal), or
// weakens the SSH-key + IPN-secret rotation discipline.
//
//   • V-675. V-666 family — IPN + CryptoOrdersService + admin.
//   • In-memory CryptoOrdersRepo Map — wiped on deploy/restart.
//   • V-666.E follow-up wires crypto_orders table when live.
//   • Order lifecycle states: pending + confirming + partial +
//     paid + failed (5 states).
//   • State machine forward-only — paid/failed terminal,
//     late confirming IPN after paid rejected (isTerminalForward).
//   • NowPayments HMAC-SHA512 IPN signature verification.
//   • Refunds via NowPayments dashboard (not Driftstack).
//   • DO NOT mutate in-memory store by hand.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'docs/runbooks/crypto-payments.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W555.B /docs/runbooks/crypto-payments.md content parity', () => {
  const body = read(LIB);

  it("Header + V-675 + V-666 family framing pinned: '# Crypto-payments operator runbook (V-675)' + 'Operational reference for the V-666 family — NowPayments IPN ingestion, the in-memory `CryptoOrdersService` order state machine, the customer-facing `/v1/billing/crypto-checkout` route (V-666.C), and the admin lookup routes (V-666.D).' + 'A customer reports \"I sent the crypto payment but my account is still pending.\"' — pinned so the V-675-runbook + V-666-family-NowPayments-IPN-CryptoOrdersService + V-666.C-crypto-checkout + V-666.D-admin-lookup + still-pending-customer-trigger commitment survives", () => {
    expect(body).toMatch(/^# Crypto-payments operator runbook \(V-675\)$/m);
    expect(body).toMatch(/Operational reference for the V-666 family — NowPayments IPN/);
    expect(body).toMatch(/ingestion, the in-memory `CryptoOrdersService` order state machine,/);
    expect(body).toMatch(
      /the customer-facing `\/v1\/billing\/crypto-checkout` route \(V-666\.C\),/,
    );
    expect(body).toMatch(/and the admin lookup routes \(V-666\.D\)\./);
    expect(body).toMatch(/- A customer reports "I sent the crypto payment but my account is/);
    expect(body).toMatch(/still pending\."/);
  });

  it("HMAC-SHA512 + in-memory posture framing pinned: 'POST /v1/billing/crypto-checkout  (V-666.C)' + 'creates CryptoOrder { status:'pending', provider:'stub' }' + 'POST /v1/webhooks/nowpayments  (V-666 + V-666.B)' + 'HMAC-SHA512 signature verification gate' + '**In-memory posture.** The repo is a `Map` in process memory. On every deploy or restart, all crypto orders are dropped.' + 'The V-666.E follow-up wires a `crypto_orders` table when live volume justifies it.' — pinned so the V-666.C-crypto-checkout-stub-pending + V-666.B-NowPayments-webhook + HMAC-SHA512-signature-gate + Map-process-memory-drops-on-deploy + V-666.E-crypto_orders-table-follow-up commitment survives", () => {
    expect(body).toMatch(/POST \/v1\/billing\/crypto-checkout {2}\(V-666\.C\)/);
    expect(body).toMatch(/creates CryptoOrder \{ status:'pending', provider:'stub' \}/);
    expect(body).toMatch(/POST \/v1\/webhooks\/nowpayments {2}\(V-666 \+ V-666\.B\)/);
    expect(body).toMatch(/HMAC-SHA512 signature verification gate/);
    expect(body).toMatch(
      /> \*\*In-memory posture\.\*\* The repo is a `Map` in process memory\. On/,
    );
    expect(body).toMatch(/> every deploy or restart, all crypto orders are dropped\./);
    expect(body).toMatch(/The V-666\.E follow-up wires a `crypto_orders` table/);
    expect(body).toMatch(/> when live volume justifies it\./);
  });

  it("5-state lifecycle + forward-only invariant framing pinned: '`pending`    | Initial state on `POST /crypto-checkout`          | confirming, partial, paid, failed' + '`confirming` | NowPayments IPN `confirming` / `sending`          | paid, failed, partial' + '`partial`    | NowPayments IPN `partially_paid`                  | paid, failed (terminal otherwise)' + '`paid`       | NowPayments IPN `finished`                        | terminal' + '`failed`     | NowPayments IPN `failed` / `expired` / `refunded` | terminal' + 'The state machine is **forward-only**. Once an order reaches `paid` or `failed` it cannot move back to a non-terminal state, even if NowPayments retries an IPN (e.g. a delayed `confirming` IPN arriving after the `finished` IPN — we ignore the late one).' — pinned so the 5-state-transition-table + finished=paid + partially_paid=partial + refunded=failed + forward-only-terminal commitment survives", () => {
    expect(body).toMatch(
      /`pending`\s+\|\s+Initial state on `POST \/crypto-checkout`\s+\|\s+confirming, partial, paid, failed/,
    );
    expect(body).toMatch(
      /`confirming` \| NowPayments IPN `confirming` \/ `sending`\s+\|\s+paid, failed, partial/,
    );
    expect(body).toMatch(
      /`partial`\s+\|\s+NowPayments IPN `partially_paid`\s+\|\s+paid, failed \(terminal otherwise\)/,
    );
    expect(body).toMatch(/`paid`\s+\|\s+NowPayments IPN `finished`\s+\|\s+terminal/);
    expect(body).toMatch(
      /`failed`\s+\|\s+NowPayments IPN `failed` \/ `expired` \/ `refunded` \| terminal/,
    );
    expect(body).toMatch(
      /The state machine is \*\*forward-only\*\*\. Once an order reaches `paid`/,
    );
    expect(body).toMatch(/or `failed` it cannot move back to a non-terminal state, even if/);
    expect(body).toMatch(/NowPayments retries an IPN \(e\.g\. a delayed `confirming` IPN/);
    expect(body).toMatch(/arriving after the `finished` IPN — we ignore the late one\)\./);
  });

  it("Triage workflow + IPN-rejection framing pinned: 'Get the customer's `order_id` from their dashboard / support email.' + 'curl -H \"Authorization: Bearer <internal-admin-key>\"' + '$BASE_URL/v1/admin/crypto-orders/<order_id>' + '**`pending` + no `payment_id`** — NowPayments hasn't seen the payment yet.' + '**`pending` + has `payment_id`** — NowPayments saw the payment but no status IPN has fired.' + '**`partial`** — customer underpaid. Follow up with the customer about a top-up or refund.' + '**`failed`** — order expired or refunded. Open a new order for the customer to retry.' + '\"x-nowpayments-sig header missing\"' + '\"NowPayments IPN signature verification failed\" — IPN secret mismatch.' + '\"NowPayments IPN is missing required fields\" — schema drift.' — pinned so the order_id-from-dashboard + admin-crypto-orders-curl + pending-payment_id-cases + partial-underpaid + failed-new-order + 3-rejection-error-types commitment survives", () => {
    expect(body).toMatch(
      /1\. Get the customer's `order_id` from their dashboard \/ support email\./,
    );
    expect(body).toMatch(/curl -H "Authorization: Bearer <internal-admin-key>" \\/);
    expect(body).toMatch(/"\$BASE_URL\/v1\/admin\/crypto-orders\/<order_id>"/);
    expect(body).toMatch(/- \*\*`pending` \+ no `payment_id`\*\* — NowPayments hasn't seen the/);
    expect(body).toMatch(/payment yet\./);
    expect(body).toMatch(/- \*\*`pending` \+ has `payment_id`\*\* — NowPayments saw the/);
    expect(body).toMatch(/payment but no status IPN has fired\./);
    expect(body).toMatch(/- \*\*`partial`\*\* — customer underpaid\. Follow up with the customer/);
    expect(body).toMatch(/about a top-up or refund\./);
    // V-743 — this bullet used to end at "Open a new order for the customer to
    // retry", which is the WRONG action when the expiry sweep beat a slow
    // settlement: the customer already paid. The pin now requires the
    // check-first guidance, and asserts the bare old instruction cannot return.
    expect(body).toMatch(
      /- \*\*`failed`\*\* — order expired or refunded\. \*\*First check whether\n\s+money actually arrived\*\*/,
    );
    expect(body).toMatch(
      /ipn_settled_payment_dropped_on_terminal_order` with this\n\s+`order_id` \(V-743\)/,
    );
    expect(body).toMatch(
      /the customer HAS paid and the order will never\n\s+grant — refund or grant manually/,
    );
    expect(body).toMatch(/do\n\s+NOT ask them to pay again/);
    expect(body).not.toMatch(/refunded\. Open a new order/);
    expect(body).toMatch(/for the customer to retry\./);
    expect(body).toMatch(/- \*\*`"x-nowpayments-sig header missing"`\*\* — NowPayments retried/);
    expect(body).toMatch(/- \*\*`"NowPayments IPN signature verification failed"`\*\* — IPN/);
    expect(body).toMatch(/secret mismatch\./);
    expect(body).toMatch(
      /- \*\*`"NowPayments IPN is missing required fields"`\*\* — schema drift\./,
    );
  });

  it("Refund procedure + when-merchant-account-lands framing pinned: 'Refunds are issued by the founder via the NowPayments dashboard, not by Driftstack.' + 'Founder issues the refund in NowPayments (asset + amount + the customer's forwarding address).' + 'Our applyIpnStatus maps `refunded` → `failed`. The order moves to terminal `failed`.' + 'Do NOT mutate the in-memory store by hand' + '## When the merchant account lands (V-666.E follow-up)' + 'NowPayments merchant account is approved + API keys minted.' + '`NOWPAYMENTS_API_KEY` env var is set in production.' + 'The `/v1/billing/crypto-checkout` route's stubbed `payment_address: null` response is replaced with a real NowPayments `POST /v1/payment` call' + 'The customer-facing crypto checkout flow is unblocked in the GUI (V-534.J button + view).' + 'A `crypto_orders` table replaces the in-memory repo (V-666.E DB migration).' — pinned so the founder-issues-via-NowPayments + refunded→failed-mapping + DO-NOT-mutate-by-hand + V-666.E-5-step-go-live + V-534.J-GUI-button commitment survives", () => {
    expect(body).toMatch(/Refunds are issued by the founder via the NowPayments dashboard,/);
    expect(body).toMatch(/not by Driftstack\./);
    expect(body).toMatch(/1\. Founder issues the refund in NowPayments \(asset \+ amount \+ the/);
    expect(body).toMatch(/customer's forwarding address\)\./);
    expect(body).toMatch(/3\. Our applyIpnStatus maps `refunded` → `failed`\. The order moves/);
    expect(body).toMatch(/to terminal `failed`\./);
    expect(body).toMatch(/Do NOT mutate the in-memory store by hand/);
    expect(body).toMatch(/## When the merchant account lands \(V-666\.E follow-up\)/);
    expect(body).toMatch(/1\. NowPayments merchant account is approved \+ API keys minted\./);
    expect(body).toMatch(/2\. `NOWPAYMENTS_API_KEY` env var is set in production\./);
    expect(body).toMatch(/3\. The `\/v1\/billing\/crypto-checkout` route's stubbed/);
    expect(body).toMatch(/`payment_address: null` response is replaced with a real/);
    expect(body).toMatch(/NowPayments `POST \/v1\/payment` call/);
    expect(body).toMatch(/4\. The customer-facing crypto checkout flow is unblocked in the/);
    expect(body).toMatch(/GUI \(V-534\.J button \+ view\)\./);
    expect(body).toMatch(/5\. A `crypto_orders` table replaces the in-memory repo \(V-666\.E/);
    expect(body).toMatch(/DB migration\)\./);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
