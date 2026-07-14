// Guard for the PERMISSIVE_CORS-in-production misconfiguration. The flag
// makes @fastify/cors echo any request Origin with credentials:true; in
// production that must never be on (CORS_ALLOWED_ORIGINS is the boundary).
// corsPostureWarning() returns a non-secret diagnostic for that exact
// combination; assertCorsPosture() refuses boot there and allows every
// legitimate pair (dev/test escape hatch, or locked-down production). See
// docs/internal/2026-05-31-permissive-cors-in-prod.md.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { assertCorsPosture, corsPostureWarning } from '../../src/lib/cors-posture.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const BOOTSTRAP = readFileSync(resolve(HERE, '..', '..', 'src', 'lib', 'bootstrap.ts'), 'utf8');

function bootstrapFailsClosed(source: string): boolean {
  return (
    source.includes("import { assertCorsPosture } from './cors-posture.js';") &&
    source.includes('assertCorsPosture(permissiveCors, config.nodeEnv);') &&
    !source.includes("logger.error({ component: 'cors' }, corsWarning);")
  );
}

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

  it('refuses only permissive production and retains the non-secret diagnostic', () => {
    expect(() => assertCorsPosture(true, 'production')).toThrow(
      /INSECURE CORS: PERMISSIVE_CORS=true in production.*CORS_ALLOWED_ORIGINS/,
    );
    expect(() => assertCorsPosture(false, 'production')).not.toThrow();
    expect(() => assertCorsPosture(true, 'development')).not.toThrow();
    expect(() => assertCorsPosture(true, 'test')).not.toThrow();
  });

  it('pins bootstrap to the fail-closed assertion instead of a log-only warning', () => {
    expect(bootstrapFailsClosed(BOOTSTRAP)).toBe(true);
    expect(
      bootstrapFailsClosed(
        BOOTSTRAP.replace(
          'assertCorsPosture(permissiveCors, config.nodeEnv);',
          "logger.error({ component: 'cors' }, corsPostureWarning(permissiveCors, config.nodeEnv));",
        ),
      ),
    ).toBe(false);
  });
});
