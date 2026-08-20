// V-1172 — a link that carries a `#fragment` has to land on a heading that exists.
//
// Two guards already check internal links, and BOTH throw the fragment away before
// checking anything:
//
//   site-internal-links-resolve      `const href = (raw.split('#')[0] ?? '')…`
//   docs-internal-links-parity       `href.replace(/[?#].*$/, '')`
//
// That is correct for what they own — they answer "does the PAGE exist". Nobody asked
// whether the anchor does. A broken fragment does not 404; the browser silently leaves the
// reader at the top of the document. On a 500-line DPA that is worse than a dead link,
// because the reader believes they are looking at the clause they asked for.
//
// Three were broken, all in the internal mirror under `docs/legal/`:
//
//   definitions.md    privacy-policy.md#sub-processors   heading is `## 7. Sub-processors`
//                                                        → `#7-sub-processors`
//   definitions.md    dpa.md#annex-3-sub-processors      one dash; the em-dash in
//                                                        `## Annex 3 — Sub-processors`
//                                                        leaves TWO → `#annex-3--sub-processors`
//   privacy-policy.md dpa.md#annex-2-tom                 an abbreviation that was never a
//                                                        slug of anything
//
// The published mirror had all three RIGHT — `/legal/privacy/#7-sub-processors`,
// `#annex-2--technical-and-organisational-measures-toms`. The internal copy of
// `privacy-policy.md` and the published `privacy.md` carry the same sentence byte for byte
// and diverge only inside the parentheses. So this is not a document that was never
// checked; it is two mirrors of one document that drifted where nothing was looking.
//
// ── Why the slug is derived and not pinned, and how the derivation is trusted ──
//
// Reading `dist/` would give the true ids, and would also pass against a stale build —
// dist-reading tests are a known false signal here. So the slug is derived from the source
// heading instead, and the derivation is held honest two ways: the first arm pins
// heading→slug pairs that were verified against the shipped HTML at the time of writing,
// and the second arm requires specific links to be FOUND before it reports the broken set
// empty. Checked while writing: over the 40 headings of the DPA, this derivation reproduced
// the 40 shipped ids exactly, with no id in one set and not the other.
//
// The em-dash is the whole story of two of the three. `Annex 3 — Sub-processors` is not
// punctuation-then-space, it is space-dash-space, and dropping the dash leaves the two
// spaces that become two hyphens. Every hand-written `#annex-N-…` anchor in this repo got
// that wrong; every generated one got it right.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

/** Markdown roots that ship, plus the internal legal mirror that is their canonical draft. */
const ROOTS = ['docs', 'apps/marketing-site/src/pages', 'apps/docs/src/pages'] as const;

/** Public origin → the pages directory that builds it, so cross-surface links are checkable. */
const ORIGINS: ReadonlyArray<readonly [string, string]> = [
  ['https://driftstack.dev', 'apps/marketing-site/src/pages'],
  ['https://docs.driftstack.dev', 'apps/docs/src/pages'],
];

const LINK = /\]\(([^)\s]*)#([^)\s]+)\)/g;
const HEADING = /^#{1,6}\s+(.+?)\s*$/gm;

/**
 * The GitHub/Astro heading slug: strip inline markup, lowercase, drop everything that is
 * not word/space/hyphen, then spaces to hyphens. Punctuation is REMOVED rather than
 * replaced, which is why ` — ` collapses to `--` and not to `-`.
 */
export function slug(text: string): string {
  return text
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*\*|__|\*/g, '')
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s/g, '-');
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.mdx?$/.test(entry)) out.push(full);
  }
  return out;
}

/** Every markdown file under the roots, keyed by repo-relative path → its heading slugs. */
function corpus(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const root of ROOTS) {
    for (const abs of walk(resolve(REPO_ROOT, root))) {
      const rel = abs.slice(REPO_ROOT.length + 1);
      const body = readFileSync(abs, 'utf8');
      out.set(rel, new Set([...body.matchAll(HEADING)].map((m) => slug(m[1] ?? ''))));
    }
  }
  return out;
}

/** A site path (`/legal/privacy/`) or a relative one (`dpa.md`) → the file that serves it. */
function targetFile(
  from: string,
  root: string,
  path: string,
  files: Map<string, Set<string>>,
): string | null {
  if (path === '') return from;
  if (path.startsWith('/')) {
    const base = `${root}/${path.replace(/^\/|\/$/g, '')}`;
    for (const cand of [`${base}.md`, `${base}.mdx`, `${base}/index.md`]) {
      if (files.has(cand)) return cand;
    }
    return null;
  }
  const cand = normalize(join(dirname(from), path));
  return files.has(cand) ? cand : null;
}

interface Anchor {
  from: string;
  path: string;
  frag: string;
  target: string;
}

function anchors(): { checked: Anchor[]; broken: string[]; skipped: string[] } {
  const files = corpus();
  const checked: Anchor[] = [];
  const broken: string[] = [];
  const skipped: string[] = [];

  for (const root of ROOTS) {
    for (const [rel, _heads] of files) {
      if (!rel.startsWith(`${root}/`)) continue;
      void _heads;
      for (const m of readFileSync(resolve(REPO_ROOT, rel), 'utf8').matchAll(LINK)) {
        const path = m[1] ?? '';
        const frag = m[2] ?? '';
        if (path.startsWith('mailto:')) continue;

        let target: string | null = null;
        if (path.startsWith('http')) {
          const origin = ORIGINS.find(([o]) => path.startsWith(o));
          // A third-party anchor is somebody else's document; not checkable here.
          if (origin === undefined) continue;
          target = targetFile(rel, origin[1], path.slice(origin[0].length) || '/', files);
          if (target === null) {
            skipped.push(`${rel}: own-site page not found for ${path}`);
            continue;
          }
        } else {
          target = targetFile(rel, root, path, files);
          if (target === null) {
            // Page existence is `site-internal-links-resolve`'s claim, not this one.
            skipped.push(`${rel}: page not found for ${path}`);
            continue;
          }
        }

        checked.push({ from: rel, path, frag, target });
        if (!(files.get(target) ?? new Set()).has(frag)) {
          broken.push(`${rel} → ${path}#${frag} (no such heading in ${target})`);
        }
      }
    }
  }
  return { checked, broken, skipped };
}

describe('V-1172 every anchor link lands on a heading', () => {
  it('CRITICAL the slug derivation reproduces what the site actually publishes. These pairs were verified against the shipped HTML; the em-dash one is the whole finding, because ` — ` is a space-dash-space that collapses to TWO hyphens and every hand-written anchor in this repo assumed one.', () => {
    expect(slug('Annex 3 — Sub-processors')).toBe('annex-3--sub-processors');
    expect(slug('Annex 2 — Technical and Organisational Measures (TOMs)')).toBe(
      'annex-2--technical-and-organisational-measures-toms',
    );
    expect(slug('7. Sub-processors')).toBe('7-sub-processors');
    expect(slug('3.1 Account data')).toBe('31-account-data');
    expect(slug('9. Retention')).toBe('9-retention');
    // A single hyphen stays single: the doubling is caused by the surrounding spaces,
    // not by the dash character, and confusing the two would make the guard wrong in the
    // forgiving direction.
    expect(slug('Customer-Connected Services')).toBe('customer-connected-services');
  });

  it('CRITICAL the scan finds the anchor links it is meant to check, across all three surfaces and both link syntaxes. A resolver that silently matched nothing would report every anchor honest — so this names links that must be present rather than counting how many were, and requires the cross-surface case that two guards before this one skipped.', () => {
    const { checked, skipped } = anchors();
    expect(
      checked.length,
      'no anchor links extracted — the corpus or the pattern moved',
    ).toBeGreaterThan(40);
    expect(skipped, 'anchor links whose target page could not be located').toEqual([]);

    const keys = checked.map((a) => `${a.from} → ${a.path}#${a.frag}`);
    expect(keys.join('\n'), 'the internal relative-link case is gone').toContain(
      'docs/legal/definitions.md → dpa.md#annex-3--sub-processors',
    );
    expect(keys.join('\n'), 'the site-absolute case is gone').toContain(
      '#annex-2--technical-and-organisational-measures-toms',
    );
    expect(keys.join('\n'), 'the cross-surface docs→marketing case is gone').toContain(
      'https://driftstack.dev/legal/privacy/#31-account-data',
    );
  });

  it('CRITICAL every `#fragment` link in the markdown corpus lands on a heading that exists. A broken fragment does not 404 — it drops the reader at the top of the document, which on a 500-line DPA reads as "this is the clause you asked for".', () => {
    expect(anchors().broken.sort(), 'anchor links pointing at headings that do not exist').toEqual(
      [],
    );
  });

  it('CRITICAL the internal legal mirror still carries the anchors its published twin does. `privacy-policy.md` and the published `privacy.md` hold the same sentence byte for byte and drifted only inside the parentheses — which is how three anchors went wrong in the copy nobody renders.', () => {
    const defs = readFileSync(resolve(REPO_ROOT, 'docs/legal/definitions.md'), 'utf8');
    const priv = readFileSync(resolve(REPO_ROOT, 'docs/legal/privacy-policy.md'), 'utf8');

    expect(defs).toContain('(privacy-policy.md#7-sub-processors)');
    expect(defs).toContain('(dpa.md#annex-3--sub-processors)');
    expect(priv).toContain('(dpa.md#annex-2--technical-and-organisational-measures-toms)');

    expect(defs, 'the sub-processor anchor dropped its section number again').not.toMatch(
      /\(privacy-policy\.md#sub-processors\)/,
    );
    expect(defs, 'the annex anchor collapsed to a single hyphen again').not.toMatch(
      /\(dpa\.md#annex-3-sub-processors\)/,
    );
    expect(priv, 'the TOMs anchor went back to an abbreviation').not.toMatch(
      /\(dpa\.md#annex-2-tom\)/,
    );
  });
});
