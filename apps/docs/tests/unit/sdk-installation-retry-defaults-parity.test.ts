// W339.C — drift guard for the /sdk/installation TS configure
// snippet. The page hard-codes retry + timeout values that look
// like "the defaults" to a reader:
//
//   timeoutMs: 30_000,
//   retry: { maxAttempts: 3, initialDelayMs: 200, maxDelayMs: 10_000 }
//
// If the SDK's DEFAULTS drift away from these (e.g. we lower
// maxAttempts to 2), the snippet keeps quietly showing the old
// values and customers either over- or under-retry. Pin both sides.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/docs/src/pages/sdk/installation.md');
const CLIENT = resolve(REPO_ROOT, 'packages/sdk-typescript/src/client.ts');
const RETRY = resolve(REPO_ROOT, 'packages/sdk-typescript/src/retry.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W339.C /sdk/installation retry+timeout defaults parity', () => {
  const page = read(PAGE);
  const client = read(CLIENT);
  const retry = read(RETRY);

  it('SDK retry DEFAULTS still match the documented snippet values', () => {
    // DEFAULTS is module-local in retry.ts; grep the literal so the
    // test still catches drift without needing a public re-export.
    expect(retry).toMatch(/maxAttempts:\s*3\b/);
    expect(retry).toMatch(/initialDelayMs:\s*200\b/);
    expect(retry).toMatch(/maxDelayMs:\s*10_000/);
  });

  it('page cites timeoutMs: 30_000 and the SDK comment confirms 30000 is the default', () => {
    expect(page).toMatch(/timeoutMs:\s*30_000/);
    // The DriftstackOptions JSDoc states `Default 30000`.
    expect(client).toMatch(/Default 30000/);
  });

  it('page cites retry maxAttempts/initialDelayMs/maxDelayMs matching DEFAULTS', () => {
    expect(page).toMatch(/maxAttempts:\s*3\b/);
    expect(page).toMatch(/initialDelayMs:\s*200\b/);
    expect(page).toMatch(/maxDelayMs:\s*10_000/);
  });

  it('page cites baseUrl: "https://api.driftstack.dev" matching DEFAULT_BASE_URL', () => {
    expect(page).toContain("baseUrl: 'https://api.driftstack.dev'");
    expect(client).toContain("DEFAULT_BASE_URL = 'https://api.driftstack.dev'");
  });

  it('page references DriftstackError + four canonical subclasses (granular handling)', () => {
    expect(page).toContain('DriftstackError');
    expect(page).toContain('RateLimitError');
    expect(page).toContain('ConcurrencyLimitError');
    expect(page).toContain('ValidationError');
    expect(page).toContain('AuthError');
  });

  it('page declares Node.js >= 18 (matches the native-fetch floor)', () => {
    // The minimum Node version is set by native `fetch`. If we
    // ever raise to 20+ (or lower to 16 by polyfilling), the page
    // must follow.
    expect(page).toMatch(/Node\.js ≥ 18/);
  });
});
