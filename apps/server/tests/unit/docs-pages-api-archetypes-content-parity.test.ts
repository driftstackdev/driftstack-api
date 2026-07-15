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

  it('generates direct create payloads from catalog capabilities without synthesizing ids', () => {
    expect(page).toContain('## Generate a create payload from the live catalog');
    expect(page).toContain('async function archetypeCreatePayload(filter: ArchetypeFilter = {})');
    expect(page).toContain("await fetch('https://api.driftstack.dev/v1/archetypes')");
    expect(page).toContain('return { archetype: match.id };');
    expect(page).toContain(
      "throw new Error('No currently selectable archetype matches those capabilities.');",
    );
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
