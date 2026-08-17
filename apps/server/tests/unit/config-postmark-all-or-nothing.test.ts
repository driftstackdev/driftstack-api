// Email is configured completely or not at all.
//
// `readPostmarkConfig` returns a config only when all three of
// POSTMARK_API_TOKEN / POSTMARK_FROM / POSTMARK_REPLY_TO are present, and null
// otherwise. Nothing exercised that: every mention of these variables in the
// test tree is a documentation sweep or a parity pin, so the resolution itself
// — one of the remaining branch gaps in `lib/config.ts` — has never run.
//
// The all-or-nothing rule is what keeps a half-configured deploy honest. A
// config object missing its `from` address does not fail at boot; it fails at
// SEND time, one message at a time, on exactly the flows a locked-out customer
// depends on — password reset and email verification. The operator sees a
// service that started cleanly, and the failure surfaces as customers reporting
// they never got the mail.
//
// Returning null instead is the loud-by-omission option: the caller wires no
// mailer at all, which is a state the rest of the system already understands and
// reports.
//
// Blank values get their own arm because `!value` treats '' and undefined alike,
// and a blank is what a half-filled deploy template actually produces — the same
// hazard `blank-env-value-does-not-disable-the-ip-gate` pins on the IP gate. An
// env var that is present-but-empty is the normal shape of a partly-filled
// secrets file, not an exotic case.

import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/lib/config.js';

const BASE: NodeJS.ProcessEnv = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
};

const FULL = {
  POSTMARK_API_TOKEN: 'pm-token',
  POSTMARK_FROM: 'noreply@driftstack.dev',
  POSTMARK_REPLY_TO: 'support@driftstack.dev',
} as const;

const postmark = (
  env: NodeJS.ProcessEnv,
): { apiToken: string; from: string; replyTo: string } | null =>
  loadConfig({ ...BASE, ...env }).postmark ?? null;

describe('Postmark config is all-or-nothing', () => {
  it('CRITICAL all three variables present yields a usable config', () => {
    expect(
      postmark(FULL),
      'a fully configured deploy did not resolve an email config — every transactional email would ' +
        'be silently disabled',
    ).toEqual({
      apiToken: 'pm-token',
      from: 'noreply@driftstack.dev',
      replyTo: 'support@driftstack.dev',
    });
  });

  it('CRITICAL no variables at all yields null rather than a partial config', () => {
    expect(postmark({})).toBeNull();
  });

  it.each([
    ['POSTMARK_API_TOKEN', { ...FULL, POSTMARK_API_TOKEN: undefined }],
    ['POSTMARK_FROM', { ...FULL, POSTMARK_FROM: undefined }],
    ['POSTMARK_REPLY_TO', { ...FULL, POSTMARK_REPLY_TO: undefined }],
  ])('CRITICAL a deploy missing %s disables email rather than half-configuring it', (name, env) => {
    expect(
      postmark(env as NodeJS.ProcessEnv),
      `${name} was missing and a config was resolved anyway. That does not fail at boot — it fails ` +
        'at SEND time, one message at a time, on password reset and email verification, and the ' +
        'operator sees a service that started cleanly',
    ).toBeNull();
  });

  it.each([
    ['POSTMARK_API_TOKEN', { ...FULL, POSTMARK_API_TOKEN: '' }],
    ['POSTMARK_FROM', { ...FULL, POSTMARK_FROM: '' }],
    ['POSTMARK_REPLY_TO', { ...FULL, POSTMARK_REPLY_TO: '' }],
  ])('CRITICAL a BLANK %s counts as missing, not as configured', (name, env) => {
    // A present-but-empty variable is the normal shape of a partly-filled
    // secrets file, not an exotic case.
    expect(
      postmark(env as NodeJS.ProcessEnv),
      `a blank ${name} was treated as configured`,
    ).toBeNull();
  });
});
