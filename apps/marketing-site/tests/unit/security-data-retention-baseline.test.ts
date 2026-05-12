// W333.B — drift guard for /security no-customer-data-access pillar.
// Pins the load-bearing privacy framing:
//   • "Driftstack staff cannot read your sessions" headline
//   • The control plane stores metadata only — no session content
//   • Specific exclusions: URLs / form data / screenshots / DOM /
//     cookies never reach our infra
//   • Self-hosted: even metadata stays inside the customer network

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

describe('W333.B /security no-customer-data-access pillar', () => {
  const body = read(PAGE);

  it('headline claims Driftstack staff cannot read sessions', () => {
    expect(body).toMatch(/Driftstack staff cannot read your sessions/i);
  });

  it('control plane explicitly stores metadata only (no session content)', () => {
    expect(body).toMatch(/[Cc]ontrol plane[\s\S]{0,80}metadata/);
    expect(body).toMatch(/does not store the session content/i);
  });

  it('names specific exclusions (URLs / form data / screenshots / DOM / cookies)', () => {
    expect(body).toMatch(/URLs visited/i);
    expect(body).toMatch(/form data/i);
    expect(body).toMatch(/screenshots/i);
    expect(body).toMatch(/DOM\s+snapshots/i);
    expect(body).toMatch(/browser cookies/i);
  });

  it('self-hosted: only license-validity heartbeats reach the control plane', () => {
    expect(body).toMatch(/license-validity heartbeats/i);
  });
});
