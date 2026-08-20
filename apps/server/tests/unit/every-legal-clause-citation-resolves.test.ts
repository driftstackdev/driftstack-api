// V-1169 — every numbered clause a legal document cites has to exist in the document it
// names.
//
// V-1166 found the privacy policy citing the wrong DPA section and fixed that one pointer.
// V-1167 then reported the class closed at five citations. V-1168 found fourteen and a
// second defect. The lesson there was that a sweep reporting a class closed is a claim
// about the pattern — so this stops sweeping and resolves instead: all 147 numbered
// citations across both published mirrors, checked against the clause structure of the
// document each one points at.
//
// It found a third defect, of a different shape than the first two. Both earlier ones cited
// a clause that existed and meant something else. This one cites clauses that do not exist
// at all:
//
//   AUP §5 "Enforcement progression" lists three steps as an ordered list — Warning,
//   Suspension, Termination — and never gave them clause identifiers. But `### 5.4
//   Discretion to skip steps` follows, and §5.4's own carve-out sentence reads "The
//   progression in Section 5.1–5.3 is the default". Section 5.1 through 5.3 did not exist.
//
// `### 5.4` was the ONLY `###` in the whole document — an orphan sub-clause under a section
// whose other parts were unnumbered. Three independent surfaces assumed the identifiers
// were real: the heading, that carve-out sentence, and roughly fifteen citations of "AUP
// §5.2" in shipped source (`services/billing.ts`, `services/admin-accounts.ts`,
// `lib/bootstrap.ts`), in V-758 and V-1042, and in two pin titles. Only the document did
// not provide them.
//
// So the steps were numbered rather than the citation deleted — using the inline convention
// the Terms already uses for sub-clauses (`5.5 **Customer warranties.**`), which leaves the
// ordered-list rendering and every nested block untouched. That matters beyond tidiness:
// §5.4 lets Driftstack skip steps in the ladder, and a customer disputing a suspension has
// to be able to name the step that was skipped.
//
// ── Why this resolves rather than pins ────────────────────────────────────
//
// Pinning "5.1" here would freeze the number without checking anything, which is the
// failure V-1166 already recorded: a citation is only worth something while it resolves.
// This reads the number out of the citing sentence and looks it up in the cited document,
// so a renumbering fails here instead of quietly re-pointing customers at whatever moved
// into that slot.
//
// ── Resolver notes, because four versions were wrong ──────────────────────
//
// Each wrong version reported defects that were not there, and the wrongness was invisible
// without reading the source:
//
//   • Matching only `^## N.` headings called 31 citations broken. Sub-clauses are written
//     inline as bold leads (`12.1 **Driftstack indemnifies Customer**`), not as headings,
//     so most of the Terms looked absent.
//   • Line-scoped context missed a document name that had wrapped to the next line —
//     "see Annex 3 of the\nDPA" resolved against the privacy policy.
//   • `this DPA` appearing earlier in a sentence hijacked "Section 13 of the Terms of
//     Service", because a self-reference marker was checked before the qualifier that
//     actually follows the number.
//   • `ToS Section 13.3(3)` fell through both, since `(3)` sits between the number and its
//     qualifier — the document name PRECEDING the citation had to be consulted too.
//
// All four produced clean-looking failure lists over documents that were correct. The arms
// below therefore assert that specific known-good citations RESOLVE, not merely that the
// broken list is empty — a resolver that silently stopped matching would otherwise report
// the whole corpus honest.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

/** Both published mirrors. A citation fixed in one copy and not the other is not fixed. */
const MIRRORS = ['apps/marketing-site/src/pages/legal', 'docs/legal'] as const;

/** `privacy-policy.md` and `privacy.md` are the same document under two filenames. */
const STEM: Readonly<Record<string, string>> = {
  'privacy-policy': 'privacy',
  'terms-of-service': 'terms',
  'acceptable-use-policy': 'aup',
};
const stemOf = (fn: string): string => STEM[fn.slice(0, -3)] ?? fn.slice(0, -3);

/** How each document may name another. Order matters only for overlapping prose. */
const ALIAS: ReadonlyArray<readonly [string, RegExp]> = [
  ['dpa', /data processing addendum|\bDPA\b|\/legal\/dpa\/|\bdpa\.md/i],
  ['terms', /terms of service|\bToS\b|\/legal\/terms\/|\bthe Terms\b|terms-of-service\.md/i],
  ['privacy', /privacy polic|\/legal\/privacy\/|privacy-policy\.md/i],
  ['aup', /acceptable use polic|\bAUP\b|\/legal\/aup\//i],
  ['sla', /\bSLA\b|service level agreement/i],
  ['refunds', /refund polic|\/legal\/refunds\//i],
];

const CITE = /\b(?:(section|clause)|(annex|appendix|schedule))\s*([0-9]+(?:\.[0-9]+)*)\b/gi;
const SELF = /\bthis (DPA|AUP|Agreement|Policy|Addendum|Section)\b/i;
/** A version-qualified citation is a claim about a superseded document, not this one. */
const HISTORICAL = /v0\.[0-9]|previously|superseded|former/i;

interface Clauses {
  sections: Set<string>;
  annexes: Set<string>;
}

/**
 * The four ways this corpus gives a clause a number:
 *   `## 7. Records of Processing`      top-level heading
 *   `### 6.1 Notification to Customer` sub-heading
 *   `5.5 **Customer warranties.**`     inline bold lead (Terms)
 *   `1. **5.1 Warning.**`              list item carrying its clause id (AUP)
 *   `## Annex 3 — Sub-processors`      annex heading
 */
function clausesOf(txt: string): Clauses {
  const sections = new Set<string>();
  const annexes = new Set<string>();
  for (const m of txt.matchAll(/^#{2,4}\s*([0-9]+(?:\.[0-9]+)*)\.?\s+\S/gm)) sections.add(m[1] ?? '');
  for (const m of txt.matchAll(/^\s*(?:[0-9]+\.\s+)?\*\*([0-9]+(?:\.[0-9]+)+)\s+\S/gm))
    sections.add(m[1] ?? '');
  for (const m of txt.matchAll(/^\s*([0-9]+(?:\.[0-9]+)+)\s+\*\*/gm)) sections.add(m[1] ?? '');
  for (const m of txt.matchAll(/^#{2,4}\s*Annex\s+([0-9]+)\b/gim)) annexes.add(m[1] ?? '');
  return { sections, annexes };
}

interface Citation {
  where: string;
  target: string;
  kind: 'section' | 'annex';
  num: string;
  context: string;
}

/**
 * Which document a citation points at. A name immediately BEFORE the number wins
 * (`ToS Section 13.3`), then the qualifier that FOLLOWS it (`Section 13 of the Terms of
 * Service`), then any name nearby, then the citing document itself. That precedence is
 * what four earlier versions got wrong, each in a way that manufactured findings.
 */
function targetOf(ctx: string, at: number, match: string, own: string): string {
  const before = ctx.slice(Math.max(0, at - 32), at);
  const fromBefore = ALIAS.find(([, p]) => p.test(before));
  if (fromBefore !== undefined) return fromBefore[0];

  const after = ctx.slice(at + match.length, at + match.length + 60);
  const q = /^\s*(?:\([0-9]+\))?\s*(?:of|in|under)\s+(?:the\s+|this\s+)?([A-Za-z ]{2,40})/i.exec(
    after,
  );
  if (q !== null) {
    const isSelf =
      /^(DPA|AUP|Agreement|Policy|Addendum)\b/i.test(q[1] ?? '') &&
      /^\s*(?:\([0-9]+\))?\s*(?:of|in|under)\s+this/i.test(after);
    if (isSelf) return own;
    const named = ALIAS.find(([, p]) => p.test(q[1] ?? ''));
    if (named !== undefined) return named[0];
  }

  const near = ctx.slice(Math.max(0, at - 160), at + match.length + 50);
  if (SELF.test(near)) return own;
  return ALIAS.find(([, p]) => p.test(near))?.[0] ?? own;
}

function citations(): { all: Citation[]; unresolved: string[] } {
  const all: Citation[] = [];
  const unresolved: string[] = [];

  for (const mirror of MIRRORS) {
    const dir = resolve(REPO_ROOT, mirror);
    const docs = new Map<string, string>();
    for (const fn of readdirSync(dir).sort()) {
      if (fn.endsWith('.md')) docs.set(fn, readFileSync(resolve(dir, fn), 'utf8'));
    }
    const clauses = new Map<string, Clauses>();
    for (const [fn, txt] of docs) clauses.set(stemOf(fn), clausesOf(txt));

    for (const [fn, txt] of docs) {
      const own = stemOf(fn);
      const lines = txt.split('\n');
      for (const [i, line] of lines.entries()) {
        // Paragraph-scoped, so a document name wrapped onto the next line is still visible.
        const ctx = lines.slice(Math.max(0, i - 1), i + 2).join(' ');
        for (const m of line.matchAll(CITE)) {
          const kind = m[2] !== undefined ? 'annex' : 'section';
          const num = m[3] ?? '';
          const at = ctx.indexOf(m[0]);
          const near = ctx.slice(Math.max(0, at - 160), at + m[0].length + 50);
          if (HISTORICAL.test(near)) continue;

          const target = targetOf(ctx, at, m[0], own);
          const table = clauses.get(target);
          // A document with no numbered clauses (the changes log) is not a citable target.
          if (table === undefined || (table.sections.size === 0 && table.annexes.size === 0))
            continue;

          const where = `${mirror}/${fn}:${i + 1}`;
          all.push({ where, target, kind, num, context: near.trim() });
          const found = kind === 'annex' ? table.annexes.has(num) : table.sections.has(num);
          if (!found) unresolved.push(`${where} cites ${target} ${kind} ${num} — no such clause`);
        }
      }
    }
  }
  return { all, unresolved };
}

describe('V-1169 every legal clause citation resolves', () => {
  it('CRITICAL the resolver finds the citations it is supposed to check, and points each at the right document. Four earlier versions produced clean-looking lists of broken citations over documents that were correct — a mis-targeted resolver reads exactly like a working one, so these name citations that must be found AND must resolve rather than counting how many were.', () => {
    const { all } = citations();
    expect(all.length, 'no clause citations extracted — the legal corpus or the pattern moved').toBeGreaterThan(
      100,
    );

    const key = (c: Citation): string => `${c.target} ${c.kind} ${c.num}`;
    const found = new Set(all.map(key));

    // One per targeting rule, so a narrowing of any rule fails here rather than making the
    // arm below easier to satisfy.
    expect([...found], 'the qualifier-follows-the-number case is no longer resolved').toContain(
      'terms section 13',
    );
    expect([...found], 'the name-precedes-the-number case is no longer resolved').toContain(
      'terms section 13.3',
    );
    expect([...found], 'the cross-document annex case is no longer resolved').toContain(
      'dpa annex 3',
    );
    expect([...found], 'the V-1166 breach-notification citation is gone').toContain(
      'dpa section 6.1',
    );
    expect([...found], 'the AUP enforcement-ladder citation is gone').toContain('aup section 5.1');
  });

  it('CRITICAL every numbered clause cited anywhere in the legal corpus exists in the document it names. A pointer a reader cannot follow reads as precision — and these point at the clauses a customer needs when disputing a suspension, objecting to a sub-processor, or checking a breach-notification deadline.', () => {
    expect(citations().unresolved.sort(), 'legal citations pointing at clauses that do not exist').toEqual(
      [],
    );
  });

  it('CRITICAL the AUP enforcement ladder still carries clause identifiers on all three steps. §5.4 grants Driftstack discretion to skip steps in this ladder, so a customer disputing a suspension has to be able to name the step that was skipped — and shipped code in billing, admin-accounts and bootstrap cites §5.2 by number.', () => {
    for (const rel of [
      'apps/marketing-site/src/pages/legal/aup.md',
      'docs/legal/acceptable-use-policy.md',
    ]) {
      const body = readFileSync(resolve(REPO_ROOT, rel), 'utf8');
      expect(body, `${rel} lost the warning step identifier`).toMatch(/^1\. \*\*5\.1 Warning\.\*\*/m);
      expect(body, `${rel} lost the suspension step identifier`).toMatch(
        /^2\. \*\*5\.2 Suspension\.\*\*/m,
      );
      expect(body, `${rel} lost the termination step identifier`).toMatch(
        /^3\. \*\*5\.3 Termination\.\*\*/m,
      );
      expect(body, `${rel} states the ladder as unnumbered steps again`).not.toMatch(
        /^2\. \*\*Suspension\.\*\*/m,
      );
      // The orphan that gave the defect away: 5.4 is a sub-clause of a section whose other
      // parts were unnumbered. It should now have siblings.
      expect(body, `${rel} lost the discretion clause the ladder is subject to`).toMatch(
        /^### 5\.4 Discretion to skip steps/m,
      );
    }
  });
});
