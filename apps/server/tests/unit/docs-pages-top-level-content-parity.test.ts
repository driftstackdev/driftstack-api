// W784 — apps/docs index.astro + 404.astro content parity. One-
// hundred-tenth in the cross-SDK drift-guard series. Pins the top-
// level docs landing + 404 fallback.
//
// Drift to the V-254 / V-257 onboarding-path framing (kept as the
// historical layout-rationale comment) or the S22.5 landing structure
// (plain-words hero + pick-your-path band + DOC_NAV-derived section
// cards) would erode the customer-discovery flow.

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

  // S22.5 (2026-07-06, Stoplight redesign final slice) — the V-257
  // onboarding/guides/reference card grids are SUPERSEDED by a
  // "pick your path" band + DOC_NAV-derived section cards. The three
  // V-257 destinations (quickstart / SDK / license activation) stay
  // first-click reachable: quickstart + license-activation as path
  // cards + the hero CTA, the SDK pages via the SDKs section card
  // (/sdk/ links installation) and the left tree on every page. The
  // per-card facts kept their pins with their pages (24h key-rotation
  // grace → /api/api-keys/ pins; team roles → /api/team/ pins; recipes
  // v1.0/v1.1 scope → /api/ index, see
  // docs-pages-homepage-index-content-parity).

  it("CRITICAL S22.5 pick-your-path band pinned — 'Drive it by hand' (/license-activation/) + 'Drive it from code' (/quickstart/) + 'Look something up' (/api/), plain words leading with a mono aside naming the technical resource. Supersedes the V-257 onboarding 3-card set.", () => {
    const p = read(INDEX);

    expect(p).toMatch(/^const paths = \[/m);

    // By hand → GUI client / license activation.
    expect(p).toMatch(/label: 'Drive it by hand',/);
    expect(p).toMatch(/mono: 'GUI client · license activation',/);
    expect(p).toMatch(/href: '\/license-activation\/',/);

    // From code → quickstart / SDK.
    expect(p).toMatch(/label: 'Drive it from code',/);
    expect(p).toMatch(/mono: 'quickstart · @driftstack\/sdk',/);
    expect(p).toMatch(/href: '\/quickstart\/',/);

    // Look something up → API reference (+ the ⌘K search gloss).
    expect(p).toMatch(/label: 'Look something up',/);
    expect(p).toMatch(/mono: 'API reference · \/v1\/\*',/);
    expect(p).toMatch(/href: '\/api\/',/);
    expect(p).toMatch(/press ⌘K anywhere and search every page at once\./);
  });

  it('CRITICAL S22.5 DOC_NAV-derived section cards pinned — index imports DOC_NAV, maps every section (label/href/page-count from the tree source), and sectionIntros carries a plain one-liner for all 7 tree sections. Supersedes the hand-kept guides/reference card grids; lockstep with doc-nav-section-label-baseline.', () => {
    const p = read(INDEX);

    expect(p).toMatch(/import \{ DOC_NAV \} from '\.\.\/data\/nav';/);
    expect(p).toMatch(/const sections = DOC_NAV\.map\(\(s\) => \(\{/);
    expect(p).toMatch(/count: s\.items\.length,/);
    expect(p).toMatch(/intro: sectionIntros\[s\.label\] \?\? '',/);

    // Every DOC_NAV section label has a plain description entry.
    expect(p).toMatch(/^const sectionIntros: Record<string, string> = \{/m);
    expect(p).toMatch(/^\s+Overview: '/m);
    expect(p).toMatch(/^\s+'Get started':/m);
    expect(p).toMatch(/^\s+Guides:\n?\s*'/m);
    expect(p).toMatch(/^\s+SDKs: '/m);
    expect(p).toMatch(/^\s+'API reference': '/m);
    expect(p).toMatch(/^\s+Webhooks:\n?\s*'/m);
    expect(p).toMatch(/^\s+'Platform reference':/m);

    // The intro-tier gloss discipline: idempotency never ships unglossed.
    expect(p).toMatch(/safe retries \(idempotency\)/);
  });

  it('CRITICAL S22.5 hero affordances pinned — Quickstart CTA (btn-primary → /quickstart/) + search button ([data-search-open], reusing the S22.3 BaseLayout Pagefind modal — NOT a second search implementation) with the [data-search-kbd] ⌘K hint the BaseLayout script swaps to "Ctrl K" off-Apple.', () => {
    const p = read(INDEX);

    expect(p).toMatch(
      /<a href="\/quickstart\/" class="btn-primary">Start in about five minutes<\/a>/,
    );
    expect(p).toMatch(/data-search-open/);
    expect(p).toMatch(/aria-label="Search docs"/);
    expect(p).toMatch(/aria-haspopup="dialog"/);
    expect(p).toMatch(/data-search-kbd/);
    expect(p).toMatch(/<span>Search the docs<\/span>/);
  });

  it("CRITICAL S22.5 plain-words hero copy pinned. 'Driftstack gives you real iPhones in the cloud. These docs show you how to drive them…' — plain words lead (intro-tier plain-language mandate), matching the marketing-site 'real iPhones in the cloud' register; the AI path names the precise resource (agent sessions). Supersedes the 'Reference and guides for integrating…' header copy.", () => {
    const p = read(INDEX);

    expect(p).toMatch(
      /Driftstack gives you real iPhones in the cloud\. These docs show you how to drive them —/,
    );
    expect(p).toMatch(/by hand from the desktop app, from code in TypeScript, Python, or Go,/);
    expect(p).toMatch(/an AI agent \(<a href="\/api\/agent-sessions\/">agent sessions<\/a>\)\./);
  });

  it('CRITICAL current 3-section heading set pinned — Pick your path + Browse the docs + Need help?. Supersedes the V-257 Get started / Concept guides / Reference set.', () => {
    const p = read(INDEX);

    expect(p).toMatch(/<h2>Pick your path<\/h2>/);
    expect(p).toMatch(/<h2>Browse the docs<\/h2>/);
    expect(p).toMatch(/<h2>Need help\?<\/h2>/);
  });

  it("CRITICAL S22.5 band lead-ins pinned. 'Three ways people arrive here. Start with the one that sounds like you.' + 'Every page on this site, grouped the same way as the sidebar tree.' — supersedes the 'If you have an API key, start here.' anchor.", () => {
    const p = read(INDEX);

    expect(p).toMatch(
      /<p>Three ways people arrive here\. Start with the one that sounds like you\.<\/p>/,
    );
    expect(p).toMatch(
      /<p>Every page on this site, grouped the same way as the sidebar tree\.<\/p>/,
    );
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

    expect(p).toMatch(/<a href="https:\/\/driftstack\.dev\/pricing\/">\/pricing<\/a>/);
    expect(p).toMatch(/<a href="https:\/\/driftstack\.dev\/security\/">\/security<\/a>/);
    expect(p).toMatch(/<a href="https:\/\/driftstack\.dev\/self-hosted\/">\/self-hosted<\/a>/);
    expect(p).not.toMatch(/href="https:\/\/driftstack\.dev\/(?:pricing|security|self-hosted)"/);
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

    // S22.1 (2026-07-06) — tk-* tokens: heading ink + AA-safe accent-text
    // links (was text-ink-primary / the legacy glow-red alias).
    expect(p).toMatch(/<h1 class="text-4xl font-semibold text-tk-ink">Page not found<\/h1>/);
    expect(p).toMatch(
      /The page you're looking for might have moved as the docs site is built out\. Try the/,
    );
    expect(p).toMatch(/<a href="\/" class="text-tk-accent-text hover:underline">overview<\/a>/);
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
