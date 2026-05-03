// LegalDocumentCatalog — loads the bound legal documents at server
// startup, computes content hashes, and exposes the catalog to the
// LegalService.
//
// The catalog is built from `docs/legal/*.md`. Each document's header
// is expected to contain a line of the form:
//
//   **Version:** 0.1.0-draft · **Effective:** 2026-05-03
//
// — the loader parses the version + effective date out of that line.
// If the line is missing, the loader fails fast at startup; this is
// preferable to silently serving documents without acceptance gating.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface LegalDocumentEntry {
  /** Stable key — 'tos' | 'privacy' | 'dpa' | 'aup'. */
  documentKey: string;
  /** Display title for client surfaces. */
  title: string;
  /** SemVer-shaped version parsed from the document header. */
  version: string;
  /** Effective date (ISO 8601 yyyy-mm-dd) parsed from the header. */
  effectiveDate: string;
  /** SHA-256 hex digest of the file content at load time, lowercase. */
  contentHash: string;
  /** Repo-relative path to the source file. */
  sourcePath: string;
  /** Length in bytes (informational, surfaces in client APIs). */
  byteSize: number;
}

export interface LegalDocumentCatalog {
  entries(): LegalDocumentEntry[];
  get(documentKey: string): LegalDocumentEntry | undefined;
}

interface DocSource {
  documentKey: string;
  title: string;
  filePath: string;
}

/**
 * Default source list. Each entry binds the stable documentKey to the
 * source file path. Adding a new bound document = appending here +
 * generating the `.md` file with the standard header.
 */
const DEFAULT_SOURCES: DocSource[] = [
  {
    documentKey: 'tos',
    title: 'Terms of Service',
    filePath: 'docs/legal/terms-of-service.md',
  },
  {
    documentKey: 'privacy',
    title: 'Privacy Policy',
    filePath: 'docs/legal/privacy-policy.md',
  },
  {
    documentKey: 'dpa',
    title: 'Data Processing Agreement',
    filePath: 'docs/legal/dpa.md',
  },
  {
    documentKey: 'aup',
    title: 'Acceptable Use Policy',
    filePath: 'docs/legal/acceptable-use-policy.md',
  },
];

/**
 * Build a catalog from the given repo root + source list. Reads each
 * file, parses the header, computes the hash. Throws on missing files
 * or unparseable headers.
 */
export function buildLegalCatalog(opts: {
  repoRoot: string;
  sources?: DocSource[];
}): LegalDocumentCatalog {
  const sources = opts.sources ?? DEFAULT_SOURCES;
  const entries = new Map<string, LegalDocumentEntry>();
  for (const src of sources) {
    const fullPath = resolve(opts.repoRoot, src.filePath);
    const content = readFileSync(fullPath, 'utf8');
    const { version, effectiveDate } = parseLegalHeader(content, src.documentKey);
    const contentHash = createHash('sha256').update(content).digest('hex');
    entries.set(src.documentKey, {
      documentKey: src.documentKey,
      title: src.title,
      version,
      effectiveDate,
      contentHash,
      sourcePath: src.filePath,
      byteSize: Buffer.byteLength(content, 'utf8'),
    });
  }
  return {
    entries: () => Array.from(entries.values()),
    get: (documentKey: string) => entries.get(documentKey),
  };
}

/**
 * Build a catalog directly from in-memory document strings. Used by
 * tests so they don't need to read from disk.
 */
export function buildLegalCatalogFromContent(
  documents: Array<{ documentKey: string; title: string; content: string; sourcePath: string }>,
): LegalDocumentCatalog {
  const entries = new Map<string, LegalDocumentEntry>();
  for (const doc of documents) {
    const { version, effectiveDate } = parseLegalHeader(doc.content, doc.documentKey);
    const contentHash = createHash('sha256').update(doc.content).digest('hex');
    entries.set(doc.documentKey, {
      documentKey: doc.documentKey,
      title: doc.title,
      version,
      effectiveDate,
      contentHash,
      sourcePath: doc.sourcePath,
      byteSize: Buffer.byteLength(doc.content, 'utf8'),
    });
  }
  return {
    entries: () => Array.from(entries.values()),
    get: (documentKey: string) => entries.get(documentKey),
  };
}

const HEADER_RE = /\*\*Version:\*\*\s*(\S+)\s*·\s*\*\*Effective:\*\*\s*(\d{4}-\d{2}-\d{2})/;

function parseLegalHeader(
  content: string,
  documentKey: string,
): { version: string; effectiveDate: string } {
  const match = HEADER_RE.exec(content);
  if (match === null) {
    throw new Error(
      `Legal document ${documentKey} is missing the standard "**Version:** … · **Effective:** YYYY-MM-DD" header line.`,
    );
  }
  const version = match[1];
  const effectiveDate = match[2];
  if (version === undefined || effectiveDate === undefined) {
    throw new Error(`Legal document ${documentKey} header parse mismatch.`);
  }
  return { version, effectiveDate };
}
