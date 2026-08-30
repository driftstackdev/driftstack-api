// Drift guard for packages/api-types/src/agent-models.ts — the per-session
// model-picker registry (#15 / 6.c). Pins the selectable Claude 4.x lineup +
// the founder-confirmed Anthropic LIST PRICE per model (2026-05-27 decision:
// real list price, not the retired Opus 4.1 figure). These rates feed the
// usage writer + cost monitor, so a drift silently mis-charges cost-to-serve.

import { describe, expect, it } from 'vitest';
import { AgentModelSchema, CLAUDE_MODELS, DEFAULT_AGENT_MODEL } from '@driftstack/api-types';

describe('agent-models registry parity', () => {
  it('AgentModelSchema = the 4 Claude 4.x picker models (Opus 4.8 added; 4.7 kept for back-compat)', () => {
    expect(AgentModelSchema.options).toEqual([
      'claude-opus-5',
      'claude-sonnet-5',
      'claude-opus-4-8',
      'claude-opus-4-7',
      'claude-sonnet-4-6',
      'claude-haiku-4-5',
    ]);
  });

  it('DEFAULT_AGENT_MODEL is Opus 4.8 (latest/highest-capability default)', () => {
    expect(DEFAULT_AGENT_MODEL).toBe('claude-opus-5');
  });

  it('CLAUDE_MODELS covers every AgentModel with a label + rates', () => {
    expect(Object.keys(CLAUDE_MODELS).sort()).toEqual([...AgentModelSchema.options].sort());
  });

  it('per-model rates = Anthropic list price in cents/1k ($/MTok ÷ 10)', () => {
    // Opus 4.8 — mirrors 4.7's list rate pending an Anthropic price update.
    expect(CLAUDE_MODELS['claude-opus-4-8'].inputCentsPer1k).toBe(0.5);
    expect(CLAUDE_MODELS['claude-opus-4-8'].outputCentsPer1k).toBe(2.5);
    // Opus 4.7 — $5 / $25 per MTok.
    expect(CLAUDE_MODELS['claude-opus-4-7'].inputCentsPer1k).toBe(0.5);
    expect(CLAUDE_MODELS['claude-opus-4-7'].outputCentsPer1k).toBe(2.5);
    // Sonnet 4.6 — $3 / $15 per MTok.
    expect(CLAUDE_MODELS['claude-sonnet-4-6'].inputCentsPer1k).toBe(0.3);
    expect(CLAUDE_MODELS['claude-sonnet-4-6'].outputCentsPer1k).toBe(1.5);
    // Haiku 4.5 — $1 / $5 per MTok.
    expect(CLAUDE_MODELS['claude-haiku-4-5'].inputCentsPer1k).toBe(0.1);
    expect(CLAUDE_MODELS['claude-haiku-4-5'].outputCentsPer1k).toBe(0.5);
  });

  it('labels are the human-facing model names', () => {
    expect(CLAUDE_MODELS['claude-opus-4-8'].label).toBe('Claude Opus 4.8');
    expect(CLAUDE_MODELS['claude-opus-4-7'].label).toBe('Claude Opus 4.7');
    expect(CLAUDE_MODELS['claude-sonnet-4-6'].label).toBe('Claude Sonnet 4.6');
    expect(CLAUDE_MODELS['claude-haiku-4-5'].label).toBe('Claude Haiku 4.5');
  });
});
