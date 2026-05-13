// W380.C — drift guard for marketing-site /docs (docs landing) page
// content. Existing docs-landing-baseline covers basic shape. This
// guard pins the load-bearing customer-onboarding claims:
//
//   • Hero: "Everything you need to drive a session." + 4-line
//     orientation copy.
//   • 5 doc-category cards in canonical order: Quickstart →
//     /docs/api-quickstart / API reference → /api-reference / SDKs
//     → /docs/sdk-typescript / Webhooks → /docs/webhooks /
//     Self-hosted → /self-hosted.
//   • 5 webhook event types pinned in the Webhooks card description
//     (session.completed / session.failed / api_key.revoked /
//     quota.warning_80pct / quota.exceeded) + HMAC-SHA256 framing.
//   • W210 "Recipe library removed until ships" comment pinned
//     (load-bearing honesty signal — drift would mean adding back a
//     404 link).
//   • SDK card mentions TypeScript / Python / Go + npm/PyPI/Go-
//     module + async iterators.
//   • API reference card: OpenAPI 3.1 + browser try + same-spec-
//     codegen claim.
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
      /Quickstarts for every supported language, the full API reference,\s+SDK guides, self-hosted setup, and the recipe catalogue/,
    );
    expect(body).toMatch(/Driftstack\s+is small enough to read end-to-end/);
  });

  it('5 doc-category cards in canonical order (Quickstart / API reference / SDKs / Webhooks / Self-hosted)', () => {
    const cards = [
      { href: '/docs/api-quickstart', label: 'Quickstart' },
      { href: '/api-reference', label: 'API reference' },
      { href: '/docs/sdk-typescript', label: 'SDKs' },
      { href: '/docs/webhooks', label: 'Webhooks' },
      { href: '/self-hosted', label: 'Self-hosted' },
    ];
    let lastIdx = -1;
    for (const card of cards) {
      const idx = body.indexOf(`href="${card.href}"`);
      expect(idx, `card href out of order: ${card.href}`).toBeGreaterThan(lastIdx);
      lastIdx = idx;
      expect(body, `card label missing: ${card.label}`).toMatch(
        new RegExp(`text-glow-red">\\s*${card.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*<`),
      );
    }
  });

  it('Quickstart card: "Five minutes to first session" + paste-API-key framing', () => {
    expect(body).toMatch(/Five minutes to first session →/);
    expect(body).toMatch(
      /Install the SDK in your language, paste an API key, drive\s+your first session/,
    );
    expect(body).toMatch(/No prior browser-automation experience\s+needed/);
  });

  it('API reference card: OpenAPI 3.1 + browser-try + same-spec-codegen-reads claim', () => {
    expect(body).toMatch(/Every endpoint, every shape →/);
    expect(body).toMatch(/Auto-generated from the OpenAPI 3\.1 spec/);
    expect(body).toMatch(/Try requests\s+against your own API key directly in the browser/);
    expect(body).toMatch(/Same\s+spec the SDK codegen reads/);
  });

  it('SDK card: TypeScript · Python · Go + npm/PyPI/Go-module + async iterators', () => {
    expect(body).toMatch(/TypeScript · Python · Go →/);
    expect(body).toMatch(/Native packages on npm, PyPI, and as a Go module/);
    expect(body).toMatch(/Async iterators for paginated\s+list endpoints/);
    expect(body).toMatch(/Webhook\s+signature verification/);
  });

  it('Webhooks card: 5 event types pinned (session.completed / .failed / api_key.revoked / quota.warning_80pct / .exceeded) + HMAC-SHA256', () => {
    expect(body).toMatch(/Event types \+ signature verification →/);
    expect(body).toMatch(
      /All five event types — session\.completed, session\.failed,\s+api_key\.revoked, quota\.warning_80pct, quota\.exceeded/,
    );
    expect(body).toMatch(/HMAC-SHA256 verification examples/);
  });

  it('Self-hosted card: "Deploy on your own hardware" + sustained high-concurrency + data-sovereignty framing', () => {
    expect(body).toMatch(/Deploy on your own hardware →/);
    expect(body).toMatch(/SKU comparison, hardware specs, onboarding flow/);
    expect(body).toMatch(/For\s+sustained high-concurrency operations or full data\s+sovereignty/);
  });

  it('W210 Recipe-library-removal honesty comment pinned (no 404 link until ships)', () => {
    expect(body).toMatch(/W210 — the Recipe library card pointed at \/docs\/recipes/);
    expect(body).toMatch(/Removed\s+until the page ships rather than show customers a 404/);
  });

  it('help banner: "Doc not landing?" + support@driftstack.dev mailto + same-business-day claim', () => {
    expect(body).toMatch(
      /<h2 class="text-xl font-semibold text-ink-primary">Doc not landing\?<\/h2>/,
    );
    expect(body).toMatch(
      /<a\s+href="mailto:support@driftstack\.dev"\s+class="text-glow-red underline">support@driftstack\.dev<\/a>/,
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
    expect(body).toMatch(/<BaseLayout\s*\n?\s*title="Docs"/);
    expect(body).toMatch(
      /Driftstack documentation: quickstart, SDK references for TypeScript \/ Python \/ Go/,
    );
  });

  it('all 5 destination pages exist (Quickstart / API ref / TS SDK / Webhooks / Self-hosted)', () => {
    const dir = resolve(REPO_ROOT, 'apps/marketing-site/src/pages');
    expect(existsSync(resolve(dir, 'docs/api-quickstart.astro'))).toBe(true);
    expect(existsSync(resolve(dir, 'api-reference.astro'))).toBe(true);
    expect(existsSync(resolve(dir, 'docs/sdk-typescript.astro'))).toBe(true);
    expect(existsSync(resolve(dir, 'docs/webhooks.astro'))).toBe(true);
    expect(existsSync(resolve(dir, 'self-hosted.astro'))).toBe(true);
  });
});
