// `onDelete: 'cascade'` looks like a retention policy. Usually it is not one.
//
// A cascade only fires when the PARENT ROW is deleted. This system does not
// delete account rows: `deleteAccount` sets `status = 'deleted'` and
// `deleted_at = now`, and reclaims resources in place. There is no
// `DELETE FROM accounts` anywhere in apps/server/src. So every
// `references(() => accounts.id, { onDelete: 'cascade' })` is a referential
// integrity rule and nothing else — it will not remove a row in the lifetime of
// this deployment.
//
// That is not news to the codebase; it is written down once, for one table. The
// W438 comment beside session_events in AUDIT_TABLES says it exactly: "Its FK to
// sessions is onDelete:cascade, but sessions are marked-destroyed (never
// row-deleted) so the cascade never fires → unbounded growth." That reasoning is
// correct and it generalises to fifteen tables. Nobody had generalised it.
//
// SEVEN OF THEM APPEND A ROW PER EVENT:
//
//   account_audit_log             one row per customer action
//   usage_records                 one row per metered event
//   sessions                      one per session, marked destroyed, never
//                                 removed — the case W438 already documented
//   web_sessions                  one per browser login; revoked by UPDATE
//   incident_update_notifications one per (subscriber × incident update), so it
//                                 grows as the product of two things that grow
//   oauth_pending_links           one per link attempt, consumed by UPDATE
//   billing_email_sends           one per billing email; also the dedup key
//
// The other eight hold one row per live entity — an account's API keys, its
// webhook endpoints, its subscription — and are bounded by the entity count.
// They are in the roster so that the difference is a recorded reading of each
// one rather than an impression.
//
// This changes no schema and adds no sweeper. Retention is a policy decision
// with a privacy-policy sentence attached to it, and picking windows for seven
// tables out of a drift guard would be inventing policy. What it does is make
// the eighth per-event table arrive as a failure instead of as a row in a
// migration nobody reads twice.
//
// SCOPE, AND THE ONE INDIRECTION. The detector reads `apps/server/src/db` only,
// because that is where DB deletes live; scanning all of src drowns in
// `Map.delete(key)`. Inside db/ exactly one delete goes through a variable —
// `auth-flows-repo.ts` does `.delete(t)` where `t = tableForKind(kind)` — which
// covers the three auth-token tables. That is recorded in
// DELETED_VIA_DISPATCHER rather than pattern-matched, and an arm below fails if
// a second indirection appears, because the next one would silently widen the
// roster instead of being resolved.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const DB = resolve(HERE, '..', '..', 'src', 'db');

/**
 * Tables removed through `.delete(t)` where `t` comes from `tableForKind`.
 * Resolved by hand because the detector cannot follow the variable, and left
 * visible because an unrecorded indirection is how a table gets counted as
 * unbounded when it is swept every night.
 */
const DELETED_VIA_DISPATCHER = new Set([
  'emailVerifyTokens',
  'magicLinkTokens',
  'passwordResetTokens',
]);

/**
 * Every table whose only removal path is a cascade from a parent that is itself
 * never row-deleted, and what actually bounds it.
 *
 * `PER-EVENT` — appends a row per action. Nothing removes it, ever.
 * `entity`    — one row per live thing; bounded by how many of that thing exist.
 */
const CASCADE_ONLY_TABLES = new Map<string, string>([
  ['account_audit_log', 'PER-EVENT — one row per customer action'],
  ['account_oauth_links', 'entity — one row per account per provider'],
  ['api_keys', 'entity — per account, capped by the key limit'],
  [
    'billing_email_sends',
    'PER-EVENT — one row per billing email; also the (event, kind) dedup key',
  ],
  ['crypto_entitlements', 'entity — per account'],
  [
    'incident_update_notifications',
    'PER-EVENT — one row per (subscriber × incident update); the product of two growing things',
  ],
  ['incident_updates', 'entity — per incident, and incidents are staff-created'],
  ['oauth_clients', 'entity — registered by staff'],
  ['oauth_pending_links', 'PER-EVENT — one row per link attempt, consumed by UPDATE not DELETE'],
  [
    'rate_limit_buckets',
    'entity — and in fact nothing writes it at all; the live counters are in Redis (D-015)',
  ],
  ['sessions', 'PER-EVENT — marked destroyed, never removed. The case W438 documented'],
  ['subscriptions', 'entity — per account'],
  ['usage_records', 'PER-EVENT — one row per metered event'],
  ['web_sessions', 'PER-EVENT — one row per browser login; revoked by UPDATE'],
  ['webhook_endpoints', 'entity — per account, capped by the endpoint limit'],
]);

interface Table {
  readonly sql: string;
  /** Parent table consts this one cascades from. */
  readonly cascadeParents: string[];
}

function parseSchema(): Map<string, Table> {
  const schema = readFileSync(resolve(DB, 'schema.ts'), 'utf8');
  const out = new Map<string, Table>();
  for (const m of schema.matchAll(/export const (\w+) = pgTable\(\s*\n?\s*'([a-z_]+)'/g)) {
    const start = m.index ?? 0;
    const next = schema.indexOf('export const', start + 10);
    const body = schema.slice(start, next === -1 ? schema.length : next);
    const cascadeParents: string[] = [];
    for (const r of body.matchAll(/references\(\(\) => (\w+)\.\w+(?:,\s*\{([^}]*)\})?\)/g)) {
      if (/onDelete:\s*'cascade'/.test(r[2] ?? '')) cascadeParents.push(r[1] ?? '');
    }
    out.set(m[1] ?? '', { sql: m[2] ?? '', cascadeParents });
  }
  return out;
}

interface Deletes {
  /** Table consts with a literal `.delete(const)` or raw `DELETE FROM`. */
  readonly direct: Set<string>;
  /** `.delete(x)` where x is not a table const — must be resolved by hand. */
  readonly indirect: string[];
}

function parseDeletes(tables: Map<string, Table>): Deletes {
  const direct = new Set<string>();
  const indirect: string[] = [];
  const bySql = new Map([...tables].map(([c, t]) => [t.sql, c]));
  for (const f of readdirSync(DB).filter((x) => x.endsWith('.ts'))) {
    const src = readFileSync(resolve(DB, f), 'utf8');
    for (const m of src.matchAll(/\.delete\(\s*(\w+)\s*\)/g)) {
      const id = m[1] ?? '';
      if (tables.has(id)) direct.add(id);
      else indirect.push(`${f}: .delete(${id})`);
    }
    for (const m of src.matchAll(/DELETE FROM\s+([a-z_]+)/gi)) {
      const c = bySql.get((m[1] ?? '').toLowerCase());
      if (c !== undefined) direct.add(c);
    }
  }
  return { direct, indirect };
}

function cascadeOnly(): string[] {
  const tables = parseSchema();
  const { direct } = parseDeletes(tables);
  const out: string[] = [];
  for (const [name, { sql, cascadeParents }] of tables) {
    if (direct.has(name) || DELETED_VIA_DISPATCHER.has(name)) continue;
    if (cascadeParents.length === 0) continue;
    // A cascade whose parent IS deleted really does fire.
    if (cascadeParents.some((p) => direct.has(p))) continue;
    out.push(sql);
  }
  return out.sort();
}

describe('a cascade from a row nobody deletes is not a retention policy', () => {
  const tables = parseSchema();

  it('CRITICAL the premise holds: nothing deletes an account row. Every reading below rests on this one fact — if `deleteAccount` ever starts removing the row, fifteen cascades begin firing and this whole file is describing a system that no longer exists.', () => {
    const src = readdirSync(DB)
      .filter((f) => f.endsWith('.ts'))
      .map((f) => readFileSync(resolve(DB, f), 'utf8'))
      .join('\n');
    expect(src, 'an account row is now deleted — re-read this file from the top').not.toMatch(
      /\.delete\(\s*accounts\s*\)|DELETE FROM accounts\b/i,
    );
  });

  it('CRITICAL the scan sees the schema and can tell a deleted table from a cascade-only one. This asserts a set equals a list, so a parser that read nothing would report an empty set — no unbounded tables at all, which is both the most reassuring answer and the wrong one. Probed in both directions by name.', () => {
    expect(tables.size, 'tables parsed out of schema.ts').toBeGreaterThan(45);
    const { direct } = parseDeletes(tables);
    expect(direct.size, 'table consts with a direct delete').toBeGreaterThan(20);
    expect(
      cascadeOnly(),
      'profiles has a real purge path and must NOT be reported as cascade-only',
    ).not.toContain('profiles');
    expect(cascadeOnly(), 'usage_records is cascade-only — the detector is broken').toContain(
      'usage_records',
    );
  });

  it('CRITICAL every delete that goes through a variable is resolved by hand. The detector cannot follow `.delete(t)`, so an unrecorded one makes a swept table look unbounded — or, worse, hides that a table stopped being swept. There is exactly one today and it is the tableForKind dispatcher.', () => {
    const { indirect } = parseDeletes(tables);
    expect([...new Set(indirect)].sort(), 'unresolved indirect delete(s) in src/db:').toEqual([
      'auth-flows-repo.ts: .delete(t)',
    ]);
    // And it must still cover what DELETED_VIA_DISPATCHER claims it covers.
    const repo = readFileSync(resolve(DB, 'auth-flows-repo.ts'), 'utf8');
    expect(repo, 'the dispatcher this exemption names is gone').toMatch(/tableForKind/);
    for (const t of DELETED_VIA_DISPATCHER) {
      expect(
        repo,
        `${t} is exempted as dispatcher-deleted but the repo no longer names it`,
      ).toMatch(new RegExp(`\\b${t}\\b`));
    }
  });

  it('CRITICAL no table relies on a cascade that cannot fire without that being recorded. Add it here with what bounds it in practice. If the honest answer is "nothing — it appends a row per event", say PER-EVENT, because that is a table that is fine in staging and is a disk-full page at scale.', () => {
    const unrecorded = cascadeOnly().filter((t) => !CASCADE_ONLY_TABLES.has(t));
    expect(unrecorded, 'cascade-only table(s) with no recorded bound:').toEqual([]);
  });

  it('CRITICAL every recorded entry still names a real cascade-only table. A stale entry claims a table was reviewed when it has since gained a sweeper — which is the good outcome, and it should show up as a required edit here rather than as an exemption nobody re-reads.', () => {
    const live = new Set(cascadeOnly());
    const stale = [...CASCADE_ONLY_TABLES.keys()].filter((t) => !live.has(t)).sort();
    expect(stale, 'recorded table(s) that are no longer cascade-only:').toEqual([]);
  });

  it('CRITICAL rate_limit_buckets is written, or the docs say it is not. It is in the roster above as entity-bounded for an unusual reason: nothing writes it at all. D-015 describes it as a durability snapshot "synced periodically" and architecture.md listed it under Metering as "(snapshots)" — a table that exists in every production database, is named in two documents as a live durability mechanism, and has never held a row. Whoever builds the sync must delete these notices; whoever deletes the notices must build the sync.', () => {
    const src = readdirSync(DB)
      .filter((f) => f.endsWith('.ts') && f !== 'schema.ts')
      .map((f) => readFileSync(resolve(DB, f), 'utf8'))
      .join('\n');
    const written = /\.insert\(\s*rateLimitBuckets\s*\)|INSERT INTO rate_limit_buckets/i.test(src);
    const docs = resolve(HERE, '..', '..', '..', '..', 'docs');
    const notices =
      /Reality check 2026-08-18[\s\S]{0,400}?nothing reads or writes it/.test(
        readFileSync(resolve(docs, 'decisions.md'), 'utf8'),
      ) &&
      /`rate_limit_buckets` — which exists in the schema but is \*\*never written\*\*/.test(
        readFileSync(resolve(docs, 'architecture.md'), 'utf8'),
      );
    expect(
      written !== notices,
      written
        ? 'rate_limit_buckets is written now — remove the D-015 reality check and the architecture.md note, and say what the sync period is'
        : 'nothing writes rate_limit_buckets and the docs no longer say so — D-015 and architecture.md describe a durability mechanism that does not exist',
    ).toBe(true);
  });

  it('CRITICAL the per-event set is still exactly these seven. The entity-bounded majority is the boring part of the roster; this is the list that says whether the situation is getting worse, and an eighth would otherwise arrive as one more line in a table of fifteen.', () => {
    const perEvent = [...CASCADE_ONLY_TABLES.entries()]
      .filter(([, why]) => why.startsWith('PER-EVENT'))
      .map(([t]) => t)
      .sort();
    expect(perEvent, 'tables that append a row per event and are never removed:').toEqual([
      'account_audit_log',
      'billing_email_sends',
      'incident_update_notifications',
      'oauth_pending_links',
      'sessions',
      'usage_records',
      'web_sessions',
    ]);
  });
});
