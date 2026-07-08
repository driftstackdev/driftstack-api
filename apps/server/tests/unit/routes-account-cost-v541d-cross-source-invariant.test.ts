// W1025 — routes/account-cost V-541.D cross-source invariant. Three-
// hundred-fifty-first in the drift-guard series. Pins the apps/
// server/src/routes/account-cost.ts customer-facing cost surface:
//
//   V-541.D anchor — 'V-541.D — customer-facing cost surface'.
//
//   Endpoint — 'GET /v1/account/cost?billing_cycle=YYYY-MM'.
//
//   Scope framing — 'Scoped to the calling account via requireAuth —
//   the service is reused from the admin path (V-541.B) but the
//   account id is pinned to ctx.account.id, not pulled from a URL
//   param'.
//
//   Query schema — billing_cycle optional /^\\d{4}-\\d{2}$/.
//
//   Synth-zero-on-null framing — 'Not 404 — for a fresh account with
//   no usage in the cycle the customer should see you've spent €0
//   this cycle, not not found. Synthesize a zero breakdown response'.
//
//   Synth 7-field breakdown — computeCents:0 + storageCents:0 +
//     egressCents:0 + emailCents:0 + llmCents:0 + totalCents:0 +
//     thresholdState:'under-soft'.
//
//   Customer-omits-thresholds framing — 'Customer surface omits the
//   operator-tuned threshold values (those are admin-only
//   configuration; we don't surface the numeric caps to customers —
//   they see only their actual spend)'.
//
//   Customer response 4 fields — account_id + billing_cycle + tier +
//     breakdown.
//
//   void NotFoundError pragma — 'Make the 404 reachable explicitly
//   for clients that want to distinguish account exists, no data
//   from account doesn't exist. Not currently routed; left as a hook
//   for V-541.E detailed-view scope'.
//
//   preHandler [requireAuth, rateLimit('global')] + parseOrThrow Zod
//     helper.
//
// stays in lockstep across apps/server/src/routes/account-cost.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W1025 routes/account-cost V-541.D cross-source invariant', () => {
  it('CRITICAL V-541.D anchor + endpoint framing.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/account-cost.ts'));
    expect(p).toMatch(/V-541\.D — customer-facing cost surface\./);
    expect(p).toMatch(/GET \/v1\/account\/cost\?billing_cycle=YYYY-MM/);
  });

  it("CRITICAL scope framing — 'Scoped to the calling account via requireAuth — the service is reused from the admin path (V-541.B) but the account id is pinned to ctx.account.id, not pulled from a URL param'.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/account-cost.ts'));
    expect(p).toMatch(/Scoped to the calling account via requireAuth — the service is/);
    expect(p).toMatch(/reused from the admin path \(V-541\.B\) but the account id is pinned/);
    expect(p).toMatch(/to ctx\.account\.id, not pulled from a URL param\./);
  });

  it('CRITICAL query schema — billing_cycle optional /^\\d{4}-\\d{2}$/.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/account-cost.ts'));
    expect(p).toMatch(/billing_cycle: z/);
    expect(p).toMatch(/\.regex\(\/\^\\d\{4\}-\\d\{2\}\$\/\)/);
    expect(p).toMatch(/\.optional\(\)/);
  });

  it("CRITICAL synth-zero framing — 'Not 404 — for a fresh account with no usage in the cycle the customer should see you've spent €0 this cycle, not not found. Synthesize a zero breakdown response'.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/account-cost.ts'));
    expect(p).toMatch(/\/\/ Not 404 — for a fresh account with no usage in the cycle the/);
    expect(p).toMatch(/\/\/ customer should see "you've spent €0 this cycle", not "not/);
    expect(p).toMatch(/\/\/ found"\. Synthesize a zero breakdown response\./);
  });

  it("CRITICAL synth 7-field breakdown — computeCents:0 + storageCents:0 + egressCents:0 + emailCents:0 + llmCents:0 + totalCents:0 + thresholdState:'under-soft'.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/account-cost.ts'));
    expect(p).toMatch(/computeCents: 0,/);
    expect(p).toMatch(/storageCents: 0,/);
    expect(p).toMatch(/egressCents: 0,/);
    expect(p).toMatch(/emailCents: 0,/);
    expect(p).toMatch(/llmCents: 0,/);
    expect(p).toMatch(/totalCents: 0,/);
    expect(p).toMatch(/thresholdState: 'under-soft' as const,/);
  });

  it("CRITICAL customer-omits-thresholds framing — 'Customer surface omits the operator-tuned threshold values (those are admin-only configuration; we don't surface the numeric caps to customers — they see only their actual spend)'.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/account-cost.ts'));
    expect(p).toMatch(/\/\/ Customer surface omits the operator-tuned threshold values/);
    expect(p).toMatch(/\/\/ \(those are admin-only configuration; we don't surface the/);
    expect(p).toMatch(/\/\/ numeric caps to customers — they see only their actual spend\)\./);
  });

  it('CRITICAL customer response 4 fields — account_id (acc_-prefixed, S46 2026-07-07) + billing_cycle + tier + breakdown.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/account-cost.ts'));
    // S46 2026-07-07 (founder-approved) — canonical acc_ prefix, mirroring
    // GET /v1/account/me. Was the bare internal uuid.
    expect(p).toMatch(/account_id: `acc_\$\{summary\.account_id\}`,/);
    expect(p).not.toMatch(/account_id: summary\.account_id,/);
    expect(p).toMatch(/billing_cycle: summary\.billing_cycle,/);
    expect(p).toMatch(/tier: summary\.tier,/);
    expect(p).toMatch(/breakdown: summary\.breakdown,/);
  });

  it('CRITICAL void NotFoundError pragma + V-541.E detailed-view framing.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/account-cost.ts'));
    expect(p).toMatch(/\/\/ Make the 404 reachable explicitly for clients that want to/);
    expect(p).toMatch(/\/\/ distinguish "account exists, no data" from "account doesn't/);
    expect(p).toMatch(/\/\/ exist"\. Not currently routed; left as a hook for V-541\.E/);
    expect(p).toMatch(/\/\/ detailed-view scope\./);
    expect(p).toMatch(/void NotFoundError;/);
  });

  it('CRITICAL preHandler + parseOrThrow Zod helper.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/account-cost.ts'));
    // #122 — the cost read now requires the read:billing scope.
    expect(p).toMatch(
      /\{ preHandler: \[app\.requireAuth, app\.requireScope\('read:billing'\), app\.rateLimit\('global'\)\] \},/,
    );
    expect(p).toMatch(/function parseOrThrow<T>\(schema: z\.ZodSchema<T>, input: unknown\): T \{/);
    expect(p).toContain(
      "if (!result.success) throw new BadRequestError('Invalid query: billing_cycle must be YYYY-MM.');",
    );
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/routes-account-cost-v541d-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
