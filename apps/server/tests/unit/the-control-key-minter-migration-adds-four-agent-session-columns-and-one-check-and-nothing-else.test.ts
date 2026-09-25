// Migration 0142 records who minted a session's GUI control key (security sweep
// #2): the calling account, the API key or web session it called with, and the
// team membership a member acted through — four `agent_sessions` columns and one
// CHECK that a key names at most one minting credential. Properties that keep it
// safe to run while the old process serves, and that no green run against an idle
// database would show:
//
//   · the lock timeout comes FIRST, so a busy `agent_sessions` (every transcript
//     append writes it) fails the batch in seconds, safe to retry, instead of
//     queueing every live session's writes behind the lock;
//   · every column is nullable with no default: a catalog change, not a table
//     rewrite, and every existing row reads "no recorded minter" (NULL) — which the
//     use-time check refuses, so a key minted before the deploy is re-minted rather
//     than trusted;
//   · no foreign keys (a missing row fails the use-time check on its own), no index,
//     no row touched, no other table, and no type statement.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { codeOnly } from './_helpers/code-only.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DB = resolve(HERE, '..', '..', 'src', 'db');
const TAG = '0142_agent_session_control_key_minter';
const MIGRATION = resolve(DB, 'migrations', `${TAG}.sql`);

/** SQL with `--` comments removed. */
function code(path: string): string {
  return readFileSync(path, 'utf8')
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');
}

function statements(sql: string): string[] {
  return sql
    .split(';')
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s.length > 0);
}

const COLUMNS = [
  'gui_control_key_minted_by_account_id',
  'gui_control_key_minted_by_api_key_id',
  'gui_control_key_minted_by_web_session_id',
  'gui_control_key_minted_by_membership_id',
] as const;

describe('migration 0142 adds four agent-session columns and one check, and nothing else', () => {
  it('CRITICAL it is exactly these statements, the lock timeout FIRST', () => {
    expect(statements(code(MIGRATION))).toEqual([
      "SET LOCAL lock_timeout = '5s'",
      ...COLUMNS.map((c) => `ALTER TABLE "agent_sessions" ADD COLUMN IF NOT EXISTS "${c}" uuid`),
      'ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_gui_control_key_one_minter_credential" ' +
        'CHECK (num_nonnulls("gui_control_key_minted_by_api_key_id", "gui_control_key_minted_by_web_session_id") <= 1)',
    ]);
  });

  it('CRITICAL every column is nullable with no default and no foreign key: a catalog change, not a table rewrite', () => {
    const added = statements(code(MIGRATION)).filter((s) => /ADD COLUMN/.test(s));
    expect(added).toHaveLength(4);
    for (const s of added) expect(s).not.toMatch(/NOT NULL|DEFAULT|REFERENCES/i);
  });

  it('never spells a type statement, even in its prose', () => {
    const raw = readFileSync(MIGRATION, 'utf8');
    expect(raw).not.toMatch(/\bENUM\b/i);
    expect(raw).not.toMatch(/ALTER TYPE|CREATE TYPE/i);
  });

  it('the journal applies it after 0141, with a later `when`', () => {
    const journal = JSON.parse(
      readFileSync(resolve(DB, 'migrations', 'meta', '_journal.json'), 'utf8'),
    ) as { entries: Array<{ idx: number; when: number; tag: string }> };
    const at = journal.entries.findIndex((e) => e.tag === TAG);
    expect(at).toBe(142);
    expect(journal.entries[at]?.idx).toBe(142);
    expect(journal.entries[at - 1]?.tag).toBe('0141_subscription_past_due_grace');
    expect(journal.entries[at]?.when).toBeGreaterThan(journal.entries[at - 1]?.when ?? Infinity);
  });

  it('schema.ts mirrors it: the four columns as nullable uuids and the CHECK by name', () => {
    const schema = codeOnly(readFileSync(resolve(DB, 'schema.ts'), 'utf8'));
    const table = /pgTable\(\s*'agent_sessions',[\s\S]*?\n\);/.exec(schema)?.[0] ?? '';
    expect(table, 'the agent_sessions table was not found in schema.ts').not.toBe('');
    for (const column of COLUMNS) {
      expect(table).toMatch(new RegExp(`: uuid\\('${column}'\\),`));
    }
    expect(table).toContain("'agent_sessions_gui_control_key_one_minter_credential'");
  });
});
