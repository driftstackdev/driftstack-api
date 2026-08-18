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
// S27 (2026-07-07, docs reference hygiene) — the sweep is extended to
// the WEBHOOKS section pages (webhooks/*.md; endpoints + replay carry
// children, events is a catalog with zero endpoint h2s), and the md
// defects the S22.4 extraction had to special-case are fixed at the
// source: api/status's heading-embedded methods are normalized to
// declaration lines (rule B is now a vestigial guard — no page uses
// the format), and the flow-step endpoints that used to hide under h3
// steps (oauth authorize/complete/token, mfa enroll/verify, auth
// cli-authorize initiate/bind/exchange, agent-sessions
// takeover/handback/resume) are promoted to h2 sections, so they get
// real sub-nodes.
//
// Extraction rules (shared with the S22.4 generator):
//  A) an h2 is an ENDPOINT section iff its DIRECT content (between the
//     h2 and the first h3 / next h2, fenced code stripped) contains a
//     paragraph-start `METHOD /path` inline-code declaration line
//     (previous line blank or the heading itself). Paragraph-start
//     excludes wrapped mid-sentence continuation lines; the h3 cutoff
//     keeps any future multi-step flow section (declarations under h3
//     steps) from being mislabeled as ONE endpoint — as of S27 no
//     api/webhooks page has such a section, prose flow INTROS (oauth
//     "The flow", mfa "Enrollment") simply have no declaration line.
//  B) OR the h2 heading itself embeds the method as "<label> — METHOD
//     /path" (retired from api/status in S27; kept so a reintroduction
//     still yields a sub-node and fails the deep-equal until nav.ts
//     regen).
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
const WEBHOOKS_DIR = resolve(REPO_ROOT, 'apps/docs/src/pages/webhooks');

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
const webhooksSection = DOC_NAV.find((s) => s.label === 'Webhooks');

// S27 — the two swept (dir ↔ section) pairs. Extraction rules are
// identical for both; only the href base differs.
const SWEPT: { dir: string; hrefPrefix: string; section: typeof apiSection }[] = [
  { dir: API_DIR, hrefPrefix: '/api/', section: apiSection },
  { dir: WEBHOOKS_DIR, hrefPrefix: '/webhooks/', section: webhooksSection },
];

describe('S22.4/S27 DOC_NAV endpoint children ↔ api/*.md + webhooks/*.md integrity', () => {
  it('the API reference + Webhooks sections exist', () => {
    expect(apiSection).toBeDefined();
    expect(webhooksSection).toBeDefined();
  });

  it('every api/*.md + webhooks/*.md endpoint set matches its nav children EXACTLY (href = page + # + rehype slug, label = h2 text, method = declared method, page order)', () => {
    const mismatches: { page: string; expected: DocNavChild[]; actual: DocNavChild[] }[] = [];
    for (const { dir, hrefPrefix, section } of SWEPT) {
      for (const file of readdirSync(dir)
        .filter((f) => f.endsWith('.md'))
        .sort()) {
        const hrefBase = `${hrefPrefix}${file.replace(/\.md$/, '')}/`;
        const expected = extractEndpoints(resolve(dir, file), hrefBase);
        const item = section?.items.find((i) => i.href === hrefBase);
        const actual = item?.children ?? [];
        if (JSON.stringify(expected) !== JSON.stringify(actual)) {
          mismatches.push({ page: hrefBase, expected, actual });
        }
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('zero-endpoint pages (api overview + versioning + the webhooks event catalog) and every NON-swept-section item carry NO children — sub-nodes are an endpoint-page affordance only', () => {
    const offenders: string[] = [];
    for (const section of DOC_NAV) {
      for (const item of section.items) {
        if (section.label === 'API reference' || section.label === 'Webhooks') continue;
        if (item.children !== undefined) offenders.push(`${section.label} → ${item.href}`);
      }
    }
    for (const href of ['/api/', '/api/versioning/']) {
      const item = apiSection?.items.find((i) => i.href === href);
      if (item?.children !== undefined) offenders.push(`API reference → ${href}`);
    }
    // webhooks/events.md is a payload catalog — its two method mentions
    // are wrapped mid-sentence continuations, not declaration lines, so
    // it must extract zero endpoints and carry no children key at all.
    const events = webhooksSection?.items.find((i) => i.href === '/webhooks/events/');
    if (events?.children !== undefined) offenders.push('Webhooks → /webhooks/events/');
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

  it('the tree carries a substantial endpoint census (136 API + 8 webhooks; includes the public archetype catalog endpoint). V-846 raised it from 133: V-843 documented the crypto quote and receipt endpoints, which the page had been omitting, and every documented endpoint earns a nav child', () => {
    const apiTotal = (apiSection?.items ?? []).reduce((n, i) => n + (i.children?.length ?? 0), 0);
    const webhooksTotal = (webhooksSection?.items ?? []).reduce(
      (n, i) => n + (i.children?.length ?? 0),
      0,
    );
    // Census tripwire, refreshed only after the EXACTNESS test above passed:
    // nav children match each page's h2 endpoint set byte-for-byte. The +1 is
    // `/api/account/#profile-organization-taxonomy`, the resource `98d767a73`
    // added to api/account.md without a sidebar entry.
    expect(apiTotal).toBe(136);
    expect(webhooksTotal).toBe(8);
  });
});
