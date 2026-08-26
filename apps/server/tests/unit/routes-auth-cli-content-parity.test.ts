// W418.B — drift guard for apps/server/src/routes/auth-cli.ts.
// V-266 Browser-OAuth-style CLI/GUI activation. 3 endpoints (initiate
// public + bind auth-required + exchange public). Drift here either
// breaks the bind-failure revoke compensation (plaintext leaks if the
// bind fails AND the just-minted key isn't revoked) or breaks
// CliAuthorizeError → HTTP error mapping (clients can't distinguish
// state mismatch from expired code).
//
//   • V-266 framing pinned: initiate (CLI/GUI starts) + bind
//     (dashboard binds the code, auth required) + exchange (CLI/GUI
//     polls for issued key).
//   • Default key shape: DEFAULT_KEY_NAME='Desktop client' +
//     DEFAULT_SCOPES=['account_owner'].
//   • Schemas sourced from @driftstack/api-types: Initiate/Bind/
//     Exchange request schemas + ApiKeyScope type.
//   • Bind compensation: revoke the just-minted key on every thrown bind
//     failure, log a secondary revoke failure, and preserve/map the
//     original bind error.
//   • account_id stamped as `acc_${ctx.account.id}` template.
//   • CliAuthorizeError → HTTP map: state_mismatch+already_bound+
//     invalid_code → 400 BadRequestError; not_found+expired → 404
//     NotFoundError.
//   • Auth posture: initiate + exchange = public but each carries a
//     dedicated per-IP gate (initiate 5/min, exchange 60/min poll);
//     bind = requireAuth + rateLimit('global').
//   • ValidationError on zod safeParse fail (parsed.error.flatten()).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/routes/auth-cli.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W418.B apps/server/src/routes/auth-cli.ts content parity', () => {
  const body = read(LIB);

  it('V-266 framing pinned: 3 routes — initiate (public, IP-gated) + bind (auth required, dashboard) + exchange (public, IP-gated, CLI polls)', () => {
    expect(body).toMatch(/V-266 — Browser-OAuth-style activation flow for CLI \/ GUI clients\./);
    expect(body).toMatch(
      /POST \/v1\/auth\/cli-authorize\/initiate\s+— public; CLI\/GUI starts the flow/,
    );
    expect(body).toMatch(
      /POST \/v1\/auth\/cli-authorize\/bind-device-code\s+— auth required; dashboard binds the code/,
    );
    expect(body).toMatch(
      /POST \/v1\/auth\/cli-authorize\/exchange\s+— public; CLI\/GUI polls for the issued key/,
    );
  });

  it('Bind framing pinned: requires authenticated account (dashboard web session); mints API key on that account; hands plaintext to CLI via exchange', () => {
    expect(body).toMatch(
      /The bind endpoint requires an authenticated account \(typically via\s*\/\/\s*the dashboard's web session\)\. It mints an API key on that account\s*\/\/\s*and hands the plaintext to the CLI\/GUI via the exchange endpoint\./,
    );
  });

  it("Defaults: DEFAULT_KEY_NAME='Desktop client' + DEFAULT_SCOPES=['account_owner']", () => {
    expect(body).toMatch(/const DEFAULT_KEY_NAME = 'Desktop client';/);
    expect(body).toMatch(/const DEFAULT_SCOPES: ApiKeyScope\[\] = \['account_owner'\];/);
  });

  it('Schemas + types from @driftstack/api-types: Initiate/Bind/Exchange + ApiKeyScope (SDK mirror)', () => {
    expect(body).toMatch(
      /import \{\s*CliAuthorizeBindRequestSchema,\s*CliAuthorizeExchangeRequestSchema,\s*CliAuthorizeInitiateRequestSchema,\s*\} from '@driftstack\/api-types';/,
    );
    expect(body).toMatch(/import type \{ ApiKeyScope \} from '@driftstack\/api-types';/);
  });

  it('Initiate returns the separate device-displayed user_code', () => {
    expect(body).toMatch(
      /app\.post\('\/v1\/auth\/cli-authorize\/initiate', \{ preHandler: \[initiateGate\] \}, async \(req\) => \{\s*const parsed = CliAuthorizeInitiateRequestSchema\.safeParse\(req\.body\);\s*if \(!parsed\.success\) throw new ValidationError\(parsed\.error\.flatten\(\)\);/,
    );
    // The IP gates are built from the shared store + the AUTH_IP_LIMITS buckets.
    expect(body).toMatch(
      /const initiateGate = ipRateLimit\(rateLimitStore, \{\s*bucketPrefix: 'auth-ip:cli-authorize-initiate',/,
    );
    expect(body).toMatch(/AUTH_IP_LIMITS\.cliAuthorizeInitiate\.capacity/);
    expect(body).toMatch(
      /const result = await cliAuthorizeService\.initiate\([\s\S]*?return \{\s*code: result\.code,\s*user_code: result\.user_code,\s*browser_url: result\.browser_url,\s*expires_at: result\.expires_at\.toISOString\(\),\s*\};/,
    );
  });

  it("Bind: requireAuth + rateLimit('global'); apiKeysService.create with DEFAULT_KEY_NAME + scopes + expiresAt:null; account_id stamped as acc_<uuid>", () => {
    expect(body).toMatch(
      /app\.post\(\s*'\/v1\/auth\/cli-authorize\/bind-device-code',\s*\{ preHandler: \[app\.requireAuth, app\.rateLimit\('global'\)\] \},/,
    );
    expect(body).toMatch(/const scopes = parsed\.data\.scopes \?\? DEFAULT_SCOPES;/);
    // C1 — the minted device key is stamped provenance:'cli_device' so the
    // deny-gate bars it from account-takeover operations.
    expect(body).toMatch(
      /const created = await apiKeysService\.create\(ctx, \{\s*name: DEFAULT_KEY_NAME,\s*scopes,\s*expiresAt: null,[\s\S]*?provenance: 'cli_device',\s*\}\);/,
    );
    // C1 — bind requires an interactive web session (no API-key-authed bind).
    expect(body).toMatch(/if \(ctx\.webSession === null\) \{/);
    expect(body).toMatch(/account_id: `acc_\$\{ctx\.account\.id\}`,/);
    expect(body).toMatch(/user_code: parsed\.data\.user_code,/);
    expect(body).toMatch(/api_key_plaintext: created\.plaintext,/);
    expect(body).not.toMatch(/cliAuthorizeService\.bind\(\{[\s\S]*?scopes,[\s\S]*?\}\);/);
  });

  it('Bind compensation pinned: every bind failure revokes the just-minted key, logs secondary revoke failure, and preserves/maps the original error', () => {
    expect(body).toMatch(
      /\/\/ Every failed bind must retire the just-minted key, including\s*\/\/ infrastructure\/serialization failures that are not expressed as\s*\/\/ CliAuthorizeError\./,
    );
    expect(body).toMatch(
      /try \{\s*await apiKeysService\.revoke\(ctx, created\.row\.id\);\s*\} catch \(revokeErr\) \{[\s\S]*?req\.log\.error\([\s\S]*?apiKeyId: created\.row\.id[\s\S]*?\);\s*\}\s*if \(err instanceof CliAuthorizeError\) throw mapCliAuthorizeError\(err\);\s*throw err;/,
    );
  });

  it('Bind success reply: { ok: true as const, account_id, expires_at ISO }', () => {
    expect(body).toMatch(
      /return \{\s*ok: true as const,\s*account_id: result\.account_id,\s*expires_at: result\.expires_at\.toISOString\(\),\s*\};/,
    );
  });

  it('Exchange: public but IP-gated (exchangeGate preHandler, generous 60/min poll bucket); cliAuthorizeService.exchange dispatch; pass-through result; CliAuthorizeError → HTTP map', () => {
    expect(body).toMatch(
      /app\.post\('\/v1\/auth\/cli-authorize\/exchange', \{ preHandler: \[exchangeGate\] \}, async \(req\) => \{[\s\S]+?const result = await cliAuthorizeService\.exchange\(\{\s*code: parsed\.data\.code,\s*state: parsed\.data\.state,\s*\}\);\s*return result;[\s\S]+?if \(err instanceof CliAuthorizeError\) throw mapCliAuthorizeError\(err\);/,
    );
    expect(body).toMatch(
      /const exchangeGate = ipRateLimit\(rateLimitStore, \{\s*bucketPrefix: 'auth-ip:cli-authorize-exchange',/,
    );
    expect(body).toMatch(/AUTH_IP_LIMITS\.cliAuthorizeExchange\.capacity/);
  });

  it('mapCliAuthorizeError: user_code_mismatch has a stable 400 response', () => {
    expect(body).toMatch(/function mapCliAuthorizeError\(err: CliAuthorizeError\): Error \{/);
    expect(body).toMatch(
      /case 'state_mismatch':\s*return new BadRequestError\('State parameter does not match\.'\);/,
    );
    expect(body).toMatch(
      /case 'user_code_mismatch':\s*return new BadRequestError\('Device verification code does not match\.'\);/,
    );
    expect(body).toMatch(
      /case 'already_bound':\s*return new BadRequestError\('Authorization code has already been bound\.'\);/,
    );
    expect(body).toMatch(
      /case 'not_found':\s*case 'expired':\s*return new NotFoundError\('Authorization code not found or expired\.'\);/,
    );
    expect(body).toMatch(
      /case 'invalid_code':\s*return new BadRequestError\('Authorization code is invalid\.'\);/,
    );
  });

  it('AuthCliRoutesDeps: cliAuthorizeService + apiKeysService + rateLimitStore (for the public-route IP gates)', () => {
    expect(body).toMatch(/cliAuthorizeService: CliAuthorizeService;/);
    expect(body).toMatch(/apiKeysService: ApiKeysService;/);
    expect(body).toMatch(/rateLimitStore: RateLimitStore;/);
  });

  it('imports: FastifyInstance + ApiKeysService + CliAuthorizeError/Service + BadRequestError/NotFoundError/ValidationError + AUTH_IP_LIMITS/ipRateLimit + RateLimitStore', () => {
    expect(body).toMatch(/import type \{ FastifyInstance \} from 'fastify';/);
    expect(body).toMatch(/import type \{ ApiKeysService \} from '\.\.\/services\/api-keys\.js';/);
    expect(body).toMatch(
      /import \{ CliAuthorizeError, type CliAuthorizeService \} from '\.\.\/services\/cli-authorize\.js';/,
    );
    expect(body).toMatch(
      /import \{\s*BadRequestError,\s*FeatureUnavailableError,\s*ForbiddenError,\s*NotFoundError,\s*ValidationError,\s*\} from '\.\.\/lib\/errors\.js';/,
    );
    expect(body).toMatch(
      /import \{ AUTH_IP_LIMITS, ipRateLimit \} from '\.\.\/middleware\/ip-rate-limit\.js';/,
    );
    expect(body).toMatch(/import type \{ RateLimitStore \} from '\.\.\/services\/rate-limit\.js';/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
