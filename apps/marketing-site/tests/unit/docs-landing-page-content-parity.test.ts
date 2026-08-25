// W380.C — drift guard for marketing-site /docs (docs landing) page
// content. Existing docs-landing-baseline covers basic shape. This
// guard pins the load-bearing customer-onboarding claims:
//
//   • Hero: "Everything you need to drive a session." + 4-line
//     orientation copy.
//   • 5 doc-category cards in canonical order: Quickstart →
//     docs.driftstack.dev/quickstart-curl/ (S47 2026-07-07 mirror
//     deprecation — was /docs/api-quickstart, now deleted + 301) /
//     API reference → /api-reference / SDKs → /docs/sdk-typescript /
//     Webhooks → /docs/webhooks / Self-hosted → /self-hosted.
//   • 5 webhook event types pinned in the Webhooks card description
//     (session.completed / session.failed / api_key.revoked /
//     live eight-event roster) + HMAC-SHA256 framing.
//   • W210 "Recipe library removed until ships" comment pinned
//     (load-bearing honesty signal — drift would mean adding back a
//     404 link).
//   • SDK card pins all three published pre-1.0 registry packages and
//     reproducible-install guidance.
//   • API reference card distinguishes the curated local map from the
//     complete interactive reference.
//   • Help banner: "Doc not landing?" + support@driftstack.dev
//     mailto + same-business-day claim.
//   • GitHub external link.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/docs.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W380.C marketing-site /docs.astro (docs landing) content parity', () => {
  const body = read(PAGE);

  it('hero copy: "Everything you need to drive a session." + 4-line orientation', () => {
    expect(body).toMatch(/Everything you need to drive a session\./);
    expect(body).toMatch(
      /Desktop and code quickstarts, the living API reference,\s+SDK guides, self-hosted setup, and the recipe catalogue/,
    );
    expect(body).toMatch(/Driftstack\s+is small enough to read end-to-end/);
  });

  it('5 doc-category cards in canonical order (Quickstart / API reference / SDKs / Webhooks / Self-hosted)', () => {
    const cards = [
      // S47 2026-07-07 (founder-approved: mirror deprecation): the
      // Quickstart card points at the docs successor of the deleted
      // /docs/api-quickstart mirror.
      { href: 'https://docs.driftstack.dev/quickstart-curl/', label: 'Quickstart' },
      { href: '/api-reference/', label: 'API reference' },
      { href: '/docs/sdk-typescript/', label: 'SDKs' },
      { href: '/docs/webhooks/', label: 'Webhooks' },
      { href: '/self-hosted/', label: 'Self-hosted' },
    ];
    let lastIdx = -1;
    for (const card of cards) {
      const idx = body.indexOf(`href="${card.href}"`);
      expect(idx, `card href out of order: ${card.href}`).toBeGreaterThan(lastIdx);
      lastIdx = idx;
      // Fleet v2 (2026-07-03): card labels re-pinned to the AA-safe
      // accent-text tone (label text + card order unchanged).
      expect(body, `card label missing: ${card.label}`).toMatch(
        new RegExp(
          `text-tk-accent-text">\\s*${card.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*<`,
        ),
      );
    }
  });

  it('Quickstart card separates Free browser-first desktop activation from paid code', () => {
    expect(body).toMatch(/Free desktop or paid code →/);
    expect(body).toMatch(/On Free, sign in through the desktop app's browser flow/);
    expect(body).toMatch(/stores\s+a restricted device credential automatically/);
    expect(body).toMatch(/Code quickstarts use\s+a paid tier and a customer API key/);
    expect(body).not.toMatch(/paste an API key, drive/);
  });

  it('API reference card distinguishes curated route map from complete live OpenAPI reference', () => {
    expect(body).toMatch(/Curated route map \+ live reference →/);
    expect(body).toMatch(/Browse common routes and runnable patterns here/);
    expect(body).toMatch(/complete interactive OpenAPI 3\.1 reference on docs\.driftstack\.dev/);
    expect(body).toMatch(/same contract the SDK codegen reads/);
    expect(body).not.toMatch(/Every endpoint, every shape/);
  });

  it('SDK card states the current publish posture for all three languages', () => {
    expect(body).toMatch(/TypeScript · Python · Go →/);
    expect(body).toMatch(
      /TypeScript, Python, and Go are published as pre-1\.0 packages on\s+npm, PyPI, and the Go module proxy/,
    );
    expect(body).toMatch(
      /use your package-manager lockfile\s+or constraints for reproducible deployments/,
    );
    expect(body).not.toMatch(/alpha source\s+distributions|first registry tag|tag pending/i);
  });

  it('Webhooks card: all eight live subscribable event types + HMAC-SHA256', () => {
    expect(body).toMatch(/Event types \+ signature verification →/);
    expect(body).toMatch(/All eight subscribable event types/);
    expect(body).toMatch(/session\.completed/);
    expect(body).toMatch(/session\.failed/);
    expect(body).toMatch(/api_key\.revoked/);
    expect(body).toMatch(/session\.egress_capability_changed/);
    expect(body).toMatch(/crypto\.order\.paid/);
    expect(body).toMatch(/crypto\.order\.failed/);
    expect(body).toMatch(/session\.challenge_detected/);
    expect(body).toMatch(/session\.profile_save_failed/);
    expect(body).not.toMatch(/quota\.warning_80pct|quota\.exceeded/);
    expect(body).toMatch(/HMAC-SHA256 verification examples/);
  });

  it('Self-hosted card: "Deploy on your own hardware" + sustained high-concurrency + data-sovereignty framing', () => {
    expect(body).toMatch(/Deploy on your own hardware →/);
    expect(body).toMatch(/SKU comparison, hardware specs, onboarding flow/);
    expect(body).toMatch(/For\s+sustained high-concurrency operations or full data\s+sovereignty/);
  });

  it('points recipe readers at the live docs host without a dead marketing mirror', () => {
    expect(body).toContain('docs.driftstack.dev/api/recipes/');
    expect(body).not.toMatch(/href="\/docs\/recipes/);
  });

  it('help banner: "Doc not landing?" + support@driftstack.dev mailto + same-business-day claim. 2026-05-23 — h2 wrapped with help-circle icon; pin loosened to label-presence.', () => {
    expect(body).toMatch(/Doc not landing\?/);
    expect(body).toMatch(
      /<a\s+href="mailto:support@driftstack\.dev"\s+class="text-tk-accent-text underline">support@driftstack\.dev<\/a>/,
    );
    expect(body).toMatch(/We answer in writing,\s+usually same business day/);
    expect(body).toMatch(/with the URL you expected to find/);
  });

  it('GitHub external link in help banner', () => {
    expect(body).toMatch(
      /<a href="https:\/\/github\.com\/driftstackdev" class="btn-secondary">GitHub →<\/a>/,
    );
  });

  it('uses BaseLayout + Docs title + description', () => {
    expect(body).toMatch(/import BaseLayout from '\.\.\/layouts\/BaseLayout\.astro';/);
    expect(body).toMatch(/<BaseLayout\s*title="Docs"/);
    expect(body).toMatch(
      /Driftstack documentation: desktop and code quickstarts, SDK guides for TypeScript \/ Python \/ Go/,
    );
  });

  it('all 5 destination pages exist (Quickstart / API ref / TS SDK / Webhooks / Self-hosted)', () => {
    const dir = resolve(REPO_ROOT, 'apps/marketing-site/src/pages');
    // S47 2026-07-07: the Quickstart card's destination is the docs
    // app successor; the old mirror page must stay DELETED (a
    // restored file would shadow its 301 in public/_redirects).
    expect(existsSync(resolve(dir, 'docs/api-quickstart.astro'))).toBe(false);
    expect(existsSync(resolve(REPO_ROOT, 'apps/docs/src/pages/quickstart-curl.md'))).toBe(true);
    expect(existsSync(resolve(dir, 'api-reference.astro'))).toBe(true);
    expect(existsSync(resolve(dir, 'docs/sdk-typescript.astro'))).toBe(true);
    expect(existsSync(resolve(dir, 'docs/webhooks.astro'))).toBe(true);
    expect(existsSync(resolve(dir, 'self-hosted.astro'))).toBe(true);
  });
});
