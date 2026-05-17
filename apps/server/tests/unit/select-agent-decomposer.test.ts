// Q.1 — unit tests for selectAgentDecomposer (bootstrap selection
// logic per Q.1.a + Q.1.a-open-answer verdicts 2026-05-17).
//
// 3-way decision matrix:
//   1. DRIFTSTACK_AGENT_DECOMPOSER_FORCE=deterministic → force
//      DeterministicAgentDecomposer regardless of key state.
//   2. fallbackApiKey OR mfaEncryptionKey present → wire
//      ClaudeAgentDecomposer (Q.1.a option 4: EITHER key path).
//   3. Neither present + no force → wire DeterministicAgentDecomposer
//      (safe default; agent-sessions still returns clarify/plan
//      output rather than 503ing the customer).

import { describe, expect, it } from 'vitest';
import { selectAgentDecomposer } from '../../src/lib/bootstrap.js';
import { ClaudeAgentDecomposer } from '../../src/services/agent-decomposer-claude.js';
import { DeterministicAgentDecomposer } from '../../src/services/agent-decomposer-deterministic.js';
import type { Config } from '../../src/lib/config.js';
import type { Logger } from '../../src/lib/logger.js';

function silentLogger(): Logger {
  const noop = (..._args: unknown[]): void => {};
  return {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    fatal: noop,
    trace: noop,
    child: () => silentLogger(),
  } as unknown as Logger;
}

function baseConfig(overrides: Partial<Config> = {}): Config {
  return {
    nodeEnv: 'test',
    driver: 'mock',
    databaseUrl: 'postgres://test',
    redisUrl: 'redis://test',
    dashboardOrigin: 'https://test.example',
    ...overrides,
  } as Config;
}

describe('Q.1 selectAgentDecomposer', () => {
  describe('force override (Q.1.a open-answer escape hatch)', () => {
    it('forceImpl=deterministic returns Deterministic even when fallbackApiKey is set', () => {
      const config = baseConfig({
        agentDecomposer: {
          forceImpl: 'deterministic',
          useFallbackForUnconfiguredCustomers: false,
        },
        byokAnthropic: { fallbackApiKey: 'sk-ant-test' },
      });
      const dec = selectAgentDecomposer(config, silentLogger());
      expect(dec).toBeInstanceOf(DeterministicAgentDecomposer);
    });

    it('forceImpl=deterministic returns Deterministic even when mfaEncryptionKey is set', () => {
      const config = baseConfig({
        agentDecomposer: {
          forceImpl: 'deterministic',
          useFallbackForUnconfiguredCustomers: false,
        },
        mfaEncryptionKey: Buffer.alloc(32).toString('base64'),
      });
      const dec = selectAgentDecomposer(config, silentLogger());
      expect(dec).toBeInstanceOf(DeterministicAgentDecomposer);
    });

    it('forceImpl=deterministic returns Deterministic when both keys are set', () => {
      const config = baseConfig({
        agentDecomposer: {
          forceImpl: 'deterministic',
          useFallbackForUnconfiguredCustomers: false,
        },
        byokAnthropic: { fallbackApiKey: 'sk-ant-test' },
        mfaEncryptionKey: Buffer.alloc(32).toString('base64'),
      });
      const dec = selectAgentDecomposer(config, silentLogger());
      expect(dec).toBeInstanceOf(DeterministicAgentDecomposer);
    });
  });

  describe('auto-selection (Q.1.a verdict option 4: EITHER key path)', () => {
    it('fallbackApiKey alone → ClaudeAgentDecomposer', () => {
      const config = baseConfig({
        byokAnthropic: { fallbackApiKey: 'sk-ant-test' },
      });
      const dec = selectAgentDecomposer(config, silentLogger());
      expect(dec).toBeInstanceOf(ClaudeAgentDecomposer);
    });

    it('mfaEncryptionKey alone (per-customer storage available) → ClaudeAgentDecomposer', () => {
      const config = baseConfig({
        mfaEncryptionKey: Buffer.alloc(32).toString('base64'),
      });
      const dec = selectAgentDecomposer(config, silentLogger());
      expect(dec).toBeInstanceOf(ClaudeAgentDecomposer);
    });

    it('both key paths configured → ClaudeAgentDecomposer (still option 4 — either is sufficient)', () => {
      const config = baseConfig({
        byokAnthropic: { fallbackApiKey: 'sk-ant-test' },
        mfaEncryptionKey: Buffer.alloc(32).toString('base64'),
      });
      const dec = selectAgentDecomposer(config, silentLogger());
      expect(dec).toBeInstanceOf(ClaudeAgentDecomposer);
    });
  });

  describe('safe default (neither key path + no force)', () => {
    it('no fallback + no mfa key → DeterministicAgentDecomposer', () => {
      const config = baseConfig();
      const dec = selectAgentDecomposer(config, silentLogger());
      expect(dec).toBeInstanceOf(DeterministicAgentDecomposer);
    });

    it('agentDecomposer config absent (undefined) is treated as no-force + no-fallback', () => {
      const config = baseConfig({
        agentDecomposer: undefined,
      });
      const dec = selectAgentDecomposer(config, silentLogger());
      expect(dec).toBeInstanceOf(DeterministicAgentDecomposer);
    });
  });
});
