// W416.C — drift guard for apps/server/src/routes/admin-status-subscribers.ts.
// V-295c3-tombstone admin endpoints for status-page email subscribers.
// force-unsubscribe writes admin_audit_log via the V-281 dual-write
// pattern (success + error path both audit). Drift here either drops
// the dual-write (silent admin actions) or breaks the sub_ public-id
// prefix.
//
//   • V-295c3-tombstone framing pinned: GET list + POST
//     force-unsubscribe; gated by driftstack_internal_admin scope.
//   • V-281 dual-write pattern: success → audit success; error →
//     audit `error: <code>` + rethrow (no silent swallow).
//   • 90d email-purge cron is wired in bootstrap (daily setInterval);
//     NOT exposed as HTTP endpoint.
//   • PUBLIC_ID_RE: ^sub_(uuid)$ (single-prefix, not the shared
//     ^[a-z]{3}_).
//   • uuidFromPrefixedId throws ValidationError (not BadRequestError)
//     with formErrors framing.
//   • ListQuerySchema: limit coerce int 1..200 optional + offset
//     coerce int min(0) optional.
//   • publicSubscriber: id=sub_<uuid> + email + confirmed_at/
//     unsubscribed_at nullable ISO + created_at ISO.
//   • Error audit: lowercase err.name with /error$/ strip → code.
//   • Reply: 200 { message:'Subscriber force-unsubscribed.', email }.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/routes/admin-status-subscribers.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W416.C apps/server/src/routes/admin-status-subscribers.ts content parity', () => {
  const body = read(LIB);

  it('V-295c3-tombstone framing pinned: GET list + POST force-unsubscribe; V-281 dual-write pattern audit', () => {
    expect(body).toMatch(/V-295c3-tombstone — admin endpoints for status-page email subscribers\./);
    expect(body).toMatch(/GET\s+\/v1\/admin\/status-subscribers\s+— paginated list/);
    expect(body).toMatch(/POST \/v1\/admin\/status-subscribers\/:id\/force-unsubscribe/);
    expect(body).toMatch(
      /Both gated by driftstack_internal_admin scope\. force-unsubscribe\s*\/\/\s*writes admin_audit_log via the V-281 dual-write pattern\./,
    );
  });

  it('90d purge cron framing pinned: wired in bootstrap as daily setInterval, NOT exposed as HTTP endpoint', () => {
    expect(body).toMatch(
      /The 90d email-purge cron is wired separately \(in bootstrap as a daily\s*\/\/\s*setInterval\); it is not exposed as an HTTP endpoint\./,
    );
  });

  it('ListQuerySchema: limit coerce 1..200 optional + offset coerce min(0) optional', () => {
    expect(body).toMatch(
      /const ListQuerySchema = z\.object\(\{\s*limit: z\.coerce\.number\(\)\.int\(\)\.min\(1\)\.max\(200\)\.optional\(\),\s*offset: z\.coerce\.number\(\)\.int\(\)\.min\(0\)\.optional\(\),\s*\}\);/,
    );
  });

  it('PUBLIC_ID_RE: ^sub_(uuid)$ single-prefix anchored (not shared ^[a-z]{3}_)', () => {
    expect(body).toMatch(
      /const PUBLIC_ID_RE = \/\^sub_\(\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{12\}\)\$\/;/,
    );
  });

  it('uuidFromPrefixedId: throws ValidationError (NOT BadRequestError) with formErrors framing on bad id', () => {
    expect(body).toMatch(
      /function uuidFromPrefixedId\(value: string\): string \{\s*const match = PUBLIC_ID_RE\.exec\(value\);\s*if \(!match \|\| !match\[1\]\) \{\s*throw new ValidationError\(\{\s*formErrors: \['Invalid id format\. Expected "sub_<uuid>"\.'\],\s*fieldErrors: \{\},\s*\}\);/,
    );
  });

  it('readClientIp imported from shared lib/client-ip.ts (extracted to collapse drift across admin-* routes)', () => {
    expect(body).toMatch(/import \{ readClientIp \} from '\.\.\/lib\/client-ip\.js';/);
    expect(body).toMatch(/ipAddress: readClientIp\(request\),/);
  });

  it('AdminStatusSubscribersRoutesOptions: service (StatusSubscribersService) + audit (AdminAuditService)', () => {
    expect(body).toMatch(
      /export interface AdminStatusSubscribersRoutesOptions \{\s*service: StatusSubscribersService;\s*audit: AdminAuditService;\s*\}/,
    );
  });

  it('GET list: scope-only preHandler (no rate-limit); ValidationError on safeParse fail; reply { data: [{id=sub_, email, confirmed_at/unsubscribed_at nullable ISO, created_at ISO}] }', () => {
    expect(body).toMatch(
      /app\.get\(\s*'\/v1\/admin\/status-subscribers',\s*\{ preHandler: \[app\.requireScope\('driftstack_internal_admin'\)\] \},/,
    );
    expect(body).toMatch(
      /if \(!parsed\.success\) throw new ValidationError\(parsed\.error\.flatten\(\)\);/,
    );
    expect(body).toMatch(
      /const rows = await service\.listAll\(\{\s*\.\.\.\(parsed\.data\.limit !== undefined \? \{ limit: parsed\.data\.limit \} : \{\}\),\s*\.\.\.\(parsed\.data\.offset !== undefined \? \{ offset: parsed\.data\.offset \} : \{\}\),\s*\}\);/,
    );
    expect(body).toMatch(/id: `sub_\$\{row\.id\}`,/);
    expect(body).toMatch(/email: row\.email,/);
    expect(body).toMatch(
      /confirmed_at: row\.confirmedAt \? row\.confirmedAt\.toISOString\(\) : null,/,
    );
    expect(body).toMatch(
      /unsubscribed_at: row\.unsubscribedAt \? row\.unsubscribedAt\.toISOString\(\) : null,/,
    );
    expect(body).toMatch(/created_at: row\.createdAt\.toISOString\(\),/);
  });

  it("POST force-unsubscribe: scope + rateLimit('global'); typed Params id; uuidFromPrefixedId(request.params.id)", () => {
    expect(body).toMatch(
      /app\.post<\{ Params: \{ id: string \} \}>\(\s*'\/v1\/admin\/status-subscribers\/:id\/force-unsubscribe',\s*\{\s*preHandler: \[app\.requireScope\('driftstack_internal_admin'\), app\.rateLimit\('global'\)\],\s*\},/,
    );
    expect(body).toMatch(/const id = uuidFromPrefixedId\(request\.params\.id\);/);
  });

  it("V-281 dual-write success path: service.forceUnsubscribe → audit.record action='status_subscriber.force_unsubscribed' result='success' (ipAddress sourced from shared readClientIp helper)", () => {
    expect(body).toMatch(/result = await service\.forceUnsubscribe\(id, new Date\(\)\);/);
    expect(body).toMatch(
      /await audit\.record\(\{\s*adminAccountId: ctx\.account\.id,\s*adminKeyId: ctx\.apiKey\.id,\s*action: 'status_subscriber\.force_unsubscribed',\s*targetAccountId: null,\s*targetResourceId: `sub_\$\{id\}`,\s*inputPayload: \{ email: result\.email \},\s*result: 'success',\s*ipAddress: readClientIp\(request\),\s*\}\);/,
    );
  });

  it('V-281 dual-write error path: catch → lowercase err.name with /error$/ strip → audit error code + rethrow (no silent swallow)', () => {
    expect(body).toMatch(
      /const code =\s*err instanceof Error && err\.name\s*\? err\.name\.toLowerCase\(\)\.replace\(\/error\$\/, ''\)\s*: 'unknown';/,
    );
    expect(body).toMatch(
      /await audit\.record\(\{\s*adminAccountId: ctx\.account\.id,\s*adminKeyId: ctx\.apiKey\.id,\s*action: 'status_subscriber\.force_unsubscribed',\s*targetAccountId: null,\s*targetResourceId: `sub_\$\{id\}`,\s*inputPayload: \{\},\s*result: `error: \$\{code\}`,/,
    );
    expect(body).toMatch(/throw err;/);
  });

  it("Reply: 200 { message: 'Subscriber force-unsubscribed.', email: result.email }", () => {
    expect(body).toMatch(
      /return reply\.code\(200\)\.send\(\{\s*message: 'Subscriber force-unsubscribed\.',\s*email: result\.email,\s*\}\);/,
    );
  });

  it('imports: FastifyInstance + zod + AdminAuditService + StatusSubscribersService + ValidationError + shared readClientIp', () => {
    expect(body).toMatch(/import type \{ FastifyInstance \} from 'fastify';/);
    expect(body).toMatch(/import \{ readClientIp \} from '\.\.\/lib\/client-ip\.js';/);
    expect(body).toMatch(/import \{ z \} from 'zod';/);
    expect(body).toMatch(
      /import type \{ AdminAuditService \} from '\.\.\/services\/admin-audit\.js';/,
    );
    expect(body).toMatch(
      /import type \{ StatusSubscribersService \} from '\.\.\/services\/status-subscribers\.js';/,
    );
    expect(body).toMatch(/import \{ ValidationError \} from '\.\.\/lib\/errors\.js';/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
