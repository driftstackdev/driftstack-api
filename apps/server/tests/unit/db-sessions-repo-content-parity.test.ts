// W447.A — drift guard for apps/server/src/db/sessions-repo.ts.
// Drizzle SessionRepo. Drift here either drops the
// findSessionUnscoped variant (admin force-destroy can't reach
// foreign-account sessions without explicit cross-account lookup)
// or weakens countActiveSessions (concurrent-cap enforcement)
// by dropping the isNull(destroyedAt) clause.
//
//   • In-memory impl in tests/integration/_helpers/ rationale.
//   • insertSession: 7-field values; returning(); throws on no-row.
//   • findSession: account-scoped via and(eq(id), eq(accountId)).
//   • findSessionUnscoped: id-only lookup (admin force-actions
//     path).
//   • updateSessionStatus: always-bump updatedAt; optional
//     lastStateAt + destroyedAt selectively spread.
//   • countActiveSessions: count(*) where accountId + isNull
//     (destroyedAt) — concurrent-cap source of truth.
//   • listSessions: cursor format = ISO timestamp of last seen
//     createdAt; descending order; limit+1 hasMore + nextCursor.
//   • recordEvent: 4-field append-only insert into sessionEvents.
//   • listAllSessions: admin variant with status + accountId
//     filters.
//   • toSessionRecord: 14-field SessionRecord incl. metadata
//     null-coalesce + egressCapabilities null-coalesce (migration
//     0045, cross-agent contract 7d5992d9).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/db/sessions-repo.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W447.A apps/server/src/db/sessions-repo.ts content parity', () => {
  const body = read(LIB);

  it("header framing pinned: 'Drizzle-backed implementation of SessionRepo. The shape mirrors SessionsService expectations exactly; tests use an in-memory impl from `tests/integration/_helpers/in-memory-sessions-repo.ts`.'", () => {
    expect(body).toMatch(
      /\/\/ Drizzle-backed implementation of SessionRepo\. The shape mirrors\s*\n?\s*\/\/ SessionsService expectations exactly; tests use an in-memory impl from\s*\n?\s*\/\/ `tests\/integration\/_helpers\/in-memory-sessions-repo\.ts`\./,
    );
  });

  it('imports: and/desc/eq/isNull/lt/sql from drizzle-orm; 5 service types; Database; sessionEvents + sessions schemas', () => {
    expect(body).toMatch(/import \{ and, desc, eq, isNull, lt, sql \} from 'drizzle-orm';/);
    expect(body).toMatch(
      /import type \{\s*\n?\s*NewSessionInput,\s*\n?\s*SessionEventInput,\s*\n?\s*SessionListPage,\s*\n?\s*SessionRecord,\s*\n?\s*SessionRepo,\s*\n?\s*\} from '\.\.\/services\/sessions\.js';/,
    );
    expect(body).toMatch(/import \{ sessionEvents, sessions \} from '\.\/schema\.js';/);
  });

  it("insertSession: 7-field values (accountId + apiKeyId + driverSessionId + archetype + purpose + label + metadata); returning(); throws 'insertSession returned no row'", () => {
    expect(body).toMatch(
      /\.values\(\{\s*\n?\s*accountId: input\.accountId,\s*\n?\s*apiKeyId: input\.apiKeyId,\s*\n?\s*driverSessionId: input\.driverSessionId,\s*\n?\s*archetype: input\.archetype,\s*\n?\s*purpose: input\.purpose,\s*\n?\s*label: input\.label,\s*\n?\s*metadata: input\.metadata,\s*\n?\s*\}\)\s*\n?\s*\.returning\(\);\s*\n?\s*if \(!row\) throw new Error\('insertSession returned no row'\);/,
    );
  });

  it('findSession: account-scoped via and(eq(id), eq(accountId)) + limit 1; findSessionUnscoped: id-only no account scope (admin force-actions path)', () => {
    expect(body).toMatch(
      /async findSession\(id: string, accountId: string\): Promise<SessionRecord \| null> \{\s*\n?\s*const \[row\] = await this\.database\.db\s*\n?\s*\.select\(\)\s*\n?\s*\.from\(sessions\)\s*\n?\s*\.where\(and\(eq\(sessions\.id, id\), eq\(sessions\.accountId, accountId\)\)\)\s*\n?\s*\.limit\(1\);\s*\n?\s*return row \? toSessionRecord\(row\) : null;\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /async findSessionUnscoped\(id: string\): Promise<SessionRecord \| null> \{\s*\n?\s*const \[row\] = await this\.database\.db\s*\n?\s*\.select\(\)\s*\n?\s*\.from\(sessions\)\s*\n?\s*\.where\(eq\(sessions\.id, id\)\)\s*\n?\s*\.limit\(1\);\s*\n?\s*return row \? toSessionRecord\(row\) : null;\s*\n?\s*\}/,
    );
  });

  it('updateSessionStatus: always-bump updatedAt:new Date(); selective spread of lastStateAt + destroyedAt when present', () => {
    expect(body).toMatch(
      /\.set\(\{\s*\n?\s*status,\s*\n?\s*updatedAt: new Date\(\),\s*\n?\s*\.\.\.\(extra\?\.lastStateAt \? \{ lastStateAt: extra\.lastStateAt \} : \{\}\),\s*\n?\s*\.\.\.\(extra\?\.destroyedAt \? \{ destroyedAt: extra\.destroyedAt \} : \{\}\),\s*\n?\s*\}\)/,
    );
  });

  it('countActiveSessions: count(*)::int where and(accountId, isNull(destroyedAt)) — concurrent-cap source of truth', () => {
    expect(body).toMatch(
      /async countActiveSessions\(accountId: string\): Promise<number> \{\s*\n?\s*const \[row\] = await this\.database\.db\s*\n?\s*\.select\(\{ count: sql<number>`count\(\*\)::int` \}\)\s*\n?\s*\.from\(sessions\)\s*\n?\s*\.where\(and\(eq\(sessions\.accountId, accountId\), isNull\(sessions\.destroyedAt\)\)\);\s*\n?\s*return row\?\.count \?\? 0;\s*\n?\s*\}/,
    );
  });

  it("listSessions framing pinned: 'Cursor format: ISO timestamp of the last seen createdAt (descending order).' + cursor parsed via new Date() + where account-scoped + lt(createdAt, cursor)", () => {
    expect(body).toMatch(
      /\/\/ Cursor format: ISO timestamp of the last seen createdAt \(descending order\)\./,
    );
    expect(body).toMatch(
      /const cursorDate = opts\.cursor \? new Date\(opts\.cursor\) : null;\s*\n?\s*const where = cursorDate\s*\n?\s*\? and\(eq\(sessions\.accountId, accountId\), lt\(sessions\.createdAt, cursorDate\)\)\s*\n?\s*: eq\(sessions\.accountId, accountId\);/,
    );
    expect(body).toMatch(
      /\.orderBy\(desc\(sessions\.createdAt\)\)\s*\n?\s*\.limit\(opts\.limit \+ 1\);\s*\n?\s*const hasMore = rows\.length > opts\.limit;\s*\n?\s*const items = hasMore \? rows\.slice\(0, opts\.limit\) : rows;\s*\n?\s*const last = items\[items\.length - 1\];\s*\n?\s*return \{\s*\n?\s*items: items\.map\(toSessionRecord\),\s*\n?\s*nextCursor: hasMore && last \? last\.createdAt\.toISOString\(\) : null,\s*\n?\s*\};/,
    );
  });

  it('recordEvent: append-only insert into sessionEvents with 4-field values (sessionId + type + payload + durationMs)', () => {
    expect(body).toMatch(
      /async recordEvent\(input: SessionEventInput\): Promise<void> \{\s*\n?\s*await this\.database\.db\.insert\(sessionEvents\)\.values\(\{\s*\n?\s*sessionId: input\.sessionId,\s*\n?\s*type: input\.type,\s*\n?\s*payload: input\.payload,\s*\n?\s*durationMs: input\.durationMs,\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
  });

  it('listAllSessions admin variant: status + accountId filters; cursor lt(createdAt); whereClause undefined when no filters; same nextCursor=last.createdAt.toISOString() convention', () => {
    expect(body).toMatch(
      /async listAllSessions\(opts: \{\s*\n?\s*limit: number;\s*\n?\s*cursor\?: string;\s*\n?\s*status\?: SessionRecord\['status'\];\s*\n?\s*accountId\?: string;\s*\n?\s*\}\): Promise<SessionListPage> \{\s*\n?\s*const cursorDate = opts\.cursor \? new Date\(opts\.cursor\) : null;\s*\n?\s*const filters = \[\];\s*\n?\s*if \(cursorDate\) filters\.push\(lt\(sessions\.createdAt, cursorDate\)\);\s*\n?\s*if \(opts\.status\) filters\.push\(eq\(sessions\.status, opts\.status\)\);\s*\n?\s*if \(opts\.accountId\) filters\.push\(eq\(sessions\.accountId, opts\.accountId\)\);\s*\n?\s*const whereClause = filters\.length === 0 \? undefined : and\(\.\.\.filters\);/,
    );
  });

  it('toSessionRecord: 14-field SessionRecord (id + accountId + apiKeyId + driverSessionId + status + archetype + purpose + label + metadata null-coalesce + egressCapabilities null-coalesce (migration 0045) + 4 timestamps incl. destroyedAt)', () => {
    expect(body).toMatch(
      /function toSessionRecord\(r: typeof sessions\.\$inferSelect\): SessionRecord \{\s*\n?\s*return \{\s*\n?\s*id: r\.id,\s*\n?\s*accountId: r\.accountId,\s*\n?\s*apiKeyId: r\.apiKeyId,\s*\n?\s*driverSessionId: r\.driverSessionId,\s*\n?\s*status: r\.status,\s*\n?\s*archetype: r\.archetype,\s*\n?\s*purpose: r\.purpose,\s*\n?\s*label: r\.label,\s*\n?\s*metadata: r\.metadata \?\? null,\s*\n?\s*egressCapabilities: r\.egressCapabilities \?\? null,\s*\n?\s*createdAt: r\.createdAt,\s*\n?\s*updatedAt: r\.updatedAt,\s*\n?\s*lastStateAt: r\.lastStateAt,\s*\n?\s*destroyedAt: r\.destroyedAt,\s*\n?\s*\};\s*\n?\s*\}/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
