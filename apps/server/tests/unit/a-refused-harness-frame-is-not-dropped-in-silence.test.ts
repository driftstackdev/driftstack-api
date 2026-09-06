// A frame the CP refuses must be visible, and must not leak what it carried.
//
// `FleetControlConnection.handleInbound` dropped every frame failing
// `HarnessOutboundSchema` with `if (!parsed.success) return;` and no log — while
// the `stale` branch three lines above it logged. So from the CP side, "the node
// emitted a frame we refused" and "the node never emitted anything" produced
// identical evidence: none.
//
// That cost real time twice. Ledger P-29: a customer landing on a 4xx/5xx had the
// pageState frame "REJECTED and dropped with no log". Ledger P-30: an over-cap
// `pageState.url` is "silent drop -> GUI address bar freezes", named as one
// confirmed member of a family of unbounded harness emit sites. A3 confirms the
// blindness is mutual — a queued-and-sent frame looks identical to a
// queued-and-swallowed one from their side too.
//
// ⛔ THE SECOND PROPERTY IS WHY THIS IS NOT A ONE-LINER. These frames carry
// customer URLs, page titles and cookie jars, and a Zod `z.literal`/`z.enum` issue
// ECHOES THE VALUE IT REJECTED. So the diagnostic must carry field paths and issue
// codes only — never an issue `message`, never the input. The arms below assert
// that a planted secret in a rejected frame does not survive into the description,
// with a control proving the detector would see it if it did.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HarnessOutboundSchema } from '../../src/schemas/harness-control-protocol.js';
import {
  REJECTION_KEY_CAP,
  REJECTION_LOG_EVERY,
  UNRECOGNISED_TYPE,
  describeRejection,
  frameTypeLabel,
  shouldLogRejection,
} from '../../src/services/harness-frame-rejection.js';

/** Parse something the schema will refuse, and hand back its error. */
function refuse(input: unknown) {
  const parsed = HarnessOutboundSchema.safeParse(input);
  expect(parsed.success, 'fixture must actually be refused').toBe(false);
  if (parsed.success) throw new Error('narrow');
  return parsed.error;
}

describe('a refused harness frame is not dropped in silence', () => {
  it('CRITICAL names the field paths of a KNOWN frame whose payload is wrong', () => {
    // The case that matters: the node meant to send a real frame and we refused it.
    const detail = describeRejection(refuse({ type: 'networkRequests' }));
    expect(detail).not.toBe(UNRECOGNISED_TYPE);
    expect(detail).toMatch(/sessionId/);
    expect(detail).toMatch(/entries/);
  });

  it('CRITICAL surfaces an OVER-CAP field as too_big — the P-30 family, previously invisible', () => {
    const detail = describeRejection(
      refuse({ type: 'pageState', sessionId: 's', url: 'x'.repeat(9000), title: 't' }),
    );
    expect(detail).toMatch(/url:too_big/);
  });

  it('CRITICAL a frame type nobody knows is reported as forward-compat, NOT as a payload fault', () => {
    // A newer harness sending a frame this CP has never heard of is expected during
    // a rollout. Conflating it with data loss would make the real signal unreadable.
    expect(describeRejection(refuse({ type: 'somethingNobodyEmits', a: 1 }))).toBe(
      UNRECOGNISED_TYPE,
    );
  });

  it('CRITICAL never echoes a rejected VALUE — only paths and codes', () => {
    const SECRET = 'sk-live-NEVER-LOG-THIS-0123456789';
    // ⛔ THE FIXTURE IS THE WHOLE ARM, and the obvious one does not work. Planting
    // the secret in a `type`/string/over-cap field proves nothing: those options are
    // either filtered out as discriminator failures, or produce `invalid_type` /
    // `too_big`, whose messages carry no value — so the arm passed even with the
    // issue MESSAGE deliberately concatenated in (measured). An ENUM field is the
    // one that echoes: `pageState.state` yields `invalid_enum_value` on a SURVIVING
    // option, carrying the received value. That is the fixture that can fail.
    const leaky = {
      type: 'pageState',
      sessionId: 'x',
      state: SECRET,
      url: 'https://example.com/',
      title: 't',
    };
    const detail = describeRejection(refuse(leaky));
    // ⛔ The whole secret only. A guard in this suite rejects asserting absence via
    // a PREFIX, and it is right: `sk-live` is public boilerplate, so
    // `not.toContain('sk-live')` passes while every byte of entropy leaks.
    expect(detail).not.toContain(SECRET);
    // …while still naming the field, so redaction has not cost the diagnostic.
    expect(detail).toMatch(/state:invalid_enum_value/);
    // Control: the raw Zod issues for the SAME fixture DO carry the value, so the
    // assertion above measures the redaction rather than a fixture nothing echoes.
    expect(
      JSON.stringify(refuse(leaky).issues),
      'control: zod echoes the enum value it rejected',
    ).toContain(SECRET);
  });

  it('the frame-type label refuses caller-controlled text', () => {
    expect(frameTypeLabel({ type: 'pageState' })).toBe('pageState');
    // Log-injection shapes and oversize values must not reach a log line verbatim.
    expect(frameTypeLabel({ type: 'evil\ninjected: line' })).toBe('<unprintable-type>');
    expect(frameTypeLabel({ type: 'x'.repeat(200) })).toBe('<unprintable-type>');
    expect(frameTypeLabel({ type: 42 })).toBe('<no-type>');
    expect(frameTypeLabel(42)).toBe('<not-an-object>');
    expect(frameTypeLabel(null)).toBe('<not-an-object>');
  });

  it('CRITICAL throttles a looping node without ever going fully silent', () => {
    const counts = new Map<string, number>();
    const fired: number[] = [];
    for (let i = 0; i < REJECTION_LOG_EVERY * 3; i += 1) {
      const n = shouldLogRejection(counts, 'pageState url:too_big');
      if (n !== null) fired.push(n);
    }
    // The first, then every REJECTION_LOG_EVERY-th: bounded volume, never zero.
    expect(fired[0]).toBe(1);
    expect(fired).toContain(REJECTION_LOG_EVERY);
    expect(fired).toContain(REJECTION_LOG_EVERY * 2);
    expect(fired.length).toBeLessThan(10);
    // The count rides along so a reader sees the true volume, not just the samples.
    expect(counts.get('pageState url:too_big')).toBe(REJECTION_LOG_EVERY * 3);
  });

  it('CRITICAL a key-rotating sender cannot re-trigger the first-occurrence log forever', () => {
    // An unrecognised type is caller-supplied, so the key space is attacker-facing.
    // Past the cap we stop tracking NEW keys rather than evicting — eviction would
    // let a rotator keep buying fresh "first occurrence" lines.
    const counts = new Map<string, number>();
    let logged = 0;
    for (let i = 0; i < REJECTION_KEY_CAP * 10; i += 1) {
      if (shouldLogRejection(counts, `rotating-${i}`) !== null) logged += 1;
    }
    expect(counts.size).toBe(REJECTION_KEY_CAP);
    expect(logged).toBe(REJECTION_KEY_CAP);
    // A key already being tracked keeps COUNTING past the cap, so a real standing
    // rejection seen before the rotation started is still measured (and still
    // reported on its next multiple). It returns null here only because of the
    // ordinary throttle — occurrence 2 of 100 — not because the cap silenced it.
    const before = counts.get('rotating-0') ?? 0;
    shouldLogRejection(counts, 'rotating-0');
    expect(counts.get('rotating-0')).toBe(before + 1);
  });

  it('the registry actually calls this on BOTH silent paths', () => {
    // Source pin: the two `return`s that used to be bare. Behavioural coverage of
    // the socket path lives in the fleet-control-registry suites; this asserts the
    // call sites exist, because a reporter nothing calls is the defect restated.
    const src = readRegistry();
    expect(src).toMatch(/this\.reportRejectedFrame\('<not-json>'/);
    expect(src).toMatch(/this\.reportRejectedFrame\(frameTypeLabel\(json\), describeRejection\(/);
    // And that neither path silently returns any more.
    expect(src).not.toMatch(/if \(!parsed\.success\) return;/);
  });
});

const HERE = dirname(fileURLToPath(import.meta.url));
function readRegistry(): string {
  return readFileSync(
    resolve(HERE, '..', '..', 'src', 'services', 'fleet-control-registry.ts'),
    'utf8',
  );
}
