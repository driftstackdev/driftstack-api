// W332.B — drift guard for /security egress framing. The page
// names customer-configurable egress (SOCKS5 / OpenVPN / WireGuard,
// priority order per founder verdict 2026-05-16) as ON ROADMAP,
// not live today. Catches drift if the framing silently flips to
// "shipped" before it actually does, or if the claim disappears
// entirely.

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

  it('lists supported egress modalities in priority order (SOCKS5 / OpenVPN / WireGuard)', () => {
    // Order matches the 2026-05-16 founder verdict: SOCKS5 (Phase 1
    // live target) → OpenVPN (Phase 2 priority) → WireGuard (Phase 3
    // deferred). Pinning the order keeps marketing copy in sync with
    // the API server's user-facing 503 messages (see
    // apps/server/src/routes/session-proxy.ts which uses the same order).
    expect(body).toMatch(/SOCKS5\s*\/\s*OpenVPN\s*\/\s*WireGuard/);
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
