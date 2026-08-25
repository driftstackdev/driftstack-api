// W-13 — the customer half of "a state change that leaves no audit row is a
// change nobody can review".
//
// `every-mutating-admin-route-writes-an-audit-row` scopes itself BY PATH to
// `/v1/admin/`, and has no customer sibling. Every mutation a CUSTOMER makes —
// billing, egress, legal acceptance, team membership — was outside any
// audit-coverage guard.
//
// ⛔ THE FIRST MEASUREMENT OF THIS WAS 119 OF 125 UNAUDITED, AND IT WAS WRONG.
// Audit calls live in the SERVICE, not the route: `services/team-members.ts`
// records three actions and its routes contain no audit call at all. A scan of
// route bodies therefore reports a delegating route as bare. The number was
// discarded rather than published — it is recorded here because a wrong number
// that says "there is a problem" is the kind that gets believed.
//
// WHAT THIS MEASURES, stated so nobody reads it as more: whether a central
// `accountAudit.record` call is reachable from a route — in its own body, or in
// any module its file imports one hop. It does NOT prove the specific handler
// audits, and it does NOT mean an unlisted route leaves no trace: seven of the
// nine below persist a domain record, and `/v1/legal/accept` writes
// `legal_acceptances`, whose schema comment calls it an audit log in its own
// right.
//
// ⚠️ The one-hop import check OVER-approximates coverage, measured rather than
// assumed: run against the three `/v1/admin/oauth/clients` routes that the
// sibling guard declares unaudited, it reports all three as covered, because
// another function in an imported module audits. So the set below is a LOWER
// bound on the uncovered, and the arm is one-sided in that direction on purpose.

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROUTES_DIR = resolve(HERE, '..', '..', 'src', 'routes');

/** Matches the sibling guard's pattern, including `app.post<{Body:X}>(`. */
const ROUTE_REGISTRATION = /app\.(get|post|patch|put|delete)\s*(?:<[^(]*>)?\s*\(/g;
const MUTATING = new Set(['post', 'patch', 'put', 'delete']);

/**
 * Every spelling that reaches the account audit recorder.
 *
 * `accountAudit.record` alone would miss `this.accountAudit.record` (services)
 * and `accountAudit?.record` (optional dep in agent-sessions) — between them
 * two thirds of the call sites.
 */
const AUDIT_CALL = /(?:this\.)?accountAudit\??\.record|withAudit|audit\.record/;

/** A 503 stub for a deployment-gated feature changes nothing, so it owes nothing. */
const DISABLED_STUB = /,\s*stub\s*\)|handler:\s*stub\b/;

/**
 * Not customer surface — none of these is an account-holder acting on their own
 * account, which is what an account audit log is for.
 *
 * `/v1/oauth/*` are OAuth 2 protocol endpoints a THIRD-PARTY client drives with
 * its own client credentials (V-1637 established the same boundary for SDK
 * coverage). `/v1/webhooks/*` are INBOUND callbacks from Stripe and NOWPayments —
 * the payment provider is the caller, not the customer. `/v1/mac-nodes/*` is
 * fleet-node registration behind internal bearer auth.
 */
const NOT_CUSTOMER = [
  '/v1/admin/',
  '/v1/internal/',
  '/v1/oauth/',
  '/v1/webhooks/',
  '/v1/mac-nodes',
];

/**
 * Customer mutations with no central-audit call reachable, and why each is
 * acceptable TODAY. ⛔ None of them is "a change that leaves no trace" — that
 * was checked per route, not assumed.
 */
const NO_CENTRAL_AUDIT = new Map<string, string>([
  [
    'POST /v1/billing/crypto-checkout/quote',
    'not a mutation — a quote is pure computation; it is POST because it takes a body',
  ],
  [
    'POST /v1/legal/accept',
    'writes `legal_acceptances`, whose schema comment describes it as the audit log of customer acceptance — a dedicated trail rather than a missing one',
  ],
  ['POST /v1/billing/crypto-checkout', 'creates a crypto order; the order row IS the record'],
  [
    'PATCH /v1/billing/crypto-orders/:order_id',
    'mutates a crypto order row, which carries its own state',
  ],
  [
    'POST /v1/billing/crypto-orders/:order_id/cancel',
    'same — the cancelled order row is the record',
  ],
  [
    'POST /v1/status/subscribe',
    'creates a status-subscriber row; an email-confirmation flow, not account state',
  ],
  [
    'POST /v1/sessions/:id/proxy',
    'binds a proxy to a session; the session row carries the binding',
  ],
  [
    'POST /v1/billing/checkout-session',
    'builds a Stripe Checkout session; the durable record is created by Stripe and arrives via webhook',
  ],
  [
    'POST /v1/billing/portal-session',
    'builds a Stripe Billing Portal session; a redirect, and Stripe owns the resulting record',
  ],
]);

interface RouteBlock {
  file: string;
  verb: string;
  path: string;
  body: string;
}

function routeFiles(): string[] {
  return readdirSync(ROUTES_DIR)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => join(ROUTES_DIR, f))
    .sort();
}

const sourceCache = new Map<string, string>();
function source(p: string): string {
  const hit = sourceCache.get(p);
  if (hit !== undefined) return hit;
  const t = readFileSync(p, 'utf-8');
  sourceCache.set(p, t);
  return t;
}

/** Modules a route file imports by relative path, resolved one hop. */
function importedModules(file: string): string[] {
  const out: string[] = [];
  for (const m of source(file).matchAll(/from '(\.\.?\/[^']+)'/g)) {
    const rel = (m[1] ?? '').replace(/\.js$/, '.ts');
    const candidate = resolve(dirname(file), rel);
    try {
      readFileSync(candidate, 'utf-8');
      out.push(candidate);
    } catch {
      // A package import or a directory index — not a one-hop module.
    }
  }
  return out;
}

function routeBlocks(): RouteBlock[] {
  const blocks: RouteBlock[] = [];
  for (const file of routeFiles()) {
    const src = source(file);
    const marks = [...src.matchAll(ROUTE_REGISTRATION)];
    marks.forEach((mark, i) => {
      const start = mark.index ?? 0;
      const end = i + 1 < marks.length ? (marks[i + 1]?.index ?? src.length) : src.length;
      const body = src.slice(start, end);
      const pathMatch = /['"`]([^'"`]+)['"`]/.exec(body);
      if (pathMatch?.[1] === undefined) return;
      blocks.push({ file, verb: (mark[1] ?? '').toUpperCase(), path: pathMatch[1], body });
    });
  }
  return blocks;
}

function customerMutations(): RouteBlock[] {
  const seen = new Set<string>();
  const out: RouteBlock[] = [];
  for (const b of routeBlocks()) {
    if (!MUTATING.has(b.verb.toLowerCase())) continue;
    if (NOT_CUSTOMER.some((p) => b.path.startsWith(p))) continue;
    if (DISABLED_STUB.test(b.body)) continue;
    const key = `${b.verb} ${b.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(b);
  }
  return out;
}

/**
 * ⚠️ Deliberately coarse, in a stated direction. It tests the whole route FILE
 * rather than the route's own block, because an audit call frequently lives in a
 * file-level helper declared ABOVE the registrations — `account-byok-anthropic.ts`
 * records at line 103, before its first `app.put` at 139, so block-scoped
 * detection reported three audited routes as bare. Combined with the one-hop
 * import check this OVER-approximates coverage, which makes the listed set a
 * LOWER bound on what is uncovered. Measured, not assumed: run against the three
 * `/v1/admin/oauth/clients` routes the sibling guard declares unaudited, it
 * reports all three as covered.
 */
const auditReachable = (b: RouteBlock): boolean =>
  AUDIT_CALL.test(source(b.file)) ||
  importedModules(b.file).some((m) => AUDIT_CALL.test(source(m)));

describe('W-13 every customer mutation is audited, or recorded as not', () => {
  it('CRITICAL POSITIVE CONTROL the detector finds an audit call that lives in a SERVICE, not the route. Without this the sweep could report every delegating route as bare — which is exactly the wrong measurement this guard exists to replace.', () => {
    const removal = customerMutations().find(
      (b) => b.verb === 'DELETE' && b.path.includes('/team/members/'),
    );
    expect(removal, 'the team-member removal route is in the population').toBeDefined();
    // Its own body contains no audit call at all...
    expect(AUDIT_CALL.test(removal?.body ?? '')).toBe(false);
    // ...and it is still detected, via services/team-members.ts.
    expect(auditReachable(removal as RouteBlock)).toBe(true);
  });

  it("CRITICAL the population is real routes, not a pattern artefact — it reproduces the sibling guard's independently measured admin count", () => {
    const admin = routeBlocks().filter(
      (b) => MUTATING.has(b.verb.toLowerCase()) && b.path.startsWith('/v1/admin/'),
    );
    // `every-mutating-admin-route-writes-an-audit-row` measured 33.
    expect(admin.length, 'admin mutating routes').toBe(33);
    expect(customerMutations().length, 'customer mutating routes').toBeGreaterThan(80);
  });

  it('CRITICAL every customer mutation either reaches the account audit log or is listed with a reason. A new one joins the listed set only deliberately.', () => {
    const uncovered = customerMutations()
      .filter((b) => !auditReachable(b))
      .map((b) => `${b.verb} ${b.path}`)
      .sort();
    expect(
      uncovered.filter((k) => !NO_CENTRAL_AUDIT.has(k)),
      'these customer mutations reach no account-audit call and carry no recorded reason:',
    ).toEqual([]);
  });

  it('CRITICAL a listed route that starts auditing must leave the list, so it cannot look considered while hiding nothing', () => {
    const uncovered = new Set(
      customerMutations()
        .filter((b) => !auditReachable(b))
        .map((b) => `${b.verb} ${b.path}`),
    );
    expect(
      [...NO_CENTRAL_AUDIT.keys()].filter((k) => !uncovered.has(k)).sort(),
      'these are listed as reaching no audit call and now do (or no longer exist):',
    ).toEqual([]);
  });
});
