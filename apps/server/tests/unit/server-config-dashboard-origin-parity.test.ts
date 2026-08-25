// W715 — server-side config + DASHBOARD_ORIGIN single-source-of-
// truth parity. Forty-second in the cross-SDK drift-guard series
// (W649 + W675-W715).
//
// Pins apps/server/src/lib/config.ts as the AUTHORITATIVE source of
// the V-079.B/V-079.C DASHBOARD_ORIGIN-derived auth-flow URLs +
// V-266 dashboard origin for CLI-authorize browser_url + the
// production-boot guards that REFUSE to boot if the configuration
// is misset.
//
// CRITICAL invariants:
//   1. DASHBOARD_ORIGIN trailing-slash strip in the Zod schema
//      (W190) — consumers can safely template `${dashboardOrigin}/
//      billing` without double-slash bugs.
//   2. Production boot guard 1: any auth-flow URL containing
//      `localhost` is REJECTED (drift to allowing would let real
//      customers receive emails with broken links — the 2026-05-12
//      incident).
//   3. Production boot guard 2: DASHBOARD_ORIGIN undefined OR empty
//      is REJECTED (drift to allowing would let the zod default
//      `http://localhost:5173` land in production).
//   4. Resolution order for auth-flow URLs: per-URL env var →
//      DASHBOARD_ORIGIN + conventional path → dev-friendly localhost
//      fallback.
//   5. V-079.C paths match the customer-dashboard file-based routes
//      (/verify-email + /auth/magic-link + /reset-password — NOT the
//      previous /auth/<flow> paths that 404'd).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const SERVER_CONFIG = resolve(REPO_ROOT, 'apps/server/src/lib/config.ts');

describe('W715 server-side config DASHBOARD_ORIGIN parity', () => {
  it('config.ts file exists', () => {
    expect(existsSync(SERVER_CONFIG), `missing ${SERVER_CONFIG}`).toBe(true);
  });

  it("CRITICAL V-266 dashboardOrigin Zod schema pinned with trailing-slash strip transform. W190 strip is the single normalisation point — drift to dropping `.transform(s => s.replace(/\\/+$/, ''))` would force every call site to re-strip.", () => {
    const src = read(SERVER_CONFIG);

    // Schema definition with .url() + .default() + .transform() chain.
    expect(src).toMatch(
      /dashboardOrigin: z\s*\.string\(\)\s*\.url\(\)\s*\.default\('http:\/\/localhost:5173'\)\s*\.transform\(\(s\) => s\.replace\(\/\\\/\+\$\/, ''\)\)/,
    );

    // W190 anchor.
    expect(src).toMatch(/W190 — strip any trailing slash/);
    expect(src).toMatch(
      /so consumers can safely do\s*\/\/\s*`\$\{dashboardOrigin\}\/billing` etc\. without producing `https:\/\/…\/\/billing`/,
    );
  });

  it('CRITICAL V-079.B framing pinned — "derive the three auth-flow URLs from a single DASHBOARD_ORIGIN env var when the per-URL overrides aren\'t set". The single-source-of-truth approach is what prevents the 2026-05-12 broken-link incident.', () => {
    const src = read(SERVER_CONFIG);

    expect(src).toMatch(
      /V-079\.B — derive the three auth-flow URLs from a single\s*\*\s*`DASHBOARD_ORIGIN` env var/,
    );
    expect(src).toMatch(/Real customers received emails with broken links/);
  });

  it('CRITICAL 3-step resolution order pinned in deriveAuthFlowUrls. Drift to changing the order would silently mis-route in dev (or worse, mis-route in prod via the localhost fallback).', () => {
    const src = read(SERVER_CONFIG);

    expect(src).toMatch(
      /Resolution order for each URL:\s*\*\s*1\. explicit per-URL env var \(AUTH_VERIFY_EMAIL_URL etc\.\)/,
    );
    expect(src).toMatch(/2\. DASHBOARD_ORIGIN \+ the conventional path/);
    expect(src).toMatch(/3\. dev-friendly localhost default \(final fallback, dev-only\)/);
  });

  it('CRITICAL V-079.C path roster pinned — /verify-email + /auth/magic-link + /reset-password. The 3 paths match the customer-dashboard file-based routes; drift to /auth/<flow> would land on 404s (the 2026-05-12 customer incident).', () => {
    const src = read(SERVER_CONFIG);

    expect(src).toMatch(/V-079\.C — paths match the customer-dashboard's actual file-based/);
    expect(src).toMatch(/`\/verify-email`,\s*`\/reset-password`/);
    expect(src).toMatch(
      /verifyEmail: env\.AUTH_VERIFY_EMAIL_URL \?\? fromOrigin\('\/verify-email'\)/,
    );
    expect(src).toMatch(
      /magicLink: env\.AUTH_MAGIC_LINK_URL \?\? fromOrigin\('\/auth\/magic-link'\)/,
    );
    expect(src).toMatch(
      /passwordReset: env\.AUTH_PASSWORD_RESET_URL \?\? fromOrigin\('\/reset-password'\)/,
    );
  });

  it('CRITICAL production boot guard 1 — REFUSE to boot when any auth-flow URL resolves to a localhost host. Drift to allowing would let production customers receive emails with localhost links (broken).', () => {
    const src = read(SERVER_CONFIG);

    expect(src).toMatch(/if \(env\.NODE_ENV === 'production'\)/);
    expect(src).toMatch(/\/\\blocalhost\\b\/\.test\(value\)/);
    expect(src).toMatch(
      /throw new Error\(\s*`Refusing to boot: \$\{name\} resolves to a localhost URL/,
    );
    expect(src).toMatch(
      /Set DASHBOARD_ORIGIN \(or the per-URL env var\) to the customer-facing dashboard origin/,
    );
  });

  it('CRITICAL production boot guard 2 — REFUSE to boot when DASHBOARD_ORIGIN is undefined or empty in production. Drift to allowing would let the zod default `http://localhost:5173` land in production via the fallback chain.', () => {
    const src = read(SERVER_CONFIG);

    expect(src).toMatch(
      /if \(env\.DASHBOARD_ORIGIN === undefined \|\| env\.DASHBOARD_ORIGIN\.length === 0\) \{\s*throw new Error\(\s*'Refusing to boot: DASHBOARD_ORIGIN must be set in production/,
    );
    expect(src).toMatch(/drives auth-flow URLs \+ CLI-authorize browser URL/);
  });

  it('CRITICAL 4 production-checked env vars pinned — DASHBOARD_ORIGIN, AUTH_VERIFY_EMAIL_URL, AUTH_MAGIC_LINK_URL, AUTH_PASSWORD_RESET_URL. The 4-entry loop is what guarantees every customer-facing email URL is localhost-free in production. Drift to dropping any would let one URL slip through.', () => {
    const src = read(SERVER_CONFIG);

    expect(src).toMatch(/DASHBOARD_ORIGIN: env\.DASHBOARD_ORIGIN,/);
    expect(src).toMatch(/AUTH_VERIFY_EMAIL_URL: resolved\.verifyEmail,/);
    expect(src).toMatch(/AUTH_MAGIC_LINK_URL: resolved\.magicLink,/);
    expect(src).toMatch(/AUTH_PASSWORD_RESET_URL: resolved\.passwordReset,/);
  });

  it("CRITICAL fromOrigin helper does its own trailing-slash strip on DASHBOARD_ORIGIN — `env.DASHBOARD_ORIGIN?.replace(/\\/+$/, '')`. This handles raw env-var input (Zod schema only applies to parsed Config, not raw process.env). Drift to dropping would let `DASHBOARD_ORIGIN=https://app.…/` produce `https://app.…//verify-email`.", () => {
    const src = read(SERVER_CONFIG);

    expect(src).toMatch(/const origin = env\.DASHBOARD_ORIGIN\?\.replace\(\/\\\/\+\$\/, ''\);/);
    expect(src).toMatch(
      /const fromOrigin = \(path: string\): string \| undefined =>\s*origin !== undefined && origin\.length > 0 \? `\$\{origin\}\$\{path\}` : undefined;/,
    );
  });

  it('CRITICAL 2026-05-12 customer incident provenance pinned in V-079.C comment. The dated incident note is what tells engineers the bug-fix is load-bearing (real customer impacted by /auth/<flow> 404). Drift to removing would lose the institutional memory.', () => {
    const src = read(SERVER_CONFIG);
    expect(src).toMatch(/Postmark approval landed \(2026-05-12\)/);
  });

  it('CRITICAL V-266 anchor on dashboardOrigin Zod-schema doc-comment pinned. V-266 is the CLI-activation feature (W686/W703); the doc-comment threads "browser_url returned by /v1/auth/cli-authorize/initiate" so engineers know the field drives CLI deep-link routing.', () => {
    const src = read(SERVER_CONFIG);

    expect(src).toMatch(/V-266 — origin of the customer dashboard/);
    expect(src).toMatch(
      /Used to build the\s*\*\s*browser_url returned by \/v1\/auth\/cli-authorize\/initiate/,
    );
    expect(src).toMatch(/dev \/ staging \/ prod/);
  });

  it('CRITICAL `dashboardOrigin: env.DASHBOARD_ORIGIN` propagation pinned in the final Config builder. The pass-through is what makes the parsed Config object accessible via `cfg.dashboardOrigin`. Drift to dropping would force every consumer to read raw process.env.', () => {
    const src = read(SERVER_CONFIG);
    expect(src).toMatch(/dashboardOrigin: env\.DASHBOARD_ORIGIN,/);
  });

  it('CRITICAL ConfigSchema exports — z.infer<typeof ConfigSchema> as Config type. The Config type is what gives the whole server type-safe access to config fields. Drift to manually maintaining a type would break the single-source-of-truth.', () => {
    const src = read(SERVER_CONFIG);
    expect(src).toMatch(/export type Config = z\.infer<typeof ConfigSchema>;/);
  });

  it('Server config 5-invariant cluster — Zod trailing-slash strip + V-079.B framing + 3-step resolution order + production-localhost-reject + DASHBOARD_ORIGIN-required-in-prod + 4-env-var-loop. Drift on any would fragment the dashboard-origin single-source-of-truth.', () => {
    const src = read(SERVER_CONFIG);

    expect(src).toMatch(/W190 — strip any trailing slash/);
    expect(src).toMatch(/V-079\.B/);
    expect(src).toMatch(/Resolution order for each URL:/);
    expect(src).toMatch(/Refusing to boot: DASHBOARD_ORIGIN must be set in production/);
    expect(src).toMatch(/\/\\blocalhost\\b\/\.test\(value\)/);
    expect(src).toMatch(/AUTH_VERIFY_EMAIL_URL: resolved\.verifyEmail/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/server-config-dashboard-origin-parity.test.ts'),
      ),
    ).toBe(true);
  });
});
