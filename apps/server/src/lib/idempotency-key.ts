// V-666.AO + v2-#19 — shared Idempotency-Key parser.
//
// Four routes consume the customer-facing `Idempotency-Key` request
// header today:
//
//   - POST /v1/billing/checkout-session (Stripe Checkout safe retry)
//   - POST /v1/billing/crypto-checkout (V-666.AO; documented at
//     /docs/idempotency-keys on the marketing site)
//   - POST /v1/agent-sessions (v2-#19; Stripe-pattern dedup)
//   - POST /v1/agent-sessions/:id/message (durable at-most-once turn receipt)
//
// All four follow the same validation contract documented at
// apps/marketing-site/src/pages/docs/idempotency-keys.astro:
//   - empty / whitespace-only → treat as absent
//   - >255 ASCII chars → invalid (return 400)
//   - contains whitespace OR non-printable-ASCII → invalid (400)
//   - duplicate header → first value wins
//
// Previously each route hand-rolled its own parser. agent-sessions
// only checked "empty → absent" and missed the length / whitespace /
// ASCII rules, silently accepting keys that the docs say would be
// rejected. Extracting to a shared helper closes the gap.

import type { FastifyRequest } from 'fastify';

export type IdempotencyHeader =
  | { kind: 'absent' }
  | { kind: 'valid'; key: string }
  | { kind: 'invalid' };

/**
 * Read + validate the `Idempotency-Key` header off a Fastify request.
 *
 * Fastify normalises header names to lowercase before this runs, so
 * the lookup key is always `'idempotency-key'`.
 *
 * Returns a discriminated union:
 *   - `absent` — no header, OR empty / whitespace-only value
 *   - `valid` — key trimmed + content-validated; safe to use as a
 *     dedup key
 *   - `invalid` — caller violated the contract (whitespace inside,
 *     non-ASCII bytes, OR >255 chars). Route layer should 400.
 */
export function readIdempotencyKey(req: FastifyRequest): IdempotencyHeader {
  const raw = req.headers['idempotency-key'];
  if (raw === undefined) return { kind: 'absent' };
  // Duplicate header → first wins. A Fastify request with multiple
  // copies of the same header presents as an array; downstream
  // tooling should not have to think about that.
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined) return { kind: 'absent' };
  const trimmed = value.trim();
  if (trimmed.length === 0) return { kind: 'absent' };
  if (trimmed.length > 255) return { kind: 'invalid' };
  // Printable ASCII excluding space (0x21-0x7e). Whitespace inside
  // the key is rejected — the customer-facing docs commit to this.
  if (!/^[\x21-\x7e]+$/.test(trimmed)) return { kind: 'invalid' };
  return { kind: 'valid', key: trimmed };
}
