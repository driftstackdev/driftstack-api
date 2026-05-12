// W332.B — drift guard for /security egress framing. The page
// names customer-configurable egress (SOCKS5 / WireGuard / OpenVPN)
// as ON ROADMAP, not live today. Catches drift if the framing
// silently flips to "shipped" before it actually does, or if the
// claim disappears entirely.

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

describe('W332.B /security egress roadmap framing', () => {
  const body = read(PAGE);

  it('section header marks egress as "(roadmap)"', () => {
    expect(body).toMatch(/Egress \(roadmap\)/);
  });

  it('lists supported egress modalities (SOCKS5 / WireGuard / OpenVPN)', () => {
    expect(body).toMatch(/SOCKS5/);
    expect(body).toMatch(/WireGuard/);
    expect(body).toMatch(/OpenVPN/);
  });

  it('frames egress as "on the roadmap" (forward-looking, not live)', () => {
    expect(body).toMatch(/Customer-configurable egress[\s\S]{0,80}on the roadmap/i);
  });

  it('does NOT claim egress is shipped today', () => {
    expect(body).not.toMatch(
      /Customer-configurable egress[^.]{0,80}(?:available today|shipped|live now|in production)/i,
    );
  });
});
