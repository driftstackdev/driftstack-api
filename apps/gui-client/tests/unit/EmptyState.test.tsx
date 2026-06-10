// W462 — shared EmptyState primitive. Pins the optional-slot contract so the
// component stays a safe drop-in for any list view's "nothing here yet" block.

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { EmptyState } from '../../src/components/EmptyState';

describe('EmptyState', () => {
  afterEach(cleanup);

  it('renders the title heading (the one required slot)', () => {
    render(<EmptyState title="No sessions yet" />);
    expect(screen.getByRole('heading', { name: 'No sessions yet' })).toBeInTheDocument();
  });

  it('renders the optional description when provided', () => {
    render(<EmptyState title="No profiles" description="Create one to get started." />);
    expect(screen.getByText('Create one to get started.')).toBeInTheDocument();
  });

  it('omits the description paragraph when not provided', () => {
    const { container } = render(<EmptyState title="Empty" />);
    expect(container.querySelector('p')).toBeNull();
  });

  it('renders an optional action (e.g. a CTA button)', () => {
    render(<EmptyState title="No recordings" action={<button type="button">Record</button>} />);
    expect(screen.getByRole('button', { name: 'Record' })).toBeInTheDocument();
  });
});
