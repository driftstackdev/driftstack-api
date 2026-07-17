import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/docs/src/pages/api/archetypes.md');

describe('docs /api/archetypes live-contract parity', () => {
  const page = readFileSync(PAGE, 'utf8');

  it('exists and documents the cacheable public selectable catalog', () => {
    expect(existsSync(PAGE)).toBe(true);
    expect(page).toMatch(
      /^---\nlayout: \.\.\/\.\.\/layouts\/DocLayout\.astro\ntitle: Archetypes\n/,
    );
    expect(page).toContain('`GET /v1/archetypes`');
    expect(page).toContain('`Cache-Control: public, max-age=300`');
    expect(page).toContain('Only customer-selectable entries are returned:');
  });

  it('generates direct create payloads only from one exact live-catalog match', () => {
    expect(page).toContain('## Generate a create payload from the live catalog');
    expect(page).toContain('async function archetypeCreatePayload(filter: ArchetypeFilter = {})');
    expect(page).toContain('if (requested.length === 0) return {};');
    expect(page).toContain("await fetch('https://api.driftstack.dev/v1/archetypes')");
    expect(page).toContain('const matches = catalog.data.filter(');
    expect(page).toContain('return { archetype: matches[0]!.id };');
    expect(page).toContain(
      "throw new Error('No currently selectable archetype matches those capabilities.');",
    );
    expect(page).toContain(
      "'More than one archetype matches. Add another capability or use an exact catalog id.',",
    );
    expect(page).toMatch(
      /device: 'iPhone 17',[\s\S]*ios_version: '18\.7',[\s\S]*safari_version: '26\.4'/,
    );
    expect(page).not.toContain('catalog.data.find(');
  });

  it('does not promise archetype accessors in registry packages that predate the resource', () => {
    expect(page).not.toMatch(/client\.archetypes\.list|client\.Archetypes\.List/);
    expect(page).toContain('The route and its inline response schema are also published');
  });

  it('pins direct-write rejection and stored-profile compatibility', () => {
    expect(page).toMatch(
      /Any other id returns\s*\n?`400 ValidationFailed` on the `archetype` field before a browser, profile row,\s*\n?or driver allocation is attempted\./,
    );
    expect(page).not.toMatch(/\bplanned\b|reference-only/i);
    expect(page).toMatch(
      /Existing stored profiles keep their pinned archetype\s*\n?even if it later leaves the selectable catalog/,
    );
  });
});
