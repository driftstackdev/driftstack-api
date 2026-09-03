// "Geo spoofing is instantly rejected, but we want to spoof it, even live
// geolocation API spoofing matching our IP. Fully featured and exactly like a
// real location." (owner item T-11.)
//
// The fork already overrides navigator.geolocation and, with no explicit
// override, auto-derives the location from the exit IP — but coarsely. A2's half
// is to feed it the ACCURATE exit coordinates the pre-launch probe measured
// (Cloudflare cf-iplatitude/longitude), so the reported location matches the exit
// IP precisely. These arms pin the resolution rule the dispatch applies.

import { describe, expect, it } from 'vitest';
import { resolveDispatchGeolocation } from '../../src/routes/agent-sessions.js';

describe('geolocation matches the exit IP when the customer set none', () => {
  it('derives from the measured exit coordinates when there is no explicit override', () => {
    expect(resolveDispatchGeolocation(undefined, { lat: 52.37, lon: 4.9 })).toEqual({
      latitude: 52.37,
      longitude: 4.9,
    });
  });

  it('an explicit customer override always wins over the exit coordinates', () => {
    expect(
      resolveDispatchGeolocation(
        { latitude: 1, longitude: 2, accuracy: 20 },
        { lat: 52.37, lon: 4.9 },
      ),
    ).toEqual({ latitude: 1, longitude: 2, accuracy: 20 });
  });

  it('VACUITY CONTROL: with neither an override nor measured coordinates it is left unset — the harness keeps its IP fallback, never a fabricated 0,0', () => {
    expect(resolveDispatchGeolocation(undefined, undefined)).toBeUndefined();
    expect(resolveDispatchGeolocation(undefined, { lat: null, lon: null })).toBeUndefined();
    expect(resolveDispatchGeolocation(undefined, { lat: 52.37 })).toBeUndefined();
  });
});
