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
      /\/\/ Arc 7 obs\.2\.b — v2-#8 BYOK \+ gui_control_key Sentry mirror of\s*\/\/ the lib\/logger\.ts redact-paths extension\./,
    );
  });

  it("Sentry's case-insensitive matching is documented: 'Match keys are lowercase + hyphen/underscore variants (the SENTRY_SENSITIVE_KEYS Set is compared via key.toLowerCase()).' — pinned so the lowercase-key invariant stays documented (drift to case-sensitive matching would let mixed-case keys slip through)", () => {
    expect(sentry).toMatch(
      /Match keys are\s*\/\/ lowercase \+ hyphen\/underscore variants \(the\s*\/\/ SENTRY_SENSITIVE_KEYS Set is compared via key\.toLowerCase\(\)\)\./,
    );
  });

  it("Pino logger pins both camelCase + snake_case variants of gui_control_key: 'gui_control_key' + 'guiControlKey' + 'body.gui_control_key' — pinned so both casings get scrubbed regardless of which call-site emits the field", () => {
    expect(logger).toMatch(/'gui_control_key',\s*'guiControlKey',\s*'body\.gui_control_key',/);
  });

  // ─── Full programmatic lockstep (mirror-or-leak guard) ──────────────────────
  // The spot-checks above pin specific high-risk keys; this asserts the WHOLE
  // logger redact.paths set is mirrored in SENTRY_SENSITIVE_KEYS. The source
  // comments instruct "Keep in sync … whenever a request/response shape gains
  // [a sensitive field]" but only human discipline + the spot-checks enforced
  // it — a NEW field added to logger.ts but not sentry.ts would pass silently
  // and leak that secret to Sentry events (request.data / breadcrumbs / extra /
  // contexts), the "asymmetric scrubbing" the comments warn about. Subset
  // direction: every field Pino bothers to redact MUST also be scrubbed from
  // Sentry, since the same object can reach both sinks. (Sentry is
  // intentionally broader — bare-key match vs Pino's narrower dot-paths — so
  // the reverse is NOT an invariant.) Line-based extraction keeps the regexes
  // short + robust to prettier reformatting (array elements stay one-per-line).
  function linesBetween(src: string, startRe: RegExp, endRe: RegExp): string[] {
    const lines = src.split('\n');
    const start = lines.findIndex((l) => startRe.test(l));
    expect(start, `start marker ${String(startRe)} not found`).toBeGreaterThanOrEqual(0);
    const end = lines.findIndex((l, i) => i > start && endRe.test(l));
    expect(end, `end marker ${String(endRe)} not found`).toBeGreaterThan(start);
    return lines.slice(start + 1, end);
  }
  function quotedStringsOnOwnLines(lines: readonly string[]): string[] {
    const out: string[] = [];
    for (const line of lines) {
      const m = line.match(/^\s*'([^']+)',?\s*$/);
      if (m && m[1] !== undefined) out.push(m[1]);
    }
    return out;
  }
  /** Reduce a Pino dot/bracket redact path to the bare key Sentry matches on. */
  function bareKey(path: string): string {
    const bracket = path.match(/\["([^"]+)"\]\s*$/);
    if (bracket && bracket[1] !== undefined) return bracket[1].toLowerCase();
    const lastDot = path.lastIndexOf('.');
    return (lastDot >= 0 ? path.slice(lastDot + 1) : path).toLowerCase();
  }

  it('CRITICAL every lib/logger.ts redact.path is mirrored in SENTRY_SENSITIVE_KEYS — a field scrubbed from Pino logs MUST also be scrubbed from Sentry events (mirror-or-leak; catches a new sensitive field added to one list but not the other)', () => {
    const loggerPaths = quotedStringsOnOwnLines(
      linesBetween(logger, /redact:\s*\{/, /^\s*\],?\s*$/),
    );
    const sentryKeys = new Set(
      quotedStringsOnOwnLines(linesBetween(sentry, /new Set<string>\(\[/, /^\s*\]\)/)).map((k) =>
        k.toLowerCase(),
      ),
    );
    // Sanity: both lists extracted non-trivially (guards against a marker
    // rename silently reducing either set to empty — which would make the
    // subset check vacuously pass).
    expect(loggerPaths.length, 'logger redact.paths extraction').toBeGreaterThan(10);
    expect(sentryKeys.size, 'SENTRY_SENSITIVE_KEYS extraction').toBeGreaterThan(10);
    const missing = loggerPaths.map(bareKey).filter((k) => !sentryKeys.has(k));
    expect(
      missing,
      `logger redact fields missing from SENTRY_SENSITIVE_KEYS (would leak to Sentry): ${missing.join(', ')}`,
    ).toEqual([]);
  });
});
