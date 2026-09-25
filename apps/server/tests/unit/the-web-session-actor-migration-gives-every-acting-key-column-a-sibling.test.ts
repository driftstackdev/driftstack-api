// Migration 0138 gives every column that records the ACTING key a web-session
// sibling, relaxes the three that were NOT NULL, bounds each pair with a CHECK,
// and changes nothing else — fails fast on a busy table, and is mirrored in
// schema.ts.
//
// A signed-in browser acts as `wsk_<web session uuid>`, which no `uuid` column
// can hold, so every action the admin panel or the dashboard took went
// unrecorded or failed outright (the behaviour is proved end to end in
// tests/integration/an-action-taken-from-a-signed-in-browser-is-recorded-against-
// its-web-session.test.ts). Properties that keep the migration safe to run while
// the old process serves, and that no green run against an idle database shows:
//
//   · the lock timeout comes FIRST, so a busy table fails the batch in seconds
//     (safe to retry) instead of queueing every writer behind the lock;
//   · every new column is nullable with no default and NO foreign key — a catalog
//     change that rewrites no row, on a column an audit row keeps after the
//     session it names is deleted;
//   · the rate-card guard it replaces is 0127's, byte for byte, but for the one
//     column added to the terms a withdrawal may not change.
//
// And one property of the CLASS rather than of this file: the set of acting-key
// columns is DERIVED from every migration, so a future table that records an API
// key without a web-session sibling fails here instead of shipping the same bug.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { codeOnly } from './_helpers/code-only.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DB = resolve(HERE, '..', '..', 'src', 'db');
const MIGRATIONS = resolve(DB, 'migrations');
const TAG = '0138_web_session_actor_columns';
const MIGRATION = resolve(MIGRATIONS, `${TAG}.sql`);
const RATE_CARD_MIGRATION = resolve(MIGRATIONS, '0127_credit_rate_cards.sql');

/** Each acting-key column, its new sibling, and whether it was NOT NULL before. */
const SIBLINGS: ReadonlyArray<{
  table: string;
  key: string;
  webSession: string;
  wasNotNull: boolean;
}> = [
  {
    table: 'admin_audit_log',
    key: 'admin_key_id',
    webSession: 'admin_web_session_id',
    wasNotNull: true,
  },
  {
    table: 'ai_credits_admin_audit_log',
    key: 'admin_key_id',
    webSession: 'admin_web_session_id',
    wasNotNull: true,
  },
  {
    table: 'rate_limit_overrides',
    key: 'set_by_key_id',
    webSession: 'set_by_web_session_id',
    wasNotNull: true,
  },
  {
    table: 'account_audit_log',
    key: 'actor_key_id',
    webSession: 'actor_web_session_id',
    wasNotNull: false,
  },
  {
    table: 'incidents',
    key: 'created_by_admin_key_id',
    webSession: 'created_by_admin_web_session_id',
    wasNotNull: false,
  },
  {
    table: 'incident_updates',
    key: 'posted_by_admin_key_id',
    webSession: 'posted_by_admin_web_session_id',
    wasNotNull: false,
  },
  {
    table: 'pricing',
    key: 'updated_by_key_id',
    webSession: 'updated_by_web_session_id',
    wasNotNull: false,
  },
  {
    table: 'platform_secrets',
    key: 'updated_by_key_id',
    webSession: 'updated_by_web_session_id',
    wasNotNull: false,
  },
  {
    table: 'credit_rate_cards',
    key: 'created_by_key_id',
    webSession: 'created_by_web_session_id',
    wasNotNull: false,
  },
  {
    table: 'credit_plan_overrides',
    key: 'set_by_key_id',
    webSession: 'set_by_web_session_id',
    wasNotNull: false,
  },
];

/**
 * Columns that reference an API key and legitimately need a REAL one, with why.
 * An entry here is a decision, not a convenience: each is a key that must exist
 * for the row to mean anything.
 */
const NEEDS_A_REAL_KEY: Record<string, string> = {
  'sessions.api_key_id':
    'an automation session is owned by the credential that runs it: the key is published on ' +
    'every session as `api_key_id: key_<uuid>` and is what a key revocation acts on. No browser ' +
    'surface creates one (the dashboard only lists them).',
  'oauth_access_tokens.id':
    'an OAuth access token IS an api_keys row (the same id, cascade-deleted with it); it is ' +
    'not an actor column at all.',
};

/**
 * Acting-key columns added AFTER 0138 that brought their own web-session sibling
 * in the same migration — the rule this file states, kept by a later column rather
 * than by 0138 — keyed `table.key` to the sibling's column name. The last arm below
 * checks each sibling really is declared beside its key.
 *
 *   · 0142 (security sweep #2): who minted a session's GUI control key. The key
 *     may be minted from a signed-in browser as well as with an API key, so the
 *     minting credential is one of the pair, and a CHECK in 0142 allows at most one.
 */
const SIBLING_ADDED_WITH_THE_COLUMN: Record<string, string> = {
  'agent_sessions.gui_control_key_minted_by_api_key_id': 'gui_control_key_minted_by_web_session_id',
};

/** SQL with `--` comments removed (the prose names statements it does not run). */
function code(path: string): string {
  return readFileSync(path, 'utf8')
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');
}

/** Statements split on `;`, except inside a `$$ … $$` function body. */
function statements(sql: string): string[] {
  const out: string[] = [];
  let current = '';
  let inBody = false;
  for (let i = 0; i < sql.length; i += 1) {
    if (sql.startsWith('$$', i)) {
      inBody = !inBody;
      current += '$$';
      i += 1;
      continue;
    }
    const ch = sql[i] ?? '';
    if (ch === ';' && !inBody) {
      out.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  out.push(current);
  return out.map((s) => s.replace(/\s+/g, ' ').trim()).filter((s) => s.length > 0);
}

/** The `credit_rate_cards_guard` definition in one migration, whitespace-normalised. */
function guardIn(path: string): string {
  const found = statements(code(path)).find((s) =>
    /FUNCTION "credit_rate_cards_guard"\(\)/.test(s),
  );
  if (found === undefined) throw new Error(`credit_rate_cards_guard not found in ${path}`);
  return found;
}

/**
 * Every `table.column` any migration declares as a uuid that either references
 * `api_keys` or is named `…key_id`, by the three shapes this history uses: a
 * column inside CREATE TABLE (inline REFERENCES, or a table-level FOREIGN KEY), an
 * ALTER TABLE … ADD CONSTRAINT … FOREIGN KEY, and an ALTER TABLE … ADD COLUMN.
 */
function actingKeyColumnsInHistory(): Set<string> {
  const found = new Set<string>();
  const files = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const file of files) {
    for (const s of statements(code(resolve(MIGRATIONS, file)))) {
      const created = /^CREATE TABLE (?:IF NOT EXISTS )?"([a-z0-9_]+)" \((.*)\)$/.exec(s);
      if (created !== null) {
        const [, table = '', body = ''] = created;
        for (const col of body.matchAll(/"([a-z0-9_]+)" uuid\b([^,]*)/g)) {
          const [, name = '', rest = ''] = col;
          if (rest.includes('api_keys') || name.endsWith('key_id')) found.add(`${table}.${name}`);
        }
        for (const fk of body.matchAll(
          /FOREIGN KEY \("([a-z0-9_]+)"\) REFERENCES (?:"public"\.)?"api_keys"/g,
        )) {
          found.add(`${table}.${fk[1] ?? ''}`);
        }
        continue;
      }
      const constraint =
        /^ALTER TABLE "([a-z0-9_]+)" ADD CONSTRAINT "[^"]+" FOREIGN KEY \("([a-z0-9_]+)"\) REFERENCES (?:"public"\.)?"api_keys"/.exec(
          s,
        );
      if (constraint !== null) found.add(`${constraint[1] ?? ''}.${constraint[2] ?? ''}`);
      const added =
        /^ALTER TABLE "([a-z0-9_]+)" ADD COLUMN (?:IF NOT EXISTS )?"([a-z0-9_]+)" uuid\b(.*)$/.exec(
          s,
        );
      if (added !== null) {
        const [, table = '', name = '', rest = ''] = added;
        if (rest.includes('api_keys') || name.endsWith('key_id')) found.add(`${table}.${name}`);
      }
    }
  }
  return found;
}

describe('migration 0138 gives every acting-key column a web-session sibling', () => {
  const all = statements(code(MIGRATION));

  it('CRITICAL the lock timeout comes FIRST, then exactly the statements the header describes and nothing else', () => {
    expect(all[0]).toBe("SET LOCAL lock_timeout = '5s'");
    const expected: string[] = ["SET LOCAL lock_timeout = '5s'"];
    for (const s of SIBLINGS) {
      if (s.wasNotNull) {
        expected.push(`ALTER TABLE "${s.table}" ALTER COLUMN "${s.key}" DROP NOT NULL`);
      }
      expected.push(`ALTER TABLE "${s.table}" ADD COLUMN IF NOT EXISTS "${s.webSession}" uuid`);
      const name = s.wasNotNull ? `${s.table}_one_actor` : `${s.table}_at_most_one_actor`;
      expected.push(
        `ALTER TABLE "${s.table}" ADD CONSTRAINT "${name}" CHECK (num_nonnulls("${s.key}", "${s.webSession}") ${s.wasNotNull ? '= 1' : '<= 1'})`,
      );
    }
    expect(all.slice(0, -1)).toEqual(expected);
    expect(all.at(-1)).toMatch(/^CREATE OR REPLACE FUNCTION "credit_rate_cards_guard"\(\)/);
    expect(all).toHaveLength(expected.length + 1);
  });

  it('CRITICAL every new column is nullable, has no default and no foreign key: a catalog change that rewrites no row, on a column that outlives the session it names', () => {
    const added = all.filter((s) => /ADD COLUMN/.test(s));
    expect(added).toHaveLength(SIBLINGS.length);
    for (const s of added) expect(s).not.toMatch(/NOT NULL|DEFAULT|REFERENCES/i);
  });

  it('CRITICAL only the three NOT NULL columns lose NOT NULL, and each of them gets EXACTLY-ONE: every such row still names who acted', () => {
    const relaxed = all.filter((s) => /DROP NOT NULL/.test(s));
    expect(relaxed.map((s) => /^ALTER TABLE "([a-z_]+)"/.exec(s)?.[1])).toEqual(
      SIBLINGS.filter((s) => s.wasNotNull).map((s) => s.table),
    );
    for (const s of SIBLINGS.filter((x) => x.wasNotNull)) {
      expect(all).toContain(
        `ALTER TABLE "${s.table}" ADD CONSTRAINT "${s.table}_one_actor" CHECK (num_nonnulls("${s.key}", "${s.webSession}") = 1)`,
      );
    }
  });

  it('CRITICAL the rate-card guard is 0127’s own, changed ONLY by the new column joining the terms a withdrawal may not change', () => {
    const before = guardIn(RATE_CARD_MIGRATION).replace(
      /^CREATE FUNCTION/,
      'CREATE OR REPLACE FUNCTION',
    );
    const widened = before
      .replace(
        'NEW."created_by_key_id", NEW."note")',
        'NEW."created_by_key_id", NEW."created_by_web_session_id", NEW."note")',
      )
      .replace(
        'OLD."created_by_key_id", OLD."note")',
        'OLD."created_by_key_id", OLD."created_by_web_session_id", OLD."note")',
      );
    expect(widened, 'the expected edit did not apply to 0127’s guard').not.toBe(before);
    expect(guardIn(MIGRATION)).toBe(widened);
  });

  it('CRITICAL the class is closed: every column any migration declares as an API-key reference has a web-session sibling here, or is named as needing a real key with the reason', () => {
    const history = actingKeyColumnsInHistory();
    // Non-vacuity, per extraction shape: an inline REFERENCES (0018), an ALTER
    // TABLE FOREIGN KEY (0003, and 0000's sessions), a table-level FOREIGN KEY
    // inside CREATE TABLE (0106), and a `…key_id` uuid with no foreign key (0067).
    for (const probe of [
      'account_audit_log.actor_key_id',
      'admin_audit_log.admin_key_id',
      'sessions.api_key_id',
      'oauth_access_tokens.id',
      'pricing.updated_by_key_id',
    ]) {
      expect(history, `the scan no longer finds ${probe}`).toContain(probe);
    }
    const covered = new Set([
      ...SIBLINGS.map((s) => `${s.table}.${s.key}`),
      ...Object.keys(SIBLING_ADDED_WITH_THE_COLUMN),
    ]);
    const uncovered = [...history].filter((c) => !covered.has(c) && !(c in NEEDS_A_REAL_KEY));
    expect(uncovered.sort(), 'acting-key column(s) with no web-session sibling').toEqual([]);
    const stale = Object.keys(NEEDS_A_REAL_KEY).filter((c) => !history.has(c));
    expect(stale, 'an exclusion names a column no migration declares').toEqual([]);
    const phantom = [...covered].filter((c) => !history.has(c));
    expect(phantom, 'a sibling added for a column no migration declares').toEqual([]);
  });

  it('a later acting-key column that carries its own sibling really does: the web-session column is declared beside it, as a nullable uuid with no foreign key', () => {
    const schema = codeOnly(readFileSync(resolve(DB, 'schema.ts'), 'utf8'));
    for (const [column, webSession] of Object.entries(SIBLING_ADDED_WITH_THE_COLUMN)) {
      const [tableName = '', key = ''] = column.split('.');
      const table =
        new RegExp(`pgTable\\(\\s*'${tableName}',[\\s\\S]*?\\n\\);`).exec(schema)?.[0] ?? '';
      expect(table, `${tableName} was not found in schema.ts`).not.toBe('');
      expect(table, `${column} is not declared`).toMatch(new RegExp(`: uuid\\('${key}'\\)`));
      const sibling = new RegExp(`: uuid\\('${webSession}'\\)([^\\n]*)`).exec(table);
      expect(sibling, `${tableName}.${webSession} is not declared`).not.toBeNull();
      expect(sibling?.[1] ?? '', `${tableName}.${webSession}`).not.toMatch(/notNull|references/);
    }
  });

  it('the journal applies it after 0137, with a later `when`', () => {
    const journal = JSON.parse(
      readFileSync(resolve(MIGRATIONS, 'meta', '_journal.json'), 'utf8'),
    ) as { entries: Array<{ idx: number; when: number; tag: string }> };
    const at = journal.entries.findIndex((e) => e.tag === TAG);
    expect(at).toBe(138);
    expect(journal.entries[at]?.idx).toBe(138);
    expect(journal.entries[at - 1]?.tag).toBe('0137_credit_lot_still_paid');
    expect(journal.entries[at]?.when).toBeGreaterThan(journal.entries[at - 1]?.when ?? Infinity);
  });

  it('CRITICAL schema.ts mirrors it: each sibling is a nullable uuid with no foreign key, the three relaxed columns are no longer .notNull(), and every CHECK is declared by name', () => {
    const schema = codeOnly(readFileSync(resolve(DB, 'schema.ts'), 'utf8'));
    for (const s of SIBLINGS) {
      const table =
        new RegExp(`pgTable\\(\\s*'${s.table}',[\\s\\S]*?\\n\\);`).exec(schema)?.[0] ?? '';
      expect(table, `${s.table} was not found in schema.ts`).not.toBe('');
      const sibling = new RegExp(`: uuid\\('${s.webSession}'\\)([^\\n]*)`).exec(table);
      expect(sibling, `${s.table}.${s.webSession} is not declared`).not.toBeNull();
      expect(sibling?.[1] ?? '', `${s.table}.${s.webSession}`).not.toMatch(/notNull|references/);
      const key = new RegExp(`: uuid\\('${s.key}'\\)[\\s\\S]*?,\\n`).exec(table)?.[0] ?? '';
      expect(key, `${s.table}.${s.key} is not declared`).not.toBe('');
      expect(key, `${s.table}.${s.key} must be nullable now`).not.toMatch(/\.notNull\(\)/);
      const name = s.wasNotNull ? `${s.table}_one_actor` : `${s.table}_at_most_one_actor`;
      expect(table, `${s.table} does not declare ${name}`).toContain(`'${name}'`);
    }
  });
});
