import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGES = resolve(HERE, '..', '..', 'src', 'pages');
const FETCH_PAGES = [
  'index.astro',
  'history.astro',
  'incident.astro',
  'subscribe.astro',
  'subscribe/confirm.astro',
  'subscribe/unsubscribe.astro',
];

describe('status-site bounded request sweep', () => {
  it('routes every public API/R2 request through an abort-backed 10s deadline', () => {
    let boundedCalls = 0;
    for (const page of FETCH_PAGES) {
      const body = readFileSync(resolve(PAGES, page), 'utf8');
      const rawFetches = body.match(/\bfetch\(/g) ?? [];
      const deadlineUses = body.match(/\bfetchWithDeadline\(/g) ?? [];
      expect(
        rawFetches.length,
        `${page}: raw fetch is allowed only inside the deadline helper`,
      ).toBe(1);
      expect(
        deadlineUses.length,
        `${page}: every request must use the deadline helper`,
      ).toBeGreaterThan(1);
      expect(body).toMatch(/timeoutMs = 10_000/);
      expect(body).toMatch(/const controller = new AbortController\(\);/);
      expect(body).toMatch(/setTimeout\(\(\) => controller\.abort\(\), timeoutMs\)/);
      expect(body).toMatch(/\.finally\(\(\) => clearTimeout\(timer\)\)/);
      boundedCalls += deadlineUses.length - 1;
    }
    // 7, not 8: index.astro routes its THREE bounded requests (live incidents,
    // live readiness /v1/status, R2 snapshot fallback) through one shared
    // `load()` wrapper around fetchWithDeadline (f66e8a02c) instead of two
    // inline call sites. Bounded request coverage went up, call sites went down.
    // This total stays load-bearing: adding or deleting any awaited
    // fetchWithDeadline call site on any of the six pages flips it, and a raw
    // fetch smuggled in outside the helper is caught by the per-page
    // `rawFetches.length === 1` assertion above.
    expect(boundedCalls).toBe(7);
  });
});
