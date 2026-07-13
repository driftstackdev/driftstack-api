import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

describe('marketing autonomous probe indexing boundary', () => {
  for (const filename of ['scroll-probe.html', 'sim-probe.html']) {
    it(`${filename} is machine-only and must not enter search indexes`, () => {
      const body = readFileSync(resolve(REPO_ROOT, 'apps/marketing-site/public', filename), 'utf8');
      expect(body.match(/<meta name="robots" content="noindex,\s*nofollow" \/>/g)).toHaveLength(1);
    });
  }
});
