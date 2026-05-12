// W193 — unit tests for the admin-panel's resolveApiBaseUrl helper.
// Mirrors the customer-dashboard test (W192). The prod-throw case is
// the load-bearing assertion: a missed env var on deploy would have
// silently pointed every admin call at localhost:3000, which is worse
// than the dashboard case because admins might misread "no accounts"
// as system state rather than a misconfiguration.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveApiBaseUrl } from '../../src/lib/api-base-url';

describe('W193 admin-panel resolveApiBaseUrl', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('when PUBLIC_API_BASE_URL is set', () => {
    it('returns the env value as-is when no trailing slash', () => {
      vi.stubEnv('PUBLIC_API_BASE_URL', 'https://api.driftstack.dev');
      expect(resolveApiBaseUrl()).toBe('https://api.driftstack.dev');
    });

    it('strips a trailing slash', () => {
      vi.stubEnv('PUBLIC_API_BASE_URL', 'https://api.driftstack.dev/');
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
      expect(() => resolveApiBaseUrl()).toThrow(/admin-panel: PUBLIC_API_BASE_URL/);
    });

    it('throws with a directive error message that mentions astro build', () => {
      vi.stubEnv('DEV', '');
      vi.stubEnv('PROD', 'true');
      expect(() => resolveApiBaseUrl()).toThrow(/astro build/);
    });
  });
});
