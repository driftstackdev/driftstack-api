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

describe('/roadmap legacy URL current-state content', () => {
  it('routes readers to released changes and the supported API contract', () => {
    expect(body).toContain('title="Product updates"');
    expect(body).toContain('href="/changelog/"');
    expect(body).toContain('href="https://docs.driftstack.dev/api/"');
  });

  it('contains no forward-looking feature inventory', () => {
    expect(body).not.toMatch(/RoadmapItem|const (?:NOW|NEXT|LATER)|forward-looking|lands next/i);
  });
});
