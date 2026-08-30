// #48 item 2 — formatSessionDiagnostics() pure-function tests.
//
// The "Copy diagnostics" panel action is wired into the live session-info
// overlay (clipboard + React state hard to exercise headless); the pure
// formatter that builds the paste-ready text is testable in isolation. Pins:
//
//   - absent optionals are OMITTED (no confusing "null" lines)
//   - latency falls back app-ping → media-RTT → 'measuring…' (overlay parity)
//   - transport renders direct vs relay; media line joins present fields only

import { describe, expect, it } from 'vitest';
import {
  formatSessionDiagnostics,
  type SessionDiagnosticsInput,
} from '../../src/lib/session-diagnostics';

const FULL: SessionDiagnosticsInput = {
  sessionId: 'as_abc123',
  profileName: 'shopper-de',
  deviceName: 'iPhone 17',
  link: 'sfu-eu.driftstack.dev',
  egress: '🌍 DE residential',
  fps: 30,
  latencyMs: 42,
  linkRttMs: 88,
  transport: 'udp',
  relayed: false,
  decodeFps: 29,
  packetLossPct: 0.3,
  jitterMs: 4,
  freezeCount: 0,
  build: '2026-06-23T01:00',
};

describe('#48 formatSessionDiagnostics', () => {
  it('renders every field when all are present (app-ping latency wins)', () => {
    const out = formatSessionDiagnostics(FULL);
    expect(out).toContain('Driftstack session diagnostics');
    expect(out).toContain('session: as_abc123');
    expect(out).toContain('profile: shopper-de');
    expect(out).toContain('device: iPhone 17');
    expect(out).toContain('link: sfu-eu.driftstack.dev');
    expect(out).toContain('egress: 🌍 DE residential');
    expect(out).toContain('fps: 30');
    expect(out).toContain('latency: 42 ms');
    expect(out).toContain('transport: udp · direct');
    expect(out).toContain('decode 29 fps · loss 0.3% · jitter 4ms · freezes 0');
    expect(out).toContain('build: 2026-06-23T01:00');
  });

  it('omits absent optional lines instead of printing null/empty', () => {
    const out = formatSessionDiagnostics({
      ...FULL,
      sessionId: '',
      profileName: '',
      egress: '',
      fps: null,
      transport: null,
      relayed: null,
      decodeFps: null,
      packetLossPct: null,
      jitterMs: null,
      freezeCount: null,
    });
    expect(out).not.toContain('session:');
    expect(out).not.toContain('profile:');
    expect(out).not.toContain('egress:');
    expect(out).not.toContain('fps:');
    expect(out).not.toContain('transport:');
    expect(out).not.toContain('null');
    // device + link + latency + build always present
    expect(out).toContain('device: iPhone 17');
    expect(out).toContain('build: 2026-06-23T01:00');
  });

  it('falls back to the media RTT (link) when the app ping is absent', () => {
    expect(formatSessionDiagnostics({ ...FULL, latencyMs: null })).toContain(
      'latency: 88 ms (link)',
    );
  });

  it("shows 'measuring…' when neither RTT is available", () => {
    expect(formatSessionDiagnostics({ ...FULL, latencyMs: null, linkRttMs: null })).toContain(
      'latency: measuring…',
    );
  });

  it("renders 'not connected' when there is no link, and '· relay' when relayed", () => {
    const out = formatSessionDiagnostics({ ...FULL, link: null, relayed: true });
    expect(out).toContain('link: not connected');
    expect(out).toContain('transport: udp · relay');
  });
});

// V-2168 — the frame ledger reaches the paste-ready report.
describe('frame attribution (V-2168)', () => {
  it('renders decoded / presented / dropped / frozen / avg buffer on one line', () => {
    const text = formatSessionDiagnostics({
      ...FULL,
      framesDecoded: 3000,
      framesRendered: 2040,
      framesDropped: 960,
      totalFreezesDurationS: 4.25,
      jitterBufferDelayS: 12.5,
      jitterBufferEmittedCount: 2500,
    });
    expect(text).toContain(
      'frames: decoded 3000 · presented 2040 · dropped 960 · frozen 4.3s · avg buffer 5ms',
    );
  });

  it('omits the line entirely when no counter is known — never prints null or 0-by-default', () => {
    const text = formatSessionDiagnostics(FULL);
    expect(text).not.toContain('frames:');
  });
});
