// Cross-source guard: every public entry in the sub-processor register
// reaches /docs/security-overview.
//
// The page carried a hand-written five-name shortlist — Stripe,
// NowPayments, Cloudflare, Postmark, Sentry — while naming Neon,
// Hetzner, MacStadium and LiveKit in its own data-handling, network and
// browser-sandbox sections. A procurement reviewer reading the security
// overview for an Article 28 disclosure saw five of twelve, on a page
// that contradicted itself four paragraphs earlier.
//
// The fix is structural: the list is rendered from SUB_PROCESSORS in
// `src/data/sub-processors.ts` — the same register /trust/sub-processors
// renders and `scripts/check-subprocessor-mirror.mjs` mirrors against
// DPA Annex 3. This guard holds that structure, because the failure it
// prevents is silent: a shortlist that is out of date reads exactly like
// a shortlist that is current.
//
// The page is Astro source, not built HTML, so "every entry appears" is
// checked the only way it can be without building the site — the page
// must read the WHOLE array, with nothing between the register and the
// render that could drop an entry. Each arm names the mutation it
// catches, so a future reader can tell what this is actually proving.
//
// Two arms are about the TEXT that reaches the customer rather than the
// structure that carries it, and both run the real code: `firstSentence`
// is imported from the register module (not copied here, and no longer
// hidden in the page's frontmatter where nothing could call it), so a
// mutation inside it changes what these arms read. They hold that every
// published line is a whole sentence quoted from its purpose, and that
// none of them carries a word the 2026-09-15 customer-facing copy rule
// bans — the register's own words are now this page's words.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SUB_PROCESSORS, firstSentence } from '../../src/data/sub-processors';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/docs/security-overview.astro');

const SECTION_HEADING = '<h2>Sub-processors</h2>';

/** The names the hand-written shortlist left out while the page named them elsewhere. */
const PREVIOUSLY_OMITTED = ['Neon', 'Hetzner Cloud', 'MacStadium', 'LiveKit'] as const;

/**
 * Words the 2026-09-15 customer-facing copy rule bans: they say how the
 * service is run, not what the customer gets. The page's own source has
 * never contained one — but the page publishes register text now, so
 * the register can import them for it. Three purposes did exactly that
 * ("control plane" x2, "fleet" x1) until they were reworded.
 */
const BANNED_IN_CUSTOMER_COPY =
  /control plane|fleet|\bnode\b|harness|observer|vantage|verdict|archetype/i;

/**
 * Abbreviations whose full stop is not a sentence end. `firstSentence`
 * splits on the first ". ", so a purpose reading "… Stripe Payments
 * Europe Ltd. and …" would publish a fragment. None does today; this
 * list is what turns that red on the day one is added.
 */
const ABBREVIATION_END = /\b(?:Ltd|Inc|Corp|Co|B\.V|Pty|plc|e\.g|i\.e|etc|vs|approx|No)\.$/;

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

/** The page's sub-processor section: its own `<h2>` up to the next one. */
function subProcessorSection(page: string): string {
  const start = page.indexOf(SECTION_HEADING);
  expect(start, 'the page still has a <h2>Sub-processors</h2> section').toBeGreaterThan(-1);
  const rest = page.slice(start + SECTION_HEADING.length);
  const end = rest.indexOf('<h2>');
  return end === -1 ? rest : rest.slice(0, end);
}

describe('/docs/security-overview ↔ sub-processor register cross-source parity', () => {
  const body = read(PAGE);
  const section = subProcessorSection(body);

  it('CRITICAL the register is non-empty and carries the four entries the old shortlist omitted. Every arm below reports on the register REACHING the page; an empty or shortened register would make all of them pass while the page disclosed nobody.', () => {
    expect(SUB_PROCESSORS.length, 'entries in the sub-processor register').toBeGreaterThan(10);
    const names = SUB_PROCESSORS.map((sp) => sp.name);
    for (const omitted of PREVIOUSLY_OMITTED) {
      expect(names, `${omitted} is the reason this guard exists`).toContain(omitted);
    }
  });

  it("every entry renders a complete sentence — this runs firstSentence itself, so it reads what the page publishes rather than what the register holds (mutation: slice(0, end + 1) -> slice(0, end) in src/data/sub-processors.ts drops the full stop from the Stripe, Anthropic, NowPayments and LiveKit lines and turns this red; indexOf('. ') -> indexOf(', ') truncates Neon mid-clause and turns it red too)", () => {
    for (const sp of SUB_PROCESSORS) {
      const line = firstSentence(sp.purpose);
      expect(line.trim(), `${sp.name} renders an empty line`).not.toBe('');
      // A prefix, never a rewrite: the page quotes the register.
      expect(sp.purpose.startsWith(line), `${sp.name} line is not a prefix of its purpose`).toBe(
        true,
      );
      // A whole sentence, never a fragment — this is a legal disclosure.
      expect(line, `${sp.name} line does not end in a full stop`).toMatch(/\.$/);
      expect(line, `${sp.name} line ends on an abbreviation, not a sentence`).not.toMatch(
        ABBREVIATION_END,
      );
      // One sentence, not the whole multi-sentence purpose: where a
      // purpose has more to say, the page links the full record.
      if (sp.purpose.includes('. ')) {
        expect(line.length, `${sp.name} line is not shorter than its purpose`).toBeLessThan(
          sp.purpose.length,
        );
      }
    }
  });

  it('no entry publishes internal vocabulary on this customer page (mutation: put "control plane" or "fleet" back into a register purpose — e.g. revert Hetzner to "Compute infrastructure for the Driftstack control plane." — and this goes red)', () => {
    for (const sp of SUB_PROCESSORS) {
      expect(
        firstSentence(sp.purpose),
        `${sp.name} publishes a word the customer-facing copy rule bans`,
      ).not.toMatch(BANNED_IN_CUSTOMER_COPY);
    }
  });

  it('the page reads the canonical register module (mutation: change the import to a local literal array and this goes red)', () => {
    expect(body).toMatch(
      /import\s*\{[\s\S]*?\bSUB_PROCESSORS\b[\s\S]*?\}\s+from\s+['"][^'"]*data\/sub-processors/,
    );
  });

  it("the list is rendered straight off the whole array — nothing sits between the register and the render (mutation: SUB_PROCESSORS.filter((sp) => sp.name !== 'LiveKit').map(…), or a const that pre-trims the array, turns this red)", () => {
    // Exactly two mentions: the import, and the single render site. A
    // third would mean the array is read somewhere else — e.g. trimmed
    // into a local const and that const rendered instead.
    expect(
      [...body.matchAll(/SUB_PROCESSORS/g)].length,
      'the register is named twice on this page: the import, and the one render site',
    ).toBe(2);
    // `.map(` is adjacent to the identifier: no pre-render transform.
    expect(section).toMatch(/\{\s*SUB_PROCESSORS\.map\(\(sp\) => \(/);
  });

  it('the rendered list is not trimmed after the map either (mutation: SUB_PROCESSORS.map(…).slice(0, -1) turns this red)', () => {
    expect(section).toMatch(/<\/li>\s*\)\)\s*\}\s*<\/ul>/);
  });

  it('each entry renders its name and its purpose (mutation: drop {sp.name} or {firstSentence(sp.purpose)} from the <li> and this goes red)', () => {
    expect(section).toMatch(
      /<li>\s*<strong>\{sp\.name\}<\/strong> — \{firstSentence\(sp\.purpose\)\}\s*<\/li>/,
    );
  });

  it("no entry is named by hand in the section (mutation: transcribe the list back, or skip one with `sp.name !== 'LiveKit'`, and the skipped name appears as a literal — red)", () => {
    for (const sp of SUB_PROCESSORS) {
      expect(
        section,
        `${sp.name} is written into the page instead of read from the register`,
      ).not.toContain(sp.name);
    }
    // The old shortlist's own wording, pinned negative so it cannot return.
    expect(section).not.toMatch(/card billing only/);
    expect(section).not.toMatch(/crypto checkout/);
    expect(section).not.toMatch(/CDN, WAF, R2 object storage/);
    expect(section).not.toMatch(/PII-scrubbed at SDK level/);
    expect(section).not.toMatch(/shortlist/);
  });

  it('the full record stays linked, and the page still says the list is complete', () => {
    expect(section).toContain('href="/trust/sub-processors/"');
    expect(section).toMatch(/This is the complete list/);
    expect(section).toMatch(
      /We publish 30-day notice before adding or rotating a sub-\s*processor\./,
    );
  });
});
