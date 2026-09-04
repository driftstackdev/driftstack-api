// W773 — apps/docs api/legal.md content parity. Ninety-ninth in the
// cross-SDK drift-guard series.
//
// /api/legal is the canonical reference for legal-document acceptance
// recording. Drift to the content-hash binding or the 3-reason enum
// would erode GDPR Art. 28(2) sub-processor amendment compliance.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const PAGE = resolve(REPO_ROOT, 'apps/docs/src/pages/api/legal.md');

describe('W773 docs /api/legal content parity', () => {
  it('api/legal.md file exists', () => {
    expect(existsSync(PAGE)).toBe(true);
  });

  it('CRITICAL frontmatter title + description pinned.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /^---\nlayout: \.\.\/\.\.\/layouts\/DocLayout\.astro\ntitle: Legal documents \+ acceptance\n/,
    );
    expect(p).toMatch(
      /description: List the legal document catalog, see which documents your account must accept, and record acceptance with a content-hash binding\./,
    );
  });

  it("CRITICAL content-hash-binding GDPR Art. 28(2) framing pinned. The 'Driftstack records customer acceptance of every versioned legal document (Terms of Service, Privacy Policy, DPA, Acceptable Use Policy, etc.) with a content-hash binding. When a document version bumps — typically a sub-processor amendment or a material policy change — the customer must re-accept under the GDPR Art. 28(2) sub-processor amendment cadence' wording is the load-bearing legal-compliance framing.", () => {
    const p = read(PAGE);

    expect(p).toMatch(/Driftstack records customer acceptance of every/);
    expect(p).toMatch(/versioned legal document \(Terms of Service, Privacy Policy, DPA,/);
    expect(p).toMatch(/Acceptable Use Policy, etc\.\) with a content-hash binding\./);
    expect(p).toMatch(
      /the customer must re-accept under the\s*\n?GDPR Art\. 28\(2\) sub-processor amendment cadence\./,
    );
  });

  it("CRITICAL 3-source legal-document location framing pinned. The 'document text lives at /legal/* on the marketing site (publicly readable without auth) and on docs/legal/*.md in the repo (canonical source-of-truth)' wording explains the 3-layer source-of-truth model.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /The actual document text\s*\n?lives at `\/legal\/\*` on the marketing site \(publicly readable\s*\n?without auth\) and on `docs\/legal\/\*\.md` in the repo \(canonical\s*\n?source-of-truth\)\./,
    );
  });

  it('CRITICAL 4-document catalog pinned — tos/privacy/dpa/aup with shape (document_key + title + version + effective_date + content_hash + source_path + byte_size). Drift to dropping any field would break the SDK consumer typings.', () => {
    const p = read(PAGE);

    for (const docKey of ['tos', 'privacy', 'dpa', 'aup']) {
      expect(p, `document_key ${docKey}`).toMatch(new RegExp(`"document_key": "${docKey}"`));
    }

    for (const field of [
      'document_key',
      'title',
      'version',
      'effective_date',
      'content_hash',
      'source_path',
      'byte_size',
    ]) {
      expect(p, `field ${field}`).toMatch(new RegExp(`"${field}":`));
    }
  });

  it('CRITICAL source_path canonical-repo paths pinned — docs/legal/terms-of-service.md / privacy-policy.md / dpa.md / acceptable-use-policy.md. Matches legal-catalog.ts filePath (the source-of-truth the route returns); aup uses the long-form filename, NOT aup.md.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/"source_path": "docs\/legal\/terms-of-service\.md"/);
    expect(p).toMatch(/"source_path": "docs\/legal\/privacy-policy\.md"/);
    expect(p).toMatch(/"source_path": "docs\/legal\/dpa\.md"/);
    expect(p).toMatch(/"source_path": "docs\/legal\/acceptable-use-policy\.md"/);
  });

  it("CRITICAL content-hash-binding rejection framing pinned. The 'Customers ship a hash with their acceptance; if the document text has changed in any way — even a typo fix — the hash differs and the acceptance is rejected with 409 (the customer must re-fetch + re-accept)' wording is the load-bearing tamper-resistance contract.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /Customers ship a hash with\s*\n?their acceptance; if the document text has changed in any way —\s*\n?even a typo fix — the hash differs and the acceptance is\s*\n?rejected with 409 \(the customer must re-fetch \+ re-accept\)\./,
    );
  });

  it('CRITICAL 3-reason enum pinned — never_accepted / version_outdated / content_hash_changed. These are the literal RequiredAcceptance.reason values in services/legal.ts (:37, :172, :182, :196); drift to a fabricated value would mislead dashboard re-acceptance routing.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/`never_accepted` — the account has never accepted this document/);
    expect(p).toMatch(/`version_outdated` — the account accepted an earlier version/);
    expect(p).toMatch(/`content_hash_changed` — the account accepted the current version/);
  });

  it('Art. 28(2) sub-processor-change framing pinned: it surfaces via version_outdated / content_hash_changed (NOT a dedicated reason) + the dashboard banner is shown whenever re-acceptance is required.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /For a DPA sub-processor change \(Art\. 28\(2\) trigger\), the new version\s*\n?surfaces as `version_outdated`/,
    );
    expect(p).toMatch(
      /The dashboard surfaces an in-app banner whenever a\s*\n?re-acceptance is required\./,
    );
  });

  it('CRITICAL POST /v1/legal/accept body shape pinned — { document_key, version, content_hash } triple. The 3-field body is the load-bearing acceptance-record contract.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/"document_key": "tos"/);
    expect(p).toMatch(/"version": "2026\.05"/);
    expect(p).toMatch(/"content_hash": "8f4a…\(sha256 hex\)…7e2b"/);
  });

  it('CRITICAL POST response 201 + lacc_ prefix pinned. Drift to a different status or prefix would break SDK type discriminators.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/Response \(201\):/);
    expect(p).toMatch(/"id": "lacc_<uuid>"/);
  });

  it('CRITICAL 3-error-code set — 400 (hex format) / 404 (unknown doc) / 409 (hash/version mismatch). The 409 response carries current_version + current_content_hash so client can refresh + retry.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/`400 bad-request` — `content_hash` not a 64-character hex SHA-256 digest\./);
    expect(p).toMatch(/`404 not-found` — `document_key` is not in the catalog\./);
    expect(p).toMatch(/`409 conflict` — `version` or `content_hash` doesn't match the/);
    expect(p).toMatch(
      /current document\. Response body carries\s*\n?\s+`current_version` \+ `current_content_hash` so the client can\s*\n?\s+refresh and retry\./,
    );
  });

  it("CRITICAL no-recursive-retry framing pinned. The 'Use the conflict response, not a recursive client retry — log the version drift for audit' wording protects against tight-loop retries that mask the drift.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /Use the conflict response, not a recursive\s*\n?\s+client retry — log the version drift for audit\./,
    );
  });

  // V-1144 — this froze the whole sentence in one regex, stable anchor and volatile
  // claim together, so the citation could not be corrected without a red. The claim was
  // wrong twice over: it sent a customer exercising erasure to `docs/legal/dpa.md`, a
  // repo path they cannot open, and that document contains no Article 17 material at all
  // — its only "17" is the effective date, and its deletion clause (§3.8) is
  // return-or-delete at END of processing, not a data-subject request. The Article 17
  // right is in the privacy policy, which is published.
  it('CRITICAL append-only + no-DELETE-or-PATCH framing pinned, with the erasure pointer split out. A customer who reads this line is trying to withdraw consent, so where it sends them is the load-bearing half — and the anchor is separated from it so the pointer can be corrected without fighting the pin.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/The acceptance row is append-only — there is no `DELETE` or\s*\n?`PATCH`\./);
    expect(p).toMatch(/Article 17 right to erasure set out in the/);
    expect(p).toMatch(/\[privacy policy\]\(https:\/\/driftstack\.io\/legal\/privacy\/\)/);

    // V-1144 negative — the retired pointer, quoted so it cannot return. The DPA has no
    // Article 17 procedure to follow.
    expect(p, 'the erasure pointer names the DPA again').not.toMatch(
      /`docs\/legal\/dpa\.md` Art\. 17/,
    );
  });

  it('CRITICAL 3-location framing pinned — Public marketing /legal/* + Canonical repo docs/legal/*.md + API catalog metadata-only. The 3-layer model explains where each source is canonical.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/\*\*Public \(marketing site\)\*\*: `\/legal\/terms`, `\/legal\/privacy`,/);
    expect(p).toMatch(/\*\*Canonical \(repo\)\*\*: `docs\/legal\/\*\.md`\./);
    expect(p).toMatch(
      /\*\*API catalog\*\*: this endpoint set surfaces metadata; never\s*\n?\s+the document body\. Read the public URLs for the body\./,
    );
  });

  it("CRITICAL scope-required per-endpoint pinned. The two GET endpoints (GET /v1/legal/documents + GET /v1/legal/required) are auth-only — their handlers use requireAuth with no requireScope (legal.ts) — so the doc must NOT overstate a read/account_owner scope. S36 2026-07-07 (fable-truth-audit): POST /v1/legal/accept requires the account_owner scope (legal.ts:93 requireScope('account_owner')) and hasScope does NOT let a broad `write` key satisfy account_owner (only exact match or the V-174 admin alias) — the old 'write or account_owner' claim would 403 a write-scoped key.", () => {
    const p = read(PAGE);

    const authOnlyMatches = (
      p.match(
        /Requires authentication; no specific API-key scope is needed beyond a\s*\n?valid key\./g,
      ) ?? []
    ).length;
    expect(authOnlyMatches).toBeGreaterThanOrEqual(2);
    expect(p).toMatch(
      /Required scope: `account_owner` \(the route gates acceptance on\s*\n?`account_owner` — a broad `write` key is not sufficient\)\./,
    );
    // Drift sentinels — neither overstated scope claim may come back.
    expect(p).not.toMatch(/Required scope: `read` or `account_owner`\./);
    expect(p).not.toMatch(/Required scope: `write` or `account_owner`\./);
  });

  it('CRITICAL Source-of-truth pointers pinned — routes/legal.ts + services/legal.ts + db/legal-repo.ts + services/legal-catalog.ts. Drift would lose the canonical impl pointers.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/Routes: `apps\/server\/src\/routes\/legal\.ts`\./);
    expect(p).toMatch(/Service:\s*\n?`apps\/server\/src\/services\/legal\.ts`\./);
    expect(p).toMatch(/Repo:\s*\n?`apps\/server\/src\/db\/legal-repo\.ts`\./);
    expect(p).toMatch(
      /Catalog\s*\n?configuration: `apps\/server\/src\/services\/legal-catalog\.ts`\./,
    );
  });

  it('CRITICAL 3-endpoint canonical action set — GET /v1/legal/documents + GET /v1/legal/required + POST /v1/legal/accept.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/`GET \/v1\/legal\/documents`/);
    expect(p).toMatch(/`GET \/v1\/legal\/required`/);
    expect(p).toMatch(/`POST \/v1\/legal\/accept`/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/docs-pages-api-legal-content-parity.test.ts'),
      ),
    ).toBe(true);
  });
});
