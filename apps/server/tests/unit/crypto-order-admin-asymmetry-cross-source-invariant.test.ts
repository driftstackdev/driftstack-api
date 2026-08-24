// W896 — CryptoOrder admin-vs-customer asymmetry cross-source
// invariant. Two-hundred-twenty-second in the drift-guard series.
// Pins the V-666 crypto-order admin-vs-customer surface split:
//
//   CryptoOrderEnvelope (customer surface, 12 fields):
//     order_id + product + price_cents + price_currency +
//     payment_id + status + customer_note + events + expires_at
//     + created_at + updated_at.
//
//   AdminCryptoOrderEnvelope (admin surface, EXTENDS customer + 2):
//     - Customer 12 fields PLUS:
//     - account_id: nullable (null for pre-signup checkouts).
//     - internal_note: nullable (admin-only).
//
//   ListCryptoOrdersQuery (customer):
//     - limit: 1-100.
//     - status?: CryptoOrderStatusSchema.
//     - V-666.BU cursor: 1+ chars forward-pagination.
//     - V-666.BX created_after/created_before: ISO half-open window.
//
//   AdminCryptoOrderEventsResponse source: 5 values (incl. 'swept').
//     Customer event-source is 4 (excludes 'swept'); admin sees all 5.
//
// stays in lockstep across api-types Zod canonical.
//
// Drift would silently break:
//   * Customer-surface leak of admin-only fields (internal_note,
//     account_id).
//   * V-666.AU 'swept' leak to customer-facing event timeline.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W896 CryptoOrder admin/customer asymmetry cross-source invariant', () => {
  // ─── AdminCryptoOrderEnvelope extends customer + 2 admin-only ─

  it('CRITICAL packages/api-types/src/crypto-orders.ts AdminCryptoOrderEnvelopeSchema = CryptoOrderEnvelopeSchema.extend({ account_id: z.string().nullable(), internal_note: z.string().nullable() }). The 2-field admin extension keeps the customer surface narrow + admin-only fields strictly admin.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/crypto-orders.ts'));
    expect(p).toMatch(
      /AdminCryptoOrderEnvelopeSchema = CryptoOrderEnvelopeSchema\.extend\(\{[\s\S]+?account_id: z\.string\(\)\.nullable\(\),[\s\S]+?internal_note: z\.string\(\)\.nullable\(\)/,
    );
  });

  it("CRITICAL admin extension comment pins 'Owning account; null for pre-signup checkouts' + 'Admin-only operations note. Never returned on the customer surface'. The two-comment pair distinguishes 'data the customer-side schema also has but is admin-trimmed' from 'admin-only entirely'.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/crypto-orders.ts'));
    expect(p).toMatch(/Owning account; null for pre-signup checkouts\./);
    expect(p).toMatch(/Admin-only operations note\. Never returned on the customer surface\./);
  });

  // ─── Customer-facing envelope does NOT include admin fields ──

  it('CRITICAL CryptoOrderEnvelopeSchema (customer surface) does NOT include account_id or internal_note fields. The fields are admin-only — drift to adding them to customer-side would leak operations details.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/crypto-orders.ts'));
    const m = p.match(/CryptoOrderEnvelopeSchema = z\.object\(\{([\s\S]+?)\}\);/);
    expect(m).not.toBeNull();
    const body = m![1];
    expect(body, 'customer envelope MUST NOT have account_id').not.toMatch(/account_id:/);
    expect(body, 'customer envelope MUST NOT have internal_note').not.toMatch(/internal_note:/);
  });

  // ─── ListCryptoOrders cursor + window bounds ─────────────────

  it('CRITICAL ListCryptoOrdersQuerySchema has 5 fields — limit (1-100) + status + cursor (V-666.BU) + created_after + created_before (V-666.BX half-open ISO). The 5-field query is the pagination + filter surface.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/crypto-orders.ts'));
    expect(p).toMatch(
      /ListCryptoOrdersQuerySchema = z\.object\(\{[\s\S]+?limit: z\.number\(\)\.int\(\)\.min\(1\)\.max\(100\)\.optional\(\)/,
    );
    expect(p).toMatch(/status: CryptoOrderStatusSchema\.optional\(\)/);
    // V-1473 — `.max(512)` is the slice-149 cap; this schema had min but no max.
    expect(p).toMatch(/cursor: z\.string\(\)\.min\(1\)\.max\(512\)\.optional\(\)/);
    expect(p).toMatch(/created_after: z\.string\(\)\.datetime\(\)\.optional\(\)/);
    expect(p).toMatch(/created_before: z\.string\(\)\.datetime\(\)\.optional\(\)/);
  });

  it('CRITICAL V-666.BU + V-666.BX anchors pinned for cursor + window framing. The 2 sub-anchors distinguish pagination from filter — each has its own provenance.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/crypto-orders.ts'));
    expect(p).toMatch(/V-666\.BU — forward cursor/);
    expect(p).toMatch(/V-666\.BX — half-open window on created_at; ISO 8601 strings/);
  });

  // ─── AdminEvents source = 5 (incl. 'swept') ──────────────────

  it("CRITICAL AdminCryptoOrderEventsResponseSchema source field has 5 values including 'swept' — admin sees the FULL event-source set. The customer-facing CryptoOrderEventSourceSchema excludes 'swept' (V-666.AU customer-facing reduction).", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/crypto-orders.ts'));
    expect(p).toMatch(
      /AdminCryptoOrderEventsResponseSchema = z\.object\(\{[\s\S]+?source: z\.enum\(\['create', 'ipn', 'cancel', 'expired', 'swept'\]\)/,
    );
  });

  it("CRITICAL the admin event source comment pins 'Admin source includes the internal swept variant' framing. The cross-reference to customer-side V-666.AU 'swept→expired' mapping is the asymmetry documentation.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/crypto-orders.ts'));
    expect(p).toMatch(/Admin source includes the internal 'swept' variant/);
  });

  // ─── AdminListCryptoOrders response ──────────────────────────

  it('CRITICAL AdminListCryptoOrdersResponseSchema = { orders: array(AdminCryptoOrderEnvelope); next_cursor: nullable }. Mirrors customer ListCryptoOrders shape but with admin-extended envelopes.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/crypto-orders.ts'));
    expect(p).toMatch(
      /AdminListCryptoOrdersResponseSchema = z\.object\(\{\s*\n\s*orders: z\.array\(AdminCryptoOrderEnvelopeSchema\),\s*\n\s*next_cursor: z\.string\(\)\.nullable\(\),\s*\n\s*\}\);/,
    );
  });

  // ─── Asymmetry summary ───────────────────────────────────────

  it('CRITICAL 2 asymmetries are intentional: (a) admin envelope = customer + 2 admin-only fields; (b) admin event source = customer + 1 internal source ("swept"). The asymmetry prevents admin-only state from leaking into customer-facing surfaces.', () => {
    // Customer envelope is the base; admin extends.
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/crypto-orders.ts'));
    expect(p).toMatch(/AdminCryptoOrderEnvelopeSchema = CryptoOrderEnvelopeSchema\.extend\(/);
    // Customer event source is 4; admin event source is 5.
    expect(p).toMatch(
      /CryptoOrderEventSourceSchema = z\.enum\(\['create', 'ipn', 'cancel', 'expired'\]\);/,
    );
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/crypto-order-admin-asymmetry-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
