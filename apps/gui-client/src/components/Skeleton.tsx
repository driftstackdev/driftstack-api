// Skeleton loading placeholders — pulsing blocks that show a view's shape
// settling in, instead of a bare "Loading…" line (which reads as basic/janky).
// W465: list views previously rendered a plain <p role="status">Loading…</p>;
// SkeletonRows replaces that with the modern placeholder treatment while
// keeping the screen-reader status announcement.
//
// `animate-pulse` is already reduced-motion-safe via the global stylesheet
// (the prefers-reduced-motion block near-instants all animations), so motion-
// sensitive users get a static placeholder rather than a pulse.

import type { JSX, ReactNode } from 'react';

/** A single pulsing placeholder block. Size/shape via `className`. */
export function Skeleton({ className = '' }: { className?: string }): JSX.Element {
  return (
    <div className={`animate-pulse rounded bg-surface-inset ${className}`} aria-hidden="true" />
  );
}

/**
 * Accessible loading region for composite skeletons. The visual silhouette is
 * hidden from assistive technology while the loading label remains announced.
 */
export function SkeletonRegion({
  label = 'Loading…',
  children,
  className,
  contentClassName,
}: {
  label?: string;
  children: ReactNode;
  className?: string;
  contentClassName?: string;
}): JSX.Element {
  return (
    <div role="status" aria-label={label} className={className}>
      <span className="sr-only">{label}</span>
      <div aria-hidden="true" className={contentClassName}>
        {children}
      </div>
    </div>
  );
}

/**
 * N stacked skeleton rows for a list/table loading state, with a visually
 * hidden status line so assistive tech still announces the load.
 */
export function SkeletonRows({
  rows = 4,
  label = 'Loading…',
  layoutClassName,
  rowClassName,
}: {
  rows?: number;
  label?: string;
  /** Replaces the default stacked-row layout when provided. */
  layoutClassName?: string;
  /** Replaces the default row dimensions when provided. */
  rowClassName?: string;
}): JSX.Element {
  return (
    <SkeletonRegion label={label} contentClassName={layoutClassName ?? 'flex flex-col gap-2'}>
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className={rowClassName ?? 'h-9 w-full'} />
      ))}
    </SkeletonRegion>
  );
}
