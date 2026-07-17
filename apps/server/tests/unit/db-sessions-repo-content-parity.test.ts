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
//   • destroySessionSerialized: row lock + bounded driver callback
//     + atomic terminal/event commit with driver-error slot release.
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

  it('imports: Drizzle primitives; SessionStatusSchema + AccountTier; ProfileInUseError; closed event projector; service/Database types; both session schemas; canonical profile lock helper', () => {
    // Reflow-robust: prettier wraps this multi-member import across lines, so
    // match the members with \s* separators rather than a single-line literal.
    expect(body).toMatch(
      /import \{\s*type SQL,\s*and,\s*asc,\s*desc,\s*eq,\s*inArray,\s*isNull,\s*lt,\s*notInArray,\s*or,\s*sql,?\s*\} from 'drizzle-orm';/,
    );
    // 6.g — AccountTier for listExpiredForAutoDestroy tierCutoffs; SessionStatusSchema
    // for the countAllByStatus zero-fill.
    expect(body).toMatch(
      /import \{ SessionStatusSchema, type AccountTier \} from '@driftstack\/api-types';/,
    );
    // A3 finding #7 (W2979/W2980) — ProfileInUseError thrown by the single-active-
    // session-per-profile guard inside insertSessionIfUnderLimit.
    expect(body).toMatch(/import \{ ProfileInUseError \} from '\.\.\/lib\/errors\.js';/);
    expect(body).toMatch(
      /import \{ projectSessionEventMetadata \} from '\.\.\/lib\/session-event-metadata\.js';/,
    );
    expect(body).toMatch(
      /import type \{\s*\n?\s*NewSessionInput,\s*\n?\s*SessionEventInput,\s*\n?\s*SessionListPage,\s*\n?\s*SessionRecord,\s*\n?\s*SessionRepo,\s*\n?\s*SerializedSessionDestroyInput,\s*\n?\s*SerializedSessionDestroyResult,\s*\n?\s*\} from '\.\.\/services\/sessions\.js';/,
    );
    // 6.g — accounts joined in for the duration-sweep tier resolution. The agent
    // table participates in the global single-profile launch guard.
    expect(body).toMatch(
      /import \{ accounts, agentSessions, sessionEvents, sessions \} from '\.\/schema\.js';/,
    );
    expect(body).toMatch(
      /import \{ profileSessionAdvisoryLockKey \} from '\.\/profile-session-lock\.js';/,
    );
  });

  it("insertSession: 7-field values (accountId + apiKeyId + driverSessionId + archetype + purpose + label + metadata); returning(); throws 'insertSession returned no row'", () => {
    expect(body).toMatch(
      /\.values\(\{\s*\n?\s*accountId: input\.accountId,\s*\n?\s*apiKeyId: input\.apiKeyId,\s*\n?\s*driverSessionId: input\.driverSessionId,\s*\n?\s*archetype: input\.archetype,\s*\n?\s*purpose: input\.purpose,\s*\n?\s*label: input\.label,\s*\n?\s*metadata: input\.metadata,\s*\n?\s*\}\)\s*\n?\s*\.returning\(\);\s*\n?\s*if \(!row\) throw new Error\('insertSession returned no row'\);/,
    );
  });

  it('insertSessionIfUnderLimit: atomic count+insert in a transaction, serialised by a per-account pg_advisory_xact_lock; returns null when count >= limit (the concurrent-cap TOCTOU fix). Drift to dropping the advisory lock or the tx reopens the create-path race.', () => {
    expect(body).toMatch(
      /async insertSessionIfUnderLimit\(\s*\n?\s*input: NewSessionInput,\s*\n?\s*limit: number,\s*\n?\s*opts: \{ profileId\?: string \} = \{\},\s*\n?\s*\): Promise<SessionRecord \| null> \{/,
    );
    expect(body).toMatch(/return this\.database\.db\.transaction\(async \(tx\) => \{/);
    expect(body).toMatch(
      /SELECT pg_advisory_xact_lock\(hashtext\(\$\{`session-create:\$\{input\.accountId\}`\}\)\)/,
    );
    // count under the SAME tx, then conditional insert / null.
    expect(body).toMatch(
      /\.where\(and\(eq\(sessions\.accountId, input\.accountId\), isNull\(sessions\.destroyedAt\)\)\);\s*\n?\s*if \(\(countRow\?\.count \?\? 0\) >= limit\) return null;/,
    );
  });

  it('A3 finding #7 (W2979/W2980) — global single-profile guard uses the canonical lock and checks both legacy + agent live tables before insert, returning the competing public id', () => {
    expect(body).toMatch(
      /SELECT pg_advisory_xact_lock\(hashtext\(\$\{profileSessionAdvisoryLockKey\(opts\.profileId\)\}\)\)/,
    );
    expect(body).toMatch(/\$\{sessions\.metadata\}->>'profile_id' = \$\{opts\.profileId\}/);
    expect(body).toMatch(/notInArray\(sessions\.status, \['destroyed', 'errored'\]\)/);
    expect(body).toMatch(/throw new ProfileInUseError\(`ses_\$\{liveLegacy\.id\}`\)/);
    expect(body).toMatch(/\.from\(agentSessions\)/);
    expect(body).toMatch(/eq\(agentSessions\.profileId, opts\.profileId\)/);
    expect(body).toMatch(/notInArray\(agentSessions\.status, \['closed'\]\)/);
    expect(body).toMatch(/throw new ProfileInUseError\(liveAgent\.id\)/);
    expect(body).not.toMatch(/session-create-profile:/);
  });

  it('findSession: account-scoped via and(eq(id), eq(accountId)) + limit 1; findSessionUnscoped: id-only no account scope (admin force-actions path)', () => {
    expect(body).toMatch(
      /async findSession\(id: string, accountId: string\): Promise<SessionRecord \| null> \{\s*\n?\s*const \[row\] = await this\.database\.db\s*\n?\s*\.select\(\)\s*\n?\s*\.from\(sessions\)\s*\n?\s*\.where\(and\(eq\(sessions\.id, id\), eq\(sessions\.accountId, accountId\)\)\)\s*\n?\s*\.limit\(1\);\s*\n?\s*return row \? toSessionRecord\(row\) : null;\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /async findSessionUnscoped\(id: string\): Promise<SessionRecord \| null> \{\s*\n?\s*const \[row\] = await this\.database\.db\s*\n?\s*\.select\(\)\s*\n?\s*\.from\(sessions\)\s*\n?\s*\.where\(eq\(sessions\.id, id\)\)\s*\n?\s*\.limit\(1\);\s*\n?\s*return row \? toSessionRecord\(row\) : null;\s*\n?\s*\}/,
    );
  });

  it('destroySessionSerialized: projects before transaction/driver; scoped SELECT FOR UPDATE elects one terminal callback winner; success update + projected event share the transaction', () => {
    expect(body).toMatch(
      /async destroySessionSerialized\(\s*\n?\s*input: SerializedSessionDestroyInput,\s*\n?\s*destroyDriverSession: \(session: SessionRecord\) => Promise<void>,\s*\n?\s*\): Promise<SerializedSessionDestroyResult> \{/,
    );
    const projectionIdx = body.indexOf('const event = projectSessionEventMetadata(input.event);');
    const transactionIdx = body.indexOf(
      'return this.database.db.transaction(async (tx) => {',
      projectionIdx,
    );
    expect(projectionIdx).toBeGreaterThan(0);
    expect(transactionIdx).toBeGreaterThan(projectionIdx);
    expect(body).toMatch(/return this\.database\.db\.transaction\(async \(tx\) => \{/);
    expect(body).toMatch(
      /input\.accountId === null \? undefined : eq\(sessions\.accountId, input\.accountId\)/,
    );
    expect(body).toMatch(
      /tx\.select\(\)\.from\(sessions\)\.where\(scope\)\.limit\(1\)\.for\('update'\)/,
    );
    expect(body).toMatch(
      /if \(current\.status === 'destroyed' \|\| current\.status === 'errored'\) \{\s*\n?\s*return \{ kind: 'already_terminal', session: current \};/,
    );
    expect(body).toMatch(/await destroyDriverSession\(current\);/);
    expect(body).toMatch(
      /\.set\(\{ status: 'destroyed', destroyedAt: input\.destroyedAt, updatedAt: new Date\(\) \}\)/,
    );
    const driverFailureIdx = body.indexOf("if (driverFailed) return { kind: 'driver_error'");
    const eventInsertIdx = body.indexOf('await tx.insert(sessionEvents).values({');
    expect(driverFailureIdx).toBeGreaterThan(0);
    expect(eventInsertIdx).toBeGreaterThan(driverFailureIdx);
    expect(body.slice(eventInsertIdx, eventInsertIdx + 260)).toMatch(
      /type: event\.type,\s*payload: event\.payload,\s*durationMs: event\.durationMs/,
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

  it('countAllByStatus: count(*)::int groupBy status; zero-fill from SessionStatusSchema.options', () => {
    expect(body).toMatch(
      /async countAllByStatus\(\): Promise<Record<SessionRecord\['status'\], number>> \{/,
    );
    expect(body).toMatch(
      /\.select\(\{ status: sessions\.status, count: sql<number>`count\(\*\)::int` \}\)/,
    );
    expect(body).toMatch(/\.groupBy\(sessions\.status\);/);
    expect(body).toMatch(/const out = emptySessionStatusCounts\(\);/);
    expect(body).toMatch(/for \(const row of rows\) out\[row\.status\] = row\.count;/);
    expect(body).toMatch(
      /function emptySessionStatusCounts\(\): Record<SessionRecord\['status'\], number> \{\s*\n?\s*const out = \{\} as Record<SessionRecord\['status'\], number>;\s*\n?\s*for \(const status of SessionStatusSchema\.options\) out\[status\] = 0;\s*\n?\s*return out;\s*\n?\s*\}/,
    );
  });

  it('listSessions: keyset cursor (createdAt desc, id desc) — account-scoped conds; cursor row looked up by (id, accountId); nextCursor = last.id', () => {
    expect(body).toMatch(/const conds: SQL\[\] = \[eq\(sessions\.accountId, accountId\)\];/);
    expect(body).toMatch(/lt\(sessions\.createdAt, c\.createdAt\),/);
    expect(body).toMatch(
      /and\(eq\(sessions\.createdAt, c\.createdAt\), lt\(sessions\.id, c\.id\)\),/,
    );
    expect(body).toMatch(/\.orderBy\(desc\(sessions\.createdAt\), desc\(sessions\.id\)\)/);
    expect(body).toMatch(/nextCursor: hasMore && last \? last\.id : null,/);
  });

  it('recordEvent: projects before append-only insert into sessionEvents', () => {
    expect(body).toMatch(
      /async recordEvent\(input: SessionEventInput\): Promise<void> \{\s*const event = projectSessionEventMetadata\(input\);\s*await this\.database\.db\.insert\(sessionEvents\)\.values\(\{\s*sessionId: input\.sessionId,\s*type: event\.type,\s*payload: event\.payload,\s*durationMs: event\.durationMs,\s*\}\);\s*\}/,
    );
  });

  it('listAllSessions admin variant: keyset cursor (createdAt,id) + status + accountId filters; whereClause undefined when no filters; nextCursor = last.id', () => {
    expect(body).toMatch(/async listAllSessions\(opts: \{/);
    expect(body).toMatch(
      /if \(opts\.status\) filters\.push\(eq\(sessions\.status, opts\.status\)\);/,
    );
    expect(body).toMatch(
      /if \(opts\.accountId\) filters\.push\(eq\(sessions\.accountId, opts\.accountId\)\);/,
    );
    expect(body).toMatch(
      /const whereClause = filters\.length === 0 \? undefined : and\(\.\.\.filters\);/,
    );
  });

  it('toSessionRecord: 15-field SessionRecord (id + accountId + apiKeyId + driverSessionId + status + archetype + purpose + label + metadata null-coalesce + egressCapabilities null-coalesce (migration 0045) + egressCapabilityReport null-coalesce (Arc 5 EGRESS report) + 4 timestamps incl. destroyedAt)', () => {
    expect(body).toMatch(
      /function toSessionRecord\(r: typeof sessions\.\$inferSelect\): SessionRecord \{\s*\n?\s*return \{\s*\n?\s*id: r\.id,\s*\n?\s*accountId: r\.accountId,\s*\n?\s*apiKeyId: r\.apiKeyId,\s*\n?\s*driverSessionId: r\.driverSessionId,\s*\n?\s*status: r\.status,\s*\n?\s*archetype: r\.archetype,\s*\n?\s*purpose: r\.purpose,\s*\n?\s*label: r\.label,\s*\n?\s*metadata: r\.metadata \?\? null,\s*\n?\s*egressCapabilities: r\.egressCapabilities \?\? null,\s*\n?\s*egressCapabilityReport: r\.egressCapabilityReport \?\? null,\s*\n?\s*createdAt: r\.createdAt,\s*\n?\s*updatedAt: r\.updatedAt,\s*\n?\s*lastStateAt: r\.lastStateAt,\s*\n?\s*destroyedAt: r\.destroyedAt,\s*\n?\s*\};\s*\n?\s*\}/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
