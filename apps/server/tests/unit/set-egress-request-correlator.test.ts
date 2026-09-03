// Live egress swap — unit tests for the set-egress correlator (A3 P-17). Pins the
// mirrored request/reply mechanics its siblings have, plus the two properties that
// are specific to this frame and are the reason it was designed rather than
// borrowed: an apply point that is ECHOED or the outcome says so, and a `drain`
// value that cannot be expressed at all.
//
// ⛔ These tests prove the CP speaks the frame correctly. They prove NOTHING about
// what a node does with it — the WebKit driver is a stub and the fleet control
// plane is flag-gated, so there is no live path to verify against.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SetEgressRequestCorrelator,
  SET_EGRESS_REQUEST_TIMEOUT_MS,
  type SetEgressTransport,
} from '../../src/services/set-egress-request-correlator.js';
import {
  SetEgressRequestSchema,
  SET_EGRESS_APPLY_POINTS,
  type SetEgressRequest,
} from '../../src/schemas/harness-control-protocol.js';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serializeSetEgress } from '../../src/services/harness-control-codec.js';

const CODEC_SRC = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../src/services/harness-control-codec.ts',
);

const EXIT = {
  ip: '203.0.113.7',
  country: 'NL',
  region: 'North Holland',
  city: 'Amsterdam',
  timezone: 'Europe/Amsterdam',
  quic_ok: true,
  probed_at: '2026-08-26T00:00:00.000Z',
} as const;

function req(
  requestId: string,
  applyPoint: 'next_navigation' | 'immediate' = 'next_navigation',
  sessionId = 'agt_x',
): SetEgressRequest {
  return {
    type: 'setEgress',
    requestId,
    sessionId,
    inlineProxyConfig: 'eyJob3N0IjoiMTI3LjAuMC4xIn0=',
    exitIdentity: { ...EXIT },
    applyPoint,
  };
}

function resultFrame(
  requestId: string,
  opts: { ok?: boolean; error?: string; sessionId?: string; applyPoint?: string },
): unknown {
  return {
    type: 'setEgressResult',
    requestId,
    sessionId: opts.sessionId ?? 'agt_x',
    ...(opts.ok !== undefined ? { ok: opts.ok } : {}),
    ...(opts.error !== undefined ? { error: opts.error } : {}),
    ...(opts.applyPoint !== undefined ? { applyPoint: opts.applyPoint } : {}),
  };
}

describe('SetEgressRequestCorrelator', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function make(): { c: SetEgressRequestCorrelator; sent: SetEgressRequest[] } {
    const sent: SetEgressRequest[] = [];
    const transport: SetEgressTransport = {
      send: (r) => {
        sent.push(r);
      },
    };
    return { c: new SetEgressRequestCorrelator(transport), sent };
  }

  it('sends the request via the transport and resolves APPLIED when the node echoes an immediate apply point', async () => {
    const { c, sent } = make();
    const p = c.request(req('r1', 'immediate'));
    expect(sent).toHaveLength(1);
    expect(sent[0]!.type).toBe('setEgress');
    c.onResultFrame(resultFrame('r1', { ok: true, applyPoint: 'immediate' }));
    await expect(p).resolves.toEqual({ status: 'applied' });
  });

  it('CRITICAL resolves ACCEPTED_PENDING_NAVIGATION for a deferred swap — accepted is not applied, and a caller polling "did my swap take?" must be able to tell a deferred swap from a silent failure.', async () => {
    const { c } = make();
    const p = c.request(req('r2', 'next_navigation'));
    c.onResultFrame(resultFrame('r2', { ok: true, applyPoint: 'next_navigation' }));
    await expect(p).resolves.toEqual({ status: 'accepted_pending_navigation' });
  });

  it('CRITICAL an ok result that OMITS the apply point resolves ok_apply_point_unconfirmed, never a plain success. A node predating the field accepts the request, drops the field, does whatever it does by default and replies ok — reporting that as success would tell the caller they bought a deferred swap while every in-flight connection may have been reset.', async () => {
    const { c } = make();
    const p = c.request(req('r3', 'next_navigation'));
    c.onResultFrame(resultFrame('r3', { ok: true }));
    await expect(p).resolves.toEqual({ status: 'ok_apply_point_unconfirmed' });
  });

  it('CRITICAL `drain` cannot be expressed. Old connections finishing on the old exit while new ones use the new puts two exit IPs on the wire concurrently for one page, which no single-interface device can produce — so the enum omits it and a value nobody can select is a value nobody selects by accident.', () => {
    expect([...SET_EGRESS_APPLY_POINTS]).toEqual(['next_navigation', 'immediate']);
    const drained = { ...req('r4'), applyPoint: 'drain' };
    expect(SetEgressRequestSchema.safeParse(drained).success).toBe(false);
    // control: the same object with a legal apply point parses, so the rejection
    // above is the enum and not some unrelated field being wrong.
    expect(SetEgressRequestSchema.safeParse(req('r4')).success).toBe(true);
  });

  it('CRITICAL the exit identity is required and travels with the config — a swap that moved the IP but kept the old timezone would have the session claiming one geography while exiting from another, visible in a single page load.', () => {
    const { exitIdentity: _dropped, ...withoutExit } = req('r5');
    expect(SetEgressRequestSchema.safeParse(withoutExit).success).toBe(false);
  });

  it('resolves error when the result carries an error', async () => {
    const { c } = make();
    const p = c.request(req('r6'));
    c.onResultFrame(resultFrame('r6', { error: 'proxy unreachable' }));
    await expect(p).resolves.toEqual({ status: 'error', message: 'proxy unreachable' });
  });

  it('resolves error when a success-shaped result is not ok:true (never reports an unconfirmed swap)', async () => {
    const { c } = make();
    const p = c.request(req('r7'));
    c.onResultFrame(resultFrame('r7', { applyPoint: 'immediate' }));
    await expect(p).resolves.toEqual({
      status: 'error',
      message: 'set-egress result did not confirm ok',
    });
  });

  it('times out after SET_EGRESS_REQUEST_TIMEOUT_MS when no result arrives', async () => {
    const { c } = make();
    const p = c.request(req('r8'));
    vi.advanceTimersByTime(SET_EGRESS_REQUEST_TIMEOUT_MS);
    await expect(p).resolves.toEqual({ status: 'timeout' });
  });

  it('DROPS a result whose sessionId mismatches the pending request (cross-session spoof guard), leaving it to time out', async () => {
    const { c } = make();
    const p = c.request(req('r9', 'immediate', 'agt_victim'));
    c.onResultFrame(
      resultFrame('r9', { ok: true, applyPoint: 'immediate', sessionId: 'agt_other' }),
    );
    expect(c.inFlight()).toBe(1);
    vi.advanceTimersByTime(SET_EGRESS_REQUEST_TIMEOUT_MS);
    await expect(p).resolves.toEqual({ status: 'timeout' });
  });

  it('ignores a non-setEgressResult frame and a result for an unknown requestId', async () => {
    const { c } = make();
    const p = c.request(req('r10', 'immediate'));
    c.onResultFrame({ type: 'somethingElse', requestId: 'r10' });
    c.onResultFrame(resultFrame('unknown', { ok: true, applyPoint: 'immediate' }));
    expect(c.inFlight()).toBe(1);
    c.onResultFrame(resultFrame('r10', { ok: true, applyPoint: 'immediate' }));
    await expect(p).resolves.toEqual({ status: 'applied' });
  });

  it('a synchronous transport-send throw resolves error and leaks no timer', async () => {
    const transport: SetEgressTransport = {
      send: () => {
        throw new Error('socket closed');
      },
    };
    const c = new SetEgressRequestCorrelator(transport);
    const p = c.request(req('r11'));
    await expect(p).resolves.toEqual({
      status: 'error',
      message: 'set-egress request send failed: socket closed',
    });
    expect(c.inFlight()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('CRITICAL serializeSetEgress VALIDATES the proxy config instead of trusting a pre-encoded string. The first version took base64 and checked nothing, so a config the harness would refuse on assign would have sailed through on a swap.', () => {
    expect(() =>
      serializeSetEgress({
        requestId: 'r14',
        sessionId: 'agt_x',
        inlineProxyConfig: { host: '', port: 99999 } as never,
        exitIdentity: { ...EXIT },
        applyPoint: 'next_navigation',
      }),
    ).toThrow(/egress swap/);
  });

  it('serializeSetEgress base64-encodes a valid config onto the wire field', () => {
    const frame = serializeSetEgress({
      requestId: 'r15',
      sessionId: 'agt_x',
      inlineProxyConfig: { host: '127.0.0.1', port: 1080, udp_associate: true } as never,
      exitIdentity: { ...EXIT },
      applyPoint: 'immediate',
    });
    const decoded: unknown = JSON.parse(
      Buffer.from(frame.inlineProxyConfig, 'base64').toString('utf8'),
    );
    expect(decoded).toMatchObject({ host: '127.0.0.1', port: 1080 });
  });

  it('CRITICAL ONE encoder, not three. sessionAssign, setEgress and probeEgress put the SAME field on the wire, and a second encoder is the shape that drifts — the moment one gains a contract the others lack, a config refused on assign is accepted on a swap or on a pre-launch probe. Pinned structurally because the divergence would be invisible to any test that exercised only one caller.', () => {
    const src = readFileSync(CODEC_SRC, 'utf8');
    expect(
      src.match(/SocksProxyConfigWireSchema\.safeParse/g)?.length ?? 0,
      'the socks contract is checked in more than one place',
    ).toBe(1);
    expect(
      src.match(/InlineVpnProxyWireSchema\.safeParse/g)?.length ?? 0,
      'the vpn contract is checked in more than one place',
    ).toBe(1);
    expect(
      src.match(/encodeInlineProxyConfig\(/g)?.length ?? 0,
      'the shared encoder should be defined once and called by all three serializers',
    ).toBe(4);
  });

  it('failAll resolves every in-flight request with error and settle is idempotent', async () => {
    const { c } = make();
    const a = c.request(req('r12'));
    const b = c.request(req('r13'));
    expect(c.inFlight()).toBe(2);
    c.failAll('control connection dropped');
    await expect(a).resolves.toEqual({ status: 'error', message: 'control connection dropped' });
    await expect(b).resolves.toEqual({ status: 'error', message: 'control connection dropped' });
    expect(c.inFlight()).toBe(0);
    c.onResultFrame(resultFrame('r12', { ok: true, applyPoint: 'immediate' })); // no throw
    expect(c.inFlight()).toBe(0);
  });
});
