import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SearchRequestSchema, SearchResponseSchema } from '@driftstack/api-types';
import {
  DRIVER_SEARCH_DURATION_MAX_MS,
  DriverSearchResultSchema,
} from '../../src/drivers/types.js';
import {
  HARNESS_INTENT_RESULT_SCHEMAS,
  HARNESS_SEARCH_PRODUCER_DEADLINE_MS,
  HARNESS_SEND_KEYS_MAX_CHARS,
  SearchParamsSchema,
} from '../../src/schemas/harness-control-protocol.js';
import {
  DISPATCH_TIMEOUT_SLACK_MS,
  dispatchTimeoutMs,
} from '../../src/services/harness-dispatch-correlator.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const CONTRACT = resolve(REPO_ROOT, 'docs/internal/cross-agent-control-plane-contract.md');

describe('direct-search control-plane contract', () => {
  it('shares the exact 10,000-character query admission bound', () => {
    expect(HARNESS_SEND_KEYS_MAX_CHARS).toBe(10_000);
    expect(SearchRequestSchema.safeParse({ query: 'q'.repeat(10_000) }).success).toBe(true);
    expect(SearchParamsSchema.safeParse({ query: 'q'.repeat(10_000) }).success).toBe(true);
    expect(SearchRequestSchema.safeParse({ query: 'q'.repeat(10_001) }).success).toBe(false);
    expect(SearchParamsSchema.safeParse({ query: 'q'.repeat(10_001) }).success).toBe(false);
  });

  it('shares exact normal and zero-submit truncation terminals across every boundary', () => {
    const normalHarness = {
      submitted: true,
      query_truncated: false,
      results_visible: false,
    } as const;
    const truncatedHarness = { submitted: false, query_truncated: true } as const;
    const normalDriver = {
      submitted: true,
      queryTruncated: false,
      resultsVisible: false,
      durationMs: 600_000,
    } as const;
    const truncatedDriver = {
      submitted: false,
      queryTruncated: true,
      durationMs: 600_000,
    } as const;
    const normalPublic = { ...normalHarness, duration_ms: 600_000 } as const;
    const truncatedPublic = { ...truncatedHarness, duration_ms: 600_000 } as const;

    expect(HARNESS_INTENT_RESULT_SCHEMAS.search.safeParse(normalHarness).success).toBe(true);
    expect(HARNESS_INTENT_RESULT_SCHEMAS.search.safeParse(truncatedHarness).success).toBe(true);
    expect(DriverSearchResultSchema.safeParse(normalDriver).success).toBe(true);
    expect(DriverSearchResultSchema.safeParse(truncatedDriver).success).toBe(true);
    expect(SearchResponseSchema.safeParse(normalPublic).success).toBe(true);
    expect(SearchResponseSchema.safeParse(truncatedPublic).success).toBe(true);

    for (const invalid of [
      { submitted: true, query_truncated: true, duration_ms: 1 },
      { submitted: false, query_truncated: true, results_visible: false, duration_ms: 1 },
      { submitted: true, query_truncated: false, duration_ms: 600_001 },
    ]) {
      expect(SearchResponseSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it('pins one 600-second producer owner plus exactly 15 seconds of correlator slack', () => {
    expect(HARNESS_SEARCH_PRODUCER_DEADLINE_MS).toBe(600_000);
    expect(DRIVER_SEARCH_DURATION_MAX_MS).toBe(HARNESS_SEARCH_PRODUCER_DEADLINE_MS);
    expect(DISPATCH_TIMEOUT_SLACK_MS).toBe(15_000);
    expect(dispatchTimeoutMs('search')).toBe(615_000);
  });

  it('records the non-activation posture and fill_form public-surface exclusion', () => {
    const body = readFileSync(CONTRACT, 'utf8');
    expect(body).toMatch(
      /Search now targets the same \*\*600,000ms producer wall \+ 15,000ms delivery slack = 615,000ms\s*correlation\*\*/,
    );
    expect(body).toMatch(/exact zero-submit truncation terminal/);
    expect(body).toMatch(/every shipped driver is non-real and returns 503 before lookup\/claim/);
    expect(body).toMatch(
      /`fill_form`\s*remains an internal harness intent with no public session route or SDK method/,
    );
  });
});
