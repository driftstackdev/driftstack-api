// W502.C — drift guard for apps/marketing-site/src/pages/trust/sub-processors.astro.
// V-478 sub-processor register + change-log. Drift here either drops the
// Article 28(2) GDPR 30-day notice commitment (would expose the
// company to DPA-amendment breach) or breaks the source-of-truth link
// to /legal/dpa Annex 3 (would let the customer view diverge from the
// contractual register).
//
//   • 4-import set from sub-processors.ts: SUB_PROCESSORS +
//     SUB_PROCESSOR_REGISTER_LAST_UPDATED + SUB_PROCESSOR_CHANGELOG +
//     SubProcessorChangeLogEntry type.
//   • changeLogKindLabel 4-state: added / removed / material_change /
//     register_published.
//   • Article 28(2) GDPR + 30-day-notice + /legal/dpa Annex 3
//     cross-reference framing.
//   • Region preference vs. region routing: 'stated preference' + 'does
//     not move your data' + 'EU-jurisdiction infrastructure' + 30-day
//     migration-notice commitment.
//   • Change-log section: 'immutable entry' + 'cosmetic edits don't
//     qualify' framing.
//   • Sub-processor changes 30-day-notice mechanics + objection right +
//     terminate-affected-portion right.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/trust/sub-processors.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W502.C apps/marketing-site/src/pages/trust/sub-processors.astro content parity', () => {
  const body = read(LIB);

  it('4-import set from sub-processors.ts: SUB_PROCESSORS + SUB_PROCESSOR_REGISTER_LAST_UPDATED + SUB_PROCESSOR_CHANGELOG + SubProcessorChangeLogEntry — pinned so the data + last-updated + changelog + type imports all stay sourced from the canonical sub-processors.ts (drift to hardcoding here would diverge from /legal/dpa Annex 3 when the register changes)', () => {
    expect(body).toMatch(
      /import \{\s*\n?\s*SUB_PROCESSORS,\s*\n?\s*SUB_PROCESSOR_REGISTER_LAST_UPDATED,\s*\n?\s*SUB_PROCESSOR_CHANGELOG,\s*\n?\s*type SubProcessorChangeLogEntry,\s*\n?\s*\} from '\.\.\/\.\.\/data\/sub-processors\.ts';/,
    );
  });

  it("changeLogKindLabel 4-state map: added → 'Added' / removed → 'Removed' / material_change → 'Material change' / register_published → 'Register published' — pinned so the 4-kind change-log taxonomy stays consistent (drift to dropping 'material_change' would lose the GDPR-relevant change kind; drift to dropping 'register_published' would orphan the initial-publication entry)", () => {
    expect(body).toMatch(/case 'added':\s*\n?\s*return 'Added';/);
    expect(body).toMatch(/case 'removed':\s*\n?\s*return 'Removed';/);
    expect(body).toMatch(/case 'material_change':\s*\n?\s*return 'Material change';/);
    expect(body).toMatch(/case 'register_published':\s*\n?\s*return 'Register published';/);
  });

  it("changeLogKindClass 4-state color map: added → emerald / removed → red / material_change → amber / register_published → neutral token — pinned so the change-log visual semantic (green=added, red=removed, amber=changed, neutral=published) stays consistent (drift would break the at-a-glance scan customers use to spot 'is this change I need to act on'). Fleet v2 (S10): register_published moved from the legacy bg-slate-200 to the tokened neutral bg-tk-raised (same neutral intent, mode-aware)", () => {
    expect(body).toMatch(/case 'added':\s*\n?\s*return 'bg-emerald-100 text-emerald-800';/);
    expect(body).toMatch(/case 'removed':\s*\n?\s*return 'bg-red-100 text-red-800';/);
    expect(body).toMatch(/case 'material_change':\s*\n?\s*return 'bg-amber-100 text-amber-800';/);
    expect(body).toMatch(
      /case 'register_published':\s*\n?\s*return 'border border-tk-border bg-tk-raised text-tk-ink-2';/,
    );
  });

  it("Article 28(2) GDPR + 30-day-notice + /legal/dpa Annex 3 cross-reference framing pinned: 'This page is the customer-facing source of truth for sub-processor changes. Adding or removing an entry triggers a 30-day notice to all customers per Article 28(2) of the GDPR; the same content also lives in Annex 3 of the Data Processing Agreement' — pinned so the source-of-truth + Article 28(2) + 30-day-notice + DPA-Annex-3 4-state framing survives (drift to dropping Article 28(2) would lose the GDPR-anchored legal basis; drift to dropping the Annex 3 cross-reference would let the customer view drift from the contractual register)", () => {
    expect(body).toMatch(
      /This page is the customer-facing source of truth for sub-processor\s*\n?\s*changes\. Adding or removing an entry triggers a 30-day notice to all\s*\n?\s*customers per Article 28\(2\) of the GDPR; the same content also lives\s*\n?\s*in <a href="\/legal\/dpa\/" class="text-tk-accent-text underline"\s*\n?\s*>Annex 3 of the Data Processing Agreement<\/a\s*\n?\s*>/,
    );
    expect(body).not.toContain('href="/legal/dpa"');
  });

  it("Last-updated stamp pinned: 'Last updated: {SUB_PROCESSOR_REGISTER_LAST_UPDATED}' — pinned so the register-freshness signal stays bound to the canonical timestamp (drift to a hardcoded date would let the page go stale without a code change; drift to dropping the stamp would hide the freshness signal customers use to verify the register is current)", () => {
    expect(body).toMatch(/Last updated: \{SUB_PROCESSOR_REGISTER_LAST_UPDATED\}/);
  });

  it("4-column register table: Sub-processor + Region + Purpose + Transfer mechanism — pinned so the per-sub-processor 4-attribute disclosure stays consistent (drift to dropping 'Transfer mechanism' would hide the SCC / adequacy-decision basis that EU customers rely on; drift to dropping 'Region' would obscure where data is processed)", () => {
    expect(body).toMatch(/<th class="py-4 pr-4 font-medium text-tk-ink-2">Sub-processor<\/th>/);
    expect(body).toMatch(/<th class="px-4 py-4 font-medium text-tk-ink-2">Region<\/th>/);
    expect(body).toMatch(/<th class="px-4 py-4 font-medium text-tk-ink-2">Purpose<\/th>/);
    // S20c 2026-07-06 plain-language pass: the column header now
    // glosses the GDPR term inline for non-lawyers.
    expect(body).toMatch(
      /<th class="px-4 py-4 font-medium text-tk-ink-2">Transfer mechanism \(legal basis for any data leaving the EU\)<\/th>/,
    );
  });

  it("Region-preference-vs-routing framing pinned (S43 2026-07-07, founder-approved): stated preference doesn't move data + database-resident data EU-resident + R2 file objects replicate EU + US under the listed transfer mechanism — the old blanket 'every customer's data … EU-jurisdiction' claim was false for R2-held objects and must not reappear", () => {
    expect(body).toMatch(/Region preference vs\. region routing\./);
    expect(body).toMatch(
      /\(us \/ eu \/ apac\) is a <em>stated preference<\/em>\. It does not move\s*\n?\s*your data\./,
    );
    expect(body).toMatch(
      /every customer's database-resident data —\s*\n?\s*account, profiles, sessions, audit logs — resides on the\s*\n?\s*EU-resident infrastructure listed in the table above/,
    );
    expect(body).toMatch(
      /use R2's default jurisdiction, which replicates\s*\n?\s*between the EU and the US under the transfer mechanism\s*\n?\s*listed in the table\./,
    );
    expect(body).not.toMatch(
      /every customer's data resides on the\s*\n?\s*EU-jurisdiction infrastructure/,
    );
  });

  it('region preference remains informational and does not promise an unshipped migration', () => {
    expect(body).toMatch(
      /The preference is informational and does not change routing or\s*\n?\s*residency\. Leaving it unset, or selecting us \/ eu \/ apac, produces\s*\n?\s*the same current placement described above\./,
    );
    expect(body).not.toMatch(/multi-region|selected a non-EU region|data is migrated/i);
  });

  it("V-478 change-log section pinned: 'Change log.' header + 'Every material change to the register lands here as an immutable entry. Cosmetic edits (rewording, typo fixes) don't qualify and aren't logged.' — pinned so the change-log immutability + cosmetic-edits-excluded framing survives (drift to logging cosmetic edits would dilute the signal; drift to dropping 'immutable' would let customers question whether entries get rewritten)", () => {
    expect(body).toMatch(/<!-- V-478 — sub-processor change-log -->/);
    expect(body).toMatch(/Change log\./);
    // S20c 2026-07-06 plain-language pass: immutability said plainly
    // ("recorded here permanently — never edited or removed"), the
    // precise term kept in parens; cosmetic-edits exclusion survives.
    expect(body).toMatch(
      /Every meaningful change to this list is recorded here\s+permanently — entries are never edited or removed \(an immutable\s+record\)\. Cosmetic edits \(rewording, typo fixes\) don't qualify\s+and aren't logged\./,
    );
  });

  it("How-sub-processor-changes-work 4-step mechanics pinned: 'engages a new sub-processor, removes one, or materially changes the role of an existing one' + 'customers receive notice at least 30 days before the change takes effect' + 'right to terminate the affected portion of the service' + 'Article 28(2) — Sub-processor amendment' cross-reference — pinned so the 30-day-notice + termination-right + DPA-Article-28(2)-cross-reference all survive (drift to dropping termination-right would invite DPA-breach complaints; drift to dropping the Article 28(2) anchor would orphan the legal basis)", () => {
    expect(body).toMatch(
      /When Driftstack engages a new sub-processor, removes one, or\s*\n?\s*materially changes the role of an existing one, customers receive\s*\n?\s*notice at least 30 days before the change takes effect\./,
    );
    expect(body).toMatch(
      /Customers who object to a sub-processor change have the right to\s*\n?\s*terminate the affected portion of the service before the change\s*\n?\s*takes effect\./,
    );
    expect(body).toMatch(/Article 28\(2\) — Sub-processor amendment/);
  });

  it('Privacy contact pinned: mailto:privacy@driftstack.dev — pinned so the privacy-channel routing stays consistent (drift to dropping or changing the address would orphan customer questions about the register; drift to support@ would lose the privacy-team routing tag)', () => {
    expect(body).toMatch(
      /<a href="mailto:privacy@driftstack\.dev" class="text-tk-accent-text underline"\s*\n?\s*>privacy@driftstack\.dev<\/a\s*\n?\s*>/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
