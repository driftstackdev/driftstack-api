// V-1654 — one `await` carries the derived-identity property of the entire
// Stripe integration, and nothing said so.
//
// Every inbound Stripe webhook resolves the account through
// `findAccountIdFromCustomerOrRef({ stripeCustomerId, clientReferenceId: null })`
// — a lookup on a column WE wrote, rather than trusting anything in the
// payload. That only works because the column is already there when the event
// arrives, and the reason it is already there is a single ordering inside
// `ensureCustomerId`:
//
//     const customerId = await this.provider.ensureCustomer(...);
//     await this.repo.setStripeCustomerId({ accountId, customerId });   // <- this
//     return customerId;
//
// The persist is awaited BEFORE the id is handed to the caller that opens the
// Checkout Session. Make it fire-and-forget — `void this.repo.setStripe…`, or
// move it after the return path, or start the checkout in parallel with
// `Promise.all` — and the account row can still be missing its customer id when
// `customer.subscription.created` arrives. The resolver then returns null, the
// handler logs "unknown customer; ignoring", and a paying customer silently does
// not get their tier.
//
// ⛔ NOTHING WOULD FAIL AT THE TIME OF THE REFACTOR. The unit tests stub the
// repo, the ordering is invisible to types, and the damage appears later as a
// webhook that ignored a real payment. That is the definition of a property that
// needs a guard rather than a comment: correct today, silently reversible, and
// expensive when reversed.
//
// This does NOT re-test what the billing tests already cover (that a customer is
// created, that the id is stored). It pins the ORDER.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const BILLING = resolve(REPO_ROOT, 'apps/server/src/services/billing.ts');

/**
 * The body of one method, and ONLY that method.
 *
 * ⚠️ Anchored deliberately, and the FIRST version of this was wrong in the way
 * this whole file is about. It ended the body at the first `\n  }` — which is
 * also how a multi-line PARAMETER OBJECT TYPE closes:
 *
 *     async createCheckoutSession(args: {
 *       accountId: string;
 *       …
 *     }): Promise<…> {          <- `\n  }` matches HERE, not at the body end
 *
 * so the extracted "body" was the signature, `indexOf('ensureCustomerId')`
 * returned -1, and the arm failed on an unmutated tree. ⛔ The baseline run is
 * what caught it: the mutations all behaved, and reading only those would have
 * shipped an arm that could never pass. A guard must be run UNMUTATED first.
 *
 * ⛔ AND THE FIX WAS WRONG TWICE MORE, each time one construct further right.
 * Walking parentheses past the parameter list lands on the RETURN TYPE, and a
 * generic return type has braces too — `Promise<{ url: string; … }>` — so the
 * body came out as 34 characters of type literal. It now tracks angle depth
 * and takes the first brace outside every `<…>`.
 *
 * ⭐ Three boundary errors in one small function, and the BASELINE caught all
 * three. Every mutation behaved correctly throughout. A mutation proves an arm
 * CAN fail; only the unmutated run proves it can PASS.
 */
function methodBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  if (start < 0) throw new Error(`method not found: ${signature}`);

  // 1. Walk the parameter list to its closing paren.
  let i = source.indexOf('(', start);
  let depth = 0;
  for (; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  // 2. Skip the RETURN TYPE to reach the body brace. A generic return type
  //    carries braces of its own — `Promise<{ url: string; sessionId: string }>`
  //    — so the first `{` after the parameter list is NOT the body. Track angle
  //    depth and take the first brace that sits outside every `<…>`.
  let angle = 0;
  let bodyOpen = -1;
  for (let k = i + 1; k < source.length; k += 1) {
    const ch = source[k];
    if (ch === '<') angle += 1;
    else if (ch === '>') angle = Math.max(0, angle - 1);
    else if (ch === '{' && angle === 0) {
      bodyOpen = k;
      break;
    }
  }
  if (bodyOpen < 0) throw new Error(`method body not delimited: ${signature}`);

  // 3. Walk braces to the matching close.
  depth = 0;
  for (let j = bodyOpen; j < source.length; j += 1) {
    const ch = source[j];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(bodyOpen, j + 1);
    }
  }
  throw new Error(`method body not delimited: ${signature}`);
}

describe('V-1654 a derived identity must be persisted before it is used', () => {
  it('CRITICAL POSITIVE CONTROL the body reader isolates one method, so the assertions below cannot be satisfied by a different one', () => {
    const src = readFileSync(BILLING, 'utf8');
    const body = methodBody(src, 'private async ensureCustomerId(');

    expect(body, 'the reader found a real body').toContain('ensureCustomer');
    // A neighbouring method's distinctive text must NOT be inside this body.
    expect(body, 'the body stops before the next method').not.toContain('pause invoice collection');
    expect(() => methodBody(src, 'private async noSuchMethod(')).toThrow(/method not found/);
  });

  it('CRITICAL ensureCustomerId AWAITS the persist before returning the id. Every Stripe webhook resolves the account through accounts.stripe_customer_id, so an unawaited or post-return persist means a real subscription event can arrive before the column exists and be ignored as an unknown customer.', () => {
    const body = methodBody(readFileSync(BILLING, 'utf8'), 'private async ensureCustomerId(');

    const persist = body.indexOf('setStripeCustomerId');
    const ret = body.lastIndexOf('return customerId');
    expect(persist, 'the persist call is present').toBeGreaterThan(-1);
    expect(ret, 'the id is returned to the caller').toBeGreaterThan(-1);
    expect(persist, 'the persist happens BEFORE the id is handed out').toBeLessThan(ret);

    // ...and it is awaited, not fired and forgotten.
    const line = body.slice(body.lastIndexOf('\n', persist) + 1, body.indexOf('\n', persist));
    expect(line.trim(), 'the persist is awaited').toMatch(/^await\b/);
    expect(line, 'the persist is not voided into a floating promise').not.toMatch(/\bvoid\s/);
  });

  it('CRITICAL the checkout session is opened only AFTER ensureCustomerId resolves — not raced with it, which would reintroduce the same window', () => {
    const body = methodBody(readFileSync(BILLING, 'utf8'), 'async createCheckoutSession(');

    const ensure = body.indexOf('ensureCustomerId');
    const checkout = body.indexOf('createSubscriptionCheckout');
    expect(ensure, 'the checkout path ensures a customer').toBeGreaterThan(-1);
    expect(checkout, 'the checkout path opens a session').toBeGreaterThan(-1);
    expect(ensure, 'the customer is ensured before the session is opened').toBeLessThan(checkout);
    expect(
      body.slice(body.lastIndexOf('\n', ensure) + 1, body.indexOf('\n', ensure)).trim(),
      'ensureCustomerId is awaited rather than raced',
    ).toMatch(/^const\s+customerId\s*=\s*await\b/);
  });

  it('CRITICAL every Stripe webhook still resolves the account from the column we wrote, never from the payload id. If a caller ever passes clientReferenceId the derived source stops winning, and the two are not cross-checked.', () => {
    const hooks = readFileSync(
      resolve(REPO_ROOT, 'apps/server/src/services/stripe-webhooks.ts'),
      'utf8',
    );
    const calls = [...hooks.matchAll(/findAccountIdFromCustomerOrRef\(\{([\s\S]{0,120}?)\}\)/g)];
    expect(calls.length, 'the resolver is actually called').toBeGreaterThan(0);
    for (const call of calls) {
      expect(call[1], 'resolves by the column we wrote').toContain('stripeCustomerId');
      expect(call[1], 'does not trust the round-tripped payload id').toMatch(
        /clientReferenceId:\s*null/,
      );
    }
  });
});
