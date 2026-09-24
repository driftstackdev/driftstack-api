// Turning on two-factor sends the current password.
//
// Sign-in re-audit, round 1, new defect 3 (LOW). Turning on two-factor for an
// account with a password needs that password (`current_password` on
// POST /v1/account/mfa/verify). The Go SDK has the field and the Python SDK
// passes a dict through, but the TypeScript SDK's `MfaVerifyRequest` had only
// `code`, so a TypeScript caller could not send it without a cast:
//
//   client.mfa.verify({ code, current_password })
//   -> TS2353 'current_password' does not exist in type 'MfaVerifyRequest'
//
// The first arm is checked by `tsc` (this directory is in the SDK's tsconfig):
// against the old one-field interface the object literal below is a type error.
// The second holds the request type to the server's own schema, field for field.

import { describe, expect, it } from 'vitest';
import { CompleteMfaEnrollmentRequestSchema } from '@driftstack/api-types';
import { MfaResource, type MfaVerifyRequest } from '../../src/resources/mfa.js';
import type { HttpClient } from '../../src/http.js';

interface RequestOpts {
  method: string;
  path: string;
  body?: unknown;
}

describe('turning on two-factor sends the current password', () => {
  it('verify({ code, current_password }) type-checks and sends both fields', async () => {
    const calls: RequestOpts[] = [];
    const http = {
      request: (opts: RequestOpts) => {
        calls.push(opts);
        return Promise.resolve({ recovery_codes: [] });
      },
    } as unknown as HttpClient;

    const body: MfaVerifyRequest = { code: '123456', current_password: 'the current password' };
    await new MfaResource(http).verify(body);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toBe('/v1/account/mfa/verify');
    expect(calls[0]?.body).toEqual({ code: '123456', current_password: 'the current password' });
  });

  it('an account without a password can still leave it out', () => {
    const body: MfaVerifyRequest = { code: '123456' };
    expect(CompleteMfaEnrollmentRequestSchema.safeParse(body).success).toBe(true);
  });

  it('every field the server reads is a field of MfaVerifyRequest', () => {
    // A value of the SDK type with every optional field present. A field the
    // server reads and the type lacks fails the comparison; a field the type
    // gains and this literal lacks fails `tsc` on `Required<…>`.
    const everyField: Required<MfaVerifyRequest> = {
      code: '123456',
      current_password: 'the current password',
    };
    expect(Object.keys(everyField).sort()).toEqual(
      Object.keys(CompleteMfaEnrollmentRequestSchema.shape).sort(),
    );
  });
});
