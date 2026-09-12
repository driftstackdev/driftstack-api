// Item 11 guard — the cockpit HTTP/3 (QUIC) readout.
//
// The load-bearing property (T-27): h3_connection_observed is LATCHED and
// ABSENT-means-unknown, so absence must render as "not observed", NEVER "no
// HTTP/3" — and, since (q) Item 11 residual, never "measuring…" either (nothing
// in this repo can prove the fork build is measuring). A MEASURED count of 0 is
// its own state: "none yet (0 connections)".
//
// Mutations (QuicReadout.tsx / session-h3-observation.ts h3ReadoutState):
//   * render the green verdict on an absent field → the first two arms red;
//   * fold `count === 0` back into the absent branch (delete the 'none-yet'
//     return) → the zero-count arm reds on its data-state and text;
//   * bring back "measuring…" → the absent arms red on the exact text.
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { QuicReadout } from '../../src/components/QuicReadout';
import type { AgentSessionCapabilityReport } from '../../src/lib/agent-session-control';

/** WCAG 2.1 contrast of a `text-white/<alpha>` class over the simulator drawer's own chrome
 *  (#1d1e24, dark in BOTH themes) — computed from the class the DOM carries. */
function whiteAlphaContrast(className: string): number {
  const m = /(?:^|\s)text-white\/(\d+)(?:\s|$)/.exec(className);
  if (m === null) throw new Error(`no text-white/<alpha> class on: ${className}`);
  const alpha = Number(m[1]) / 100;
  const chrome: readonly [number, number, number] = [0x1d, 0x1e, 0x24];
  const channel = (v: number): number => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const lum = ([r, g, b]: readonly [number, number, number]): number =>
    0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  const over = (v: number): number => 255 * alpha + v * (1 - alpha);
  const fg = lum([over(chrome[0]), over(chrome[1]), over(chrome[2])]);
  const bg = lum(chrome);
  return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
}

function report(over: Partial<AgentSessionCapabilityReport>): AgentSessionCapabilityReport {
  return {
    manual_input_available: null,
    streaming_state: null,
    egress_state: null,
    ...over,
  };
}

describe('QuicReadout', () => {
  it('renders "not observed" when there is no report yet — never "measuring…", never a negative', () => {
    render(<QuicReadout report={null} />);
    const el = screen.getByText('HTTP/3: not observed');
    expect(el.getAttribute('data-state')).toBe('not-observed');
    expect(screen.queryByText(/measuring/i)).toBeNull();
    expect(screen.queryByText(/HTTP\/3 ✓/)).toBeNull();
  });

  it('renders "not observed" when the report is present but carries neither the flag nor a count — absence is not a negative verdict', () => {
    // The whole point: an absent h3_connection_observed must not read as "no HTTP/3".
    render(<QuicReadout report={report({})} />);
    const el = screen.getByText('HTTP/3: not observed');
    expect(el.getAttribute('data-state')).toBe('not-observed');
    expect(screen.queryByText(/measuring/i)).toBeNull();
    expect(screen.queryByText(/HTTP\/3 ✓/)).toBeNull();
  });

  it('CRITICAL a MEASURED count of 0 without the flag is "none yet (0 connections)" — a measurement, not "not observed"', () => {
    render(<QuicReadout report={report({ h3_connection_count: 0 })} />);
    const el = screen.getByText('HTTP/3: none yet (0 connections)');
    expect(el.getAttribute('data-state')).toBe('none-yet');
    expect(screen.queryByText(/not observed/)).toBeNull();
    expect(screen.queryByText(/measuring/i)).toBeNull();
    // Still NOT the green verdict: zero connections is not "HTTP/3 carried".
    expect(screen.queryByText(/HTTP\/3 ✓/)).toBeNull();
  });

  it('renders the green live verdict once an HTTP/3 connection was observed', () => {
    render(<QuicReadout report={report({ h3_connection_observed: true })} />);
    const el = screen.getByText(/HTTP\/3 ✓ live/);
    expect(el.getAttribute('data-state')).toBe('observed');
  });

  it('the latched flag wins over a stale zero count (latched = "ever", the count may lag)', () => {
    render(
      <QuicReadout report={report({ h3_connection_observed: true, h3_connection_count: 0 })} />,
    );
    expect(screen.getByText(/HTTP\/3 ✓ live/).getAttribute('data-state')).toBe('observed');
  });

  it('surfaces the connection count when more than one h3 connection was observed', () => {
    render(
      <QuicReadout report={report({ h3_connection_observed: true, h3_connection_count: 3 })} />,
    );
    expect(screen.getByText(/HTTP\/3 ✓ live · 3 connections/)).toBeTruthy();
  });

  it('does not tack on a count for a single connection', () => {
    render(
      <QuicReadout report={report({ h3_connection_observed: true, h3_connection_count: 1 })} />,
    );
    expect(screen.getByText(/HTTP\/3 ✓ live$/)).toBeTruthy();
  });

  it('(S1) the muted absence lines ("not observed", "none yet") clear WCAG AA (4.5) on the drawer chrome', () => {
    // Measured 2026-09-12: the shared caption tint text-white/40 is 3.77 on #1d1e24. The
    // guard is the RATIO from the class the DOM carries, with the shipped-before value as
    // the control so the instrument is known to fail.
    for (const r of [null, report({}), report({ h3_connection_count: 0 })]) {
      const { container, unmount } = render(<QuicReadout report={r} />);
      const el = container.querySelector('[data-component="sim-quic-readout"]');
      expect(el, 'the readout renders').not.toBeNull();
      expect(whiteAlphaContrast(el?.className ?? ''), el?.textContent ?? '').toBeGreaterThanOrEqual(
        4.5,
      );
      unmount();
    }
    expect(whiteAlphaContrast('mt-1 text-white/40')).toBeCloseTo(3.77, 2);
  });
});

// 2026-09-12 review — the observed verdict is a MODE token on fixed-dark chrome.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

type Rgb = readonly [number, number, number];
const SRC = join(__dirname, '..', '..', 'src');
const INDEX_CSS = readFileSync(join(SRC, 'styles', 'index.css'), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
);
function modeRgb(name: string, mode: 'light' | 'dark'): Rgb {
  const block = new RegExp(`\\[data-mode='${mode}'\\]\\s*\\{([^}]*)\\}`).exec(INDEX_CSS)?.[1];
  const m = new RegExp(`--${name}-rgb:\\s*(\\d+)\\s+(\\d+)\\s+(\\d+)`).exec(block ?? '');
  if (m === null) throw new Error(`--${name}-rgb not defined for ${mode} in styles/index.css`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}
function wcagContrast(a: Rgb, b: Rgb): number {
  const lum = ([r, g, b2]: Rgb): number => {
    const lin = (c: number): number => {
      const v = c / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b2);
  };
  const [x, y] = [lum(a), lum(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

describe('QuicReadout — the observed verdict on the simulator chrome', () => {
  it('(review) "HTTP/3 ✓ live" wears text-status-ready, which only clears AA on the #17181d card at the DARK token — so it depends on the simulator\'s dark scope', () => {
    // T4 darkened the light --status-ready-rgb for light surfaces; on the Egress
    // card (bg-black/20 over #1d1e24 = #17181d, dark in both themes) that value
    // reads 2.66 — the gate's own light-simulator finding — while the dark value
    // reads 9.22. The component keeps the token; the roots that mount it carry
    // data-mode="dark" (SimulatorWindow.tsx). Mutations: a mode-independent
    // literal here passes the class pin only if it still clears 4.5 on the card;
    // dropping the scope attribute from the shell reds the source pin below.
    const { container } = render(
      <QuicReadout report={report({ h3_connection_observed: true, h3_connection_count: 4 })} />,
    );
    const el = container.querySelector(
      '[data-component="sim-quic-readout"][data-state="observed"]',
    );
    expect(el?.textContent).toBe('HTTP/3 ✓ live · 4 connections');
    expect(el?.className.split(/\s+/)).toContain('text-status-ready');
    const card: Rgb = [0x17, 0x18, 0x1d];
    expect(wcagContrast(modeRgb('status-ready', 'dark'), card)).toBeGreaterThanOrEqual(4.5);
    expect(wcagContrast(modeRgb('status-ready', 'dark'), card)).toBeCloseTo(9.22, 1);
    expect(wcagContrast(modeRgb('status-ready', 'light'), card)).toBeLessThan(4.5);
    expect(wcagContrast(modeRgb('status-ready', 'light'), card)).toBeCloseTo(2.66, 1);
    const shell = readFileSync(join(SRC, 'views', 'SimulatorWindow.tsx'), 'utf8');
    expect(shell).toContain('<QuicReadout report={sessionCapabilityReport} />');
    expect(shell).toMatch(/<div\s+data-mode="dark"\s+data-component="simulator-shell"/);
  });
});
