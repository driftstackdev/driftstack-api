// W980 — auth middleware V-353e MFA step-up cross-source invariant.
// Three-hundred-sixth in the drift-guard series. Pins the apps/
// server/src/middleware/auth.ts Fastify-decoration primitive:
//
//   Header framing — 'Auth middleware: validates the Authorization
//   header, attaches the account context to request.account, and
//   rejects with the appropriate problem+json error if the key is
//   missing/invalid/revoked/expired'.
//
//   3-decorator surface — requireAuth + requireScope + requireMfaFresh
//     (V-353e).
//
//   request.account FastifyRequest field augmentation —
//     AccountContext | null.
//
//   V-353e step-up gate framing — 'V-353e — step-up MFA gate. Throws
//   MfaStepUpRequiredError (403) when the calling web session's
//   mfa_satisfied_at is null or older than the freshness window
//   (default 15 min per V-353a Q4). No-ops when the calling account
//   is NOT MFA-enrolled (gate empty), or when the caller is API-key-
//   authed (machine path, MFA is a human-factor concept). Configure
//   the window per-route if you want shorter (e.g. 5 min for billing-
//   tier change)'.
//
//   DEFAULT_MFA_FRESHNESS_SECONDS = 15 * 60 (900 seconds = 15 min,
//     per V-353a Q4).
//
//   AuthPluginOptions 4-field shape — authRepo + authCache (nullable)
//     + authCoalescer (nullable) + mfaService (optional, V-353e).
//
//   requireAuth flow: extractBearerToken → authenticate(repo, token,
//     cache, new Date(), coalescer) → request.account = ctx.
//
//   requireScope decorator: ensures requireAuth ran first, then
//     services/auth requireScope check.
//
//   requireMfaFresh 5-bypass-ladder:
//     - request.account null after requireAuth (would have thrown).
//     - ctx.webSession === null → API-key caller bypass.
//     - !opts.mfaService → no MFA wired = bypass.
//     - !status.enrolled → not-enrolled bypass.
//     - sat null → throw MfaStepUpRequiredError('never_satisfied').
//     - ageSec > window → throw MfaStepUpRequiredError('expired').
//
//   API-key-bypass framing — 'API-key callers (no web session)
//   bypass — MFA is a human-factor gate, not a machine-to-machine
//   concept. Founder may revisit if api-key auth needs MFA gating;
//   surface as a separate slice if so'.
//
//   ageSec calc — (Date.now() - sat.getTime()) / 1000.
//
// stays in lockstep across apps/server/src/middleware/auth.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_MFA_FRESHNESS_SECONDS } from '../../src/middleware/auth.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W980 auth middleware V-353e MFA step-up cross-source invariant', () => {
  // ─── Header framing ──────────────────────────────────────────

  it("CRITICAL apps/server/src/middleware/auth.ts header pins surface — 'Auth middleware: validates the Authorization header, attaches the account context to request.account, and rejects with the appropriate problem+json error if the key is missing/invalid/revoked/expired'. The 4-rejection-mode (missing/invalid/revoked/expired) design is the V-079 auth-middleware contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/middleware/auth.ts'));
    expect(p).toMatch(/Auth middleware: validates the Authorization header, attaches the/);
    expect(p).toMatch(/account context to `request\.account`, and rejects with the appropriate/);
    expect(p).toMatch(/problem\+json error if the key is missing\/invalid\/revoked\/expired\./);
  });

  // ─── FastifyRequest augmentation ─────────────────────────────

  it("CRITICAL FastifyRequest augmentation — 'account: AccountContext | null'. The nullable account field is what makes requireAuth-not-yet-run code paths null-safe.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/middleware/auth.ts'));
    expect(p).toMatch(/interface FastifyRequest \{/);
    expect(p).toMatch(/account: AccountContext \| null;/);
  });

  // ─── 3-decorator surface ─────────────────────────────────────

  it('CRITICAL FastifyInstance augmentation — 3 decorators: requireAuth + requireScope + requireMfaFresh. The 3-decorator surface is what route definitions consume via preHandler.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/middleware/auth.ts'));
    expect(p).toMatch(/interface FastifyInstance \{/);
    expect(p).toMatch(
      /requireAuth: \(request: FastifyRequest, reply: FastifyReply\) => Promise<void>;/,
    );
    expect(p).toMatch(/requireScope: \(/);
    expect(p).toMatch(/scope: ApiKeyScope,/);
    expect(p).toMatch(/requireMfaFresh: \(opts\?: \{/);
    expect(p).toMatch(/freshnessSeconds\?: number;/);
  });

  // ─── V-353e step-up gate framing ─────────────────────────────

  it("CRITICAL V-353e step-up gate framing — 'V-353e — step-up MFA gate. Throws MfaStepUpRequiredError (403) when the calling web session's mfa_satisfied_at is null or older than the freshness window (default 15 min per V-353a Q4). No-ops when the calling account is NOT MFA-enrolled (gate empty), or when the caller is API-key-authed (machine path, MFA is a human-factor concept). Configure the window per-route if you want shorter (e.g. 5 min for billing-tier change)'. The 3-bypass + 2-throw + per-route-override design is the V-353e contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/middleware/auth.ts'));
    expect(p).toMatch(/V-353e — step-up MFA gate\. Throws MfaStepUpRequiredError \(403\)/);
    expect(p).toMatch(/when the calling web session's `mfa_satisfied_at` is null or/);
    expect(p).toMatch(/older than the freshness window \(default 15 min per V-353a Q4\)\./);
    expect(p).toMatch(/No-ops when the calling account is NOT MFA-enrolled \(gate/);
    expect(p).toMatch(/empty\), or when the caller is API-key-authed \(machine path,/);
    expect(p).toMatch(/MFA is a human-factor concept\)\. Configure the window per-route/);
    expect(p).toMatch(/if you want shorter \(e\.g\. 5 min for billing-tier change\)\./);
  });

  // ─── DEFAULT_MFA_FRESHNESS_SECONDS ───────────────────────────

  it('CRITICAL DEFAULT_MFA_FRESHNESS_SECONDS = 15 * 60 (900 seconds). The 15-min window matches the V-353a Q4 verdict.', () => {
    expect(DEFAULT_MFA_FRESHNESS_SECONDS).toBe(15 * 60);
    expect(DEFAULT_MFA_FRESHNESS_SECONDS).toBe(900);
    const p = read(resolve(REPO_ROOT, 'apps/server/src/middleware/auth.ts'));
    expect(p).toMatch(/V-353e — default step-up freshness window per V-353a Q4 verdict\./);
    expect(p).toMatch(/export const DEFAULT_MFA_FRESHNESS_SECONDS = 15 \* 60;/);
  });

  // ─── AuthPluginOptions 4-field shape ─────────────────────────

  it('CRITICAL AuthPluginOptions has 9 fields, and this arm pins 4 of them — authRepo + authCache (nullable) + authCoalescer (nullable) + mfaService (optional, V-353e). The optional-mfaService is what makes the gate a no-op in fixtures without MFA wired.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/middleware/auth.ts'));
    expect(p).toMatch(/export interface AuthPluginOptions \{/);
    expect(p).toMatch(/authRepo: AccountAuthRepo;/);
    expect(p).toMatch(/authCache: AuthCache \| null;/);
    expect(p).toMatch(/authCoalescer: AuthCoalescer \| null;/);
    expect(p).toMatch(/mfaService\?: MfaService \| null;/);
  });

  it("CRITICAL mfaService optional framing — 'V-353e — when set, step-up gate consults this for enrollment state. When omitted the gate becomes a no-op (MFA off in this deploy / test fixture without it)'. The omitted-as-bypass design is what keeps test fixtures terse.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/middleware/auth.ts'));
    expect(p).toMatch(/V-353e — when set, step-up gate consults this for enrollment/);
    expect(p).toMatch(/state\. When omitted the gate becomes a no-op \(MFA off in this/);
    expect(p).toMatch(/deploy \/ test fixture without it\)\./);
  });

  // ─── requireAuth flow ────────────────────────────────────────

  it('CRITICAL requireAuth flow — extractBearerToken(request.headers.authorization) → authenticate(repo, token, cache, new Date(), coalescer) → request.account = ctx. The 3-arg + 5-arg-call shape is the V-079 + D-020 auth-cache + coalescer wire-format.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/middleware/auth.ts'));
    expect(p).toMatch(/const token = extractBearerToken\(request\.headers\.authorization\);/);
    expect(p).toMatch(/const ctx = await authenticate\(/);
    expect(p).toMatch(/opts\.authRepo,/);
    expect(p).toMatch(/token,/);
    expect(p).toMatch(/opts\.authCache,/);
    expect(p).toMatch(/new Date\(\),/);
    expect(p).toMatch(/opts\.authCoalescer,/);
    expect(p).toMatch(/request\.account = ctx;/);
  });

  // ─── requireScope decorator wires ────────────────────────────

  it('CRITICAL requireScope decorator — when request.account is null first runs requireAuth, then services/auth requireScope. The lazy-auth + scope-check split lets routes opt into auth + scope in one preHandler.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/middleware/auth.ts'));
    expect(p).toMatch(/app\.decorate\('requireScope', \(scope: ApiKeyScope\) => \{/);
    expect(p).toMatch(/if \(!request\.account\) \{/);
    expect(p).toMatch(/await requireAuth\(request, reply\);/);
    expect(p).toMatch(/if \(request\.account\) requireScope\(request\.account, scope\);/);
  });

  // ─── requireMfaFresh 5-bypass-ladder ─────────────────────────

  it('CRITICAL requireMfaFresh bypass 1 — request.account null after requireAuth = requireAuth would have thrown. The early-return-on-null is defense-in-depth.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/middleware/auth.ts'));
    expect(p).toMatch(/const ctx = request\.account;/);
    expect(p).toMatch(/if \(!ctx\) return; \/\/ requireAuth would have thrown/);
  });

  it("CRITICAL requireMfaFresh bypass 2 framing — 'API-key callers (no web session) bypass — MFA is a human-factor gate, not a machine-to-machine concept. Founder may revisit if api-key auth needs MFA gating; surface as a separate slice if so'. The webSession===null bypass is the V-353e api-key-machine carve-out.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/middleware/auth.ts'));
    expect(p).toMatch(/API-key callers \(no web session\) bypass — MFA is a human-/);
    expect(p).toMatch(/factor gate, not a machine-to-machine concept\. Founder may/);
    expect(p).toMatch(/revisit if api-key auth needs MFA gating; surface as a/);
    expect(p).toMatch(/separate slice if so\./);
    expect(p).toMatch(/if \(ctx\.webSession === null\) return;/);
  });

  it("CRITICAL requireMfaFresh bypass 3 — no MfaService wired → no gate. 'No MfaService wired = MFA disabled in this deploy → no gate'.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/middleware/auth.ts'));
    expect(p).toMatch(/\/\/ No MfaService wired = MFA disabled in this deploy → no gate\./);
    expect(p).toMatch(/if \(!opts\.mfaService\) return;/);
  });

  it("CRITICAL requireMfaFresh bypass 4 — !status.enrolled returns (no gate when account isn't MFA-enrolled). The not-enrolled-bypass keeps the gate empty for accounts that haven't opted in.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/middleware/auth.ts'));
    expect(p).toMatch(/const status = await opts\.mfaService\.getStatus\(ctx\.account\.id\);/);
    expect(p).toMatch(/if \(!status\.enrolled\) return;/);
  });

  it("CRITICAL requireMfaFresh throw 1 — sat===null → throw MfaStepUpRequiredError('never_satisfied'). The never-satisfied reason-code distinguishes 'web session lacks MFA' from 'web session expired'.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/middleware/auth.ts'));
    expect(p).toMatch(/const sat = ctx\.webSession\.mfaSatisfiedAt;/);
    expect(p).toMatch(/if \(sat === null\) \{/);
    expect(p).toMatch(/throw new MfaStepUpRequiredError\('never_satisfied'\);/);
  });

  it("CRITICAL requireMfaFresh throw 2 — ageSec > window → throw MfaStepUpRequiredError('expired'). The 2-reason taxonomy lets the client distinguish 'prompt for OTP' vs 'fresh OTP only'.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/middleware/auth.ts'));
    expect(p).toMatch(/const ageSec = \(Date\.now\(\) - sat\.getTime\(\)\) \/ 1000;/);
    expect(p).toMatch(/if \(ageSec > window\) \{/);
    expect(p).toMatch(/throw new MfaStepUpRequiredError\('expired'\);/);
  });

  // ─── Per-route freshness override ────────────────────────────

  it('CRITICAL requireMfaFresh accepts per-route freshnessSeconds override — `gateOpts?.freshnessSeconds ?? DEFAULT_MFA_FRESHNESS_SECONDS`. The override is what V-353e routes (e.g. billing-tier change) use to tighten to 5 min.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/middleware/auth.ts'));
    expect(p).toMatch(
      /app\.decorate\('requireMfaFresh', \(gateOpts\?: \{ freshnessSeconds\?: number \}\) => \{/,
    );
    expect(p).toMatch(
      /const window = gateOpts\?\.freshnessSeconds \?\? DEFAULT_MFA_FRESHNESS_SECONDS;/,
    );
  });

  // ─── requireOwner gate (2026-06-04 master-owner foundation) ──

  it('CRITICAL requireOwner — project-owner gate: ownerEmail AuthPluginOptions field + FastifyInstance decorator decl + the identity check (account.email vs ownerEmail) + fails CLOSED when no owner configured. Admits ONLY the owner, not staff-admins.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/middleware/auth.ts'));
    // AuthPluginOptions carries the owner email.
    expect(p).toMatch(/ownerEmail\?: string \| null;/);
    // FastifyInstance decorator declaration.
    expect(p).toMatch(
      /requireOwner: \(request: FastifyRequest, reply: FastifyReply\) => Promise<void>;/,
    );
    // Decorator impl: lowercase the configured owner, lazy-auth, then
    // forbid when no owner configured OR account email != owner.
    expect(p).toMatch(
      /const ownerEmail = opts\.ownerEmail != null \? opts\.ownerEmail\.trim\(\)\.toLowerCase\(\) : null;/,
    );
    expect(p).toMatch(/app\.decorate\(\s*'requireOwner',/);
    expect(p).toMatch(/if \(ownerEmail === null \|\| ownerEmail\.length === 0\) \{/);
    expect(p).toMatch(/if \(ctx\.account\.email\.toLowerCase\(\) !== ownerEmail\) \{/);
    expect(p).toMatch(/This action requires the project owner account\./);
  });

  it('CRITICAL bootstrap wires the owner — DRIFTSTACK_OWNER_EMAIL (default founder account), unioned into the staff set (owner always admin), passed as deps.ownerEmail.', () => {
    const b = read(resolve(REPO_ROOT, 'apps/server/src/lib/bootstrap.ts'));
    expect(b).toMatch(
      /const ownerEmailRaw = process\.env\.DRIFTSTACK_OWNER_EMAIL \?\? 'joeltheunissen89@gmail\.com';/,
    );
    expect(b).toMatch(
      /const ownerEmail: string \| null = ownerEmailRaw\.trim\(\)\.toLowerCase\(\) \|\| null;/,
    );
    // Owner unioned into the staff set → always admin.
    expect(b).toMatch(
      /ownerEmail !== null \? new Set\(\[\.\.\.staffEmails, ownerEmail\]\) : staffEmails;/,
    );
    expect(b).toMatch(/\.\.\.\(ownerEmail !== null \? \{ ownerEmail \} : \{\}\),/);
  });

  // ─── Plugin name ─────────────────────────────────────────────

  it("CRITICAL plugin name 'auth' — registered via fp(authPlugin, { name: 'auth' }). The named-plugin lets bootstrap.ts assert ordering.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/middleware/auth.ts'));
    expect(p).toMatch(/export default fp\(authPlugin, \{ name: 'auth' \}\);/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/auth-middleware-v353e-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
