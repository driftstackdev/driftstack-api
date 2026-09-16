// W305.C — drift guard for /self-hosted page positioning. The
// page must describe the deployment model (the customer runs the
// Driftstack server on their own Macs — corrected 2026-09-15 from a
// Driftstack-hosted "coordination service" the code never had),
// reference Mac hardware as the runtime, and tie each SKU to a
// concrete hardware configuration.

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

  it("describes the deployment model: the Driftstack server runs on the customer's own Macs", () => {
    // 2026-09-15 owner directive: "control plane" is banned on customer
    // surfaces. Same day, refuter: the page had described a Driftstack-
    // hosted coordination service; apps/docs license-activation.md, Terms
    // §3 and the self-hosted runbook all have the customer running the
    // server, and no code reports to a hosted service.
    expect(body).toMatch(
      /The Driftstack server that starts and manages your sessions runs\s+on your Macs as well/,
    );
    expect(body).not.toMatch(/coordination service|Driftstack hosts the service/);
    expect(body).toMatch(/hardware you own/i);
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
