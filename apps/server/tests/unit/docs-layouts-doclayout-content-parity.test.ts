// Drift guard for apps/docs/src/layouts/DocLayout.astro. Pins the
// V-254 doc-comment + the frontmatter Props contract + the DOC_NAV
// sidebar pattern + the R11 prose-invert dark-surface styling.

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

  it('V-254 doc-comment framing pinned: doc-page layout wraps BaseLayout with sidebar + content. Drift would orphan the engineering anchor for the doc-layout split', () => {
    expect(body).toMatch(/\/\/ V-254 — doc-page layout\. Wraps BaseLayout with a sidebar nav/);
    expect(body).toMatch(
      /Used as `layout:` frontmatter\s*\n?\s*\/\/ in `\.md` doc pages so markdown content renders into the slot/,
    );
  });

  it("Frontmatter Props contract pinned: title (required) + description (optional, overrides BaseLayout default). Drift to a different shape would break every .md page's frontmatter that targets DocLayout", () => {
    expect(body).toMatch(/frontmatter\?: \{ title: string; description\?: string \}/);
    expect(body).toMatch(
      /Frontmatter contract: pages set `title` \(required\), optionally\s*\n?\s*\/\/ `description` \(overrides BaseLayout default\)/,
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

  it('DOC_NAV sidebar pattern pinned: imports from data/nav + renders section.label + nested items with isActive() highlighting. Drift to a different nav source would break the doc-site IA', () => {
    expect(body).toMatch(/import \{ DOC_NAV \} from '\.\.\/data\/nav';/);
    expect(body).toMatch(/DOC_NAV\.map\(\(section\) =>/);
    expect(body).toMatch(/isActive\(item\.href\)/);
  });

  it("isActive() trailing-slash tolerance pinned: matches exact OR trailing-slash variant. Drift to exact-match-only would silently lose highlighting on canonical-with-slash URLs (Astro's default for content collections)", () => {
    expect(body).toMatch(/pathname === href \|\| pathname === href\.replace\(\/\\\/\$\/, ''\)/);
  });

  it('tk-token prose styling pinned (S22.1 2026-07-06, brand-parity port — SUPERSEDES the R11 "prose-slate + prose-pre:bg-[#16171c]" pin): single `prose` class set whose color hooks are un-layered --tw-prose-* overrides in base.css reading the mode-scoped tk tokens. Still NOT prose-invert (no mode-flip class swap), and fenced code stays a DARK terminal in BOTH modes via --tw-prose-pre-bg: var(--code-bg) — the founder flagged light code backgrounds as ugly, so that invariant carries over from the light theme unchanged', () => {
    expect(body).toMatch(/S22\.1 \(2026-07-06, brand-parity port\) — tk-token-driven prose/);
    expect(body).toMatch(/prose max-w-3xl flex-1/);
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
});
