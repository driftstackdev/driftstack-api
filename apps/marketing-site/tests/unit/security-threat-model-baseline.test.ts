// W325.B — drift guard for /security threat-model section. The
// page declares both addressed threats (with mitigations) AND
// explicitly out-of-scope threats. Pinning this section makes
// the honesty posture load-bearing: an accidental copy refactor
// that drops the "out of scope" framing or the named adversaries
// will fail.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/security.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W325.B /security threat-model baseline', () => {
  const body = read(PAGE);

  it('section heading "Threat model" is present', () => {
    expect(body).toMatch(/>\s*Threat model\s*</);
  });

  it('section heading "Explicitly out of scope" is present', () => {
    expect(body).toMatch(/Explicitly out of scope/);
  });

  it('lists addressed threats with mitigations', () => {
    expect(body).toMatch(/API key compromise[\s\S]{0,80}Mitigation/);
    expect(body).toMatch(/Webhook signature forgery[\s\S]{0,80}Mitigation/);
    expect(body).toMatch(/Brute-force auth attempts[\s\S]{0,80}Mitigation/);
  });

  it('explicitly names nation-state-with-sub-processor-access as out of scope', () => {
    expect(body).toMatch(/Nation-state actors with sub-processor access/);
  });

  it("frames the customer's remote-target threat as out of scope", () => {
    // The doc must be clear that protecting the target site is the
    // customer's threat model, not Driftstack's.
    expect(body).toMatch(/your threat model, not ours/i);
  });
});
