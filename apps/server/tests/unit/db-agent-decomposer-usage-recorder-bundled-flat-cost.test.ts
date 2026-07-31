// BEHAVIOURAL guard for the bundled-LLM flat charge.
//
// The bundled charge is a flat $0.10 per agent TURN — migration 0051 states the
// invariant ("one row of this type per bundled-LLM-served agent-session turn
// with a flat $0.10 posted cost"), and the customer docs, the dashboard settings
// page and the pricing page all promise "a flat $0.10 per agent turn".
//
// But a read-intent turn posts TWO usage rows (decompose + the #140 read-back),
// and the flat amount was written per ROW. One turn therefore debited $0.20: the
// monthly cap was consumed at 2x, the customer was hard-402'd after half the
// turns they were sold, and the turn's own API response still reported 10 — so
// their own reconciliation was off by 2x too.
//
// The pre-existing guard for this file is a SOURCE-TEXT parity test that pins
// `const POSTED_BUNDLED_COST_CENTS = 10;` as a string. It asserts the constant's
// spelling and exercises no behaviour, so it structurally cannot see how many
// rows a turn writes or what they sum to. This file asserts the written amount.

import { describe, expect, it } from 'vitest';
import type { Logger } from 'pino';
import { DrizzleAgentDecomposerUsageRecorder } from '../../src/db/agent-decomposer-usage-recorder.js';
import type { Database } from '../../src/db/client.js';

interface CapturedInsert {
  recordType: string;
  metadata: Record<string, unknown>;
}

/** Minimal Drizzle stand-in that captures the inserted row. */
function recorderWithCapture(): {
  recorder: DrizzleAgentDecomposerUsageRecorder;
  rows: CapturedInsert[];
} {
  const rows: CapturedInsert[] = [];
  const database = {
    db: {
      insert: () => ({
        values: (row: CapturedInsert) => {
          rows.push(row);
          return Promise.resolve();
        },
      }),
    },
  } as unknown as Database;
  const logger = {
    warn: () => undefined,
    error: () => undefined,
    info: () => undefined,
    debug: () => undefined,
  } as unknown as Logger;
  return { recorder: new DrizzleAgentDecomposerUsageRecorder(database, logger), rows };
}

const base = {
  accountId: '00000000-0000-4000-8000-0000000000a1',
  driftstackSessionId: null,
  agentSessionId: 'agt_00000000-0000-4000-8000-0000000000a2',
  decomposeResultKind: 'plan' as const,
  usage: { decomposerKind: 'claude' as const, costUsdCents: 37 },
  tokensConsumed: 100,
  now: new Date('2026-07-31T00:00:00.000Z'),
};

describe('bundled-LLM flat cost is posted once per TURN, not once per row', () => {
  it('charges the documented $0.10 on the turn, not $0.20, when a read-back posts a second row', async () => {
    const { recorder, rows } = recorderWithCapture();

    // Row 1 — the decompose pass carries the turn's flat charge.
    await recorder.record({ ...base, keySource: 'bundled' });
    // Row 2 — the #140 read-back pass, same turn.
    await recorder.record({
      ...base,
      keySource: 'bundled',
      bundledFlatCostAlreadyPosted: true,
    });

    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.recordType).toBe('agent_decomposer_bundled');

    // This total is what db/bundled-llm-repo.ts sums for the monthly cap and
    // what the customer reconciles against the per-turn cost the API reports.
    const total = rows.reduce((sum, r) => sum + Number(r.metadata.cost_usd_cents ?? 0), 0);
    expect(total).toBe(10);
    expect(rows[0]!.metadata.cost_usd_cents).toBe(10);
    expect(rows[1]!.metadata.cost_usd_cents).toBe(0);
  });

  it('keeps the documented cost_basis on both rows of the turn', async () => {
    const { recorder, rows } = recorderWithCapture();
    await recorder.record({ ...base, keySource: 'bundled' });
    await recorder.record({ ...base, keySource: 'bundled', bundledFlatCostAlreadyPosted: true });
    // The docs promise `cost_basis = 'bundled_flat_per_turn'` for auditability;
    // the turn still posts a flat $0.10 on that basis, so both rows keep it.
    for (const row of rows) expect(row.metadata.cost_basis).toBe('bundled_flat_per_turn');
  });

  it('never suppresses the upstream-derived cost on a BYOK turn, where both rows are real spend', async () => {
    const { recorder, rows } = recorderWithCapture();
    // No keySource → not bundled. Two rows of a read-intent turn each carry
    // their own real Anthropic-derived cost; the flag must not zero them.
    await recorder.record({ ...base });
    await recorder.record({ ...base, bundledFlatCostAlreadyPosted: true });

    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.recordType).toBe('agent_decomposer');
      expect(row.metadata.cost_usd_cents).toBe(37);
      expect(row.metadata.cost_basis).toBeUndefined();
    }
  });
});
