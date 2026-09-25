// Owner item 9 (2026-09-24, verbatim): "The UDP, QUIC, Apple badges not always
// show currently still at auto proxy state detection. Has not been measured, but
// QUIC did, or the other way around, it's very confusing, they should all always
// show accurate stats."
//
// ROOT CAUSE (one of several — this file pins the wire half). On 2026-09-21 the
// server began answering `POST /v1/account/me/proxies/:id/test` in customer words
// (services/customer-safe-proxy-test-vocabulary.ts, applied to EVERY reply by
// `toPublicProxyTestResult`):
//   not_run                      node_busy | node_error | no_node → check_unavailable
//                                unresolvable                     → config_unresolvable
//   os_fingerprint_unavailable   vpn_tunnel   → not_available_for_vpn
//                                not_observed → not_captured
//                                observer_off → not_offered_here
// The app's parsers (`cleanTestNotRun`, `isOsFingerprintUnavailable`) still
// admitted only the internal words, so:
//   · a busy check during the automatic capability check (`check_unavailable`)
//     lost its `not_run`, `serverProbeOutcome` classified the reply as `failed`,
//     and `saveFleetFailure` DROPPED the row's OS / QUIC / UDP readings and
//     painted "tunnel down" — for a check that never ran. The next check put
//     them back. Measured, then "not measured", then measured again.
//   · every OS cause was dropped, so a row whose OS could not be captured this
//     time read "OS not measured yet. Run Test" beside readings that were.
//
// Pinned: the public words land in the SAME state as the internal ones (a
// not-run, never a failure; the cause, never "not measured"), and the internal
// words an older server sends still do.

import { describe, expect, it } from 'vitest';
import { cleanTestNotRun } from '../../src/lib/account-proxies';
import { cleanOsFingerprintUnavailable } from '../../src/lib/os-fingerprint-verdict';
import { serverProbeOutcome } from '../../src/lib/proxy-server-test';

describe('owner item 9 — the server’s customer words land in the same badge state', () => {
  it('CRITICAL check_unavailable (a busy / failed / absent check) is a not-run, never a failed proxy', () => {
    expect(cleanTestNotRun('check_unavailable')).toBe('no_node');
    const outcome = serverProbeOutcome(
      {
        ok: false,
        reason: 'Our test service is busy right now. Try again in a minute.',
        measured_from: 'control_plane',
        not_run: cleanTestNotRun('check_unavailable'),
      },
      1_000,
    );
    expect(outcome.kind).toBe('not_run');
  });

  it('config_unresolvable (and the older `unresolvable`) is a not-run: nothing was dialled', () => {
    expect(cleanTestNotRun('config_unresolvable')).toBe('config_unresolvable');
    expect(cleanTestNotRun('unresolvable')).toBe('config_unresolvable');
  });

  it('the internal words an older server sends are unchanged', () => {
    for (const w of ['live_session', 'node_busy', 'node_error', 'no_node'] as const) {
      expect(cleanTestNotRun(w)).toBe(w);
    }
    // …and the client-minted refusals are never read off the wire.
    expect(cleanTestNotRun('plan_excluded')).toBeUndefined();
    expect(cleanTestNotRun('desktop_credential')).toBeUndefined();
    expect(cleanTestNotRun('something_new')).toBeUndefined();
  });

  it('CRITICAL every public OS cause maps to the cause the chip states — never dropped to "not measured"', () => {
    expect(cleanOsFingerprintUnavailable('not_available_for_vpn')).toBe('vpn_tunnel');
    expect(cleanOsFingerprintUnavailable('not_captured')).toBe('not_observed');
    expect(cleanOsFingerprintUnavailable('not_offered_here')).toBe('observer_off');
    // older servers
    expect(cleanOsFingerprintUnavailable('vpn_tunnel')).toBe('vpn_tunnel');
    expect(cleanOsFingerprintUnavailable('not_observed')).toBe('not_observed');
    expect(cleanOsFingerprintUnavailable('observer_off')).toBe('observer_off');
    expect(cleanOsFingerprintUnavailable('from_the_future')).toBeUndefined();
    expect(cleanOsFingerprintUnavailable(7)).toBeUndefined();
  });

  it('the two maps are the server’s own: every public code it can publish is admitted', async () => {
    // Read the server's closed sets so a code added there reds here first.
    const vocab = await import('../../../server/src/services/customer-safe-proxy-test-vocabulary');
    for (const code of vocab.PUBLIC_PROXY_TEST_NOT_RUN_CODES) {
      expect(cleanTestNotRun(code), `not_run ${code}`).toBeDefined();
    }
    for (const code of vocab.PUBLIC_OS_FINGERPRINT_UNAVAILABLE_CODES) {
      expect(cleanOsFingerprintUnavailable(code), `os cause ${code}`).toBeDefined();
    }
  });
});
