// parseProfileId — accepts the canonical prefixed id the API returns
// (prof_<uuid>) AND a bare uuid (back-compat), normalizes to the bare uuid,
// and 400s on anything else.

import { describe, expect, it } from 'vitest';
import { parseProfileId } from '../../src/lib/profile-id.js';
import { BadRequestError } from '../../src/lib/errors.js';

const UUID = '11111111-2222-4333-8444-555555555555';

describe('parseProfileId', () => {
  it('strips the prof_ prefix → bare uuid (the form the API returns)', () => {
    expect(parseProfileId(`prof_${UUID}`)).toBe(UUID);
  });

  it('accepts a bare uuid unchanged (historical contract — no client breaks)', () => {
    expect(parseProfileId(UUID)).toBe(UUID);
  });

  it('is case-insensitive on the uuid hex', () => {
    expect(parseProfileId(`prof_${UUID.toUpperCase()}`)).toBe(UUID.toUpperCase());
  });

  it('throws 400 on a prof_-prefixed non-uuid', () => {
    expect(() => parseProfileId('prof_not-a-uuid')).toThrow(BadRequestError);
  });

  it('throws 400 on a bare non-uuid', () => {
    expect(() => parseProfileId('garbage')).toThrow(BadRequestError);
    expect(() => parseProfileId('')).toThrow(BadRequestError);
  });

  it('does NOT strip a second prefix / over-eager match (only one prof_)', () => {
    // prof_prof_<uuid> → strips one prof_, leaving prof_<uuid> which is not a
    // bare uuid → 400 (no silent double-strip).
    expect(() => parseProfileId(`prof_prof_${UUID}`)).toThrow(BadRequestError);
  });
});
