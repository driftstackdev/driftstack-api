// Guard for the PERMISSIVE_CORS-in-production misconfiguration. The flag
// makes @fastify/cors echo any request Origin with credentials:true; in
// production that must never be on (CORS_ALLOWED_ORIGINS is the boundary).
// corsPostureWarning() returns a loud message for that exact combination
// and stays silent for every legitimate one (dev/test escape hatch, or a
// locked-down production). See
// docs/internal/2026-05-31-permissive-cors-in-prod.md.

import { describe, expect, it } from 'vitest';
import { corsPostureWarning } from '../../src/lib/cors-posture.js';

describe('corsPostureWarning', () => {
  it('WARNS when PERMISSIVE_CORS is on in production (the insecure combination)', () => {
    const w = corsPostureWarning(true, 'production');
    expect(w).not.toBeNull();
    expect(w).toMatch(/PERMISSIVE_CORS=true in production/);
    expect(w).toMatch(/CORS_ALLOWED_ORIGINS/);
  });

  it('is SILENT when production is locked down (non-permissive)', () => {
    expect(corsPostureWarning(false, 'production')).toBeNull();
  });

  it('is SILENT when permissive in development (the documented escape-hatch use)', () => {
    expect(corsPostureWarning(true, 'development')).toBeNull();
  });

  it('is SILENT when permissive in test', () => {
    expect(corsPostureWarning(true, 'test')).toBeNull();
  });
});
