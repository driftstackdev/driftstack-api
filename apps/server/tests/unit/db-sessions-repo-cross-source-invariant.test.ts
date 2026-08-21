// W998 — db/sessions-repo cross-source invariant. Three-hundred-
// twenty-fourth in the drift-guard series. Pins the apps/server/src/
// db/sessions-repo.ts Drizzle sessions repo primitive:
//
//   Header framing — 'Drizzle-backed implementation of SessionRepo.
//   The shape mirrors SessionsService expectations exactly; tests
//   use an in-memory impl from tests/integration/_helpers/in-memory-
//   sessions-repo.ts'.
//
//   DrizzleSessionRepo method surface — insertSession + findSession
//     (account-scoped) + serialized terminal destroy authority +
//     updateSessionStatus + countActiveSessions + listSessions
//     (account-scoped paged) + recordEvent + listAllSessions (admin
//     paged) + listExpiredForAutoDestroy (6.g free-tier duration sweep;
//     accounts-join, oldest-first, bounded).
//
//   insertSession 7-field values — accountId + apiKeyId +
//     driverSessionId + archetype + purpose + label + metadata.
//
//   updateSessionStatus 2-conditional spread — lastStateAt + destroyedAt
//     each only set when present in extra.
//
//   countActiveSessions uses sql<number>`count(*)::int` + isNull
//     (destroyedAt). The ::int cast keeps Postgres bigint from
//     becoming a JS string.
//
//   listSessions cursor framing — 'Cursor format: ISO timestamp of
//   the last seen createdAt (descending order)'. cursor → lt
//   (createdAt, cursorDate).
//
//   listAllSessions admin filters — cursor + status + accountId.
//
//   recordEvent closed projection boundary — project before the
//     four-field sessionId + type + payload + durationMs insert.
//
//   toSessionRecord 13-field mapper — id + accountId + apiKeyId +
//     driverSessionId + status + archetype + purpose + label +
//     metadata ?? null + createdAt + updatedAt + lastStateAt +
//     destroyedAt.
//
// stays in lockstep across apps/server/src/db/sessions-repo.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W998 db/sessions-repo cross-source invariant', () => {
  // ─── Header framing ──────────────────────────────────────────

  it("CRITICAL apps/server/src/db/sessions-repo.ts header — 'Drizzle-backed implementation of SessionRepo. The shape mirrors SessionsService expectations exactly; tests use an in-memory impl from tests/integration/_helpers/in-memory-sessions-repo.ts'. The Drizzle + in-memory test-impl pairing is the V-156 sessions-repo contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/sessions-repo.ts'));
    expect(p).toMatch(/Drizzle-backed implementation of SessionRepo\. The shape mirrors/);
    expect(p).toMatch(/SessionsService expectations exactly; tests use an in-memory impl from/);
    expect(p).toMatch(/`tests\/integration\/_helpers\/in-memory-sessions-repo\.ts`\./);
  });

  // ─── 9-method surface ────────────────────────────────────────

  it('CRITICAL 11-method surface includes destroySessionSerialized between lookup and general status mutation', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/sessions-repo.ts'));
    expect(p).toMatch(/async insertSession\(input: NewSessionInput\): Promise<SessionRecord> \{/);
    expect(p).toMatch(
      /async insertSessionIfUnderLimit\(\s*\n?\s*input: NewSessionInput,\s*\n?\s*limit: number,\s*\n?\s*opts: \{ profileId\?: string \} = \{\},\s*\n?\s*\): Promise<SessionRecord \| null> \{/,
    );
    expect(p).toMatch(
      /async findSession\(id: string, accountId: string\): Promise<SessionRecord \| null> \{/,
    );
    expect(p).toMatch(/async findSessionUnscoped\(id: string\): Promise<SessionRecord \| null> \{/);
    expect(p).toMatch(/async destroySessionSerialized\(/);
    expect(p).toMatch(/async updateSessionStatus\(/);
    expect(p).toMatch(/async countActiveSessions\(accountId: string\): Promise<number> \{/);
    expect(p).toMatch(/async listSessions\(/);
    expect(p).toMatch(/async recordEvent\(input: SessionEventInput\): Promise<void> \{/);
    expect(p).toMatch(/async listAllSessions\(opts: \{/);
    expect(p).toMatch(/async listExpiredForAutoDestroy\(opts: \{/);
  });

  // ─── listExpiredForAutoDestroy (6.g duration sweep) ──────────

  it('CRITICAL listExpiredForAutoDestroy — accounts innerJoin to resolve tier; status restricted to ACTIVE_SESSION_STATUSES; per-tier (tier eq + createdAt lt cutoff) clauses OR-ed; oldest-first; bounded by limit. The accounts-join is what makes paid (null-cap) sessions impossible to return — they never match a cutoff.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/sessions-repo.ts'));
    expect(p).toMatch(
      /const ACTIVE_SESSION_STATUSES: SessionRecord\['status'\]\[\] = \['creating', 'ready', 'busy'\];/,
    );
    expect(p).toMatch(/\.innerJoin\(accounts, eq\(sessions\.accountId, accounts\.id\)\)/);
    expect(p).toMatch(
      /and\(eq\(accounts\.tier, c\.tier\), lt\(sessions\.createdAt, c\.expiredBefore\)\)/,
    );
    expect(p).toMatch(/inArray\(sessions\.status, ACTIVE_SESSION_STATUSES\)/);
    expect(p).toMatch(/\.orderBy\(asc\(sessions\.createdAt\)\)/);
    expect(p).toMatch(/\.limit\(opts\.limit\)/);
  });

  // ─── insertSession 7-field values ────────────────────────────

  it('CRITICAL insertSession 7-field values — accountId + apiKeyId + driverSessionId + archetype + purpose + label + metadata. The 7-field shape carries identity + driver-binding + per-archetype attrs.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/sessions-repo.ts'));
    expect(p).toMatch(/accountId: input\.accountId,/);
    expect(p).toMatch(/apiKeyId: input\.apiKeyId,/);
    expect(p).toMatch(/driverSessionId: input\.driverSessionId,/);
    expect(p).toMatch(/archetype: input\.archetype,/);
    expect(p).toMatch(/purpose: input\.purpose,/);
    expect(p).toMatch(/label: input\.label,/);
    expect(p).toMatch(/metadata: input\.metadata,/);
    expect(p).toMatch(/if \(!row\) throw new Error\('insertSession returned no row'\);/);
  });

  // ─── findSession + findSessionUnscoped split ─────────────────

  it('CRITICAL findSession + findSessionUnscoped split — tenant-scoped vs admin lookup. The 2-variant design keeps the customer surface tenant-isolated.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/sessions-repo.ts'));
    expect(p).toMatch(
      /\.where\(and\(eq\(sessions\.id, id\), eq\(sessions\.accountId, accountId\)\)\)/,
    );
    expect(p).toMatch(/\.where\(eq\(sessions\.id, id\)\)/);
  });

  it('CRITICAL serialized destroy authority — row-level FOR UPDATE lock, explicit nullable admin scope, terminal sinks, callback before terminal write, driver-error before event insert', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/sessions-repo.ts'));
    expect(p).toMatch(
      /input\.accountId === null \? undefined : eq\(sessions\.accountId, input\.accountId\)/,
    );
    expect(p).toMatch(/\.for\('update'\)/);
    expect(p).toMatch(/current\.status === 'destroyed' \|\| current\.status === 'errored'/);
    const callbackIdx = p.indexOf('await destroyDriverSession(current);');
    const terminalWriteIdx = p.indexOf(".set({ status: 'destroyed'");
    const driverErrorIdx = p.indexOf("if (driverFailed) return { kind: 'driver_error'");
    const eventIdx = p.indexOf('await tx.insert(sessionEvents).values({');
    expect(callbackIdx).toBeGreaterThan(0);
    expect(terminalWriteIdx).toBeGreaterThan(callbackIdx);
    expect(driverErrorIdx).toBeGreaterThan(terminalWriteIdx);
    expect(eventIdx).toBeGreaterThan(driverErrorIdx);
  });

  // ─── updateSessionStatus conditional-spreads ─────────────────

  it("CRITICAL updateSessionStatus 2-conditional spread — lastStateAt + destroyedAt each only set when present in extra. The conditional-spread avoids overwriting timestamps to undefined when caller doesn't pass them.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/sessions-repo.ts'));
    expect(p).toMatch(/status,/);
    expect(p).toMatch(/updatedAt: new Date\(\),/);
    expect(p).toMatch(
      /\.\.\.\(extra\?\.lastStateAt \? \{ lastStateAt: extra\.lastStateAt \} : \{\}\),/,
    );
    expect(p).toMatch(
      /\.\.\.\(extra\?\.destroyedAt \? \{ destroyedAt: extra\.destroyedAt \} : \{\}\),/,
    );
  });

  // ─── countActiveSessions sql cast ────────────────────────────

  it('CRITICAL countActiveSessions uses sql<number>`count(*)::int` + isNull(destroyedAt). The ::int cast keeps Postgres bigint from becoming a JS string.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/sessions-repo.ts'));
    expect(p).toMatch(/\.select\(\{ count: sql<number>`count\(\*\)::int` \}\)/);
    expect(p).toMatch(
      /\.where\(and\(eq\(sessions\.accountId, accountId\), isNull\(sessions\.destroyedAt\)\)\);/,
    );
    expect(p).toMatch(/return row\?\.count \?\? 0;/);
  });

  // ─── listSessions cursor framing ─────────────────────────────

  it('CRITICAL listSessions keyset cursor — account-scoped conds + (createdAt,id) compound; cursor row looked up by (id, accountId).', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/sessions-repo.ts'));
    expect(p).toMatch(/const conds: SQL\[\] = \[eq\(sessions\.accountId, accountId\)\];/);
    expect(p).toMatch(/lt\(sessions\.createdAt, c\.createdAt\),/);
    expect(p).toMatch(/and\(eq\(sessions\.createdAt, c\.createdAt\), lt\(sessions\.id, c\.id\)\),/);
  });

  it("CRITICAL listSessions limit+1 hasMore probe + (createdAt desc, id desc) keyset — '.limit(opts.limit + 1)' + 'nextCursor = hasMore && last ? last.id : null'.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/sessions-repo.ts'));
    expect(p).toMatch(/\.orderBy\(desc\(sessions\.createdAt\), desc\(sessions\.id\)\)/);
    expect(p).toMatch(/\.limit\(opts\.limit \+ 1\);/);
    expect(p).toMatch(/const hasMore = rows\.length > opts\.limit;/);
    expect(p).toMatch(/nextCursor: hasMore && last \? last\.id : null,/);
  });

  // ─── recordEvent closed projection boundary ─────────────────

  it('CRITICAL recordEvent projects through the closed metadata boundary before its 4-field insert', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/sessions-repo.ts'));
    expect(p).toMatch(
      /import \{ projectSessionEventMetadata \} from '\.\.\/lib\/session-event-metadata\.js';/,
    );
    const projectionIdx = p.indexOf('const event = projectSessionEventMetadata(input);');
    const insertIdx = p.indexOf('await this.database.db.insert(sessionEvents).values({');
    expect(projectionIdx).toBeGreaterThan(0);
    expect(insertIdx).toBeGreaterThan(projectionIdx);
    expect(p).toMatch(/sessionId: input\.sessionId,/);
    expect(p).toMatch(/type: event\.type,/);
    expect(p).toMatch(/payload: event\.payload,/);
    expect(p).toMatch(/durationMs: event\.durationMs,/);
  });

  // ─── listAllSessions admin filters ───────────────────────────

  it('CRITICAL listAllSessions admin 3-filter — cursor (lt createdAt) + status (eq) + accountId (eq). The admin-side filter set covers cross-tenant lookup with optional status/account narrowing.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/sessions-repo.ts'));
    expect(p).toMatch(/and\(eq\(sessions\.createdAt, c\.createdAt\), lt\(sessions\.id, c\.id\)\),/);
    expect(p).toMatch(/if \(opts\.status\) filters\.push\(eq\(sessions\.status, opts\.status\)\);/);
    expect(p).toMatch(
      /if \(opts\.accountId\) filters\.push\(eq\(sessions\.accountId, opts\.accountId\)\);/,
    );
    expect(p).toMatch(
      /const whereClause = filters\.length === 0 \? undefined : and\(\.\.\.filters\);/,
    );
  });

  // ─── toSessionRecord 13-field mapper ─────────────────────────

  it('CRITICAL toSessionRecord 13-field mapper — id + accountId + apiKeyId + driverSessionId + status + archetype + purpose + label + metadata ?? null + createdAt + updatedAt + lastStateAt + destroyedAt. The 13-field SessionRecord is the SessionsService consumer shape.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/sessions-repo.ts'));
    expect(p).toMatch(
      /function toSessionRecord\(r: typeof sessions\.\$inferSelect\): SessionRecord \{/,
    );
    expect(p).toMatch(/id: r\.id,/);
    expect(p).toMatch(/accountId: r\.accountId,/);
    expect(p).toMatch(/apiKeyId: r\.apiKeyId,/);
    expect(p).toMatch(/driverSessionId: r\.driverSessionId,/);
    expect(p).toMatch(/status: r\.status,/);
    expect(p).toMatch(/archetype: r\.archetype,/);
    expect(p).toMatch(/purpose: r\.purpose,/);
    expect(p).toMatch(/label: r\.label,/);
    expect(p).toMatch(/metadata: r\.metadata \?\? null,/);
    expect(p).toMatch(/createdAt: r\.createdAt,/);
    expect(p).toMatch(/updatedAt: r\.updatedAt,/);
    expect(p).toMatch(/lastStateAt: r\.lastStateAt,/);
    expect(p).toMatch(/destroyedAt: r\.destroyedAt,/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/db-sessions-repo-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });

  // ─── V-1001: the pair this file names must AGREE ─────────────

  it("CRITICAL the in-memory double READS the repo's ACTIVE_SESSION_STATUSES instead of spelling it out. The repo names the set once and uses it twice — listActiveByAccount and listExpiredForAutoDestroy, the auto-destroy sweeper's query — and the double stands in for both. This arm used to compare the repo's declaration against two hard-coded chains in the double, which caught drift but left two copies agreeing by inspection; V-1279 exported the constant so there is one home, and what is checked now is that the second copy has not come back. Adding a status must move the shipped sweeper and every test wired to the double in the same edit.", () => {
    const repoSrc = read(resolve(REPO_ROOT, 'apps/server/src/db/sessions-repo.ts'));
    const doubleSrc = read(
      resolve(REPO_ROOT, 'apps/server/tests/integration/_helpers/in-memory-sessions-repo.ts'),
    );

    const decl = /export const ACTIVE_SESSION_STATUSES[^=]*=\s*\[([^\]]*)\]/.exec(repoSrc);
    expect(
      decl,
      'ACTIVE_SESSION_STATUSES is no longer EXPORTED as an array literal — the double imports it, ' +
        'so un-exporting it breaks the link rather than the build alone',
    ).not.toBeNull();
    expect(
      [...(decl?.[1] ?? '').matchAll(/'([a-z_]+)'/g)].length,
      'the constant parsed as empty — the regex, not the source',
    ).toBe(3);

    // Every place the repo uses the set, so a third use cannot appear unnoticed.
    expect(
      [...repoSrc.matchAll(/inArray\(sessions\.status, ACTIVE_SESSION_STATUSES\)/g)].length,
      'repo queries keyed to the constant',
    ).toBe(2);

    // The double reads it, at both sites that stand in for those queries.
    expect(
      doubleSrc.includes(
        "import { ACTIVE_SESSION_STATUSES } from '../../../src/db/sessions-repo.js'",
      ),
      'the double no longer imports the constant',
    ).toBe(true);
    expect(
      [...doubleSrc.matchAll(/ACTIVE_SESSION_STATUSES\.includes\(/g)].length,
      'the double stopped using the constant at both of the sites that mirror the repo queries',
    ).toBe(2);

    // …and has not grown a hand-written copy back. The detector is exercised on a control first,
    // because an arm asserting "zero chains" passes just as happily when its regex has stopped
    // matching anything at all.
    const CHAIN = /s\.status === '[a-z_]+'(?:\s*\|\|\s*s\.status === '[a-z_]+')+/g;
    expect(
      [...`s.status === 'creating' || s.status === 'ready' || s.status === 'busy'`.matchAll(CHAIN)]
        .length,
      'the chain detector no longer recognises a hand-written active-status copy',
    ).toBe(1);
    expect(
      [...doubleSrc.matchAll(CHAIN)].map((m) => m[0]),
      'the double spells the active-status set out by hand again — import the constant',
    ).toEqual([]);
  });
});
