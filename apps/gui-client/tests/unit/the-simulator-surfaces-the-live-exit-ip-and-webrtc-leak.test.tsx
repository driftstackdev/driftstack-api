// T-26 (owner #12) — the simulator cockpit surfaces a session's LIVE exit
// identity, and a profile can opt to stop the session when the exit IP rotates.
//
// Two units are covered here, both pure and testable without driving a launch:
//
//  1. ExitIpChip — the cockpit chip. Three render arms:
//       • exit IP + a DIFFERENT WebRTC candidate → the warning (leak) treatment,
//       • exit IP + a MATCHING WebRTC candidate → no warning (the vacuity control
//         for the warning arm: the same shape with coherent IPs must NOT warn),
//       • absent fields → the muted "measuring…" state, no crash (the live state
//         today, until the harness/A3 emits the fields).
//
//  2. stopOnExitIpChangeCreateFields — the create-body fragment. The flag is
//     present iff the profile opted in; a default profile yields nothing (the
//     vacuity control). Mutation proof: hardcoding the production helper to `{}`
//     reds the "opted-in" arm; the default-profile arm stays green either way,
//     so it cannot mask that mutation.

import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { ExitIpChip } from '../../src/components/ExitIpChip';
import { stopOnExitIpChangeCreateFields } from '../../src/lib/agent-session-create-fields';
import type { AgentSessionCapabilityReport } from '../../src/lib/agent-session-control';
import type { ProfileMeta } from '../../src/lib/profiles-meta';

/** A capability report with the health fields nulled — the caller layers on the
 *  exit-identity fields under test. */
function report(extra: Partial<AgentSessionCapabilityReport>): AgentSessionCapabilityReport {
  return {
    manual_input_available: null,
    streaming_state: null,
    egress_state: null,
    ...extra,
  };
}

function meta(extra: Partial<ProfileMeta>): ProfileMeta {
  return { folder: '', tags: [], note: '', icon: '', ...extra };
}

/** WCAG 2.1 contrast of a `text-white/<alpha>` class composited over the simulator's
 *  OWN chrome (#1d1e24). The drawer and toolbar are dark in BOTH themes, so this is the
 *  one background the captions ever sit on; the ratio is computed from the class the DOM
 *  actually carries, so the assertion is "this element clears AA", not "this literal". */
const SIM_CHROME: readonly [number, number, number] = [0x1d, 0x1e, 0x24];
function whiteAlphaContrast(className: string): number {
  const m = /(?:^|\s)text-white\/(\d+)(?:\s|$)/.exec(className);
  if (m === null) throw new Error(`no text-white/<alpha> class on: ${className}`);
  const alpha = Number(m[1]) / 100;
  const channel = (v: number): number => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const lum = ([r, g, b]: readonly [number, number, number]): number =>
    0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  const over = (v: number): number => 255 * alpha + v * (1 - alpha);
  const fg = lum([over(SIM_CHROME[0]), over(SIM_CHROME[1]), over(SIM_CHROME[2])]);
  const bg = lum(SIM_CHROME);
  return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
}

describe('ExitIpChip', () => {
  it('marks a WebRTC candidate that differs from the exit IP as a leak', () => {
    const { container } = render(
      <ExitIpChip
        report={report({
          exit_ip: '203.0.113.7',
          exit_country: 'US',
          exit_timezone: 'America/New_York',
          webrtc_candidate_ips: ['203.0.113.7', '198.51.100.4'],
        })}
      />,
    );
    const chip = container.querySelector('[data-component="sim-exit-ip-chip"]');
    expect(chip?.getAttribute('data-state')).toBe('observed');
    expect(chip?.textContent).toContain('203.0.113.7');
    expect(chip?.textContent).toContain('US');
    expect(chip?.textContent).toContain('America/New_York');
    const webrtc = container.querySelector('[data-component="sim-webrtc-candidates"]');
    expect(webrtc?.getAttribute('data-leak')).toBe('true');
    expect(webrtc?.className).toContain('text-status-error');
    expect(webrtc?.textContent).toContain('198.51.100.4');
  });

  it('does NOT warn when every WebRTC candidate matches the exit IP (vacuity)', () => {
    const { container } = render(
      <ExitIpChip
        report={report({
          exit_ip: '203.0.113.7',
          webrtc_candidate_ips: ['203.0.113.7'],
        })}
      />,
    );
    const webrtc = container.querySelector('[data-component="sim-webrtc-candidates"]');
    expect(webrtc?.getAttribute('data-leak')).toBe('false');
    expect(webrtc?.className).not.toContain('text-status-error');
  });

  it('degrades to a muted "measuring…" state when the exit fields are absent (no crash)', () => {
    // null report (control panel not yet loaded)…
    const nullRender = render(<ExitIpChip report={null} />);
    const nullChip = nullRender.container.querySelector('[data-component="sim-exit-ip-chip"]');
    expect(nullChip?.getAttribute('data-state')).toBe('measuring');
    expect(nullChip?.textContent).toContain('measuring');

    // …and a live report that simply has not carried exit fields yet (today's
    // real state): still measuring, and NO webrtc line is drawn.
    const { container } = render(<ExitIpChip report={report({ h3_connection_observed: true })} />);
    const chip = container.querySelector('[data-component="sim-exit-ip-chip"]');
    expect(chip?.getAttribute('data-state')).toBe('measuring');
    expect(container.querySelector('[data-component="sim-webrtc-candidates"]')).toBeNull();
  });

  it('(S2) both truncating lines carry title = the full text they render — and a bare exit IP titles exactly that (vacuity)', () => {
    // The chip sits in a ~212px drawer column; "Exit IP 203.0.113.7 · NL · Europe/Amsterdam"
    // clips there (measured +13px in the harness scene). A clipped line with no title
    // hides the timezone it exists to show. The title is built from the SAME values the
    // line renders, so textContent === title is the binding, not two literals.
    const { container } = render(
      <ExitIpChip
        report={report({
          exit_ip: '203.0.113.7',
          exit_country: 'NL',
          exit_timezone: 'Europe/Amsterdam',
          webrtc_candidate_ips: ['203.0.113.7', '198.51.100.4'],
        })}
      />,
    );
    const chip = container.querySelector('[data-component="sim-exit-ip-chip"]');
    const line = chip?.firstElementChild;
    expect(line?.className).toContain('truncate');
    expect(line?.getAttribute('title')).toBe('Exit IP 203.0.113.7 · NL · Europe/Amsterdam');
    expect(line?.textContent).toBe(line?.getAttribute('title'));
    const webrtc = container.querySelector('[data-component="sim-webrtc-candidates"]');
    expect(webrtc?.className).toContain('truncate');
    expect(webrtc?.getAttribute('title')).toBe('⚠ WebRTC: 203.0.113.7, 198.51.100.4');
    expect(webrtc?.textContent).toBe(webrtc?.getAttribute('title'));

    // VACUITY — no country, no timezone, no candidates: the title is exactly the shorter
    // line (no dangling " · "), and there is no WebRTC line to title.
    const bare = render(<ExitIpChip report={report({ exit_ip: '203.0.113.7' })} />);
    const bareLine = bare.container.querySelector(
      '[data-component="sim-exit-ip-chip"]',
    )?.firstElementChild;
    expect(bareLine?.getAttribute('title')).toBe('Exit IP 203.0.113.7');
    expect(bareLine?.textContent).toBe('Exit IP 203.0.113.7');
    expect(bare.container.querySelector('[data-component="sim-webrtc-candidates"]')).toBeNull();
  });

  it('(S1) the "Exit IP" caption and the measuring line clear WCAG AA (4.5) on the drawer chrome', () => {
    // Measured 2026-09-12 (scene-quality over the real chip in the harness): the caption
    // at text-white/45 was 4.41 on #1d1e24, the measuring line at text-white/40 was 3.77.
    // The gate is the RATIO computed from the class the DOM carries, so a quieter tint
    // that still clears 4.5 passes and one that does not reds — nothing pins a literal.
    const observed = render(<ExitIpChip report={report({ exit_ip: '203.0.113.7' })} />);
    const caption = Array.from(observed.container.querySelectorAll('span')).find(
      (el) => el.textContent === 'Exit IP ',
    );
    expect(caption, 'the "Exit IP " caption span renders').toBeDefined();
    expect(whiteAlphaContrast(caption?.className ?? '')).toBeGreaterThanOrEqual(4.5);

    const measuring = render(<ExitIpChip report={null} />).container.querySelector(
      '[data-component="sim-exit-ip-chip"][data-state="measuring"]',
    );
    expect(whiteAlphaContrast(measuring?.className ?? '')).toBeGreaterThanOrEqual(4.5);

    // INSTRUMENT CONTROL — the two shipped-before values must read as failures, or the
    // ratio above is not measuring anything.
    expect(whiteAlphaContrast('mt-1 text-white/45')).toBeCloseTo(4.41, 2);
    expect(whiteAlphaContrast('mt-1 text-white/40')).toBeCloseTo(3.77, 2);
  });
});

describe('stopOnExitIpChangeCreateFields', () => {
  it('includes stop_on_exit_ip_change:true iff the profile opted in', () => {
    expect(stopOnExitIpChangeCreateFields(meta({ stopOnExitIpChange: true }))).toEqual({
      stop_on_exit_ip_change: true,
    });
  });

  it('omits the flag for a default profile and for absent meta (vacuity)', () => {
    // A default profile has no flag → the fragment is empty (never stop).
    expect(stopOnExitIpChangeCreateFields(meta({}))).toEqual({});
    // An explicit false is treated as off, not written as false.
    expect(stopOnExitIpChangeCreateFields(meta({ stopOnExitIpChange: false }))).toEqual({});
    // No meta at all (a brand-new profile) → empty.
    expect(stopOnExitIpChangeCreateFields(undefined)).toEqual({});
  });
});

// 2026-09-12 review — the WebRTC leak line is a MODE token on fixed-dark chrome.
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

describe('ExitIpChip — the leak line on the simulator chrome', () => {
  it('(review) "⚠ WebRTC: …" wears text-status-error, which clears AA on the #17181d card only at the DARK token — so it depends on the simulator\'s dark scope', () => {
    // T4's light --status-error-rgb (166 53 46) on the Egress card is 2.68; the
    // dark 248 113 113 is 6.41. Same mechanism as the QUIC readout: the chip
    // keeps the token, and the shell that mounts it carries data-mode="dark".
    const { container } = render(
      <ExitIpChip
        report={report({ exit_ip: '203.0.113.7', webrtc_candidate_ips: ['198.51.100.4'] })}
      />,
    );
    const leak = container.querySelector(
      '[data-component="sim-webrtc-candidates"][data-leak="true"]',
    );
    expect(leak?.textContent).toBe('⚠ WebRTC: 198.51.100.4');
    expect(leak?.className.split(/\s+/)).toContain('text-status-error');
    const card: Rgb = [0x17, 0x18, 0x1d];
    expect(wcagContrast(modeRgb('status-error', 'dark'), card)).toBeGreaterThanOrEqual(4.5);
    expect(wcagContrast(modeRgb('status-error', 'dark'), card)).toBeCloseTo(6.41, 1);
    expect(wcagContrast(modeRgb('status-error', 'light'), card)).toBeLessThan(4.5);
    expect(wcagContrast(modeRgb('status-error', 'light'), card)).toBeCloseTo(2.68, 1);
    const shell = readFileSync(join(SRC, 'views', 'SimulatorWindow.tsx'), 'utf8');
    expect(shell).toContain('<ExitIpChip report={sessionCapabilityReport} />');
    expect(shell).toMatch(/<div\s+data-mode="dark"\s+data-component="simulator-shell"/);
  });
});
