// Security drift-guard — security-sensitive randomness (auth tokens, API
// keys, OAuth codes, CSRF state, MFA/recovery codes, web-session tokens,
// webhook secrets, nonces) must use a CSPRNG, never `Math.random()`. The
// codebase already does: ~80 `randomBytes`/`randomUUID`/`randomInt`/
// `getRandomValues`/`generateAuthToken` sites. `Math.random()` is
// predictable (seedable PRNG) — using it for a secret/token/id makes the
// value guessable (auth bypass / session prediction).
//
// A 2026-06-01 audit found `Math.random()` in EXACTLY three runtime files
// under apps/server/src, all NON-security and intentional:
//   • services/webhook-worker.ts — retry backoff JITTER (predictable
//     jitter is harmless; it only spreads retry load).
//   • lib/livekit-token.ts — a FALLBACK for the JWT `jti` only when Web
//     Crypto is unavailable (dead code in Node 22 / browsers, where
//     crypto.getRandomValues is always present); and the `jti` is a
//     replay/uniqueness marker, NOT a secret — the LiveKit token's
//     security is its HMAC-SHA256 signature, so a predictable jti can't
//     forge a token.
//   • drivers/playwright.ts — a synthetic INTERNAL driver-session handle
//     (the API auth boundary is the account-scoped `ses_` DB id resolved
//     via requireOwned; this id is never a client-supplied auth token),
//     timestamp-salted so collisions are negligible.
//
// This pins that set: a `Math.random()` in any OTHER apps/server/src file
// fails CI and gets a security review ("is this generating a token / id /
// secret? if so use randomBytes/randomUUID"). To add a vetted non-security
// use, append its `src/...` path to ALLOWLIST with a one-line rationale.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const SERVER_SRC = resolve(REPO_ROOT, 'apps/server/src');

// Files where a NON-security Math.random() is vetted + intentional.
const ALLOWLIST = new Set<string>([
  'apps/server/src/services/webhook-worker.ts', // retry backoff jitter
  'apps/server/src/lib/livekit-token.ts', // jti CSPRNG-fallback (non-secret)
  'apps/server/src/drivers/playwright.ts', // internal driver-session handle
]);

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  if (!statSync(dir, { throwIfNoEntry: false })) return out;
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = resolve(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...listSourceFiles(full));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

function rel(p: string): string {
  return relative(REPO_ROOT, p).split('\\').join('/');
}

describe('security: no Math.random() for secrets/tokens/ids in server runtime', () => {
  const files = listSourceFiles(SERVER_SRC);

  it('CRITICAL Math.random() appears only in the vetted non-security allowlist — any other apps/server/src use must be reviewed (use a CSPRNG for tokens/ids/secrets)', () => {
    const offenders: string[] = [];
    for (const f of files) {
      if (/\bMath\.random\(\)/.test(read(f))) {
        const r = rel(f);
        if (!ALLOWLIST.has(r)) offenders.push(r);
      }
    }
    expect(
      offenders,
      `Math.random() in non-allowlisted server file(s):\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('non-vacuous: the scan reached server source AND the CSPRNG convention (randomBytes/randomUUID/getRandomValues) is in use', () => {
    expect(files.length).toBeGreaterThan(100);
    const usesCsprng = files.some((f) =>
      /\b(randomBytes|randomUUID|randomInt|getRandomValues)\b/.test(read(f)),
    );
    expect(usesCsprng, 'expected a CSPRNG call somewhere in server source').toBe(true);
  });

  it('allowlist entries still exist + still contain Math.random() (so the allowlist tracks reality, not a stale exemption)', () => {
    for (const a of ALLOWLIST) {
      const full = resolve(REPO_ROOT, a);
      expect(
        statSync(full, { throwIfNoEntry: false }),
        `allowlisted file missing: ${a}`,
      ).toBeTruthy();
      expect(
        /\bMath\.random\(\)/.test(read(full)),
        `allowlisted file no longer uses Math.random(): ${a}`,
      ).toBe(true);
    }
  });
});
