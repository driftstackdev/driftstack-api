// W421.C — drift guard for apps/server/src/routes/billing-crypto-orders.ts.
// V-666.G customer-facing crypto-orders (7 routes). V-666.AV pay-
// window hint via expires_at = created_at + PAY_WINDOW_MS for
// pending orders. V-666.AW no-store + private cache rationale on
// status-volatile endpoints. V-666.AU customer events surface
// (excludes 'swept'). V-666.J 409-on-not-cancellable.
// V-666.BR/.BU/.BX/.BZ list filtering. Drift here either drops the
// no-store cache header (proxy serves stale pending → paid) or
// breaks cross-account 404-not-403 leak posture.
//
//   • V-666.G framing pinned: 7 routes — list + get + PATCH note +
//     cancel + receipt (.json/.txt/.pdf).
//   • Cross-account framing pinned: 404 not 403 on cross-account
//     id lookup (no existence leak).
//   • V-666.AV PAY_WINDOW_MS = 60*60*1000 (1h); expires_at ISO on
//     pending; null otherwise; purely informational (admin sweep +
//     cancel endpoint each consult own thresholds).
//   • V-666.AW cache framing pinned: 'no-store, private' on list
//     + get; status flips mid-checkout (pending → confirming →
//     paid) so cache must never mask paid IPN.
//   • V-666.AU events surface: status + at ISO + source; admin
//     'swept' coerced to 'expired' for customer view (internal
//     lifecycle hidden).
//   • V-666.BR status filter: zod enum 6-tuple (pending +
//     confirming + paid + failed + partial + cancelled).
//   • V-666.BU cursor pagination: opaque base64url token; service
//     encode/decode.
//   • V-666.BX created_after (inclusive) + created_before (exclusive)
//     ISO 8601 datetime filter.
//   • V-666.BZ inverted-window guard: before <= after → 400
//     ("strictly greater than" message; common bugs masked silent
//     empty rationale).
//   • V-666.M receipt JSON; V-666.P plain-text rendering; V-666.U
//     PDF with content-disposition attachment + filename
//     receipt-<order_id>.pdf.
//   • V-666.Q customer_note: max 500 chars + nullable.
//   • V-666.J cancel: 409 ConflictError with non-refundable
//     reconciliation hint when not in pending state.
//   • Auth: requireAuth + rateLimit('global') on all 7 routes.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/routes/billing-crypto-orders.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W421.C apps/server/src/routes/billing-crypto-orders.ts content parity', () => {
  const body = read(LIB);

  it('V-666.G framing pinned: 7 routes (list + get + PATCH note V-666.Q + cancel V-666.J + receipt JSON V-666.M + .txt V-666.P + .pdf V-666.U)', () => {
    expect(body).toMatch(/V-666\.G — customer-facing crypto-orders routes\./);
    expect(body).toMatch(/GET\s+\/v1\/billing\/crypto-orders\s+— list caller's own orders/);
    expect(body).toMatch(/GET\s+\/v1\/billing\/crypto-orders\/:id\s+— single order lookup/);
    expect(body).toMatch(
      /PATCH \/v1\/billing\/crypto-orders\/:id\s+— update customer_note \(V-666\.Q\)/,
    );
    expect(body).toMatch(
      /POST\s+\/v1\/billing\/crypto-orders\/:id\/cancel\s+— abandon a pending order \(V-666\.J\)/,
    );
    expect(body).toMatch(
      /GET\s+\/v1\/billing\/crypto-orders\/:id\/receipt\s+— normalized receipt JSON \(V-666\.M\)/,
    );
    expect(body).toMatch(
      /GET\s+\/v1\/billing\/crypto-orders\/:id\/receipt\.txt\s+— same receipt as text\/plain \(V-666\.P\)/,
    );
    expect(body).toMatch(
      /GET\s+\/v1\/billing\/crypto-orders\/:id\/receipt\.pdf\s+— same receipt as application\/pdf \(V-666\.U\)/,
    );
  });

  it('Cross-account framing pinned: 404 not 403 (no existence leak for orders belonging to other accounts)', () => {
    expect(body).toMatch(
      /All routes are scoped to the calling account\. Cross-account\s*\n?\s*\/\/\s*id lookups return 404 \(not 403\) — we don't leak the existence of\s*\n?\s*\/\/\s*orders that belong to other accounts\./,
    );
  });

  it('V-666.AV PAY_WINDOW_MS = 60*60*1000 (1h); informational expires_at hint; admin sweep + cancel each consult own thresholds', () => {
    expect(body).toMatch(
      /\/\/ V-666\.AV — customer-facing pay-window hint\. Pending orders carry\s*\n?\s*\/\/ an `expires_at` ISO timestamp set to `created_at \+ PAY_WINDOW_MS`\s*\n?\s*\/\/ so the UI can render a countdown without computing locally\. The\s*\n?\s*\/\/ hint is purely informational — actual expiry is enforced by the\s*\n?\s*\/\/ admin sweep \+ the customer cancel endpoint, which both consult\s*\n?\s*\/\/ their own thresholds\. Non-pending orders carry expires_at: null\./,
    );
    expect(body).toMatch(/const PAY_WINDOW_MS = 60 \* 60 \* 1000;/);
    expect(body).toMatch(
      /expires_at:\s*\n?\s*order\.status === 'pending' \? new Date\(order\.created_at \+ PAY_WINDOW_MS\)\.toISOString\(\) : null,/,
    );
  });

  it("V-666.AW cache framing pinned: 'no-store, private' header on list + get; status flips mid-checkout never cached", () => {
    expect(body).toMatch(
      /\/\/ V-666\.AW — order state changes constantly between mints \+ IPNs;\s*\n?\s*\/\/ shared \/ proxy caches must never serve stale state\. `private`\s*\n?\s*\/\/ additionally signals that even browser caches shouldn't share\s*\n?\s*\/\/ the response across users on the same machine\./,
    );
    expect(body).toMatch(
      /\/\/ V-666\.AW — same no-store, private rationale: status flips\s*\n?\s*\/\/ mid-checkout \(pending → confirming → paid\) and we never want\s*\n?\s*\/\/ a cached pending response to mask a paid IPN\./,
    );
    const matches = body.match(/void reply\.header\('cache-control', 'no-store, private'\);/g);
    expect(matches?.length).toBe(2);
  });

  it("V-666.AU events surface framing pinned: admin 'swept' coerced to 'expired' (internal lifecycle hidden from customer)", () => {
    expect(body).toMatch(
      /\/\/ V-666\.AU — customer-facing event timeline\. Same shape as the\s*\n?\s*\/\/ admin \/events endpoint \(V-666\.AT\) but inlined on the\s*\n?\s*\/\/ envelope so the order-detail GET is a single round trip\.\s*\n?\s*\/\/ Excludes the 'swept' source from the customer's view —\s*\n?\s*\/\/ admin sweep is an internal lifecycle event the customer\s*\n?\s*\/\/ doesn't need to see; we surface it as a regular 'expired'\s*\n?\s*\/\/ from their perspective\./,
    );
    expect(body).toMatch(
      /events: order\.events\.map\(\(e\) => \(\{\s*\n?\s*status: e\.status,\s*\n?\s*at: new Date\(e\.at\)\.toISOString\(\),\s*\n?\s*source: e\.source === 'swept' \? 'expired' : e\.source,\s*\n?\s*\}\)\),/,
    );
  });

  it('V-666.BR status filter zod enum 6-tuple (pending|confirming|paid|failed|partial|cancelled); admin parity rationale', () => {
    expect(body).toMatch(
      /\/\/ V-666\.BR — single-value status filter on the customer list\.\s*\n?\s*\/\/ Mirrors the admin endpoint so customer-side dashboards can\s*\n?\s*\/\/ narrow their history view \(e\.g\. "show only paid orders"\)\s*\n?\s*\/\/ without paging through the full result set\./,
    );
    expect(body).toMatch(
      /status: z\.enum\(\['pending', 'confirming', 'paid', 'failed', 'partial', 'cancelled'\]\)\.optional\(\),/,
    );
  });

  it('V-666.BU cursor pagination framing pinned: opaque base64url token of {ts,id}; service encode/decode; loop until null', () => {
    expect(body).toMatch(
      /\/\/ V-666\.BU — cursor for forward pagination\. Opaque base64url\s*\n?\s*\/\/ encoding of `\{ts, id\}`; consumers treat it as a token\. The\s*\n?\s*\/\/ service layer encodes\/decodes it\./,
    );
    expect(body).toMatch(
      /\/\/ V-666\.BU — cursor pagination\. The service produces a\s*\n?\s*\/\/ next_cursor when there's at least one more matching row\s*\n?\s*\/\/ beyond the returned page; null otherwise\. Consumers loop\s*\n?\s*\/\/ until they get null\./,
    );
  });

  it('V-666.BX half-open date-range framing pinned: created_after inclusive + created_before exclusive; ISO 8601 datetime', () => {
    expect(body).toMatch(
      /\/\/ V-666\.BX — half-open date-range filter on created_at\. Both\s*\n?\s*\/\/ bounds accept ISO 8601 timestamps\. created_after is inclusive,\s*\n?\s*\/\/ created_before is exclusive\./,
    );
    expect(body).toMatch(/created_after: z\.string\(\)\.datetime\(\)\.optional\(\),/);
    expect(body).toMatch(/created_before: z\.string\(\)\.datetime\(\)\.optional\(\),/);
  });

  it('V-666.BZ inverted-window guard: before <= after → 400 (silent-empty masking rationale: "swapped args, missing tz suffix"); strict > messaging', () => {
    expect(body).toMatch(
      /\/\/ V-666\.BZ — reject obviously-wrong windows \(before <= after\)\.\s*\n?\s*\/\/ The empty result was previously silent, which masked common\s*\n?\s*\/\/ bugs \(swapped args, missing tz suffix\)\./,
    );
    expect(body).toMatch(
      /if \(\s*\n?\s*createdAfter !== undefined &&\s*\n?\s*createdBefore !== undefined &&\s*\n?\s*createdBefore <= createdAfter\s*\n?\s*\) \{\s*\n?\s*throw new BadRequestError\('created_before must be strictly greater than created_after\.'\);/,
    );
  });

  it('toPublic: 11-field shape with order_id + product + price/currency + payment_id + status + customer_note ?? null + events + expires_at + ISO timestamps', () => {
    expect(body).toMatch(/function toPublic\(order: CryptoOrder\): Record<string, unknown> \{/);
    expect(body).toMatch(/order_id: order\.order_id,/);
    expect(body).toMatch(/payment_id: order\.payment_id,/);
    expect(body).toMatch(/customer_note: order\.customer_note \?\? null,/);
    expect(body).toMatch(/created_at: new Date\(order\.created_at\)\.toISOString\(\),/);
    expect(body).toMatch(/updated_at: new Date\(order\.updated_at\)\.toISOString\(\),/);
  });

  it('Limit zod regex: /^\\d+$/ string then Number.parseInt with 1..100 BadRequestError', () => {
    expect(body).toMatch(/limit: z\.string\(\)\.regex\(\/\^\\d\+\$\/\)\.optional\(\),/);
    expect(body).toMatch(
      /const n = Number\.parseInt\(query\.limit, 10\);\s*\n?\s*if \(!Number\.isInteger\(n\) \|\| n < 1 \|\| n > 100\) \{\s*\n?\s*throw new BadRequestError\('limit must be an integer between 1 and 100\.'\);/,
    );
  });

  it('UpdateNoteSchema V-666.Q: customer_note max 500 + nullable', () => {
    expect(body).toMatch(
      /const UpdateNoteSchema = z\.object\(\{\s*\n?\s*customer_note: z\.string\(\)\.max\(500\)\.nullable\(\),\s*\n?\s*\}\);/,
    );
  });

  it('GET single + receipt routes: cross-account 404 via order.account_id !== ctx.account.id; NotFoundError with "No crypto order with id" message', () => {
    expect(body).toMatch(
      /if \(order === null \|\| order\.account_id !== ctx\.account\.id\) \{\s*\n?\s*throw new NotFoundError\(`No crypto order with id "\$\{params\.order_id\}"\.`\);/,
    );
    const matches = body.match(
      /throw new NotFoundError\(`No crypto order with id "\$\{params\.order_id\}"\.`\);/g,
    );
    expect(matches?.length).toBeGreaterThanOrEqual(4);
  });

  it('V-666.P plain-text receipt: 7-line render (header + blank + Order/Issued/Status/Product/Amount); paid_at/payment_id conditional; trailing newline', () => {
    expect(body).toMatch(
      /\/\/ V-666\.P — plain-text rendering of the same receipt\. Useful for\s*\n?\s*\/\/ wget \/ curl \/ cron jobs that pipe the receipt to a file without\s*\n?\s*\/\/ an extra jq step\. Identical access semantics as the JSON variant\./,
    );
    expect(body).toMatch(
      /const lines = \[\s*\n?\s*'Driftstack receipt',\s*\n?\s*'',\s*\n?\s*`Order: \$\{receipt\.order_id\}`,\s*\n?\s*`Issued: \$\{receipt\.issued_at\}`,\s*\n?\s*`Status: \$\{receipt\.status\}`,\s*\n?\s*`Product: \$\{receipt\.product\}`,\s*\n?\s*`Amount: \$\{\(receipt\.price_cents \/ 100\)\.toFixed\(2\)\} \$\{receipt\.price_currency\}`,\s*\n?\s*\];/,
    );
    expect(body).toMatch(
      /if \(receipt\.paid_at !== null\) lines\.push\(`Paid at: \$\{receipt\.paid_at\}`\);/,
    );
    expect(body).toMatch(
      /if \(receipt\.payment_id !== null\) lines\.push\(`Payment id: \$\{receipt\.payment_id\}`\);/,
    );
    expect(body).toMatch(
      /return reply\.type\('text\/plain; charset=utf-8'\)\.send\(lines\.join\('\\n'\) \+ '\\n'\);/,
    );
  });

  it('V-666.U PDF receipt: buildReceiptPdfBytes; application/pdf type + content-disposition attachment filename=receipt-<order_id>.pdf', () => {
    expect(body).toMatch(
      /\/\/ V-666\.U — PDF rendering of the receipt for archiving \/ emailing\.\s*\n?\s*\/\/ Same access semantics as the JSON \/ \.txt variants; cross-account\s*\n?\s*\/\/ requests return 404\. Content-Disposition: attachment so a browser\s*\n?\s*\/\/ GET triggers a download with a meaningful filename\./,
    );
    expect(body).toMatch(/const bytes = buildReceiptPdfBytes\(receipt\);/);
    expect(body).toMatch(
      /return reply\s*\n?\s*\.type\('application\/pdf'\)\s*\n?\s*\.header\('content-disposition', `attachment; filename="receipt-\$\{receipt\.order_id\}\.pdf"`\)\s*\n?\s*\.send\(bytes\);/,
    );
  });

  it('V-666.J cancel framing pinned: customer-facing self-service abandonment of pending; once-payment-activity → 409 "crypto payments non-refundable; contact support" with resource/field detail', () => {
    expect(body).toMatch(
      /\/\/ V-666\.J — cancel a pending order\. Customer-facing self-service\s*\n?\s*\/\/ abandonment\. Once any payment activity exists \(confirming\/partial\/\s*\n?\s*\/\/ paid\/failed\) the cancel must go through support so the customer's\s*\n?\s*\/\/ on-chain funds can be reconciled — those statuses return 409\./,
    );
    expect(body).toMatch(
      /if \(result\.ok === 'not_cancellable'\) \{\s*\n?\s*throw new ConflictError\(\s*\n?\s*`Order is in state "\$\{result\.reason\}" and can no longer be cancelled\. Crypto payments are non-refundable; contact support if you need to discuss reconciliation\.`,\s*\n?\s*\{ resource: 'crypto_order', field: 'status' \},\s*\n?\s*\);/,
    );
  });

  it("Auth posture (W496 + #122): the 5 read/receipt GETs add requireScope('read:billing'); the 2 mutations (PATCH order-note + POST cancel) add requireScope('admin:billing')", () => {
    // #122 read:billing floor — no route is plain requireAuth+rateLimit now.
    const plain = body.match(/preHandler: \[app\.requireAuth, app\.rateLimit\('global'\)\] \},/g);
    expect(plain).toBeNull();
    const readBilling = body.match(
      /preHandler: \[app\.requireAuth, app\.requireScope\('read:billing'\), app\.rateLimit\('global'\)\] \},/g,
    );
    expect(readBilling?.length).toBe(5);
    const gated = body.match(
      /preHandler: \[app\.requireAuth, app\.requireScope\('admin:billing'\), app\.rateLimit\('global'\)\] \},/g,
    );
    expect(gated?.length).toBe(2);
  });

  it('parseOrThrow helper: zod safeParse + a fixed generic BadRequestError message (no raw zod JSON leaked into the customer problem detail)', () => {
    expect(body).toMatch(
      /function parseOrThrow<T>\(schema: z\.ZodSchema<T>, input: unknown\): T \{\s*\n?\s*const result = schema\.safeParse\(input\);/,
    );
    expect(body).toContain("throw new BadRequestError('Invalid request parameters.');");
    expect(body).not.toMatch(/BadRequestError\(result\.error\.message\)/);
  });

  it('imports: FastifyInstance/FastifyRequest + zod + BadRequest/Conflict/NotFoundError + buildReceiptPdfBytes + CryptoOrder/Service', () => {
    expect(body).toMatch(/import type \{ FastifyInstance, FastifyRequest \} from 'fastify';/);
    expect(body).toMatch(/import \{ z \} from 'zod';/);
    expect(body).toMatch(
      /import \{ BadRequestError, ConflictError, NotFoundError \} from '\.\.\/lib\/errors\.js';/,
    );
    expect(body).toMatch(/import \{ buildReceiptPdfBytes \} from '\.\.\/lib\/receipt-pdf\.js';/);
    expect(body).toMatch(
      /import type \{ CryptoOrder, CryptoOrdersService \} from '\.\.\/services\/crypto-orders\.js';/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
