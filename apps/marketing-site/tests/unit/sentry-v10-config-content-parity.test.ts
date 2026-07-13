import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(HERE, '..', '..');

function read(name: string): string {
  return readFileSync(resolve(APP_ROOT, name), 'utf8');
}

describe('marketing Sentry v10 configuration', () => {
  const astro = read('astro.config.mjs');
  const client = read('sentry.client.config.ts');
  const server = read('sentry.server.config.ts');

  it('keeps build-time controls in the Astro integration', () => {
    expect(astro).toMatch(/enabled:\s*SENTRY_DSN\.length > 0/);
    expect(astro).toMatch(/project:\s*'driftstack-marketing'/);
    expect(astro).toMatch(/org:\s*process\.env\.SENTRY_ORG \?\? 'driftstack'/);
    expect(astro).toMatch(/authToken:\s*SENTRY_AUTH_TOKEN \|\| undefined/);
    expect(astro).not.toContain('sourceMapsUploadOptions');
  });

  it('keeps client and server runtime settings identical', () => {
    for (const config of [client, server]) {
      expect(config).toContain("from '@sentry/astro'");
      expect(config).toMatch(/dsn:\s*import\.meta\.env\.PUBLIC_SENTRY_DSN_MARKETING/);
      expect(config).toMatch(
        /environment:\s*import\.meta\.env\.PUBLIC_SENTRY_ENVIRONMENT \?\? 'production'/,
      );
      expect(config).toMatch(/tracesSampleRate:\s*0\.05/);
      expect(config).not.toMatch(/\brelease:/);
    }
  });

  it('aligns the public environment and plugin-injected release before Vite runs', () => {
    expect(astro).toMatch(
      /process\.env\.PUBLIC_SENTRY_ENVIRONMENT \?\?= process\.env\.SENTRY_ENVIRONMENT \?\? 'production'/,
    );
    expect(astro).toMatch(
      /process\.env\.SENTRY_RELEASE \?\?= process\.env\.GIT_SHA \?\? 'unknown'/,
    );
    expect(astro).not.toMatch(/\b(?:dsn|environment|release|tracesSampleRate):/);
  });
});
