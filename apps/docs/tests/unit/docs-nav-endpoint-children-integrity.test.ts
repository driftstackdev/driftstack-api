// S22.4 (2026-07-06, Stoplight reference furniture) — drift guard for the
// per-endpoint anchor sub-nodes in DOC_NAV.
//
// nav.ts carries a static `children` array per API-reference resource
// entry (one `{ href, label, method }` per documented endpoint, in page
// order). That data was EXTRACTED from the api/*.md sources, so this
// suite re-derives it from those sources with the same rules and
// deep-equals the result — an .md heading edit, a new/removed endpoint
// section, or a hand-typo'd anchor fails here until nav.ts is
// regenerated in lockstep.
//
// Extraction rules (shared with the S22.4 generator):
//  A) an h2 is an ENDPOINT section iff its DIRECT content (between the
//     h2 and the first h3 / next h2, fenced code stripped) contains a
//     paragraph-start `METHOD /path` inline-code declaration line
//     (previous line blank or the heading itself). Paragraph-start
//     excludes wrapped mid-sentence continuation lines; the h3 cutoff
//     excludes multi-step flow sections (oauth "The flow", mfa
//     "Enrollment", agent-sessions "Pair-mode takeover + handback")
//     whose declarations belong to h3 steps — those h2s are not ONE
//     endpoint and get no sub-node.
//  B) OR the h2 heading itself embeds the method as "<label> — METHOD
//     /path" (the api/status page format; the tail is stripped from the
//     sub-node label).
// Anchor slugs are computed with github-slugger over ALL headings in
// page order (stateful, so dedup suffixes match) — the same slugger
// rehype-slug uses to render heading ids, mirroring
// docs-anchor-link-integrity.

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import GithubSlugger from 'github-slugger';
import { DOC_NAV } from '../../src/data/nav';
import type { DocNavChild } from '../../src/data/nav';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const API_DIR = resolve(REPO_ROOT, 'apps/docs/src/pages/api');

// Strip the inline markdown rehype removes before slugging (mirrors
// docs-anchor-link-integrity.test.ts).
function headingText(raw: string): string {
  return raw
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]*)\*\*/g, '$1')
    .replace(/\*([^*]*)\*/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .trim();
}

function extractEndpoints(mdFile: string, hrefBase: string): DocNavChild[] {
  const lines = readFileSync(mdFile, 'utf8').split('\n');
  const inFence: boolean[] = new Array(lines.length).fill(false);
  let fence = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^```/.test(lines[i]!)) {
      inFence[i] = true;
      fence = !fence;
      continue;
    }
    inFence[i] = fence;
  }
  const slugger = new GithubSlugger();
  const headings: { line: number; level: number; text: string; slug: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (inFence[i]) continue;
    const m = /^(#{1,6})\s+(.+?)\s*$/.exec(lines[i]!);
    if (!m) continue;
    const text = headingText(m[2]!);
    headings.push({ line: i, level: m[1]!.length, text, slug: slugger.slug(text) });
  }
  const out: DocNavChild[] = [];
  for (const h of headings.filter((x) => x.level === 2)) {
    // B) heading-embedded method.
    const hm = /^(.+?)\s+—\s+(GET|POST|PUT|PATCH|DELETE)\s+(\/\S+)$/.exec(h.text);
    if (hm) {
      out.push({
        href: `${hrefBase}#${h.slug}`,
        label: hm[1]!,
        method: hm[2] as DocNavChild['method'],
      });
      continue;
    }
    // A) paragraph-start declaration in the h2's direct content.
    const after = headings.filter((x) => x.line > h.line);
    const nextH2 = after.find((x) => x.level === 2);
    const sectionEnd = nextH2 ? nextH2.line : lines.length;
    const firstH3 = after.find((x) => x.level >= 3 && x.line < sectionEnd);
    const scanEnd = firstH3 ? firstH3.line : sectionEnd;
    for (let i = h.line + 1; i < scanEnd; i++) {
      if (inFence[i]) continue;
      const dm = /^`(GET|POST|PUT|PATCH|DELETE)\s+[^`]+`/.exec(lines[i]!);
      if (dm && (i === h.line + 1 || lines[i - 1]!.trim() === '')) {
        out.push({
          href: `${hrefBase}#${h.slug}`,
          label: h.text,
          method: dm[1] as DocNavChild['method'],
        });
        break;
      }
    }
  }
  return out;
}

const apiSection = DOC_NAV.find((s) => s.label === 'API reference');

describe('S22.4 DOC_NAV endpoint children ↔ api/*.md integrity', () => {
  it('the API reference section exists', () => {
    expect(apiSection).toBeDefined();
  });

  it('every api/*.md endpoint set matches its nav children EXACTLY (href = page + # + rehype slug, label = h2 text, method = declared method, page order)', () => {
    const mismatches: { page: string; expected: DocNavChild[]; actual: DocNavChild[] }[] = [];
    for (const file of readdirSync(API_DIR)
      .filter((f) => f.endsWith('.md'))
      .sort()) {
      const hrefBase = `/api/${file.replace(/\.md$/, '')}/`;
      const expected = extractEndpoints(resolve(API_DIR, file), hrefBase);
      const item = apiSection?.items.find((i) => i.href === hrefBase);
      const actual = item?.children ?? [];
      if (JSON.stringify(expected) !== JSON.stringify(actual)) {
        mismatches.push({ page: hrefBase, expected, actual });
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('zero-endpoint api pages (api overview + versioning) and every NON-API item carry NO children — sub-nodes are an API-reference-resource affordance only', () => {
    const offenders: string[] = [];
    for (const section of DOC_NAV) {
      for (const item of section.items) {
        if (section.label === 'API reference') continue;
        if (item.children !== undefined) offenders.push(`${section.label} → ${item.href}`);
      }
    }
    for (const href of ['/api/', '/api/versioning/']) {
      const item = apiSection?.items.find((i) => i.href === href);
      if (item?.children !== undefined) offenders.push(`API reference → ${href}`);
    }
    expect(offenders).toEqual([]);
  });

  it('children hrefs all extend their parent href with a #fragment and never introduce new pages (prev/next + breadcrumbs walk top-level items only)', () => {
    const offenders: string[] = [];
    for (const section of DOC_NAV) {
      for (const item of section.items) {
        for (const child of item.children ?? []) {
          if (!child.href.startsWith(`${item.href}#`)) offenders.push(child.href);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the tree carries a substantial endpoint census (108 as of S22.4 — drops mean endpoint sections went missing from the md or nav)', () => {
    const total = (apiSection?.items ?? []).reduce((n, i) => n + (i.children?.length ?? 0), 0);
    expect(total).toBe(108);
  });
});
