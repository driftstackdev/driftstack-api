// No customer doc may tell a reader to find a validation bound in the `detail` field.
//
// `reference/pagination.md` said "Out-of-range values surface as `400 ValidationFailed`
// problem+json with the per-endpoint bound in the `detail` field." Both halves were wrong, and
// wrong for the very endpoint that page builds all three of its examples on:
//
//   * `ValidationError` (lib/errors.ts) hardcodes `detail: 'One or more fields failed
//     validation.'`. The Zod flatten — the only place a bound appears — goes into the `issues`
//     EXTENSION. Code written from that sentence renders a generic sentence where the customer
//     expected a number.
//   * `routes/account-audit.ts` safe-parses and re-raises `BadRequestError`, so its problem type
//     is `.../bad-request`, not `.../validation-failed`. The type genuinely varies per endpoint —
//     bare `.parse()` produces one, `safeParse` + `BadRequestError` the other — so an
//     `instanceof ValidationError` branch silently never fires for an out-of-range audit-log
//     `limit`.
//
// Derived rather than pinned. The premise — that `detail` is a fixed sentence which cannot carry
// a bound — is read out of `lib/errors.ts`, so if `ValidationError` ever starts interpolating the
// failing constraint into `detail`, this guard steps aside and the docs are free to say so.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const DOCS_PAGES = resolve(REPO_ROOT, 'apps/docs/src/pages');

/** The `detail` string `ValidationError` actually sends. */
function validationDetail(): string | null {
  const src = readFileSync(resolve(REPO_ROOT, 'apps/server/src/lib/errors.ts'), 'utf8');
  const start = src.indexOf('export class ValidationError');
  if (start === -1) return null;
  const body = src.slice(start, src.indexOf('\n}', start));
  return /detail:\s*'([^']*)'/.exec(body)?.[1] ?? null;
}

function docPages(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) docPages(p, out);
    else if (entry.endsWith('.md') || entry.endsWith('.mdx') || entry.endsWith('.astro')) {
      out.push(p);
    }
  }
  return out;
}

describe('no customer doc points at `detail` for a validation bound', () => {
  const detail = validationDetail();
  const pages = docPages(DOCS_PAGES);

  it('CRITICAL the premise still holds and the scan found pages. If ValidationError began interpolating the bound into `detail`, or the page scan came back empty, the check below would be either wrong or vacuous.', () => {
    expect(detail, 'ValidationError must still send a literal detail').not.toBeNull();
    // A fixed sentence: no template placeholder, so it cannot carry a per-endpoint number.
    expect(detail).toBe('One or more fields failed validation.');
    expect(pages.length, 'customer doc pages scanned').toBeGreaterThan(20);
  });

  it('CRITICAL no page tells a reader the bound is in `detail` — it is in the `issues` extension, and code written from the wrong sentence renders a generic string where a number was expected', () => {
    // Per OCCURRENCE of `detail`, with a proximity window rather than a sentence split. The
    // first version split on /(?<=\.)\s+/ and produced two false positives: markdown blocks
    // have no sentence boundaries, so a whole section got treated as one "sentence" and a
    // distant `detail` paired with an unrelated "cap". 120 chars either side is what actually
    // reads as the same claim.
    const WINDOW = 120;
    const offenders: string[] = [];
    for (const page of pages) {
      const text = readFileSync(page, 'utf8');
      for (const m of text.matchAll(/`detail`/g)) {
        const at = m.index ?? 0;
        const near = text.slice(Math.max(0, at - WINDOW), at + WINDOW);
        if (!/\bbound\b|\bmaximum\b|\bmax\b/i.test(near)) continue;
        // "not in `detail`" / "rather than `detail`" are the corrected phrasings.
        if (/not in `detail`|rather than `detail`|instead of `detail`/i.test(near)) continue;
        offenders.push(
          `${page.slice(REPO_ROOT.length + 1)}: …${near.replace(/\s+/g, ' ').trim()}…`,
        );
      }
    }

    expect(
      offenders.sort(),
      'doc sentence(s) pointing at `detail` for a validation bound — the bound is in the `issues` extension:',
    ).toEqual([]);
  });
});
