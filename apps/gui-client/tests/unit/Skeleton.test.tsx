// W465 — Skeleton loading primitives. Pins the pulse-block contract + the
// accessible status announcement so the loading treatment stays screen-reader
// safe as it rolls out across list views.

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { Skeleton, SkeletonRows } from '../../src/components/Skeleton';

describe('Skeleton', () => {
  afterEach(cleanup);

  it('renders a pulsing block carrying the passed className', () => {
    const { container } = render(<Skeleton className="h-9 w-full" />);
    const el = container.querySelector('.animate-pulse');
    expect(el).not.toBeNull();
    expect(el?.className).toContain('h-9');
  });

  it('SkeletonRows exposes an accessible status label for screen readers', () => {
    render(<SkeletonRows rows={5} label="Loading sessions" />);
    expect(screen.getByRole('status', { name: 'Loading sessions' })).toBeInTheDocument();
    expect(screen.getByText('Loading sessions')).toBeInTheDocument();
  });

  it('renders the requested row count (and defaults to 4)', () => {
    const { container: five } = render(<SkeletonRows rows={5} />);
    expect(five.querySelectorAll('.animate-pulse').length).toBe(5);
    cleanup();
    const { container: def } = render(<SkeletonRows />);
    expect(def.querySelectorAll('.animate-pulse').length).toBe(4);
  });
});
