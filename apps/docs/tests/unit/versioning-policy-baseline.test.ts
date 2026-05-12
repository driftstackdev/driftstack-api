// W326.A — drift guard for /api/versioning policy. Pins the
// customer-facing contract for what counts as additive vs breaking,
// and the deprecation cycle (Deprecation+Sunset headers, 90-day
// minimum, email notice). Important: customers may quote this in
// their own change-management procedures.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/docs/src/pages/api/versioning.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W326.A /api/versioning policy baseline', () => {
  const body = read(PAGE);

  it('cites /openapi.json as the single source of truth', () => {
    expect(body).toContain('/openapi.json');
  });

  it('declares /v1/* as the active major today', () => {
    expect(body).toMatch(/`\/v1\/\*` today/);
  });

  it('frames new optional request field with default as additive', () => {
    expect(body).toMatch(/New optional request field with sensible default[\s\S]{0,40}Additive/i);
  });

  it('frames renaming/removing a field as breaking', () => {
    expect(body).toMatch(/Renaming an existing field[\s\S]{0,80}Breaking/i);
    expect(body).toMatch(/Removing an existing field[\s\S]{0,80}Breaking/i);
  });

  it('promises Deprecation + Sunset headers (RFC 8594)', () => {
    expect(body).toMatch(/`Deprecation`\s+HTTP response\s+header/);
    expect(body).toMatch(/`Sunset`\s+header/);
    expect(body).toMatch(/RFC\s*8594/);
  });

  it('commits to a 90-day minimum deprecation window', () => {
    expect(body).toMatch(/Minimum\s+90\s+days/);
  });

  it('separates API versioning from SDK versioning + cross-links', () => {
    expect(body).toContain('/sdk/versioning');
  });
});
