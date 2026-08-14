// A blank environment value means "unset", never "zero".
//
// `GLOBAL_IP_RATE_LIMIT_PER_MIN=` — the key present, nothing after the `=` — is
// what a `.env` looks like when someone copies a line out of the template and
// does not fill it in. It used to disable the app-wide DoS gate.
//
// The chain is short and every link is reasonable on its own.
// `z.coerce.number()` runs `Number('')`, which is `0`. Zod's `.default()` fires
// only on `undefined`, so it never sees the blank. Bootstrap maps
// `globalIpRateLimitPerMin <= 0` to `null`, and `app.ts` registers the
// `onRequest` IP gate only when that value is not null. So a blank line removed
// the pre-auth rate limit entirely — the one that caps an unauthenticated flood
// of bogus bearer tokens BEFORE `findApiKeyByPrefix` + scrypt + AES-GCM run.
// The server boots normally and reports itself healthy.
//
// Whitespace-only did the same thing, which is the version that survives a
// copy-paste.
//
// Only this field needed the fix, and the reason is worth stating so nobody
// "consistently" applies it to the rest. Of eleven coerced numbers in the
// config, seven are `.positive()` — 0 fails validation and the boot dies
// loudly, which is the correct outcome for a blank. Two are mock-driver
// latencies where 0 is harmless, and the Sentry sample rate already defaults to
// 0. `globalIpRateLimitPerMin` is the only one where 0 is a MEANINGFUL
// INSTRUCTION rather than an invalid value, so it is the only one where a blank
// could be mistaken for one.
//
// The deliberate disable is preserved: an explicit `0` still turns the gate off,
// because an operator who types a zero means it.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/lib/config.js';

/** The two fields with no default; everything else is exercised via defaults. */
const BASE: NodeJS.ProcessEnv = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
};

const withGate = (value: string | undefined): number =>
  loadConfig(value === undefined ? BASE : { ...BASE, GLOBAL_IP_RATE_LIMIT_PER_MIN: value })
    .globalIpRateLimitPerMin;

describe('a blank env value does not disable the global IP gate', () => {
  it('CRITICAL an unset variable still yields the documented default. This is the baseline the other cases are measured against — if the default itself moved, every assertion below would be comparing against the wrong number.', () => {
    expect(withGate(undefined), 'unset falls back to 600/min/IP').toBe(600);
  });

  it('CRITICAL a BLANK value yields the default rather than zero. `Number("")` is 0 and zod defaults only fire on undefined, so this coerced to 0 — and 0 means DISABLED downstream, so a key copied from the template and left unfilled silently removed the pre-auth DoS cap.', () => {
    expect(withGate(''), 'blank is unset, not zero').toBe(600);
  });

  it('CRITICAL a WHITESPACE-ONLY value does the same. This is the version that survives a copy-paste, and it coerced to 0 exactly like the empty string.', () => {
    expect(withGate('   '), 'whitespace is unset, not zero').toBe(600);
    expect(withGate('\t'), 'including a stray tab').toBe(600);
  });

  it('CRITICAL an explicit zero STILL disables the gate. Fail-safe defaulting must not swallow a deliberate instruction — an operator who types 0 means it, and the tests that need the gate off pass it explicitly.', () => {
    expect(withGate('0'), 'an explicit zero is honoured').toBe(0);
  });

  it('CRITICAL a real value still passes through, and garbage still fails the boot. A preprocessor that swallowed unparseable input would trade a silent zero for a silent default, which is the same class of bug wearing different clothes.', () => {
    expect(withGate('900'), 'a configured value is used verbatim').toBe(900);
    expect(() => withGate('abc'), 'unparseable input still throws at boot').toThrow();
  });

  it('CRITICAL zero still MEANS disabled downstream. This guard is only worth having while 0 removes the gate — if bootstrap stopped treating it that way, a blank would be harmless and this file would be guarding nothing.', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const boot = readFileSync(resolve(here, '..', '..', 'src', 'lib', 'bootstrap.ts'), 'utf8');
    expect(boot, 'bootstrap still maps a non-positive value to null').toMatch(
      /config\.globalIpRateLimitPerMin <= 0\s*\n?\s*\?\s*null/,
    );
    const app = readFileSync(resolve(here, '..', '..', 'src', 'lib', 'app.ts'), 'utf8');
    expect(app, 'and app.ts still skips the hook when it is null').toMatch(
      /if \(globalIpGateCfg !== null\) \{/,
    );
  });
});
