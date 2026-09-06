// "Geo spoofing is instantly rejected, but we want to spoof it, even live
// geolocation API spoofing matching our IP. Fully featured and exactly like a
// real location." (owner item T-11.)
//
// The fork already overrides navigator.geolocation and, with no explicit
// override, auto-derives the location from the exit IP — but coarsely. A2's half
// is to feed it the ACCURATE exit coordinates the pre-launch probe measured
// (Cloudflare cf-iplatitude/longitude), so the reported location matches the exit
// IP precisely. These arms pin the resolution rule the dispatch applies.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveDispatchGeolocation } from '../../src/routes/agent-sessions.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROUTE = readFileSync(resolve(HERE, '..', '..', 'src', 'routes', 'agent-sessions.ts'), 'utf8');

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

  it('CRITICAL the dispatch REPORTS which geolocation it sent, and names all three outcomes', () => {
    // ⛔ Resolving correctly is half the property. T-11 asks whether the page
    // ends up matching the exit IP, and answering that needs the coordinates the
    // control plane actually DISPATCHED — not coordinates re-derived by calling
    // the resolver again, which would test this file's other arms a second time
    // and say nothing about the wire. The item sat open through two verification
    // attempts partly because there was no authoritative CP-side record.
    const log = ROUTE.slice(
      ROUTE.indexOf("component: 'fleet-session-dispatch'"),
      ROUTE.indexOf("'dispatched sessionAssign to fleet node'"),
    );
    expect(log.length, 'the dispatch log block was not found').toBeGreaterThan(200);
    expect(log).toContain('geolocation:');
    expect(log).toContain('resolvedGeolocation.latitude');
    expect(log).toContain('resolvedGeolocation.longitude');
    // The three outcomes are distinguishable. `unset` is a real answer — the box
    // falls back to its own IP derivation — and must not be logged as an absent
    // field, which would read as "we forgot to log it".
    for (const source of ['unset-harness-derives', 'customer-override', 'exit-measured']) {
      expect(log, `${source} must be a named outcome`).toContain(source);
    }
  });

  it('VACUITY CONTROL: with neither an override nor measured coordinates it is left unset — the harness keeps its IP fallback, never a fabricated 0,0', () => {
    expect(resolveDispatchGeolocation(undefined, undefined)).toBeUndefined();
    expect(resolveDispatchGeolocation(undefined, { lat: null, lon: null })).toBeUndefined();
    expect(resolveDispatchGeolocation(undefined, { lat: 52.37 })).toBeUndefined();
  });
});
