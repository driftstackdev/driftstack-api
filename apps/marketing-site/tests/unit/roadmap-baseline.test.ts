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

describe('legacy product-updates route baseline', () => {
  it('uses the canonical layout and current-state hero', () => {
    expect(body).toContain("import BaseLayout from '../layouts/BaseLayout.astro'");
    expect(body).toContain('label="Product updates"');
    expect(body).toContain('title="What is available today."');
  });
});
