// The closed unions in services/agent-turn-telemetry.ts, the CHECK constraints
// in migration 0125, and the eval's death-reason taxonomy — three statements of
// the same vocabulary, held together.
//
// Why each pairing matters:
//
//   source ↔ migration. Every text column on agent_turn_telemetry is
//   CHECK-constrained so it cannot hold free text. That makes "add an outcome
//   in source" a silent production failure: the insert is refused, the writer
//   swallows it by design, and the only symptom is a metric. This turns it into
//   a red test on the same day.
//
//   source ↔ eval. The point of mirroring the eval's class names is that a death
//   seen in production and a death reproduced in the eval are the same WORD. A
//   renamed class on either side breaks that silently; src cannot import from
//   tests, so the comparison has to live here.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  AGENT_TURN_DEATH_REASONS,
  AGENT_TURN_OUTCOMES,
  AGENT_TURN_PERSISTED_OUTCOMES,
  AGENT_TURN_PERSISTED_STEP_KINDS,
  AGENT_TURN_STEP_KINDS,
  AGENT_TURN_TRANSPORTS,
  AGENT_TURN_MODEL_LABELS,
} from '../../src/services/agent-turn-telemetry.js';
import { AgentIntentSchema } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = resolve(HERE, '..', '..');
const MIGRATION = resolve(SERVER, 'src/db/migrations/0125_add_agent_turn_telemetry.sql');
const SCHEMA = resolve(SERVER, 'src/db/schema.ts');
const EVAL_SCORE = resolve(SERVER, 'tests/eval/_lib/score.ts');

const sql = readFileSync(MIGRATION, 'utf8');

/** The quoted members of `"column" IN ( … )` inside the named constraint. */
function checkList(constraint: string): string[] {
  const match = new RegExp(
    `CONSTRAINT "${constraint}" CHECK \\(([\\s\\S]*?)\\n  \\)|CONSTRAINT "${constraint}" CHECK \\((.*)\\)`,
  ).exec(sql);
  const body = match?.[1] ?? match?.[2];
  if (body === undefined) throw new Error(`constraint ${constraint} not found in the migration`);
  return [...body.matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1] ?? '');
}

describe('agent_turn_telemetry unions ↔ migration 0125', () => {
  it('outcome: every PERSISTED outcome is allowed, and the two metrics-only ones are not', () => {
    expect(checkList('agent_turn_telemetry_outcome').sort()).toEqual(
      [...AGENT_TURN_PERSISTED_OUTCOMES].sort(),
    );
    // The named set is DERIVED, so pin what it is derived to: a third
    // metrics-only outcome must be a decision somebody made here, not a side
    // effect of adding a member to a private set.
    expect(
      AGENT_TURN_OUTCOMES.filter((o) => !AGENT_TURN_PERSISTED_OUTCOMES.includes(o)).sort(),
    ).toEqual(['manual_note', 'replayed']);
  });

  it('death_reason: the constraint lists exactly the source union', () => {
    expect(checkList('agent_turn_telemetry_death_reason').sort()).toEqual(
      [...AGENT_TURN_DEATH_REASONS].sort(),
    );
  });

  it('died_step_kind: exactly the step kinds, with `none` expressed as NULL', () => {
    expect(checkList('agent_turn_telemetry_died_step_kind').sort()).toEqual(
      [...AGENT_TURN_PERSISTED_STEP_KINDS].sort(),
    );
    expect(
      AGENT_TURN_STEP_KINDS.filter((k) => !AGENT_TURN_PERSISTED_STEP_KINDS.includes(k)),
    ).toEqual(['none']);
    expect(sql).toMatch(/"died_step_kind" IS NULL\s+OR "died_step_kind" IN/);
  });

  it('transport: exactly the source union', () => {
    expect(checkList('agent_turn_telemetry_transport').sort()).toEqual(
      [...AGENT_TURN_TRANSPORTS].sort(),
    );
  });

  it('model: constrained by SHAPE, and every label the writer can produce fits it while prose, a URL and a long string do not', () => {
    const shape = /CONSTRAINT "agent_turn_telemetry_model" CHECK \("model" ~ '([^']+)'\)/.exec(sql);
    expect(shape).not.toBeNull();
    const re = new RegExp(shape?.[1] ?? '$^');
    for (const label of AGENT_TURN_MODEL_LABELS) expect(re.test(label), label).toBe(true);
    expect(re.test('find the cheapest flight')).toBe(false);
    expect(re.test('https://example.test/a')).toBe(false);
    expect(re.test('a'.repeat(41))).toBe(false);
    expect(re.test('')).toBe(false);
  });

  it('step kinds track the intent union, so a new intent kind cannot be dropped on the floor', () => {
    const intentKinds = AgentIntentSchema.options.map((o) => o.shape.kind.value).sort();
    expect(AGENT_TURN_STEP_KINDS.filter((k) => k !== 'none').sort()).toEqual(intentKinds);
  });

  it('CRITICAL every text column of the table carries a CHECK. A text column without one is a place a task, a URL or an answer could be stored, and "content-free by construction" would quietly become "content-free by convention".', () => {
    const table = /CREATE TABLE IF NOT EXISTS "agent_turn_telemetry" \(([\s\S]*?)\n\);/.exec(sql);
    expect(table).not.toBeNull();
    const body = table?.[1] ?? '';
    const columns = [...body.matchAll(/^ {2}"([a-z_]+)" ([a-z]+)/gm)].map((m) => ({
      name: m[1] ?? '',
      type: m[2] ?? '',
    }));
    expect(columns.length).toBeGreaterThan(20);
    const textColumns = columns.filter((c) => c.type === 'text').map((c) => c.name);
    expect(textColumns.sort()).toEqual(
      ['death_reason', 'died_step_kind', 'model', 'outcome', 'transport'].sort(),
    );
    for (const column of textColumns) {
      expect(
        new RegExp(`CHECK \\(\\s*"${column}" (?:IN|~|IS NULL)`).test(body),
        `text column ${column} has no CHECK constraint`,
      ).toBe(true);
    }
    // And nothing that could hold content by another route.
    const allowedTypes = new Set(['uuid', 'timestamptz', 'text', 'integer', 'bigint', 'boolean']);
    expect(columns.filter((c) => !allowedTypes.has(c.type))).toEqual([]);
  });

  it('CRITICAL the table has no identifier column. It must not be joinable back to a customer.', () => {
    const table = /CREATE TABLE IF NOT EXISTS "agent_turn_telemetry" \(([\s\S]*?)\n\);/.exec(sql);
    const names = [...(table?.[1] ?? '').matchAll(/^ {2}"([a-z_]+)" /gm)].map((m) => m[1] ?? '');
    expect(names.filter((n) => n !== 'id' && /(^|_)(id|key|email|ip|url|token)$/.test(n))).toEqual(
      [],
    );
    expect(table?.[1] ?? '').not.toMatch(/REFERENCES/);
  });

  it('schema.ts restates the same closed lists — the third statement of one vocabulary', () => {
    const schema = readFileSync(SCHEMA, 'utf8');
    const listIn = (constraint: string): string[] => {
      const match = new RegExp(`check\\(\\s*'${constraint}',\\s*sql\`([^\`]*)\``).exec(schema);
      if (match?.[1] === undefined) throw new Error(`${constraint} not declared in schema.ts`);
      return [...match[1].matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1] ?? '').sort();
    };
    for (const constraint of [
      'agent_turn_telemetry_outcome',
      'agent_turn_telemetry_death_reason',
      'agent_turn_telemetry_died_step_kind',
      'agent_turn_telemetry_transport',
    ]) {
      expect(listIn(constraint), constraint).toEqual(checkList(constraint).sort());
    }
    // Every constraint the migration names is declared, by the same name.
    const named = [...sql.matchAll(/CONSTRAINT "([a-z_]+)"/g)].map((m) => m[1] ?? '');
    expect(named.length).toBe(7);
    for (const name of named) expect(schema, name).toContain(`'${name}'`);
  });

  it('schema.ts declares the same columns the migration creates', () => {
    const schema = readFileSync(SCHEMA, 'utf8');
    const start = schema.indexOf("pgTable(\n  'agent_turn_telemetry'");
    expect(start).toBeGreaterThan(-1);
    // The column object only — the constraint callback below it quotes list
    // members in the same `('name'` shape.
    const block = schema.slice(start, schema.indexOf('(t) => [', start));
    const schemaColumns = [...block.matchAll(/\('([a-z_]+)'/g)]
      .map((m) => m[1] ?? '')
      .filter((n) => n !== 'agent_turn_telemetry');
    const table = /CREATE TABLE IF NOT EXISTS "agent_turn_telemetry" \(([\s\S]*?)\n\);/.exec(sql);
    const sqlColumns = [...(table?.[1] ?? '').matchAll(/^ {2}"([a-z_]+)" /gm)].map(
      (m) => m[1] ?? '',
    );
    expect(schemaColumns.sort()).toEqual(sqlColumns.sort());
  });
});

describe('production death reasons ↔ the eval taxonomy', () => {
  const evalSource = readFileSync(EVAL_SCORE, 'utf8');
  const union = /export type DeathReasonClass =([\s\S]*?);/.exec(evalSource);
  const evalClasses = [...(union?.[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((m) => m[1] ?? '');

  /** Eval classes production cannot assign, with the reason. Exact: an entry
   *  that stops being true must leave, and a new eval class must be placed. */
  const EVAL_ONLY: Record<string, string> = {
    answer_not_grounded: 'needs the task’s success criterion, which production never has',
    answer_was_not_an_extraction: 'needs the task’s success criterion',
    criterion_not_met: 'needs the task’s success criterion',
    selector_rejected_before_dispatch:
      'needs the device dispatch log; at the route it is one of the `invalid_parameter` deaths',
    intent_not_mappable:
      'needs the device dispatch log; at the route it is one of the `invalid_parameter` deaths',
    navigated_but_page_never_loaded:
      'needs the device dispatch log; the executor reports that step as a success',
  };

  it('the scan found the eval union — an empty list would make both checks below vacuous', () => {
    expect(evalClasses.length).toBeGreaterThan(10);
    expect(evalClasses).toContain('element_never_appeared_in_retry_budget');
  });

  it('CRITICAL every eval class is either a production class under the SAME name or a recorded eval-only class', () => {
    const production = new Set<string>(AGENT_TURN_DEATH_REASONS);
    const unplaced = evalClasses.filter((c) => !production.has(c) && EVAL_ONLY[c] === undefined);
    expect(
      unplaced,
      'eval death class(es) with no production counterpart and no EVAL_ONLY reason — mirror the name in AGENT_TURN_DEATH_REASONS (and widen the CHECK), or record why production cannot assign it:',
    ).toEqual([]);
  });

  it('no EVAL_ONLY entry has gone stale', () => {
    const production = new Set<string>(AGENT_TURN_DEATH_REASONS);
    expect(Object.keys(EVAL_ONLY).filter((c) => !evalClasses.includes(c))).toEqual([]);
    expect(Object.keys(EVAL_ONLY).filter((c) => production.has(c))).toEqual([]);
  });
});
