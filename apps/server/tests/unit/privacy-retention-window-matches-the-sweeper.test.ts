// V-759 — the published §9 retention window and the code that enforces it must be the same
// number.
//
// Deliberately a CROSS-SOURCE pin, not a text pin. A text pin would only record what the
// policy said; this reads the number OUT of the published policy and compares it to
// `RETENTION_WINDOW_DAYS`, so the two cannot drift apart in either direction. Editing the
// policy to 30 days without changing the sweeper now fails here, and so does changing the
// sweeper without updating the policy.
//
// It also pins something less obvious. The entire implementation is anonymisation rather
// than deletion, and the only thing that makes that the DISCLOSED behaviour instead of a
// workaround is §9's closing sentence authorising it. Literal row deletion is structurally
// impossible (`usage_records` cascades from `sessions` and §9 keeps billing data 7 years
// under AWR Art 52; revoked `api_keys` are RESTRICT-referenced by `admin_audit_log` and the
// incident tables). So if that sentence is ever edited out of the policy, the sweep silently
// becomes undisclosed processing — and there would be no other signal. See
// docs/internal/2026-08-12-retention-anonymisation-design.md.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RETENTION_WINDOW_DAYS } from '../../src/db/retention-scrub-repo.js';
import { ACCOUNT_DELETION_RETENTION_DAYS } from '../../src/services/account-deletion-purge-sweeper.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

/** Both published copies. A window honoured in one and not the other is still a false claim. */
const SOURCES = [
  'docs/legal/privacy-policy.md',
  'apps/marketing-site/src/pages/legal/privacy.md',
] as const;

/**
 * The two §9 table rows whose windows this sweep enforces, keyed by their row label. Matched
 * on the label and bounded to the single line, so the extraction cannot wander into a
 * neighbouring row's number.
 */
const ROWS = [
  { label: 'Authentication data', re: /^\|\s*Authentication data\b.*$/m },
  { label: 'Session metadata', re: /^\|\s*Session metadata\b.*$/m },
] as const;

const DAYS_RE = /(\d+)\s+days/;

interface Extracted {
  readonly source: string;
  readonly row: string;
  readonly days: number;
}

function extract(): Extracted[] {
  const out: Extracted[] = [];
  for (const source of SOURCES) {
    const text = readFileSync(resolve(REPO_ROOT, source), 'utf8');
    for (const row of ROWS) {
      const line = row.re.exec(text)?.[0];
      if (line === undefined) continue;
      const days = DAYS_RE.exec(line)?.[1];
      if (days === undefined) continue;
      out.push({ source, row: row.label, days: Number(days) });
    }
  }
  return out;
}

describe('published §9 retention window matches the sweeper (V-759)', () => {
  const found = extract();

  it('CRITICAL the extraction found both rows in both published copies. A regex that silently matches nothing would make the comparison below vacuously true, which is exactly how a pin ends up freezing a claim nobody is checking.', () => {
    expect(
      found.map((f) => `${f.source} :: ${f.row}`).sort(),
      'expected 2 rows x 2 published copies',
    ).toEqual([
      'apps/marketing-site/src/pages/legal/privacy.md :: Authentication data',
      'apps/marketing-site/src/pages/legal/privacy.md :: Session metadata',
      'docs/legal/privacy-policy.md :: Authentication data',
      'docs/legal/privacy-policy.md :: Session metadata',
    ]);
  });

  it('CRITICAL every published window equals RETENTION_WINDOW_DAYS — the number customers are shown is the number the sweep actually applies', () => {
    const mismatched = found
      .filter((f) => f.days !== RETENTION_WINDOW_DAYS)
      .map((f) => `${f.source} :: ${f.row} says ${f.days}, sweeper uses ${RETENTION_WINDOW_DAYS}`)
      .sort();

    expect(
      mismatched,
      'published retention window(s) that the sweeper does not implement — change both, or neither:',
    ).toEqual([]);
  });

  it('CRITICAL §9 still authorises anonymisation. Row deletion is structurally impossible here, so this sentence is the only thing that makes a scrub-in-place the DISCLOSED behaviour rather than undisclosed processing.', () => {
    const missing = SOURCES.filter((source) => {
      const text = readFileSync(resolve(REPO_ROOT, source), 'utf8');
      // Checked as an ALTERNATIVE to deletion rather than as a bare word match: the clause
      // only authorises this sweep because it offers anonymisation *instead of* deleting.
      // `\s+` because the sentence wraps across lines in both copies.
      return !/deletes the Personal Data\s+or anonymises it/i.test(text);
    });

    expect(
      missing,
      'published cop(ies) that no longer authorise anonymisation — the retention scrub in db/retention-scrub-repo.ts depends on this clause:',
    ).toEqual([]);
  });
  it('CRITICAL the published Customer-Provided Secrets window equals ACCOUNT_DELETION_RETENTION_DAYS. Both sides were already pinned separately — the policy text in the legal content-parity tests, the constant nowhere at all — which catches an edit to either and not a DRIFT between them. This is the number a customer is promised their credentials are gone by.', () => {
    for (const src of SOURCES) {
      const body = readFileSync(resolve(REPO_ROOT, src), 'utf8');
      const row = /^\|\s*Customer-Provided Secrets\b.*$/m.exec(body)?.[0];
      expect(
        row,
        `the Customer-Provided Secrets row is missing from ${src}, so this arm read nothing`,
      ).toBeDefined();
      const published = Number(/within\s+(\d+)\s+days/.exec(row ?? '')?.[1]);
      expect(
        published,
        `no "within N days" figure could be read out of the Customer-Provided Secrets row in ${src}`,
      ).not.toBeNaN();
      expect(
        published,
        `${src} promises secrets are deleted within ${published} days; the purge sweeper uses ` +
          `${ACCOUNT_DELETION_RETENTION_DAYS}. Whichever is wrong, customers are reading the other one`,
      ).toBe(ACCOUNT_DELETION_RETENTION_DAYS);
    }
  });
});
