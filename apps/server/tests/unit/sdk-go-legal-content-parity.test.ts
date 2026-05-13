// W592.D (W630-deepened) — drift guard for packages/sdk-go/legal.go.
// V-049 / V-458 LegalResource.
//
// W630 splits the original single 30-assertion it() block into per-
// concept focused blocks + pins previously-implicit invariants:
//
//   • Content-vs-catalog separation: "Document content is served
//     separately on the marketing site; this resource handles the
//     catalog + acceptance machinery." This is the load-bearing
//     architectural invariant that keeps the legal-doc PDFs OUT of
//     the API surface (binary content stays on Cloudflare Pages
//     marketing-site).
//   • AcceptLegalDocumentRequest 3-tuple integrity: (document_key,
//     version, content_hash). The hash is what binds an acceptance
//     to a specific snapshot of the document text — if a customer
//     accepted version "1.2" but the content_hash changes, the
//     acceptance is stale and must be re-collected.
//   • LegalRequiredEntry "last_accepted_version" nullability: *string,
//     null when the account has never accepted this document. The
//     Reason field documents why re-acceptance is required (new
//     version, hash-mismatch, etc.).
//   • HTTP-method correctness: Documents/Required are GET, Accept is
//     POST. The 4 struct shapes pinned with exact json tags so a
//     SDK regen can't silently drop a field.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/sdk-go/legal.go');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W592.D packages/sdk-go/legal.go content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path + LegalResource V-049/V-458 anchor + content-vs-catalog separation invariant ("Document content is served separately on the marketing site; this resource handles the catalog + acceptance machinery") — the architectural rule that keeps legal-doc text OUT of the API surface', () => {
    expect(existsSync(LIB)).toBe(true);
    expect(body).toMatch(/^package driftstack$/m);
    expect(body).toMatch(/\/\/ LegalResource handles \/v1\/legal\/\* \(V-049 \/ V-458\)\./);
    expect(body).toMatch(
      /\/\/ Customer acceptance of legal documents \(ToS \/ Privacy \/ DPA \/ AUP\)\./,
    );
    expect(body).toMatch(/\/\/ Document content is served separately on the marketing site;/);
    expect(body).toMatch(/\/\/ this resource handles the catalog \+ acceptance machinery\./);
    expect(body).toMatch(/^type LegalResource struct \{\s*\n\s*client \*Client\s*\n\}/m);
  });

  it('LegalDocumentEntry — 7-field catalog row with exact json tags: DocumentKey + Title + Version + EffectiveDate + ContentHash + SourcePath + ByteSize. SourcePath points at the marketing-site MDX file so customers can fetch the rendered HTML if needed; ContentHash is what binds a row to a specific snapshot of text.', () => {
    expect(body).toMatch(
      /^type LegalDocumentEntry struct \{\s*\n\s*DocumentKey\s+string `json:"document_key"`\s*\n\s*Title\s+string `json:"title"`\s*\n\s*Version\s+string `json:"version"`\s*\n\s*EffectiveDate string `json:"effective_date"`\s*\n\s*ContentHash\s+string `json:"content_hash"`\s*\n\s*SourcePath\s+string `json:"source_path"`\s*\n\s*ByteSize\s+int\s+`json:"byte_size"`\s*\n\}/m,
    );
    expect(body).toMatch(
      /^type ListLegalDocumentsResponse struct \{\s*\n\s*Data \[\]LegalDocumentEntry `json:"data"`\s*\n\}/m,
    );
  });

  it('LegalRequiredEntry — 5-field "what must be accepted" row with nullable LastAcceptedVersion *string (null when the account has never accepted this document). Reason field documents WHY re-acceptance is required (new version / hash-mismatch / first-time) so the dashboard can render the right copy.', () => {
    expect(body).toMatch(
      /\/\/ LegalRequiredEntry — one document the calling account must accept\./,
    );
    expect(body).toMatch(
      /^type LegalRequiredEntry struct \{\s*\n\s*DocumentKey\s+string\s+`json:"document_key"`\s*\n\s*CurrentVersion\s+string\s+`json:"current_version"`\s*\n\s*ContentHash\s+string\s+`json:"content_hash"`\s*\n\s*Reason\s+string\s+`json:"reason"`\s*\n\s*LastAcceptedVersion \*string `json:"last_accepted_version"`\s*\n\}/m,
    );
    expect(body).toMatch(
      /^type ListLegalRequiredResponse struct \{\s*\n\s*Data \[\]LegalRequiredEntry `json:"data"`\s*\n\}/m,
    );
  });

  it('AcceptLegalDocumentRequest + AcceptLegalDocumentResponse — 3-tuple integrity (document_key, version, content_hash). The hash is what binds an acceptance to a specific snapshot of the document text: if a customer accepted version "1.2" but the underlying text changes (content_hash differs), the acceptance is STALE and Required will re-list the doc. Drift to dropping ContentHash from either side would break the version-binding contract.', () => {
    expect(body).toMatch(
      /\/\/ AcceptLegalDocumentRequest — record acceptance of a \(document, version,/,
    );
    expect(body).toMatch(/\/\/ content_hash\) tuple\./);
    expect(body).toMatch(
      /^type AcceptLegalDocumentRequest struct \{\s*\n\s*DocumentKey string `json:"document_key"`\s*\n\s*Version\s+string `json:"version"`\s*\n\s*ContentHash string `json:"content_hash"`\s*\n\}/m,
    );
    expect(body).toMatch(
      /^type AcceptLegalDocumentResponse struct \{\s*\n\s*ID\s+string\s+`json:"id"`\s*\n\s*AccountID\s+string\s+`json:"account_id"`\s*\n\s*DocumentKey string\s+`json:"document_key"`\s*\n\s*Version\s+string\s+`json:"version"`\s*\n\s*ContentHash string\s+`json:"content_hash"`\s*\n\s*AcceptedAt\s+time\.Time `json:"accepted_at"`\s*\n\}/m,
    );
  });

  it('Documents — GET /v1/legal/documents lists the full catalog (no body, no query params, no per-account filtering — same catalog for every account)', () => {
    expect(body).toMatch(/\/\/ Documents lists the legal-document catalog\./);
    expect(body).toMatch(
      /func \(r \*LegalResource\) Documents\(ctx context\.Context\) \(\*ListLegalDocumentsResponse, error\)/,
    );
    expect(body).toMatch(/method: "GET",\s*\n\s*path:\s+"\/v1\/legal\/documents",/);
  });

  it("Required — GET /v1/legal/required lists documents the calling account must accept (or re-accept). Account-scoped via bearer token — never a parameter, so customers can never enumerate someone else's required-acceptance state.", () => {
    expect(body).toMatch(
      /\/\/ Required lists documents the calling account must accept \(or re-accept\)\./,
    );
    expect(body).toMatch(
      /func \(r \*LegalResource\) Required\(ctx context\.Context\) \(\*ListLegalRequiredResponse, error\)/,
    );
    expect(body).toMatch(/method: "GET",\s*\n\s*path:\s+"\/v1\/legal\/required",/);
  });

  it("Accept — POST /v1/legal/accept records acceptance of a (document, version, content_hash) tuple. The server validates the hash matches the current catalog row before persisting — if a customer's SDK is out of date and posts a stale hash, the server rejects rather than silently accepting an obsolete version.", () => {
    expect(body).toMatch(
      /\/\/ Accept records acceptance of a \(document, version, content_hash\) tuple\./,
    );
    expect(body).toMatch(
      /func \(r \*LegalResource\) Accept\(ctx context\.Context, body \*AcceptLegalDocumentRequest\) \(\*AcceptLegalDocumentResponse, error\)/,
    );
    expect(body).toMatch(/method: "POST",\s*\n\s*path:\s+"\/v1\/legal\/accept",/);
  });
});
