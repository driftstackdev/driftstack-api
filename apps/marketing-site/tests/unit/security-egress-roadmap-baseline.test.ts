// W332.B — drift guard for /security egress framing. As of 2026-05-22,
// customer-configurable egress (SOCKS5 / OpenVPN / WireGuard, priority
// order per founder verdict 2026-05-16) IS SHIPPED per planning 133
// Phase 1 + the SocksProxyBackend impl wired in bootstrap. The page
// now describes the per-profile capability instead of the roadmap.
// This file was previously "roadmap framing" — it now guards against
// drift back to roadmap-style honesty hedging that would obscure the
// shipped feature.

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

describe('W332.B /security egress framing (shipped)', () => {
  const body = read(PAGE);

  it('section header reads plain "Egress" (no "(roadmap)" hedge)', () => {
    expect(body).toMatch(/02 · Egress/);
    expect(body).not.toMatch(/02 · Egress \(roadmap\)/);
  });

  it('lists supported egress modalities (SOCKS5 / OpenVPN / WireGuard)', () => {
    // Order matches the 2026-05-16 founder verdict.
    expect(body).toMatch(/SOCKS5/);
    expect(body).toMatch(/OpenVPN/);
    expect(body).toMatch(/WireGuard/);
  });

  it('describes egress as a per-profile capability (shipped)', () => {
    expect(body).toMatch(/Each profile can attach its own egress/);
  });
});
