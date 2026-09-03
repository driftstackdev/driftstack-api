// T-6: "the QUIC chip is inferred ('~', never green). When the server reports a
// MEASURED quic_measured==='h3' the chip must render GREEN ✓; 'h2-only' renders a
// muted 'no HTTP/3' (measured, not inferred); null keeps today's '~' inferred
// rendering. NEVER green for inferred or null."
//
// MEASURED mechanism: ProxyCapabilityChips forwards `quicMeasured` into
// proxyCapabilities, which sets the QUIC chip's ok/inferred flags. The chip's
// three renderings are distinguishable at the DOM: green carries the
// `text-status-ready` class and data-inferred="false"; a measured negative is
// muted (no status-ready) and data-inferred="false"; an inferred chip is muted
// AND data-inferred="true" with a '~' glyph. Green is therefore a property of
// exactly one input — a measured 'h3' — and this guard pins that one-to-one map.
//
// One property per assertion; the null/undefined case is the vacuity control —
// the unmeasured chip must be byte-for-byte the pre-existing inferred rendering
// and must NEVER be green.

import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { ProxyCapabilityChips } from '../../src/components/ProxyCapabilities';
import type { ProxyTestResult } from '../../src/lib/proxies';

// A fully usable, UDP-relaying exit: without a measured verdict its QUIC chip is
// the INFERRED positive ('~'), which is the exact state a measurement must be
// able to override in either direction.
const UDP_OK: ProxyTestResult = {
  reachable: true,
  auth_ok: true,
  udp_associate: true,
  can_route: true,
  connect_reply: 0x00,
  latency_ms: 12,
  message: 'ok',
};

/** Render the chips and read the QUIC chip's rendering as three orthogonal facts. */
function quicChip(quicMeasured?: 'h3' | 'h2-only' | null): {
  green: boolean;
  inferred: string | null;
  ok: string | null;
  glyph: string;
} {
  const { container } = render(
    <ProxyCapabilityChips result={UDP_OK} quicMeasured={quicMeasured} />,
  );
  const el = container.querySelector('[data-capability="quic"]');
  if (el === null) throw new Error('QUIC chip did not render');
  return {
    // Green is the ONE colour that says "verified". status-ready is the token the
    // muted (surface-inset) and error states never carry.
    green: el.className.includes('status-ready'),
    inferred: el.getAttribute('data-inferred'),
    ok: el.getAttribute('data-ok'),
    glyph: el.textContent ?? '',
  };
}

describe('the measured-QUIC chip is green ONLY for a measured h3', () => {
  it("a measured 'h3' renders green", () => {
    expect(quicChip('h3').green).toBe(true);
  });

  it("a measured 'h3' is marked as a measurement, not an inference", () => {
    expect(quicChip('h3').inferred).toBe('false');
  });

  it("a measured 'h3' shows the verified ✓, never the inferred '~'", () => {
    const chip = quicChip('h3');
    expect(chip.glyph).toContain('✓');
    expect(chip.glyph).not.toContain('~');
  });

  it("a measured 'h2-only' is NOT green — it is a measured negative", () => {
    expect(quicChip('h2-only').green).toBe(false);
  });

  it("a measured 'h2-only' is a measurement (not inferred) and reads as not-ok", () => {
    const chip = quicChip('h2-only');
    expect(chip.inferred).toBe('false');
    expect(chip.ok).toBe('false');
  });

  it("a measured 'h2-only' never shows a ✓", () => {
    expect(quicChip('h2-only').glyph).not.toContain('✓');
  });

  // ── VACUITY CONTROL ──────────────────────────────────────────────
  // With NO measurement the chip must stay exactly the inferred '~' it is
  // today, and above all must not be green. If a mutant rendered the inferred
  // chip green, these are the arms that turn red.
  it('VACUITY CONTROL — null is unmeasured: inferred, never green', () => {
    const chip = quicChip(null);
    expect(chip.green).toBe(false);
    expect(chip.inferred).toBe('true');
    expect(chip.glyph).toContain('~');
  });

  it('VACUITY CONTROL — undefined is unmeasured: inferred, never green', () => {
    const chip = quicChip(undefined);
    expect(chip.green).toBe(false);
    expect(chip.inferred).toBe('true');
    expect(chip.glyph).toContain('~');
  });

  it('green is a property of the measured h3 ALONE, across every input', () => {
    // The whole rule in one line: exactly one of the four inputs is green.
    expect(quicChip('h3').green).toBe(true);
    expect(quicChip('h2-only').green).toBe(false);
    expect(quicChip(null).green).toBe(false);
    expect(quicChip(undefined).green).toBe(false);
  });
});
