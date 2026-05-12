// W358.B — drift guard for customer-dashboard /audit-log page
// content. V-216 customer-facing audit log + V-297 GDPR Article-20
// export. Existing tests cover action-label + endpoint parity;
// this guard pins the page-side ACTION_LABEL / FILTER_OPTIONS maps
// against the AccountAuditActionSchema source-of-truth.
//
// Pinned:
//   • Every ACTION_LABEL key is a real AccountAuditActionSchema
//     value (V-216 / V-297 / V-398 audit catalogue).
//   • Every FILTER_OPTIONS preset value is also a real schema
//     value (the dropdown can't 400 by sending a bogus action).
//   • GDPR Article-20 framing pinned (the legal hook for the
//     export buttons).
//   • CSV + JSON export endpoint + format query param pinned ↔
//     server route /v1/account/audit-log/export?format=csv|json.
//   • Cursor-paginated list endpoint /v1/account/audit-log
//     pinned ↔ route registration.
//   • Load-more button + cursor-pagination semantics framed.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AccountAuditActionSchema } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/audit-log.astro');
const ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/account-audit.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W358.B customer-dashboard /audit-log page content parity', () => {
  const body = read(PAGE);
  const route = read(ROUTE);
  const actions = new Set<string>(
    (AccountAuditActionSchema._def as { values: readonly string[] }).values,
  );

  it('every ACTION_LABEL key is a real AccountAuditActionSchema value', () => {
    // Pull every key on the left of `: 'Label',` in the map. A
    // page-side key that the schema doesn't know would render the
    // raw action verbatim, no human-readable label.
    const labelKeys = Array.from(body.matchAll(/'([a-z_]+\.[a-z_]+)':\s*'[^']+',/g)).map(
      (m) => m[1] as string,
    );
    expect(labelKeys.length).toBeGreaterThan(20);
    for (const key of labelKeys) {
      expect(actions.has(key), `ACTION_LABEL key missing from schema: ${key}`).toBe(true);
    }
  });

  it('every FILTER_OPTIONS preset value is a real schema value (no bogus filter values)', () => {
    // The "All events" preset has value: ''; everything else must
    // resolve. A bogus preset would 400 server-side and look like
    // an empty list to the customer.
    const presets = Array.from(body.matchAll(/\{\s*value:\s*'([a-z_]+\.[a-z_]+)',\s*label:/g)).map(
      (m) => m[1] as string,
    );
    expect(presets.length).toBeGreaterThan(15);
    for (const v of presets) {
      expect(actions.has(v), `FILTER_OPTIONS value missing from schema: ${v}`).toBe(true);
    }
  });

  it('GDPR Article-20 portability framing pinned (legal hook for export buttons)', () => {
    expect(body).toMatch(/V-297 — added export \(CSV \/ JSON\) for GDPR Article 20 portability/);
  });

  it('CSV + JSON export endpoint + format query param pinned ↔ server route', () => {
    expect(body).toContain('/v1/account/audit-log/export?format=');
    expect(body).toContain("downloadExport('csv')");
    expect(body).toContain("downloadExport('json')");
    expect(route).toContain("'/v1/account/audit-log/export'");
  });

  it('cursor-paginated list endpoint /v1/account/audit-log pinned ↔ route registration', () => {
    expect(body).toMatch(/GET \/v1\/account\/audit-log/);
    expect(body).toMatch(/cursor pagination/);
    expect(body).toMatch(/params\.push\('cursor=' \+ encodeURIComponent\(cursor\)\)/);
    expect(route).toContain("'/v1/account/audit-log'");
  });

  it('load-more button + next_cursor end-of-walk semantics pinned', () => {
    // The Load-more button is hidden when next_cursor is null —
    // standard cursor-walk termination semantics.
    expect(body).toMatch(/Load more/);
    expect(body).toMatch(/nextCursor = body\.next_cursor \|\| null/);
  });

  it('"presets are single-action because backend takes one action at a time" rationale pinned', () => {
    // V-354 — the page intentionally exposes "security" as adjacent
    // presets rather than one composite filter. Future refactors
    // must either preserve this behaviour or land a backend change
    // first; this comment is the load-bearing breadcrumb.
    expect(body).toMatch(/backend takes one action at a time and not a list/);
  });

  it('ACTION_LABEL covers every audit category cited in customer-facing copy', () => {
    // Spot-check that the major surfaces (account / api_key /
    // session / profile / subscription / webhook / team / admin)
    // each have at least one labeled action — protects against a
    // catalog growing on the server side without the customer-
    // facing labels keeping up.
    for (const prefix of [
      'account.',
      'api_key.',
      'session.',
      'profile.',
      'subscription.',
      'webhook_endpoint.',
      'team.',
      'admin.',
    ]) {
      expect(body).toMatch(new RegExp(`'${prefix.replace('.', '\\.')}[a-z_]+':\\s*'`));
    }
  });
});
