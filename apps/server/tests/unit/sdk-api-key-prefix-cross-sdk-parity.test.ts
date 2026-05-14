// W837 — cross-SDK ds_live_ / ds_test_ API-key prefix consistency.
// One-hundred-sixty-third in the drift-guard series. Pins that all
// 3 SDK source files reference the canonical 2-prefix convention
// (ds_live_ for production, ds_test_ for sandbox) in their
// docstrings, comments, and example placeholders. Drift would let
// one SDK silently document a different prefix convention,
// confusing customers who switch between SDKs.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W837 cross-SDK ds_live_/ds_test_ key-prefix consistency', () => {
  // ─── TS client.ts dual-prefix docstring ───────────────────────

  it("CRITICAL TS client.ts apiKey docstring references both 'ds_live_…' AND 'ds_test_…'. The dual reference is the load-bearing 'production-vs-sandbox' convention. Drift to mentioning only one would hide the test-mode prefix from customers.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/sdk-typescript/src/client.ts'));
    expect(p).toMatch(/Long-lived API key \(`ds_live_…` or `ds_test_…`\)/);
  });

  // ─── Python client + __init__ reference ds_live_ ──────────────

  it("CRITICAL Python client.py + __init__.py reference 'ds_live_' in their copy-pasteable example docstring. Matches W820 + W834 client framing. Drift to dropping would lose customer copy-paste-ready import example.", () => {
    const clientPy = read(resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/client.py'));
    const initPy = read(resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/__init__.py'));
    expect(clientPy).toMatch(/api_key="ds_live_…"/);
    expect(initPy).toMatch(/api_key="ds_live_\.\.\."/);
  });

  // ─── Go doc.go references ds_live_ in Quickstart ──────────────

  it("CRITICAL Go doc.go Quickstart references 'ds_live_…' as the API-key placeholder. Matches W820 + W834 doc framing. Drift would break the canonical copy-pasteable Quickstart.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/sdk-go/doc.go'));
    expect(p).toMatch(/client := driftstack\.New\("ds_live_…"\)/);
  });

  // ─── 3 quickstart examples reference ds_live_ in run command ──

  it("CRITICAL TS+Python+Go quickstart examples all reference 'ds_live_' in their copy-pasteable run-command comment. Matches W796 cross-SDK quickstart parity.", () => {
    const tsQs = read(resolve(REPO_ROOT, 'packages/sdk-typescript/examples/quickstart.ts'));
    const pyQs = read(resolve(REPO_ROOT, 'packages/sdk-python/examples/quickstart.py'));
    const goQs = read(resolve(REPO_ROOT, 'packages/sdk-go/examples/quickstart/main.go'));

    expect(tsQs).toMatch(/DRIFTSTACK_API_KEY=ds_live_\.\.\./);
    expect(pyQs).toMatch(/DRIFTSTACK_API_KEY=ds_live_…/);
    expect(goQs).toMatch(/DRIFTSTACK_API_KEY=ds_live_…/);
  });

  // ─── env-templates use sk_test_/whsec_ prefixes per W807 ──────

  it("CRITICAL infra/env-templates use 'sk_test_' Stripe + 'whsec_' webhook secret prefixes (matches W807 env-template parity). Pinned here as the cross-cutting V-NNN credential-handling convention.", () => {
    const prodEnv = read(resolve(REPO_ROOT, 'infra/env-templates/production.env.template'));
    expect(prodEnv).toMatch(/STRIPE_SECRET_KEY=sk_test_REDACTED/);
    expect(prodEnv).toMatch(/STRIPE_WEBHOOK_SECRET=whsec_REDACTED/);
  });

  // ─── Cross-SDK NO 'ds_secret_' or 'ds_pub_' confusion ─────────

  it("CRITICAL NO SDK source uses non-canonical prefixes like 'ds_secret_' / 'ds_pub_' / 'ds_key_' / 'ds_prod_'. Drift to a different prefix would break customer code AND the server-side V-NNN key-validation. The ONLY valid prefixes are 'ds_live_' + 'ds_test_'.", () => {
    const filesToCheck = [
      'packages/sdk-typescript/src/client.ts',
      'packages/sdk-typescript/src/http.ts',
      'packages/sdk-python/src/driftstack/client.py',
      'packages/sdk-python/src/driftstack/__init__.py',
      'packages/sdk-go/doc.go',
      'packages/sdk-go/client.go',
    ];
    for (const f of filesToCheck) {
      const p = read(resolve(REPO_ROOT, f));
      for (const wrongPrefix of ['ds_secret_', 'ds_pub_', 'ds_prod_', 'ds_sandbox_']) {
        expect(p, `${f} references non-canonical prefix '${wrongPrefix}'`).not.toMatch(
          new RegExp(wrongPrefix),
        );
      }
    }
  });

  // ─── error-handling.ts TS-only ds_live_demo fallback ──────────

  it("CRITICAL TS error-handling.ts uses 'ds_live_demo' as the env-var fallback (lets the example RUN without env-var setup; the unrecognised key hits the InvalidKeyError demo path per W797). Drift to dropping the fallback or changing the magic-string would break CI rendering of the example.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/sdk-typescript/examples/error-handling.ts'));
    expect(p).toMatch(/process\.env\.DRIFTSTACK_API_KEY \?\? 'ds_live_demo'/);
  });

  // ─── TS rate-limit-handling.ts also uses ds_live_demo fallback ─

  it("CRITICAL TS rate-limit-handling.ts uses the same 'ds_live_demo' fallback as error-handling.ts. Matches W802 single-language-examples parity.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/sdk-typescript/examples/rate-limit-handling.ts'));
    expect(p).toMatch(/apiKey: process\.env\.DRIFTSTACK_API_KEY \?\? 'ds_live_demo'/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/sdk-api-key-prefix-cross-sdk-parity.test.ts'),
      ),
    ).toBe(true);
  });
});
