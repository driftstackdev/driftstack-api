// The rate-card migration seeds the launch card at list price × 2.0, and the
// seed is exactly the api-types constant.
//
// Three statements of the same prices exist and nothing derives one from
// another at run time, on purpose: the migration's INSERT is what the database
// holds, `CREDIT_RATE_CARD_V1` is what the code prices with, and `CLAUDE_MODELS`
// is the provider's list price. A disagreement between the first two is a
// customer charged one figure and shown another; a disagreement with the third
// is a card that is not list × markup. So the INSERT is PARSED out of the SQL —
// comments stripped first, so a commented-out row cannot satisfy it — and held
// equal to the constant, and each row is re-derived from the registry here.
//
// The integration file `the-database-refuses-a-rate-card-without-notice-or-with-an-opus-price`
// reads the same rows back from a migrated database; this one needs no database
// and fails at commit time.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  AI_CREDITS_MODEL_DECISION,
  AgentModelSchema,
  CLAUDE_MODELS,
  CLAUDE_MODEL_KEY_POLICY,
  CREDIT_RATE_CARD_V1,
  MARKUP_BASIS_POINTS_PER_UNIT,
  type AgentModel,
  type CreditRateCardModelRow,
} from '@driftstack/api-types';
import { deriveRateCardRows } from '../../src/services/credit-rate-card-publisher.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATION = resolve(HERE, '../../src/db/migrations/0127_credit_rate_cards.sql');

/**
 * SQL with `--` and `/* *\/` comments removed, string literals left intact — a
 * `--` inside a quoted string is text, not a comment. Newlines are kept.
 */
function sqlCodeOnly(sql: string): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i] as string;
    const next = sql[i + 1];
    if (inString) {
      out += ch;
      if (ch === "'" && next === "'") {
        out += next;
        i += 1;
      } else if (ch === "'") {
        inString = false;
      }
      continue;
    }
    if (ch === "'") {
      inString = true;
      out += ch;
    } else if (ch === '-' && next === '-') {
      while (i < sql.length && sql[i] !== '\n') i += 1;
      out += '\n';
    } else if (ch === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      const skipped = sql.slice(i, end === -1 ? sql.length : end + 2);
      out += skipped.replace(/[^\n]/g, '');
      i = end === -1 ? sql.length : end + 1;
    } else {
      out += ch;
    }
  }
  return out;
}

type SqlValue = number | string | { call: string };

/** One scalar of a VALUES tuple: an integer, a quoted string, or a bare call like now(). */
function parseValue(token: string): SqlValue {
  const t = token.trim();
  if (/^-?\d+$/.test(t)) return Number(t);
  if (/^'(?:[^']|'')*'$/.test(t)) return t.slice(1, -1).replace(/''/g, "'");
  if (/^[a-z_]+\(\)$/i.test(t)) return { call: t.toLowerCase() };
  throw new Error(`unparsed SQL value: ${t}`);
}

/** Split on commas that are outside quotes and parentheses. */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inString = false;
  let current = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] as string;
    if (inString) {
      current += ch;
      if (ch === "'" && text[i + 1] === "'") {
        current += "'";
        i += 1;
      } else if (ch === "'") inString = false;
      continue;
    }
    if (ch === "'") inString = true;
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else current += ch;
  }
  if (current.trim() !== '') parts.push(current);
  return parts;
}

/** Every `INSERT INTO "<table>" (cols) VALUES (…), (…);` in the code, as column → value records. */
function insertsInto(sql: string, table: string): Array<Array<Record<string, SqlValue>>> {
  const code = sqlCodeOnly(sql);
  const out: Array<Array<Record<string, SqlValue>>> = [];
  const re = new RegExp(
    `INSERT\\s+INTO\\s+"?${table}"?\\s*\\(([^)]*)\\)\\s*VALUES\\s*([^;]*);`,
    'gi',
  );
  for (const m of code.matchAll(re)) {
    const columns = (m[1] ?? '').split(',').map((c) => c.trim().replace(/^"|"$/g, ''));
    const tuples = splitTopLevel(m[2] ?? '').map((t) => t.trim());
    out.push(
      tuples.map((tuple) => {
        if (!tuple.startsWith('(') || !tuple.endsWith(')'))
          throw new Error(`not a tuple: ${tuple}`);
        const values = splitTopLevel(tuple.slice(1, -1)).map(parseValue);
        if (values.length !== columns.length) {
          throw new Error(`${String(values.length)} values for ${String(columns.length)} columns`);
        }
        return Object.fromEntries(columns.map((c, i) => [c, values[i] as SqlValue]));
      }),
    );
  }
  return out;
}

/** The row fields of the constant, by the column that stores each. */
const COLUMN_OF: Record<keyof CreditRateCardModelRow, string> = {
  inputMicroPerToken: 'input_micro_per_token',
  outputMicroPerToken: 'output_micro_per_token',
  cacheReadMicroPerToken: 'cache_read_micro_per_token',
  cacheWrite5mMicroPerToken: 'cache_write_5m_micro_per_token',
  cacheWrite1hMicroPerToken: 'cache_write_1h_micro_per_token',
  minStartMicro: 'min_start_micro',
  maxReserveMicro: 'max_reserve_micro',
  listInputMicrocentsPerToken: 'list_input_microcents_per_token',
  listOutputMicrocentsPerToken: 'list_output_microcents_per_token',
};

/** A list price in cents per 1k tokens × a multiplier × a markup, as a whole number of µcr per token. */
function derive(centsPer1k: number, multiplier: number, markup: number, what: string): number {
  const value = centsPer1k * 1000 * multiplier * markup;
  const whole = Math.round(value);
  expect(Math.abs(value - whole), `${what} = ${String(value)} is not whole`).toBeLessThan(1e-9);
  return whole;
}

const migrationSql = readFileSync(MIGRATION, 'utf8');

function seededModels(): Map<string, Record<string, SqlValue>> {
  const inserts = insertsInto(migrationSql, 'credit_rate_card_models');
  expect(inserts, 'exactly one INSERT seeds the model prices').toHaveLength(1);
  const rows = inserts[0] ?? [];
  const byModel = new Map<string, Record<string, SqlValue>>();
  for (const row of rows) {
    const { model } = row;
    if (typeof model !== 'string') throw new Error('a seeded row has no quoted model id');
    byModel.set(model, row);
  }
  expect(byModel.size, 'no model is seeded twice').toBe(rows.length);
  return byModel;
}

describe('the rate-card migration seeds the launch card at list price × 2.0', () => {
  it('CRITICAL the parser reads real INSERTs and ignores commented ones. Every assertion below compares parsed values, so a parser that returned nothing, or read a row out of a comment, would compare the wrong thing and could still agree.', () => {
    const fixture = [
      '-- INSERT INTO "t" ("a", "b") VALUES (9, \'commented\');',
      '/* INSERT INTO "t" ("a", "b") VALUES (8, \'blocked\'); */',
      'INSERT INTO "t" ("a", "b", "c") VALUES',
      "  (1, 'x -- not a comment', now()),",
      "  (2, 'it''s', 3); -- trailing",
    ].join('\n');
    expect(insertsInto(fixture, 't')).toEqual([
      [
        { a: 1, b: 'x -- not a comment', c: { call: 'now()' } },
        { a: 2, b: "it's", c: 3 },
      ],
    ]);
    // And the real file parses to a real population.
    expect(seededModels().size, 'model rows seeded by 0127').toBeGreaterThanOrEqual(3);
  });

  it('CRITICAL the card row is version 1 at the constant markup and note, effective at once', () => {
    const inserts = insertsInto(migrationSql, 'credit_rate_cards');
    expect(inserts, 'exactly one INSERT seeds the card').toHaveLength(1);
    expect(inserts[0]).toEqual([
      {
        version: CREDIT_RATE_CARD_V1.version,
        markup_bp: CREDIT_RATE_CARD_V1.markupBp,
        effective_at: { call: 'now()' },
        note: CREDIT_RATE_CARD_V1.note,
      },
    ]);
    expect(CREDIT_RATE_CARD_V1.markupBp / MARKUP_BASIS_POINTS_PER_UNIT).toBe(2);
  });

  it('CRITICAL every seeded row equals CREDIT_RATE_CARD_V1 field for field, and they price the same models', () => {
    const seeded = seededModels();
    const constant = CREDIT_RATE_CARD_V1.models as Readonly<Record<string, CreditRateCardModelRow>>;
    expect([...seeded.keys()].sort()).toEqual(Object.keys(constant).sort());
    for (const [model, row] of seeded) {
      const expected = constant[model];
      expect(expected, `${model} is in the constant`).toBeDefined();
      expect(row.version, `${model} version`).toBe(CREDIT_RATE_CARD_V1.version);
      for (const [field, column] of Object.entries(COLUMN_OF) as Array<
        [keyof CreditRateCardModelRow, string]
      >) {
        expect(row[column], `${model}.${column}`).toBe(expected?.[field]);
      }
      expect(Object.keys(row).sort(), `${model}: the seed writes every column`).toEqual(
        ['model', 'version', ...Object.values(COLUMN_OF)].sort(),
      );
    }
  });

  it('CRITICAL every seeded price is the registry list price × the markup, derived here per model and per kind of token', () => {
    const markup = CREDIT_RATE_CARD_V1.markupBp / MARKUP_BASIS_POINTS_PER_UNIT;
    for (const [model, row] of seededModels()) {
      const list = CLAUDE_MODELS[model as AgentModel];
      expect(list, `${model} is in the list-price registry`).toBeDefined();
      expect(row.input_micro_per_token, `${model} input`).toBe(
        derive(list.inputCentsPer1k, 1, markup, `${model} input`),
      );
      expect(row.output_micro_per_token, `${model} output`).toBe(
        derive(list.outputCentsPer1k, 1, markup, `${model} output`),
      );
      expect(row.cache_read_micro_per_token, `${model} cache read`).toBe(
        derive(list.inputCentsPer1k, list.cacheReadMultiplier, markup, `${model} read`),
      );
      expect(row.cache_write_5m_micro_per_token, `${model} 5-minute write`).toBe(
        derive(list.inputCentsPer1k, list.cacheWrite5mMultiplier, markup, `${model} 5m`),
      );
      expect(row.cache_write_1h_micro_per_token, `${model} 1-hour write`).toBe(
        derive(list.inputCentsPer1k, list.cacheWrite1hMultiplier, markup, `${model} 1h`),
      );
      expect(row.list_input_microcents_per_token, `${model} list input`).toBe(
        derive(list.inputCentsPer1k, 1, 1, `${model} list input`),
      );
      expect(row.list_output_microcents_per_token, `${model} list output`).toBe(
        derive(list.outputCentsPer1k, 1, 1, `${model} list output`),
      );
    }
  });

  it('CRITICAL no seeded model is Opus-class or may only run on the customer key, and each is a model the registry knows', () => {
    for (const model of seededModels().keys()) {
      expect(model, 'the database refuses any id containing opus').not.toMatch(/opus/i);
      const parsed = AgentModelSchema.safeParse(model);
      expect(parsed.success, `${model} is a known model id`).toBe(true);
      const id = model as AgentModel;
      expect(CLAUDE_MODEL_KEY_POLICY[id], `${model} key policy`).toBe('any_key');
      expect(AI_CREDITS_MODEL_DECISION[id], `${model} credits decision`).toBe('on_credits');
    }
  });

  it('the publisher, given the launch markup and limits, derives exactly the seeded rows — the SQL, the constant and the publishing path agree', () => {
    const seeded = seededModels();
    const result = deriveRateCardRows({
      markupBp: CREDIT_RATE_CARD_V1.markupBp,
      models: Object.entries(CREDIT_RATE_CARD_V1.models).map(([model, row]) => ({
        model,
        minStartMicro: row.minStartMicro,
        maxReserveMicro: row.maxReserveMicro,
      })),
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.rows.map((r) => r.model).sort()).toEqual([...seeded.keys()].sort());
    for (const derived of result.rows) {
      const row = seeded.get(derived.model);
      for (const [field, column] of Object.entries(COLUMN_OF) as Array<
        [keyof CreditRateCardModelRow, string]
      >) {
        expect(row?.[column], `${derived.model}.${column}`).toBe(derived[field]);
      }
    }
  });
});
