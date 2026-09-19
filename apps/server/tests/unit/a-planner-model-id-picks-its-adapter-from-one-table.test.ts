// The provider table, and the factory that picks an adapter from a model id.
//
// ⛔ The non-Claude rows are EVAL-ONLY: nothing here may make one reachable by a
// customer, so the last arm checks the public enum still refuses them.

import { AgentModelSchema, CLAUDE_MODELS } from '@driftstack/api-types';
import { describe, expect, it } from 'vitest';
import { ClaudeAgentDecomposer } from '../../src/services/agent-decomposer-claude.js';
import { OpenAICompatibleAgentDecomposer } from '../../src/services/agent-decomposer-openai-compatible.js';
import {
  CHAT_PLANNER_MODELS,
  UnknownPlannerModelError,
  chatPricesOn,
  createPlannerDecomposer,
  resolvePlannerModel,
} from '../../src/services/agent-planner-providers.js';

describe('a planner model id picks its adapter from one table', () => {
  it('every Claude id — bare or anthropic:-qualified — builds exactly the adapter production builds', () => {
    for (const id of Object.keys(CLAUDE_MODELS)) {
      for (const spelled of [id, `anthropic:${id}`]) {
        const { decomposer, selection } = createPlannerDecomposer(spelled);
        expect(decomposer).toBeInstanceOf(ClaudeAgentDecomposer);
        expect(selection).toEqual({ kind: 'claude', model: id });
      }
    }
  });

  it('every chat row builds the chat-completions adapter aimed at that row: its endpoint, its model id, its controls', () => {
    for (const row of CHAT_PLANNER_MODELS) {
      const { decomposer } = createPlannerDecomposer(row.qualifiedId, {
        chat: { apiKey: 'sk-test' },
        day: new Date('2026-09-18T00:00:00Z'),
      });
      expect(decomposer).toBeInstanceOf(OpenAICompatibleAgentDecomposer);
      const target = (decomposer as OpenAICompatibleAgentDecomposer).target;
      expect(target).toMatchObject({
        qualifiedId: row.qualifiedId,
        baseUrl: row.provider.baseUrl,
        model: row.model,
        replyFormat: row.replyFormat,
        reasoningEffort: row.reasoningEffort,
        maxTokensParam: row.maxTokensParam,
        prices: row.prices,
      });
    }
  });

  it('a chat row without its provider key refuses to build, naming the variable (never a value)', () => {
    expect(() => createPlannerDecomposer('openai:gpt-5.6-luna')).toThrow(/OPENAI_API_KEY/);
    expect(() => createPlannerDecomposer('openai:gpt-5.6-luna', { chat: { apiKey: '' } })).toThrow(
      /OPENAI_API_KEY/,
    );
  });

  it('an unknown id throws, listing what would have been accepted — a typo must never measure a different model', () => {
    for (const id of [
      'gpt-5.6-luna',
      'openai:gpt-5',
      'claude-sonnet',
      'google:gemini-3.8-flash ',
    ]) {
      if (id.trim() === 'google:gemini-3.8-flash') {
        // Surrounding whitespace is forgiven; the id itself is not guessed at.
        expect(resolvePlannerModel(id).kind).toBe('chat');
        continue;
      }
      expect(() => resolvePlannerModel(id)).toThrow(UnknownPlannerModelError);
    }
    expect(() => resolvePlannerModel('nope')).toThrow(/openai:gpt-5\.6-luna/);
  });

  it('the table is complete and self-describing: every shortlisted provider, unique ids, https docs for every control and price, a key variable per provider, and prices that can bound a spend cap', () => {
    const ids = CHAT_PLANNER_MODELS.map((m) => m.qualifiedId);
    expect(new Set(ids).size).toBe(ids.length);
    const providers = new Set(CHAT_PLANNER_MODELS.map((m) => m.provider.id));
    for (const expected of [
      'openai',
      'google',
      'baseten',
      'fireworks',
      'cerebras',
      'mistral',
      'inception',
      // The one-key comparison: every arm through a single aggregator key.
      'openrouter',
    ]) {
      expect(providers.has(expected), expected).toBe(true);
    }
    for (const row of CHAT_PLANNER_MODELS) {
      expect(row.qualifiedId.startsWith(`${row.provider.id}:`)).toBe(true);
      expect(row.provider.baseUrl).toMatch(/^https:\/\/[^/]+.*[^/]$/);
      expect(row.provider.keyEnvVar).toMatch(/^[A-Z][A-Z0-9_]+_API_KEY$/);
      for (const source of [row.provider.docsUrl, row.replyFormatSource, row.reasoningSource]) {
        expect(source, row.qualifiedId).toMatch(/^https:\/\//);
      }
      // A price either cites its page or says plainly that it was not re-fetched.
      if (!row.priceSource.startsWith('https://')) {
        expect(
          row.unverified.some((u) => /price/.test(u)),
          row.qualifiedId,
        ).toBe(true);
      }
      for (const prices of [row.prices, row.priceChange?.prices].filter((p) => p !== undefined)) {
        expect(prices.inputUsdPerMTok).toBeGreaterThan(0);
        expect(prices.outputUsdPerMTok).toBeGreaterThan(0);
        expect(prices.cachedInputUsdPerMTok).toBeGreaterThan(0);
        expect(prices.cachedInputUsdPerMTok).toBeLessThanOrEqual(prices.inputUsdPerMTok);
      }
    }
    // Every key variable is distinct per provider and none is Anthropic's.
    const keyVars = new Map(CHAT_PLANNER_MODELS.map((m) => [m.provider.id, m.provider.keyEnvVar]));
    expect(new Set(keyVars.values()).size).toBe(keyVars.size);
    for (const name of keyVars.values()) expect(name).not.toMatch(/ANTHROPIC/);
  });

  it('a scheduled price change applies from its day: Gemini doubles on 2027-01-01', () => {
    const gemini = CHAT_PLANNER_MODELS.find((m) => m.qualifiedId === 'google:gemini-3.8-flash')!;
    expect(chatPricesOn(gemini, new Date('2026-12-31T23:59:59Z')).inputUsdPerMTok).toBe(0.75);
    expect(chatPricesOn(gemini, new Date('2027-01-01T00:00:00Z')).inputUsdPerMTok).toBe(1.5);
  });

  it('⛔ EVAL-ONLY: no chat row is a model the product accepts — the public enum still refuses every one', () => {
    for (const row of CHAT_PLANNER_MODELS) {
      expect(AgentModelSchema.safeParse(row.qualifiedId).success).toBe(false);
      expect(AgentModelSchema.safeParse(row.model).success).toBe(false);
    }
  });
});
