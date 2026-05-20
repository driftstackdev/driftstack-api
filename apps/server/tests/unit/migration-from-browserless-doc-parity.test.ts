// W228.A — drift-guard for /docs/migration-from-browserless. The
// previous revision invented a richer Driftstack surface than the
// one that exists — script-passthrough sessions, waitUntilTerminal,
// getResult, recordings-by-default. This guard pins it to reality.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CreateSessionRequestSchema, CreateProfileRequestSchema } from '@driftstack/api-types';

const REPO = join(__dirname, '..', '..', '..', '..');
const DOC_PATH = join(
  REPO,
  'apps',
  'marketing-site',
  'src',
  'pages',
  'docs',
  'migration-from-browserless.astro',
);

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('W228.A migration-from-browserless doc parity', () => {
  const full = read(DOC_PATH);
  // Strip the Astro frontmatter (the leading `---…---` block) so doc
  // comments that mention the removed-fictional methods don't trip
  // the regex.
  const doc = full.replace(/^---[\s\S]*?---/, '');

  it('does not reference fictional SDK methods', () => {
    expect(doc).not.toMatch(/client\.sessions\.start\(/);
    expect(doc).not.toMatch(/waitUntilTerminal/);
    expect(doc).not.toMatch(/getResult\(/);
    // recordings.get() — fictional today
    expect(doc).not.toMatch(/recordings\.get\(/);
  });

  it("does not claim session create accepts the fictional script/target_url fields (profile_id IS now schema-accepted per fa8cb83a but stays out of the browserless migration narrative — audience hasn't created profiles yet)", () => {
    const shape = CreateSessionRequestSchema.shape;
    expect(shape).not.toHaveProperty('script');
    expect(shape).not.toHaveProperty('target_url');
    // 2026-05-20 — profile_id IS now schema-accepted; the doc still
    // omits it because the migration audience starts ephemeral. The
    // doc body itself shouldn't mention profile_id, but the schema
    // check no longer asserts absence.
    expect(shape).toHaveProperty('profile_id');
    expect(doc).not.toMatch(/target_url:\s*'/);
    expect(doc).not.toMatch(/script:\s*`/);
    expect(doc).not.toMatch(/profile_id:/);
  });

  it('profile create uses real schema fields', () => {
    const shape = CreateProfileRequestSchema.shape;
    expect(shape).toHaveProperty('name');
    expect(doc).toMatch(/name:\s*'evergreen-scraper'/);
    // The previous draft passed a fictional `label:` field.
    expect(doc).not.toMatch(/label:\s*'evergreen-scraper'/);
  });

  it('recordings are flagged as roadmap, not as a live differentiator', () => {
    expect(doc).toMatch(/roadmap/i);
    // Old wording: "Every Driftstack session can record … by default".
    expect(doc).not.toMatch(/record full-fidelity WebM by default/i);
  });
});
