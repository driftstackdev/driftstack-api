// V-534.N — unit tests for SessionStatusBadge.

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  SessionStatusBadge,
  sessionStatusLabelFor,
  sessionStatusToneFor,
} from '../../src/components/SessionStatusBadge';

describe('V-534.N sessionStatusLabelFor', () => {
  it('maps every known status to a human-readable label', () => {
    expect(sessionStatusLabelFor('creating')).toBe('Creating');
    expect(sessionStatusLabelFor('ready')).toBe('Ready');
    expect(sessionStatusLabelFor('busy')).toBe('Busy');
    expect(sessionStatusLabelFor('destroyed')).toBe('Destroyed');
    expect(sessionStatusLabelFor('errored')).toBe('Errored');
  });

  it('falls back to the raw status for unknown values', () => {
    expect(sessionStatusLabelFor('future_state')).toBe('future_state');
  });
});

describe('V-534.N sessionStatusToneFor', () => {
  it('ready → success, busy → busy, destroyed → warning, errored → error', () => {
    expect(sessionStatusToneFor('ready')).toBe('success');
    expect(sessionStatusToneFor('busy')).toBe('busy');
    expect(sessionStatusToneFor('destroyed')).toBe('warning');
    expect(sessionStatusToneFor('errored')).toBe('error');
  });

  it('creating → neutral (pre-running ambiguous state)', () => {
    expect(sessionStatusToneFor('creating')).toBe('neutral');
  });

  it('falls back to neutral for unknown statuses', () => {
    expect(sessionStatusToneFor('mystery')).toBe('neutral');
  });
});

describe('V-534.N SessionStatusBadge rendering', () => {
  it('renders the canonical label + role="status"', () => {
    render(<SessionStatusBadge status="ready" />);
    const el = screen.getByRole('status', { name: /session status: ready/i });
    expect(el.textContent).toContain('Ready');
  });

  it('applies tone-specific classes per status', () => {
    const { container: readyEl } = render(<SessionStatusBadge status="ready" />);
    expect(readyEl.querySelector('span')?.className).toContain('status-success');
    const { container: erroredEl } = render(<SessionStatusBadge status="errored" />);
    expect(erroredEl.querySelector('span')?.className).toContain('status-error');
    const { container: busyEl } = render(<SessionStatusBadge status="busy" />);
    expect(busyEl.querySelector('span')?.className).toContain('status-info');
  });

  it('busy state includes an animated pulse dot', () => {
    const { container } = render(<SessionStatusBadge status="busy" />);
    // The inner span carries the animate-pulse class for the dot.
    expect(container.innerHTML).toContain('animate-pulse');
  });

  it('applies size=sm when requested', () => {
    const { container } = render(<SessionStatusBadge status="ready" size="sm" />);
    expect(container.querySelector('span')?.className).toContain('text-xs');
  });

  it('defaults to size=md', () => {
    const { container } = render(<SessionStatusBadge status="ready" />);
    expect(container.querySelector('span')?.className).toContain('text-sm');
  });
});
