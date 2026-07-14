import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const page = readFileSync(
  resolve(REPO_ROOT, 'apps/marketing-site/src/pages/trust/compliance.astro'),
  'utf8',
);

describe('/trust/compliance honesty baseline', () => {
  it('does not claim an unavailable pen-test report, certification, or PGP key', () => {
    expect(page).not.toMatch(
      /Executive summary \(PDF\)|Full report \(NDA-gated\)|downloadable below/,
    );
    expect(page).not.toMatch(/public PGP key|fingerprint.*published/);
    expect(page).not.toMatch(/SOC 2 Type I|SOC 2 Type II|Independent pen-test/);
  });
});
