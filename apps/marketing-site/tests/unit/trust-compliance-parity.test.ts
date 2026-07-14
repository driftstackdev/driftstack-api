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

describe('/trust/compliance current posture', () => {
  it('lists GDPR Article 28 with DPA evidence', () => {
    expect(page).toContain('GDPR Article 28');
    expect(page).toContain('>In place</span');
    expect(page).toContain('href="/legal/dpa/"');
  });

  it('states the current SOC 2 and ISO 27001 status without a delivery promise', () => {
    expect(page).toContain('not currently SOC 2 or ISO 27001 certified');
    expect(page).not.toMatch(/In progress|Scheduled|Q[1-4] 20\d\d|Planned/);
  });
});
