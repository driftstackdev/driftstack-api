// V-111: targeted unit tests for legal-catalog uncovered paths.
//
// V-086 audit had this file at 66.66% — the file-system path
// (buildLegalCatalog) and the parseLegalHeader error branches
// were untested. Tests against a temp-dir fixture cover the
// happy + error branches without changing the production path.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildLegalCatalog,
  buildLegalCatalogFromContent,
} from '../../src/services/legal-catalog.js';

const VALID_HEADER = '**Version:** 0.1.0-draft · **Effective:** 2026-05-03';
const VALID_DOC = (key: string): string => `# ${key}\n\n${VALID_HEADER}\n\nFull text here.\n`;

describe('buildLegalCatalog (file-system path)', () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'legal-catalog-test-'));
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('reads + parses a valid document', () => {
    const docDir = join(repoRoot, 'docs', 'legal');
    mkdirSync(docDir, { recursive: true });
    writeFileSync(join(docDir, 'tos.md'), VALID_DOC('tos'));

    const catalog = buildLegalCatalog({
      repoRoot,
      sources: [{ documentKey: 'tos', title: 'Terms of Service', filePath: 'docs/legal/tos.md' }],
    });

    const entries = catalog.entries();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.documentKey).toBe('tos');
    expect(entries[0]?.version).toBe('0.1.0-draft');
    expect(entries[0]?.effectiveDate).toBe('2026-05-03');
    expect(entries[0]?.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(entries[0]?.sourcePath).toBe('docs/legal/tos.md');
    expect(entries[0]?.byteSize).toBeGreaterThan(0);
  });

  it('throws on missing file', () => {
    expect(() =>
      buildLegalCatalog({
        repoRoot,
        sources: [
          {
            documentKey: 'tos',
            title: 'Terms of Service',
            filePath: 'docs/legal/missing.md',
          },
        ],
      }),
    ).toThrow();
  });

  it('throws on missing header line', () => {
    const docDir = join(repoRoot, 'docs', 'legal');
    mkdirSync(docDir, { recursive: true });
    writeFileSync(
      join(docDir, 'tos.md'),
      '# Terms of Service\n\nNo version line here, just text.\n',
    );

    expect(() =>
      buildLegalCatalog({
        repoRoot,
        sources: [{ documentKey: 'tos', title: 'Terms of Service', filePath: 'docs/legal/tos.md' }],
      }),
    ).toThrow(/missing the standard.*Version.*Effective.*header line/);
  });

  it('exposes get() for single-key lookup', () => {
    const docDir = join(repoRoot, 'docs', 'legal');
    mkdirSync(docDir, { recursive: true });
    writeFileSync(join(docDir, 'tos.md'), VALID_DOC('tos'));
    writeFileSync(join(docDir, 'privacy.md'), VALID_DOC('privacy'));

    const catalog = buildLegalCatalog({
      repoRoot,
      sources: [
        { documentKey: 'tos', title: 'Terms of Service', filePath: 'docs/legal/tos.md' },
        { documentKey: 'privacy', title: 'Privacy Policy', filePath: 'docs/legal/privacy.md' },
      ],
    });

    expect(catalog.get('tos')?.documentKey).toBe('tos');
    expect(catalog.get('privacy')?.documentKey).toBe('privacy');
    expect(catalog.get('nonexistent')).toBeUndefined();
  });

  it('uses DEFAULT_SOURCES when no sources arg provided', () => {
    // Create the four default doc files at the expected paths.
    const docDir = join(repoRoot, 'docs', 'legal');
    mkdirSync(docDir, { recursive: true });
    for (const filename of [
      'terms-of-service.md',
      'privacy-policy.md',
      'dpa.md',
      'acceptable-use-policy.md',
    ]) {
      writeFileSync(join(docDir, filename), VALID_DOC(filename));
    }

    const catalog = buildLegalCatalog({ repoRoot });
    const keys = catalog.entries().map((e) => e.documentKey);
    expect(keys.sort()).toEqual(['aup', 'dpa', 'privacy', 'tos']);
  });
});

describe('buildLegalCatalogFromContent (in-memory path)', () => {
  it('builds a catalog without disk reads', () => {
    const catalog = buildLegalCatalogFromContent([
      {
        documentKey: 'tos',
        title: 'Terms of Service',
        content: VALID_DOC('tos'),
        sourcePath: 'docs/legal/terms-of-service.md',
      },
    ]);
    const entries = catalog.entries();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.version).toBe('0.1.0-draft');
  });

  it('propagates header-parse errors from in-memory source', () => {
    expect(() =>
      buildLegalCatalogFromContent([
        {
          documentKey: 'tos',
          title: 'Terms of Service',
          content: 'No header here.',
          sourcePath: 'docs/legal/terms-of-service.md',
        },
      ]),
    ).toThrow(/missing the standard.*header line/);
  });

  it('hash differs across distinct content', () => {
    const a = buildLegalCatalogFromContent([
      {
        documentKey: 'tos',
        title: 'Terms of Service',
        content: VALID_DOC('tos') + 'A',
        sourcePath: 'docs/legal/terms-of-service.md',
      },
    ]);
    const b = buildLegalCatalogFromContent([
      {
        documentKey: 'tos',
        title: 'Terms of Service',
        content: VALID_DOC('tos') + 'B',
        sourcePath: 'docs/legal/terms-of-service.md',
      },
    ]);
    expect(a.entries()[0]?.contentHash).not.toBe(b.entries()[0]?.contentHash);
  });
});
