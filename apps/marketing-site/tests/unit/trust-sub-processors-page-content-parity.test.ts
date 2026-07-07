// W376.B — drift guard for marketing-site /trust/sub-processors
// page content. V-478. Existing trust-sub-processors-page-binding
// + dpa-subprocessor-parity + sub-processor-registry-last-updated-
// baseline + privacy-subprocessor-parity tests cover row-shape.
// This guard pins the load-bearing GDPR Article 28(2) posture:
//
//   • SUB_PROCESSORS + SUB_PROCESSOR_REGISTER_LAST_UPDATED +
//     SUB_PROCESSOR_CHANGELOG imported from canonical data source.
//   • 4 canonical change-log entry kinds: added / removed /
//     material_change / register_published. A schema add silently
//     renders undefined kind label.
//   • Region preference vs region routing framing pinned —
//     load-bearing honesty claim ("It does not move your data").
//   • Article 28(2) 30-day notice mechanism pinned + customer
//     right-to-terminate-affected-portion-of-service.
//   • Cross-links: /legal/dpa (Annex 3) + DPA file exists.
//   • Last-updated timestamp surfaced (data-driven).
//   • Cosmetic-edits-not-logged honesty pinned.
//   • mailto:privacy@driftstack.dev contact path.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/trust/sub-processors.astro');
const DATA_SOURCE = resolve(REPO_ROOT, 'apps/marketing-site/src/data/sub-processors.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W376.B marketing-site /trust/sub-processors page content parity', () => {
  const body = read(PAGE);

  it('imports from canonical data source (SUB_PROCESSORS + LAST_UPDATED + CHANGELOG + type)', () => {
    expect(existsSync(DATA_SOURCE)).toBe(true);
    expect(body).toMatch(
      /import \{\s*\n?\s*SUB_PROCESSORS,\s*\n?\s*SUB_PROCESSOR_REGISTER_LAST_UPDATED,\s*\n?\s*SUB_PROCESSOR_CHANGELOG,\s*\n?\s*type SubProcessorChangeLogEntry,\s*\n?\s*\} from '\.\.\/\.\.\/data\/sub-processors\.ts';/,
    );
  });

  it('4 change-log entry kinds pinned (added / removed / material_change / register_published)', () => {
    for (const kind of ['added', 'removed', 'material_change', 'register_published']) {
      expect(body, `change-log kind missing: ${kind}`).toMatch(new RegExp(`case '${kind}':`));
    }
    // Labels.
    expect(body).toMatch(/case 'added':\s*\n?\s*return 'Added';/);
    expect(body).toMatch(/case 'removed':\s*\n?\s*return 'Removed';/);
    expect(body).toMatch(/case 'material_change':\s*\n?\s*return 'Material change';/);
    expect(body).toMatch(/case 'register_published':\s*\n?\s*return 'Register published';/);
  });

  it('change-log color map pinned (emerald / red / amber / neutral token). Fleet v2 (S10): register_published moved from the legacy bg-slate-200 to the tokened neutral bg-tk-raised (same neutral visual intent, mode-aware)', () => {
    expect(body).toMatch(/case 'added':\s*\n?\s*return 'bg-emerald-100 text-emerald-800';/);
    expect(body).toMatch(/case 'removed':\s*\n?\s*return 'bg-red-100 text-red-800';/);
    expect(body).toMatch(/case 'material_change':\s*\n?\s*return 'bg-amber-100 text-amber-800';/);
    expect(body).toMatch(
      /case 'register_published':\s*\n?\s*return 'border border-tk-border bg-tk-raised text-tk-ink-2';/,
    );
  });

  it('"region preference vs region routing" honesty framing pinned (S43 2026-07-07: scoped to database-resident data; R2 file objects replicate EU + US)', () => {
    expect(body).toMatch(/Region preference vs\. region routing\./);
    expect(body).toMatch(/It does not move\s+your data/);
    // S43 2026-07-07 (founder-approved) — the old blanket "every
    // customer's data resides on the EU-jurisdiction infrastructure"
    // claim was false for R2-held file objects (default jurisdiction,
    // EU + US replication). Now scoped honestly.
    expect(body).toMatch(
      /every customer's database-resident data —\s+account, profiles, sessions, audit logs — resides on the\s+EU-resident infrastructure listed in the table above/,
    );
    expect(body).toMatch(
      /use R2's default jurisdiction, which replicates\s+between the EU and the US under the transfer mechanism\s+listed in the table/,
    );
    expect(body).not.toMatch(
      /every customer's data resides on the\s+EU-jurisdiction infrastructure/,
    );
  });

  it('Article 28(2) 30-day notice + right-to-terminate-affected-portion framing pinned', () => {
    expect(body).toMatch(
      /customers receive\s+notice at least 30 days before the change takes effect/,
    );
    expect(body).toMatch(
      /Customers who object to a sub-processor change have the right to\s+terminate the affected portion of the service before the change\s+takes effect/,
    );
  });

  it('/legal/dpa Annex 3 cross-link pinned + DPA file exists', () => {
    // Astro wraps the closing `>` onto a new line; tolerate whitespace.
    expect(body).toMatch(
      /<a href="\/legal\/dpa" class="text-tk-accent-text underline"\s*>\s*Annex 3 of the Data Processing Agreement\s*<\/a\s*>/,
    );
    // Article 28(2) reference cross-link.
    expect(body).toMatch(/<a href="\/legal\/dpa" class="text-tk-accent-text underline">DPA<\/a>/);
    expect(body).toMatch(/\(Article 28\(2\) — Sub-processor amendment\)/);
    expect(existsSync(resolve(REPO_ROOT, 'apps/marketing-site/src/pages/legal/dpa.md'))).toBe(true);
  });

  it('last-updated timestamp surfaced from data source (not hardcoded)', () => {
    expect(body).toMatch(/Last updated: \{SUB_PROCESSOR_REGISTER_LAST_UPDATED\}/);
  });

  it('"cosmetic edits not logged" honesty claim pinned', () => {
    // S20c 2026-07-06 plain-language pass: immutability said plainly
    // ("never edited or removed"); cosmetic-edits exclusion survives.
    expect(body).toMatch(
      /entries are never edited or removed \(an immutable\s+record\)\. Cosmetic edits \(rewording, typo fixes\) don't qualify\s+and aren't logged\./,
    );
  });

  it('mailto:privacy@driftstack.dev contact path pinned', () => {
    expect(body).toMatch(/mailto:privacy@driftstack\.dev/);
    expect(body).toMatch(/For questions about the list, email/);
  });

  it('table renders 4 columns (Sub-processor / Region / Purpose / Transfer mechanism)', () => {
    expect(body).toMatch(/<th class="py-4 pr-4 font-medium text-tk-ink-2">Sub-processor<\/th>/);
    expect(body).toMatch(/<th class="px-4 py-4 font-medium text-tk-ink-2">Region<\/th>/);
    expect(body).toMatch(/<th class="px-4 py-4 font-medium text-tk-ink-2">Purpose<\/th>/);
    // S20c 2026-07-06 plain-language pass: the column header now
    // glosses the GDPR term inline for non-lawyers.
    expect(body).toMatch(
      /<th class="px-4 py-4 font-medium text-tk-ink-2">Transfer mechanism \(legal basis for any data leaving the EU\)<\/th>/,
    );
  });

  it('"Until multi-region rollout, leaving field as no-preference == EU" honesty pinned', () => {
    expect(body).toMatch(
      /Until the multi-region rollout ships, leaving the field as "no\s+preference" produces identical behaviour to selecting "eu"\./,
    );
  });

  it('multi-region rollout 30-day-notice + EU-stay-or-terminate framing pinned', () => {
    expect(body).toMatch(
      /customers who selected a non-EU region will be\s+notified 30 days before any of their data is migrated, with the\s+opportunity to keep their data in the EU or terminate the\s+affected portion of the service/,
    );
  });

  it('change-log entries iterate data-driven (entry.date / entry.kind / entry.summary / entry.effective_at)', () => {
    expect(body).toMatch(/SUB_PROCESSOR_CHANGELOG\.map\(\(entry\)/);
    expect(body).toMatch(/\{entry\.date\}/);
    expect(body).toMatch(/\{entry\.subject \|\| 'Register-level entry'\}/);
    expect(body).toMatch(/\{entry\.summary\}/);
    expect(body).toMatch(/\{entry\.effective_at\}/);
  });
});
