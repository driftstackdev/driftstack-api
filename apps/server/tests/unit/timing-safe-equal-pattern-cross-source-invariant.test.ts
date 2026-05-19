// Cross-source invariant: every signature / token / secret comparison
// uses node:crypto's timingSafeEqual (constant-time) — NEVER === or
// .equals(). Drift to a non-constant-time compare anywhere in this
// list invites timing-attack-style information leak.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

const FILES = [
  {
    file: 'apps/server/src/lib/oauth-client-state.ts',
    purpose: 'OAuth-client state JWT signature',
  },
  { file: 'apps/server/src/lib/nowpayments-signing.ts', purpose: 'NowPayments IPN HMAC-SHA512' },
  { file: 'apps/server/src/lib/api-keys.ts', purpose: 'API key hash compare' },
  { file: 'apps/server/src/lib/oauth-pkce.ts', purpose: 'PKCE S256 challenge compare' },
];

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('timing-safe-equal pattern cross-source invariant', () => {
  it.each(FILES)('$file imports timingSafeEqual from node:crypto for $purpose', ({ file }) => {
    const src = read(resolve(REPO_ROOT, file));
    expect(src).toMatch(/from 'node:crypto'/);
    expect(src).toMatch(/timingSafeEqual/);
  });

  it.each(FILES)('$file actually CALLS timingSafeEqual (not just imports it)', ({ file }) => {
    const src = read(resolve(REPO_ROOT, file));
    // Either `timingSafeEqual(a, b)` call or `!timingSafeEqual(...)` negation
    expect(src).toMatch(/timingSafeEqual\([^)]+\)/);
  });

  it("lib/oauth-pkce documents the constant-time rationale: 'Constant-time comparison via timingSafeEqual avoids leaking the' — pinned so the timing-attack-rationale stays documented", () => {
    const src = read(resolve(REPO_ROOT, 'apps/server/src/lib/oauth-pkce.ts'));
    expect(src).toMatch(/\/\/ Constant-time comparison via timingSafeEqual avoids leaking the/);
  });

  it("lib/nowpayments-signing documents 'Constant-time comparison via {@link timingSafeEqual}' — pinned so the doc-comment cross-reference stays anchored", () => {
    const src = read(resolve(REPO_ROOT, 'apps/server/src/lib/nowpayments-signing.ts'));
    expect(src).toMatch(/Constant-time comparison via \{@link timingSafeEqual\}/);
  });

  it('routes/auth-oauth-client cookie-verifier compare also uses timingSafeEqual — pinned so the cookie-tamper check is constant-time too', () => {
    const src = read(resolve(REPO_ROOT, 'apps/server/src/routes/auth-oauth-client.ts'));
    expect(src).toMatch(/import \{[^}]*timingSafeEqual[^}]*\} from 'node:crypto';/);
    expect(src).toMatch(/if \(!timingSafeEqual\(received, expected\)\) return null;/);
  });
});
