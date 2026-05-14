// W825 — cross-SDK BillingResource methods parity. One-hundred-
// fifty-first in the drift-guard series. Pins the BillingResource
// method set across all 3 SDKs. Billing surfaces the Stripe-mediated
// upgrade path (V-082) — drift would break W800 cross-SDK billing-
// flow example + customer self-serve subscribe + portal flow.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const TS = resolve(REPO_ROOT, 'packages/sdk-typescript/src/resources/billing.ts');
const PY = resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/resources/billing.py');
const GO = resolve(REPO_ROOT, 'packages/sdk-go/billing.go');

// 4 required method names. Each language uses idiomatic naming.
const REQUIRED_METHODS: Array<[string, string, string]> = [
  ['getState', 'get_state', 'GetState'],
  ['createCheckoutSession', 'create_checkout_session', 'CreateCheckoutSession'],
  ['startTrialPack', 'start_trial_pack', 'StartTrialPack'],
  ['createPortalSession', 'create_portal_session', 'CreatePortalSession'],
];

describe('W825 cross-SDK BillingResource methods parity', () => {
  it('all 3 BillingResource files exist at canonical paths', () => {
    expect(existsSync(TS)).toBe(true);
    expect(existsSync(PY)).toBe(true);
    expect(existsSync(GO)).toBe(true);
  });

  // ─── 4-required-method set ────────────────────────────────────

  it('CRITICAL all 4 BillingResource methods exist in all 3 SDKs — getState + createCheckoutSession + startTrialPack + createPortalSession. Drift would break W800 cross-SDK billing-flow example + customer self-serve subscribe + portal flow.', () => {
    const ts = read(TS);
    const py = read(PY);
    const go = read(GO);

    for (const [tsName, pyName, goName] of REQUIRED_METHODS) {
      expect(ts, `TS missing '${tsName}('`).toMatch(new RegExp(`\\b${tsName}\\s*\\(`));
      expect(py, `Python missing 'def ${pyName}('`).toMatch(new RegExp(`def ${pyName}\\(`));
      expect(go, `Go missing 'func (r *BillingResource) ${goName}('`).toMatch(
        new RegExp(`func \\(r \\*BillingResource\\) ${goName}\\(`),
      );
    }
  });

  // ─── TS strongly-typed responses ──────────────────────────────

  it('CRITICAL TS BillingResource methods return typed responses — GetBillingStateResponse + CreateCheckoutSessionResponse + StartTrialPackResponse + CreatePortalSessionResponse. Drift to dropping types would lose customer typeahead for billing surfaces.', () => {
    const p = read(TS);
    expect(p).toMatch(/getState\(\): Promise<GetBillingStateResponse>/);
    expect(p).toMatch(/createCheckoutSession\(/);
    expect(p).toMatch(
      /startTrialPack\(body: StartTrialPackRequest = \{\}\): Promise<StartTrialPackResponse>/,
    );
    expect(p).toMatch(/createPortalSession\(\): Promise<CreatePortalSessionResponse>/);
  });

  // ─── Go strongly-typed responses ──────────────────────────────

  it('CRITICAL Go BillingResource methods return typed pointer-+-error pairs. GetState → *GetBillingStateResponse + error; CreateCheckoutSession → *CreateCheckoutSessionResponse + error; StartTrialPack → *StartTrialPackResponse + error; CreatePortalSession → *CreatePortalSessionResponse + error.', () => {
    const p = read(GO);
    expect(p).toMatch(/GetState\(ctx context\.Context\) \(\*GetBillingStateResponse, error\)/);
    expect(p).toMatch(
      /CreateCheckoutSession\(ctx context\.Context, body \*CreateCheckoutSessionRequest\) \(\*CreateCheckoutSessionResponse, error\)/,
    );
    expect(p).toMatch(
      /StartTrialPack\(ctx context\.Context, body \*StartTrialPackRequest\) \(\*StartTrialPackResponse, error\)/,
    );
    expect(p).toMatch(
      /CreatePortalSession\(ctx context\.Context\) \(\*CreatePortalSessionResponse, error\)/,
    );
  });

  // ─── Python untyped-dict return (pending codegen) ─────────────

  it('CRITICAL Python BillingResource returns raw dict (untyped pending codegen pass — matches W824 profiles + W798 pagination duck-typing). All 4 methods return dict[str, Any].', () => {
    const p = read(PY);
    expect(p).toMatch(/def get_state\(self\) -> dict\[str, Any\]:/);
    expect(p).toMatch(
      /def create_checkout_session\(self, body: dict\[str, Any\]\) -> dict\[str, Any\]:/,
    );
    expect(p).toMatch(
      /def start_trial_pack\(self, body: dict\[str, Any\] \| None = None\) -> dict\[str, Any\]:/,
    );
    expect(p).toMatch(/def create_portal_session\(self\) -> dict\[str, Any\]:/);
  });

  // ─── Python sync + async dual ─────────────────────────────────

  it('CRITICAL Python provides BOTH BillingResource (sync) AND AsyncBillingResource (async) — every method has an async counterpart.', () => {
    const p = read(PY);
    for (const [, pyName] of REQUIRED_METHODS) {
      expect(p, `Python AsyncBillingResource missing 'async def ${pyName}'`).toMatch(
        new RegExp(`async def ${pyName}\\(`),
      );
    }
  });

  // ─── startTrialPack optional body cross-SDK ───────────────────

  it('CRITICAL startTrialPack accepts optional body cross-SDK. TS: StartTrialPackRequest = {} default; Python: dict | None = None; Go: *StartTrialPackRequest (nil OK). Drift to required body would break customers who want trial-pack defaults.', () => {
    expect(read(TS)).toMatch(/startTrialPack\(body: StartTrialPackRequest = \{\}\)/);
    expect(read(PY)).toMatch(/def start_trial_pack\(self, body: dict\[str, Any\] \| None = None\)/);
    expect(read(GO)).toMatch(
      /StartTrialPack\(ctx context\.Context, body \*StartTrialPackRequest\)/,
    );
  });

  // ─── Go ctx-first convention ──────────────────────────────────

  it('CRITICAL Go BillingResource methods all take ctx context.Context as first arg. Matches W822-W824 cross-SDK Go convention.', () => {
    const p = read(GO);
    for (const [, , goName] of REQUIRED_METHODS) {
      expect(p, `Go ${goName} must take ctx context.Context as first arg`).toMatch(
        new RegExp(`func \\(r \\*BillingResource\\) ${goName}\\(\\s*ctx context\\.Context`),
      );
    }
  });

  // ─── createCheckoutSession + createPortalSession imply the W800 flow ─

  it('CRITICAL the (getState → createCheckoutSession | createPortalSession) gate that W800 cross-SDK billing-flow example uses is wired through these resource methods. The 3-method cluster (getState + create both kinds of session) is the load-bearing customer-self-serve surface.', () => {
    const ts = read(TS);
    const py = read(PY);
    const go = read(GO);
    // All 3 SDKs MUST have all 3 methods of the W800 flow.
    expect(ts).toMatch(/getState\(/);
    expect(ts).toMatch(/createCheckoutSession\(/);
    expect(ts).toMatch(/createPortalSession\(/);
    expect(py).toMatch(/def get_state\(/);
    expect(py).toMatch(/def create_checkout_session\(/);
    expect(py).toMatch(/def create_portal_session\(/);
    expect(go).toMatch(/GetState\(/);
    expect(go).toMatch(/CreateCheckoutSession\(/);
    expect(go).toMatch(/CreatePortalSession\(/);
  });

  // ─── Python __init__ wiring ───────────────────────────────────

  it('CRITICAL Python BillingResource + AsyncBillingResource constructors take http client. Matches W822-W824 cross-SDK wiring.', () => {
    const p = read(PY);
    expect(p).toMatch(/def __init__\(self, http: HttpClient\) -> None:/);
    expect(p).toMatch(/def __init__\(self, http: AsyncHttpClient\) -> None:/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/sdk-billing-resource-cross-sdk-parity.test.ts'),
      ),
    ).toBe(true);
  });
});
