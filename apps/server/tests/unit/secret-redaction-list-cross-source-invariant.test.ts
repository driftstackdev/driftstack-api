// Cross-source invariant: secret-redaction lists in lib/sentry.ts +
// lib/logger.ts MUST include the same canonical secret keys
// (gui_control_key + BYOK Anthropic + MFA TOTP). Drift on either
// side would let a secret slip through to one observability surface
// (Sentry breadcrumb or Pino structured log) without scrubbing.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const SENTRY = resolve(REPO_ROOT, 'apps/server/src/lib/sentry.ts');
const LOGGER = resolve(REPO_ROOT, 'apps/server/src/lib/logger.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('secret-redaction list cross-source invariant (Sentry + Pino logger)', () => {
  const sentry = read(SENTRY);
  const logger = read(LOGGER);

  it('Both Sentry SENTRY_SENSITIVE_KEYS + Pino logger redact-paths include gui_control_key', () => {
    expect(sentry).toMatch(/'gui_control_key',/);
    expect(logger).toMatch(/'gui_control_key',/);
  });

  it('Both Sentry + Pino logger include x-byok-anthropic-api-key / byok-anthropic body-field redaction', () => {
    expect(sentry).toMatch(/'x-byok-anthropic-api-key',/);
    expect(sentry).toMatch(/'byokanthropicapikey',/);
    expect(logger).toMatch(/'body\.api_key',/);
  });

  it('Both Sentry + Pino include MFA TOTP secret + recovery_codes redaction — pinned so the MFA-related scrubbing stays consistent across observability surfaces', () => {
    expect(sentry).toMatch(/'totp_secret',/);
    expect(sentry).toMatch(/'totpsecret',/);
    expect(sentry).toMatch(/'mfasecret',/);
    expect(logger).toMatch(/'recovery_codes',/);
    expect(logger).toMatch(/'recoveryCodes',/);
    expect(logger).toMatch(/'totpSecret',/);
  });

  it("Sentry cross-references the lib/logger.ts redact-paths via 'Sentry mirror of the lib/logger.ts redact-paths extension' — pinned so the mirror relationship stays documented (drift on one without updating the other would create asymmetric scrubbing)", () => {
    expect(sentry).toMatch(
      /\/\/ Arc 7 obs\.2\.b — v2-#8 BYOK \+ gui_control_key Sentry mirror of\s*\n?\s*\/\/ the lib\/logger\.ts redact-paths extension\./,
    );
  });

  it("Sentry's case-insensitive matching is documented: 'Match keys are lowercase + hyphen/underscore variants (the SENTRY_SENSITIVE_KEYS Set is compared via key.toLowerCase()).' — pinned so the lowercase-key invariant stays documented (drift to case-sensitive matching would let mixed-case keys slip through)", () => {
    expect(sentry).toMatch(
      /Match keys are\s*\n?\s*\/\/ lowercase \+ hyphen\/underscore variants \(the\s*\n?\s*\/\/ SENTRY_SENSITIVE_KEYS Set is compared via key\.toLowerCase\(\)\)\./,
    );
  });

  it("Pino logger pins both camelCase + snake_case variants of gui_control_key: 'gui_control_key' + 'guiControlKey' + 'body.gui_control_key' — pinned so both casings get scrubbed regardless of which call-site emits the field", () => {
    expect(logger).toMatch(
      /'gui_control_key',\s*\n?\s*'guiControlKey',\s*\n?\s*'body\.gui_control_key',/,
    );
  });
});
