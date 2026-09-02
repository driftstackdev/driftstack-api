// The customer's "timezone mismatch on proxies", from the CP side.
//
// The harness renders the session clock from the CP's exit timezone and falls
// back to the archetype when it is null. The launch archetype ships
// `Europe/Istanbul`. And the exit timezone was ALWAYS null — not sometimes:
// it was read straight from Cloudflare's `cf-timezone`, which only arrives with
// the "Add visitor location headers" Managed Transform, and that is off. So
// every production session rendered Turkey time no matter where it egressed,
// while the IP panel beside it showed the real exit.
//
// Measured 2026-09-02 before the fix: a live session through a working US proxy
// cached `country=US, timezone=null`, and GET /v1/egress/echo returned
// `{"country":"NL","region":null,"city":null,"timezone":null}` — one cause for
// all three nulls, since only `cf-ipcountry` is plan-independent.
//
// These arms pin the PRECEDENCE and, most importantly, that an unknown stays
// null. A wrong-but-confident zone is the bug class this whole day was about.

import { describe, it, expect } from 'vitest';
import { resolveExitTimezone, isValidIanaTimeZone } from '../../src/lib/exit-timezone.js';

describe('the edge value wins when the transform is on', () => {
  it('uses the per-IP timezone the edge supplied', () => {
    expect(resolveExitTimezone('America/Los_Angeles', 'US')).toBe('America/Los_Angeles');
  });

  it('prefers the edge over the country even when they disagree', () => {
    // The country table is a fallback, never an override. A Torrance exit whose
    // edge says America/Los_Angeles must NOT be rewritten to the US table's
    // America/New_York.
    expect(resolveExitTimezone('America/Los_Angeles', 'US')).not.toBe('America/New_York');
  });

  it('rejects a malformed edge value rather than shipping it worldwide', () => {
    // Shape alone is not enough: 'America/Atlantis' looks like a zone and is
    // not one. Falls through to the country rather than propagating garbage.
    expect(resolveExitTimezone('America/Atlantis', 'DE')).toBe('Europe/Berlin');
    expect(resolveExitTimezone('not a zone', 'DE')).toBe('Europe/Berlin');
    expect(isValidIanaTimeZone('America/Atlantis')).toBe(false);
    expect(isValidIanaTimeZone('Europe/Berlin')).toBe(true);
  });
});

describe('the country answers when the edge cannot', () => {
  it('resolves the countries the account actually egresses through', () => {
    // These are the exit countries measured on this account today.
    expect(resolveExitTimezone(null, 'US')).toBe('America/New_York');
    expect(resolveExitTimezone(null, 'NL')).toBe('Europe/Amsterdam');
  });

  it('is case-insensitive on the country code', () => {
    expect(resolveExitTimezone(null, 'de')).toBe('Europe/Berlin');
  });

  it('lands in the SAME COUNTRY as the exit, which is the comparison that matters', () => {
    // The point of tier 2. Inside a multi-zone country it may pick the wrong
    // zone, but a US exit reporting a US zone is coherent at the granularity a
    // detector compares; a US exit reporting Europe/Istanbul is a free tell.
    const us = resolveExitTimezone(null, 'US');
    expect(us).not.toBeNull();
    expect(us?.startsWith('America/')).toBe(true);
    expect(us).not.toBe('Europe/Istanbul');
  });
});

describe('an unknown exit stays UNKNOWN', () => {
  it('returns null when neither source can answer', () => {
    // ⛔ The whole point. Null means "we do not know" and the harness keeps its
    // own fallback. Substituting a plausible zone here would be exactly the
    // absent-data-as-measurement bug this fix removes.
    expect(resolveExitTimezone(null, null)).toBeNull();
    expect(resolveExitTimezone(undefined, undefined)).toBeNull();
    expect(resolveExitTimezone('', '')).toBeNull();
  });

  it('returns null for a country the table does not cover', () => {
    // Not a neighbour's zone, not a regional guess. Unknown.
    expect(resolveExitTimezone(null, 'ZZ')).toBeNull();
  });

  it("does not treat Cloudflare's XX (unresolved) as a country", () => {
    expect(resolveExitTimezone(null, 'XX')).toBeNull();
  });
});
