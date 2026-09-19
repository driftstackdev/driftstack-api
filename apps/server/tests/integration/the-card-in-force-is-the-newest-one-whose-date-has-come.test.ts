// The credit rate card in force is the newest card whose date has come and that
// was not withdrawn — read through `DrizzleCreditRateCardRepo` on a real
// database, with cards published the only way the database allows: each card
// and its prices in one transaction, and a withdrawal later.
//
// A second card's prices here come from `deriveRateCardRows` (the publisher's
// validation) at a 3.0 × markup, so this also shows the publisher's rows are
// rows the database accepts, and read back unchanged. (Not 2.5 ×: that would
// make Sonnet 4.6's 5-minute write 937.5 microcredits, and the publisher
// refuses a fractional price rather than rounding it.)
//
// Instants are truncated to milliseconds before they are written, and read
// back as epoch milliseconds: the column holds microseconds and a JavaScript
// Date does not, and the Drizzle driver leaves the shared client returning
// timestamps as text, so neither a Date nor a string round-trips exactly.

import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CREDIT_RATE_CARD_V1, type CreditRateCardModelRow } from '@driftstack/api-types';
import { createDb } from '../../src/db/client.js';
import {
  DrizzleCreditRateCardRepo,
  type CreditRateCardRecord,
} from '../../src/db/credit-rate-card-repo.js';
import { deriveRateCardRows } from '../../src/services/credit-rate-card-publisher.js';
import { assertIsolatedDatabase } from './_helpers/isolated-database.js';
import { ensureFreshIsolatedDatabase } from './_helpers/fresh-isolated-database.js';

const ISOLATED_DB_NAME = 'driftstack_iso_credit_rate_card_repo';
const RUN_DB_TESTS = Boolean(process.env.CI || process.env.DATABASE_URL);
const HOUR = 3_600_000;

let database: ReturnType<typeof createDb> | null = null;
let repo: DrizzleCreditRateCardRepo | null = null;

beforeAll(async () => {
  if (!RUN_DB_TESTS) return;
  const url = await ensureFreshIsolatedDatabase(ISOLATED_DB_NAME);
  if (url === null) return;
  const candidate = createDb(url, { max: 3 });
  try {
    await candidate.client`SELECT 1`;
  } catch {
    await candidate.close().catch(() => {});
    return;
  }
  await assertIsolatedDatabase(candidate.client, ISOLATED_DB_NAME);
  database = candidate;
  repo = new DrizzleCreditRateCardRepo(candidate);
}, 60_000);

afterAll(async () => {
  await database?.close().catch(() => {});
});

function sql(): postgres.Sql {
  if (database === null) throw new Error('isolated database unreachable');
  return database.client;
}

function cards(): DrizzleCreditRateCardRepo {
  if (repo === null) throw new Error('isolated database unreachable');
  return repo;
}

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

const LAUNCH_TERMS = Object.entries(CREDIT_RATE_CARD_V1.models).map(([model, row]) => ({
  model,
  minStartMicro: row.minStartMicro,
  maxReserveMicro: row.maxReserveMicro,
}));

/**
 * Publish a card taking effect `hours` from now (to the millisecond), with the
 * publisher's rows at `markupBp`, in one transaction. Returns its effective instant.
 */
async function publish(version: number, hours: number, markupBp = 20_000): Promise<Date> {
  const derived = deriveRateCardRows({ markupBp, models: LAUNCH_TERMS });
  if (!derived.ok) throw new Error(`publisher refused: ${JSON.stringify(derived.refusals)}`);
  return sql().begin(async (tx) => {
    const [row] = await tx<Array<{ ms: string }>>`
      INSERT INTO credit_rate_cards (version, markup_bp, effective_at, note)
      VALUES (${version}, ${markupBp},
              date_trunc('milliseconds', now() + make_interval(hours => ${hours})), 'test card')
      RETURNING (extract(epoch FROM effective_at) * 1000)::bigint::text AS ms`;
    for (const { model, ...prices } of derived.rows) {
      const columns: Record<string, string | number> = { version, model };
      for (const [field, column] of Object.entries(COLUMN_OF) as Array<
        [keyof CreditRateCardModelRow, string]
      >) {
        columns[column] = prices[field];
      }
      await tx`INSERT INTO credit_rate_card_models ${tx(columns)}`;
    }
    if (row === undefined) throw new Error('card insert returned no row');
    return new Date(Number(row.ms));
  });
}

const version = (c: CreditRateCardRecord | null): number | null => c?.version ?? null;

describe.skipIf(!RUN_DB_TESTS)('the card in force is the newest one whose date has come', () => {
  it('the isolated database was rebuilt from the migrations and is reachable — otherwise every arm below would fail on setup, not on what it proves', () => {
    expect(database, 'isolated Postgres database could not be created or reached').not.toBeNull();
  });

  it('with only the launch card, the card in force now is version 1, as seeded', async () => {
    const now = await cards().cardInForce();
    expect(now).toMatchObject({
      version: 1,
      markupBp: CREDIT_RATE_CARD_V1.markupBp,
      note: CREDIT_RATE_CARD_V1.note,
      withdrawnAt: null,
      createdByKeyId: null,
    });
    expect(now?.announcedAt.getTime()).toBe(now?.effectiveAt.getTime());
  });

  it('before the launch card took effect no card was in force — null, not the nearest card', async () => {
    const launch = await cards().cardInForce();
    if (launch === null) throw new Error('no launch card');
    expect(await cards().cardInForce(new Date(launch.effectiveAt.getTime() - 1_000))).toBeNull();
  });

  it('CRITICAL an announced card is not in force before its date and is from that instant; the database clock decides "now"', async () => {
    // 721, not 720: truncating to the millisecond lands up to 1 ms early, and
    // the database refuses a card announced even that little under 720 hours.
    const at = await publish(2, 721, 30_000);
    expect(version(await cards().cardInForce()), 'now: still the launch card').toBe(1);
    expect(
      version(await cards().cardInForce(new Date(at.getTime() - 1))),
      'a millisecond before',
    ).toBe(1);
    expect(version(await cards().cardInForce(at)), 'at its effective instant').toBe(2);
    expect(version(await cards().cardInForce(new Date(at.getTime() + 24 * HOUR)))).toBe(2);
  });

  it('CRITICAL a withdrawn card is never in force, and the card before it stays in force past its date', async () => {
    const at = await publish(3, 800);
    expect(version(await cards().cardInForce(at)), 'live, it would be in force').toBe(3);
    await sql()`UPDATE credit_rate_cards SET withdrawn_at = now() WHERE version = 3`;
    expect(version(await cards().cardInForce(at)), 'withdrawn, the previous card is').toBe(2);
    expect(version(await cards().cardInForce(new Date(at.getTime() + 24 * HOUR)))).toBe(2);
  });

  it('CRITICAL "newest" means latest effective date, not highest version number', async () => {
    // Version 5 takes effect BEFORE version 4.
    const at5 = await publish(5, 900);
    const at4 = await publish(4, 1000);
    expect(at5.getTime()).toBeLessThan(at4.getTime());
    expect(version(await cards().cardInForce(new Date(at5.getTime() + HOUR)))).toBe(5);
    expect(version(await cards().cardInForce(new Date(at4.getTime() + HOUR)))).toBe(4);
  });

  it('CRITICAL a model row reads back exactly as the constant for every model the launch card prices', async () => {
    for (const [model, expected] of Object.entries(CREDIT_RATE_CARD_V1.models)) {
      expect(await cards().modelRow(1, model), model).toEqual({ version: 1, model, ...expected });
    }
  });

  it('a later card returns its own prices — the 3.0 × card charges 3.0 × list, not the launch prices', async () => {
    const row = await cards().modelRow(2, 'claude-sonnet-5');
    const launch = CREDIT_RATE_CARD_V1.models['claude-sonnet-5'];
    expect(row?.inputMicroPerToken).toBe((launch.inputMicroPerToken * 3) / 2);
    expect(row?.outputMicroPerToken).toBe((launch.outputMicroPerToken * 3) / 2);
    expect(row?.cacheWrite5mMicroPerToken).toBe((launch.cacheWrite5mMicroPerToken * 3) / 2);
    expect(row?.listInputMicrocentsPerToken).toBe(launch.listInputMicrocentsPerToken);
  });

  it('CRITICAL there is no row for an Opus model, an unknown id, or a card that does not exist — null, never a default price', async () => {
    expect(await cards().modelRow(1, 'claude-opus-5')).toBeNull();
    expect(await cards().modelRow(1, 'claude-sonnet-99')).toBeNull();
    expect(await cards().modelRow(999, 'claude-sonnet-5')).toBeNull();
    // Positive control: the same lookups on real keys do find rows.
    expect(await cards().modelRow(1, 'claude-sonnet-5')).not.toBeNull();
  });

  it('CRITICAL a stored price past 2^53 is refused on read, never rounded — a rounded price is a wrong charge that looks right', async () => {
    // The columns are bigint and the database puts no ceiling on a price, so
    // this row is valid SQL. Read as a JavaScript number, 2^53 + 1 becomes 2^53.
    await sql().begin(async (tx) => {
      await tx`
        INSERT INTO credit_rate_cards (version, markup_bp, effective_at, note)
        VALUES (90, 20000, now() + interval '5000 hours', 'test card: prices past 2^53')`;
      for (const [model, v] of [
        ['claude-sonnet-5', '9007199254740993'],
        ['claude-haiku-4-5', String(Number.MAX_SAFE_INTEGER)],
      ] as const) {
        await tx`
          INSERT INTO credit_rate_card_models (
            version, model, input_micro_per_token, output_micro_per_token,
            cache_read_micro_per_token, cache_write_5m_micro_per_token,
            cache_write_1h_micro_per_token, min_start_micro, max_reserve_micro,
            list_input_microcents_per_token, list_output_microcents_per_token)
          VALUES (90, ${model}, ${v}::bigint, ${v}::bigint, 0, ${v}::bigint, ${v}::bigint,
                  1, ${v}::bigint, 1, 1)`;
      }
    });
    await expect(cards().modelRow(90, 'claude-sonnet-5')).rejects.toThrow(
      /input_micro_per_token is not a safe integer/,
    );
    // Positive control: the largest safe integer reads back exactly.
    const safe = await cards().modelRow(90, 'claude-haiku-4-5');
    expect(safe?.inputMicroPerToken).toBe(Number.MAX_SAFE_INTEGER);
    expect(safe?.maxReserveMicro).toBe(Number.MAX_SAFE_INTEGER);
  });
});
