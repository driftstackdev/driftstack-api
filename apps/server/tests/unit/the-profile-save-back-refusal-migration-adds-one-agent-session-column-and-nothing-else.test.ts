// Migration 0143 records, per agent session, that the session may not save its
// profile back: one `agent_sessions` column, `profile_save_back_refused`, set at
// dispatch when the device could not be given the profile's stored state.
//
// Properties that keep it safe to run while the old process serves, and that no
// green run against an idle database would show:
//
//   · the lock timeout comes FIRST, so a busy `agent_sessions` (every transcript
//     append writes it) fails the batch in seconds, safe to retry, instead of
//     queueing every live session's writes behind the lock;
//   · the column is `boolean NOT NULL DEFAULT false` — a constant default, which
//     Postgres 11+ records in the catalog without rewriting a row, and which reads
//     every existing session as "not refused": exactly what the old code did;
//   · no index, no constraint, no row touched, no other table, no type statement.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { codeOnly } from './_helpers/code-only.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DB = resolve(HERE, '..', '..', 'src', 'db');
const TAG = '0143_agent_session_profile_save_back_refused';
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

describe('migration 0143 adds one agent-session column and nothing else', () => {
  it('CRITICAL it is exactly these statements, the lock timeout FIRST', () => {
    expect(statements(code(MIGRATION))).toEqual([
      "SET LOCAL lock_timeout = '5s'",
      'ALTER TABLE "agent_sessions" ADD COLUMN IF NOT EXISTS "profile_save_back_refused" boolean DEFAULT false NOT NULL',
    ]);
  });

  it('never spells a type statement, even in its prose', () => {
    const raw = readFileSync(MIGRATION, 'utf8');
    expect(raw).not.toMatch(/\bENUM\b/i);
    expect(raw).not.toMatch(/ALTER TYPE|CREATE TYPE/i);
  });

  it('the journal applies it after 0142, with a later `when`', () => {
    const journal = JSON.parse(
      readFileSync(resolve(DB, 'migrations', 'meta', '_journal.json'), 'utf8'),
    ) as { entries: Array<{ idx: number; when: number; tag: string }> };
    const at = journal.entries.findIndex((e) => e.tag === TAG);
    expect(at).toBe(143);
    expect(journal.entries[at]?.idx).toBe(143);
    expect(journal.entries[at - 1]?.tag).toBe('0142_agent_session_control_key_minter');
    expect(journal.entries[at]?.when).toBeGreaterThan(journal.entries[at - 1]?.when ?? Infinity);
  });

  it('schema.ts mirrors it: a NOT NULL boolean defaulting to false', () => {
    const schema = codeOnly(readFileSync(resolve(DB, 'schema.ts'), 'utf8'));
    const table = /pgTable\(\s*'agent_sessions',[\s\S]*?\n\);/.exec(schema)?.[0] ?? '';
    expect(table, 'the agent_sessions table was not found in schema.ts').not.toBe('');
    expect(table).toMatch(
      /: boolean\('profile_save_back_refused'\)\s*\.notNull\(\)\s*\.default\(false\),/,
    );
  });
});
