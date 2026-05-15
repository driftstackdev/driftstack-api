// W952 — legal-catalog cross-source invariant. Two-hundred-seventy-
// eighth in the drift-guard series. Pins the LegalDocumentCatalog
// loader + parser:
//
//   Service intro — 'LegalDocumentCatalog — loads the bound legal
//   documents at server startup, computes content hashes, and
//   exposes the catalog to the LegalService'.
//
//   Document-source-of-truth framing — 'The catalog is built from
//   docs/legal/*.md. Each document's header is expected to contain
//   a line of the form: **Version:** 0.1.0-draft · **Effective:**
//   2026-05-03 — the loader parses the version + effective date out
//   of that line. If the line is missing, the loader fails fast at
//   startup; this is preferable to silently serving documents
//   without acceptance gating'.
//
//   LegalDocumentEntry (7 fields):
//     - documentKey ('tos' | 'privacy' | 'dpa' | 'aup').
//     - title (display title for client surfaces).
//     - version (SemVer-shaped, parsed from header).
//     - effectiveDate (ISO 8601 yyyy-mm-dd, parsed from header).
//     - contentHash (SHA-256 hex, lowercase).
//     - sourcePath (repo-relative).
//     - byteSize (informational; surfaces in client APIs).
//
//   LegalDocumentCatalog 2-method interface: entries() + get().
//
//   DEFAULT_SOURCES — 4-doc binding:
//     - tos → Terms of Service / docs/legal/terms-of-service.md.
//     - privacy → Privacy Policy / docs/legal/privacy-policy.md.
//     - dpa → Data Processing Agreement / docs/legal/dpa.md.
//     - aup → Acceptable Use Policy /
//       docs/legal/acceptable-use-policy.md.
//
//   2 catalog builders:
//     - buildLegalCatalog({ repoRoot, sources? }) — disk-based;
//       throws on missing files or unparseable headers.
//     - buildLegalCatalogFromContent(documents) — in-memory; used
//       by tests so they don't need to read from disk.
//
//   HEADER_RE regex parses '**Version:** <semver> · **Effective:**
//     YYYY-MM-DD' line.
//
//   parseLegalHeader throws 2-distinct-error-paths:
//     - 'Legal document X is missing the standard "**Version:** …
//       · **Effective:** YYYY-MM-DD" header line.' on no match.
//     - 'Legal document X header parse mismatch.' on capture-group
//       undefined.
//
// stays in lockstep across apps/server/src/services/legal-catalog.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildLegalCatalogFromContent } from '../../src/services/legal-catalog.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const SAMPLE_HEADER = '**Version:** 0.1.0-draft · **Effective:** 2026-05-03';

describe('W952 legal-catalog cross-source invariant', () => {
  // ─── Service intro ───────────────────────────────────────────

  it("CRITICAL apps/server/src/services/legal-catalog.ts header pins surface — 'LegalDocumentCatalog — loads the bound legal documents at server startup, computes content hashes, and exposes the catalog to the LegalService'. The startup-load + hash + LegalService-consumer is the central design.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/legal-catalog.ts'));
    expect(p).toMatch(/LegalDocumentCatalog — loads the bound legal documents at server/);
    expect(p).toMatch(/startup, computes content hashes, and exposes the catalog to the/);
    expect(p).toMatch(/LegalService\./);
  });

  // ─── Document-source-of-truth + fail-fast framing ────────────

  it("CRITICAL docs-as-source framing — 'The catalog is built from docs/legal/*.md. Each document's header is expected to contain a line of the form: **Version:** 0.1.0-draft · **Effective:** 2026-05-03 — the loader parses the version + effective date out of that line. If the line is missing, the loader fails fast at startup; this is preferable to silently serving documents without acceptance gating'. The header-format + fail-fast + acceptance-gating framing is the policy provenance.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/legal-catalog.ts'));
    expect(p).toMatch(/The catalog is built from `docs\/legal\/\*\.md`\. Each document's header/);
    expect(p).toMatch(/is expected to contain a line of the form:/);
    expect(p).toMatch(/\*\*Version:\*\* 0\.1\.0-draft · \*\*Effective:\*\* 2026-05-03/);
    expect(p).toMatch(/— the loader parses the version \+ effective date out of that line\./);
    expect(p).toMatch(/If the line is missing, the loader fails fast at startup; this is/);
    expect(p).toMatch(/preferable to silently serving documents without acceptance gating\./);
  });

  // ─── LegalDocumentEntry 7-field shape ────────────────────────

  it('CRITICAL LegalDocumentEntry has 7 fields — documentKey + title + version + effectiveDate + contentHash + sourcePath + byteSize. The 7-field shape is the W945 LegalService consumer contract.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/legal-catalog.ts'));
    expect(p).toMatch(/export interface LegalDocumentEntry \{/);
    expect(p).toMatch(/Stable key — 'tos' \| 'privacy' \| 'dpa' \| 'aup'\./);
    expect(p).toMatch(/documentKey: string;/);
    expect(p).toMatch(/Display title for client surfaces\./);
    expect(p).toMatch(/title: string;/);
    expect(p).toMatch(/SemVer-shaped version parsed from the document header\./);
    expect(p).toMatch(/version: string;/);
    expect(p).toMatch(/Effective date \(ISO 8601 yyyy-mm-dd\) parsed from the header\./);
    expect(p).toMatch(/effectiveDate: string;/);
    expect(p).toMatch(/SHA-256 hex digest of the file content at load time, lowercase\./);
    expect(p).toMatch(/contentHash: string;/);
    expect(p).toMatch(/Repo-relative path to the source file\./);
    expect(p).toMatch(/sourcePath: string;/);
    expect(p).toMatch(/Length in bytes \(informational, surfaces in client APIs\)\./);
    expect(p).toMatch(/byteSize: number;/);
  });

  // ─── LegalDocumentCatalog 2-method interface ─────────────────

  it('CRITICAL LegalDocumentCatalog has 2 methods — entries() + get(). The 2-method interface is what the W945 LegalService consumes.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/legal-catalog.ts'));
    expect(p).toMatch(/export interface LegalDocumentCatalog \{/);
    expect(p).toMatch(/entries\(\): LegalDocumentEntry\[\];/);
    expect(p).toMatch(/get\(documentKey: string\): LegalDocumentEntry \| undefined;/);
  });

  // ─── DEFAULT_SOURCES 4-doc binding ───────────────────────────

  it('CRITICAL DEFAULT_SOURCES binds 4 documents: tos→Terms of Service/docs/legal/terms-of-service.md + privacy→Privacy Policy/docs/legal/privacy-policy.md + dpa→Data Processing Agreement/docs/legal/dpa.md + aup→Acceptable Use Policy/docs/legal/acceptable-use-policy.md. The 4-binding ordered tuple is the source-of-truth document set.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/legal-catalog.ts'));
    expect(p).toMatch(/const DEFAULT_SOURCES: DocSource\[\] = \[/);
    expect(p).toMatch(/documentKey: 'tos',/);
    expect(p).toMatch(/title: 'Terms of Service',/);
    expect(p).toMatch(/filePath: 'docs\/legal\/terms-of-service\.md',/);
    expect(p).toMatch(/documentKey: 'privacy',/);
    expect(p).toMatch(/title: 'Privacy Policy',/);
    expect(p).toMatch(/filePath: 'docs\/legal\/privacy-policy\.md',/);
    expect(p).toMatch(/documentKey: 'dpa',/);
    expect(p).toMatch(/title: 'Data Processing Agreement',/);
    expect(p).toMatch(/filePath: 'docs\/legal\/dpa\.md',/);
    expect(p).toMatch(/documentKey: 'aup',/);
    expect(p).toMatch(/title: 'Acceptable Use Policy',/);
    expect(p).toMatch(/filePath: 'docs\/legal\/acceptable-use-policy\.md',/);
  });

  it("CRITICAL DEFAULT_SOURCES default-source framing — 'Default source list. Each entry binds the stable documentKey to the source file path. Adding a new bound document = appending here + generating the .md file with the standard header'. The append-here-to-extend pattern is the extension contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/legal-catalog.ts'));
    expect(p).toMatch(/Default source list\. Each entry binds the stable documentKey to the/);
    expect(p).toMatch(/source file path\. Adding a new bound document = appending here \+/);
    expect(p).toMatch(/generating the `\.md` file with the standard header\./);
  });

  // ─── buildLegalCatalog disk-based + fail-fast ────────────────

  it("CRITICAL buildLegalCatalog JSDoc — 'Build a catalog from the given repo root + source list. Reads each file, parses the header, computes the hash. Throws on missing files or unparseable headers'. The throws-on-missing matches fail-fast intent.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/legal-catalog.ts'));
    expect(p).toMatch(/Build a catalog from the given repo root \+ source list\. Reads each/);
    expect(p).toMatch(/file, parses the header, computes the hash\. Throws on missing files/);
    expect(p).toMatch(/or unparseable headers\./);
    expect(p).toMatch(/export function buildLegalCatalog\(opts: \{/);
    expect(p).toMatch(/repoRoot: string;/);
    expect(p).toMatch(/sources\?: DocSource\[\];/);
  });

  // ─── buildLegalCatalogFromContent test-builder ───────────────

  it("CRITICAL buildLegalCatalogFromContent JSDoc — 'Build a catalog directly from in-memory document strings. Used by tests so they don't need to read from disk'. The in-memory builder is the W945 LegalService test-fixture seam.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/legal-catalog.ts'));
    expect(p).toMatch(/Build a catalog directly from in-memory document strings\. Used by/);
    expect(p).toMatch(/tests so they don't need to read from disk\./);
    expect(p).toMatch(/export function buildLegalCatalogFromContent\(/);
  });

  // ─── HEADER_RE regex ─────────────────────────────────────────

  it('CRITICAL HEADER_RE = /\\*\\*Version:\\*\\*\\s*(\\S+)\\s*·\\s*\\*\\*Effective:\\*\\*\\s*(\\d{4}-\\d{2}-\\d{2})/ — captures SemVer-shape version + YYYY-MM-DD effective date. The 2-capture regex is the docs-header parser contract.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/legal-catalog.ts'));
    expect(p).toMatch(
      /const HEADER_RE = \/\\\*\\\*Version:\\\*\\\*\\s\*\(\\S\+\)\\s\*·\\s\*\\\*\\\*Effective:\\\*\\\*\\s\*\(\\d\{4\}-\\d\{2\}-\\d\{2\}\)\/;/,
    );
  });

  // ─── parseLegalHeader 2-error-path framing ───────────────────

  it('CRITICAL parseLegalHeader throws \'Legal document X is missing the standard "**Version:** … · **Effective:** YYYY-MM-DD" header line.\' on no match. The interpolated-key + format-quoted message is the fail-fast error contract.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/legal-catalog.ts'));
    expect(p).toMatch(
      /`Legal document \$\{documentKey\} is missing the standard "\*\*Version:\*\* … · \*\*Effective:\*\* YYYY-MM-DD" header line\.`,/,
    );
  });

  it("CRITICAL parseLegalHeader throws 'Legal document X header parse mismatch.' when capture-groups are undefined. The 2nd error path defends against regex edge cases.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/legal-catalog.ts'));
    expect(p).toMatch(
      /throw new Error\(`Legal document \$\{documentKey\} header parse mismatch\.`\);/,
    );
  });

  // ─── Runtime parity: buildLegalCatalogFromContent ────────────

  it('CRITICAL buildLegalCatalogFromContent runtime — parses header, computes sha256, returns 7-field LegalDocumentEntry with version + effectiveDate from parser.', () => {
    const content = `# Terms of Service\n\n${SAMPLE_HEADER}\n\nBody...`;
    const catalog = buildLegalCatalogFromContent([
      {
        documentKey: 'tos',
        title: 'Terms of Service',
        content,
        sourcePath: 'docs/legal/terms-of-service.md',
      },
    ]);
    const entry = catalog.get('tos');
    expect(entry).toBeDefined();
    expect(entry!.documentKey).toBe('tos');
    expect(entry!.title).toBe('Terms of Service');
    expect(entry!.version).toBe('0.1.0-draft');
    expect(entry!.effectiveDate).toBe('2026-05-03');
    expect(entry!.sourcePath).toBe('docs/legal/terms-of-service.md');
    expect(entry!.contentHash).toMatch(/^[0-9a-f]{64}$/); // sha256 hex
    expect(entry!.byteSize).toBe(Buffer.byteLength(content, 'utf8'));
  });

  it("CRITICAL buildLegalCatalogFromContent throws on missing header — 'Legal document X is missing the standard ... header line.' interpolation. Verified mechanically.", () => {
    expect(() =>
      buildLegalCatalogFromContent([
        {
          documentKey: 'tos',
          title: 'TOS',
          content: 'No header at all',
          sourcePath: 'docs/legal/terms-of-service.md',
        },
      ]),
    ).toThrow(/Legal document tos is missing the standard/);
  });

  it('CRITICAL buildLegalCatalogFromContent entries() returns all docs + get() finds by documentKey. The 2-method shape is verified mechanically.', () => {
    const docs = [
      { documentKey: 'tos', title: 'TOS', content: `# X\n${SAMPLE_HEADER}\n`, sourcePath: 'a.md' },
      {
        documentKey: 'privacy',
        title: 'PRIV',
        content: `# Y\n${SAMPLE_HEADER}\n`,
        sourcePath: 'b.md',
      },
    ];
    const catalog = buildLegalCatalogFromContent(docs);
    expect(catalog.entries()).toHaveLength(2);
    expect(catalog.get('tos')?.title).toBe('TOS');
    expect(catalog.get('privacy')?.title).toBe('PRIV');
    expect(catalog.get('unknown')).toBeUndefined();
  });

  it('CRITICAL buildLegalCatalogFromContent contentHash matches createHash("sha256").update(content).digest("hex") — sha256-of-content. Verified mechanically.', async () => {
    const { createHash } = await import('node:crypto');
    const content = `${SAMPLE_HEADER}\n\nBody`;
    const expected = createHash('sha256').update(content).digest('hex');
    const catalog = buildLegalCatalogFromContent([
      {
        documentKey: 'tos',
        title: 'T',
        content,
        sourcePath: 'docs/legal/terms-of-service.md',
      },
    ]);
    expect(catalog.get('tos')!.contentHash).toBe(expected);
  });

  // ─── DocSource 3-field shape ─────────────────────────────────

  it('CRITICAL DocSource has 3 fields — documentKey + title + filePath. The 3-field source binding is the catalog input contract.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/legal-catalog.ts'));
    expect(p).toMatch(/interface DocSource \{/);
    expect(p).toMatch(/documentKey: string;/);
    expect(p).toMatch(/title: string;/);
    expect(p).toMatch(/filePath: string;/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/legal-catalog-cross-source-invariant.test.ts'),
      ),
    ).toBe(true);
  });
});
