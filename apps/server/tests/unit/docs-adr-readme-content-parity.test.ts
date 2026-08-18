// W551.C — drift guard for /docs/adr/README.md.
// ADR directory README + format spec. Drift here either weakens
// the when-to-write-an-ADR criteria (would invite single-
// paragraph decisions migrating into the ADR directory and
// orphaning docs/decisions.md), changes the ADR-NNN sequential-
// no-reuse numbering policy (would break the audit trail across
// superseded entries), or drops an ADR-001..ADR-004 index entry
// (would orphan the Index pointer the founder-review surface
// relies on).
//
//   • ADR-NNN sequential numbering — never reused across
//     supersession; superseded ADR keeps its number + status flag.
//   • 3 when-to-write criteria: deviation + non-obvious-tradeoffs
//     + explicit-revisit-triggers.
//   • Routine decisions stay in docs/decisions.md as one-paragraph
//     D-NNN entries.
//   • Index pins ADR-001 + ADR-002 + ADR-003 + ADR-004 (ADR-005 +
//     ADR-006 still Proposed and not yet listed).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'docs/adr/README.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W551.C /docs/adr/README.md content parity', () => {
  const body = read(LIB);

  it("Header + ADR-purpose framing pinned: '# Architecture Decision Records' + 'This directory holds Architecture Decision Records (ADRs) — long-form records for decisions where the rationale is too rich for the one-paragraph `D-NNN` entries in `docs/decisions.md`.' — pinned so the ADR-vs-D-NNN-one-paragraph + docs/decisions.md-cross-reference commitment survives", () => {
    expect(body).toMatch(/^# Architecture Decision Records$/m);
    expect(body).toMatch(/This directory holds Architecture Decision Records \(ADRs\) — long-form/);
    expect(body).toMatch(/records for decisions where the rationale is too rich for the/);
    expect(body).toMatch(/one-paragraph `D-NNN` entries in `docs\/decisions\.md`\./);
  });

  it("When-to-write — 3-criterion framing pinned: 'The decision is a **deviation from a planned approach** documented elsewhere' + 'The decision has **non-obvious tradeoffs** that future-you or a reviewer will need to reconstruct' + 'The decision has **explicit revisit triggers** (capacity, cost, compliance, vendor change)' + 'For routine decisions inside the locked stack, the one-paragraph `D-NNN` entry in `decisions.md` is enough. ADRs are reserved for the load-bearing contextual decisions.' — pinned so the 3-criterion-deviation+non-obvious-tradeoffs+revisit-triggers + routine-stays-in-decisions.md commitment survives", () => {
    expect(body).toMatch(
      /- The decision is a \*\*deviation from a planned approach\*\* documented/,
    );
    expect(body).toMatch(/elsewhere \(e\.g\., a architectural approved swap from a previously/);
    expect(body).toMatch(/- The decision has \*\*non-obvious tradeoffs\*\* that future-you or a/);
    expect(body).toMatch(/reviewer will need to reconstruct/);
    expect(body).toMatch(/- The decision has \*\*explicit revisit triggers\*\* \(capacity, cost,/);
    expect(body).toMatch(/compliance, vendor change\)/);
    expect(body).toMatch(
      /For routine decisions inside the locked stack, the one-paragraph\s*\n?\s*`D-NNN` entry in `decisions\.md` is enough\./,
    );
    expect(body).toMatch(/ADRs are reserved for the\s*\n?\s*load-bearing contextual decisions\./);
  });

  it("Format spec — 6-section ADR shape pinned: 'ADR-NNN — Short title' + '**Status:** Accepted | Superseded by ADR-MMM | Deprecated' + '**Tier:** 1 | 2 | 3 (per AGENTS.md autonomy tiers)' + '**Related D-entry:** D-NNN (if applicable)' + '**Related V-entry:** V-NNN (if applicable)' + '## Context' + '## Decision' + '## Consequences' + '## Alternatives considered' + '## Revisit triggers' — pinned so the ADR-format-frontmatter + 5-section-body-Context+Decision+Consequences+Alternatives+Revisit-triggers commitment survives", () => {
    expect(body).toMatch(/# ADR-NNN — Short title/);
    // `Proposed` added 2026-08-18. This pin required the three-value line, and
    // ADR-005 and ADR-006 had been carrying `Proposed (pending review)` since
    // May — so the pin made the format spec's omission mandatory.
    expect(body).toMatch(
      /\*\*Status:\*\* Proposed \| Accepted \| Superseded by ADR-MMM \| Deprecated/,
    );
    expect(body).toMatch(/\*\*Tier:\*\* 1 \| 2 \| 3 \(per AGENTS\.md autonomy tiers\)/);
    expect(body).toMatch(/\*\*Related D-entry:\*\* D-NNN \(if applicable\)/);
    expect(body).toMatch(/\*\*Related V-entry:\*\* V-NNN \(if applicable\)/);
    expect(body).toMatch(/## Context/);
    expect(body).toMatch(/## Decision/);
    expect(body).toMatch(/## Consequences/);
    expect(body).toMatch(/## Alternatives considered/);
    expect(body).toMatch(/## Revisit triggers/);
  });

  it("Numbering — sequential-no-reuse policy framing pinned: 'ADRs are numbered sequentially as `ADR-001`, `ADR-002`, etc. Numbers are never reused, even if an ADR is superseded — the superseded ADR keeps its number and gets `Status: Superseded by ADR-MMM` in its header. The history matters; the number is part of the record.' — pinned so the sequential-numbering + never-reused + superseded-keeps-number + Status-Superseded-by-ADR-MMM commitment survives", () => {
    expect(body).toMatch(/## Numbering/);
    expect(body).toMatch(/ADRs are numbered sequentially as `ADR-001`, `ADR-002`, etc\. Numbers/);
    expect(body).toMatch(/are never reused, even if an ADR is superseded — the superseded ADR/);
    expect(body).toMatch(/keeps its number and gets `Status: Superseded by ADR-MMM` in its/);
    expect(body).toMatch(/header\. The history matters; the number is part of the record\./);
  });

  it("Index — ADR-001 + ADR-002 + ADR-003 + ADR-004 inventory framing pinned: '- [ADR-001](ADR-001-control-plane-hosting-hetzner.md) — Control-plane hosting on Hetzner Cloud (architectural deviation from PaaS plan).' + '- [ADR-002](ADR-002-stripe-only-payment-processing.md) — Stripe-only payment processing at launch (architectural deviation from Mollie-primary' + '- [ADR-003](ADR-003-paid-trial-pack-replaces-free-tier.md) — $2.99 paid trial pack replaces the free tier (explicit deviation from parent driftstack repo file 127 §6).' + '- [ADR-004](ADR-004-pricing-restructure-two-ladder.md) — Pricing restructure to two-ladder concurrent-only (explicit deviation from parent driftstack repo file 127 single-ladder hours-with-overage design).' — pinned so the 4-ADR-index-inventory + ADR-001-Hetzner + ADR-002-Stripe-only + ADR-003-trial-pack + ADR-004-two-ladder commitment survives", () => {
    expect(body).toMatch(/## Index/);
    expect(body).toMatch(
      /- \[ADR-001\]\(ADR-001-control-plane-hosting-hetzner\.md\) — Control-plane/,
    );
    expect(body).toMatch(/hosting on Hetzner Cloud \(architectural deviation from PaaS plan\)\./);
    expect(body).toMatch(
      /- \[ADR-002\]\(ADR-002-stripe-only-payment-processing\.md\) — Stripe-only/,
    );
    expect(body).toMatch(
      /payment processing at launch \(architectural deviation from Mollie-primary/,
    );
    expect(body).toMatch(
      /- \[ADR-003\]\(ADR-003-paid-trial-pack-replaces-free-tier\.md\) — \$2\.99/,
    );
    expect(body).toMatch(
      /paid trial pack replaces the free tier \(explicit deviation from\s*\n?\s*parent driftstack repo file 127 §6\)\./,
    );
    expect(body).toMatch(/- \[ADR-004\]\(ADR-004-pricing-restructure-two-ladder\.md\) — Pricing/);
    expect(body).toMatch(
      /restructure to two-ladder concurrent-only \(explicit deviation from\s*\n?\s*parent driftstack repo file 127 single-ladder hours-with-overage/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
