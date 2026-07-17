// W512.B — drift guard for apps/marketing-site/src/pages/docs/sdk-typescript.astro.
// V-703 TypeScript SDK quickstart. Drift here either changes the
// @driftstack/sdk package name (would create marketing↔npm-registry
// divergence) or shifts the dual-published (ESM + CommonJS)
// commitment (would mislead CJS users who land here).
//
//   • V-703 doc-comment framing + V-680 posture + companion to
//     docs.driftstack.dev/quickstart-curl/ (S47).
//   • Package: @driftstack/sdk (npm/bun/pnpm install matrix).
//   • Node ≥ 18 + dual-published (ESM + CommonJS) commitment.
//   • new Driftstack({ apiKey, baseUrl }) constructor + reusable.
//   • Session lifecycle: creating → ready → busy → destroyed / errored.
//   • sessions.create no target URL; navigate separately.
//   • 5-method drive surface: navigate / interact / wait / capture /
//     destroy (idempotent).
//   • iterate() async iterator + list() single-page.
//   • DriftstackError with kind discriminator + ValidationError +
//     RateLimitedError subclasses.
//   • Paid customer-key boundary + RFC 9457 + curated API map.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/docs/sdk-typescript.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W512.B apps/marketing-site/src/pages/docs/sdk-typescript.astro content parity', () => {
  const body = read(LIB);

  it('SEO promises inline capture outputs, not a customer recordings API', () => {
    expect(body).toMatch(
      /description="Use the Driftstack TypeScript SDK to start browser sessions and capture screenshots, DOM snapshots, or PDFs inline — with full type-safety\."/,
    );
    expect(body).not.toMatch(/pull recordings|recordings API/i);
  });

  it("V-703 + V-680 framing pinned: 'TypeScript SDK quickstart. Companion to the curl quickstart. Pitched at teams that already have a Node/Bun/Deno service and want a typed surface instead of hand-rolling fetch calls. Posture matches V-680: code samples runnable verbatim once a key is in hand.' — pinned so the V-703 + V-680 anchors + real curl companion + verbatim-runnable posture all survive without advertising an unpublished CLI", () => {
    expect(body).toMatch(
      /\/\/ V-703 — TypeScript SDK quickstart\. Companion to https:\/\/docs\.driftstack\.dev\/quickstart-curl\/\s*\n?\s*\/\/ \(raw HTTP \/ curl\)\. Pitched at teams that already have a Node\/Bun\/Deno service/,
    );
    expect(body).toMatch(
      /\/\/ and want a typed surface instead of hand-rolling fetch calls\. Posture matches V-680: code\s*\n?\s*\/\/ samples runnable verbatim once a key is in hand\./,
    );
    expect(body).not.toContain('/docs/cli-quickstart');
  });

  it('@driftstack/sdk package + 3-runtime install matrix pinned: bun add + npm install + pnpm add — pinned so the canonical package name + 3-package-manager install paths stay consistent (drift to a different package name would create marketing↔npm divergence; drift to dropping pnpm would orphan one of the major package managers)', () => {
    expect(body).toMatch(/<code>@driftstack\/sdk<\/code>/);
    expect(body).toMatch(/bun add @driftstack\/sdk/);
    expect(body).toMatch(/npm install @driftstack\/sdk/);
    expect(body).toMatch(/pnpm add @driftstack\/sdk/);
  });

  it('Node ≥ 18 + dual-publish commitment is pinned without unsupported runtime claims', () => {
    expect(body).toMatch(
      /Node ≥ 18 is supported\. The package is dual-published \(ESM \+ CommonJS via conditional\s*\n?\s*<code>exports<\/code>\); both <code>import<\/code> and\s*\n?\s*<code>require\('@driftstack\/sdk'\)<\/code> work out of the box\./,
    );
    // The stale ESM-only / dynamic-import-required framing must NOT return.
    expect(body).not.toMatch(/ships ESM-only/);
    expect(body).not.toMatch(/Node ≥ 20|Bun ≥ 1\.1|Deno ≥ 1\.40/);
  });

  it("Constructor framing pinned: 'new Driftstack({ apiKey: process.env.DRIFTSTACK_API_KEY!, ... })' + 'The constructor does not make any network calls. Reuse one client across your process — it is internally pooled and safe for concurrent use.' — pinned so the apiKey + baseUrl-override + no-network-on-construct + reuse-pooled-concurrent commitments survive (drift to claiming a network call at construct-time would mislead about init cost)", () => {
    expect(body).toMatch(/import \{ Driftstack \} from '@driftstack\/sdk';/);
    expect(body).toMatch(/apiKey: process\.env\.DRIFTSTACK_API_KEY!/);
    expect(body).toMatch(/\/\/ baseUrl defaults to https:\/\/api\.driftstack\.dev/);
    expect(body).toMatch(
      /The constructor does not make any network calls\. Reuse one\s*\n?\s*client across your process — it is internally pooled and safe\s*\n?\s*for concurrent use\./,
    );
  });

  it("Session lifecycle states pinned: 'creating → ready → busy → destroyed / errored' — pinned so the 5-state session-lifecycle taxonomy stays consistent (drift to dropping 'errored' as a terminal state would leave customers unprepared for failures; drift to changing the order would create marketing↔state-machine divergence)", () => {
    expect(body).toMatch(
      /TypeScript narrows <code>session\.status<\/code> through the\s*\n?\s*lifecycle \(<code>creating<\/code> → <code>ready<\/code> →\s*\n?\s*<code>busy<\/code> → <code>destroyed<\/code> \/\s*\n?\s*<code>errored<\/code>\)\./,
    );
  });

  it("sessions.create no-target-URL framing + sessions.navigate() separate-call pinned: 'The session creation call does NOT take a target URL — drive the session to a URL with client.sessions.navigate()' — pinned so the explicit-no-URL-on-create + navigate-separately commitment stays consistent with /docs/sdk-python (drift to claiming sessions.create takes a URL would create marketing↔OpenAPI divergence)", () => {
    expect(body).toMatch(
      /The session creation call does NOT take\s*\n?\s*a target URL — drive the session to a URL with\s*\n?\s*<code>client\.sessions\.navigate\(\)<\/code>/,
    );
  });

  it("5-method session-drive surface + 'no built-in waitUntil helper' + idempotent destroy pinned — pinned so the 5-method drive surface + no-magic-wait helper + idempotent-destroy all survive (drift to claiming a waitUntil() helper exists would mislead about the SDK surface; consistent with /docs/sdk-python)", () => {
    expect(body).toMatch(
      /There is no built-in <code>waitUntil<\/code> helper — drive the\s*\n?\s*lifecycle with the methods that fit your workflow\s*\n?\s*\(<code>navigate<\/code>, <code>interact<\/code>,\s*\n?\s*<code>wait<\/code>, <code>capture<\/code>\)/,
    );
    expect(body).toMatch(/\/\/ Clean up — destroy is idempotent\./);
  });

  it("iterate() async iterator pinned: 'for await (const s of client.sessions.iterate({ limit: 50 }))' + 'iterate walks cursor pages transparently and stops when the server returns next_cursor: null. The single-page form is client.sessions.list(...).' — pinned so the iterate-walks-cursor + list-single-page commitment survives (consistent with /docs/sdk-python iterate() framing)", () => {
    expect(body).toMatch(
      /for await \(const s of client\.sessions\.iterate\(\{ limit: 50 \}\)\) \{/,
    );
    expect(body).toMatch(
      /<code>iterate<\/code> walks cursor pages transparently and\s*\n?\s*stops when the server returns\s*\n?\s*<code>next_cursor: null<\/code>\./,
    );
  });

  it('DriftstackError kind discriminator + RFC 9457 fields are pinned', () => {
    expect(body).toMatch(
      /The error carries <code>kind<\/code>\s*\n?\s*\(discriminator, narrow with <code>===<\/code>\),\s*\n?\s*<code>status<\/code>, <code>type<\/code> \(the RFC 9457 URI\),\s*\n?\s*<code>detail<\/code>, and any extension fields from the problem\s*\n?\s*response\./,
    );
    expect(body).toMatch(/err instanceof DriftstackError && err\.kind === 'validation'/);
    expect(body).toMatch(/err instanceof DriftstackError && err\.kind === 'rate_limited'/);
    expect(body).toMatch(/err\.issues/);
    expect(body).toMatch(/err\.retryAfterSeconds/);
  });

  it('paid customer-key boundary is explicit and unverified bundle absolutes stay absent', () => {
    expect(body).toContain('SDK automation requires an API-enabled paid tier');
    expect(body).toContain('<code>ds_live_…</code> customer API key');
    expect(body).toContain('restricted <code>ds_test_…</code>');
    expect(body).not.toMatch(/~12 kB gzipped|fully tree-shakeable/);
  });

  it('5-related-doc cluster: /api-reference + /docs/sdk-typescript-crypto-orders + /docs/webhooks + /docs/cost-monitoring + /docs/error-codes — pinned so the 5-related-doc navigation surface stays complete (drift to dropping /docs/error-codes would orphan the RFC-7807-type cross-reference from the typed-errors framing)', () => {
    const relatedDocs = [
      ['/api-reference', 'Curated API map'],
      ['/docs/sdk-typescript-crypto-orders', 'SDK — crypto orders'],
      ['/docs/webhooks', 'Webhooks'],
      ['/docs/cost-monitoring', 'Cost monitoring'],
      ['/docs/error-codes', 'Error codes'],
    ] as const;

    for (const [path, label] of relatedDocs) {
      expect(body).toContain(`<a href="${path}/">${label}</a>`);
      expect(body).not.toContain(`<a href="${path}">${label}</a>`);
    }
    expect(body).toContain('complete interactive reference');
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
