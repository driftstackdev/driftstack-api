// Drift guard for apps/server/src/lib/idempotency-key.ts. Pins the
// V-666.AO + v2-#19 shared Idempotency-Key parser — 4-consumer
// consolidation + 4-rule validation contract + discriminated union
// return shape.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/lib/idempotency-key.ts');
const SPEC = resolve(REPO_ROOT, 'packages/sdk-python/openapi.json');

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

  it('4-consumer catalog pins subscription checkout, crypto checkout, agent-session create, and durable agent-turn retry identities', () => {
    expect(body).toMatch(
      /\/\/ Four routes consume the customer-facing `Idempotency-Key` request\s*\/\/ header today:/,
    );
    expect(body).toMatch(
      /\/\/ {3}- POST \/v1\/billing\/checkout-session \(Stripe Checkout safe retry\)/,
    );
    expect(body).toMatch(
      /\/\/ {3}- POST \/v1\/billing\/crypto-checkout \(V-666\.AO; documented at\s*\/\/ {5}\/docs\/idempotency-keys on the marketing site\)/,
    );
    expect(body).toMatch(/\/\/ {3}- POST \/v1\/agent-sessions \(v2-#19; Stripe-pattern dedup\)/);
    expect(body).toMatch(
      /\/\/ {3}- POST \/v1\/agent-sessions\/:id\/message \(durable at-most-once turn receipt\)/,
    );
  });

  it("V-1507 CRITICAL every route in that catalog DECLARES the header in the published spec. The list above is parsed out of the module's own comment rather than restated here, so the two cannot be edited apart. Two of the four honoured the header while the document never mentioned it: a generated client has no parameter to send `Idempotency-Key` with, so the safe-retry guarantee the reference page promises was unreachable from the SDKs — `POST /v1/agent-sessions` deduplicates via findByIdempotencyKey and replays its original 201, and `POST /v1/billing/checkout-session` forwards the key to Stripe.", () => {
    const catalog = [...body.matchAll(/^\/\/ {3}- (POST) (\/v1\/[^\s(]+)/gm)].map(
      (m) => `${m[1]} ${m[2]!.replace(/:(\w+)/g, '{$1}')}`,
    );
    // The assertion below reports an absence, so an empty parse would pass
    // having compared nothing — the failure mode this repo has hit repeatedly.
    expect(catalog.length, "consumers parsed out of the module's own comment").toBe(4);

    const spec = JSON.parse(readFileSync(SPEC, 'utf8')) as {
      paths: Record<string, Record<string, { parameters?: { name?: string; in?: string }[] }>>;
    };
    const declared = new Set<string>();
    for (const [path, ops] of Object.entries(spec.paths)) {
      for (const [method, op] of Object.entries(ops)) {
        const has = (op.parameters ?? []).some(
          (x) => x.in === 'header' && (x.name ?? '').toLowerCase() === 'idempotency-key',
        );
        if (has) declared.add(`${method.toUpperCase()} ${path}`);
      }
    }
    expect(
      catalog.filter((r) => !declared.has(r)).sort(),
      'these routes read Idempotency-Key and the published spec does not declare it, so a ' +
        'generated client cannot send one:',
    ).toEqual([]);
    // And the reverse: a declaration on a route that does not read the header
    // promises deduplication the server will not perform.
    expect(
      [...declared].filter((r) => !catalog.includes(r)).sort(),
      'the spec declares Idempotency-Key on routes the parser catalog does not list:',
    ).toEqual([]);
  });

  // V-1365 — the fourth rule used to say a repeated header resolved to its first
  // value. It does not: Node joins the two values with a comma and a space, and the
  // joined string then fails the whitespace rule, so the real outcome is a 400. The
  // rule now states that, and the behaviour is executed over a socket in
  // tests/integration/a-header-sent-twice-does-not-arrive-as-an-array.test.ts.
  it('4-rule validation contract framing pinned: empty/whitespace → absent + >255 ASCII → invalid (400) + whitespace or non-printable-ASCII → invalid (400) + header sent twice → joined by Node and refused as whitespace (400). + cross-ref to /docs/idempotency-keys.astro single-source-of-truth. — pinned so the 4-rule + docs-as-source-of-truth contract all stay documented', () => {
    expect(body).toMatch(
      /\/\/ All four follow the same validation contract documented at\s*\/\/ apps\/marketing-site\/src\/pages\/docs\/idempotency-keys\.astro:\s*\/\/ {3}- empty \/ whitespace-only → treat as absent\s*\/\/ {3}- >255 ASCII chars → invalid \(return 400\)\s*\/\/ {3}- contains whitespace OR non-printable-ASCII → invalid \(400\)\s*\/\/ {3}- header sent twice → Node joins the two values with `, `, and the\s*\/\/ {5}joined string trips the whitespace rule above → invalid \(400\)/,
    );
  });

  it('Extraction-gap-fix framing pinned: \'Previously each route hand-rolled its own parser. agent-sessions only checked "empty → absent" and missed the length / whitespace / ASCII rules, silently accepting keys that the docs say would be rejected. Extracting to a shared helper closes the gap.\' — pinned so the historical context + agent-sessions-was-missing-rules + extracting-closes-gap rationale all stay documented', () => {
    expect(body).toMatch(
      /\/\/ Previously each route hand-rolled its own parser\. agent-sessions\s*\/\/ only checked "empty → absent" and missed the length \/ whitespace \/\s*\/\/ ASCII rules, silently accepting keys that the docs say would be\s*\/\/ rejected\. Extracting to a shared helper closes the gap\./,
    );
  });

  it("IdempotencyHeader 3-variant discriminated union pinned: absent + valid (with key) + invalid. Drift to dropping a variant would force callers to handle 'all the rest' as a fall-through; drift to merging absent + invalid would let downstream code conflate the contract (absent = no opinion; invalid = customer broke the contract → 400)", () => {
    expect(body).toMatch(
      /export type IdempotencyHeader =\s*\| \{ kind: 'absent' \}\s*\| \{ kind: 'valid'; key: string \}\s*\| \{ kind: 'invalid' \};/,
    );
  });

  it("readIdempotencyKey JSDoc framing pinned: '3 return variants — absent (no header, OR empty / whitespace-only value) + valid (key trimmed + content-validated; safe to use as a dedup key) + invalid (caller violated the contract (whitespace inside, non-ASCII bytes, OR >255 chars). Route layer should 400).' — pinned so the per-variant semantics + route-layer-400-on-invalid contract stay documented", () => {
    expect(body).toMatch(
      /\* Returns a discriminated union:\s*\*\s+- `absent` — no header, OR empty \/ whitespace-only value\s*\*\s+- `valid` — key trimmed \+ content-validated; safe to use as a\s*\*\s+dedup key\s*\*\s+- `invalid` — caller violated the contract \(whitespace inside,\s*\*\s+non-ASCII bytes, OR >255 chars\)\. Route layer should 400\./,
    );
  });

  it("Fastify normalises header to 'idempotency-key' lowercase framing pinned: 'Fastify normalises header names to lowercase before this runs, so the lookup key is always idempotency-key.' — pinned so the lowercase-lookup contract stays documented", () => {
    expect(body).toMatch(
      /\* Fastify normalises header names to lowercase before this runs, so\s*\*\s+the lookup key is always `'idempotency-key'`\./,
    );
  });

  // V-1365 — this pin used to freeze a claim that the array narrowing was the
  // duplicate-header path. Only `set-cookie` reaches a handler as an array, so that
  // branch cannot run for this header; the narrowing is there for the `string |
  // string[]` type. What the pin protects is unchanged and now stated truthfully,
  // including the reason the check cannot be written with app.inject.
  it("readIdempotencyKey 6-step implementation pinned: 1. undefined → absent 2. narrow the string | string[] header type (explicitly NOT the duplicate path — Node arrays only set-cookie, and a repeated key arrives joined as `key-one, key-two`, which the whitespace rule then refuses) 3. undefined first → absent 4. trim → empty? absent 5. length > 255 → invalid 6. /^[\\x21-\\x7e]+$/ char class (printable ASCII excluding space; 'Whitespace inside the key is rejected — the customer-facing docs commit to this.') Drift to expanding the char class to allow whitespace would silently change the contract the docs commit to, AND would start accepting a joined duplicate as a dedup key that is neither value the customer sent", () => {
    expect(body).toMatch(
      /\/\/ NOT the duplicate-header path, whatever it looks like: Node puts only\s*\/\/ `set-cookie` in an array\. A repeated `Idempotency-Key` arrives already\s*\/\/ joined — `key-one, key-two` — and the whitespace rule below then refuses\s*\/\/ it/,
    );
    expect(body).toMatch(
      /tests\/integration\/a-header-sent-twice-does-not-arrive-as-an-array\.test\.ts,\s*\/\/ which also shows why app\.inject cannot be used to check this: it joins\s*\/\/ without the space, and the result passes\./,
    );
    expect(body).toMatch(
      /export function readIdempotencyKey\(req: FastifyRequest\): IdempotencyHeader \{\s*const raw = req\.headers\['idempotency-key'\];\s*if \(raw === undefined\) return \{ kind: 'absent' \};/,
    );
    expect(body).toMatch(
      /const value = Array\.isArray\(raw\) \? raw\[0\] : raw;\s*if \(value === undefined\) return \{ kind: 'absent' \};\s*const trimmed = value\.trim\(\);\s*if \(trimmed\.length === 0\) return \{ kind: 'absent' \};\s*if \(trimmed\.length > 255\) return \{ kind: 'invalid' \};/,
    );
    expect(body).toMatch(
      /\/\/ Printable ASCII excluding space \(0x21-0x7e\)\. Whitespace inside\s*\/\/ the key is rejected — the customer-facing docs commit to this\.\s*if \(!\/\^\[\\x21-\\x7e\]\+\$\/\.test\(trimmed\)\) return \{ kind: 'invalid' \};/,
    );
    expect(body).toMatch(/return \{ kind: 'valid', key: trimmed \};/);
  });
});
