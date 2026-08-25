// W400.B — drift guard for apps/server/src/services/legal-catalog.ts.
// Boot-time loader for the bound legal documents (docs/legal/*.md).
// Each entry binds documentKey → version + effective date + SHA-256
// content hash. Drift here would either let the server boot with an
// unparseable doc header (silent acceptance gating bypass) or
// re-order the bound key set so acceptances point at the wrong doc.
//
//   • 4 DEFAULT_SOURCES: tos / privacy / dpa / aup with canonical
//     filePath bindings.
//   • Header regex: **Version:** SemVer · **Effective:** YYYY-MM-DD.
//   • Fail-fast at startup on missing header (better than silent
//     serving without acceptance gating).
//   • LegalDocumentEntry: 7 fields (documentKey / title / version /
//     effectiveDate / contentHash / sourcePath / byteSize).
//   • buildLegalCatalog: reads from disk via readFileSync.
//   • buildLegalCatalogFromContent: in-memory test seam (no disk).
//   • SHA-256 hex digest of file content at load time, lowercase.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/services/legal-catalog.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W400.B apps/server/src/services/legal-catalog.ts content parity', () => {
  const body = read(LIB);

  it('Module framing pinned: boot-time loader + content-hash + LegalService consumer', () => {
    expect(body).toMatch(
      /LegalDocumentCatalog — loads the bound legal documents at server\s*\/\/\s*startup, computes content hashes, and exposes the catalog to the\s*\/\/\s*LegalService\./,
    );
  });

  it('Header format pinned: **Version:** X · **Effective:** YYYY-MM-DD', () => {
    expect(body).toMatch(
      /Each document's header\s*\/\/\s*is expected to contain a line of the form:\s*\/\/\s*\/\/\s*\*\*Version:\*\* 0\.1\.0-draft · \*\*Effective:\*\* 2026-05-03/,
    );
  });

  it('Fail-fast framing pinned: missing-header → throw at startup (better than silent serving without acceptance gating)', () => {
    expect(body).toMatch(
      /If the line is missing, the loader fails fast at startup; this is\s*\/\/\s*preferable to silently serving documents without acceptance gating\./,
    );
  });

  it('LegalDocumentEntry: 7 fields (documentKey / title / version / effectiveDate / contentHash / sourcePath / byteSize)', () => {
    expect(body).toMatch(/export interface LegalDocumentEntry \{/);
    expect(body).toMatch(
      /\/\*\* Stable key — 'tos' \| 'privacy' \| 'dpa' \| 'aup'\. \*\/\s*documentKey: string;/,
    );
    expect(body).toMatch(/\/\*\* Display title for client surfaces\. \*\/\s*title: string;/);
    expect(body).toMatch(
      /\/\*\* SemVer-shaped version parsed from the document header\. \*\/\s*version: string;/,
    );
    expect(body).toMatch(
      /\/\*\* Effective date \(ISO 8601 yyyy-mm-dd\) parsed from the header\. \*\/\s*effectiveDate: string;/,
    );
    expect(body).toMatch(
      /\/\*\* SHA-256 hex digest of the file content at load time, lowercase\. \*\/\s*contentHash: string;/,
    );
    expect(body).toMatch(
      /\/\*\* Repo-relative path to the source file\. \*\/\s*sourcePath: string;/,
    );
    expect(body).toMatch(
      /\/\*\* Length in bytes \(informational, surfaces in client APIs\)\. \*\/\s*byteSize: number;/,
    );
  });

  it('LegalDocumentCatalog: 2-method interface (entries / get)', () => {
    expect(body).toMatch(
      /export interface LegalDocumentCatalog \{\s*entries\(\): LegalDocumentEntry\[\];\s*get\(documentKey: string\): LegalDocumentEntry \| undefined;\s*\}/,
    );
  });

  it('DEFAULT_SOURCES: 4 entries (tos / privacy / dpa / aup) with canonical filePath bindings', () => {
    expect(body).toMatch(/const DEFAULT_SOURCES: DocSource\[\] = \[/);
    expect(body).toMatch(
      /\{\s*documentKey: 'tos',\s*title: 'Terms of Service',\s*filePath: 'docs\/legal\/terms-of-service\.md',\s*\},/,
    );
    expect(body).toMatch(
      /\{\s*documentKey: 'privacy',\s*title: 'Privacy Policy',\s*filePath: 'docs\/legal\/privacy-policy\.md',\s*\},/,
    );
    expect(body).toMatch(
      /\{\s*documentKey: 'dpa',\s*title: 'Data Processing Agreement',\s*filePath: 'docs\/legal\/dpa\.md',\s*\},/,
    );
    expect(body).toMatch(
      /\{\s*documentKey: 'aup',\s*title: 'Acceptable Use Policy',\s*filePath: 'docs\/legal\/acceptable-use-policy\.md',\s*\},/,
    );
  });

  it('buildLegalCatalog: reads file + parses header + computes sha256 hex + Buffer.byteLength byteSize', () => {
    expect(body).toMatch(
      /export function buildLegalCatalog\(opts: \{\s*repoRoot: string;\s*sources\?: DocSource\[\];\s*\}\): LegalDocumentCatalog \{/,
    );
    expect(body).toMatch(/const sources = opts\.sources \?\? DEFAULT_SOURCES;/);
    expect(body).toMatch(/const fullPath = resolve\(opts\.repoRoot, src\.filePath\);/);
    expect(body).toMatch(/const content = readFileSync\(fullPath, 'utf8'\);/);
    expect(body).toMatch(
      /const \{ version, effectiveDate \} = parseLegalHeader\(content, src\.documentKey\);/,
    );
    expect(body).toMatch(
      /const contentHash = createHash\('sha256'\)\.update\(content\)\.digest\('hex'\);/,
    );
    expect(body).toMatch(/byteSize: Buffer\.byteLength\(content, 'utf8'\),/);
  });

  it("buildLegalCatalogFromContent: in-memory test seam (no disk reads — tests don't need files)", () => {
    expect(body).toMatch(
      /Build a catalog directly from in-memory document strings\. Used by\s*\*\s*tests so they don't need to read from disk\./,
    );
    expect(body).toMatch(
      /export function buildLegalCatalogFromContent\(\s*documents: Array<\{ documentKey: string; title: string; content: string; sourcePath: string \}>,\s*\): LegalDocumentCatalog \{/,
    );
  });

  it('HEADER_RE: parses **Version:** \\S+ · **Effective:** YYYY-MM-DD regex', () => {
    expect(body).toMatch(
      /const HEADER_RE = \/\\\*\\\*Version:\\\*\\\*\\s\*\(\\S\+\)\\s\*·\\s\*\\\*\\\*Effective:\\\*\\\*\\s\*\(\\d\{4\}-\\d\{2\}-\\d\{2\}\)\/;/,
    );
  });

  it('parseLegalHeader: throws on missing header OR group-match mismatch (defensive type guard)', () => {
    expect(body).toMatch(
      /function parseLegalHeader\(\s*content: string,\s*documentKey: string,\s*\): \{ version: string; effectiveDate: string \} \{/,
    );
    expect(body).toMatch(/const match = HEADER_RE\.exec\(content\);/);
    expect(body).toMatch(
      /if \(match === null\) \{\s*throw new Error\(\s*`Legal document \$\{documentKey\} is missing the standard "\*\*Version:\*\* … · \*\*Effective:\*\* YYYY-MM-DD" header line\.`,\s*\);/,
    );
    expect(body).toMatch(
      /if \(version === undefined \|\| effectiveDate === undefined\) \{\s*throw new Error\(`Legal document \$\{documentKey\} header parse mismatch\.`\);\s*\}/,
    );
  });

  it('imports: createHash from node:crypto + readFileSync from node:fs + resolve from node:path', () => {
    expect(body).toMatch(/import \{ createHash \} from 'node:crypto';/);
    expect(body).toMatch(/import \{ readFileSync \} from 'node:fs';/);
    expect(body).toMatch(/import \{ resolve \} from 'node:path';/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
