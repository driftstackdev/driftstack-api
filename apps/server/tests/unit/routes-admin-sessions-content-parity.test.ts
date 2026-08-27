// W415.A — drift guard for apps/server/src/routes/admin-sessions.ts.
// Admin cross-account session list. Read-only, no audit row. Mutating
// session actions split into admin-force-actions.ts. Drift here either
// drops the scope-gate (cross-tenant leak) or breaks the status enum
// (admin GUI status filter chip stops working).
//
//   • Framing pinned: GET /v1/admin/sessions read-only no-audit;
//     mutating actions in admin-force-actions.ts at POST
//     /v1/admin/sessions/:id/destroy.
//   • PUBLIC_ID_RE: ^[a-z]{3}_(uuid)$.
//   • uuidFromPrefixedId helper enforces expectedPrefix match.
//   • Query schema: limit coerce int 1..100 default 50 + cursor +
//     status enum (creating|ready|busy|destroyed|errored) +
//     account_id optional.
//   • publicSession: id=ses_, account_id=acc_, api_key_id=key_,
//     archetype + purpose + label + metadata, ISO timestamps
//     (created_at + updated_at + last_state_at nullable +
//     destroyed_at nullable).
//   • Scope-gate: driftstack_internal_admin + global rate-limit.
//   • Service dispatch: sessionsService.listAll with spread-conditional
//     cursor + status + accountId args.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/routes/admin-sessions.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W415.A apps/server/src/routes/admin-sessions.ts content parity', () => {
  const body = read(LIB);

  it('Framing pinned: GET /v1/admin/sessions read-only no-audit + destroy at POST /v1/admin/sessions/:id/destroy in admin-force-actions', () => {
    expect(body).toMatch(
      /Admin-only cross-account session list — GET \/v1\/admin\/sessions\.\s*\/\/\s*Read-only; no audit row written for the read itself\. Mutating\s*\/\/\s*admin actions on sessions live in admin-force-actions\.ts\s*\/\/\s*\(POST \/v1\/admin\/sessions\/:id\/destroy\)\./,
    );
  });

  it('PUBLIC_ID_RE: ^[a-z]{3}_(uuid)$ + uuidFromPrefixedId with BadRequestError hint', () => {
    expect(body).toMatch(
      /const PUBLIC_ID_RE = \/\^\[a-z\]\{3\}_\(\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{12\}\)\$\/;/,
    );
    expect(body).toMatch(
      /function uuidFromPrefixedId\(value: string, expectedPrefix: string\): string \{\s*const match = PUBLIC_ID_RE\.exec\(value\);\s*if \(!match \|\| !match\[1\] \|\| !value\.startsWith\(`\$\{expectedPrefix\}_`\)\) \{\s*throw new BadRequestError\(`Invalid id format\. Expected "\$\{expectedPrefix\}_<uuid>"\.`\);/,
    );
  });

  it('ListAdminSessionsQuerySchema: limit coerce 1..100 default 50 + cursor (string 1-512) + status enum (creating|ready|busy|destroyed|errored) + account_id (string 1-100) (Slice 146 defensive caps).', () => {
    expect(body).toMatch(
      /const ListAdminSessionsQuerySchema = z\.object\(\{\s*limit: z\.coerce\.number\(\)\.int\(\)\.min\(1\)\.max\(100\)\.default\(50\),[\s\S]*?cursor: z\.string\(\)\.min\(1\)\.max\(512\)\.optional\(\),\s*status: z\.enum\(\['creating', 'ready', 'busy', 'destroyed', 'errored'\]\)\.optional\(\),/,
    );
    expect(body).toMatch(
      /\/\*\* Optional account scoping \(`acc_<uuid>` or raw uuid\)\. \*\/\s*account_id: z\.string\(\)\.min\(1\)\.max\(100\)\.optional\(\),/,
    );
  });

  it('publicSession: id=ses_ + account_id=acc_ + api_key_id=key_ + archetype/purpose/label/metadata + ISO timestamps (last_state_at/destroyed_at nullable)', () => {
    expect(body).toMatch(/function publicSession\(s: SessionRecord\): Record<string, unknown> \{/);
    expect(body).toMatch(/id: `ses_\$\{s\.id\}`,/);
    expect(body).toMatch(/account_id: `acc_\$\{s\.accountId\}`,/);
    expect(body).toMatch(/api_key_id: `key_\$\{s\.apiKeyId\}`,/);
    expect(body).toMatch(/status: s\.status,/);
    expect(body).toMatch(/archetype: s\.archetype,/);
    expect(body).toMatch(/purpose: s\.purpose,/);
    expect(body).toMatch(/label: s\.label,/);
    expect(body).toMatch(/metadata: s\.metadata,/);
    expect(body).toMatch(/created_at: s\.createdAt\.toISOString\(\),/);
    expect(body).toMatch(/updated_at: s\.updatedAt\.toISOString\(\),/);
    expect(body).toMatch(
      /last_state_at: s\.lastStateAt \? s\.lastStateAt\.toISOString\(\) : null,/,
    );
    expect(body).toMatch(/destroyed_at: s\.destroyedAt \? s\.destroyedAt\.toISOString\(\) : null,/);
  });

  it("Scope-gate: requireScope('driftstack_internal_admin') + rateLimit('global')", () => {
    expect(body).toMatch(
      /preHandler: \[app\.requireScope\('driftstack_internal_admin'\), app\.rateLimit\('global'\)\],/,
    );
  });

  it('account_id resolution: 36-char raw uuid pass-through OR uuidFromPrefixedId(value, "acc")', () => {
    expect(body).toMatch(
      /const accountUuid =\s*parsed\.data\.account_id !== undefined\s*\? BARE_UUID_RE\.test\(parsed\.data\.account_id\)\s*\? parsed\.data\.account_id\s*: uuidFromPrefixedId\(parsed\.data\.account_id, 'acc'\)\s*: undefined;/,
    );
  });

  it('Service dispatch: sessionsService.listAll with spread-conditional cursor + status + accountId args', () => {
    expect(body).toMatch(
      /const page = await sessionsService\.listAll\(ctx, \{\s*limit: parsed\.data\.limit,\s*\.\.\.\(parsed\.data\.cursor !== undefined \? \{ cursor: parsed\.data\.cursor \} : \{\}\),\s*\.\.\.\(parsed\.data\.status !== undefined \? \{ status: parsed\.data\.status \} : \{\}\),\s*\.\.\.\(accountUuid !== undefined \? \{ accountId: accountUuid \} : \{\}\),\s*\}\);/,
    );
  });

  it('Reply shape: { data: page.items.map(publicSession), next_cursor: page.nextCursor }', () => {
    expect(body).toMatch(
      /return \{\s*data: page\.items\.map\(publicSession\),\s*next_cursor: page\.nextCursor,\s*\};/,
    );
  });

  it('GET /v1/admin/sessions/stats: scope-gated read-only; dispatches sessionsService.statsForAdmin(ctx); reply { by_status, active, total }', () => {
    expect(body).toMatch(/'\/v1\/admin\/sessions\/stats',/);
    expect(body).toMatch(/const stats = await sessionsService\.statsForAdmin\(ctx\);/);
    expect(body).toMatch(
      /return \{\s*by_status: stats\.by_status,\s*active: stats\.active,\s*total: stats\.total,\s*\};/,
    );
  });

  it('BadRequestError on safeParse fail with "Invalid query parameters."', () => {
    expect(body).toMatch(
      /if \(!parsed\.success\) throw new BadRequestError\('Invalid query parameters\.'\);/,
    );
  });

  it('imports: FastifyInstance + zod + SessionRecord/SessionsService + BadRequestError', () => {
    expect(body).toMatch(/import type \{ FastifyInstance \} from 'fastify';/);
    expect(body).toMatch(/import \{ z \} from 'zod';/);
    expect(body).toMatch(
      /import type \{ SessionRecord, SessionsService \} from '\.\.\/services\/sessions\.js';/,
    );
    expect(body).toMatch(/import \{ BadRequestError \} from '\.\.\/lib\/errors\.js';/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
