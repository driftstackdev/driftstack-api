// Drift guard for apps/server/src/lib/idempotency-key.ts. Pins the
// V-666.AO + v2-#19 shared Idempotency-Key parser — 3-consumer
// consolidation + 4-rule validation contract + discriminated union
// return shape.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/lib/idempotency-key.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('lib/idempotency-key content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });

  it("V-666.AO + v2-#19 module-level framing pinned: 'shared Idempotency-Key parser.' — pinned so both V-anchors (V-666.AO billing crypto-checkout + v2-#19 agent-sessions) stay documented (drift to dropping either would orphan the cross-feature consumer trail)", () => {
    expect(body).toMatch(/\/\/ V-666\.AO \+ v2-#19 — shared Idempotency-Key parser\./);
  });

  it('3-consumer catalog pins subscription Checkout, crypto checkout, and agent-session retry identities', () => {
    expect(body).toMatch(
      /\/\/ Three routes consume the customer-facing `Idempotency-Key` request\s*\n?\s*\/\/ header today:/,
    );
    expect(body).toMatch(
      /\/\/ {3}- POST \/v1\/billing\/checkout-session \(Stripe Checkout safe retry\)/,
    );
    expect(body).toMatch(
      /\/\/ {3}- POST \/v1\/billing\/crypto-checkout \(V-666\.AO; documented at\s*\n?\s*\/\/ {5}\/docs\/idempotency-keys on the marketing site\)/,
    );
    expect(body).toMatch(/\/\/ {3}- POST \/v1\/agent-sessions \(v2-#19; Stripe-pattern dedup\)/);
  });

  it('4-rule validation contract framing pinned: empty/whitespace → absent + >255 ASCII → invalid (400) + whitespace or non-printable-ASCII → invalid (400) + duplicate header → first wins. + cross-ref to /docs/idempotency-keys.astro single-source-of-truth. — pinned so the 4-rule + docs-as-source-of-truth contract all stay documented', () => {
    expect(body).toMatch(
      /\/\/ All three follow the same validation contract documented at\s*\n?\s*\/\/ apps\/marketing-site\/src\/pages\/docs\/idempotency-keys\.astro:\s*\n?\s*\/\/ {3}- empty \/ whitespace-only → treat as absent\s*\n?\s*\/\/ {3}- >255 ASCII chars → invalid \(return 400\)\s*\n?\s*\/\/ {3}- contains whitespace OR non-printable-ASCII → invalid \(400\)\s*\n?\s*\/\/ {3}- duplicate header → first value wins/,
    );
  });

  it('Extraction-gap-fix framing pinned: \'Previously each route hand-rolled its own parser. agent-sessions only checked "empty → absent" and missed the length / whitespace / ASCII rules, silently accepting keys that the docs say would be rejected. Extracting to a shared helper closes the gap.\' — pinned so the historical context + agent-sessions-was-missing-rules + extracting-closes-gap rationale all stay documented', () => {
    expect(body).toMatch(
      /\/\/ Previously each route hand-rolled its own parser\. agent-sessions\s*\n?\s*\/\/ only checked "empty → absent" and missed the length \/ whitespace \/\s*\n?\s*\/\/ ASCII rules, silently accepting keys that the docs say would be\s*\n?\s*\/\/ rejected\. Extracting to a shared helper closes the gap\./,
    );
  });

  it("IdempotencyHeader 3-variant discriminated union pinned: absent + valid (with key) + invalid. Drift to dropping a variant would force callers to handle 'all the rest' as a fall-through; drift to merging absent + invalid would let downstream code conflate the contract (absent = no opinion; invalid = customer broke the contract → 400)", () => {
    expect(body).toMatch(
      /export type IdempotencyHeader =\s*\{ kind: 'absent' \}\s*\| \{ kind: 'valid'; key: string \}\s*\| \{ kind: 'invalid' \};/,
    );
  });

  it("readIdempotencyKey JSDoc framing pinned: '3 return variants — absent (no header, OR empty / whitespace-only value) + valid (key trimmed + content-validated; safe to use as a dedup key) + invalid (caller violated the contract (whitespace inside, non-ASCII bytes, OR >255 chars). Route layer should 400).' — pinned so the per-variant semantics + route-layer-400-on-invalid contract stay documented", () => {
    expect(body).toMatch(
      /\* Returns a discriminated union:\s*\n?\s*\*\s+- `absent` — no header, OR empty \/ whitespace-only value\s*\n?\s*\*\s+- `valid` — key trimmed \+ content-validated; safe to use as a\s*\n?\s*\*\s+dedup key\s*\n?\s*\*\s+- `invalid` — caller violated the contract \(whitespace inside,\s*\n?\s*\*\s+non-ASCII bytes, OR >255 chars\)\. Route layer should 400\./,
    );
  });

  it("Fastify normalises header to 'idempotency-key' lowercase framing pinned: 'Fastify normalises header names to lowercase before this runs, so the lookup key is always idempotency-key.' — pinned so the lowercase-lookup contract stays documented", () => {
    expect(body).toMatch(
      /\* Fastify normalises header names to lowercase before this runs, so\s*\n?\s*\*\s+the lookup key is always `'idempotency-key'`\./,
    );
  });

  it("readIdempotencyKey 6-step implementation pinned: 1. undefined → absent 2. array → first wins (with framing 'Duplicate header → first wins. A Fastify request with multiple copies of the same header presents as an array; downstream tooling should not have to think about that.') 3. undefined first → absent 4. trim → empty? absent 5. length > 255 → invalid 6. /^[\\x21-\\x7e]+$/ char class (printable ASCII excluding space; 'Whitespace inside the key is rejected — the customer-facing docs commit to this.') Drift to using last-wins on duplicate would let attackers force a specific dedup key; drift to expanding the char class to allow whitespace would silently change the contract the docs commit to", () => {
    expect(body).toMatch(
      /\/\/ Duplicate header → first wins\. A Fastify request with multiple\s*\n?\s*\/\/ copies of the same header presents as an array; downstream\s*\n?\s*\/\/ tooling should not have to think about that\./,
    );
    expect(body).toMatch(
      /export function readIdempotencyKey\(req: FastifyRequest\): IdempotencyHeader \{\s*\n?\s*const raw = req\.headers\['idempotency-key'\];\s*\n?\s*if \(raw === undefined\) return \{ kind: 'absent' \};/,
    );
    expect(body).toMatch(
      /const value = Array\.isArray\(raw\) \? raw\[0\] : raw;\s*\n?\s*if \(value === undefined\) return \{ kind: 'absent' \};\s*\n?\s*const trimmed = value\.trim\(\);\s*\n?\s*if \(trimmed\.length === 0\) return \{ kind: 'absent' \};\s*\n?\s*if \(trimmed\.length > 255\) return \{ kind: 'invalid' \};/,
    );
    expect(body).toMatch(
      /\/\/ Printable ASCII excluding space \(0x21-0x7e\)\. Whitespace inside\s*\n?\s*\/\/ the key is rejected — the customer-facing docs commit to this\.\s*\n?\s*if \(!\/\^\[\\x21-\\x7e\]\+\$\/\.test\(trimmed\)\) return \{ kind: 'invalid' \};/,
    );
    expect(body).toMatch(/return \{ kind: 'valid', key: trimmed \};/);
  });
});
