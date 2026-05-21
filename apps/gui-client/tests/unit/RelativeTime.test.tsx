// 2026-05-21 — RelativeTime (Slice C) — locks the unit thresholds so
// a careless refactor of the SLICES table can't silently flip
// "1 minute ago" to "60 seconds ago" or similar.

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { RelativeTime } from '../../src/components/RelativeTime';

afterEach(() => cleanup());

const NOW = 1_700_000_000_000; // arbitrary fixed reference

describe('RelativeTime', () => {
  it('renders "now" for diffs under 1 minute', () => {
    const iso = new Date(NOW - 5_000).toISOString();
    render(<RelativeTime iso={iso} nowMs={NOW} />);
    expect(screen.getByText(/now|seconds ago|in 0 seconds/)).toBeInTheDocument();
  });

  it('renders minute precision for diffs 1m–1h', () => {
    const iso = new Date(NOW - 5 * 60_000).toISOString();
    render(<RelativeTime iso={iso} nowMs={NOW} />);
    expect(screen.getByText(/5 min/)).toBeInTheDocument();
  });

  it('renders hour precision for diffs 1h–1d', () => {
    const iso = new Date(NOW - 3 * 3_600_000).toISOString();
    render(<RelativeTime iso={iso} nowMs={NOW} />);
    expect(screen.getByText(/3 hr|3 hours/)).toBeInTheDocument();
  });

  it('renders day precision for diffs 1d–1w', () => {
    const iso = new Date(NOW - 2 * 86_400_000).toISOString();
    render(<RelativeTime iso={iso} nowMs={NOW} />);
    expect(screen.getByText(/yesterday|2 days ago/i)).toBeInTheDocument();
  });

  it('renders month precision for diffs ≥ ~30d', () => {
    const iso = new Date(NOW - 60 * 86_400_000).toISOString();
    render(<RelativeTime iso={iso} nowMs={NOW} />);
    expect(screen.getByText(/2 months|2 mo/i)).toBeInTheDocument();
  });

  it('renders future tense for diffs in the future', () => {
    const iso = new Date(NOW + 2 * 3_600_000).toISOString();
    render(<RelativeTime iso={iso} nowMs={NOW} />);
    expect(screen.getByText(/in 2 hr|in 2 hours/)).toBeInTheDocument();
  });

  it('emits a <time> element with the dateTime attribute pinned to the ISO input', () => {
    const iso = new Date(NOW - 60_000).toISOString();
    render(<RelativeTime iso={iso} nowMs={NOW} />);
    const time = screen.getByText(/1 min/).closest('time');
    expect(time).not.toBeNull();
    expect(time).toHaveAttribute('datetime', iso);
  });

  it('includes the tooltipPrefix in the title attribute when supplied', () => {
    const iso = new Date(NOW - 60_000).toISOString();
    render(<RelativeTime iso={iso} nowMs={NOW} tooltipPrefix="Last used" />);
    const time = screen.getByText(/1 min/).closest('time');
    expect(time?.title).toMatch(/^Last used: /);
  });
});
