// W573.C — drift guard for /docs/legal/README.md.
// Driftstack legal-document-set index. Drift here either reorders
// the 4-bound docs + 1-definitions table, drops a versioning-rule
// (patch=no-reaccept / minor=force-reaccept / major=force-reaccept
// +notice_period_days default 30), or unsets the 5-revision-trigger
// (business + sub-processor + jurisdiction + regulatory + annual).
//
//   • 4 bound docs + definitions.md.
//   • Acceptance tracked via POST /v1/legal/accept.
//   • Acceptance log: account_id + document_key + version +
//     content_hash + accepted_at.
//   • SemVer with version-bump rules.
//   • 5 revision triggers + annual-minimum 12-month review.
//   • Defined terms identical across all 4 documents.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'docs/legal/README.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W573.C /docs/legal/README.md content parity', () => {
  const body = read(LIB);

  it('Header + 4-bound-docs + 1-definitions + marketing-site mirror + sub-processor RSS framing pinned', () => {
    expect(body).toMatch(/^# Driftstack — legal document set$/m);
    expect(body).toMatch(/This directory holds the four bound legal documents for the Driftstack/);
    expect(body).toMatch(/service plus a shared definitions file:/);
    expect(body).toMatch(
      /\| \[`definitions\.md`\]\(definitions\.md\)\s+\| Defined terms used across all four documents\. Source of truth for terminology\.\s+\|/,
    );
    expect(body).toMatch(
      /\| \[`terms-of-service\.md`\]\(terms-of-service\.md\)\s+\| Master commercial agreement with Customer\. Incorporates AUP and Privacy Policy by reference\.\s+\|/,
    );
    expect(body).toMatch(
      /\| \[`privacy-policy\.md`\]\(privacy-policy\.md\)\s+\| GDPR-compliant disclosures for personal data Driftstack processes as \*\*Controller\*\* \(account, billing, support\)\.\s+\|/,
    );
    expect(body).toMatch(
      /\| \[`dpa\.md`\]\(dpa\.md\)\s+\| Article 28 GDPR processor agreement for personal data Driftstack processes as \*\*Processor\*\* on Customer's behalf/,
    );
    expect(body).toMatch(/\(session content, recordings, customer-provided secrets\)\./);
    expect(body).toMatch(
      /\| \[`acceptable-use-policy\.md`\]\(acceptable-use-policy\.md\) \| Prohibited targets, prohibited techniques, customer responsibility framing, enforcement\./,
    );
    expect(body).toMatch(/Incorporated into ToS by reference\./);
    expect(body).toMatch(/The four bound documents are mirrored to public-facing pages on the/);
    expect(body).toMatch(
      /Driftstack marketing site under `\/legal\/\{terms,privacy,dpa,aup\}` \(see/,
    );
    expect(body).toMatch(/`apps\/marketing-site\/src\/pages\/legal\/`\)\./);
    expect(body).toMatch(/The DPA Annex 3/);
    expect(body).toMatch(/sub-processor list is mirrored to a customer-facing transparency page/);
    expect(body).toMatch(/at `\/trust\/sub-processors` driven by/);
    expect(body).toMatch(/`apps\/marketing-site\/src\/data\/sub-processors\.ts`\./);
  });

  it('Acceptance + revision machinery + SemVer rules (patch/minor/major) framing pinned', () => {
    expect(body).toMatch(/## Acceptance \+ revision/);
    expect(body).toMatch(/Customer acceptance of these documents is tracked via/);
    expect(body).toMatch(/`POST \/v1\/legal\/accept`\./);
    expect(body).toMatch(/Each acceptance records `account_id`,/);
    expect(body).toMatch(/`document_key`, `version`, `content_hash` \(SHA-256 of the document/);
    expect(body).toMatch(/content at acceptance\), and `accepted_at`\./);
    expect(body).toMatch(/Version bumps invalidate/);
    expect(body).toMatch(/prior acceptances and trigger a re-accept flow on the customer's next/);
    expect(body).toMatch(/API call\./);
    expect(body).toMatch(/## Versioning/);
    expect(body).toMatch(/Each document carries a SemVer-shaped version in its header\. Bumping/);
    expect(body).toMatch(/follows these rules:/);
    expect(body).toMatch(
      /- \*\*Patch\*\* \(`1\.0\.0` → `1\.0\.1`\): typo fix, formatting, no substantive/,
    );
    expect(body).toMatch(/legal change\. \*\*Does not\*\* force re-acceptance\./);
    expect(body).toMatch(
      /- \*\*Minor\*\* \(`1\.0\.x` → `1\.1\.0`\): clarification or addition that does/,
    );
    expect(body).toMatch(/not materially change the customer's obligations\./);
    expect(body).toMatch(/\*\*Forces re-acceptance\*\* under conservative posture\./);
    expect(body).toMatch(
      /- \*\*Major\*\* \(`1\.x\.y` → `2\.0\.0` and beyond\): material change to the/,
    );
    expect(body).toMatch(/customer's rights, obligations, or fees; new sub-processor; new/);
    expect(body).toMatch(/jurisdiction\./);
    expect(body).toMatch(/\*\*Forces re-acceptance\*\* with a `notice_period_days`/);
    expect(body).toMatch(/parameter \(default 30\) and prominent surfacing in the API response/);
    expect(body).toMatch(/to clients running on the prior version\./);
  });

  it('Revision-triggers + Cross-document-consistency + What-is-NOT + Acceptance-machinery framing pinned', () => {
    expect(body).toMatch(/## Revision triggers/);
    expect(body).toMatch(/A revision pass is required on any of:/);
    expect(body).toMatch(/1\. Material business model change \(new product, new pricing tier,/);
    expect(body).toMatch(/new commercial primitive\)\./);
    expect(body).toMatch(/2\. New sub-processor added to the list in the Privacy Policy or DPA\./);
    expect(body).toMatch(/3\. New jurisdiction served \(i\.e\. Driftstack accepts customers from/);
    expect(body).toMatch(/a jurisdiction not previously contemplated by these documents —/);
    expect(body).toMatch(/the current set assumes EU \+ UK \+ US \+ Switzerland customers\)\./);
    expect(body).toMatch(/4\. Regulatory change in any covered jurisdiction \(notably: Dutch DPA/);
    expect(body).toMatch(/guidance, EU Commission decisions on Standard Contractual Clauses/);
    expect(body).toMatch(/or the EU-US Data Privacy Framework, Court of Justice of the EU/);
    expect(body).toMatch(/rulings affecting transfer mechanisms\)\./);
    expect(body).toMatch(/5\. \*\*Annual minimum\*\* — review at least once every 12 months/);
    expect(body).toMatch(/regardless of trigger fires\./);
    expect(body).toMatch(/## Cross-document consistency/);
    expect(body).toMatch(
      /- Defined terms are \*\*identical across all four documents\*\* and live/,
    );
    expect(body).toMatch(/in `definitions\.md`\./);
    expect(body).toMatch(/If a term needs to mean different things in/);
    expect(body).toMatch(/different documents, it is renamed; we do not redefine\./);
    expect(body).toMatch(/- Effective-date headers across all four documents move in lockstep/);
    expect(body).toMatch(/when a multi-document revision lands\. Single-document revisions are/);
    expect(body).toMatch(/allowed; the affected document's header updates while others remain/);
    expect(body).toMatch(/at their previous version\./);
    expect(body).toMatch(/## What's NOT in this set/);
    expect(body).toMatch(
      /- \*\*Customer-facing onboarding copy\*\* \(signup flow, email templates,/,
    );
    expect(body).toMatch(/in-product banners\)\./);
    expect(body).toMatch(/Lives outside this directory in the marketing/);
    expect(body).toMatch(/- product surfaces\./);
    expect(body).toMatch(
      /- \*\*Sub-processor agreements\*\* themselves \(e\.g\. the actual contract/,
    );
    expect(body).toMatch(/between Driftstack B\.V\. and Stripe Ireland\)\./);
    expect(body).toMatch(/Each sub-processor/);
    expect(body).toMatch(/relationship is established through that sub-processor's own/);
    expect(body).toMatch(/contracting flow\./);
    expect(body).toMatch(/- \*\*Insurance certificates\*\*\. The ToS references "commercially/);
    expect(body).toMatch(/reasonable insurance"; the actual policies are procured separately/);
    expect(body).toMatch(/and not tracked here\./);
    expect(body).toMatch(/- \*\*Internal corporate documents\*\* \(articles of association,/);
    expect(body).toMatch(/shareholder agreements, employment contracts\)\./);
    expect(body).toMatch(/## Acceptance \+ revision machinery/);
    expect(body).toMatch(
      /See `apps\/server\/src\/routes\/legal\.ts` for the endpoints that record/,
    );
    expect(body).toMatch(/customer acceptance, and the `legal_acceptances` table in/);
    expect(body).toMatch(/`apps\/server\/src\/db\/schema\.ts` for the audit log shape\./);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
