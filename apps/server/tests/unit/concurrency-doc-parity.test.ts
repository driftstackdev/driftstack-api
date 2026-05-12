// W242.A — drift-guard for /docs/concurrency. The previous revision
// asserted tier caps (Trial Pack: 2, Solo: 5, API Starter: 10, Team:
// 20, etc.) that are all higher than what the server actually
// enforces via `TIER_CONCURRENT_SESSION_LIMITS`. Customers building
// against those numbers would over-allocate pools + see 429s well
// below documented capacity. This guard pins the table to the
// shared constant.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AccountTierSchema,
  PROBLEM_TYPES,
  TIER_CONCURRENT_SESSION_LIMITS,
} from '@driftstack/api-types';

const REPO = join(__dirname, '..', '..', '..', '..');
const DOC_PATH = join(REPO, 'apps', 'marketing-site', 'src', 'pages', 'docs', 'concurrency.astro');

function read(): string {
  return readFileSync(DOC_PATH, 'utf8');
}

describe('W242.A concurrency doc parity', () => {
  const doc = read();
  const tiers = (AccountTierSchema._def.values as readonly string[]).slice();

  it('lists every AccountTier in the cap table', () => {
    for (const tier of tiers) {
      expect(doc).toMatch(new RegExp(`<code>${tier}</code>`));
    }
  });

  it('cap column matches TIER_CONCURRENT_SESSION_LIMITS for every tier', () => {
    for (const tier of tiers) {
      const cap =
        TIER_CONCURRENT_SESSION_LIMITS[tier as keyof typeof TIER_CONCURRENT_SESSION_LIMITS];
      // Row format: <td><code>tier</code></td><td>N</td>...
      const re = new RegExp(`<code>${tier}</code></td>\\s*<td>${cap.toString()}</td>`);
      expect(doc).toMatch(re);
    }
  });

  it('uses the stable RFC 7807 concurrency-limit type URI', () => {
    expect(doc).toContain(PROBLEM_TYPES.ConcurrencyLimit);
  });

  it('references concurrent_session_active / _cap not the old current_concurrent_sessions', () => {
    expect(doc).toMatch(/concurrent_session_active/);
    expect(doc).toMatch(/concurrent_session_cap/);
    expect(doc).not.toMatch(/current_concurrent_sessions/);
  });

  it('does not assert any tier cap above the live ceiling (max 32)', () => {
    const maxLive = Math.max(...Object.values(TIER_CONCURRENT_SESSION_LIMITS));
    // Pull every <td>NN</td> from the cap table body and check.
    const tableSection =
      doc.split('<h2>Concurrent-session caps</h2>')[1]?.split('</table>')[0] ?? '';
    const nums = Array.from(tableSection.matchAll(/<td>(\d+)<\/td>/g)).map((m) => Number(m[1]));
    expect(nums.length).toBeGreaterThan(0);
    for (const n of nums) {
      expect(n).toBeLessThanOrEqual(maxLive);
    }
  });
});
