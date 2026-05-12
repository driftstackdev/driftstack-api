// W192 — unit tests for the resolveApiBaseUrl helper.
//
// The helper centralises what used to be 20 inline `import.meta.env`
// expressions. The risk it mitigates: in prod, a missed env var would
// silently default every customer-dashboard page to
// `http://localhost:3000`, breaking the entire app. The prod-throw
// case is the load-bearing assertion here.
//
// `import.meta.env` is provided by Vite; vitest exposes it during
// tests. We use vi.stubEnv to swap values per test.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveApiBaseUrl } from '../../src/lib/api-base-url';

describe('W192 resolveApiBaseUrl', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('when PUBLIC_API_BASE_URL is set', () => {
    it('returns the env value as-is when no trailing slash', () => {
      vi.stubEnv('PUBLIC_API_BASE_URL', 'https://api.driftstack.dev');
      expect(resolveApiBaseUrl()).toBe('https://api.driftstack.dev');
    });

    it('strips a single trailing slash', () => {
      vi.stubEnv('PUBLIC_API_BASE_URL', 'https://api.driftstack.dev/');
      expect(resolveApiBaseUrl()).toBe('https://api.driftstack.dev');
    });

    it('strips multiple trailing slashes', () => {
      vi.stubEnv('PUBLIC_API_BASE_URL', 'https://api.driftstack.dev///');
      expect(resolveApiBaseUrl()).toBe('https://api.driftstack.dev');
    });
  });

  describe('when PUBLIC_API_BASE_URL is unset', () => {
    beforeEach(() => {
      vi.stubEnv('PUBLIC_API_BASE_URL', '');
    });

    it('falls back to localhost:3000 in dev mode', () => {
      vi.stubEnv('DEV', 'true');
      vi.stubEnv('PROD', '');
      expect(resolveApiBaseUrl()).toBe('http://localhost:3000');
    });

    it('throws in prod mode — fails the build fast', () => {
      vi.stubEnv('DEV', '');
      vi.stubEnv('PROD', 'true');
      expect(() => resolveApiBaseUrl()).toThrow(/PUBLIC_API_BASE_URL must be set/);
    });

    it('throws with a directive error message that mentions astro build', () => {
      vi.stubEnv('DEV', '');
      vi.stubEnv('PROD', 'true');
      expect(() => resolveApiBaseUrl()).toThrow(/astro build/);
    });
  });
});
