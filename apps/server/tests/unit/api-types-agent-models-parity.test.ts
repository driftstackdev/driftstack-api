// Drift guard for packages/api-types/src/agent-models.ts — the per-session
// model-picker registry (#15 / 6.c). Pins the selectable Claude 4.x lineup +
// the founder-confirmed Anthropic LIST PRICE per model (2026-05-27 decision:
// real list price, not the retired Opus 4.1 figure). These rates feed the
// usage writer + cost monitor, so a drift silently mis-charges cost-to-serve.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { AgentModelSchema, CLAUDE_MODELS, DEFAULT_AGENT_MODEL } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

describe('agent-models registry parity', () => {
  it('AgentModelSchema = the 6 picker models: Claude 5 (Opus/Sonnet) first, then 4.x kept for back-compat', () => {
    expect(AgentModelSchema.options).toEqual([
      'claude-opus-5',
      'claude-sonnet-5',
      'claude-opus-4-8',
      'claude-opus-4-7',
      'claude-sonnet-4-6',
      'claude-haiku-4-5',
    ]);
  });

  it('DEFAULT_AGENT_MODEL is Opus 5 (current-generation, highest-capability default)', () => {
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

  it('⛔ V-2168: the GUI picker lists EXACTLY the registry models — owner "no Opus 5" was GUI/registry drift', () => {
    // The GUI keeps a hand-written MODELS array + a ChatModel union (it cannot
    // import the api-types RUNTIME registry — it depends on the SDK, which
    // exports the ids as a TYPE only). So a model added to the registry does not
    // reach the picker until someone edits the GUI too; the owner reported
    // exactly that gap. Pin both GUI copies to the registry as source of truth.
    const view = readFileSync(
      resolve(REPO_ROOT, 'apps/gui-client/src/views/AgentChatView.tsx'),
      'utf8',
    );
    const block = /const MODELS:[^[]*\[([\s\S]*?)\];/.exec(view)?.[1] ?? '';
    const pickerIds = [...block.matchAll(/id:\s*'([a-z0-9-]+)'/g)].map((m) => m[1]);
    expect(pickerIds).toEqual([...AgentModelSchema.options]);

    const chat = readFileSync(
      resolve(REPO_ROOT, 'apps/gui-client/src/lib/use-agent-chat.ts'),
      'utf8',
    );
    const union = /export type ChatModel =([\s\S]*?);/.exec(chat)?.[1] ?? '';
    const unionIds = [...union.matchAll(/'([a-z0-9-]+)'/g)].map((m) => m[1]);
    expect(unionIds.sort()).toEqual([...AgentModelSchema.options].sort());
  });
});
