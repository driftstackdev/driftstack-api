// V-1199 — the account-recovery paths resolve a Gmail dot-variant, and keep doing so.
//
// `AuthFlowsService.findAccountByEmailOrCanonical` runs two lookups: the literal email, and the
// canonical (Gmail dot/+tag-folded) form. The canonical half is computed from the helper's
// PARAMETER, which the helper does not normalise:
//
//     private async findAccountByEmailOrCanonical(email: string) {
//       const canonicalEmail = canonicalizeEmailForDedup(email);   // <- raw parameter
//
// and `canonicalizeEmailForDedup` neither trims nor lowercases — its Gmail test is
// `domain === 'gmail.com'`, which a capital G fails. Every caller happens to pass
// `args.email.trim().toLowerCase()`, so this is correct today. It is correct BY CONVENTION,
// held in four call sites, and invisible at the helper that depends on it.
//
// If one caller stopped normalising, `Foo.Bar@Gmail.com` would canonicalise to itself rather
// than to `foobar@gmail.com`, the canonical lookup would miss, and the account would not be
// found. These paths deliberately return a generic "if that address exists" result to avoid
// account enumeration, so the failure is SILENT: a customer whose stored address is a dot-form
// simply never receives the reset mail, and nothing errors.
//
// PRIOR ART, and why this is not it. `canonical-email-sql-matches-the-runtime-drizzle.test.ts`
// pins `args.email.trim().toLowerCase()` inside `signup` — the WRITE path, which decides what
// gets stored — and its own comment notes that "four other methods lowercase too" without
// pinning them. Those four are the READ paths, and they are what this file covers.
//
// WHY THE FIXTURE USES A DOT-VARIANT. The account is registered as `foo.bar@gmail.com` and
// looked up as `FooBar@Gmail.com` — dots removed AND mixed case. Looking it up as
// `Foo.Bar@Gmail.com` would prove nothing: that lowercases to the stored literal, so the
// LITERAL half resolves it and the arm would pass with canonicalisation completely broken.
// Removing the dots is what makes the canonical half the only route to the account.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { createTestLogger } from '../../src/lib/logger.js';
import { createEmailService } from '../../src/services/email.js';
import { AuthFlowsService } from '../../src/services/auth-flows.js';
import { InMemoryAuthFlowsRepo } from './_helpers/in-memory-auth-flows-repo.js';

/** The address as the customer registered it. Its canonical form is `foobar@gmail.com`. */
const REGISTERED = 'foo.bar@gmail.com';
/** The same inbox, typed differently: dots dropped, capitals added. */
const AS_TYPED = 'FooBar@Gmail.com';

function makeService(): AuthFlowsService {
  const logger = createTestLogger();
  return new AuthFlowsService(
    new InMemoryAuthFlowsRepo(),
    createEmailService({ config: null, logger }),
    logger,
    {
      verifyEmailUrl: 'https://app.driftstack.local/verify-email',
      magicLinkUrl: 'https://app.driftstack.local/auth/magic-link',
      passwordResetUrl: 'https://app.driftstack.local/reset-password',
      exposeDebugToken: true,
    },
    null,
    null,
  );
}

async function withRegisteredAccount(): Promise<AuthFlowsService> {
  const service = makeService();
  await service.signup({
    email: REGISTERED,
    password: 'correct horse battery staple',
    requestedFromIp: null,
  });
  return service;
}

describe('V-1199 account recovery resolves a Gmail dot-variant', () => {
  it('CRITICAL requestPasswordReset finds the account when the address is typed without its dots and with capitals. Only the canonical lookup can resolve this, and it is computed from an unnormalised parameter — if the caller stops lowercasing, the reset mail is silently never sent.', async () => {
    const service = await withRegisteredAccount();

    const result = await service.requestPasswordReset({
      email: AS_TYPED,
      requestedFromIp: null,
    });

    expect(
      result.sent,
      `password reset for ${AS_TYPED} did not resolve the account registered as ${REGISTERED}`,
    ).toBe(true);
  });

  it('CRITICAL requestMagicLink finds the account for the same dot-variant. Magic-link is the passwordless entry point, so losing this locks the customer out rather than merely inconveniencing them.', async () => {
    const service = await withRegisteredAccount();

    const result = await service.requestMagicLink({
      email: AS_TYPED,
      requestedFromIp: null,
    });

    expect(
      result.sent,
      `magic-link for ${AS_TYPED} did not resolve the account registered as ${REGISTERED}`,
    ).toBe(true);
  });

  it('CRITICAL resendSignupVerification finds the account for the same dot-variant. This one strands a customer at signup: the account exists, unverified, and the resend that would rescue it reports success while sending nothing.', async () => {
    const service = await withRegisteredAccount();

    const result = await service.resendSignupVerification({
      email: AS_TYPED,
      requestedFromIp: null,
    });

    expect(
      result.sent,
      `resend-verification for ${AS_TYPED} did not resolve the account registered as ${REGISTERED}`,
    ).toBe(true);
  });

  it('CRITICAL every caller of findAccountByEmailOrCanonical normalises the address it passes. The three arms above cover the callers that exist today; this one covers the caller added tomorrow, including `login`, whose failure mode is a customer who cannot sign in at all.', () => {
    const src = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '../../src/services/auth-flows.ts'),
      'utf8',
    );

    // `this.` excludes the helper's own declaration, which is not a call.
    const callSites = [
      ...src.matchAll(/this\.findAccountByEmailOrCanonical\(((?:[^()]|\([^()]*\))*)\)/g),
    ].map((m) => (m[1] ?? '').trim());

    expect(
      callSites.length,
      'no call sites matched, so this arm checked nothing — the helper was renamed or the ' +
        'call shape changed, and the guard silently stopped guarding',
    ).toBeGreaterThanOrEqual(4);

    // Each site must either normalise inline, or hand over a local named `email` — which the
    // per-method check below then holds to being the normalised one. `args.email` passed raw is
    // exactly the regression this exists to catch.
    const methods = src.split(/\n {2}(?:private )?async /).slice(1);
    const offenders: string[] = [];
    for (const body of methods) {
      if (!/this\.findAccountByEmailOrCanonical\(/.test(body)) continue;
      const name = (/^([a-zA-Z]+)\(/.exec(body)?.[1] ?? '?').trim();
      const arg = (
        /this\.findAccountByEmailOrCanonical\(((?:[^()]|\([^()]*\))*)\)/.exec(body)?.[1] ?? ''
      ).trim();

      const normalisedInline = arg.includes('.trim().toLowerCase()');
      const normalisedLocal =
        arg === 'email' && /const email = args\.email\.trim\(\)\.toLowerCase\(\);/.test(body);
      if (!normalisedInline && !normalisedLocal) offenders.push(`${name}(${arg})`);
    }

    expect(
      offenders,
      'these callers hand findAccountByEmailOrCanonical an address they have not lowercased. ' +
        'canonicalizeEmailForDedup tests `domain === "gmail.com"`, so a capital G skips the ' +
        'Gmail folding entirely and the canonical lookup silently misses',
    ).toEqual([]);
  });
});
