// W422.C — drift guard for apps/server/src/routes/admin-crypto-orders.ts.
// V-666.D admin crypto-orders surface (10 routes): the support-ops
// view behind "I sent the payment but the dashboard still says
// pending". Drift here either widens auth (scope leak), drops the
// no-store promotion comment (caching of admin PII), or shifts the
// toPublic shape (clients break).
//
//   • V-666.D framing pinned: 10 routes enumerated up-front +
//     driftstack_internal_admin scope.
//   • Sub-letter framings pinned: T (search/filter), AS (payment_id
//     exact-match), AM (opaque cursor), BY (date-range), BZ
//     (inverted-window guard), BE→BT (no-store promoted to
//     app-level), V (CSV), N (stats), W (avg_time_to_paid_ms), AE
//     (by_product), AP (idempotency-metrics) + AR (body_mismatches),
//     AC (pending-age), O (daily), AT (events), L (sweep), F
//     (apply-ipn), AA (internal-note).
//   • toPublic 11-field shape pinned: includes internal_note.
//   • CSV header pinned: 11 columns in exact order.
//   • Schemas pinned: ListQuery + CsvQuery + DailyQuery +
//     ApplyIpnBody + SweepBody + InternalNoteBody + GetParams.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/routes/admin-crypto-orders.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W422.C apps/server/src/routes/admin-crypto-orders.ts content parity', () => {
  const body = read(LIB);

  it('V-666.D framing pinned: 11 admin crypto-orders routes enumerated', () => {
    expect(body).toMatch(/\/\/ V-666\.D — admin crypto-orders routes\./);
    expect(body).toMatch(/GET\s+\/v1\/admin\/crypto-orders\?account_id=acc_X&limit=N/);
    expect(body).toMatch(/GET\s+\/v1\/admin\/crypto-orders\/stats\s+\(V-666\.N\)/);
    expect(body).toMatch(/GET\s+\/v1\/admin\/crypto-orders\/daily\?days=N\s+\(V-666\.O\)/);
    expect(body).toMatch(/GET\s+\/v1\/admin\/crypto-orders\/pending-age\s+\(V-666\.AC\)/);
    expect(body).toMatch(/GET\s+\/v1\/admin\/crypto-orders\/idempotency-metrics\s+\(V-666\.AP\)/);
    expect(body).toMatch(/GET\s+\/v1\/admin\/crypto-orders\.csv\s+\(V-666\.V\)/);
    expect(body).toMatch(/GET\s+\/v1\/admin\/crypto-orders\/:order_id/);
    expect(body).toMatch(/GET\s+\/v1\/admin\/crypto-orders\/:order_id\/events\s+\(V-666\.AT\)/);
    expect(body).toMatch(/POST\s+\/v1\/admin\/crypto-orders\/:order_id\/apply-ipn\s+\(V-666\.F\)/);
    expect(body).toMatch(
      /PATCH\s+\/v1\/admin\/crypto-orders\/:order_id\/internal-note\s+\(V-666\.AA\)/,
    );
    expect(body).toMatch(/POST\s+\/v1\/admin\/crypto-orders\/sweep-expired\s+\(V-666\.L\)/);
  });

  it('Auth posture pinned: driftstack_internal_admin scope + founder-dashboard/support-ops use case + accurate mutation framing (3 mutating endpoints; 2 via the IPN state machine V-666/B)', () => {
    expect(body).toMatch(
      /\/\/ Auth: driftstack_internal_admin scope\. Used by the founder dashboard\s*\/\/ \+ support ops to look up the order behind a customer's\s*\/\/ "I sent the payment but the dashboard still says pending" ticket\./,
    );
    expect(body).toMatch(/\/\/ Mostly read-only reporting\. Three endpoints mutate: apply-ipn and/);
    expect(body).toMatch(
      /\/\/ crypto-order state machine as the public IPN pipeline \(V-666 \/ B\)/,
    );
  });

  it('imports: Fastify types + zod + buildCsv from lib/csv + BadRequestError/NotFoundError from lib/errors + CryptoOrder/CryptoOrdersService from services', () => {
    expect(body).toMatch(/import type \{ FastifyInstance, FastifyRequest \} from 'fastify';/);
    expect(body).toMatch(/import \{ z \} from 'zod';/);
    expect(body).toMatch(/import \{ buildCsv \} from '\.\.\/lib\/csv\.js';/);
    expect(body).toMatch(
      /import \{ BadRequestError, NotFoundError \} from '\.\.\/lib\/errors\.js';/,
    );
    expect(body).toMatch(
      /import type \{ CryptoOrder, CryptoOrdersService \} from '\.\.\/services\/crypto-orders\.js';/,
    );
  });

  it('ListQuery: account_id + limit + V-666.T status enum (6) + search 1..200 + V-666.AS payment_id 1..128 + V-666.AM cursor 1..512 + V-666.BY created_after/before datetime', () => {
    expect(body).toMatch(/account_id: z\.string\(\)\.min\(1\)\.max\(100\)\.optional\(\),/);
    expect(body).toMatch(/limit: z\.string\(\)\.regex\(\/\^\\d\+\$\/\)\.optional\(\),/);
    expect(body).toMatch(/\/\/ V-666\.T — admin search\/filter knobs\./);
    expect(body).toMatch(
      /status: z\.enum\(\['pending', 'confirming', 'paid', 'failed', 'partial', 'cancelled'\]\)\.optional\(\),/,
    );
    expect(body).toMatch(/search: z\.string\(\)\.min\(1\)\.max\(200\)\.optional\(\),/);
    expect(body).toMatch(
      /\/\/ V-666\.AS — exact-match payment_id filter\. Capped at 128 so abuse\s*\/\/ can't bloat the query log; real NowPayments ids are ~20 chars\./,
    );
    expect(body).toMatch(/payment_id: z\.string\(\)\.min\(1\)\.max\(128\)\.optional\(\),/);
    expect(body).toMatch(
      /\/\/ V-666\.AM — opaque cursor returned by a prior page's\s*\/\/ `next_cursor`\. Length-bounded to keep abusive callers honest\./,
    );
    expect(body).toMatch(/cursor: z\.string\(\)\.min\(1\)\.max\(512\)\.optional\(\),/);
    expect(body).toMatch(
      /\/\/ V-666\.BY — half-open created_at window\. Same shape as the\s*\/\/ customer endpoint \(V-666\.BX\)/,
    );
    expect(body).toMatch(/created_after: z\.string\(\)\.datetime\(\)\.optional\(\),/);
    expect(body).toMatch(/created_before: z\.string\(\)\.datetime\(\)\.optional\(\),/);
  });

  it('GetParams + ApplyIpnBody (V-666.F manual IPN, forward-only, reverse-to-pending rejected) + SweepBody (V-666.L olderThanHours 1..8760 + limit 1..500) + DailyQuery (V-666.O days bounded 90)', () => {
    expect(body).toMatch(
      /const GetParams = z\.object\(\{\s*\/\/ order_id is `ord_<36-char-uuid>`[\s\S]*?\n?\s*order_id: z\.string\(\)\.min\(1\)\.max\(100\),\s*\}\);/,
    );
    expect(body).toMatch(
      /\/\/ V-666\.F — admin manual IPN application\. Operator path: when\s*\/\/ NowPayments fails to deliver an IPN \(rare\), ops can advance an\s*\/\/ order by hand by posting the provider_status they observed in\s*\/\/ the NowPayments dashboard\. The same state machine that the real\s*\/\/ IPN route uses applies \(forward-only, reverse-to-pending rejected\)\./,
    );
    expect(body).toMatch(
      /const ApplyIpnBody = z\.object\(\{[\s\S]*?provider_status: z\.string\(\)\.min\(1\)\.max\(64\),[\s\S]*?payment_id: z\.string\(\)\.min\(1\)\.max\(128\),\s*\}\);/,
    );
    expect(body).toMatch(
      /\/\/ V-666\.L — admin sweep-trigger body\. olderThanHours defaults to 24h\s*\/\/ \(matching the typical NowPayments payment window\); limit defaults\s*\/\/ to 500 \(matching the service's own per-tick cap\)\./,
    );
    expect(body).toMatch(
      /const SweepBody = z\.object\(\{\s*older_than_hours: z\.number\(\)\.int\(\)\.min\(1\)\.max\(8760\)\.optional\(\), \/\/ up to 1 year\s*limit: z\.number\(\)\.int\(\)\.min\(1\)\.max\(500\)\.optional\(\),\s*\}\);/,
    );
    expect(body).toMatch(
      /\/\/ V-666\.O — daily-breakdown query\. days bounded to 90 to keep the\s*\/\/ O\(N orders\) scan affordable; longer reports should pull from a\s*\/\/ warehouse, not the live in-memory repo\./,
    );
    expect(body).toMatch(
      /const DailyQuery = z\.object\(\{\s*days: z\.string\(\)\.regex\(\/\^\\d\+\$\/\)\.optional\(\),\s*\}\);/,
    );
  });

  it('CsvQuery (V-666.V same shape as ListQuery, limit ceiling 1000) + V-666.BY shared date-range', () => {
    expect(body).toMatch(
      /\/\/ V-666\.V — CSV export query\. Same shape as ListQuery but with a\s*\/\/ higher limit ceiling \(1000\) since CSV is the export path\./,
    );
    expect(body).toMatch(/const CsvQuery = z\.object\(\{/);
    expect(body).toMatch(/\/\/ V-666\.BY — date-range filter; same shape as the JSON list\./);
  });

  it('toPublic 11-field shape pinned (V-666.AA includes internal_note nullish-coalesce); ISO timestamps from epoch ms', () => {
    expect(body).toMatch(
      /function toPublic\(order: CryptoOrder\): Record<string, unknown> \{\s*return \{\s*order_id: order\.order_id,\s*account_id: order\.account_id,\s*product: order\.product,\s*price_cents: order\.price_cents,\s*price_currency: order\.price_currency,\s*payment_id: order\.payment_id,\s*status: order\.status,\s*customer_note: order\.customer_note \?\? null,/,
    );
    expect(body).toMatch(
      /\/\/ V-666\.AA — admin-only field; nullish-coalesce keeps older repo\s*\/\/ fixtures serialising cleanly even before they round-trip through\s*\/\/ the service's create\(\) path\.\s*internal_note: order\.internal_note \?\? null,\s*created_at: new Date\(order\.created_at\)\.toISOString\(\),\s*updated_at: new Date\(order\.updated_at\)\.toISOString\(\),/,
    );
  });

  it('InternalNoteBody (V-666.AA internal_note nullable, 2000-char ceiling = 2x customer_note budget for runbooks)', () => {
    expect(body).toMatch(
      /\/\/ V-666\.AA — admin internal-note body\. Empty string normalises to\s*\/\/ null at the service layer; 2000-char ceiling is twice the\s*\/\/ customer_note budget because internal runbooks tend to be longer\./,
    );
    expect(body).toMatch(
      /const InternalNoteBody = z\.object\(\{\s*internal_note: z\.string\(\)\.max\(2000\)\.nullable\(\),\s*\}\);/,
    );
  });

  it('V-666.BE no-store header promotion comment pinned (route-local onSend hook moved to V-666.BT app-level on /v1/admin/*)', () => {
    expect(body).toMatch(
      /\/\/ V-666\.BE — Cache-Control: no-store, private on admin crypto\s*\/\/ responses\. Used to live as a route-local onSend hook; promoted\s*\/\/ to an app-level hook on \/v1\/admin\/\* in V-666\.BT so every admin\s*\/\/ endpoint \(accounts, audit, sessions, webhooks, etc\.\) inherits\s*\/\/ the same defense-in-depth header\./,
    );
  });

  it("LIST route: GET '/v1/admin/crypto-orders' + scope-only preHandler + limit 1..200 + V-666.BZ inverted-window guard + listForAdminPage spread + reply.send({orders, next_cursor})", () => {
    expect(body).toMatch(
      /'\/v1\/admin\/crypto-orders',\s*\{ preHandler: \[app\.requireScope\('driftstack_internal_admin'\), app\.rateLimit\('global'\)\] \},/,
    );
    expect(body).toMatch(
      /throw new BadRequestError\('limit must be an integer between 1 and 200\.'\);/,
    );
    expect(body).toMatch(
      /\/\/ V-666\.BZ — same inverted-window guard as the customer route\.\s*if \(\s*createdAfter !== undefined &&\s*createdBefore !== undefined &&\s*createdBefore <= createdAfter\s*\) \{\s*throw new BadRequestError\('created_before must be strictly greater than created_after\.'\);\s*\}/,
    );
    expect(body).toMatch(/const page = await deps\.service\.listForAdminPage\(\{/);
    expect(body).toMatch(
      /return reply\.send\(\{\s*orders: page\.orders\.map\(toPublic\),\s*next_cursor: page\.nextCursor,\s*\}\);/,
    );
  });

  it("V-666.V CSV route: GET '/v1/admin/crypto-orders.csv' + limit ceiling 1000 + 11-column header in exact order + text/csv content-type + attachment content-disposition", () => {
    expect(body).toMatch(/'\/v1\/admin\/crypto-orders\.csv',/);
    expect(body).toMatch(
      /throw new BadRequestError\('limit must be an integer between 1 and 1000\.'\);/,
    );
    expect(body).toMatch(
      /header: \[\s*'order_id',\s*'account_id',\s*'product',\s*'price_cents',\s*'price_currency',\s*'status',\s*'payment_id',\s*'customer_note',\s*'internal_note',\s*'created_at',\s*'updated_at',\s*\],/,
    );
    expect(body).toMatch(
      /return reply\s*\.type\('text\/csv; charset=utf-8'\)\s*\.header\('content-disposition', 'attachment; filename="crypto-orders\.csv"'\)\s*\.send\(csv\);/,
    );
  });

  it('V-666.N stats route + V-666.W avg_time_to_paid_ms/paid_sample + V-666.AE paid_revenue_by_product/paid_count_by_product + truncated/scanned fields', () => {
    expect(body).toMatch(
      /\/\/ V-666\.N — at-a-glance stats summary for the ops dashboard\.\s*\/\/ Counts per status \+ paid revenue per currency\. Truncated when\s*\/\/ more orders exist than the scan window \(10k default\)\./,
    );
    expect(body).toMatch(
      /\/\/ V-666\.W — adds avg_time_to_paid_ms \+ paid_sample for the ops\s*\/\/ "how fast are customers actually paying" KPI\./,
    );
    expect(body).toMatch(
      /\/\/ V-666\.AE — adds paid_revenue_by_product \+ paid_count_by_product\s*\/\/ for the "which tiers are converting" KPI\./,
    );
    expect(body).toMatch(/'\/v1\/admin\/crypto-orders\/stats',/);
    expect(body).toMatch(
      /return reply\.send\(\{\s*total: stats\.total,\s*by_status: stats\.byStatus,\s*paid_revenue_cents: stats\.paidRevenueCents,\s*avg_time_to_paid_ms: stats\.avgTimeToPaidMs,\s*paid_sample: stats\.paidSample,\s*paid_revenue_by_product: stats\.paidRevenueByProduct,\s*paid_count_by_product: stats\.paidCountByProduct,\s*truncated: stats\.truncated,\s*scanned: stats\.scanned,\s*\}\);/,
    );
  });

  it('V-666.AP idempotency-metrics route + V-666.AR body_mismatches counter (signals client reusing keys across distinct intents)', () => {
    expect(body).toMatch(
      /\/\/ V-666\.AP — idempotency-key counters\. Cheap to scrape \(no full-\s*\/\/ table walk\) — useful for noticing when retries spike \(often a\s*\/\/ client-side bug or a network-blip rate\)\. Auth gated to the\s*\/\/ internal admin scope same as the rest of this surface\./,
    );
    expect(body).toMatch(/'\/v1\/admin\/crypto-orders\/idempotency-metrics',/);
    expect(body).toMatch(
      /\/\/ V-666\.AR — body-fingerprint mismatch count\. Trending non-\s*\/\/ zero signals a client that's reusing keys across distinct\s*\/\/ intents \(often a hardcoded constant where a generated UUID\s*\/\/ belongs\)\.\s*body_mismatches: m\.bodyMismatches,/,
    );
  });

  it('V-666.AC pending-age histogram route (buckets under 1h / 1-6h / 6-24h / over 24h) + pending_value_cents/total/truncated/scanned fields', () => {
    expect(body).toMatch(
      /\/\/ V-666\.AC — pending-orders age histogram\. Buckets currently-\s*\/\/ pending orders by age \(under 1h \/ 1-6h \/ 6-24h \/ over 24h\) so\s*\/\/ ops can spot stale checkouts that should be swept or contacted\./,
    );
    expect(body).toMatch(/'\/v1\/admin\/crypto-orders\/pending-age',/);
    expect(body).toMatch(
      /return reply\.send\(\{\s*buckets: histo\.buckets,\s*pending_value_cents: histo\.pendingValueCents,\s*total: histo\.total,\s*truncated: histo\.truncated,\s*scanned: histo\.scanned,\s*\}\);/,
    );
  });

  it('V-666.O daily route: default 7 days, max 90 days, one row per (date, status) with at least one order in window', () => {
    expect(body).toMatch(
      /\/\/ V-666\.O — per-day breakdown for the last N UTC days \(default 7,\s*\/\/ max 90\)\. One row per \(date, status\) combination that had at\s*\/\/ least one order in the window\./,
    );
    expect(body).toMatch(/'\/v1\/admin\/crypto-orders\/daily',/);
    expect(body).toMatch(
      /throw new BadRequestError\('days must be an integer between 1 and 90\.'\);/,
    );
  });

  it("Get-by-id route: GET '/v1/admin/crypto-orders/:order_id' + NotFoundError when service.getById returns null + toPublic(order) response", () => {
    expect(body).toMatch(/'\/v1\/admin\/crypto-orders\/:order_id',/);
    expect(body).toMatch(
      /const order = await deps\.service\.getById\(params\.order_id\);\s*if \(order === null\) \{\s*throw new NotFoundError\(`No crypto order with id "\$\{params\.order_id\}"\.`\);\s*\}\s*return reply\.send\(toPublic\(order\)\);/,
    );
  });

  it('V-666.AT order events timeline (append-only oldest-first; sources: create/ipn/cancel/expired/swept); ISO timestamps', () => {
    expect(body).toMatch(
      /\/\/ V-666\.AT — order events timeline\. Returns the order's append-\s*\/\/ only event log oldest-first\. The customer-facing surface\s*\/\/ doesn't expose this yet; the admin drawer is the first\s*\/\/ consumer\. Each event carries the destination status, the\s*\/\/ server timestamp, and the source \('create' \/ 'ipn' \/ 'cancel'\s*\/\/ \/ 'expired' \/ 'swept'\)\./,
    );
    expect(body).toMatch(/'\/v1\/admin\/crypto-orders\/:order_id\/events',/);
    expect(body).toMatch(
      /events: events\.map\(\(e\) => \(\{\s*status: e\.status,\s*at: new Date\(e\.at\)\.toISOString\(\),\s*source: e\.source,\s*\}\)\),/,
    );
  });

  it('V-666.L sweep-expired route: POST sweep-expired + idempotent + default olderThanHours=24 + olderThanMs=hours*60*60*1000 + returns {expired, capped, older_than_hours}', () => {
    expect(body).toMatch(
      /\/\/ V-666\.L — on-demand sweep of stale pending orders\. Idempotent —\s*\/\/ ops can invoke any time without side effects on non-eligible\s*\/\/ orders\. Returns the count expired this tick \+ a `capped` flag\s*\/\/ signalling whether more remain \(caller re-runs until capped:\s*\/\/ false\)\. Nightly cron lands separately when scheduled-jobs picks\s*\/\/ this up\./,
    );
    expect(body).toMatch(/'\/v1\/admin\/crypto-orders\/sweep-expired',/);
    expect(body).toMatch(/const olderThanHours = body\.older_than_hours \?\? 24;/);
    expect(body).toMatch(/const olderThanMs = olderThanHours \* 60 \* 60 \* 1000;/);
    expect(body).toMatch(
      /return reply\.send\(\{\s*expired: result\.expired,\s*capped: result\.capped,\s*older_than_hours: olderThanHours,\s*\}\);/,
    );
  });

  it('V-666.F apply-ipn route: POST :order_id/apply-ipn + same state machine as public IPN + forward-only + idempotency-preserving + NotFoundError null + toPublic(updated)', () => {
    expect(body).toMatch(
      /\/\/ V-666\.F — manual IPN application\. Used by ops to recover from\s*\/\/ missed NowPayments webhooks\. Routes through the same state\s*\/\/ machine as the public IPN endpoint, so the forward-only \+\s*\/\/ idempotency guarantees still hold\./,
    );
    expect(body).toMatch(/'\/v1\/admin\/crypto-orders\/:order_id\/apply-ipn',/);
    // D-025 audit-gap fix — apply-ipn is now wrapped in withAudit (success +
    // failure both audited); the null→NotFoundError check moved inside the
    // withAudit perform() callback so a not-found attempt is still audited
    // before the re-throw.
    expect(body).toMatch(
      /const updated = await withAudit\(\s*req,\s*'crypto_order\.ipn_applied',\s*params\.order_id,\s*\{ provider_status: body\.provider_status, payment_id: body\.payment_id \},\s*async \(\) => \{\s*const result = await deps\.service\.applyIpnStatus\(\{\s*order_id: params\.order_id,\s*payment_id: body\.payment_id,\s*provider_status: body\.provider_status,\s*\}\);/,
    );
  });

  it('V-666.AA internal-note route: PATCH :order_id/internal-note + null/empty-string clears + NotFoundError when service returns null + toPublic(updated)', () => {
    expect(body).toMatch(
      /\/\/ V-666\.AA — admin sets \/ clears the internal-note field on an\s*\/\/ order\. PATCH semantics: send \{ internal_note: "\.\.\." \} to set,\s*\/\/ \{ internal_note: null \} or \{ internal_note: "" \} to clear\./,
    );
    expect(body).toMatch(/'\/v1\/admin\/crypto-orders\/:order_id\/internal-note',/);
    // D-025 audit-gap fix — internal-note is now wrapped in withAudit
    // (success + failure both audited).
    expect(body).toMatch(
      /const updated = await withAudit\(\s*req,\s*'crypto_order\.note_updated',\s*params\.order_id,\s*\{ internal_note: body\.internal_note \},\s*async \(\) => \{\s*const result = await deps\.service\.setInternalNote\(\{\s*order_id: params\.order_id,\s*internal_note: body\.internal_note,\s*\}\);/,
    );
  });

  it('registerAdminCryptoOrdersRoutes signature + deps interface (D-025 audit-gap fix: deps now carries AdminAuditService)', () => {
    expect(body).toMatch(
      /export interface RegisterAdminCryptoOrdersRoutesDeps \{\s*service: CryptoOrdersService;/,
    );
    expect(body).toMatch(/audit: AdminAuditService;/);
    expect(body).toMatch(
      /export function registerAdminCryptoOrdersRoutes\(\s*app: FastifyInstance,\s*deps: RegisterAdminCryptoOrdersRoutesDeps,\s*\): void \{/,
    );
  });

  it('D-025 audit-gap fix: withAudit helper wraps sweep-expired/apply-ipn/internal-note with audit-on-success + audit-on-error, matching admin-accounts.ts withAudit shape', () => {
    expect(body).toMatch(
      /async function withAudit<T>\(\s*request: FastifyRequest,\s*action: AdminAuditAction,\s*orderId: string \| null,\s*inputPayload: Record<string, unknown>,\s*perform: \(\) => Promise<T>,\s*\): Promise<T> \{/,
    );
    expect(body).toMatch(/result: 'success',/);
    expect(body).toMatch(/result: `error: \$\{code\}`,/);
    expect(body).toMatch(
      /import type \{ AdminAuditService, AdminAuditAction \} from '\.\.\/services\/admin-audit\.js';/,
    );
    expect(body).toMatch(/import \{ readClientIp \} from '\.\.\/lib\/client-ip\.js';/);
  });

  it('D-025 audit-gap fix: sweep-expired wrapped in withAudit with action crypto_order.swept + targetResourceId null (batch operation, not one order)', () => {
    expect(body).toMatch(
      /const result = await withAudit\(\s*req,\s*'crypto_order\.swept',\s*null,/,
    );
  });

  it('parseOrThrow helper: zod safeParse + BadRequestError on failure with error.message', () => {
    expect(body).toMatch(
      /function parseOrThrow<T>\(schema: z\.ZodSchema<T>, input: unknown\): T \{\s*const result = schema\.safeParse\(input\);\s*if \(!result\.success\) throw new BadRequestError\(result\.error\.message\);\s*return result\.data;\s*\}/,
    );
  });

  it("every route preHandler chains [requireScope('driftstack_internal_admin'), rateLimit('global')] — 2026-05-20 rate-limit audit item 7 closed", () => {
    const occurrences = body.match(
      /\{ preHandler: \[app\.requireScope\('driftstack_internal_admin'\), app\.rateLimit\('global'\)\] \}/g,
    );
    expect(occurrences).not.toBeNull();
    expect((occurrences ?? []).length).toBe(11);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
