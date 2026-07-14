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

describe('/trust/compliance operational commitments', () => {
  it('publishes the private vulnerability channel and bounded response cadence', () => {
    expect(page).toContain('mailto:security@driftstack.dev');
    expect(page).toContain('Acknowledge receipt within 2 business days');
    expect(page).toContain('initial severity assessment within 5 business days');
    expect(page).toContain('status updates at least every 14 days');
  });

  it('publishes safe harbour, sub-processor notice, and audit retention', () => {
    expect(page).toContain('Safe harbour');
    expect(page).toMatch(/30\s+calendar days' notice/);
    expect(page).toContain('Privileged admin-action records are retained internally for 365 days');
  });
});
