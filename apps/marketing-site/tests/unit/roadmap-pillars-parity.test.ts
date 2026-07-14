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

describe('product-updates source-of-truth links', () => {
  it('names the changelog and API documentation as the two current references', () => {
    expect(body).toContain('released customer-facing changes');
    expect(body).toContain('current HTTP contract');
  });
});
