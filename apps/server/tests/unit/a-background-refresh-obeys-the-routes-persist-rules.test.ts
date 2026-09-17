// ITEM 4 — the background refresher writes the SAME two columns the /:id/test
// route writes, under the SAME rules.
//
// Those rules were written once, as closures inside the route handler, and they
// are not obvious from the column types: a miss must write NOTHING (never null a
// stored reading, never coerce a cause into a value), an ip without geo must not
// overwrite an ip WITH geo, and any exit observation spends the contradiction
// stamp that predates it. A second writer that got any one of them slightly wrong
// would not fail anything — it would quietly erase readings.
//
// `services/proxy-reading-persist.ts` is now the single implementation and the
// cases below drive it directly. The last two cases are the other half: they read
// `routes/account-me.ts` and require the route's own copy to still encode rule 1
// and to still spell the customer sentence exactly as this module does, so the
// two cannot drift while the route is switched over.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  customerOsFingerprintReason,
  exitObservationUpdates,
  osFingerprintUpdates,
  readingWasTakenThroughCurrentIdentity,
  type ObservedOsFingerprint,
  type ProxyProbedIdentity,
  type ProxyReadingRowView,
} from '../../src/services/proxy-reading-persist.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ACCOUNT_ME = resolve(HERE, '..', '..', 'src', 'routes', 'account-me.ts');

const AT = new Date('2026-09-16T12:00:00.000Z');

const reading: ObservedOsFingerprint = {
  os: 'linux',
  confidence: 'high',
  reason: 'Based on how this proxy responds to a network connection.',
  observed_ip: '198.51.100.9',
  observed_via: 'proxy_host',
};

const rowWith = (over: Partial<ProxyReadingRowView> = {}): ProxyReadingRowView => ({
  osFingerprintAt: null,
  exitObserved: null,
  exitObservedAt: null,
  exitSupersededAt: null,
  ...over,
});

describe('the rules for writing a measured reading onto a saved proxy row', () => {
  it('CRITICAL a MISS writes nothing at all. Absence is not a measurement: the three os_fingerprint_unavailable causes are reasons there is no value, and a writer that turned one into an update would null a reading somebody actually took.', () => {
    expect(
      osFingerprintUpdates({ observed: undefined, at: AT, row: rowWith() }),
      'no update — not an update setting the column to undefined, which reads the same in a Drizzle set and is not the same claim',
    ).toBeNull();
    expect(
      exitObservationUpdates({
        incoming: undefined,
        observedVia: 'probe',
        at: AT,
        row: rowWith({
          exitObserved: {
            ip: '203.0.113.1',
            country: 'NL',
            timezone: 'Europe/Amsterdam',
            observed_via: 'session',
          },
        }),
      }),
      'and a miss beside a STORED exit is exactly the case that must not clear it',
    ).toBeNull();
  });

  it("CRITICAL an exit observed WITHOUT geo never overwrites the same exit WITH geo. A vantage that sends the ip alone is not evidence the country is gone — it is a frame that predates the exit_* keys — and writing {country: null} over a live session's observation erases a real reading.", () => {
    const stored = {
      ip: '203.0.113.1',
      country: 'NL',
      timezone: 'Europe/Amsterdam',
      observed_via: 'session' as const,
    };
    expect(
      exitObservationUpdates({
        incoming: { ip: '203.0.113.1', country: null, timezone: null },
        observedVia: 'probe',
        at: AT,
        row: rowWith({ exitObserved: stored }),
      }),
      'nothing to write: same exit, less detail',
    ).toBeNull();

    // A DIFFERENT exit with no geo is a real change and is written.
    expect(
      exitObservationUpdates({
        incoming: { ip: '198.51.100.4', country: null, timezone: null },
        observedVia: 'probe',
        at: AT,
        row: rowWith({ exitObserved: stored }),
      }),
    ).toEqual({
      exitObserved: {
        ip: '198.51.100.4',
        country: null,
        timezone: null,
        observed_via: 'probe',
      },
      exitObservedAt: AT,
      exitSupersededAt: null,
    });
  });

  it('CRITICAL any exit observation SPENDS a contradiction stamp older than it — including the geo-downgrade case, where the observation happened even though the write did not. A stamp left behind makes every client refuse an exit that was just seen up.', () => {
    const stored = {
      ip: '203.0.113.1',
      country: 'NL',
      timezone: 'Europe/Amsterdam',
      observed_via: 'session' as const,
    };
    expect(
      exitObservationUpdates({
        incoming: { ip: '203.0.113.1', country: null, timezone: null },
        observedVia: 'probe',
        at: AT,
        row: rowWith({
          exitObserved: stored,
          exitSupersededAt: new Date('2026-09-15T00:00:00.000Z'),
        }),
      }),
      'the downgrade refuses the exit write and still clears the stamp',
    ).toEqual({ exitSupersededAt: null });
  });

  it('CRITICAL a reading the row took AFTER our probe began wins. Only the background sweep passes this instant; the interactive route passes none and is unaffected.', () => {
    const probeStartedAt = new Date('2026-09-16T11:59:40.000Z');
    const newer = new Date('2026-09-16T11:59:50.000Z');
    const older = new Date('2026-09-16T11:59:30.000Z');

    expect(
      osFingerprintUpdates({
        observed: reading,
        at: AT,
        row: rowWith({ osFingerprintAt: newer }),
        yieldToReadingsAfter: probeStartedAt,
      }),
      'stand down: the stored reading is newer than our dial',
    ).toBeNull();
    expect(
      osFingerprintUpdates({
        observed: reading,
        at: AT,
        row: rowWith({ osFingerprintAt: older }),
        yieldToReadingsAfter: probeStartedAt,
      }),
      'a reading older than our dial is ours to replace',
    ).toEqual({ osFingerprint: reading, osFingerprintAt: AT });
    expect(
      osFingerprintUpdates({
        observed: reading,
        at: AT,
        row: rowWith({ osFingerprintAt: newer }),
      }),
      'and with no instant passed, the rule is inert — the route is byte-for-byte unchanged',
    ).toEqual({ osFingerprint: reading, osFingerprintAt: AT });
  });

  it('CRITICAL rule 4 — a reading may only be written while the row still carries the identity it was measured through. Both writers dial for up to ~18 seconds; a PUT in that window repoints the row AND clears these columns in one statement, so a write landing after it restores a reading of the old machine dated after the move. The staleness tie-break cannot catch it: the invalidation nulls the timestamps it reads.', () => {
    const probed: ProxyProbedIdentity = {
      scheme: 'socks5',
      host: 'gw.example.com',
      port: 1080,
      username: 'user-country-us',
      wrappedPassword: 'v2:envelope-a',
      wrappedSecret: null,
    };
    // A VPN row: host and port are a display address, so the tunnel material is
    // the only column a key rotation moves.
    const tunnel: ProxyProbedIdentity = {
      scheme: 'wireguard',
      host: 'vpn.example.com',
      port: 51820,
      username: null,
      wrappedPassword: null,
      wrappedSecret: 'v2:secret-a',
    };

    expect(
      readingWasTakenThroughCurrentIdentity(probed, { ...probed }),
      'the row did not move: the reading is ours to write',
    ).toBe(true);
    expect(readingWasTakenThroughCurrentIdentity(tunnel, { ...tunnel })).toBe(true);
    for (const rotated of [
      { ...tunnel, wrappedSecret: 'v2:secret-b' },
      { ...tunnel, wrappedSecret: null },
    ]) {
      expect(
        readingWasTakenThroughCurrentIdentity(tunnel, rotated),
        `a rotated tunnel is a different machine behind the same address: ${JSON.stringify(rotated)}`,
      ).toBe(false);
    }

    for (const moved of [
      { ...probed, host: 'gw2.example.com' },
      { ...probed, port: 1081 },
      { ...probed, scheme: 'http' },
      { ...probed, username: 'user-country-de' },
      // A re-wrapped envelope reads as a change here — the AEAD nonce is random,
      // so this boundary cannot tell a rotation from a resubmission, and the
      // cheap direction is to lose one refresh cycle.
      { ...probed, wrappedPassword: 'v2:envelope-b' },
      { ...probed, wrappedPassword: null },
    ]) {
      expect(
        readingWasTakenThroughCurrentIdentity(probed, moved),
        `a reading taken through the previous identity must not be written back: ${JSON.stringify(moved)}`,
      ).toBe(false);
    }
  });

  it("CRITICAL the /:id/test route still encodes rule 1 — a fingerprint that was NOT observed writes nothing. This is the pin that stops the route's own copy of these rules from drifting from the module above while it is switched over. If this went red because the closure was refactored, the fix is to delegate to services/proxy-reading-persist.ts, not to loosen this.", () => {
    const route = readFileSync(ACCOUNT_ME, 'utf8');
    expect(
      route,
      'the route persists an OS fingerprint only when one was observed; a cause is not a measurement',
    ).toMatch(/if\s*\(\s*fp\s*===\s*undefined\s*\)\s*return;/);
  });

  it('CRITICAL both writers spell the customer-facing `reason` identically. It is stored in jsonb and the /proxies list parses it through the published schema, so a person reads it — and a customer must not be able to tell which vantage measured their proxy by getting a different sentence.', () => {
    const route = readFileSync(ACCOUNT_ME, 'utf8');
    const body = /function customerOsFingerprintReason\([\s\S]*?\n\}/.exec(route)?.[0];
    expect(
      body,
      "the route's copy was not found — this comparison cannot pass vacuously",
    ).toBeTypeOf('string');
    const sentences = [...(body ?? '').matchAll(/'([^']{20,})'/g)].map((m) => m[1]);
    expect(sentences, 'both branches of the route copy').toHaveLength(2);
    expect(
      new Set(sentences),
      'every sentence the route can produce must be one this module also produces',
    ).toEqual(
      new Set([customerOsFingerprintReason('unknown'), customerOsFingerprintReason('linux')]),
    );
  });
});
