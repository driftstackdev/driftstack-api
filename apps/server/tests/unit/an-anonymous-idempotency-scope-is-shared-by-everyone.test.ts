// V-1606 — `_anon` is one idempotency scope shared by every caller in it.
//
// `CryptoOrdersService.createIdempotent` scopes a client-supplied key by account:
//
//   const scopeKey = `${args.account_id ?? '_anon'}:${args.idempotency_key}`;
//
// That fallback is why the DB unique index can be global. `crypto_orders` carries
// `uniqueIndex('crypto_orders_idempotency_key_unique').on(idempotencyKey)` with no
// account column, unlike its two siblings — `agent_sessions` and
// `session_operations` are both `(accountId, key)`. The index is nonetheless
// correct, because the VALUE stored in that column is already account-scoped.
// Checked before writing this file, because an index on a bare key would have
// read as a cross-account collision and it is not one.
//
// The fallback is the part with a future in it. Every caller with a null
// `account_id` lands in ONE scope named `_anon`, so two of them choosing the same
// idempotency key collide: the second is answered with the first's order as a
// replay. Idempotency keys are client-chosen, and a client that picks something
// like `checkout-1` is not exotic.
//
// It is unreachable today. The only call site is `routes/billing-crypto.ts`,
// behind `requireAuth` + `requireScope('admin:billing')`, passing
// `account_id: ctx.account.id`. So `_anon` is dead — but `schema.ts` says the
// anonymous flow is intended ("Nullable for pre-signup checkouts (V-666 supports
// anonymous flow → claim on signup)"), which is exactly the change that would
// bring it to life without anyone re-deriving what the shared scope means.
//
// This file fails on that change rather than after it.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '..', '..', 'src');
const ROUTES = resolve(SRC, 'routes');
const SERVICE = resolve(SRC, 'services', 'crypto-orders.ts');

/** Cut `//` to end of line, leaving string literals alone. */
function codeOf(src: string): string {
  return src
    .split('\n')
    .map((line) => {
      let quote: string | null = null;
      let out = '';
      for (let i = 0; i < line.length; i += 1) {
        const ch = line[i] as string;
        if (quote !== null) {
          out += ch;
          if (ch === quote && line[i - 1] !== '\\') quote = null;
          continue;
        }
        if (ch === '"' || ch === "'" || ch === '`') {
          quote = ch;
          out += ch;
          continue;
        }
        if (ch === '/' && line[i + 1] === '/') break;
        out += ch;
      }
      return out;
    })
    .join('\n');
}

/** The `account_id:` argument each caller hands to createIdempotent. */
function callerAccountArguments(): Array<{ file: string; arg: string }> {
  const out: Array<{ file: string; arg: string }> = [];
  for (const name of readdirSync(ROUTES).filter((f) => f.endsWith('.ts'))) {
    const code = codeOf(readFileSync(resolve(ROUTES, name), 'utf8'));
    for (const m of code.matchAll(/createIdempotent\(\{([\s\S]{0,400}?)\}\)/g)) {
      const arg = /account_id:\s*([^,\n]+)/.exec(m[1] ?? '');
      out.push({ file: name, arg: (arg?.[1] ?? '(absent)').trim() });
    }
  }
  return out;
}

describe('an anonymous idempotency scope is shared by everyone', () => {
  it('CRITICAL the constructs this file reasons about still exist. The `_anon` fallback is the hazard and the call site is what keeps it dead — if either moved, the assertions below would pass while guarding nothing.', () => {
    const service = codeOf(readFileSync(SERVICE, 'utf8'));
    expect(
      /account_id \?\? '_anon'/.test(service),
      'the scope fallback moved — re-read what replaces it before trusting this file',
    ).toBe(true);
    expect(
      callerAccountArguments().length,
      'no createIdempotent caller found in the routes tree',
    ).toBeGreaterThanOrEqual(1);
  });

  it("CRITICAL every caller supplies a real account, so nothing lands in the shared `_anon` scope. Two callers in that scope choosing the same client-chosen key collide, and the second is answered with the first caller's order — a cross-caller read, not a duplicate write.", () => {
    const anonymous = callerAccountArguments().filter(
      (c) => !/^ctx\.account\.id$|^effective\w*\.accountId$|account\.id$/.test(c.arg),
    );
    expect(
      anonymous.map((c) => `${c.file} account_id: ${c.arg}`),
      'these can reach the shared anonymous scope; give them their own or key it per caller',
    ).toEqual([]);
  });
});
