// Cross-source invariant: every signature / token / secret comparison
// uses node:crypto's timingSafeEqual (constant-time) — NEVER === or
// .equals(). Drift to a non-constant-time compare invites a
// timing-attack-style information leak.
//
// The annotated list below was the whole guard, and it named FIVE files. The
// server actually performs constant-time comparison in FOURTEEN. The other nine —
// the API-key hash compare, the GUI control key, internal fleet auth, TOTP, the
// profile key hierarchy, Stripe signing, the OAuth store, CLI authorize — were
// doing the right thing with nothing checking they kept doing it. A hardcoded
// list is a statement about the moment it was written; the set of files that
// compare secrets is derived here instead, so a new one has to be acknowledged
// rather than silently landing outside the guard.
//
// Both directions matter. A file that STOPS calling timingSafeEqual has either
// dropped a security property or moved the comparison elsewhere, and either way
// the annotation naming its purpose is now wrong.

import { readFileSync, readdirSync, statSync } from 'node:fs';
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
  {
    file: 'apps/server/src/routes/metrics.ts',
    purpose: 'Prometheus /metrics scrape-token bearer',
  },
];

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const SERVER_SRC = resolve(REPO_ROOT, 'apps', 'server', 'src');

/** Every server source file that performs a constant-time comparison. */
function filesCallingTimingSafeEqual(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = resolve(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.endsWith('.ts')) continue;
      if (/timingSafeEqual\s*\(/.test(readFileSync(full, 'utf8'))) {
        out.push(`apps/server/src/${full.slice(SERVER_SRC.length + 1)}`);
      }
    }
  };
  walk(SERVER_SRC);
  return out.sort();
}

/**
 * Purpose annotations for every file that compares in constant time.
 *
 * MEASURED at 14. `routes/agent-sessions.ts` is deliberately absent: it
 * DOCUMENTS the property — "Equal-length-buffer + timingSafeEqual avoids a
 * length/early-return side channel" — but delegates the comparison to
 * `lib/agent-session-control-key.ts`, which is listed. Mentioning the function
 * and calling it are different things, and this guard keys on the call.
 *
 * This is documentation with teeth: a file that starts
 * comparing secrets must be named here, and one that stops is reported so the
 * annotation cannot outlive the code it describes.
 */
const PURPOSES: Record<string, string> = {
  'apps/server/src/db/oauth-store.ts': 'OAuth authorization-code + token hash compare',
  'apps/server/src/lib/agent-session-control-key.ts': 'GUI control-key bearer compare',
  'apps/server/src/lib/api-keys.ts': 'API key hash compare',
  'apps/server/src/lib/internal-fleet-auth.ts': 'internal fleet-node token compare',
  'apps/server/src/lib/mfa-totp.ts': 'TOTP code + recovery-code compare',
  'apps/server/src/lib/nowpayments-signing.ts': 'NowPayments IPN HMAC-SHA512',
  'apps/server/src/lib/oauth-client-state.ts': 'OAuth-client state JWT signature',
  'apps/server/src/lib/oauth-pkce.ts': 'PKCE S256 challenge compare',
  'apps/server/src/lib/profile-key-hierarchy.ts': 'profile key-hierarchy digest compare',
  'apps/server/src/lib/stripe-signing.ts': 'Stripe webhook signature',
  'apps/server/src/routes/auth-oauth-client.ts': 'OAuth cookie-verifier compare',
  'apps/server/src/routes/metrics.ts': 'Prometheus /metrics scrape-token bearer',
  'apps/server/src/services/cli-authorize.ts': 'CLI authorize exchange-code compare',
  'apps/server/src/services/oauth.ts': 'OAuth client-secret compare',
};

describe('timing-safe-equal pattern cross-source invariant', () => {
  it('CRITICAL every file that compares in constant time is annotated, and every annotation still describes a file that does. The list this guard started with named five of fifteen — the other ten were correct and unguarded, which is indistinguishable from correct and guarded right up until one of them changes.', () => {
    const actual = filesCallingTimingSafeEqual();

    // MEASURED: 15. Floored because an empty scan agrees with an empty
    // annotation map and would report the whole invariant satisfied.
    expect(actual.length, 'server files calling timingSafeEqual').toBeGreaterThanOrEqual(14);

    const unannotated = actual.filter((f) => PURPOSES[f] === undefined);
    expect(unannotated, 'file(s) comparing secrets with no purpose annotation:').toEqual([]);

    const stale = Object.keys(PURPOSES)
      .filter((f) => !actual.includes(f))
      .sort();
    expect(stale, 'annotated file(s) that no longer call timingSafeEqual:').toEqual([]);
  });

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
