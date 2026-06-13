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

  it('Fleet light prose styling pinned: plain prose-slate (no prose-invert) + DARK fenced code (#16171c) — the founder flagged light code backgrounds as ugly, so fenced code stays dark on the light docs theme', () => {
    expect(body).toMatch(/Fleet rebrand — prose styling for the LIGHT surface/);
    expect(body).toMatch(/prose prose-slate/);
    expect(body).not.toMatch(/prose-invert/);
    expect(body).toMatch(/prose-code:bg-oxblood-100/);
    expect(body).toMatch(/prose-pre:bg-\[#16171c\]/);
  });
});
