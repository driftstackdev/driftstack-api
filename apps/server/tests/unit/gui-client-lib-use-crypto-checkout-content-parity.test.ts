// W471.B — drift guard for apps/gui-client/src/lib/use-crypto-checkout.ts.
// V-534.J useCryptoCheckout hook + V-534.AY idempotency-key
// auto-mint + V-534.AZ replayed-flag surfacing. Drift here
// either drops the V-534.AY captured-attempt replay contract (an
// uncertain response can be dismissed into a fresh order) or
// breaks the 'idempotent-replayed' header parse
// (the "restored from earlier attempt" notice never shows
// when it should).
//
//   • V-534.J framing pinned: 'Mints a CryptoOrder via POST
//     /v1/billing/crypto-checkout (V-666.C). Single-shot state
//     machine — idle → loading → (ready | error |
//     outcome_unknown). The component
//     using the hook decides what to do with the returned
//     payment context (today: `provider: 'stub'` + null pay_
//     address; the view renders a "support will reach out"
//     notice).' + 'No SDK method yet — fetches the endpoint
//     directly using the baseUrl + apiKey from SettingsContext,
//     mirroring useAccountCost (V-534.H).'
//   • V-534.AY framing pinned: 'auto-sends an Idempotency-Key
//     (V-666.AO). A dispatched request captures its exact key,
//     body, endpoint, and credential. Ambiguous delivery is
//     resolved only by retry() replaying that captured request;
//     reset cannot rotate the key until the outcome is known.'
//   • V-534.AZ framing pinned: 'exposes `replayed: boolean` on
//     the ready state, sourced from the `Idempotent-Replayed`
//     response header. Views can show a subtle "restored from
//     your earlier attempt" notice when true.'
//   • newIdempotencyKey: crypto.randomUUID preferred + 'idem-'
//     prefix Date.now+Math.random fallback for environments
//     without crypto.randomUUID 'older test shims'.
//   • CryptoCheckoutResponse 10-field with provider 2-union
//     ('stub'|'nowpayments').
//   • UseCryptoCheckoutArgs 3-field (product + price_cents +
//     price_currency).
//   • CryptoCheckoutState 5-variant with ready{order, replayed}
//     and outcome_unknown{message,retryable}.
//   • captured attempt owns exact key/body/endpoint/credential;
//     one process-memory account/deployment owner survives view
//     remounts, expires the credential at 23 hours, and publishes
//     owner results to every current observer.
//   • replayed = res.headers.get('idempotent-replayed') === '1'.
//   • reset is blocked while loading/outcome_unknown; otherwise
//     it rotates idempotencyKeyRef.current + commits idle.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/gui-client/src/lib/use-crypto-checkout.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W471.B apps/gui-client/src/lib/use-crypto-checkout.ts content parity', () => {
  const body = read(LIB);

  it('V-534.J framing pins the outcome-unknown state and direct endpoint', () => {
    expect(body).toMatch(/\/\/ V-534\.J — useCryptoCheckout hook\./);
    expect(body).toMatch(
      /\/\/ Mints a CryptoOrder via POST \/v1\/billing\/crypto-checkout \(V-666\.C\)\.\s*\/\/ Single-shot state machine — idle → loading → \(ready \| error \|\s*\/\/ outcome_unknown\)\./,
    );
    expect(body).toMatch(
      /\/\/ No SDK method yet — fetches the endpoint directly using the\s*\/\/ baseUrl \+ apiKey from SettingsContext, mirroring useAccountCost\s*\/\/ \(V-534\.H\)\./,
    );
  });

  it('V-534.AY framing pins exact dispatched-request replay and blocks reset while unknown', () => {
    expect(body).toMatch(
      /\/\/ V-534\.AY — auto-sends an Idempotency-Key \(V-666\.AO\)\. A dispatched\s*\/\/ request captures its exact key, body, endpoint, and credential\. If\s*\/\/ delivery succeeds but the response is lost or cannot be trusted,\s*\/\/ retry\(\) replays that exact request rather than minting a second\s*\/\/ order\. reset\(\) is deliberately unavailable while the outcome is\s*\/\/ unknown/,
    );
  });

  it('V-534.AZ framing pinned: \'exposes `replayed: boolean` on the ready state, sourced from the `Idempotent-Replayed` response header. Views can show a subtle "restored from your earlier attempt" notice when true.\'', () => {
    expect(body).toMatch(
      /\/\/ V-534\.AZ — exposes `replayed: boolean` on the ready state, sourced\s*\/\/ from the `Idempotent-Replayed` response header\. Views can show a\s*\/\/ subtle "restored from your earlier attempt" notice when true\./,
    );
  });

  it("newIdempotencyKey: crypto.randomUUID preferred + 'idem-' prefix Date.now base36 + Math.random.toString(36).slice(2,12) fallback framing 'Fallback for environments without crypto.randomUUID (older test shims). Not cryptographic strength, just a unique-enough token.'", () => {
    expect(body).toMatch(
      /function newIdempotencyKey\(\): string \{\s*if \(typeof crypto !== 'undefined' && typeof crypto\.randomUUID === 'function'\) \{\s*return crypto\.randomUUID\(\);\s*\}\s*\/\/ Fallback for environments without crypto\.randomUUID \(older test\s*\/\/ shims\)\. Not cryptographic strength, just a unique-enough token\.\s*return `idem-\$\{Date\.now\(\)\.toString\(36\)\}-\$\{Math\.random\(\)\.toString\(36\)\.slice\(2, 12\)\}`;\s*\}/,
    );
  });

  it('CryptoCheckoutResponse matches the 10-field public envelope including status union and pay_amount', () => {
    expect(body).toMatch(
      /export interface CryptoCheckoutResponse \{\s*order_id: string;\s*product: string;\s*price_cents: number;\s*price_currency: string;\s*status: 'pending' \| 'confirming' \| 'paid' \| 'failed' \| 'partial' \| 'cancelled';\s*provider: 'stub' \| 'nowpayments';\s*payment_address: string \| null;\s*pay_currency: string \| null;\s*pay_amount: number \| null;\s*created_at: string;/,
    );
    expect(body).toMatch(
      /export interface UseCryptoCheckoutArgs \{\s*product: string;\s*price_cents: number;\s*price_currency: string;\s*\}/,
    );
  });

  it('CryptoCheckoutState exposes outcome_unknown and a zero-argument retry', () => {
    expect(body).toMatch(
      /\| \{ kind: 'error'; message: string \}\s*\| \{ kind: 'outcome_unknown'; message: string; retryable: boolean \};/,
    );
    expect(body).toContain('retry: () => Promise<void>;');
  });

  it('captures and replays exact endpoint, credential, body, and key; accepted bodies are decoded before ready', () => {
    expect(body).toContain('initialAttemptRef.current?.idempotencyKey ?? newIdempotencyKey()');
    expect(body).toContain("'idempotency-key': attempt.idempotencyKey");
    expect(body).toContain('authorization: `Bearer ${attempt.apiKey}`');
    expect(body).toContain('body: attempt.body');
    expect(body).toContain('`${attempt.baseUrl}/v1/billing/crypto-checkout`');
    expect(body).toContain('const rawOrder = await readBoundedApiJson<unknown>(res);');
    expect(body).toContain('const order = decodeCryptoCheckoutResponse(rawOrder, attempt.args);');
    expect(body).toContain("res.headers.get('idempotent-replayed') === '1'");
    expect(body).toMatch(/import \{ readBoundedApiJson \} from '\.\/read-bounded-json';/);
    expect(body).not.toMatch(/\bres\.json\(\)/);
    expect(body).toMatch(/signal: controller\.signal/);
    expect(body).toContain("redirect: 'error'");
    expect(body).toMatch(
      /if \(inFlightRef\.current \|\| attempt\.inFlight \|\| attempt\.apiKey === null\) return;/,
    );
    expect(body).toContain('!attempt.ambiguous && isDefinitiveInitialRejectionStatus(res.status)');
    expect(body).toContain('if (definitiveInitialRejection)');
  });

  it('retry is exact-only and single-flight; reset cannot rotate during loading or outcome_unknown', () => {
    expect(body).toContain("stateKindRef.current !== 'outcome_unknown'");
    expect(body).toContain('if (attempt.retryPromise !== null)');
    expect(body).toContain('attempt.retryPromise = retryPromise;');
    expect(body).toContain(
      'if (attempt.retryPromise === retryPromise) attempt.retryPromise = null;',
    );
    expect(body).toContain('await dispatch(attempt);');
    expect(body).toContain(
      "if (stateKindRef.current === 'loading' || stateKindRef.current === 'outcome_unknown') return;",
    );
    expect(body).toContain('idempotencyKeyRef.current = newIdempotencyKey();');
    expect(body).toContain("commitState({ kind: 'idle' });");
    expect(body).toMatch(/useEffect\([\s\S]*?requestRef\.current\?\.controller\.abort\(\);/);
  });

  it('pins bounded remount recovery, exact dispatch ownership, observer reconciliation, and timed secret expiry', () => {
    expect(body).toContain('const CRYPTO_CHECKOUT_REPLAY_WINDOW_MS = 23 * 60 * 60 * 1000;');
    expect(body).toContain('const MAX_RECOVERABLE_CHECKOUTS = 8;');
    expect(body).toContain(
      'const recoverableCheckouts = new Map<string, CryptoCheckoutAttempt>();',
    );
    expect(body).toContain('const recoverableCheckoutListeners = new Map<');
    expect(body).toContain("const owner = Symbol('crypto-checkout-dispatch');");
    expect(body).toContain('const requestArgs = Object.freeze({ ...args });');
    expect(body).toContain('lockedArgs: Readonly<UseCryptoCheckoutArgs> | null;');
    expect(body).toContain('previous.dispatchOwner === activeRequest.owner');
    expect(body).toContain('attempt.dispatchOwner === activeRequest.owner');
    expect(body).toContain('const originalOwner = attempt.inFlightPromise;');
    expect(body).toContain('if (originalOwner !== null) await originalOwner;');
    expect(body).toContain('armAttemptExpiryTimer(attempt);');
    expect(body).toContain('attempt.apiKey = null;');
    expect(body).toContain('const unsubscribe = subscribeToRecoverableAttempt');
    expect(body).toContain(
      'const snapshot = recoverableCheckouts.get(currentScopeKey) ?? attemptRef.current;',
    );
    expect(body).toContain("if (attempt.resolution.kind !== 'ready') continue;");
    expect(body).not.toMatch(/localStorage|sessionStorage|indexedDB|invoke\(/);
  });

  it('accepts contract-null NowPayments instructions but rejects unsafe partial scalar values', () => {
    expect(body).toMatch(
      /value\.provider === 'nowpayments'[\s\S]*?value\.payment_address === null[\s\S]*?value\.pay_currency === null[\s\S]*?value\.pay_amount === null/,
    );
    expect(body).toContain('value.pay_amount >= MIN_CRYPTO_PAYMENT_AMOUNT');
    expect(body).toContain('value.payment_address.length <= MAX_PAYMENT_ADDRESS_LENGTH');
    expect(body).toContain('value.pay_currency.length <= MAX_PAY_CURRENCY_LENGTH');
    expect(body).toContain('!/^ord_[0-9a-f]{12}$/.test(value.order_id)');
    expect(body).toContain('value.payment_address === value.payment_address.trim()');
    expect(body).toContain('value.pay_currency === value.pay_currency.trim()');
    expect(body).toContain('/^[\\x21-\\x7e]+$/.test(value.payment_address)');
    expect(body).toContain('/^[A-Za-z0-9._-]+$/.test(value.pay_currency)');
    expect(body).toContain('new Date(value.created_at).toISOString() !== value.created_at');
  });

  it('fences prior account/deployment state synchronously before passive scope cleanup', () => {
    expect(body).toContain('scopeRef.current === currentScopeKey');
    expect(body).toContain('attemptRef.current.scopeKey === currentScopeKey');
    expect(body).toContain('const visibleState: CryptoCheckoutState =');
    expect(body).toContain(
      'return { state: visibleState, lockedArgs: visibleAttempt?.args ?? null, start, retry, reset };',
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
