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
  // These integer columns are pinnable directly; the fractional refill
  // columns ("1/N (M per minute)") are pinned cell-exact in the dedicated
  // refill-column test below.
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

  // W254.A follow-up — the capacity pins above (+ the integer global-refill
  // pin) left the two REFILL columns (sessions:create + agent_sessions:message)
  // uncovered, and the prior revision deferred the fractional ones ("1/N
  // (M per minute)") to a "separate prose pin" that never landed. So a
  // TIER_RATE_LIMIT_DEFAULTS refill change would silently drift the
  // customer-facing doc while every capacity pin still passed. Pin both refill
  // columns cell-exact (split the row on `|`) so a value like "1" can't alias
  // inside "1/60" / "120" the way a substring/loose-regex match would.
  it('every sessions:create + agent_sessions:message refill column matches TIER_RATE_LIMIT_DEFAULTS', () => {
    // Doc renders an integer rps as the number, a fractional rps as
    // "1/N (M per minute)" (N = 1/rps, M = rps*60). Mirrors the doc table.
    const renderRefill = (rps: number): string =>
      Number.isInteger(rps)
        ? rps.toLocaleString('en-US')
        : `1/${Math.round(1 / rps)} (${Math.round(rps * 60)} per minute)`;

    // Parse the markdown table into tier -> trimmed cells. A leading `|`
    // makes cells[0] the empty pre-pipe segment, so cells[1] is the tier and
    // the numeric columns are: [2] global cap, [3] global refill, [4] sc cap,
    // [5] sc refill, [6] msg cap, [7] msg refill.
    const rowByTier = new Map<string, string[]>();
    for (const line of doc.split('\n')) {
      if (!line.trimStart().startsWith('|')) continue;
      const cells = line.split('|').map((c) => c.trim());
      const tierCell = cells[1]?.replace(/`/g, '');
      if (tierCell && (tiers as string[]).includes(tierCell)) rowByTier.set(tierCell, cells);
    }

    for (const t of tiers) {
      const cfg = TIER_RATE_LIMIT_DEFAULTS[t as keyof typeof TIER_RATE_LIMIT_DEFAULTS];
      const cells = rowByTier.get(t);
      expect(cells, `no rate-limit table row found for tier ${t}`).toBeDefined();
      expect(cells?.[5], `sessions:create refill mismatch for ${t}`).toBe(
        renderRefill(cfg['sessions:create'].refill_per_second),
      );
      expect(cells?.[7], `agent_sessions:message refill mismatch for ${t}`).toBe(
        renderRefill(cfg['agent_sessions:message'].refill_per_second),
      );
    }
  });

  it('every agent_sessions:input_event capacity / refill matches TIER_RATE_LIMIT_DEFAULTS', () => {
    // V-1091: these used to live in a prose line below the table while the
    // other three buckets had columns, so this arm matched prose. They are
    // table columns [8] and [9] now — one home per number, which is what
    // stops a later edit from updating the table and leaving the prose.
    const rowByTier = new Map<string, string[]>();
    for (const line of doc.split('\n')) {
      if (!line.trimStart().startsWith('|')) continue;
      const cells = line.split('|').map((c) => c.trim());
      const tierCell = cells[1]?.replace(/`/g, '');
      if (tierCell && (tiers as string[]).includes(tierCell)) rowByTier.set(tierCell, cells);
    }

    for (const t of tiers) {
      const cfg = TIER_RATE_LIMIT_DEFAULTS[t as keyof typeof TIER_RATE_LIMIT_DEFAULTS];
      const ie = cfg['agent_sessions:input_event'];
      const cells = rowByTier.get(t);
      expect(cells, `no rate-limit table row found for tier ${t}`).toBeDefined();
      expect(cells?.[8], `input_event capacity mismatch for ${t}`).toBe(
        ie.capacity.toLocaleString('en-US'),
      );
      expect(cells?.[9], `input_event refill mismatch for ${t}`).toBe(
        ie.refill_per_second.toLocaleString('en-US'),
      );
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
