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
//   • Card hrefs: https://docs.driftstack.io/quickstart-curl/
//     (S47 2026-07-07 mirror deprecation — was /docs/api-quickstart,
//     now deleted + 301) + /api-reference + /docs/sdk-typescript +
//     /docs/webhooks + /self-hosted.
//   • W210 Recipe-library-removed inline comment (anti-404 guard).
//   • Curated local map + complete live OpenAPI + SDK codegen framing.
//   • All-5-event-types + HMAC-SHA256 verification framing.
//   • SDK publish truth: all three are published pre-1.0 packages;
//     consumers retain lockfile/constraint reproducibility.
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
      /<BaseLayout\s*title="Docs"\s*description="Driftstack documentation: desktop and code quickstarts, SDK guides for TypeScript \/ Python \/ Go, API reference, self-hosted setup, recipe library\."/,
    );
  });

  it("Hero framing: 'Everything you need to drive a session.' + 'Driftstack is small enough to read end-to-end — start with the quickstart and follow the link trail.' — pinned so the small-surface 'read end-to-end' positioning survives (drift to a chatty/feature-rich framing would imply a sprawling doc set, which contradicts the actual end-to-end-readable scope)", () => {
    expect(body).toMatch(/Everything you need to drive a session\./);
    expect(body).toMatch(
      /Driftstack\s*is small enough to read end-to-end — start with the quickstart\s*and follow the link trail\./,
    );
  });

  it('5-card category grid: Quickstart (https://docs.driftstack.io/quickstart-curl/ — S47 2026-07-07 mirror deprecation successor of the deleted /docs/api-quickstart) + API reference (/api-reference) + SDKs (/docs/sdk-typescript) + Webhooks (/docs/webhooks) + Self-hosted (/self-hosted) — pinned so the 5 main doc entry points + their canonical hrefs stay correct (drift to dropping any card would orphan customers from that documentation category; drift to a different href would break the click-through; drift BACK to /docs/api-quickstart would re-point customers at a 301 stub)', () => {
    expect(body).toMatch(/href="https:\/\/docs\.driftstack\.io\/quickstart-curl\/"/);
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

  it('Quickstart card pins Free browser-first desktop activation and paid customer-key code access', () => {
    expect(body).toMatch(/Free desktop or paid code →/);
    expect(body).toMatch(/On Free, sign in through the desktop app's browser flow/);
    expect(body).toMatch(/stores\s*a restricted device credential automatically/);
    expect(body).toMatch(/Code quickstarts use\s*a paid tier and a customer API key/);
    expect(body).not.toMatch(/paste an API key, drive/);
  });

  it('API reference card pins curated-local versus complete-live reference truth', () => {
    expect(body).toMatch(/Curated route map \+ live reference →/);
    expect(body).toMatch(/Browse common routes and runnable patterns here/);
    expect(body).toMatch(/complete interactive OpenAPI 3\.1 reference on docs\.driftstack\.io/);
    expect(body).toMatch(/same contract the SDK codegen reads/);
    expect(body).not.toMatch(/Every endpoint, every shape/);
  });

  it('SDKs card pins all three published pre-1.0 registries and reproducible installs', () => {
    expect(body).toMatch(/TypeScript · Python · Go →/);
    expect(body).toMatch(
      /TypeScript, Python, and Go are published as pre-1\.0 packages on\s*npm, PyPI, and the Go module proxy/,
    );
    expect(body).toMatch(
      /use your package-manager lockfile\s*or constraints for reproducible deployments/,
    );
    expect(body).not.toMatch(/alpha source\s*distributions|first registry tag|tag pending/i);
  });

  it('Webhooks card pins the canonical eight-event roster and HMAC-SHA256 verification', () => {
    expect(body).toMatch(
      /All eight subscribable event types — session\.completed, session\.failed,\s*api_key\.revoked,\s*session\.egress_capability_changed, crypto\.order\.paid,\s*crypto\.order\.failed, session\.challenge_detected,\s*session\.profile_save_failed — with payload shapes\s*and HMAC-SHA256 verification examples\./,
    );
    expect(body).not.toMatch(/quota\.warning_80pct|quota\.exceeded/);
  });

  it("Self-hosted card framing: 'Deploy on your own hardware →' + 'SKU comparison, hardware specs, onboarding flow. For sustained high-concurrency operations or full data sovereignty.' — pinned so the self-hosted positioning (sustained high-concurrency OR full data sovereignty) stays explicit (drift to dropping data sovereignty would hide a key compliance-driven self-host motivator; drift to dropping SKU comparison would orphan customers from the hardware-choice doc)", () => {
    expect(body).toMatch(/Deploy on your own hardware →/);
    expect(body).toMatch(
      /SKU comparison, hardware specs, onboarding flow\. For\s*sustained high-concurrency operations or full data\s*sovereignty\./,
    );
  });

  it('points recipe readers at the live docs host without a dead marketing mirror', () => {
    expect(body).toContain('docs.driftstack.io/api/recipes/');
    expect(body).not.toMatch(/href="\/docs\/recipes/);
  });

  it("Help banner: 'Doc not landing?' + mailto:support@driftstack.dev + 'We answer in writing, usually same business day.' + GitHub → https://github.com/driftstackdev — pinned so the support-channel + same-business-day SLA + the GitHub link all survive (drift to dropping the SLA would lose the response-time expectation; drift to a different github org would break the canonical org reference)", () => {
    expect(body).toMatch(/Doc not landing\?/);
    // Fleet v2 (2026-07-03): link re-pinned to the AA-safe accent-text tone.
    expect(body).toMatch(
      /<a\s*href="mailto:support@driftstack\.dev"\s*class="text-tk-accent-text underline">support@driftstack\.dev<\/a> with the URL you expected to find\. We answer in writing,\s*usually same business day\./,
    );
    expect(body).toMatch(
      /<a href="https:\/\/github\.com\/driftstackdev" class="btn-secondary">GitHub →<\/a>/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
