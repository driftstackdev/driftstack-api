// W556.B — drift guard for /docs/runbooks/oauth-ops.md.
// V-682 internal OAuth ops ref. Drift here either weakens the
// 1h-token-TTL-no-refresh posture (would re-permit perpetual
// access), drops the secret-shown-ONCE rotation discipline, or
// weakens the full-kill revocation guarantee (would surprise ops
// if a revoked client retained bearer authority).
//
//   • V-682. Customer-facing dev docs live at /docs/oauth-apps.
//   • Token TTL: 1 hour. NO refresh tokens (intentional —
//     forces consent re-confirmation on regular cadence).
//   • V-667.B register/revoke + V-667.E rotate-secret admin routes.
//   • Secret shown ONCE — copy to password-manager + email reply.
//   • Rotation preserves access tokens; client revoke atomically
//     invalidates every backing token authority.
//   • Introspect /v1/oauth/introspect for 401 triage.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'docs/runbooks/oauth-ops.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W556.B /docs/runbooks/oauth-ops.md content parity', () => {
  const body = read(LIB);

  it("Header + V-682 + customer-vs-internal split framing pinned: '# OAuth operator runbook (V-682)' + 'Internal operational reference for the V-667 OAuth subsystem.' + 'The customer-facing developer docs live at [`/docs/oauth-apps`]' + 'this runbook is for Driftstack ops handling the admin surface, incident response, and revocation/rotation workflows.' + 'A third-party developer requests a new OAuth client.' + 'A leaked client_secret needs to be rotated.' + 'A misbehaving client needs to be revoked.' + 'Token TTL: **1 hour**. There are no refresh tokens (intentional — forces consent re-confirmation on a regular cadence).' — pinned so the V-682-V-667-OAuth-subsystem + customer-vs-internal-doc-split + 4-trigger-condition + 1h-TTL-no-refresh-intentional commitment survives", () => {
    expect(body).toMatch(/^# OAuth operator runbook \(V-682\)$/m);
    expect(body).toMatch(/Internal operational reference for the V-667 OAuth subsystem\./);
    expect(body).toMatch(/customer-facing developer docs live at/);
    expect(body).toMatch(/\[`\/docs\/oauth-apps`\]/);
    expect(body).toMatch(/this runbook is for Driftstack ops handling/);
    expect(body).toMatch(/the admin surface, incident response, and revocation\/rotation/);
    expect(body).toMatch(/workflows\./);
    expect(body).toMatch(/- A third-party developer requests a new OAuth client\./);
    expect(body).toMatch(/- A leaked client_secret needs to be rotated\./);
    expect(body).toMatch(/- A misbehaving client needs to be revoked\./);
    expect(body).toMatch(/Token TTL: \*\*1 hour\*\*\. There are no refresh tokens \(intentional —/);
    expect(body).toMatch(/forces consent re-confirmation on a regular cadence\)\./);
  });

  it("Client registration + secret-shown-ONCE framing pinned: 'A developer requests a client by emailing `developers@driftstack.dev`' + 'Is the redirect_uri HTTPS (or `http://localhost:…` for dev)?' + 'Are the requested scopes proportional to the use case?' + 'curl -X POST' + '-H \"Authorization: Bearer $INTERNAL_ADMIN_KEY\"' + '\"$BASE_URL/v1/admin/oauth/clients\"' + 'The response returns `client_id` + `client_secret`. Both are plaintext; the secret is shown ONCE — copy it into the founder's password manager + the email reply to the developer.' — pinned so the developers@driftstack.dev + HTTPS-or-localhost-redirect_uri + scope-proportionality + admin-curl-POST + client_id+client_secret-plaintext + shown-ONCE-password-manager commitment survives", () => {
    expect(body).toMatch(/A developer requests a client by emailing/);
    expect(body).toMatch(/`developers@driftstack\.dev`/);
    expect(body).toMatch(/- Is the redirect_uri HTTPS \(or `http:\/\/localhost:…` for dev\)\?/);
    expect(body).toMatch(/- Are the requested scopes proportional to the use case\?/);
    expect(body).toMatch(/curl -X POST \\/);
    expect(body).toMatch(/-H "Authorization: Bearer \$INTERNAL_ADMIN_KEY"/);
    expect(body).toMatch(/"\$BASE_URL\/v1\/admin\/oauth\/clients"/);
    expect(body).toMatch(/3\. The response returns `client_id` \+ `client_secret`\. Both are/);
    expect(body).toMatch(/plaintext; the secret is shown ONCE — copy it into the/);
    expect(body).toMatch(/founder's password manager \+ the email reply to the developer\./);
  });

  it('Rotation preserves tokens while client revocation is an atomic full kill', () => {
    expect(body).toMatch(/## Rotating a client_secret \(V-667\.E\)/);
    expect(body).toMatch(/"\$BASE_URL\/v1\/admin\/oauth\/clients\/<client_id>\/rotate-secret"/);
    expect(body).toMatch(/The response carries the NEW plaintext `client_secret`\./);
    expect(body).toMatch(
      /The old secret\s*is invalid immediately — any in-flight `\/token` exchanges using/,
    );
    expect(body).toMatch(/the old secret will fail\./);
    expect(body).toMatch(/\*\*Existing access tokens stay valid\*\*/);
    expect(body).toMatch(/because they're bearer-authenticated\. The new secret is required for/);
    expect(body).toMatch(/subsequent `\/token`, `\/introspect`, and `\/revoke` requests\./);
    expect(body).toMatch(/## Revoking a client \(full kill\)/);
    expect(body).toMatch(/curl -X DELETE \\/);
    expect(body).toMatch(/`revoked_at` is set on the client row\. Effects:/);
    expect(body).toMatch(/- New `\/authorize` requests for the client fail\./);
    expect(body).toMatch(/- New `\/token` exchanges fail \(the service blocks revoked clients\)\./);
    expect(body).toMatch(/- \*\*Every existing access token issued by the client is revoked in/);
    expect(body).toMatch(/the same database transaction\.\*\*/);
    expect(body).toMatch(/there is no positive OAuth-auth cache or/);
    expect(body).toMatch(/one-hour residual-access window\./);
    expect(body).toMatch(
      /Rotation replaces\s*only the client authenticator and keeps current bearer tokens alive/,
    );
  });

  it('Triage keeps token+secret with the developer, uses client-authenticated introspection, and shares only sanitized output', () => {
    expect(body).toMatch(/## Triage workflow — "this token is failing"/);
    expect(body).toMatch(/Do not ask\s*them to send Driftstack the bearer token or client secret/);
    expect(body).toMatch(/base64 is\s*not encryption/);
    expect(body).toMatch(/--arg client_id "\$OAUTH_CLIENT_ID"/);
    expect(body).toMatch(/--arg client_secret "\$OAUTH_CLIENT_SECRET"/);
    expect(body).toMatch(/"\$BASE_URL\/v1\/oauth\/introspect"/);
    expect(body).toMatch(/stores only the client-secret hash and cannot run this/);
    expect(body).toMatch(/- `401 invalid_client` → client id\/secret mismatch or revoked client\./);
    expect(body).toMatch(/- `active: false` → token is revoked or expired\./);
    expect(body).toMatch(/- `active: true` with the wrong `scope` → the developer/);
    expect(body).toMatch(/requested narrower scopes than the call they're attempting/);
    expect(body).toMatch(/needs\./);
    expect(body).toMatch(/- `active: true` with the right scope but the call still 401s/);
    expect(body).toMatch(/→ not an OAuth problem; check the account's API rate-limit/);
    expect(body).toMatch(/state \+ V-481 scope predicate edge cases\./);
  });

  it('Security incident response pins atomic revoke, notification, and failure-mode triage', () => {
    expect(body).toMatch(/## Security incident posture/);
    expect(body).toMatch(/1\. \*\*Revoke the client immediately\*\* \(above\)\. Don't wait for/);
    expect(body).toMatch(/developer confirmation\. This atomically revokes its active tokens\./);
    expect(body).toMatch(/2\. Open an incident in the `incidents` runbook with severity/);
    expect(body).toMatch(/`major` or `critical` depending on impact\./);
    expect(body).toMatch(/3\. Notify the affected customer \(the one whose data the client/);
    expect(body).toMatch(/could access\) within 24h via the standard incident-comms path\./);
    expect(body).toMatch(/`\/authorize` returns 400 "invalid_request"/);
    expect(body).toMatch(/`\/token` returns 401 "invalid_client"/);
    expect(body).toMatch(/`\/token` returns 400 "invalid_grant"/);
    expect(body).toMatch(/`\/introspect` returns active:false unexpectedly/);
    expect(body).toMatch(/Customer sees an unexpected OAuth consent/);
    expect(body).toMatch(
      /Phishing — someone got their session and tried to authorize a malicious client\./,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
