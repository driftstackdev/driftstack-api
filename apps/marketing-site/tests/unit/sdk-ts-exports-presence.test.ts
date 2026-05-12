// W290.A — drift guard for TS SDK barrel exports. The README and
// docs cite specific named exports (`Driftstack`, `DriftstackError`,
// `verifyWebhookSignature`, `iteratePaginated`); ensure those each
// appear in packages/sdk-typescript/src/index.ts. Catches drift
// where a public symbol is moved/renamed without updating the
// barrel.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const INDEX = resolve(REPO_ROOT, 'packages/sdk-typescript/src/index.ts');
const README = resolve(REPO_ROOT, 'packages/sdk-typescript/README.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const REQUIRED_INDEX_EXPORTS = [
  'Driftstack',
  'DriftstackError',
  'verifyWebhookSignature',
  'iteratePaginated',
];
const REQUIRED_README_MENTIONS = ['Driftstack', 'DriftstackError', 'verifyWebhookSignature'];

describe('W290.A TS SDK barrel-export presence', () => {
  const index = read(INDEX);
  const readme = read(README);

  for (const name of REQUIRED_INDEX_EXPORTS) {
    it(`index.ts exports ${name}`, () => {
      // Match `export { ..., Name } from '...';` or `export { Name }`.
      const re = new RegExp(`export\\s+(type\\s+)?\\{[^}]*\\b${name}\\b[^}]*\\}`);
      expect(index).toMatch(re);
    });
  }

  for (const name of REQUIRED_README_MENTIONS) {
    it(`README mentions ${name}`, () => {
      // The README demonstrates these specific named imports — the
      // `iteratePaginated` helper is exported but drives behind
      // `client.<resource>.iterate(...)` in the README.
      expect(readme).toMatch(new RegExp(`\\b${name}\\b`));
    });
  }
});
