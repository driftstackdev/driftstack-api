// Auth email-link fixtures must mirror the customer dashboard's real pages.
// Keeping test builders on routes that 404 lets broken operator configuration
// look normal in integration and e2e coverage.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

const FIXTURES = [
  'apps/server/tests/integration/_helpers/build-test-app.ts',
  'apps/server/tests/e2e/helpers/server.ts',
  'apps/server/tests/integration/auth-flows.test.ts',
  'apps/server/tests/integration/auth-flows-email.test.ts',
  'apps/server/tests/unit/redact-url.test.ts',
] as const;

function read(relativePath: string): string {
  return readFileSync(resolve(REPO_ROOT, relativePath), 'utf8');
}

describe('auth-flow test fixture path parity', () => {
  it('the canonical verification and password-reset dashboard pages exist', () => {
    expect(
      existsSync(resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/verify-email.astro')),
    ).toBe(true);
    expect(
      existsSync(resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/reset-password.astro')),
    ).toBe(true);
  });

  it.each(FIXTURES)('%s uses real customer pages and never the legacy 404 paths', (fixture) => {
    const body = read(fixture);

    expect(body).not.toMatch(/https?:\/\/[^'"\s]+\/auth\/verify-email/);
    expect(body).not.toMatch(/https?:\/\/[^'"\s]+\/auth\/password-reset/);
    expect(body).toMatch(/verifyEmailUrl:\s*'https?:\/\/[^']+\/verify-email'/);
    expect(body).toMatch(/passwordResetUrl:\s*'https?:\/\/[^']+\/reset-password'/);
    expect(body).toMatch(/magicLinkUrl:\s*'https?:\/\/[^']+\/auth\/magic-link'/);
  });
});
