// W592.D — drift guard for packages/sdk-go/legal.go.

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

  it('V-049/V-458 LegalResource: marketing-site-serves-content + catalog+acceptance machinery; LegalDocumentEntry (7-field) + LegalRequiredEntry (5-field nullable last_accepted) + AcceptLegalDocumentRequest/Response; 3 verbs (Documents + Required + Accept) pinned', () => {
    expect(body).toMatch(/\/\/ LegalResource handles \/v1\/legal\/\* \(V-049 \/ V-458\)\./);
    expect(body).toMatch(
      /\/\/ Customer acceptance of legal documents \(ToS \/ Privacy \/ DPA \/ AUP\)\./,
    );
    expect(body).toMatch(/\/\/ Document content is served separately on the marketing site;/);
    expect(body).toMatch(/\/\/ this resource handles the catalog \+ acceptance machinery\./);
    expect(body).toMatch(
      /^type LegalDocumentEntry struct \{\s*\n\s*DocumentKey\s+string `json:"document_key"`\s*\n\s*Title\s+string `json:"title"`\s*\n\s*Version\s+string `json:"version"`\s*\n\s*EffectiveDate string `json:"effective_date"`\s*\n\s*ContentHash\s+string `json:"content_hash"`\s*\n\s*SourcePath\s+string `json:"source_path"`\s*\n\s*ByteSize\s+int\s+`json:"byte_size"`\s*\n\}/m,
    );
    expect(body).toMatch(
      /^type LegalRequiredEntry struct \{\s*\n\s*DocumentKey\s+string\s+`json:"document_key"`\s*\n\s*CurrentVersion\s+string\s+`json:"current_version"`\s*\n\s*ContentHash\s+string\s+`json:"content_hash"`\s*\n\s*Reason\s+string\s+`json:"reason"`\s*\n\s*LastAcceptedVersion \*string `json:"last_accepted_version"`\s*\n\}/m,
    );
    expect(body).toMatch(
      /\/\/ AcceptLegalDocumentRequest — record acceptance of a \(document, version,/,
    );
    expect(body).toMatch(/\/\/ content_hash\) tuple\./);
    expect(body).toMatch(
      /^type AcceptLegalDocumentResponse struct \{\s*\n\s*ID\s+string\s+`json:"id"`\s*\n\s*AccountID\s+string\s+`json:"account_id"`\s*\n\s*DocumentKey string\s+`json:"document_key"`\s*\n\s*Version\s+string\s+`json:"version"`\s*\n\s*ContentHash string\s+`json:"content_hash"`\s*\n\s*AcceptedAt\s+time\.Time `json:"accepted_at"`\s*\n\}/m,
    );
    expect(body).toMatch(/\/\/ Documents lists the legal-document catalog\./);
    expect(body).toMatch(/path:\s+"\/v1\/legal\/documents",/);
    expect(body).toMatch(
      /\/\/ Required lists documents the calling account must accept \(or re-accept\)\./,
    );
    expect(body).toMatch(/path:\s+"\/v1\/legal\/required",/);
    expect(body).toMatch(
      /\/\/ Accept records acceptance of a \(document, version, content_hash\) tuple\./,
    );
    expect(body).toMatch(/path:\s+"\/v1\/legal\/accept",/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
