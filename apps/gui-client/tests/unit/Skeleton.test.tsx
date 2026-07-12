// W465 — Skeleton loading primitives. Pins the pulse-block contract + the
// accessible status announcement so the loading treatment stays screen-reader
// safe as it rolls out across list views.

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { Skeleton, SkeletonRegion, SkeletonRows } from '../../src/components/Skeleton';

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

  it('SkeletonRegion announces composite loading states and hides their silhouette', () => {
    render(
      <SkeletonRegion
        label="Loading proxy cards"
        className="status-shell"
        contentClassName="responsive-silhouette"
      >
        <div data-testid="proxy-silhouette">Decorative placeholder</div>
      </SkeletonRegion>,
    );

    expect(screen.getByRole('status', { name: 'Loading proxy cards' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveClass('status-shell');
    expect(screen.getByText('Loading proxy cards')).toHaveClass('sr-only');
    expect(screen.getByTestId('proxy-silhouette').parentElement).toHaveAttribute(
      'aria-hidden',
      'true',
    );
    expect(screen.getByTestId('proxy-silhouette').parentElement).toHaveClass(
      'responsive-silhouette',
    );
  });

  it('renders the requested row count (and defaults to 4)', () => {
    const { container: five } = render(<SkeletonRows rows={5} />);
    expect(five.querySelectorAll('.animate-pulse').length).toBe(5);
    cleanup();
    const { container: def } = render(<SkeletonRows />);
    expect(def.querySelectorAll('.animate-pulse').length).toBe(4);
  });

  it('keeps the default row layout and dimensions', () => {
    const { container } = render(<SkeletonRows rows={1} />);
    expect(container.querySelector('.flex.flex-col.gap-2')).toBeInTheDocument();
    expect(container.querySelector('.animate-pulse')).toHaveClass('h-9', 'w-full');
  });

  it('replaces, rather than merges, row layout and dimensions when customized', () => {
    const { container } = render(
      <SkeletonRows rows={2} layoutClassName="custom-grid" rowClassName="custom-card-shape" />,
    );
    const layout = container.querySelector('.custom-grid');
    const rows = container.querySelectorAll('.animate-pulse');

    expect(layout).toHaveClass('custom-grid');
    expect(layout).not.toHaveClass('flex', 'flex-col', 'gap-2');
    expect(rows).toHaveLength(2);
    rows.forEach((row) => {
      expect(row).toHaveClass('custom-card-shape');
      expect(row).not.toHaveClass('h-9', 'w-full');
    });
  });
});
