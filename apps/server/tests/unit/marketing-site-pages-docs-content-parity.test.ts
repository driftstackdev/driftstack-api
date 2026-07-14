// W498.C — drift guard for apps/marketing-site/src/pages/docs.astro.
// /docs landing page. Drift here either drops a documentation
// category card (would orphan customers from one of the 5 main
// entry points — quickstart / API ref / SDKs / webhooks / self-
// hosted) or re-introduces the W210-removed Recipe library card
// (would point at a 404 since /docs/recipes is Phase 3).
//
//   • BaseLayout import + page title + SEO description.
//   • 5-card category grid: Quickstart / API reference / SDKs /
//     Webhooks / Self-hosted.
//   • Card hrefs: https://docs.driftstack.dev/quickstart-curl/
//     (S47 2026-07-07 mirror deprecation — was /docs/api-quickstart,
//     now deleted + 301) + /api-reference + /docs/sdk-typescript +
//     /docs/webhooks + /self-hosted.
//   • W210 Recipe-library-removed inline comment (anti-404 guard).
//   • OpenAPI 3.1 + try-in-browser + SDK codegen framing.
//   • All-5-event-types + HMAC-SHA256 verification framing.
//   • SDK runtime triad: npm / PyPI / Go module.
//   • Help banner: mailto:support@driftstack.dev + github.com/
//     driftstackdev.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/docs.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W498.C apps/marketing-site/src/pages/docs.astro content parity', () => {
  const body = read(LIB);

  it("BaseLayout title='Docs' + description covering quickstart / SDK references for TypeScript-Python-Go / API reference / self-hosted setup / recipe library — pinned so the SEO description covers ALL the doc surface customers might search for (drift to dropping any would hurt search ranking for that doc category)", () => {
    expect(body).toMatch(/import BaseLayout from '\.\.\/layouts\/BaseLayout\.astro';/);
    expect(body).toMatch(
      /<BaseLayout\s*\n?\s*title="Docs"\s*\n?\s*description="Driftstack documentation: quickstart, SDK references for TypeScript \/ Python \/ Go, API reference, self-hosted setup, recipe library\."/,
    );
  });

  it("Hero framing: 'Everything you need to drive a session.' + 'Driftstack is small enough to read end-to-end — start with the quickstart and follow the link trail.' — pinned so the small-surface 'read end-to-end' positioning survives (drift to a chatty/feature-rich framing would imply a sprawling doc set, which contradicts the actual end-to-end-readable scope)", () => {
    expect(body).toMatch(/Everything you need to drive a session\./);
    expect(body).toMatch(
      /Driftstack\s*\n?\s*is small enough to read end-to-end — start with the quickstart\s*\n?\s*and follow the link trail\./,
    );
  });

  it('5-card category grid: Quickstart (https://docs.driftstack.dev/quickstart-curl/ — S47 2026-07-07 mirror deprecation successor of the deleted /docs/api-quickstart) + API reference (/api-reference) + SDKs (/docs/sdk-typescript) + Webhooks (/docs/webhooks) + Self-hosted (/self-hosted) — pinned so the 5 main doc entry points + their canonical hrefs stay correct (drift to dropping any card would orphan customers from that documentation category; drift to a different href would break the click-through; drift BACK to /docs/api-quickstart would re-point customers at a 301 stub)', () => {
    expect(body).toMatch(/href="https:\/\/docs\.driftstack\.dev\/quickstart-curl\/"/);
    expect(body).not.toMatch(/href="\/docs\/api-quickstart"/);
    for (const path of [
      '/api-reference',
      '/docs/sdk-typescript',
      '/docs/webhooks',
      '/self-hosted',
    ]) {
      expect(body).toContain(`href="${path}/"`);
      expect(body).not.toContain(`href="${path}"`);
    }
  });

  it("Quickstart card framing: 'Five minutes to first session →' + 'Install the SDK in your language, paste an API key, drive your first session. No prior browser-automation experience needed.' — pinned so the 5-minute time-to-first-session promise + the no-prior-experience reassurance survive (drift to a longer time estimate would let customers expect a multi-hour onboarding; drift to dropping 'no prior experience' would lose the new-to-automation onboarding pull)", () => {
    expect(body).toMatch(/Five minutes to first session →/);
    expect(body).toMatch(
      /Install the SDK in your language, paste an API key, drive\s*\n?\s*your first session\. No prior browser-automation experience\s*\n?\s*needed\./,
    );
  });

  it("API reference card framing: 'Auto-generated from the OpenAPI 3.1 spec. Try requests against your own API key directly in the browser. Same spec the SDK codegen reads.' — pinned so the OpenAPI 3.1 version + the in-browser try-it + the single-source-of-truth (same spec the SDK reads) all survive (drift to OpenAPI 3.0 would orphan tooling that requires 3.1; drift to dropping the codegen reference would hide the spec→SDK consistency story)", () => {
    expect(body).toMatch(
      /Auto-generated from the OpenAPI 3\.1 spec\. Try requests\s*\n?\s*against your own API key directly in the browser\. Same\s*\n?\s*spec the SDK codegen reads\./,
    );
  });

  it("SDKs card framing: 'TypeScript · Python · Go →' + 'Native packages on npm, PyPI, and as a Go module. Typed request/response shapes. Retry-with-backoff. Webhook signature verification. Async iterators for paginated list endpoints.' — pinned so the 3-language SDK runtime triad (TS/Python/Go) + the 4-feature shortlist (typed + retry + webhook-verify + async-iter) survive (drift to dropping a language would shrink the supported-language surface; drift to dropping retry-with-backoff would hide a core SDK reliability feature)", () => {
    expect(body).toMatch(/TypeScript · Python · Go →/);
    expect(body).toMatch(
      /Native packages on npm, PyPI, and as a Go module\. Typed\s*\n?\s*request\/response shapes\. Retry-with-backoff\. Webhook\s*\n?\s*signature verification\. Async iterators for paginated\s*\n?\s*list endpoints\./,
    );
  });

  it('Webhooks card pins the canonical eight-event roster and HMAC-SHA256 verification', () => {
    expect(body).toMatch(
      /All eight subscribable event types — session\.completed, session\.failed,\s*\n?\s*api_key\.revoked,\s*\n?\s*session\.egress_capability_changed, crypto\.order\.paid,\s*\n?\s*crypto\.order\.failed, session\.challenge_detected,\s*\n?\s*session\.profile_save_failed — with payload shapes\s*\n?\s*and HMAC-SHA256 verification examples\./,
    );
    expect(body).not.toMatch(/quota\.warning_80pct|quota\.exceeded/);
  });

  it("Self-hosted card framing: 'Deploy on your own hardware →' + 'SKU comparison, hardware specs, onboarding flow. For sustained high-concurrency operations or full data sovereignty.' — pinned so the self-hosted positioning (sustained high-concurrency OR full data sovereignty) stays explicit (drift to dropping data sovereignty would hide a key compliance-driven self-host motivator; drift to dropping SKU comparison would orphan customers from the hardware-choice doc)", () => {
    expect(body).toMatch(/Deploy on your own hardware →/);
    expect(body).toMatch(
      /SKU comparison, hardware specs, onboarding flow\. For\s*\n?\s*sustained high-concurrency operations or full data\s*\n?\s*sovereignty\./,
    );
  });

  it('points recipe readers at the live docs host without a dead marketing mirror', () => {
    expect(body).toContain('docs.driftstack.dev/api/recipes/');
    expect(body).not.toMatch(/href="\/docs\/recipes/);
  });

  it("Help banner: 'Doc not landing?' + mailto:support@driftstack.dev + 'We answer in writing, usually same business day.' + GitHub → https://github.com/driftstackdev — pinned so the support-channel + same-business-day SLA + the GitHub link all survive (drift to dropping the SLA would lose the response-time expectation; drift to a different github org would break the canonical org reference)", () => {
    expect(body).toMatch(/Doc not landing\?/);
    // Fleet v2 (2026-07-03): link re-pinned to the AA-safe accent-text tone.
    expect(body).toMatch(
      /<a\s*\n?\s*href="mailto:support@driftstack\.dev"\s*\n?\s*class="text-tk-accent-text underline">support@driftstack\.dev<\/a> with the URL you expected to find\. We answer in writing,\s*\n?\s*usually same business day\./,
    );
    expect(body).toMatch(
      /<a href="https:\/\/github\.com\/driftstackdev" class="btn-secondary">GitHub →<\/a>/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
