// Drift guard for apps/docs/src/layouts/DocLayout.astro. Pins the
// V-254 doc-comment + the frontmatter Props contract + the DOC_NAV
// sidebar pattern + the tk-token prose styling + (S22.2 2026-07-06,
// Stoplight relayout) the three-pane shell: left collapsible tree,
// center article with breadcrumbs + prev/next, right sticky
// "On this page" scroll-spy rail + (S22.4 2026-07-06, Stoplight
// reference furniture) the per-endpoint sub-nodes with method chips
// (active resource page only) and the client-side language-tabs
// is:inline script (allowlisted pairwise-distinct runs, json stays
// outside, ds_docs_lang persistence, tablist keyboard semantics).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/docs/src/layouts/DocLayout.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('docs layouts/DocLayout content parity', () => {
  const body = read(PAGE);

  it('file exists at canonical path', () => {
    expect(existsSync(PAGE)).toBe(true);
  });

  it('V-254 doc-comment framing pinned: doc-page layout wraps BaseLayout with sidebar + content; S22.2 three-pane framing pinned (Stoplight pattern — left tree / center article / right rail)', () => {
    expect(body).toMatch(/\/\/ V-254 — doc-page layout\. Wraps BaseLayout with a sidebar nav/);
    expect(body).toMatch(
      /Used as `layout:` frontmatter\s*\/\/ in `\.md` doc pages so markdown content renders into the slot/,
    );
    expect(body).toMatch(/S22\.2 \(2026-07-06\) — Stoplight-style three-pane relayout/);
    expect(body).toMatch(/rendered by the LAYOUT, never injected into the \.md sources/);
  });

  it("Frontmatter Props contract pinned: title (required) + description (optional, overrides BaseLayout default). Drift to a different shape would break every .md page's frontmatter that targets DocLayout", () => {
    expect(body).toMatch(/frontmatter\?: \{ title: string; description\?: string \}/);
    expect(body).toMatch(
      /Frontmatter contract: pages set `title` \(required\), optionally\s*\/\/ `description` \(overrides BaseLayout default\)/,
    );
  });

  it("Dual-source props pattern pinned: 3-source title fallback (frontmatter.title → props.title → 'Driftstack docs'). Drift to a different precedence would surprise both .md and .astro consumers", () => {
    expect(body).toMatch(
      /const title = props\.frontmatter\?\.title \?\? props\.title \?\? 'Driftstack docs';/,
    );
    expect(body).toMatch(
      /const description = props\.frontmatter\?\.description \?\? props\.description;/,
    );
  });

  it('DOC_NAV sidebar pattern pinned: imports from data/nav + renders section.label + nested items with isActive() highlighting. Drift to a different nav source would break the doc-site IA (DOC_NAV stays the SINGLE source — breadcrumbs and prev/next derive from it too)', () => {
    expect(body).toMatch(/import \{ DOC_NAV \} from '\.\.\/data\/nav';/);
    expect(body).toMatch(/DOC_NAV\.map\(\(section\) =>/);
    expect(body).toMatch(/isActive\(item\.href\)/);
  });

  it("isActive() trailing-slash tolerance pinned: matches exact OR trailing-slash variant. Drift to exact-match-only would silently lose highlighting on canonical-with-slash URLs (Astro's default for content collections)", () => {
    expect(body).toMatch(/pathname === href \|\| pathname === href\.replace\(\/\\\/\$\/, ''\)/);
  });

  it('S22.2 three-pane shell pinned: 90rem canvas + md 2-col grid (16rem tree) + xl 3-col grid (15rem rail) — supersedes the max-w-6xl two-column flex shell', () => {
    expect(body).toMatch(
      /mx-auto w-full max-w-\[90rem\] px-6 py-8 md:grid md:grid-cols-\[16rem_minmax\(0,1fr\)\] md:gap-10 xl:grid-cols-\[16rem_minmax\(0,1fr\)_15rem\]/,
    );
    expect(body).not.toMatch(/max-w-6xl gap-8/);
  });

  it('S22.2 left tree pinned: sticky independently-scrolling pane (md-scoped so the mobile overlay stays the scroll container) + <details open> collapsible sections with chevron summary (no-JS-safe) + active item nudged into the pane view (block: nearest)', () => {
    expect(body).toMatch(/md:sticky md:top-6 md:max-h-\[calc\(100vh-3rem\)\] md:overflow-y-auto/);
    expect(body).toMatch(/<details open class="group" data-nav-section>/);
    expect(body).toMatch(/\[&::-webkit-details-marker\]:hidden/);
    expect(body).toMatch(/group-open:rotate-90/);
    expect(body).toMatch(/aside\[data-doc-mobile-nav\] a\[aria-current="page"\]/);
    expect(body).toMatch(/scrollIntoView\(\{ block: 'nearest' \}\)/);
  });

  it('S22.2 breadcrumbs pinned: layout-rendered "section › page" from the DOC_NAV lookup, above the article (never injected into .md)', () => {
    expect(body).toMatch(/const flatNav = DOC_NAV\.flatMap\(\(section\) =>/);
    expect(body).toMatch(
      /const activeIndex = flatNav\.findIndex\(\(item\) => isActive\(item\.href\)\);/,
    );
    expect(body).toMatch(/aria-label="Breadcrumb"/);
    expect(body).toMatch(/\{active\.section\}/);
    expect(body).toMatch(/\{active\.label\}/);
  });

  it('S22.2 prev/next pager pinned: flattened DOC_NAV order, tk-styled cards at the article foot', () => {
    expect(body).toMatch(
      /const prevItem = activeIndex > 0 \? flatNav\[activeIndex - 1\] : undefined;/,
    );
    expect(body).toMatch(
      /activeIndex !== -1 && activeIndex < flatNav\.length - 1 \? flatNav\[activeIndex \+ 1\] : undefined;/,
    );
    expect(body).toMatch(/aria-label="Previous and next pages"/);
    expect(body).toMatch(/\{prevItem\.label\}/);
    expect(body).toMatch(/\{nextItem\.label\}/);
  });

  it('S22.2 right rail pinned: sticky ≥xl "On this page" nav ([data-toc]) populated by the scroll-spy script — REPLACES the old inline-injected TOC box (insertBefore into the article must NOT come back)', () => {
    expect(body).toMatch(/data-toc\s*aria-label="On this page"/);
    expect(body).toMatch(/sticky top-6 hidden max-h-\[calc\(100vh-3rem\)\] overflow-y-auto/);
    expect(body).toMatch(/data-toc-list/);
    expect(body).toMatch(/IntersectionObserver/);
    expect(body).toMatch(/prefers-reduced-motion: reduce/);
    expect(body).not.toMatch(/article\.insertBefore\(nav, firstH2\)/);
  });

  it('tk-token prose styling pinned (S22.1 2026-07-06, brand-parity port — SUPERSEDES the R11 "prose-slate + prose-pre:bg-[#16171c]" pin; S22.2 dropped flex-1 since the grid column sizes the pane): single `prose` class set whose color hooks are un-layered --tw-prose-* overrides in base.css reading the mode-scoped tk tokens. Still NOT prose-invert (no mode-flip class swap), and fenced code stays a DARK terminal in BOTH modes via --tw-prose-pre-bg: var(--code-bg) — the founder flagged light code backgrounds as ugly, so that invariant carries over from the light theme unchanged', () => {
    expect(body).toMatch(/S22\.1 \(2026-07-06, brand-parity port\) — tk-token-driven prose/);
    expect(body).toMatch(/prose max-w-3xl/);
    expect(body).not.toMatch(/prose-invert/);
    expect(body).not.toMatch(/prose-slate/);
    // inline code = accent-soft WASH chip (background token only, never text).
    expect(body).toMatch(/prose-code:bg-tk-accent-soft/);
    // fenced code dark in BOTH modes (hook lives in base.css; the layout
    // documents it and must not reintroduce a light pre background).
    expect(body).toMatch(/--tw-prose-pre-bg: var\(--code-bg\)/);
    expect(body).toMatch(/prose-pre:border prose-pre:border-tk-border/);
    expect(body).not.toMatch(/prose-pre:bg-\[#f/);
  });

  it('S22.1 (2026-07-06) — tk sidebar + mobile chrome pinned: active item = accent-soft wash bg + AA-safe accent-text ink (never raw accent as text); inactive hover = tk-hover; mode-aware mobile overlay scrim rgb(var(--bg-rgb) / 0.95) (was a baked near-black rgba)', () => {
    expect(body).toMatch(/'bg-tk-accent-soft text-tk-accent-text'/);
    expect(body).toMatch(/'text-tk-ink-2 hover:bg-tk-hover hover:text-tk-ink'/);
    expect(body).toMatch(/background: rgb\(var\(--bg-rgb\) \/ 0\.95\);/);
    expect(body).not.toMatch(/rgba\(11, 11, 13/);
  });

  it('S22.4 (2026-07-06) — per-endpoint sub-nodes pinned: DOC_NAV children render under the parent ONLY while it is the active page (Stoplight behavior), each with a base.css .method-chip badge (chip text is real content, screen readers announce "GET List") + a truncating label; breadcrumbs/prev-next stay top-level-only (flatNav maps section.items untouched)', () => {
    expect(body).toMatch(/item\.children && isActive\(item\.href\) && \(/);
    expect(body).toMatch(/data-nav-endpoints/);
    expect(body).toMatch(/item\.children\.map\(\(child\) => \(/);
    expect(body).toMatch(/'method-chip method-chip--' \+ child\.method\.toLowerCase\(\)/);
    expect(body).toMatch(/\{child\.method\}/);
    expect(body).toMatch(/<span class="min-w-0 truncate">\{child\.label\}<\/span>/);
    // flatNav (breadcrumbs + prev/next source) still walks top-level
    // items only — children must never leak into the pager.
    expect(body).toMatch(
      /section\.items\.map\(\(item\) => \(\{ section: section\.label, href: item\.href, label: item\.label \}\)\)/,
    );
  });

  it('S22.4 (2026-07-06) — language-tabs is:inline script pinned: allowlist canon (ts/typescript, js, python/py, go, bash/sh, http — json NOT allowlisted so response blocks stay outside), pairwise-distinct runs (duplicate language ends the run), single **Lang:** label paragraphs absorbed+hidden, role=tablist/tab/tabpanel with arrow-key selection, ds_docs_lang localStorage persistence applied page-wide, runs AFTER the copy-button script so moved pres keep their buttons, and PLAIN RAW code (dead-inline-script trap documented)', () => {
    expect(body).toMatch(/S22\.4 — client-side language tabs/);
    expect(body).toMatch(/var CANON = \{/);
    expect(body).toMatch(/ts: 'TypeScript',/);
    expect(body).toMatch(/typescript: 'TypeScript',/);
    expect(body).toMatch(/python: 'Python',/);
    expect(body).toMatch(/py: 'Python',/);
    expect(body).toMatch(/go: 'Go',/);
    expect(body).toMatch(/bash: 'bash',/);
    expect(body).toMatch(/sh: 'bash',/);
    expect(body).toMatch(/http: 'HTTP',/);
    expect(body).not.toMatch(/json: '/); // json must never join the allowlist
    expect(body).toMatch(/var STORE_KEY = 'ds_docs_lang';/);
    expect(body).toMatch(/getAttribute\('data-language'\)/);
    expect(body).toMatch(/if \(seen\[nl\]\) break;/); // pairwise-distinct
    expect(body).toMatch(/isLangLabelFor/);
    expect(body).toMatch(/r\.label\.hidden = true;/);
    expect(body).toMatch(/setAttribute\('role', 'tablist'\)/);
    expect(body).toMatch(/setAttribute\('role', 'tab'\)/);
    expect(body).toMatch(/setAttribute\('role', 'tabpanel'\)/);
    expect(body).toMatch(/aria-label', 'Code sample language'/);
    expect(body).toMatch(/e\.key === 'ArrowRight'/);
    expect(body).toMatch(/e\.key === 'ArrowLeft'/);
    expect(body).toMatch(/data-langtabs/);
    expect(body).toMatch(/if \(run\.length < 2\) return;/); // zero multi-lang runs → no tab UI
    expect(body).toMatch(/Runs in document order AFTER the copy-button script/);
    expect(body).toMatch(/dead-inline-script\s*\**\s*trap/);
  });

  it('S22.3 (2026-07-06) — data-pagefind-body on the ARTICLE pinned: scopes the Pagefind search index to article content only (once any page carries the attribute, everything without it — header, tree, TOC rail, footer, breadcrumbs, prev/next, the 404 page — stays out of the index, so chrome text never pollutes search results). Drift to dropping it would silently flip Pagefind to whole-page indexing of every route', () => {
    expect(body).toMatch(/<article\s*data-pagefind-body\s*class="prose max-w-3xl/);
  });

  it("S35 2026-07-07 (fable-frontend-audit) — TOC labels read the heading's FULL text pinned: clone the heading, remove the appended [data-anchor] '#' link, then read textContent. The old h.firstChild.textContent read truncated any heading that STARTS with inline code to just that first element (18 of 30 rail entries on /webhooks/events lost everything after the code span, including [LIVE]/[PLANNED] tags)", () => {
    expect(body).toMatch(/var labelSource = h\.cloneNode\(true\);/);
    expect(body).toMatch(/labelSource\.querySelector\('\[data-anchor\]'\)/);
    expect(body).toMatch(
      /var label = \(labelSource\.textContent \|\| ''\)\.replace\(\/#\$\/, ''\)\.trim\(\);/,
    );
    // The first-text-node truncation must never come back.
    expect(body).not.toMatch(/h\.firstChild \? h\.firstChild\.textContent/);
  });

  it("S35 2026-07-07 (fable-frontend-audit) — scroll-spy re-sync pinned: the spy resolution is a callable resolveSpy() (IO callback + hashchange both use it), rail clicks setActive(h.id) directly after pushState (pushState fires no hashchange and an instant jump may cross no observed heading), and real hash navigations highlight the named heading when it's a rail entry, else re-run the positional spy", () => {
    expect(body).toMatch(/function resolveSpy\(\) \{/);
    expect(body).toMatch(
      /history\.pushState\(null, '', '#' \+ h\.id\);[\s\S]{0,400}?setActive\(h\.id\);/,
    );
    expect(body).toMatch(/window\.addEventListener\('hashchange', function \(\) \{/);
    expect(body).toMatch(
      /if \(id && linkById\[id\]\) setActive\(id\);\s*\n\s*else if \(id\) resolveSpy\(\);/,
    );
    // The below-96px positional fallback survives inside resolveSpy.
    expect(body).toMatch(/getBoundingClientRect\(\)\.top < 96/);
  });
});
