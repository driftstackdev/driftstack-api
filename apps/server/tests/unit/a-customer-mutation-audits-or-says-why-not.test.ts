// V-2057 — every mutating CUSTOMER route writes an audit row, or is on a list
// somebody had to look at.
//
// The admin half already has this (`admin-audit-route-coverage-invariant`,
// V-1007). It exists because `services/admin-audit.ts` claimed "Every
// /v1/admin/* endpoint writes one row here before returning its response" and
// that sentence was false in two ways. The customer half had no equivalent: its
// guards pin the SERVICE's shape — header text, field counts, method counts,
// scope gates — and nothing asserted which customer mutations reach
// `account_audit`.
//
// Coverage there rested on `docs/internal/2026-05-19-audit-log-coverage-audit.md`,
// whose own method was "spot-check route files". It has since drifted: it filed
// recipes under "Acceptable gaps (not customer-action-driven) — read-only
// customer surface; no modification ⇒ no audit needed", and recipes now register
// an authenticated write-scoped POST and DELETE (V-2054). A dated document cannot
// notice that; this can.
//
// ⛔ The emit is usually one hop away. A route rarely calls the audit service
// itself — it calls `api-keys`/`mfa`/`auth-flows`/`profiles`, which emit. A
// route-file-level check reports 20 of 27 files unaudited and every one of those
// is wrong. Resolving each route's own service imports is what makes the census
// mean anything.

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '..', '..', 'src');
const ROUTES = resolve(SRC, 'routes');

/** Identifiers that mean "this file reaches the customer audit log". */
const AUDIT = /accountAudit|emitAuditBestEffort|recordAccountAudit|AccountAuditAction/;

/** Mutating customer routes that do NOT audit, each with the reason it is not a
 *  gap. Prose, not `true`: an entry added without a reason is as unreviewed as a
 *  file missing from the list, and a reason has to survive being read. */
const NO_AUDIT_REVIEWED: ReadonlyMap<string, string> = new Map([
  [
    'billing.ts',
    'Stripe is the audit boundary for billing — the 2026-05-19 coverage audit ruled this ACCEPTABLE',
  ],
  ['billing-crypto.ts', 'same billing boundary; the provider holds the payment record'],
  ['billing-crypto-orders.ts', 'same billing boundary'],
  ['billing-crypto-quote.ts', 'same billing boundary; a quote persists no customer state'],
  [
    'session-proxy.ts',
    'POST /v1/sessions/:id/proxy throws FeatureUnavailableError unconditionally (V-823) — the route is not wired to the egress service, so it changes no state to audit',
  ],
  [
    'agent-sessions-transport-report.ts',
    'fire-and-forget ICE telemetry: logs via req.log and returns 204, persisting no customer state',
  ],
  [
    'legal.ts',
    'POST /v1/legal/accept writes a dedicated lacc- acceptance record carrying IP and user-agent, a stronger and more specific artifact than an audit row',
  ],
  [
    'status-subscribe.ts',
    'public status-page double-opt-in, unauthenticated and IP-gated — account_audit is account-scoped and there is no account to attribute a public subscriber to',
  ],
]);

function code(p: string): string {
  return readFileSync(p, 'utf8')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
    .join('\n');
}

/** Customer route files that register a mutation, mapped to whether the file or
 *  any service it directly imports reaches the audit log. Walked, not listed —
 *  a NEW customer mutation is the drift this exists for. */
function customerMutatingRoutes(): Map<string, boolean> {
  const out = new Map<string, boolean>();
  for (const entry of readdirSync(ROUTES)) {
    if (!entry.endsWith('.ts')) continue;
    if (entry.startsWith('admin') || entry.startsWith('_')) continue;
    if (entry.includes('internal') || entry.startsWith('webhooks-')) continue;
    const path = resolve(ROUTES, entry);
    const src = readFileSync(path, 'utf8');
    const body = code(path);
    if (!/app\.(post|patch|put|delete)(?:<[^>]*>)?\(\s*'/.test(body)) continue;
    const hops = [...src.matchAll(/from '(\.\.\/services\/[\w-]+)\.js'/g)].map((m) =>
      resolve(dirname(path), `${m[1] ?? ''}.ts`),
    );
    const audits =
      AUDIT.test(body) ||
      hops.some((h) => {
        try {
          return AUDIT.test(code(h));
        } catch {
          return false;
        }
      });
    out.set(entry, audits);
  }
  return out;
}

describe('a customer mutation audits, or says why not', () => {
  it('CRITICAL the census found customer mutating routes AND can tell an auditing one from a silent one. Both arms below compare sets, so an empty walk would report no gaps over no routes — and a resolver that stopped following service imports would report almost every file as silent, which is what the route-level version of this check actually did.', () => {
    const routes = customerMutatingRoutes();
    expect(routes.size, 'no customer mutating routes found').toBeGreaterThan(20);
    expect(
      [...routes.values()].filter(Boolean).length,
      'no route resolved to an audit emit — the one-hop service resolution is broken',
    ).toBeGreaterThan(10);
  });

  it('CRITICAL every mutating customer route either reaches the audit log or is recorded here with a reason. A customer mutation that records nothing is invisible to the account owner reading their own audit log, and on a shared team account it is invisible to everyone including the member who did it.', () => {
    const unreviewed = [...customerMutatingRoutes().entries()]
      .filter(([file, audits]) => !audits && !NO_AUDIT_REVIEWED.has(file))
      .map(([file]) => file)
      .sort();
    expect(
      unreviewed,
      'customer route(s) that mutate without an audit row and without a recorded reason:',
    ).toEqual([]);
  });

  it('the reviewed list cannot rot: every entry still names a customer route that mutates and does not audit. An entry whose file started auditing, or stopped mutating, is a stale claim that makes this list look more considered than it is.', () => {
    const routes = customerMutatingRoutes();
    const stale = [...NO_AUDIT_REVIEWED.keys()]
      .filter((f) => !routes.has(f) || routes.get(f) === true)
      .sort();
    expect(stale, 'reviewed entr(ies) that no longer describe a silent customer mutation:').toEqual(
      [],
    );
  });
});
