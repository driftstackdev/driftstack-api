// W471.B — drift guard for apps/gui-client/src/lib/use-crypto-checkout.ts.
// V-534.J useCryptoCheckout hook + V-534.AY idempotency-key
// auto-mint + V-534.AZ replayed-flag surfacing. Drift here
// either drops the V-534.AY idempotencyKeyRef pattern (a
// retry after network failure mints a new order instead of
// replaying the original — customer ends up with duplicate
// orders) or breaks the 'idempotent-replayed' header parse
// (the "restored from earlier attempt" notice never shows
// when it should).
//
//   • V-534.J framing pinned: 'Mints a CryptoOrder via POST
//     /v1/billing/crypto-checkout (V-666.C). Single-shot state
//     machine — idle → loading → (ready | error). The component
//     using the hook decides what to do with the returned
//     payment context (today: `provider: 'stub'` + null pay_
//     address; the view renders a "support will reach out"
//     notice).' + 'No SDK method yet — fetches the endpoint
//     directly using the baseUrl + apiKey from SettingsContext,
//     mirroring useAccountCost (V-534.H).'
//   • V-534.AY framing pinned: 'auto-sends an Idempotency-Key
//     (V-666.AO). The key is minted once per hook instance and
//     reused across retries (i.e. calling start() again after a
//     network failure replays the same order rather than minting
//     a second one). Calling reset() rotates the key so a fresh
//     checkout gets a fresh order.'
//   • V-534.AZ framing pinned: 'exposes `replayed: boolean` on
//     the ready state, sourced from the `Idempotent-Replayed`
//     response header. Views can show a subtle "restored from
//     your earlier attempt" notice when true.'
//   • newIdempotencyKey: crypto.randomUUID preferred + 'idem-'
//     prefix Date.now+Math.random fallback for environments
//     without crypto.randomUUID 'older test shims'.
//   • CryptoCheckoutResponse 9-field with provider 2-union
//     ('stub'|'nowpayments').
//   • UseCryptoCheckoutArgs 3-field (product + price_cents +
//     price_currency).
//   • CryptoCheckoutState 4-variant with ready{order, replayed}.
//   • idempotencyKeyRef: useRef<string>(newIdempotencyKey()) +
//     'idempotency-key' header lowercased.
//   • replayed = res.headers.get('idempotent-replayed') === '1'.
//   • reset: rotates idempotencyKeyRef.current + setState idle.

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

  it("V-534.J framing pinned: 'V-534.J — useCryptoCheckout hook.' + 'Mints a CryptoOrder via POST /v1/billing/crypto-checkout (V-666.C). Single-shot state machine — idle → loading → (ready | error). The component using the hook decides what to do with the returned payment context (today: `provider: 'stub'` + null pay_address; the view renders a \"support will reach out\" notice).' + 'No SDK method yet — fetches the endpoint directly using the baseUrl + apiKey from SettingsContext, mirroring useAccountCost (V-534.H).'", () => {
    expect(body).toMatch(/\/\/ V-534\.J — useCryptoCheckout hook\./);
    expect(body).toMatch(
      /\/\/ Mints a CryptoOrder via POST \/v1\/billing\/crypto-checkout \(V-666\.C\)\.\s*\n?\s*\/\/ Single-shot state machine — idle → loading → \(ready \| error\)\. The\s*\n?\s*\/\/ component using the hook decides what to do with the returned\s*\n?\s*\/\/ payment context \(today: `provider: 'stub'` \+ null pay_address; the\s*\n?\s*\/\/ view renders a "support will reach out" notice\)\./,
    );
    expect(body).toMatch(
      /\/\/ No SDK method yet — fetches the endpoint directly using the\s*\n?\s*\/\/ baseUrl \+ apiKey from SettingsContext, mirroring useAccountCost\s*\n?\s*\/\/ \(V-534\.H\)\./,
    );
  });

  it("V-534.AY framing pinned: 'auto-sends an Idempotency-Key (V-666.AO). The key is minted once per hook instance and reused across retries (i.e. calling start() again after a network failure replays the same order rather than minting a second one). Calling reset() rotates the key so a fresh checkout gets a fresh order.'", () => {
    expect(body).toMatch(
      /\/\/ V-534\.AY — auto-sends an Idempotency-Key \(V-666\.AO\)\. The key is\s*\n?\s*\/\/ minted once per hook instance and reused across retries \(i\.e\.\s*\n?\s*\/\/ calling start\(\) again after a network failure replays the same\s*\n?\s*\/\/ order rather than minting a second one\)\. Calling reset\(\) rotates\s*\n?\s*\/\/ the key so a fresh checkout gets a fresh order\./,
    );
  });

  it('V-534.AZ framing pinned: \'exposes `replayed: boolean` on the ready state, sourced from the `Idempotent-Replayed` response header. Views can show a subtle "restored from your earlier attempt" notice when true.\'', () => {
    expect(body).toMatch(
      /\/\/ V-534\.AZ — exposes `replayed: boolean` on the ready state, sourced\s*\n?\s*\/\/ from the `Idempotent-Replayed` response header\. Views can show a\s*\n?\s*\/\/ subtle "restored from your earlier attempt" notice when true\./,
    );
  });

  it("newIdempotencyKey: crypto.randomUUID preferred + 'idem-' prefix Date.now base36 + Math.random.toString(36).slice(2,12) fallback framing 'Fallback for environments without crypto.randomUUID (older test shims). Not cryptographic strength, just a unique-enough token.'", () => {
    expect(body).toMatch(
      /function newIdempotencyKey\(\): string \{\s*\n?\s*if \(typeof crypto !== 'undefined' && typeof crypto\.randomUUID === 'function'\) \{\s*\n?\s*return crypto\.randomUUID\(\);\s*\n?\s*\}\s*\n?\s*\/\/ Fallback for environments without crypto\.randomUUID \(older test\s*\n?\s*\/\/ shims\)\. Not cryptographic strength, just a unique-enough token\.\s*\n?\s*return `idem-\$\{Date\.now\(\)\.toString\(36\)\}-\$\{Math\.random\(\)\.toString\(36\)\.slice\(2, 12\)\}`;\s*\n?\s*\}/,
    );
  });

  it("CryptoCheckoutResponse 9-field with provider 2-union ('stub'|'nowpayments') + payment_address nullable + pay_currency nullable + UseCryptoCheckoutArgs 3-field (product + price_cents + price_currency)", () => {
    expect(body).toMatch(
      /export interface CryptoCheckoutResponse \{\s*\n?\s*order_id: string;\s*\n?\s*product: string;\s*\n?\s*price_cents: number;\s*\n?\s*price_currency: string;\s*\n?\s*status: string;\s*\n?\s*provider: 'stub' \| 'nowpayments';\s*\n?\s*payment_address: string \| null;\s*\n?\s*pay_currency: string \| null;\s*\n?\s*created_at: string;\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /export interface UseCryptoCheckoutArgs \{\s*\n?\s*product: string;\s*\n?\s*price_cents: number;\s*\n?\s*price_currency: string;\s*\n?\s*\}/,
    );
  });

  it('CryptoCheckoutState 4-variant union with ready{order: CryptoCheckoutResponse + replayed: boolean} — replayed exposed on ready state for V-534.AZ', () => {
    expect(body).toMatch(
      /export type CryptoCheckoutState =\s*\n?\s*\| \{ kind: 'idle' \}\s*\n?\s*\| \{ kind: 'loading' \}\s*\n?\s*\| \{ kind: 'ready'; order: CryptoCheckoutResponse; replayed: boolean \}\s*\n?\s*\| \{ kind: 'error'; message: string \};/,
    );
  });

  it('idempotencyKeyRef + lowercased header + bounded response parsing + replayed header literal check', () => {
    expect(body).toMatch(/const idempotencyKeyRef = useRef<string>\(newIdempotencyKey\(\)\);/);
    expect(body).toMatch(
      /'idempotency-key': idempotencyKeyRef\.current,\s*\n?\s*\},\s*\n?\s*body: JSON\.stringify\(args\),/,
    );
    expect(body).toMatch(
      /const order = await readBoundedApiJson<CryptoCheckoutResponse>\(res\);\s*\n?\s*const replayed = res\.headers\.get\('idempotent-replayed'\) === '1';\s*\n?\s*if \(sequence === sequenceRef\.current\) setState\(\{ kind: 'ready', order, replayed \}\);/,
    );
    expect(body).toMatch(/import \{ readBoundedApiJson \} from '\.\/read-bounded-json';/);
    expect(body).not.toMatch(/\bres\.json\(\)/);
    expect(body).toMatch(/fetchWithDeadline\(`\$\{baseUrl\}\/v1\/billing\/crypto-checkout`, \{/);
    expect(body).toMatch(/signal: controller\.signal/);
    expect(body).toMatch(/if \(inFlightRef\.current\) return;/);
  });

  it("reset: rotates idempotencyKeyRef.current = newIdempotencyKey() + setState({kind:'idle'}) + empty useCallback deps (idempotencyKeyRef is ref, no dep needed)", () => {
    expect(body).toMatch(
      /const reset = useCallback\(\(\) => \{[\s\S]*?requestRef\.current\?\.abort\(\);[\s\S]*?idempotencyKeyRef\.current = newIdempotencyKey\(\);\s*\n?\s*setState\(\{ kind: 'idle' \}\);\s*\n?\s*\}, \[\]\);/,
    );
    expect(body).toMatch(/useEffect\([\s\S]*?requestRef\.current\?\.abort\(\);/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
