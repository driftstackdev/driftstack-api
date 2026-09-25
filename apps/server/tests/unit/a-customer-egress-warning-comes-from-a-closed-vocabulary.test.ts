// `egress_capabilities.warnings` on a customer response is drawn from a CLOSED
// vocabulary, whatever the device sent.
//
// ⛔ THE DEFECT THIS PINS. `deriveWarnings` builds
// `safeguard_failed:${check.layer}` and `safeguard_missing:${check.layer}` from
// `safeguardChecks[].layer`, which the wire schema declares as
// `z.string().min(1).max(64)` — an OPEN string, chosen by the device, with
// nothing bounding what it can say. That list was persisted and then echoed
// verbatim on four session responses and a webhook. Two codes beside it named
// our own mechanisms (`h3_interpose_unavailable`,
// `safeguards_expectation_unreported`) and were documented nowhere.
//
// The arms below are the properties, not examples of them: TOTAL over arbitrary
// input, CLOSED over its output, and silent about any layer it does not know.
// The vocabulary itself is asserted against the documentation by
// `a-public-egress-warning-cannot-ship-undocumented.test.ts`; this file asserts
// the function that produces it.

import { describe, expect, it } from 'vitest';
import {
  createUnmappedEgressWarningRecorder,
  customerSafeEgressCapabilities,
  customerSafeEgressWarnings,
  isPublicEgressWarning,
  PUBLIC_EGRESS_WARNINGS,
  PUBLIC_SAFEGUARD_LAYERS,
  reportableEgressWarning,
} from '../../src/services/customer-safe-egress-warnings.js';

/** The internal vocabulary, as `session-capability-report-relay.ts` emits it.
 *  Kept here by hand ON PURPOSE: importing the producer would make this test
 *  agree with whatever the producer does, which is the agreement that lets a
 *  new internal code ship unnoticed. */
const INTERNAL_CODES = [
  'udp_unsupported_by_proxy',
  'h3_interpose_unavailable',
  'safeguards_unreported',
  'safeguard_failed:network_firewall',
  'safeguard_failed:webkit_gate',
  'safeguard_failed:per_spawn_verification',
  'safeguard_failed:screen_recording',
  'safeguard_missing:network_firewall',
  'safeguard_missing:webkit_gate',
  'safeguard_missing:per_spawn_verification',
  'safeguard_missing:screen_recording',
  'safeguards_expectation_unreported',
  'streaming_blank',
  'streaming_failed',
  'dead_proxy',
  // On a session with no proxy of its own (the agent session's proxyId is null):
  // `dead_proxy`, the UDP gap and the failed route check are the connection
  // Driftstack provides, not a proxy of the customer's.
  'default_connection_down',
  'udp_unsupported_by_default_connection',
  'default_connection_verification_failed',
] as const;

/**
 * A seeded generator, so a failure reproduces from the printed seed rather than
 * disappearing on the next run. Small on purpose: 32-bit xorshift is plenty for
 * "throw a few thousand strings at a total function".
 */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0 || 0x9e3779b9;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x1_0000_0000;
  };
}

const ALPHABET = [
  ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_:-./ <>"\'\\{}[]$&;|`\n\t\u0000é😀',
];

function randomString(rand: () => number, maxLength: number): string {
  const length = Math.floor(rand() * maxLength);
  let out = '';
  for (let i = 0; i < length; i++) {
    out += ALPHABET[Math.floor(rand() * ALPHABET.length)] ?? 'x';
  }
  return out;
}

describe('the public egress warning vocabulary is closed', () => {
  it('POSITIVE CONTROL — the vocabulary is real, non-trivial, and every member is a plain code', () => {
    // A vocabulary that had collapsed to [] would make every containment arm in
    // this file vacuously true.
    expect(PUBLIC_EGRESS_WARNINGS.length).toBeGreaterThanOrEqual(10);
    expect(new Set(PUBLIC_EGRESS_WARNINGS).size).toBe(PUBLIC_EGRESS_WARNINGS.length);
    for (const code of PUBLIC_EGRESS_WARNINGS) {
      expect(code, `${code} is not a plain lowercase code`).toMatch(/^[a-z0-9_]+(:[a-z0-9_]+)?$/);
      expect(isPublicEgressWarning(code)).toBe(true);
    }
    // The four documented layer words are all present as safeguard codes.
    for (const word of Object.values(PUBLIC_SAFEGUARD_LAYERS)) {
      expect(PUBLIC_EGRESS_WARNINGS).toContain(`safeguard_failed:${word}`);
    }
  });

  it('CRITICAL every internal code the relay emits maps to a vocabulary member, and none of them is the raw internal string', () => {
    const { warnings, unmapped } = customerSafeEgressWarnings([...INTERNAL_CODES]);
    expect(unmapped, 'an internal code the relay emits was not classified').toEqual([]);
    expect(warnings.length).toBeGreaterThan(0);
    for (const code of warnings) {
      expect(isPublicEgressWarning(code), `${code} escaped the vocabulary`).toBe(true);
    }
    // The two HOW-shaped names, and the three "we could not check" codes, are
    // gone as strings — not merely absent from the vocabulary list.
    expect(warnings).not.toContain('h3_interpose_unavailable');
    expect(warnings).not.toContain('safeguards_unreported');
    expect(warnings).not.toContain('safeguards_expectation_unreported');
    expect(warnings).toContain('quic_unavailable');
    expect(warnings).toContain('safeguards_unverified');
    // Every producer layer reaches the customer under its customer word.
    expect(warnings).toContain('safeguard_failed:direct_internet_block');
    expect(warnings).toContain('safeguard_failed:browser_integrity');
    expect(warnings).toContain('safeguard_failed:proxy_egress_verification');
    expect(warnings).toContain('safeguard_failed:live_view_capture');
    // And `safeguard_missing:<layer>` published NO layer at all: four internal
    // codes collapse into the one `safeguards_unverified` above.
    expect(warnings.filter((c) => c === 'safeguards_unverified')).toHaveLength(1);
  });

  it('CRITICAL an internal layer name never reaches the customer, however the device spells it', () => {
    const hostile = [
      'safeguard_failed:../../x <script>',
      'safeguard_failed:relay-07.fleet.internal:1080',
      'safeguard_failed:HarnessCoordinator.swift:9688',
      'safeguard_failed:quic_interpose_dyld',
      'safeguard_failed:',
      'safeguard_failed:x'.padEnd(200, 'y'),
      'safeguard_missing:../../x <script>',
    ];
    const { warnings } = customerSafeEgressWarnings(hostile);
    // Every hostile entry still tells the customer a safeguard is in question —
    // dropping the fact would be the other failure — but never names a layer.
    expect(warnings.sort()).toEqual(['safeguard_failed', 'safeguards_unverified']);
    const joined = warnings.join('\n');
    for (const fragment of [
      'script',
      'fleet',
      'internal',
      'Harness',
      'swift',
      'interpose',
      'dyld',
      '..',
      '1080',
    ]) {
      expect(joined, `${fragment} reached the customer`).not.toContain(fragment);
    }
  });

  it('CRITICAL total and closed over arbitrary strings — 4000 random inputs produce only vocabulary members', () => {
    const rand = makeRandom(0x5eed_1234);
    let sawSomething = 0;
    for (let i = 0; i < 4000; i++) {
      // Half plausible codes, half arbitrary bytes, so the arm exercises both
      // the prefix branches and the drop branch.
      const input =
        i % 2 === 0
          ? randomString(rand, 90)
          : `${['safeguard_failed:', 'safeguard_missing:', 'safeguards_', ''][i % 4] ?? ''}${randomString(rand, 40)}`;
      const { warnings, unmapped } = customerSafeEgressWarnings([input]);
      for (const code of warnings) {
        expect(isPublicEgressWarning(code), `input ${JSON.stringify(input)} produced ${code}`).toBe(
          true,
        );
        sawSomething++;
      }
      // Even the REPORT side never carries a hostile string: every entry is a
      // safe token, or a safe token pair around one colon.
      for (const code of unmapped) {
        expect(code, `report line for ${JSON.stringify(input)} is not a safe token`).toMatch(
          /^[a-z0-9_]{1,64}(:[a-z0-9_]{1,64})?$/,
        );
      }
    }
    // POSITIVE CONTROL: the loop really produced public codes on some inputs,
    // so "only vocabulary members came out" is not "nothing came out".
    expect(sawSomething).toBeGreaterThan(0);
  });

  it('total over any input shape at all — null, numbers, objects, nested arrays', () => {
    for (const input of [
      null,
      undefined,
      0,
      'safeguard_failed:network_firewall',
      { warnings: ['dead_proxy'] },
      [],
      [null, 1, {}, [], true, Symbol.iterator.toString()],
    ]) {
      const result = customerSafeEgressWarnings(input);
      expect(Array.isArray(result.warnings)).toBe(true);
      expect(Array.isArray(result.unmapped)).toBe(true);
      for (const code of result.warnings) expect(isPublicEgressWarning(code)).toBe(true);
    }
    // A bare string is NOT a one-element list: it is the wrong shape, and
    // answering it as if it were a list would be a confident answer from a
    // shape nobody checked.
    expect(customerSafeEgressWarnings('dead_proxy').warnings).toEqual([]);
  });

  it('de-duplicates and keeps first-appearance order', () => {
    const { warnings } = customerSafeEgressWarnings([
      'dead_proxy',
      'safeguards_unreported',
      'udp_unsupported_by_proxy',
      'safeguards_expectation_unreported',
      'dead_proxy',
      'safeguard_missing:webkit_gate',
      'h3_interpose_unavailable',
    ]);
    expect(warnings).toEqual([
      'dead_proxy',
      'safeguards_unverified',
      'udp_unsupported_by_proxy',
      'quic_unavailable',
    ]);
  });

  it('is idempotent — mapping an already-public list returns it unchanged, so a second application cannot silently empty it', () => {
    const once = customerSafeEgressWarnings([...INTERNAL_CODES]);
    const twice = customerSafeEgressWarnings(once.warnings);
    expect(twice.warnings).toEqual(once.warnings);
    expect(twice.unmapped).toEqual([]);
  });

  it('CRITICAL an unclassified internal code is DROPPED and REPORTED, never passed through', () => {
    const { warnings, unmapped } = customerSafeEgressWarnings([
      'dead_proxy',
      'a_brand_new_internal_code',
      'safeguard_failed:a_brand_new_layer',
    ]);
    // Dropped: the new code is not in the customer list...
    expect(warnings).not.toContain('a_brand_new_internal_code');
    expect(warnings).toEqual(['dead_proxy', 'safeguard_failed']);
    // ...and reported, by its real name, because an operator has to be able to
    // classify it from the log line.
    expect(unmapped).toEqual(['a_brand_new_internal_code', 'safeguard_failed:a_brand_new_layer']);
  });

  it('reportableEgressWarning echoes a real token and refuses anything else', () => {
    expect(reportableEgressWarning('a_new_layer_name')).toBe('a_new_layer_name');
    expect(reportableEgressWarning('safeguard_failed:a_new_layer')).toBe(
      'safeguard_failed:a_new_layer',
    );
    expect(reportableEgressWarning('safeguard_failed:../../x <script>')).toBe(
      'safeguard_failed:unprintable',
    );
    // Not a parameterised code, so it is ONE token — the port is not echoed by
    // a split that keeps the half worth not keeping.
    expect(reportableEgressWarning('relay-07.some.host:1080')).toBe('unprintable');
    expect(reportableEgressWarning('x'.repeat(65))).toBe('unprintable');
  });
});

describe('the recorder counts every occurrence and logs each code once', () => {
  it('counts every occurrence, logs a distinct code once, and never throws on a broken logger', () => {
    const lines: Array<{ obj: Record<string, unknown>; msg: string }> = [];
    const recorder = createUnmappedEgressWarningRecorder();
    const logger = {
      warn(obj: Record<string, unknown>, msg: string) {
        lines.push({ obj, msg });
      },
    };
    recorder.record(['new_code_a'], logger);
    recorder.record(['new_code_a', 'new_code_b'], logger);
    recorder.record(['new_code_a'], logger);

    expect(recorder.counts().get('new_code_a')).toBe(3);
    expect(recorder.counts().get('new_code_b')).toBe(1);
    // One line per distinct code, however many occurrences.
    expect(lines).toHaveLength(2);
    expect(lines.map((l) => l.obj.code)).toEqual(['new_code_a', 'new_code_b']);
    expect(lines[0]?.obj.component).toBe('customer-safe-egress-warnings');

    // Counting survives a logger that throws, and a missing logger entirely —
    // a response must go out either way.
    const thrower = {
      warn() {
        throw new Error('log sink is down');
      },
    };
    expect(() => recorder.record(['new_code_c'], thrower)).not.toThrow();
    expect(() => recorder.record(['new_code_d'])).not.toThrow();
    expect(recorder.counts().get('new_code_c')).toBe(1);
    expect(recorder.counts().get('new_code_d')).toBe(1);
  });
});

describe('customerSafeEgressCapabilities maps warnings and leaves the rest alone', () => {
  it('replaces warnings in place and carries every other field through unchanged', () => {
    const { capabilities, unmapped } = customerSafeEgressCapabilities({
      udp_associate: true,
      quic_route: 'disabled',
      dns_remote_resolve: false,
      warnings: ['h3_interpose_unavailable', 'safeguard_failed:screen_recording'],
    });
    expect(capabilities).toEqual({
      udp_associate: true,
      quic_route: 'disabled',
      dns_remote_resolve: false,
      warnings: ['quic_unavailable', 'safeguard_failed:live_view_capture'],
    });
    expect(unmapped).toEqual([]);
  });

  it('null in, null out — and a non-object is refused rather than spread', () => {
    expect(customerSafeEgressCapabilities(null).capabilities).toBeNull();
    expect(customerSafeEgressCapabilities(undefined).capabilities).toBeNull();
    expect(customerSafeEgressCapabilities(['dead_proxy']).capabilities).toBeNull();
    expect(customerSafeEgressCapabilities('dead_proxy').capabilities).toBeNull();
  });

  it('a stored object with no warnings key gets an empty list, not a missing field', () => {
    const { capabilities } = customerSafeEgressCapabilities({
      udp_associate: false,
      quic_route: 'proxy',
      dns_remote_resolve: true,
    });
    expect(capabilities).toEqual({
      udp_associate: false,
      quic_route: 'proxy',
      dns_remote_resolve: true,
      warnings: [],
    });
  });
});
