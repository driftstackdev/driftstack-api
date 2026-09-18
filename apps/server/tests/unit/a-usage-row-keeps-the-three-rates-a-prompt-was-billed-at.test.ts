// A usage row keeps the three rates a prompt was billed at.
//
// Once prompt caching is on, the provider's `input_tokens` is only the UNCACHED
// remainder of the prompt. A row that stored it alone would record a 9,000-token
// cached call as a 40-token one, and — because uncached, cache-written and
// cache-read tokens bill at three different rates — could never be re-priced
// after the fact. So the row carries all three, under the provider's own names.
//
// And the monthly bundled cap must stay TRUE: it sums a FLAT per-turn amount,
// so nothing about how cheaply the cache served a turn may move it.

import { describe, expect, it } from 'vitest';
import type { Logger } from 'pino';
import { DrizzleAgentDecomposerUsageRecorder } from '../../src/db/agent-decomposer-usage-recorder.js';
import type { Database } from '../../src/db/client.js';
import { __TEST_ONLY__ } from '../../src/services/agent-decomposer-claude.js';

interface CapturedInsert {
  recordType: string;
  metadata: Record<string, unknown>;
}

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

// Built by the REAL usage assembler, so this test follows the field from the
// parsed provider block to the stored row instead of restating its shape.
const cachedUsage = __TEST_ONLY__.makeClaudeUsage(
  40,
  200,
  'claude-opus-5',
  {
    inputTokens: 40,
    outputTokens: 200,
    cacheCreationInputTokens: 300,
    cacheReadInputTokens: 9_000,
    cacheCreation5mInputTokens: 300,
    cacheCreation1hInputTokens: 0,
    thinkingTokens: 120,
  },
  'end_turn',
);

const base = {
  accountId: '00000000-0000-4000-8000-0000000000a1',
  driftstackSessionId: null,
  agentSessionId: 'agt_00000000-0000-4000-8000-0000000000a2',
  decomposeResultKind: 'plan' as const,
  usage: cachedUsage,
  tokensConsumed: 1_515,
  now: new Date('2026-09-18T00:00:00.000Z'),
};

describe('a usage row keeps the three rates a prompt was billed at', () => {
  it('writes the cache counts, the prompt size, the thinking share and the stop reason on a customer-key row', async () => {
    const { recorder, rows } = recorderWithCapture();
    await recorder.record({ ...base, keySource: 'header' });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.recordType).toBe('agent_decomposer');
    expect(rows[0]!.metadata).toMatchObject({
      anthropic_input_tokens: 40,
      anthropic_output_tokens: 200,
      anthropic_cache_creation_input_tokens: 300,
      anthropic_cache_read_input_tokens: 9_000,
      anthropic_cache_creation_5m_input_tokens: 300,
      anthropic_cache_creation_1h_input_tokens: 0,
      anthropic_prompt_tokens: 9_340,
      anthropic_thinking_tokens: 120,
      anthropic_stop_reason: 'end_turn',
      tokens_consumed: 1_515,
    });
    // 40 × 0.5c/1k + 200 × 2.5c/1k + (300 × 1.25 + 9000 × 0.1) × 0.5c/1k
    //   = 0.02 + 0.5 + 0.6375 = 1.1575c → 2 (rounded up, as every row is).
    // At FULL input price the same call would have been 5.17c → 6.
    expect(rows[0]!.metadata.cost_usd_cents).toBe(2);
  });

  it('⛔ the bundled row still posts the FLAT amount — the monthly cap cannot move with the hit rate', async () => {
    const { recorder, rows } = recorderWithCapture();
    await recorder.record({ ...base, keySource: 'bundled' });
    expect(rows[0]!.recordType).toBe('agent_decomposer_bundled');
    expect(rows[0]!.metadata.cost_usd_cents).toBe(10);
    expect(rows[0]!.metadata.cost_basis).toBe('bundled_flat_per_turn');
    // The counts are still written: they are how anyone can tell whether the
    // flat price still covers what a turn costs to serve.
    expect(rows[0]!.metadata.anthropic_cache_read_input_tokens).toBe(9_000);
  });

  it('a call the cache never touched records explicit zeros, not missing fields', async () => {
    const { recorder, rows } = recorderWithCapture();
    await recorder.record({
      ...base,
      usage: __TEST_ONLY__.makeClaudeUsage(120, 80, 'claude-opus-5'),
      tokensConsumed: 200,
      keySource: 'header',
    });
    expect(rows[0]!.metadata.anthropic_cache_creation_input_tokens).toBe(0);
    expect(rows[0]!.metadata.anthropic_cache_read_input_tokens).toBe(0);
    expect(rows[0]!.metadata.anthropic_prompt_tokens).toBe(120);
    // Absent, not zero: the provider sent no breakdown and no stop reason.
    expect('anthropic_cache_creation_5m_input_tokens' in rows[0]!.metadata).toBe(false);
    expect('anthropic_stop_reason' in rows[0]!.metadata).toBe(false);
  });

  it('a deterministic (no-model) row gains no cache fields at all', async () => {
    const { recorder, rows } = recorderWithCapture();
    await recorder.record({
      ...base,
      usage: { decomposerKind: 'deterministic' },
      tokensConsumed: 0,
    });
    for (const key of Object.keys(rows[0]!.metadata)) {
      expect(key.startsWith('anthropic_')).toBe(false);
    }
  });
});
