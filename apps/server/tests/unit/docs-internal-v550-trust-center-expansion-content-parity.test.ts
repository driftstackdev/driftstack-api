// W563.A — drift guard for /docs/internal/v550-trust-center-expansion.md.
// V-550 DESIGN doc 2026-05-11 Wave-24. Drift here either weakens
// the enterprise-credible-trust-center expansion before first
// enterprise customer, drops the 3-sub-slice (sub-processor RSS +
// incident-history-MTTR + compliance-pen-test-NDA), or unsets the
// honest-current-state compliance posture.
//
//   • V-550. DESIGN. Pre-enterprise-customer trust-center expansion.
//   • Current trust surface: /security + /legal/dpa/privacy/terms/aup.
//   • 6 missing-for-enterprise (versioned-sub-proc + incident-history
//     + compliance-cert + pen-test-NDA + VDP + change-SLA-disclosure).
//   • 3 sub-slices: V-550.A (sub-proc RSS + email-on-change) +
//     V-550.B (incident-history + MTTR 30/90/365) + V-550.C
//     (compliance + pen-test-NDA + VDP + audit-log-retention).
//   • nda_requests table + R2 7-day signed-URL.
//   • Postmark sub-processor change opt-in satisfies GDPR Art-28(2)
//     30-day notice.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'docs/internal/v550-trust-center-expansion.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W563.A /docs/internal/v550-trust-center-expansion.md content parity', () => {
  const body = read(LIB);

  it("Header + V-550-DESIGN-Wave-24 + 5-current-surface + 6-missing framing pinned: '# V-550 — trust center expansion' + '**Date:** 2026-05-11' + '**Wave:** 24' + '**Status:** DESIGN — current trust surface is the marketing-site' + 'security page + DPA + privacy policy. V-550 designs the next-layer' + 'trust-center expansion before first enterprise customer.' + '`/security` — sub-processor list, encryption at rest/transit,' + '`/legal/dpa` — DPA template ready for execution.' + '`/legal/privacy` — GDPR-compliant privacy policy.' + '`/legal/terms` — terms of service.' + '`/legal/acceptable-use-policy` — AUP.' + 'Versioned + dated sub-processor list with a \"subscribe to changes\"' + 'Public incident history page.' + 'Compliance certifications surface — even a \"in progress: SOC 2' + 'Type I expected Q3 2026\" honest disclosure beats silence.' + 'Pen-test report access — gated download for prospective customers' + 'Vulnerability disclosure policy.' + 'Data subprocessor change notification SLA disclosure.' — pinned so the V-550-DESIGN-Wave-24-2026-05-11 + pre-enterprise-customer + 5-current-surface (/security + /legal/dpa + /legal/privacy + /legal/terms + /legal/acceptable-use-policy) + 6-missing (versioned-sub-proc + incident-history + SOC-2-Type-I-Q3-2026 + pen-test-NDA + VDP + change-SLA) commitment survives", () => {
    expect(body).toMatch(/^# V-550 — trust center expansion$/m);
    expect(body).toMatch(/\*\*Date:\*\* 2026-05-11/);
    expect(body).toMatch(/\*\*Wave:\*\* 24/);
    expect(body).toMatch(/\*\*Status:\*\* DESIGN — current trust surface is the marketing-site/);
    expect(body).toMatch(/security page \+ DPA \+ privacy policy\. V-550 designs the next-layer/);
    expect(body).toMatch(/trust-center expansion before first enterprise customer\./);
    expect(body).toMatch(/- `\/security` — sub-processor list, encryption at rest\/transit,/);
    expect(body).toMatch(/- `\/legal\/dpa` — DPA template ready for execution\./);
    expect(body).toMatch(/- `\/legal\/privacy` — GDPR-compliant privacy policy\./);
    expect(body).toMatch(/- `\/legal\/terms` — terms of service\./);
    expect(body).toMatch(/- `\/legal\/acceptable-use-policy` — AUP\./);
    expect(body).toMatch(/1\. Versioned \+ dated sub-processor list with a "subscribe to changes"/);
    expect(body).toMatch(/2\. Public incident history page\./);
    expect(body).toMatch(/3\. Compliance certifications surface — even a "in progress: SOC 2/);
    expect(body).toMatch(/Type I expected Q3 2026" honest disclosure beats silence\./);
    expect(body).toMatch(/4\. Pen-test report access — gated download for prospective customers/);
    expect(body).toMatch(/5\. Vulnerability disclosure policy\./);
    expect(body).toMatch(/6\. Data subprocessor change notification SLA disclosure\./);
  });

  it("3-sub-slice (V-550.A/B/C) + operational + Art-28(2) framing pinned: '### V-550.A — sub-processor changes feed' + 'Today the sub-processor list lives at `apps/marketing-site/src/data/' + 'sub-processors.ts` + renders on `/security`.' + '**Versioning** — each sub-processor entry gains an `added_at` date' + '**Public RSS feed** — `https://driftstack.dev/trust/sub-processors/' + 'feed.xml`' + '**Email-on-change** — customers can opt into Postmark notifications' + 'GDPR Art. 28(2) 30-day notice requirement (already documented in V-493' + 'sub-processor parity audit).' + '### V-550.B — incident history page' + 'Builds on V-545.C (status-site history view).' + 'Public-readable summary per incident (resolved incidents only;' + 'no operator-only updates leak).' + 'Year-archive page: `/trust/incidents/2026/`.' + 'Mean-time-to-resolution (MTTR) rolling stats over last 30 / 90 / 365 days.' + '### V-550.C — compliance + pen-test posture page' + 'New page at `/trust/compliance`' + '**Honest current state**: list certifications in progress' + '**Pen-test access**: form for prospective customers' + 'Gated on NDA acceptance.' + '**Vulnerability disclosure policy**: `security@driftstack.dev`' + 'inbox; 90-day responsible-disclosure window' + '**Subprocessor change SLA**: 30-day notice for material changes' + '**Audit log retention disclosure**: how long we retain audit' + 'logs + customer-data access logs (per ADR-006).' — pinned so the V-550.A-sub-proc-RSS-Postmark-Art-28(2)-V-493 + V-550.B-incident-history-V-545.C-resolved-only-no-operator-only-leak-MTTR-30/90/365 + V-550.C-/trust/compliance-honest-current-state-NDA-form-VDP-security@driftstack.dev-90-day-window-ADR-006-audit-retention commitment survives", () => {
    expect(body).toMatch(/### V-550\.A — sub-processor changes feed/);
    expect(body).toMatch(
      /Today the sub-processor list lives at `apps\/marketing-site\/src\/data\//,
    );
    expect(body).toMatch(/sub-processors\.ts` \+ renders on `\/security`\./);
    expect(body).toMatch(
      /1\. \*\*Versioning\*\* — each sub-processor entry gains an `added_at` date/,
    );
    expect(body).toMatch(
      /2\. \*\*Public RSS feed\*\* — `https:\/\/driftstack\.dev\/trust\/sub-processors\//,
    );
    expect(body).toMatch(/feed\.xml`/);
    expect(body).toMatch(
      /3\. \*\*Email-on-change\*\* — customers can opt into Postmark notifications/,
    );
    expect(body).toMatch(
      /GDPR Art\.\s*28\(2\) 30-day notice requirement \(already documented in V-493/,
    );
    expect(body).toMatch(/sub-processor parity audit\)\./);
    expect(body).toMatch(/### V-550\.B — incident history page/);
    expect(body).toMatch(/Builds on V-545\.C \(status-site history view\)\./);
    expect(body).toMatch(/- Public-readable summary per incident \(resolved incidents only;/);
    expect(body).toMatch(/no operator-only updates leak\)\./);
    expect(body).toMatch(/- Year-archive page: `\/trust\/incidents\/2026\/`\./);
    expect(body).toMatch(/- Mean-time-to-resolution \(MTTR\) rolling stats over last 30 \/ 90 \//);
    expect(body).toMatch(/365 days\./);
    expect(body).toMatch(/### V-550\.C — compliance \+ pen-test posture page/);
    expect(body).toMatch(/New page at `\/trust\/compliance`/);
    expect(body).toMatch(/1\. \*\*Honest current state\*\*: list certifications in progress/);
    expect(body).toMatch(/2\. \*\*Pen-test access\*\*: form for prospective customers/);
    expect(body).toMatch(/Gated on NDA acceptance\./);
    expect(body).toMatch(/3\. \*\*Vulnerability disclosure policy\*\*: `security@driftstack\.dev`/);
    expect(body).toMatch(/inbox; 90-day responsible-disclosure window/);
    expect(body).toMatch(/4\. \*\*Subprocessor change SLA\*\*: 30-day notice for material changes/);
    expect(body).toMatch(/5\. \*\*Audit log retention disclosure\*\*: how long we retain audit/);
    expect(body).toMatch(/logs \+ customer-data access logs \(per ADR-006\)\./);
  });

  it("Operational + what-this-enables + open-questions + sub-slices framing pinned: '## Operational considerations' + '**Pen-test access form**: ties to a `nda_requests` table (proposed)' + 'The report is stored as a private R2 object with a 7-day signed-URL' + '**RSS feed generation**: rendered at build time by the marketing-' + 'site CI from the sub-processor data file. No runtime endpoint' + '**MTTR stats**: rendered from the incidents table at build time' + '(cached for 1 hour) — daily rebuild is sufficient' + '## What this enables' + '**Enterprise sales motion** — a prospect's security review can' + 'self-serve through the trust center' + '**DPA compliance** — the sub-processor change feed satisfies Art.' + '28(2) without per-customer email blasts.' + '**Trust posture credibility** — \"honest current state\" outperforms' + 'silence on the certification axis.' + '## Open questions for team review' + '**MTTR public exposure** — public 30/90/365-day MTTR' + 'transparency beats hidden under-performance.' + '**Pen-test gating** — NDA-then-download workflow' + 'summary-public + full-NDA-gated.' + '**Compliance roadmap honesty**' + '## Sub-slices' + '**V-550.A** — sub-processor changes RSS + email-on-change opt-in.' + '**V-550.B** — public incident history page + MTTR rolling stats.' + '**V-550.C** — compliance page + pen-test NDA workflow +' + 'vulnerability disclosure policy + audit-log retention disclosure.' + 'V-205 + V-211 sweep: zero hits.' — pinned so the nda_requests-table + R2-7-day-signed-URL + RSS-build-time + MTTR-build-time-cached-1-hour + 3-enables + 3-open-question (MTTR-public-transparency + NDA-summary-public-full-NDA-gated + roadmap-honesty-positive-list-only) + 3-sub-slice + V-205+V-211-zero-hits commitment survives", () => {
    expect(body).toMatch(/## Operational considerations/);
    expect(body).toMatch(
      /- \*\*Pen-test access form\*\*: ties to a `nda_requests` table \(proposed\)/,
    );
    expect(body).toMatch(/The report is stored as a private R2 object with a 7-day signed-URL/);
    expect(body).toMatch(/- \*\*RSS feed generation\*\*: rendered at build time by the marketing-/);
    expect(body).toMatch(/site CI from the sub-processor data file\. No runtime endpoint/);
    expect(body).toMatch(/- \*\*MTTR stats\*\*: rendered from the incidents table at build time/);
    expect(body).toMatch(/\(cached for 1 hour\) — daily rebuild is sufficient/);
    expect(body).toMatch(/## What this enables/);
    expect(body).toMatch(/- \*\*Enterprise sales motion\*\* — a prospect's security review can/);
    expect(body).toMatch(/self-serve through the trust center/);
    expect(body).toMatch(
      /- \*\*DPA compliance\*\* — the sub-processor change feed satisfies Art\./,
    );
    expect(body).toMatch(/28\(2\) without per-customer email blasts\./);
    expect(body).toMatch(
      /- \*\*Trust posture credibility\*\* — "honest current state" outperforms/,
    );
    expect(body).toMatch(/silence on the certification axis\./);
    expect(body).toMatch(/## Open questions for team review/);
    expect(body).toMatch(/1\. \*\*MTTR public exposure\*\* — public 30\/90\/365-day MTTR/);
    expect(body).toMatch(/transparency beats hidden\s*under-performance\./);
    expect(body).toMatch(/2\. \*\*Pen-test gating\*\* — NDA-then-download workflow/);
    expect(body).toMatch(/summary-public \+ full-NDA-gated\./);
    expect(body).toMatch(/3\. \*\*Compliance roadmap honesty\*\*/);
    expect(body).toMatch(/## Sub-slices/);
    expect(body).toMatch(
      /- \*\*V-550\.A\*\* — sub-processor changes RSS \+ email-on-change opt-in\./,
    );
    expect(body).toMatch(
      /- \*\*V-550\.B\*\* — public incident history page \+ MTTR rolling stats\./,
    );
    expect(body).toMatch(/- \*\*V-550\.C\*\* — compliance page \+ pen-test NDA workflow \+/);
    expect(body).toMatch(/vulnerability disclosure policy \+ audit-log retention disclosure\./);
    expect(body).toMatch(/- V-205 \+ V-211 sweep: zero hits\./);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
