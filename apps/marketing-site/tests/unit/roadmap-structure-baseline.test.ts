import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const body = readFileSync(
  resolve(REPO_ROOT, 'apps/marketing-site/src/pages/roadmap.astro'),
  'utf8',
);

describe('product-updates route structure', () => {
  it('has two direct calls to current product evidence', () => {
    expect(body).toContain('class="btn-primary">Read the changelog</a>');
    expect(body).toContain('class="btn-secondary">Browse the API</a>');
  });
});
