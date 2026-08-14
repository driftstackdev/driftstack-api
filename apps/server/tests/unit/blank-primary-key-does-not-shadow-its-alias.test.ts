// A blank primary variable must not shadow a working secondary one.
//
// The Anthropic fallback key can be supplied under either of two names, and the
// config picks one. The outer guard that decides whether the group exists at all
// uses `||`, which skips an empty string. The inner selection three lines below
// uses `??`, which does not. Two different notions of "empty" on the same pair of
// variables, close enough to read as one expression.
//
// So `BYOK_ANTHROPIC_FALLBACK_KEY=` with a correctly-set
// `DRIFTSTACK_ANTHROPIC_FALLBACK_API_KEY` produced `fallbackApiKey: undefined`.
// `'' ?? 'sk-real'` is `''`, the ternary sees a falsy value, and the key is
// dropped — while the outer `||` had already fallen through to the real one, so
// the group WAS created. The operator set the key under the name the code
// documents as an alias and got no key at all, with nothing logged.
//
// This is the second instance of the same shape in this config. A blank
// `GLOBAL_IP_RATE_LIMIT_PER_MIN` coerced to 0 and disabled the pre-auth DoS gate.
// Both are reachable the same way: a key uncommented from an env template and
// left unfilled. The templates now list these variables precisely so operators
// can see them, which is what makes the blank form easy to produce.
//
// The fix is to use one notion of empty. `||` is the correct one here because
// both variables are secrets: an empty secret is not a secret, and preferring a
// real value under the other name is what an operator setting either name means.

import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/lib/config.js';

const BASE: NodeJS.ProcessEnv = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
};

const fallbackKeyFor = (env: NodeJS.ProcessEnv): string | undefined =>
  (loadConfig({ ...BASE, ...env }) as { byokAnthropic?: { fallbackApiKey?: string } }).byokAnthropic
    ?.fallbackApiKey;

/** The Sentry release tag, chosen from the same primary/alias pair shape. */
const releaseFor = (env: NodeJS.ProcessEnv): string | undefined =>
  (
    loadConfig({
      ...BASE,
      SENTRY_DSN: 'https://k@o1.ingest.de.sentry.io/1',
      SENTRY_ENVIRONMENT: 'production',
      ...env,
    }) as {
      sentry?: { release?: string };
    }
  ).sentry?.release;

describe('a blank primary key does not shadow a working alias', () => {
  it('CRITICAL each name alone still supplies the key. These are the baselines — if either stopped working on its own, every assertion below would be measuring against a broken alias rather than the shadowing this file is about.', () => {
    expect(fallbackKeyFor({ BYOK_ANTHROPIC_FALLBACK_KEY: 'sk-primary' }), 'primary alone').toBe(
      'sk-primary',
    );
    expect(
      fallbackKeyFor({ DRIFTSTACK_ANTHROPIC_FALLBACK_API_KEY: 'sk-real' }),
      'secondary alone',
    ).toBe('sk-real');
  });

  it('CRITICAL a BLANK primary falls through to the secondary. `"" ?? x` is `""`, so the blank won and the key was dropped entirely — the operator set it under the documented alias and got nothing, with nothing logged.', () => {
    expect(
      fallbackKeyFor({
        BYOK_ANTHROPIC_FALLBACK_KEY: '',
        DRIFTSTACK_ANTHROPIC_FALLBACK_API_KEY: 'sk-real',
      }),
      'blank primary yields the secondary',
    ).toBe('sk-real');
  });

  it('CRITICAL whitespace behaves like blank. A value that is all spaces is not a secret either, and it is the form that survives a copy-paste out of a template.', () => {
    expect(
      fallbackKeyFor({
        BYOK_ANTHROPIC_FALLBACK_KEY: '   ',
        DRIFTSTACK_ANTHROPIC_FALLBACK_API_KEY: 'sk-real',
      }),
      'whitespace primary yields the secondary',
    ).toBe('sk-real');
  });

  it('CRITICAL a real primary still WINS over the secondary. Precedence is the point of having two names — a fix that made the alias win would be a different bug, and one that silently changes which key a live deploy is using.', () => {
    expect(
      fallbackKeyFor({
        BYOK_ANTHROPIC_FALLBACK_KEY: 'sk-primary',
        DRIFTSTACK_ANTHROPIC_FALLBACK_API_KEY: 'sk-real',
      }),
      'the primary keeps precedence',
    ).toBe('sk-primary');
  });

  it('CRITICAL both blank still means no key. Falling through must end somewhere: two empty values are not a key, and inventing one would be worse than reporting none.', () => {
    expect(
      fallbackKeyFor({
        BYOK_ANTHROPIC_FALLBACK_KEY: '',
        DRIFTSTACK_ANTHROPIC_FALLBACK_API_KEY: '',
      }),
      'no key is configured',
    ).toBeUndefined();
  });
  it('CRITICAL the Sentry release tag has the same rule. `SENTRY_RELEASE ?? GIT_SHA` kept a blank primary and the `release ? …` spread then dropped the tag, so events arrived with no build attribution — quietly, because an untagged event looks exactly like a normal one.', () => {
    expect(releaseFor({ GIT_SHA: 'abc1234' }), 'GIT_SHA alone tags the release').toBe('abc1234');
    expect(
      releaseFor({ SENTRY_RELEASE: '', GIT_SHA: 'abc1234' }),
      'a blank SENTRY_RELEASE falls through to GIT_SHA',
    ).toBe('abc1234');
    expect(
      releaseFor({ SENTRY_RELEASE: 'v2.1.0', GIT_SHA: 'abc1234' }),
      'and an explicit release still wins',
    ).toBe('v2.1.0');
  });
});
