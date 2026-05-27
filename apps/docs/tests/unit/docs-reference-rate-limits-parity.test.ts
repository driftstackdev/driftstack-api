// W254.A — drift-guard for docs.driftstack.dev/reference/rate-limits.
// Previous revision asserted a fictional problem-type URI
// (`api.driftstack.dev/errors/rate-limit-exceeded`); live URI is
// `https://errors.driftstack.dev/rate-limited` per PROBLEM_TYPES.
// Pins the per-tier bucket-capacity table to TIER_RATE_LIMIT_DEFAULTS.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AccountTierSchema, PROBLEM_TYPES, TIER_RATE_LIMIT_DEFAULTS } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const DOC = resolve(REPO_ROOT, 'apps/docs/src/pages/reference/rate-limits.md');

function read(): string {
  return readFileSync(DOC, 'utf8');
}

describe('W254.A docs/reference/rate-limits ↔ TIER_RATE_LIMIT_DEFAULTS parity', () => {
  const doc = read();
  const tiers = (AccountTierSchema._def.values as readonly string[]).slice();

  it('uses the canonical rate-limited problem-type URI', () => {
    expect(doc).toContain(PROBLEM_TYPES.RateLimited);
    expect(doc).not.toMatch(/api\.driftstack\.dev\/errors\/rate-limit-exceeded/);
  });

  it('every per-tier global-bucket capacity matches TIER_RATE_LIMIT_DEFAULTS', () => {
    for (const t of tiers) {
      const cfg = TIER_RATE_LIMIT_DEFAULTS[t as keyof typeof TIER_RATE_LIMIT_DEFAULTS];
      const cap = cfg.global.capacity.toLocaleString('en-US');
      const re = new RegExp(`\`${t}\`\\s*\\|\\s*${cap.replace(/,/g, ',?')}\\s*\\|`);
      expect(doc, `global capacity mismatch for ${t} (expect ${cap})`).toMatch(re);
    }
  });

  it('every sessions:create-bucket capacity matches TIER_RATE_LIMIT_DEFAULTS', () => {
    for (const t of tiers) {
      const cfg = TIER_RATE_LIMIT_DEFAULTS[t as keyof typeof TIER_RATE_LIMIT_DEFAULTS];
      const cap = cfg['sessions:create'].capacity.toLocaleString('en-US');
      // Third numeric column.
      const re = new RegExp(`\`${t}\`\\s*\\|[^|]+\\|[^|]+\\|\\s*${cap.replace(/,/g, ',?')}\\s*\\|`);
      expect(doc, `sessions:create capacity mismatch for ${t}`).toMatch(re);
    }
  });

  // W254.A follow-up — the original guard pinned only the two capacity
  // columns (global + sessions:create), leaving global-refill and the
  // agent_sessions:message capacity unpinned so a future
  // TIER_RATE_LIMIT_DEFAULTS change to those would silently drift the doc.
  // These integer columns are pinnable directly (fractional refill columns
  // render as "1/N (M per minute)" and are left to a separate prose pin).
  it('every per-tier global-bucket refill (rps) matches TIER_RATE_LIMIT_DEFAULTS', () => {
    for (const t of tiers) {
      const cfg = TIER_RATE_LIMIT_DEFAULTS[t as keyof typeof TIER_RATE_LIMIT_DEFAULTS];
      // Only assert integer refills here; fractional ones (e.g. 1/60) use a
      // human "1/N" rendering covered separately.
      if (!Number.isInteger(cfg.global.refill_per_second)) continue;
      const refill = cfg.global.refill_per_second.toLocaleString('en-US');
      // Second numeric column (after global capacity).
      const re = new RegExp(`\`${t}\`\\s*\\|[^|]+\\|\\s*${refill.replace(/,/g, ',?')}\\s*\\|`);
      expect(doc, `global refill mismatch for ${t} (expect ${refill})`).toMatch(re);
    }
  });

  it('every agent_sessions:message capacity matches TIER_RATE_LIMIT_DEFAULTS', () => {
    for (const t of tiers) {
      const cfg = TIER_RATE_LIMIT_DEFAULTS[t as keyof typeof TIER_RATE_LIMIT_DEFAULTS];
      const cap = cfg['agent_sessions:message'].capacity.toLocaleString('en-US');
      // Fifth numeric column (skip global cap/refill + sessions:create cap/refill).
      const re = new RegExp(
        `\`${t}\`\\s*\\|[^|]+\\|[^|]+\\|[^|]+\\|[^|]+\\|\\s*${cap.replace(/,/g, ',?')}\\s*\\|`,
      );
      expect(doc, `agent_sessions:message capacity mismatch for ${t} (expect ${cap})`).toMatch(re);
    }
  });

  it('cites both bucket keys (global + sessions:create) explicitly', () => {
    expect(doc).toMatch(/`global`/);
    expect(doc).toMatch(/`sessions:create`/);
  });

  it('does not invent a "bucket" extension field on the problem body', () => {
    // Server emits problem with `retry_after_seconds` only; `bucket`
    // would be a fictional extension.
    expect(doc).not.toMatch(/"bucket":\s*"global"/);
  });
});
