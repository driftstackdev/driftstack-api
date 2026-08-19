// V-960 — the unknown-field exemption for anonymous auth routes, earned per route
// instead of granted to the whole surface.
//
// `unknown-request-fields.ts` does not report ignored fields on the unauthenticated
// auth endpoints. V-951 measured both reasons originally given for that and found
// neither holds as stated: the shapes are published in the OpenAPI document, so
// echoing a key back discloses nothing, and the failure mode does apply to at least
// one of these routes.
//
// What survives is narrower, and it is a property of each schema rather than of the
// surface: **a mistyped field can only be dropped silently if the schema has a field
// it is willing to do without.** Where every field is required, a typo is a MISSING
// REQUIRED FIELD — zod answers 400 and the caller is told exactly what happened. The
// mechanism has nothing to add there, and its absence is correct rather than
// inherited.
//
// Measured across the fifteen, and the arithmetic is exact because a vague count is
// how this kind of claim rots: ELEVEN are importable from api-types and drop-proof —
// ten declare no optional field at all, and `MfaChallengeRequestSchema` declares two
// but carries a `.refine()` requiring one of them, so it cannot be satisfied with both
// dropped either. TWO more are defined inside `auth-oauth-client.ts` rather than
// api-types, so they cannot be imported and are checked against that source. That
// leaves TWO where the drop is real, pinned below as an open decision rather than
// described in prose that nothing checks. 11 + 2 + 2 = 15.
//
// The point of this file is the direction of failure. Adding an optional field to
// `LoginRequestSchema` tomorrow would make its exemption unearned, and nothing would
// have said so — the route would silently start accepting a mistyped field and
// answering success. That edit fails here, naming the route.
//
// It took two passes to make that sentence true, and the failure is worth recording
// because it is the shape this arc keeps finding in other people's guards. The first
// version ran each schema over a body with ONE hand-picked key misspelled. That tests
// whether THAT key is droppable; it says nothing about a field added later. Proved by
// mutation: adding `remember_me: z.boolean().optional()` to `LoginRequestSchema` — the
// literal edit the paragraph above promises to catch — left all four arms green, even
// after rebuilding the package. A guard whose header describes a protection its code
// does not implement is the thing V-951, V-955 and V-956 were each about.
//
// So the check is now DERIVED from the schema rather than from a fixture: every
// declared field must be non-optional. Both halves are needed — `.isOptional()` alone
// would condemn `MfaChallengeRequestSchema`, whose two optional fields are made
// at-least-one by a `.refine()`, so that one carries a reasoned entry and is proved
// behaviourally instead.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CliAuthorizeExchangeRequestSchema,
  CliAuthorizeInitiateRequestSchema,
  LoginRequestSchema,
  LogoutRequestSchema,
  MagicLinkConsumeRequestSchema,
  MagicLinkRequestSchema,
  MfaChallengeRequestSchema,
  PasswordResetConfirmRequestSchema,
  PasswordResetRequestSchema,
  RefreshSessionRequestSchema,
  ResendVerificationRequestSchema,
  SignupRequestSchema,
  VerifyEmailRequestSchema,
} from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

interface ParsesLike {
  safeParse: (v: unknown) => { success: boolean; data?: unknown };
}

/**
 * Declared fields a schema is willing to do without, unwrapping `.refine()`.
 *
 * A refined schema is a `ZodEffects` with no `.shape`, so the inner object has to be
 * reached through `_def.schema` — the same unwrapping `knownRequestKeys` performs for
 * the reporter itself.
 */
function optionalFieldsOf(schema: unknown): string[] {
  let cur = schema as {
    shape?: Record<string, { isOptional?: () => boolean }>;
    _def?: { schema?: unknown };
  };
  for (let depth = 0; depth < 6; depth += 1) {
    if (cur?.shape !== undefined) {
      return Object.entries(cur.shape)
        .filter(([, v]) => v.isOptional?.() === true)
        .map(([k]) => k);
    }
    const inner = cur?._def?.schema;
    if (inner === undefined) return [];
    cur = inner as typeof cur;
  }
  return [];
}

/**
 * Anonymous auth routes whose schema CANNOT silently drop a mistyped field.
 *
 * `valid` is a body the schema accepts; `typo` is the same body with one key
 * misspelled. If the schema still accepts the typo body, the field was dropped in
 * silence and the exemption is no longer earned.
 */
const CANNOT_DROP: ReadonlyArray<{
  route: string;
  schema: ParsesLike;
  valid: Record<string, unknown>;
  typo: Record<string, unknown>;
  /** Optional fields a `.refine()` makes at-least-one, with the omit test below as proof. */
  refineCovers?: readonly string[];
}> = [
  {
    route: 'POST /v1/auth/login',
    schema: LoginRequestSchema,
    valid: { email: 'a@example.com', password: 'a-sufficiently-long-passphrase-1' },
    typo: { email: 'a@example.com', passwrd: 'a-sufficiently-long-passphrase-1' },
  },
  {
    route: 'POST /v1/auth/logout',
    schema: LogoutRequestSchema,
    valid: { token: 'x'.repeat(40) },
    typo: { tokn: 'x'.repeat(40) },
  },
  {
    route: 'POST /v1/auth/refresh',
    schema: RefreshSessionRequestSchema,
    valid: { token: 'x'.repeat(40) },
    typo: { tokn: 'x'.repeat(40) },
  },
  {
    route: 'POST /v1/auth/verify-email',
    schema: VerifyEmailRequestSchema,
    valid: { token: 'x'.repeat(40) },
    typo: { tokn: 'x'.repeat(40) },
  },
  {
    route: 'POST /v1/auth/resend-verification',
    schema: ResendVerificationRequestSchema,
    valid: { email: 'a@example.com' },
    typo: { emial: 'a@example.com' },
  },
  {
    route: 'POST /v1/auth/magic-link/request',
    schema: MagicLinkRequestSchema,
    valid: { email: 'a@example.com' },
    typo: { emial: 'a@example.com' },
  },
  {
    route: 'POST /v1/auth/magic-link/consume',
    schema: MagicLinkConsumeRequestSchema,
    valid: { token: 'x'.repeat(40) },
    typo: { tokn: 'x'.repeat(40) },
  },
  {
    route: 'POST /v1/auth/password-reset/request',
    schema: PasswordResetRequestSchema,
    valid: { email: 'a@example.com' },
    typo: { emial: 'a@example.com' },
  },
  {
    route: 'POST /v1/auth/password-reset/confirm',
    schema: PasswordResetConfirmRequestSchema,
    valid: { token: 'x'.repeat(40), new_password: 'a-sufficiently-long-passphrase-1' },
    typo: { token: 'x'.repeat(40), new_passwrd: 'a-sufficiently-long-passphrase-1' },
  },
  {
    route: 'POST /v1/auth/cli-authorize/exchange',
    schema: CliAuthorizeExchangeRequestSchema,
    valid: { code: 'x'.repeat(40), state: 'y'.repeat(40) },
    typo: { code: 'x'.repeat(40), stat: 'y'.repeat(40) },
  },
  {
    // Two optional-looking fields, but the refine requires one of them — so a
    // mistyped `code` leaves neither present and the parse fails. This is the
    // case `.isOptional()` alone would have got wrong.
    route: 'POST /v1/auth/mfa/challenge',
    schema: MfaChallengeRequestSchema,
    refineCovers: ['code', 'recovery_code'],
    valid: { challenge_token: 'x'.repeat(40), code: '123456' },
    typo: { challenge_token: 'x'.repeat(40), cod: '123456' },
  },
];

/**
 * The two anonymous routes where the drop is REAL, recorded as an open decision.
 *
 * Wiring the reporter here changes what an unauthenticated caller sees, which is a
 * product decision rather than a defect fix. What is not in doubt is the behaviour,
 * so it is pinned: if either schema stops dropping the field — because it became
 * required, or the route started reporting — this fails and the decision is moot.
 */
const DROPS_SILENTLY: ReadonlyArray<{
  route: string;
  schema: ParsesLike;
  field: string;
  valid: Record<string, unknown>;
  typo: Record<string, unknown>;
}> = [
  {
    route: 'POST /v1/auth/signup',
    schema: SignupRequestSchema,
    field: 'name',
    valid: {
      email: 'a@example.com',
      password: 'a-sufficiently-long-passphrase-1',
      name: 'Alice',
    },
    typo: { email: 'a@example.com', password: 'a-sufficiently-long-passphrase-1', nam: 'Alice' },
  },
  {
    route: 'POST /v1/auth/cli-authorize/initiate',
    schema: CliAuthorizeInitiateRequestSchema,
    field: 'client_label',
    valid: { state: 'y'.repeat(40), client_label: 'my laptop' },
    typo: { state: 'y'.repeat(40), client_labl: 'my laptop' },
  },
];

describe('V-960 the anonymous unknown-field exemption is earned per route', () => {
  it('CRITICAL every fixture is a body the schema really accepts. Each case below concludes something from a REJECTION, so a `valid` body that was itself invalid would make the comparison meaningless — the typo would be refused for the wrong reason and the arm would pass while proving nothing.', () => {
    for (const c of [...CANNOT_DROP, ...DROPS_SILENTLY]) {
      expect(c.schema.safeParse(c.valid).success, `${c.route}: the valid fixture parses`).toBe(
        true,
      );
    }
    expect(CANNOT_DROP.length, 'importable schemas claimed to be drop-proof').toBe(11);
  });

  it('CRITICAL on these routes a mistyped field cannot be dropped in silence — every DECLARED field is required, so the typo is a missing required field and zod answers 400. Derived from each schema rather than from a hand-picked typo: the first version of this arm mistyped one chosen key, which proves nothing about a field added later, and adding an optional field to LoginRequestSchema left it green.', () => {
    const offenders: string[] = [];
    for (const c of CANNOT_DROP) {
      const optional = optionalFieldsOf(c.schema).filter(
        (f) => !(c.refineCovers ?? []).includes(f),
      );
      if (optional.length > 0) offenders.push(`${c.route}: ${optional.join(', ')}`);
    }
    expect(
      offenders,
      'these anonymous routes declare an OPTIONAL field, so a mistyped key is dropped and the ' +
        'request answered as success with nothing said. Either wire reportUnknownRequestFields, ' +
        'make the field required, or record why a refine makes it unreachable',
    ).toEqual([]);

    // The hand-picked typo still runs: it is the concrete demonstration that a
    // misspelled REQUIRED key is refused rather than absorbed.
    const absorbed = CANNOT_DROP.filter((c) => c.schema.safeParse(c.typo).success).map(
      (c) => c.route,
    );
    expect(absorbed, 'a body with a mistyped required key was accepted:').toEqual([]);
  });

  it('CRITICAL exactly two anonymous routes really do drop a field in silence, and the number is pinned. This is the whole of the open decision — not fifteen routes, two — and a third appearing without anyone noticing is the thing this arm exists to stop.', () => {
    expect(DROPS_SILENTLY.length, 'anonymous routes that silently drop a mistyped field').toBe(2);
    for (const c of DROPS_SILENTLY) {
      const parsed = c.schema.safeParse(c.typo);
      expect(parsed.success, `${c.route}: the mistyped body is still accepted`).toBe(true);
      expect(
        (parsed.data as Record<string, unknown> | undefined)?.[c.field],
        `${c.route}: \`${c.field}\` is absent from the parsed result — the customer's value was dropped`,
      ).toBeUndefined();
    }
  });

  it('CRITICAL the two route-local oauth-client bodies declare no optional field either. They are defined in the route file rather than api-types, so they cannot be imported and compared like the rest; asserted against the source instead, which is the only place they exist.', () => {
    const src = readFileSync(
      resolve(REPO_ROOT, 'apps/server/src/routes/auth-oauth-client.ts'),
      'utf8',
    );
    const start = /const StartBodySchema = z\.object\(\{([\s\S]*?)\}\);/.exec(src);
    const confirm = /const ConfirmMergeBodySchema = z\.object\(\{([\s\S]*?)\}\);/.exec(src);
    expect(start, 'StartBodySchema still parses out of the route source').not.toBeNull();
    expect(confirm, 'ConfirmMergeBodySchema still parses out of the route source').not.toBeNull();
    expect(
      start?.[1],
      'StartBodySchema gained an optional field, so a mistyped key is now dropped in silence on an ' +
        'anonymous route and its exemption is no longer earned',
    ).not.toContain('.optional()');
    expect(
      confirm?.[1],
      'ConfirmMergeBodySchema gained an optional field, so its exemption is no longer earned',
    ).not.toContain('.optional()');
  });
});
