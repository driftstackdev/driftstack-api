// W417.B — drift guard for apps/server/src/routes/account-web-sessions.ts.
// V-355 customer-facing web-session list + revoke. Distinct from
// /v1/sessions (driver sessions in fleet). Drift here either leaks
// the raw UA string (fingerprintable per V-355 framing) or breaks the
// `?keep=current` bulk-revoke explicit-intent gate (a stray
// `DELETE /v1/account/web-sessions` would wipe every session).
//
//   • V-355 framing pinned: 3 routes (GET list + DELETE per-id +
//     DELETE bulk with ?keep=current); distinct from /v1/sessions
//     (driver sessions running browsers in the fleet).
//   • Privacy framing pinned: IP omitted from dashboard per V-355;
//     UA bucketed to coarse "macOS · Safari" rather than raw value
//     (raw UA is fingerprintable + changes on every Safari
//     point-release in a way customers don't care about).
//   • bucketUserAgent: 5 OS (macOS|Windows|Android|iOS|Linux) + 5
//     browser (Edge|Opera|Firefox|Chrome|Safari) buckets; "Unknown
//     · Unknown" miss fallback; Safari LAST (signature in every
//     WebKit UA).
//   • currentWebSessionIdFromRequest: synthetic ApiKeyRow id with
//     `wsk_<uuid>` prefix → strip; non-web-session callers (real
//     API key, different prefix) return null.
//   • uuidFromPublicSessionId: `wsess_` prefix strip + uuid regex
//     validation; BadRequestError on shape mismatch.
//   • publicSession: id=wsess_ + os/browser bucketed + last_used_at/
//     expires_at ISO + current boolean.
//   • Bulk revoke gate: `?keep=current` required; missing OR
//     non-web-session caller → BadRequestError (no "current" to
//     keep).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/routes/account-web-sessions.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W417.B apps/server/src/routes/account-web-sessions.ts content parity', () => {
  const body = read(LIB);

  it('V-355 framing pinned: 3 routes (GET list + DELETE per-id + DELETE bulk with ?keep=current); distinct from /v1/sessions driver sessions', () => {
    expect(body).toMatch(/V-355 — customer-facing web-session list \+ revoke endpoints\./);
    expect(body).toMatch(/\/v1\/account\/web-sessions\s+GET\s+— list the calling account's active/);
    expect(body).toMatch(/\/v1\/account\/web-sessions\/:id DELETE — revoke a specific session\./);
    expect(body).toMatch(/\/v1\/account\/web-sessions\s+DELETE\s+— `\?keep=current` revokes every/);
    expect(body).toMatch(
      /Distinct from \/v1\/sessions \(driver sessions running browsers in the\s*\/\/\s*fleet\) — these are the customer's own dashboard sign-ins\./,
    );
  });

  it('Privacy framing pinned: IP omitted; UA bucketed coarse to defeat fingerprint + point-release churn', () => {
    expect(body).toMatch(
      /IP and user-agent are surfaced as broad bucket strings rather than the\s*\/\/\s*raw values: \/settings already comments "IP omitted from dashboard for\s*\/\/\s*privacy", and the user-agent string is fingerprintable enough that we\s*\/\/\s*reduce it to "macOS · Safari" before render\./,
    );
  });

  it('bucketUserAgent: 5 OS + 5 browser families; Safari LAST (WebKit signature); "Unknown · Unknown" miss fallback', () => {
    expect(body).toMatch(
      /export function bucketUserAgent\(ua: string \| null\): \{ os: string; browser: string \} \{\s*if \(!ua\) return \{ os: 'Unknown', browser: 'Unknown' \};/,
    );
    expect(body).toMatch(/if \(\/Mac OS X\|macOS\/i\.test\(ua\)\) os = 'macOS';/);
    expect(body).toMatch(/else if \(\/Windows\/i\.test\(ua\)\) os = 'Windows';/);
    expect(body).toMatch(/else if \(\/Android\/i\.test\(ua\)\) os = 'Android';/);
    expect(body).toMatch(/else if \(\/iPhone\|iPad\|iOS\/i\.test\(ua\)\) os = 'iOS';/);
    expect(body).toMatch(/else if \(\/Linux\/i\.test\(ua\)\) os = 'Linux';/);
    expect(body).toMatch(
      /\/\/ Order matters: Edg \/ OPR \/ Chrome \/ Safari \(Safari signature is in\s*\/\/ every WebKit UA so it has to be checked LAST\)\./,
    );
    expect(body).toMatch(/if \(\/Edg\\\/\/i\.test\(ua\)\) browser = 'Edge';/);
    expect(body).toMatch(/else if \(\/OPR\\\/\/i\.test\(ua\)\) browser = 'Opera';/);
    expect(body).toMatch(/else if \(\/Firefox\\\/\/i\.test\(ua\)\) browser = 'Firefox';/);
    expect(body).toMatch(/else if \(\/Chrome\\\/\/i\.test\(ua\)\) browser = 'Chrome';/);
    expect(body).toMatch(/else if \(\/Safari\\\/\/i\.test\(ua\)\) browser = 'Safari';/);
  });

  it('currentWebSessionIdFromRequest: synthetic apiKey id `wsk_<uuid>` strip; non-web-session callers return null', () => {
    expect(body).toMatch(
      /V-355 — extract the calling web session's id from the AccountContext\.\s*\*\s*The auth path stamps the synthetic ApiKeyRow's id as `wsk_<uuid>` for\s*\*\s*web sessions; non-web-session callers \(a real API key\) have a\s*\*\s*different prefix and return null here\. Callers should treat null as\s*\*\s*"this isn't a web-session-authed request" and refuse the operation\./,
    );
    expect(body).toMatch(
      /function currentWebSessionIdFromRequest\(request: FastifyRequest\): string \| null \{\s*const ctx = request\.account;\s*if \(!ctx\) return null;\s*const id = ctx\.apiKey\.id;\s*if \(typeof id !== 'string' \|\| !id\.startsWith\('wsk_'\)\) return null;\s*return id\.slice\('wsk_'\.length\);/,
    );
  });

  it('publicSession: id=wsess_ + bucketed os/browser + last_used_at/expires_at ISO + current boolean (row.id === currentId)', () => {
    expect(body).toMatch(
      /function publicSession\(\s*row: WebSessionRow,\s*currentId: string \| null,/,
    );
    expect(body).toMatch(/const ua = bucketUserAgent\(row\.userAgent\);/);
    expect(body).toMatch(/id: `wsess_\$\{row\.id\}`,/);
    expect(body).toMatch(/os: ua\.os,/);
    expect(body).toMatch(/browser: ua\.browser,/);
    expect(body).toMatch(/last_used_at: row\.lastUsedAt\.toISOString\(\),/);
    expect(body).toMatch(/expires_at: row\.expiresAt\.toISOString\(\),/);
    expect(body).toMatch(/current: row\.id === currentId,/);
  });

  it('uuidFromPublicSessionId: wsess_ prefix strip + STRICT uuid regex; BadRequestError "Invalid session id." on either shape mismatch', () => {
    // Discrete pins rather than one chained mega-regex: the chained form could
    // not span an explanatory comment added between two of its segments, and a
    // guard that breaks on a comment is pinning layout, not behaviour.
    expect(body).toMatch(/function uuidFromPublicSessionId\(input: string\): string \{/);
    expect(body).toMatch(/if \(!input\.startsWith\('wsess_'\)\) \{/);
    expect(body).toMatch(/const id = input\.slice\('wsess_'\.length\);/);
    // STRICT uuid shape — the old [0-9a-fA-F-]{36} accepted 36 hex-or-dash
    // characters in any arrangement and 500'd on the Postgres uuid column.
    expect(body).toMatch(
      /if \(!\/\^\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{12\}\$\/i\.test\(id\)\) \{/,
    );
    expect(body).toMatch(/throw new BadRequestError\('Invalid session id\.'\);/);
  });

  it("DELETE per-id: requireAuth + requireScope('account_owner') (W492) + rateLimit('global'); 204 on success; NotFoundError 'Session not found.' when service returns false", () => {
    expect(body).toMatch(
      /app\.delete<\{ Params: \{ id: string \} \}>\(\s*'\/v1\/account\/web-sessions\/:id',[\s\S]*?\{ preHandler: \[app\.requireAuth, app\.requireScope\('account_owner'\), app\.rateLimit\('global'\)\] \},/,
    );
    expect(body).toMatch(
      /const ok = await service\.revokeWebSessionForAccount\(ctx\.account\.id, sessionId\);\s*if \(!ok\) throw new NotFoundError\('Session not found\.'\);/,
    );
    // Security-relevant revocation is audited (account.web_session_revoked).
    expect(body).toMatch(
      /await emitRevoked\(request, ctx\.account\.id, `wsess_\$\{sessionId\}`, \{ scope: 'single' \}\);\s*reply\.code\(204\);/,
    );
  });

  it("Bulk revoke gate: ?keep=current required (case-insensitive); missing → 400 'Bulk revoke requires `?keep=current`'; non-web-session caller → 400", () => {
    // V-1368 — the read used to come straight off request.query. A repeated query key
    // parses to an array, and .toLowerCase() on an array is a TypeError, so a duplicated
    // ?keep answered 500 rather than the 400 this gate gives every other unusable value.
    // The schema narrows the type; the case-insensitive comparison below is unchanged.
    expect(body).toMatch(
      /const query = BulkRevokeQuerySchema\.safeParse\(request\.query \?\? \{\}\);\s*if \(!query\.success\) throw new ValidationError\(query\.error\.flatten\(\)\);\s*const keep = \(query\.data\.keep \?\? ''\)\.toLowerCase\(\);/,
    );
    expect(body, 'a literal here would drop the case-insensitivity the gate commits to').toMatch(
      /const BulkRevokeQuerySchema = z\.object\(\{\s*keep: z\.string\(\)\.optional\(\),\s*\}\);/,
    );
    expect(body).toMatch(
      /if \(keep !== 'current'\) \{\s*throw new BadRequestError\(\s*'Bulk revoke requires `\?keep=current`\. Pass it explicitly to confirm intent\.',\s*\);/,
    );
    expect(body).toMatch(
      /\/\/ Non-web-session caller can't bulk revoke \+ keep current —\s*\/\/ there is no "current" to keep\. Refuse rather than guess\./,
    );
    expect(body).toMatch(
      /throw new BadRequestError\('Bulk revoke is only callable from a dashboard web session\.'\);/,
    );
  });

  it('Bulk revoke service dispatch: revokeAllWebSessionsExceptCurrent(accountId, currentId); 200 reply { revoked: n }', () => {
    expect(body).toMatch(
      /const n = await service\.revokeAllWebSessionsExceptCurrent\(ctx\.account\.id, currentId\);/,
    );
    // Bulk revocation is audited too (only when something was actually revoked).
    expect(body).toMatch(/if \(n > 0\) \{\s*await emitRevoked\(/);
    expect(body).toMatch(/reply\.code\(200\);\s*return \{ revoked: n \};/);
  });

  it('GET list: requireAuth + broad read scope + rateLimit; service.listActiveWebSessions(accountId); { data: rows.map(publicSession) }', () => {
    expect(body).toMatch(
      /app\.get\(\s*'\/v1\/account\/web-sessions',\s*\{ preHandler: \[app\.requireAuth, app\.requireScope\('read'\), app\.rateLimit\('global'\)\] \},/,
    );
    expect(body).toMatch(
      /const rows = await service\.listActiveWebSessions\(ctx\.account\.id\);\s*return \{ data: rows\.map\(\(r\) => publicSession\(r, currentId\)\) \};/,
    );
  });

  it('imports: FastifyInstance/FastifyRequest + AuthFlowsService/WebSessionRow + BadRequestError/NotFoundError', () => {
    expect(body).toMatch(/import type \{ FastifyInstance, FastifyRequest \} from 'fastify';/);
    expect(body).toMatch(
      /import type \{ AuthFlowsService, WebSessionRow \} from '\.\.\/services\/auth-flows\.js';/,
    );
    expect(body).toMatch(
      /import \{ BadRequestError, NotFoundError, ValidationError \} from '\.\.\/lib\/errors\.js';/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
