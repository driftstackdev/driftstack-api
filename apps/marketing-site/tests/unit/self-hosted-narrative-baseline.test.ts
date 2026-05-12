// W305.C — drift guard for /self-hosted page positioning. The
// page must describe the two-box architecture (control plane +
// customer-owned hardware), reference Mac hardware as the runtime,
// and tie each SKU to a concrete hardware configuration.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SELF_HOSTED_SKUS } from '../../src/data/pricing';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/self-hosted.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W305.C /self-hosted narrative baseline', () => {
  const body = read(PAGE);

  it('describes the two-box architecture (control plane + customer hardware)', () => {
    expect(body).toMatch(/control plane/i);
    expect(body).toMatch(/hardware/i);
  });

  it('references Mac hardware as the session runtime', () => {
    expect(body).toMatch(/Mac (?:Mini|Studio|Pro)/i);
  });

  it('renders SKUs sourced from SELF_HOSTED_SKUS data module', () => {
    expect(body).toMatch(
      /import\s*\{[\s\S]*?\bSELF_HOSTED_SKUS\b[\s\S]*?\}\s+from\s+['"][^'"]*data\/pricing/,
    );
    // Sanity-check that SELF_HOSTED_SKUS has entries the page can render.
    expect(SELF_HOSTED_SKUS.length).toBeGreaterThanOrEqual(3);
  });

  it('does not claim Windows / Linux as supported self-hosted runtimes', () => {
    // The platform is WebKit-on-macOS-only for v1.
    expect(body).not.toMatch(/Windows\s+(?:server|host|runtime|supported)/i);
    expect(body).not.toMatch(/Linux\s+(?:runtime|host|supported)/i);
  });
});
