// Drift guard for apps/server/src/lib/effective-account-header.ts.
// Pins the V-326c shared X-Driftstack-Account team-RBAC header
// parser — 7-route consolidation + slice-105 BYOK-pattern empty-
// string normalisation.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/lib/effective-account-header.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('lib/effective-account-header content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });

  it("V-326c module-level framing pinned: 'shared parser for the X-Driftstack-Account team-RBAC header.' — pinned so the V-326c anchor + team-RBAC purpose + X-Driftstack-Account header name all stay documented", () => {
    expect(body).toMatch(
      /\/\/ V-326c — shared parser for the `X-Driftstack-Account` team-RBAC\s*\n?\s*\/\/ header\./,
    );
  });

  it('Consumer roster pinned, with the call-site COUNT deferred to the AST invariant. `98d767a73` grew this surface to 10 route modules and replaced the hand-maintained "7 routes" number with a roster that points at `effective-account-header-authz-invariant` for the exact count — the better design, because a duplicated count in a comment is precisely what went stale here. Drift to dropping a module from the roster would re-introduce per-route drift surface.', () => {
    expect(body).toMatch(
      /\/\/ 10 route modules currently contain 32 authorized reads of this header for\s*\n\/\/ team-RBAC effective-account resolution \(the AST invariant owns the exact\s*\n\/\/ call-site count\):/,
    );
    for (const routeModule of [
      'account-audit',
      'account-me',
      'admin',
      'agent-sessions',
      'billing',
      'email-preferences',
      'profile-snapshots',
      'profiles',
      'sessions',
      'webhooks',
    ]) {
      expect(body, `roster must list ${routeModule}.ts`).toMatch(
        new RegExp(`// {3}- apps/server/src/routes/${routeModule}\\.ts`),
      );
    }
  });

  it("Extraction-rationale framing pinned: 'Previously each route hand-rolled an identical readEffectiveAccountHeader helper. Extracted to one place so: 1. Drift on any one route can be caught by a parity test. 2. Future safety improvements (e.g. the empty-string normalisation below) land everywhere at once.' — pinned so the extraction-rationale + parity-test-catches-drift + safety-improvements-land-everywhere contract all stay documented", () => {
    expect(body).toMatch(
      /\/\/ Previously each route hand-rolled an identical `readEffectiveAccountHeader`\s*\n?\s*\/\/ helper\. Extracted to one place so:\s*\n?\s*\/\/ {3}1\. Drift on any one route can be caught by a parity test\.\s*\n?\s*\/\/ {3}2\. Future safety improvements \(e\.g\. the empty-string\s*\n?\s*\/\/ {6}normalisation below\) land everywhere at once\./,
    );
  });

  it('Slice 105 BYOK-pattern empty-string normalisation framing pinned: \'The empty-string normalisation matches the slice 105 BYOK fix pattern. Without it a customer sending X-Driftstack-Account: (empty value) would pass "" to resolveEffectiveAccount, which happens to fall back to self-scope correctly today — but relying on downstream behaviour is fragile. Normalising at the read site pins the contract: empty header is indistinguishable from absent.\' — pinned so the slice-105-pattern + empty-is-absent contract + fragile-downstream-reliance rationale all stay documented', () => {
    expect(body).toMatch(
      /\/\/ The empty-string normalisation matches the slice 105 BYOK fix\s*\n?\s*\/\/ pattern\. Without it a customer sending `X-Driftstack-Account:`\s*\n?\s*\/\/ \(empty value\) would pass `""` to `resolveEffectiveAccount`, which\s*\n?\s*\/\/ happens to fall back to self-scope correctly today — but relying\s*\n?\s*\/\/ on downstream behaviour is fragile\. Normalising at the read site\s*\n?\s*\/\/ pins the contract: empty header is indistinguishable from absent\./,
    );
  });

  it("EFFECTIVE_ACCOUNT_HEADER constant pinned: 'x-driftstack-account' (Fastify lowercase). Drift to a different header name would silently break team-RBAC; drift to mixed-case would break the Fastify-lowercases-headers contract", () => {
    expect(body).toMatch(/export const EFFECTIVE_ACCOUNT_HEADER = 'x-driftstack-account';/);
  });

  it("readEffectiveAccountHeader 4-step implementation pinned: 1. read header by lowercase name 2. take first if Array (Fastify presents duplicate headers as array) 3. typeof !== 'string' → return undefined 4. trim + return undefined if empty, else trimmed. + 'Fastify presents duplicate headers as an array — first wins.' framing. Drift to using last-wins on the duplicate-array would let attackers force a specific account scope by appending a second header value", () => {
    expect(body).toMatch(
      /\/\*\*\s*\n?\s*\*\s+Read the `X-Driftstack-Account` team-RBAC effective-account header\./,
    );
    expect(body).toMatch(
      /\*\s+Returns the raw account-id string \(`acc_<uuid>`\) when present, or\s*\n?\s*\*\s+`undefined` when the header is absent OR empty \/ whitespace-only\./,
    );
    expect(body).toMatch(/\*\s+Fastify presents duplicate headers as an array — first wins\./);
    expect(body).toMatch(
      /export function readEffectiveAccountHeader\(request: FastifyRequest\): string \| undefined \{\s*\n?\s*const raw = request\.headers\[EFFECTIVE_ACCOUNT_HEADER\];\s*\n?\s*const value = Array\.isArray\(raw\) \? raw\[0\] : raw;\s*\n?\s*if \(typeof value !== 'string'\) return undefined;\s*\n?\s*const trimmed = value\.trim\(\);\s*\n?\s*return trimmed\.length === 0 \? undefined : trimmed;\s*\n?\s*\}/,
    );
  });
});
