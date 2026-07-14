// W294.A — drift guard for trust pages. The trust/sub-processors
// page must read from SUB_PROCESSORS in data/sub-processors.ts
// (not hard-code the table), and trust/compliance must reference
// the current certification posture without a delivery promise.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const TRUST_SUB = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/trust/sub-processors.astro');
const TRUST_COMPLIANCE = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/trust/compliance.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W294.A trust pages parity', () => {
  it('trust/sub-processors imports SUB_PROCESSORS from the canonical data module', () => {
    const body = read(TRUST_SUB);
    expect(body).toMatch(
      /import\s*\{[\s\S]*?\bSUB_PROCESSORS\b[\s\S]*?\}\s+from\s+['"][^'"]*data\/sub-processors/,
    );
  });

  it('trust/compliance states the current certification posture without a roadmap', () => {
    const body = read(TRUST_COMPLIANCE);
    expect(body).toContain('not currently SOC 2 or ISO 27001 certified');
    expect(body).not.toMatch(/in[- ]progress|planned|future|roadmap|Q[1-4] 20\d\d/i);
  });

  it('trust/sub-processors page cites the last-updated date from the data module', () => {
    const body = read(TRUST_SUB);
    expect(body).toMatch(/SUB_PROCESSOR_REGISTER_LAST_UPDATED/);
  });
});
