// W784 — apps/docs index.astro + 404.astro content parity. One-
// hundred-tenth in the cross-SDK drift-guard series. Pins the top-
// level docs landing + 404 fallback.
//
// Drift to the V-254 / V-257 onboarding-path framing or the
// 3-section TOC (Get started + Concept guides + Reference) would
// erode the customer-discovery flow.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const INDEX = resolve(REPO_ROOT, 'apps/docs/src/pages/index.astro');
const NOTFOUND = resolve(REPO_ROOT, 'apps/docs/src/pages/404.astro');

describe('W784 docs top-level index + 404 content parity', () => {
  it('both top-level pages exist', () => {
    expect(existsSync(INDEX)).toBe(true);
    expect(existsSync(NOTFOUND)).toBe(true);
  });

  // ─── index.astro ──────────────────────────────────────────────

  it("CRITICAL V-254 / V-257 anchor framing pinned. The 'V-254 replaced the V-250 scaffold-era \"site is being built out\" copy with a real intro that surfaces the doc-tree categories. V-257 reorganises around the customer\\'s onboarding path: Quickstart leads, then per-topic deep dives, then reference at the bottom' wording is the load-bearing layout-rationale.", () => {
    const p = read(INDEX);

    expect(p).toMatch(/V-254 \/ V-257 — docs site landing page\./);
    expect(p).toMatch(/V-254 replaced the V-250 scaffold-era "site is being built out" copy/);
    expect(p).toMatch(/with a real intro that surfaces the doc-tree categories\./);
    expect(p).toMatch(/V-257 reorganises around the customer's onboarding path:/);
    expect(p).toMatch(
      /"Quickstart" leads, then per-topic deep dives, then reference at the\s*\n?\/\/ bottom\./,
    );
  });

  it("CRITICAL bookmark-stability framing pinned. The 'Pre-launch the per-topic pages migrate in incrementally; nav stays stable so deep-link bookmarks survive future content additions' wording is the load-bearing customer-promise.", () => {
    const p = read(INDEX);

    expect(p).toMatch(
      /Pre-launch the per-topic pages migrate in incrementally;\s*\n?\/\/ nav stays stable so deep-link bookmarks survive future content\s*\n?\/\/ additions\./,
    );
  });

  it('CRITICAL onboarding 3-card array pinned — Quickstart + SDK installation + License activation. The 3-card set matches W780 guides/index Get-started + W775 SDK index + V-266/V-267 license activation.', () => {
    const p = read(INDEX);

    // Quickstart entry.
    expect(p).toMatch(/label: 'Quickstart',/);
    expect(p).toMatch(
      /Signup → API key → first session in five minutes\. TypeScript, Python, Go\./,
    );
    expect(p).toMatch(/href: '\/quickstart\/',/);

    // SDK installation.
    expect(p).toMatch(/label: 'SDK installation',/);
    expect(p).toMatch(
      /Install \+ configure @driftstack\/sdk \(TS\), driftstack-sdk \(Python\), or sdk-go\./,
    );
    expect(p).toMatch(/href: '\/sdk\/installation\/',/);

    // License activation.
    expect(p).toMatch(/label: 'License activation',/);
    expect(p).toMatch(
      /Activate the desktop GUI client against cloud or self-hosted control planes\./,
    );
    expect(p).toMatch(/href: '\/license-activation\/',/);
  });

  it('CRITICAL guides 2-card array pinned — Profile management + Session lifecycle. Matches W782 + W781 guides anchors.', () => {
    const p = read(INDEX);

    expect(p).toMatch(/label: 'Profile management',/);
    expect(p).toMatch(/Persistent identities — cookies, storage, stealth state across sessions\./);
    expect(p).toMatch(/label: 'Session lifecycle',/);
    expect(p).toMatch(/States, concurrency caps, idle timeout, error shapes, recovery semantics\./);
  });

  it('CRITICAL reference 6-card array pinned — API versioning + Webhook events + SDK versioning + API keys + Webhook replay + Team RBAC. Matches W760 /api index + W762 + W772 + W777 cross-references.', () => {
    const p = read(INDEX);

    const refs: Array<[string, string]> = [
      ['API versioning', '/api/versioning/'],
      ['Webhook events', '/webhooks/events/'],
      ['SDK versioning', '/sdk/versioning/'],
      ['API keys', '/api/api-keys/'],
      ['Webhook replay', '/webhooks/replay/'],
      ['Team RBAC', '/api/team/'],
    ];
    for (const [label, href] of refs) {
      expect(p, `reference ${label}`).toMatch(new RegExp(`label: '${label}'`));
      expect(p, `reference href ${href}`).toMatch(
        new RegExp(`href: '${href.replace(/\//g, '\\/')}'`),
      );
    }
  });

  it("CRITICAL header copy pinned. The 'Reference and guides for integrating with the Driftstack API, using the SDKs, and running the desktop GUI client against cloud or self-hosted control planes' wording is the canonical top-level promise.", () => {
    const p = read(INDEX);

    expect(p).toMatch(
      /Reference and guides for integrating with the Driftstack API, using the SDKs, and running\s*\n?\s+the desktop GUI client against cloud or self-hosted control planes\./,
    );
  });

  it('CRITICAL 3-section heading set pinned — Get started + Concept guides + Reference. Drift would break the V-257 onboarding-path layout.', () => {
    const p = read(INDEX);

    expect(p).toMatch(/<h2>Get started<\/h2>/);
    expect(p).toMatch(/<h2>Concept guides<\/h2>/);
    expect(p).toMatch(/<h2>Reference<\/h2>/);
    expect(p).toMatch(/<h2>Looking for something else\?<\/h2>/);
  });

  it("CRITICAL 'If you have an API key, start here.' framing pinned. Drift would lose the load-bearing get-started anchor.", () => {
    const p = read(INDEX);

    expect(p).toMatch(/<p>If you have an API key, start here\.<\/p>/);
  });

  it("CRITICAL repo-docs/-tree fallback pinned. The 'The canonical source for anything not yet rendered here is the repository docs/ tree' wording matches W780 guides/index pre-launch in-repo cross-reference.", () => {
    const p = read(INDEX);

    expect(p).toMatch(/The canonical source for anything not yet rendered here is the/);
    expect(p).toMatch(
      /href="https:\/\/github\.com\/driftstackdev\/driftstack-api\/tree\/main\/docs"/,
    );
    expect(p).toMatch(/repository <code>docs\/<\/code> tree/);
  });

  it('CRITICAL marketing-site product-page 3-link set pinned — driftstack.dev /pricing + /security + /self-hosted. Drift would lose the load-bearing cross-site nav.', () => {
    const p = read(INDEX);

    expect(p).toMatch(/<a href="https:\/\/driftstack\.dev\/pricing">\/pricing<\/a>/);
    expect(p).toMatch(/<a href="https:\/\/driftstack\.dev\/security">\/security<\/a>/);
    expect(p).toMatch(/<a href="https:\/\/driftstack\.dev\/self-hosted">\/self-hosted<\/a>/);
  });

  it("CRITICAL support email + 'prioritized' framing pinned. Matches W780 guides/index support@driftstack.dev contact channel.", () => {
    const p = read(INDEX);

    expect(p).toMatch(/<a href="mailto:support@driftstack\.dev">support@driftstack\.dev<\/a>/);
    expect(p).toMatch(/if you need a specific\s*\n?\s+page prioritized\./);
  });

  it('CRITICAL DocLayout used with title="Driftstack docs".', () => {
    const p = read(INDEX);

    expect(p).toMatch(/import DocLayout from '\.\.\/layouts\/DocLayout\.astro'/);
    expect(p).toMatch(/<DocLayout title="Driftstack docs">/);
  });

  // ─── 404.astro ────────────────────────────────────────────────

  it("CRITICAL 404 uses BaseLayout (NOT DocLayout) with title='Page not found'. The base-layout choice (no doc sidebar/TOC) is intentional for fall-through navigation.", () => {
    const p = read(NOTFOUND);

    expect(p).toMatch(/import BaseLayout from '\.\.\/layouts\/BaseLayout\.astro'/);
    expect(p).toMatch(/<BaseLayout title="Page not found">/);
  });

  it("CRITICAL 404 framing pinned. The 'The page you\\'re looking for might have moved as the docs site is built out. Try the overview, or check the repository docs/ tree for canonical references' wording is the canonical no-route fallback message.", () => {
    const p = read(NOTFOUND);

    expect(p).toMatch(/<h1 class="text-4xl font-semibold text-ink-primary">Page not found<\/h1>/);
    expect(p).toMatch(
      /The page you're looking for might have moved as the docs site is built out\. Try the/,
    );
    expect(p).toMatch(/<a href="\/" class="text-glow-red hover:underline">overview<\/a>/);
    expect(p).toMatch(
      /href="https:\/\/github\.com\/driftstackdev\/driftstack-api\/tree\/main\/docs"/,
    );
    expect(p).toMatch(/for canonical references\./);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/docs-pages-top-level-content-parity.test.ts'),
      ),
    ).toBe(true);
  });
});
