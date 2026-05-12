// W428.B — drift guard for packages/sdk-typescript/src/resources/legal.ts.
// V-049/V-458 LegalResource — customer acceptance machinery (ToS,
// Privacy, DPA, AUP). Drift here either breaks the content_hash
// invariant (consumer accepts the wrong-version document) or
// strips the catalog/required/accept separation (downstream
// dashboard's "accept" CTA loses its source of truth).
//
//   • Framing pinned: V-049/V-458 acceptance machinery; content
//     served separately on marketing site.
//   • LegalDocumentEntry shape pinned: 7 fields.
//   • LegalRequiredEntry shape pinned: 5 fields with last_accepted
//     nullable.
//   • AcceptLegalDocumentRequest: document_key + version +
//     64-char lowercase hex SHA-256 content_hash.
//   • AcceptLegalDocumentResponse: id + account_id + document_key +
//     version + content_hash + accepted_at.
//   • 3 verbs: documents (GET catalog) + required (GET pending) +
//     accept (POST).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/sdk-typescript/src/resources/legal.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W428.B packages/sdk-typescript/src/resources/legal.ts content parity', () => {
  const body = read(LIB);

  it('Framing pinned: V-049/V-458 typed methods for /v1/legal/* + acceptance machinery; content served separately on marketing site', () => {
    expect(body).toMatch(
      /\/\/ LegalResource — typed methods for \/v1\/legal\/\* \(V-049 \/ V-458\)\./,
    );
    expect(body).toMatch(
      /\/\/ Customer acceptance of legal documents \(ToS \/ Privacy \/ DPA \/ AUP\)\.\s*\n?\s*\/\/ Document content is served separately on the marketing site; this\s*\n?\s*\/\/ resource handles the catalog \+ acceptance machinery\./,
    );
  });

  it('LegalDocumentEntry shape pinned: document_key + title + version + effective_date + content_hash + source_path + byte_size', () => {
    expect(body).toMatch(
      /export interface LegalDocumentEntry \{\s*\n?\s*document_key: string;\s*\n?\s*title: string;\s*\n?\s*version: string;\s*\n?\s*effective_date: string;\s*\n?\s*content_hash: string;\s*\n?\s*source_path: string;\s*\n?\s*byte_size: number;\s*\n?\s*\}/,
    );
  });

  it('LegalRequiredEntry shape pinned: document_key + current_version + content_hash + reason + last_accepted_version (nullable when never accepted)', () => {
    expect(body).toMatch(
      /export interface LegalRequiredEntry \{\s*\n?\s*document_key: string;\s*\n?\s*current_version: string;\s*\n?\s*content_hash: string;\s*\n?\s*reason: string;\s*\n?\s*last_accepted_version: string \| null;\s*\n?\s*\}/,
    );
  });

  it('AcceptLegalDocumentRequest: document_key + version + 64-char lowercase hex SHA-256 content_hash; content_hash field documented inline', () => {
    expect(body).toMatch(
      /export interface AcceptLegalDocumentRequest \{\s*\n?\s*document_key: string;\s*\n?\s*version: string;\s*\n?\s*\/\*\* 64-character lowercase hex SHA-256 of the document content\. \*\/\s*\n?\s*content_hash: string;\s*\n?\s*\}/,
    );
  });

  it('AcceptLegalDocumentResponse: id + account_id + document_key + version + content_hash + accepted_at (receipt of acceptance record)', () => {
    expect(body).toMatch(
      /export interface AcceptLegalDocumentResponse \{\s*\n?\s*id: string;\s*\n?\s*account_id: string;\s*\n?\s*document_key: string;\s*\n?\s*version: string;\s*\n?\s*content_hash: string;\s*\n?\s*accepted_at: string;\s*\n?\s*\}/,
    );
  });

  it('documents verb: GET /v1/legal/documents → { data: LegalDocumentEntry[] } (full catalog)', () => {
    expect(body).toMatch(/\/\*\* List the legal-document catalog\. \*\//);
    expect(body).toMatch(
      /documents\(\): Promise<\{ data: LegalDocumentEntry\[\] \}> \{\s*\n?\s*return this\.http\.request<\{ data: LegalDocumentEntry\[\] \}>\(\{\s*\n?\s*method: 'GET',\s*\n?\s*path: '\/v1\/legal\/documents',\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
  });

  it('required verb: GET /v1/legal/required → { data: LegalRequiredEntry[] } (documents calling account must accept or re-accept)', () => {
    expect(body).toMatch(
      /\/\*\* List documents the calling account must accept \(or re-accept\)\. \*\//,
    );
    expect(body).toMatch(
      /required\(\): Promise<\{ data: LegalRequiredEntry\[\] \}> \{\s*\n?\s*return this\.http\.request<\{ data: LegalRequiredEntry\[\] \}>\(\{\s*\n?\s*method: 'GET',\s*\n?\s*path: '\/v1\/legal\/required',\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
  });

  it('accept verb: POST /v1/legal/accept; body (document_key, version, content_hash) tuple', () => {
    expect(body).toMatch(
      /\/\*\* Record acceptance of a \(document, version, content_hash\) tuple\. \*\//,
    );
    expect(body).toMatch(
      /accept\(body: AcceptLegalDocumentRequest\): Promise<AcceptLegalDocumentResponse> \{\s*\n?\s*return this\.http\.request<AcceptLegalDocumentResponse>\(\{\s*\n?\s*method: 'POST',\s*\n?\s*path: '\/v1\/legal\/accept',\s*\n?\s*body,\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
  });

  it('imports: HttpClient only (legal shapes are SDK-defined, not re-exported from api-types)', () => {
    expect(body).toMatch(/import type \{ HttpClient \} from '\.\.\/http\.js';/);
    expect(body).not.toMatch(/from '@driftstack\/api-types'/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
