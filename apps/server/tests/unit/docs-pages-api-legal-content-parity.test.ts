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

  it('CRITICAL source_path canonical-repo paths pinned — docs/legal/terms-of-service.md / privacy-policy.md / dpa.md / aup.md. Matches the canonical repo source-of-truth.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/"source_path": "docs\/legal\/terms-of-service\.md"/);
    expect(p).toMatch(/"source_path": "docs\/legal\/privacy-policy\.md"/);
    expect(p).toMatch(/"source_path": "docs\/legal\/dpa\.md"/);
    expect(p).toMatch(/"source_path": "docs\/legal\/aup\.md"/);
  });

  it("CRITICAL content-hash-binding rejection framing pinned. The 'Customers ship a hash with their acceptance; if the document text has changed in any way — even a typo fix — the hash differs and the acceptance is rejected with 409 (the customer must re-fetch + re-accept)' wording is the load-bearing tamper-resistance contract.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /Customers ship a hash with\s*\n?their acceptance; if the document text has changed in any way —\s*\n?even a typo fix — the hash differs and the acceptance is\s*\n?rejected with 409 \(the customer must re-fetch \+ re-accept\)\./,
    );
  });

  it('CRITICAL 3-reason enum pinned — never_accepted / subprocessor_amendment / version_bumped. Drift to dropping subprocessor_amendment would erode Art. 28(2) tracking.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/`never_accepted` — first-time acceptance\./);
    expect(p).toMatch(/`subprocessor_amendment` — the DPA Annex 3 sub-processor list/);
    expect(p).toMatch(/changed \(Art\. 28\(2\) trigger\)\./);
    expect(p).toMatch(/`version_bumped` — the document text changed for any reason/);
  });

  it("CRITICAL 30-day-window subprocessor_amendment framing pinned. The 'When reason: subprocessor_amendment is returned, the customer has a 30-day window per the DPA' wording matches the canonical Art. 28(2) timing.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /When `reason: subprocessor_amendment` is returned, the customer\s*\n?has a 30-day window per the DPA\./,
    );
    expect(p).toMatch(/The dashboard surfaces an\s*\n?in-app banner during that window\./);
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

  it('CRITICAL append-only + no-DELETE-or-PATCH framing pinned. The \'The acceptance row is append-only — there is no DELETE or PATCH. Customers wishing to "withdraw consent" follow the docs/legal/dpa.md Art. 17 right-to-erasure procedure rather than this endpoint\' wording matches GDPR right-of-erasure routing.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /The acceptance row is append-only — there is no `DELETE` or\s*\n?`PATCH`\. Customers wishing to "withdraw consent" follow the\s*\n?`docs\/legal\/dpa\.md` Art\. 17 right-to-erasure procedure rather\s*\n?than this endpoint\./,
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

  it('CRITICAL scope-required per-endpoint pinned. Read=read|account_owner, Write=write|account_owner. Drift would let SDK consumers send wrong-scoped requests.', () => {
    const p = read(PAGE);

    const readScopeMatches = (p.match(/Required scope: `read` or `account_owner`\./g) ?? []).length;
    expect(readScopeMatches).toBeGreaterThanOrEqual(2);
    expect(p).toMatch(/Required scope: `write` or `account_owner`\./);
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
