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
import {
  resolveExitTimezone,
  isValidIanaTimeZone,
  COUNTRY_PRIMARY_TIMEZONE,
} from '../../src/lib/exit-timezone.js';

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

// ── The full-ISO-3166 expansion (2026-09-09) — closing A3's ~19% of sessions ──
// that fell to the harness archetype (Europe/Istanbul) because their KNOWN exit
// country had no entry in the original 65.
describe('the country table covers the world with real, valid zones', () => {
  it('⭐ CRITICAL every table value is a real IANA zone this runtime knows — tier 2 ships the value UNVALIDATED, so a typo would reach a customer as a nonexistent zone, which is uniquely identifying and worse than the null it replaced', () => {
    const bad = Object.entries(COUNTRY_PRIMARY_TIMEZONE)
      .filter(([, tz]) => !isValidIanaTimeZone(tz))
      .map(([cc, tz]) => `${cc} -> ${tz}`);
    expect(bad, 'table entries whose zone Intl does not recognise').toEqual([]);
  });

  it('⛔ CRITICAL no entry is an Etc/GMT fixed-offset zone — technically valid but never reported by a real browser, so uniquely identifying', () => {
    const offsets = Object.entries(COUNTRY_PRIMARY_TIMEZONE)
      .filter(([, tz]) => /^Etc\//.test(tz))
      .map(([cc, tz]) => `${cc} -> ${tz}`);
    expect(offsets, 'fixed-offset zones must be a real primary zone instead').toEqual([]);
  });

  it('keys are well-formed ISO-3166-1 alpha-2, unique, and world-scale', () => {
    const keys = Object.keys(COUNTRY_PRIMARY_TIMEZONE);
    for (const k of keys) expect(k).toMatch(/^[A-Z]{2}$/);
    expect(new Set(keys).size).toBe(keys.length);
    // A coverage FLOOR, not an exact count: ~249 codes are assigned; this asserts
    // the table stayed world-scale (was 65) so a regression that guts it reds,
    // without pinning a number that churns every time a territory is added.
    expect(keys.length).toBeGreaterThanOrEqual(230);
  });

  it('resolves countries the original 65-entry table missed — the exact buckets that fell to the archetype', () => {
    // A spread across the regions that were entirely absent before: Latin
    // America, the Gulf, Central Asia, and smaller Europe.
    expect(resolveExitTimezone(null, 'EC')).toBe('America/Guayaquil');
    expect(resolveExitTimezone(null, 'QA')).toBe('Asia/Qatar');
    expect(resolveExitTimezone(null, 'KZ')).toBe('Asia/Almaty');
    expect(resolveExitTimezone(null, 'UY')).toBe('America/Montevideo');
    expect(resolveExitTimezone(null, 'CR')).toBe('America/Costa_Rica');
    expect(resolveExitTimezone(null, 'MT')).toBe('Europe/Malta');
    expect(resolveExitTimezone(null, 'GE')).toBe('Asia/Tbilisi');
    // ...and still returns the SAME country the exit is in, never the archetype.
    expect(resolveExitTimezone(null, 'EC')).not.toBe('Europe/Istanbul');
  });
});
