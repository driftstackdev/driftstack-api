// W473.A — drift guard for apps/gui-client/src/lib/use-crypto-quote.ts.
// V-534.V useCryptoQuote hook. Drift here either drops the
// `product: null → idle` short-circuit (a placeholder mount fires
// a request with product='null' and trips the V-666.H validator —
// shows an error in the pricing widget before the user has even
// picked a tier) or breaks the priceCurrency optional body field
// (currency override never reaches the server — every quote
// silently defaults to EUR even when the view asked for USD).
//
//   • V-534.V framing pinned: 'useCryptoQuote hook.' + 'Wraps POST
//     /v1/billing/crypto-checkout/quote (V-666.H) for the GUI
//     checkout flow. Given a tier product + optional fiat currency,
//     returns the price preview without minting an order. Re-fetches
//     automatically when product or currency changes; supports manual
//     mode for views that want to gate the request behind a button.'
//   • CryptoQuoteData exact 3-field pricing response (product +
//     price_cents + price_currency).
//   • UseCryptoQuoteOpts: product null-gateable + priceCurrency
//     optional + manual? optional.
//   • product===null short-circuit on both initial state and inside
//     fetcher + useEffect.
//   • POST body conditionally adds price_currency only when
//     priceCurrency !== undefined.
//   • useCallback deps [opts.product, opts.priceCurrency, settings.
//     apiKey, settings.baseUrl] — currency in deps so override
//     changes refetch.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/gui-client/src/lib/use-crypto-quote.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W473.A apps/gui-client/src/lib/use-crypto-quote.ts content parity', () => {
  const body = read(LIB);

  it("V-534.V framing pinned: 'V-534.V — useCryptoQuote hook.' + 'Wraps POST /v1/billing/crypto-checkout/quote (V-666.H) for the GUI checkout flow. Given a tier product + optional fiat currency, returns the price preview without minting an order. Re-fetches automatically when product or currency changes; supports manual mode for views that want to gate the request behind a button.'", () => {
    expect(body).toMatch(/\/\/ V-534\.V — useCryptoQuote hook\./);
    expect(body).toMatch(
      /\/\/ Wraps POST \/v1\/billing\/crypto-checkout\/quote \(V-666\.H\) for the GUI\s*\/\/ checkout flow\. Given a tier product \+ optional fiat currency, returns\s*\/\/ the price preview without minting an order\. Re-fetches automatically\s*\/\/ when product or currency changes; supports manual mode for views that\s*\/\/ want to gate the request behind a button\./,
    );
  });

  it('CryptoQuoteData exact pricing-only shape (product + price_cents + price_currency)', () => {
    expect(body).toMatch(
      /export interface CryptoQuoteData \{\s*product: string;\s*price_cents: number;\s*price_currency: string;\s*\}/,
    );
    expect(body).not.toMatch(/pay_min_amount|pay_max_amount|provider: string/);
  });

  it("CryptoQuoteState 4-variant union + UseCryptoQuoteOpts: product 'Tier product to quote. null = no fetch; result stays idle.' + priceCurrency? 'Defaults to the server's EUR.' + manual? 'Disable auto-fetch on mount + on dependency change. Default false.'", () => {
    expect(body).toMatch(
      /export type CryptoQuoteState =\s*\| \{ kind: 'idle' \}\s*\| \{ kind: 'loading' \}\s*\| \{ kind: 'ready'; data: CryptoQuoteData \}\s*\| \{ kind: 'error'; message: string \};/,
    );
    expect(body).toMatch(
      /export interface UseCryptoQuoteOpts \{\s*\/\*\* Tier product to quote\. null = no fetch; result stays idle\. \*\/\s*product: string \| null;\s*\/\*\* Optional fiat currency override\. Defaults to the server's EUR\. \*\/\s*priceCurrency\?: string;\s*\/\*\* Disable auto-fetch on mount \+ on dependency change\. Default false\. \*\/\s*manual\?: boolean;\s*\}/,
    );
  });

  it('product===null short-circuit: initial state guards on manual||product===null + fetcher early-return setState idle + useEffect skips both manual and null product', () => {
    expect(body).toMatch(
      /const \[state, setState\] = useState<CryptoQuoteState>\(\s*opts\.manual === true \|\| opts\.product === null \? \{ kind: 'idle' \} : \{ kind: 'loading' \},\s*\);/,
    );
    expect(body).toMatch(
      /if \(opts\.product === null\) \{\s*setState\(\{ kind: 'idle' \}\);\s*return;\s*\}/,
    );
    expect(body).toMatch(
      /useEffect\(\(\) => \{\s*if \(opts\.manual === true\) return;\s*if \(opts\.product === null\) return;\s*void fetcher\(\);\s*\}, \[fetcher, opts\.manual, opts\.product\]\);/,
    );
  });

  it('POST body conditional price_currency: body Record<string,string> seeded with product + only sets body.price_currency when priceCurrency !== undefined (so undefined override never sends an empty currency field that would trip the V-666.H validator)', () => {
    expect(body).toMatch(
      /const body: Record<string, string> = \{ product: opts\.product \};\s*if \(opts\.priceCurrency !== undefined\) \{\s*body\.price_currency = opts\.priceCurrency;\s*\}/,
    );
  });

  it('Fetch shape: POST `${baseUrl}/v1/billing/crypto-checkout/quote` exact + 3-header (authorization Bearer + accept application/json + content-type application/json) + body JSON.stringify(body); useCallback deps [opts.product, opts.priceCurrency, settings.apiKey, settings.baseUrl]', () => {
    expect(body).toMatch(
      /const res = await fetchWithDeadline\(`\$\{baseUrl\}\/v1\/billing\/crypto-checkout\/quote`, \{\s*method: 'POST',\s*signal: controller\.signal,\s*headers: \{\s*authorization: `Bearer \$\{settings\.apiKey\}`,\s*accept: 'application\/json',\s*'content-type': 'application\/json',\s*\},\s*body: JSON\.stringify\(body\),\s*\}\);/,
    );
    expect(body).toMatch(/requestRef\.current\?\.abort\(\);/);
    expect(body).toMatch(
      /if \(sequence === sequenceRef\.current\) setState\(\{ kind: 'ready', data: parsed \}\);/,
    );
    expect(body).toMatch(
      /\}, \[opts\.product, opts\.priceCurrency, settings\.apiKey, settings\.baseUrl\]\);/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
