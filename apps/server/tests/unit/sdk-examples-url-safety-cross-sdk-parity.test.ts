// W836 — cross-SDK example URL safety. One-hundred-sixty-second in
// the drift-guard series. Pins that all 3 SDK example files
// (quickstart + error-handling + pagination + etc) use only
// example.com / example.org / etc (IANA-reserved demo domains)
// for their navigate targets — never real customer hostnames.
// Drift would let an example reference a real site that breaks
// when that site changes, or accidentally direct test traffic at
// production customer infra.
//
// IANA-reserved per RFC 2606 + RFC 6761:
//   - example.com / example.org / example.net (reserved demo)
//   - localhost / 127.0.0.1 (loopback)
//   - *.test / *.invalid (reserved TLDs)
//
// Also-acceptable for examples:
//   - go.dev (Go SDK quickstart docs page)
//   - https://app.driftstack.io (canonical dashboard URL for
//     billing-flow example redirects per W800)
//   - golang.org / httpbin.org (used in W802 Go goroutine_pool
//     scraping demo).
//
// Test asserts NO mention of well-known customer/marketing hosts:
//   - google.com / facebook.com / amazon.com / netflix.com / etc.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

// All SDK example files across the 3 SDKs.
const SDK_EXAMPLE_FILES = [
  // TypeScript SDK examples (8 files).
  'packages/sdk-typescript/examples/quickstart.ts',
  'packages/sdk-typescript/examples/error-handling.ts',
  'packages/sdk-typescript/examples/pagination.ts',
  'packages/sdk-typescript/examples/webhook-receiver.ts',
  'packages/sdk-typescript/examples/billing-flow.ts',
  'packages/sdk-typescript/examples/profile-management.ts',
  'packages/sdk-typescript/examples/rate-limit-handling.ts',
  'packages/sdk-typescript/examples/crypto-checkout.ts',
  // Python SDK examples (9 files).
  'packages/sdk-python/examples/quickstart.py',
  'packages/sdk-python/examples/error_handling.py',
  'packages/sdk-python/examples/pagination.py',
  'packages/sdk-python/examples/webhook_receiver.py',
  'packages/sdk-python/examples/billing_flow.py',
  'packages/sdk-python/examples/profile_management.py',
  'packages/sdk-python/examples/crypto_checkout.py',
  'packages/sdk-python/examples/langchain_tool.py',
  'packages/sdk-python/examples/pytest_fixture.py',
  // Go SDK examples (9 files).
  'packages/sdk-go/examples/quickstart/main.go',
  'packages/sdk-go/examples/error_handling/main.go',
  'packages/sdk-go/examples/pagination/main.go',
  'packages/sdk-go/examples/webhook_receiver/main.go',
  'packages/sdk-go/examples/billing_flow/main.go',
  'packages/sdk-go/examples/profile_management/main.go',
  'packages/sdk-go/examples/crypto_checkout/main.go',
  'packages/sdk-go/examples/goroutine_pool/main.go',
  'packages/sdk-go/examples/scraping_pipeline/main.go',
];

// Hosts that MUST NOT appear in any example (well-known customer-
// reachable sites — drift would let an example point at a real
// service that could break or get rate-limited).
const FORBIDDEN_HOSTS = [
  'google.com',
  'facebook.com',
  'amazon.com',
  'netflix.com',
  'twitter.com',
  'instagram.com',
  'apple.com',
  'microsoft.com',
];

describe('W836 cross-SDK example URL safety', () => {
  it('all 26 SDK example files exist at canonical paths', () => {
    for (const f of SDK_EXAMPLE_FILES) {
      expect(existsSync(resolve(REPO_ROOT, f)), `${f} must exist`).toBe(true);
    }
  });

  // ─── No forbidden hosts cross-SDK ─────────────────────────────

  it('CRITICAL NO SDK example references well-known real-customer hosts (google.com / facebook.com / amazon.com / etc). Drift to using a real site would either break the example when that site changes or let test traffic accidentally hit production infra at scale.', () => {
    for (const f of SDK_EXAMPLE_FILES) {
      const p = read(resolve(REPO_ROOT, f));
      for (const host of FORBIDDEN_HOSTS) {
        expect(p, `${f} references forbidden host '${host}'`).not.toMatch(
          new RegExp(`https?://[^\\s'"]*\\b${host.replace(/\./g, '\\.')}\\b`, 'i'),
        );
      }
    }
  });

  // ─── At least one example.com reference in quickstarts ────────

  it('CRITICAL TS+Python+Go quickstart examples ALL reference https://example.com (IANA-reserved demo domain) as the canonical navigate target. Drift would either pick a real site (covered by FORBIDDEN_HOSTS) or invent a non-reserved demo target.', () => {
    const tsQs = read(resolve(REPO_ROOT, 'packages/sdk-typescript/examples/quickstart.ts'));
    const pyQs = read(resolve(REPO_ROOT, 'packages/sdk-python/examples/quickstart.py'));
    const goQs = read(resolve(REPO_ROOT, 'packages/sdk-go/examples/quickstart/main.go'));

    expect(tsQs).toMatch(/https:\/\/example\.com/);
    expect(pyQs).toMatch(/https:\/\/example\.com/);
    expect(goQs).toMatch(/https:\/\/example\.com/);
  });

  // ─── Allowed real-but-safe hosts ──────────────────────────────

  it('CRITICAL Go goroutine_pool scraping demo uses 5 IANA-safe + dev-community hosts — example.com/org/net + golang.org + httpbin.org. Drift to a real customer site would break the W802 cross-SDK demonstration. golang.org + httpbin.org are explicitly safe (dev/test community).', () => {
    const p = read(resolve(REPO_ROOT, 'packages/sdk-go/examples/goroutine_pool/main.go'));
    expect(p).toMatch(/example\.com/);
    expect(p).toMatch(/example\.org/);
    expect(p).toMatch(/example\.net/);
    expect(p).toMatch(/golang\.org/);
    expect(p).toMatch(/httpbin\.org/);
  });

  it('CRITICAL Go scraping_pipeline uses example.com + go.dev (Go SDK docs page is canonical for showcasing). Drift to a customer site would break the per-target isolation demo from W802.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/sdk-go/examples/scraping_pipeline/main.go'));
    expect(p).toMatch(/example\.com/);
    expect(p).toMatch(/go\.dev/);
  });

  // ─── Billing-flow examples use app.driftstack.io for redirects ─

  it("CRITICAL TS+Python+Go billing-flow examples all use https://app.driftstack.io/billing as the success_url + cancel_url. The 'app.driftstack.io' host is the canonical customer-dashboard origin per W800 — drift to a different host would break the documented Checkout redirect flow.", () => {
    const tsBf = read(resolve(REPO_ROOT, 'packages/sdk-typescript/examples/billing-flow.ts'));
    const pyBf = read(resolve(REPO_ROOT, 'packages/sdk-python/examples/billing_flow.py'));
    const goBf = read(resolve(REPO_ROOT, 'packages/sdk-go/examples/billing_flow/main.go'));

    expect(tsBf).toMatch(/https:\/\/app\.driftstack\.io\/billing/);
    expect(pyBf).toMatch(/https:\/\/app\.driftstack\.io\/billing/);
    expect(goBf).toMatch(/https:\/\/app\.driftstack\.io\/billing/);
  });

  // ─── No http:// (non-TLS) URLs except localhost ───────────────

  it('CRITICAL NO SDK example uses non-localhost http:// (plain-text) URLs for navigate targets. The IANA reserved domains + production references must all use https:// — drift to http:// would let an example demo encourage insecure customer code. Exception: localhost / 127.0.0.1 / driftstack.test are fine on plain HTTP.', () => {
    for (const f of SDK_EXAMPLE_FILES) {
      const p = read(resolve(REPO_ROOT, f));
      // Find all http:// URLs.
      const httpUrls = p.match(/http:\/\/[^\s'"`]+/g) ?? [];
      for (const url of httpUrls) {
        const isAllowed =
          /^http:\/\/localhost(?::\d+)?(?:\/|$)/.test(url) ||
          /^http:\/\/127\.0\.0\.1(?::\d+)?(?:\/|$)/.test(url) ||
          /^http:\/\/[^\s'"`]*\.test(?:\/|$)/.test(url) ||
          /^http:\/\/[^\s'"`]*\.invalid(?:\/|$)/.test(url);
        expect(isAllowed, `${f} has non-allowed http:// URL: ${url}`).toBe(true);
      }
    }
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/sdk-examples-url-safety-cross-sdk-parity.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
