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
      /\/\/ Drizzle-backed implementation of SessionRepo\. The shape mirrors\s*\/\/ SessionsService expectations exactly; tests use an in-memory impl from\s*\/\/ `tests\/integration\/_helpers\/in-memory-sessions-repo\.ts`\./,
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
      /import type \{\s*NewSessionInput,\s*SessionEventInput,\s*SessionListPage,\s*SessionRecord,\s*SessionRepo,\s*SerializedSessionDestroyInput,\s*SerializedSessionDestroyResult,\s*\} from '\.\.\/services\/sessions\.js';/,
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
      /\.values\(\{\s*accountId: input\.accountId,\s*apiKeyId: input\.apiKeyId,\s*driverSessionId: input\.driverSessionId,\s*archetype: input\.archetype,\s*purpose: input\.purpose,\s*label: input\.label,\s*metadata: input\.metadata,\s*\}\)\s*\.returning\(\);\s*if \(!row\) throw new Error\('insertSession returned no row'\);/,
    );
  });

  it('insertSessionIfUnderLimit: atomic count+insert in a transaction, serialised by a per-account pg_advisory_xact_lock; returns null when count >= limit (the concurrent-cap TOCTOU fix). Drift to dropping the advisory lock or the tx reopens the create-path race.', () => {
    expect(body).toMatch(
      /async insertSessionIfUnderLimit\(\s*input: NewSessionInput,\s*limit: number,\s*opts: \{ profileId\?: string \} = \{\},\s*\): Promise<SessionRecord \| null> \{/,
    );
    expect(body).toMatch(/return this\.database\.db\.transaction\(async \(tx\) => \{/);
    expect(body).toMatch(
      /SELECT pg_advisory_xact_lock\(hashtext\(\$\{`session-create:\$\{input\.accountId\}`\}\)\)/,
    );
    // count under the SAME tx, then conditional insert / null.
    expect(body).toMatch(
      /\.where\(and\(eq\(sessions\.accountId, input\.accountId\), isNull\(sessions\.destroyedAt\)\)\);\s*if \(\(countRow\?\.count \?\? 0\) >= limit\) return null;/,
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
      /async findSession\(id: string, accountId: string\): Promise<SessionRecord \| null> \{\s*const \[row\] = await this\.database\.db\s*\.select\(\)\s*\.from\(sessions\)\s*\.where\(and\(eq\(sessions\.id, id\), eq\(sessions\.accountId, accountId\)\)\)\s*\.limit\(1\);\s*return row \? toSessionRecord\(row\) : null;\s*\}/,
    );
    expect(body).toMatch(
      /async findSessionUnscoped\(id: string\): Promise<SessionRecord \| null> \{\s*const \[row\] = await this\.database\.db\s*\.select\(\)\s*\.from\(sessions\)\s*\.where\(eq\(sessions\.id, id\)\)\s*\.limit\(1\);\s*return row \? toSessionRecord\(row\) : null;\s*\}/,
    );
  });

  it('destroySessionSerialized: projects before transaction/driver; scoped SELECT FOR UPDATE elects one terminal callback winner; success update + projected event share the transaction', () => {
    expect(body).toMatch(
      /async destroySessionSerialized\(\s*input: SerializedSessionDestroyInput,\s*destroyDriverSession: \(session: SessionRecord\) => Promise<void>,\s*\): Promise<SerializedSessionDestroyResult> \{/,
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
      /if \(current\.status === 'destroyed' \|\| current\.status === 'errored'\) \{\s*return \{ kind: 'already_terminal', session: current \};/,
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
      /\.set\(\{\s*status,\s*updatedAt: new Date\(\),\s*\.\.\.\(extra\?\.lastStateAt \? \{ lastStateAt: extra\.lastStateAt \} : \{\}\),\s*\.\.\.\(extra\?\.destroyedAt \? \{ destroyedAt: extra\.destroyedAt \} : \{\}\),\s*\}\)/,
    );
  });

  it('countActiveSessions: count(*)::int where and(accountId, isNull(destroyedAt)) — concurrent-cap source of truth', () => {
    expect(body).toMatch(
      /async countActiveSessions\(accountId: string\): Promise<number> \{\s*const \[row\] = await this\.database\.db\s*\.select\(\{ count: sql<number>`count\(\*\)::int` \}\)\s*\.from\(sessions\)\s*\.where\(and\(eq\(sessions\.accountId, accountId\), isNull\(sessions\.destroyedAt\)\)\);\s*return row\?\.count \?\? 0;\s*\}/,
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
      /function emptySessionStatusCounts\(\): Record<SessionRecord\['status'\], number> \{\s*const out = \{\} as Record<SessionRecord\['status'\], number>;\s*for \(const status of SessionStatusSchema\.options\) out\[status\] = 0;\s*return out;\s*\}/,
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
      /function toSessionRecord\(r: typeof sessions\.\$inferSelect\): SessionRecord \{\s*return \{\s*id: r\.id,\s*accountId: r\.accountId,\s*apiKeyId: r\.apiKeyId,\s*driverSessionId: r\.driverSessionId,\s*status: r\.status,\s*archetype: r\.archetype,\s*purpose: r\.purpose,\s*label: r\.label,\s*metadata: r\.metadata \?\? null,\s*egressCapabilities: r\.egressCapabilities \?\? null,\s*egressCapabilityReport: r\.egressCapabilityReport \?\? null,\s*createdAt: r\.createdAt,\s*updatedAt: r\.updatedAt,\s*lastStateAt: r\.lastStateAt,\s*destroyedAt: r\.destroyedAt,\s*\};\s*\}/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
