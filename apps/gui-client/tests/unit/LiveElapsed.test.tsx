// Worktimer (backlog #3) — LiveElapsed component + formatElapsed pins.

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { formatElapsed, LiveElapsed } from '../../src/components/LiveElapsed';

describe('formatElapsed', () => {
  it('renders M:SS under an hour with zero-padded seconds', () => {
    expect(formatElapsed(0)).toBe('0:00');
    expect(formatElapsed(5_000)).toBe('0:05');
    expect(formatElapsed(65_000)).toBe('1:05');
    expect(formatElapsed(12 * 60_000 + 34_000)).toBe('12:34');
    expect(formatElapsed(59 * 60_000 + 59_000)).toBe('59:59');
  });

  it('renders H:MM:SS at/over an hour with zero-padded minutes + seconds', () => {
    expect(formatElapsed(3_600_000)).toBe('1:00:00');
    expect(formatElapsed(3_600_000 + 2 * 60_000 + 3_000)).toBe('1:02:03');
    expect(formatElapsed(25 * 3_600_000 + 5 * 60_000 + 9_000)).toBe('25:05:09');
  });

  it('floors sub-second remainders (does not round up)', () => {
    expect(formatElapsed(1_999)).toBe('0:01');
  });

  it('clamps negative elapsed (clock skew / future start) to 0:00', () => {
    expect(formatElapsed(-5_000)).toBe('0:00');
  });
});

describe('LiveElapsed', () => {
  it('renders the elapsed stopwatch from a fixed nowMs (deterministic, no tick)', () => {
    const start = '2026-06-18T00:00:00.000Z';
    const nowMs = new Date(start).getTime() + (3 * 60_000 + 9_000);
    render(<LiveElapsed iso={start} nowMs={nowMs} />);
    expect(screen.getByText('3:09')).toBeInTheDocument();
  });

  it('exposes the start instant via a prefixed tooltip + a machine dateTime', () => {
    const start = '2026-06-18T00:00:00.000Z';
    render(<LiveElapsed iso={start} nowMs={new Date(start).getTime()} tooltipPrefix="Started" />);
    const el = screen.getByText('0:00');
    expect(el.getAttribute('dateTime')).toBe(start);
    expect(el.getAttribute('title')).toMatch(/^Started: /);
  });

  it('renders an em-dash for an unparseable instant instead of NaN', () => {
    render(<LiveElapsed iso="not-a-date" nowMs={0} />);
    expect(screen.getByText('—')).toBeInTheDocument();
  });
});
