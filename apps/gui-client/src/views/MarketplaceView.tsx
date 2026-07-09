// F4 (2026-06-14 future-initiatives plan) — profile marketplace, FRONTEND
// PREVIEW ONLY. Founder scope: "start making the frontend on the UI, backend
// when the time is right" — plan the browse/detail surface, do NOT ship
// purchase wiring until a real catalog/inventory/transfer backend exists
// AND the founder signs off (new product line + pricing/ToS, Tier-3 per
// docs/planning/21-agent-autonomy.md).
//
// So this view is entirely client-side mock data (MOCK_LISTINGS below) —
// no network call, no real money, no real profile transfer. The catalog
// derives its archetype labels from the REAL ARCHETYPE_REGISTRY (so this
// never drifts to a stale/removed archetype id) and pairs each with a
// fixed, hand-authored age/warmth/price/signal set. "Buy" is intentionally
// a disabled, explained affordance — never a fake success state.

import { useMemo, useRef, useState } from 'react';
import { EmptyState } from '../components/EmptyState';
import { useFocusTrap } from '../lib/use-focus-trap';
import { ARCHETYPE_REGISTRY } from '@driftstack/sdk';

type WarmthTier = 'cold' | 'warming' | 'aged' | 'trusted';

interface MarketplaceListing {
  id: string;
  archetypeId: string;
  ageDays: number;
  warmthTier: WarmthTier;
  priceCents: number;
  signals: readonly string[];
}

const WARMTH_LABEL: Record<WarmthTier, string> = {
  cold: 'Cold',
  warming: 'Warming up',
  aged: 'Aged',
  trusted: 'Trusted',
};

const WARMTH_CLASSES: Record<WarmthTier, string> = {
  cold: 'bg-surface-inset text-ink-secondary border-surface-divider',
  warming: 'bg-status-busy/15 text-status-busy border-status-busy/30',
  aged: 'bg-status-warning/15 text-status-warning border-status-warning/30',
  trusted: 'bg-status-success/15 text-status-success border-status-success/30',
};

const WARMTH_ORDER: readonly WarmthTier[] = ['trusted', 'aged', 'warming', 'cold'];

// Real archetype ids/labels (never hardcoded strings that could drift from
// the registry) paired with hand-authored preview economics. availableArchetypes
// falls back gracefully — an empty registry just yields an empty catalog
// (handled by the EmptyState below) rather than throwing.
const availableArchetypes = ARCHETYPE_REGISTRY.filter(
  (a) => a.status === 'launch' || a.status === 'available',
);

function archetypeAt(index: number): { id: string; label: string } {
  const a = availableArchetypes[index % Math.max(availableArchetypes.length, 1)];
  return a !== undefined
    ? { id: a.id, label: a.displayLabel }
    : { id: 'unknown', label: 'Unknown device' };
}

const MOCK_LISTING_SEEDS: ReadonlyArray<
  Omit<MarketplaceListing, 'archetypeId'> & { archetypeIndex: number }
> = [
  {
    id: 'mkt_preview_1',
    archetypeIndex: 0,
    ageDays: 214,
    warmthTier: 'trusted',
    priceCents: 4900,
    signals: [
      '180+ warm-browse sessions over 7 months',
      '12 successful checkouts, 0 CAPTCHA triggers',
      'No fingerprint anomalies flagged',
    ],
  },
  {
    id: 'mkt_preview_2',
    archetypeIndex: 1,
    ageDays: 96,
    warmthTier: 'aged',
    priceCents: 2400,
    signals: ['64 browsing sessions over 3 months', '2 successful checkouts'],
  },
  {
    id: 'mkt_preview_3',
    archetypeIndex: 2,
    ageDays: 31,
    warmthTier: 'warming',
    priceCents: 900,
    signals: ['12 warm-browse sessions', 'No purchase history yet'],
  },
  {
    id: 'mkt_preview_4',
    archetypeIndex: 0,
    ageDays: 3,
    warmthTier: 'cold',
    priceCents: 300,
    signals: ['Freshly created — no browsing history yet'],
  },
  {
    id: 'mkt_preview_5',
    archetypeIndex: 3,
    ageDays: 340,
    warmthTier: 'trusted',
    priceCents: 7900,
    signals: [
      '300+ sessions over almost a year',
      '28 successful checkouts across 6 storefronts',
      'No fingerprint anomalies flagged',
    ],
  },
  {
    id: 'mkt_preview_6',
    archetypeIndex: 4,
    ageDays: 58,
    warmthTier: 'aged',
    priceCents: 1900,
    signals: ['40 warm-browse sessions over 2 months', '1 successful checkout'],
  },
];

const MOCK_LISTINGS: readonly MarketplaceListing[] = MOCK_LISTING_SEEDS.map((seed) => ({
  ...seed,
  archetypeId: archetypeAt(seed.archetypeIndex).id,
}));

function fmtPrice(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function fmtAge(days: number): string {
  if (days < 7) return `${days} day${days === 1 ? '' : 's'} old`;
  if (days < 60) return `${Math.round(days / 7)} week${Math.round(days / 7) === 1 ? '' : 's'} old`;
  return `${Math.round(days / 30)} month${Math.round(days / 30) === 1 ? '' : 's'} old`;
}

const STOREFRONT_ICON = (
  <svg
    viewBox="0 0 24 24"
    width="20"
    height="20"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.75"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M3 9 4.75 4h14.5L21 9" />
    <path d="M3 9v10a1.5 1.5 0 0 0 1.5 1.5h15A1.5 1.5 0 0 0 21 19V9" />
    <path d="M3 9a3 3 0 0 0 6 0 3 3 0 0 0 6 0 3 3 0 0 0 6 0" />
  </svg>
);

export function MarketplaceView(): JSX.Element {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [warmthFilter, setWarmthFilter] = useState<WarmthTier | 'all'>('all');
  const [sortKey, setSortKey] = useState<'price-asc' | 'price-desc' | 'age-desc'>('age-desc');

  const filtered = useMemo(() => {
    const base =
      warmthFilter === 'all'
        ? MOCK_LISTINGS
        : MOCK_LISTINGS.filter((l) => l.warmthTier === warmthFilter);
    const sorted = [...base];
    sorted.sort((a, b) => {
      if (sortKey === 'price-asc') return a.priceCents - b.priceCents;
      if (sortKey === 'price-desc') return b.priceCents - a.priceCents;
      return b.ageDays - a.ageDays;
    });
    return sorted;
  }, [warmthFilter, sortKey]);

  const selected = selectedId !== null ? MOCK_LISTINGS.find((l) => l.id === selectedId) : undefined;

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      <header className="flex flex-col gap-1">
        <span className="section-label">Marketplace</span>
        <h2 className="text-lg font-medium tracking-tight text-ink-primary">
          Buy pre-warmed profiles
        </h2>
        <p className="max-w-2xl text-xs text-ink-muted">
          Browse aged, trusted identities warmed up over weeks or months — skip the cold-start
          period on a brand-new profile. This is a preview of the upcoming marketplace; the listings
          below are samples, not real inventory yet.
        </p>
      </header>

      <div
        role="status"
        className="flex items-center gap-2 rounded-md border border-status-warning/30 bg-status-warning/10 px-3 py-2 text-xs text-status-warning"
      >
        <span aria-hidden="true">◐</span>
        <span>
          Preview only — purchases aren&rsquo;t live yet. We&rsquo;re building the catalog + balance
          system behind this; check back soon.
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-xs text-ink-secondary">
          Warmth
          <select
            className="form-input py-1"
            value={warmthFilter}
            onChange={(e) => setWarmthFilter(e.target.value as WarmthTier | 'all')}
          >
            <option value="all">All</option>
            {WARMTH_ORDER.map((tier) => (
              <option key={tier} value={tier}>
                {WARMTH_LABEL[tier]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-xs text-ink-secondary">
          Sort
          <select
            className="form-input py-1"
            value={sortKey}
            onChange={(e) => setSortKey(e.target.value as typeof sortKey)}
          >
            <option value="age-desc">Oldest first</option>
            <option value="price-asc">Price: low to high</option>
            <option value="price-desc">Price: high to low</option>
          </select>
        </label>
        <span className="ml-auto mono text-2xs text-ink-muted">{filtered.length} listed</span>
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          icon={STOREFRONT_ICON}
          title="No listings match that filter"
          description="Try a different warmth tier."
        />
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-auto pb-2 sm:grid-cols-2 xl:grid-cols-3">
          {filtered.map((listing) => (
            <ListingCard
              key={listing.id}
              listing={listing}
              onView={() => setSelectedId(listing.id)}
            />
          ))}
        </div>
      )}

      {selected !== undefined && (
        <DetailModal listing={selected} onClose={() => setSelectedId(null)} />
      )}
    </div>
  );
}

function ListingCard({
  listing,
  onView,
}: {
  listing: MarketplaceListing;
  onView: () => void;
}): JSX.Element {
  const archetype = ARCHETYPE_REGISTRY.find((a) => a.id === listing.archetypeId);
  return (
    <button
      type="button"
      onClick={onView}
      className="flex flex-col items-start gap-2 rounded-lg border border-surface-divider bg-surface-raised p-4 text-left transition-colors hover:border-accent/40 hover:bg-surface-elevated"
    >
      <div className="flex w-full items-start justify-between gap-2">
        <span className="text-sm font-medium text-ink-primary">
          {archetype?.displayLabel ?? 'Unknown device'}
        </span>
        <span
          className={`shrink-0 rounded-full border px-2 py-0.5 text-2xs font-medium ${WARMTH_CLASSES[listing.warmthTier]}`}
        >
          {WARMTH_LABEL[listing.warmthTier]}
        </span>
      </div>
      <span className="text-xs text-ink-muted">{fmtAge(listing.ageDays)}</span>
      <ul className="flex flex-col gap-0.5 text-2xs text-ink-secondary">
        {listing.signals.slice(0, 2).map((s, i) => (
          <li key={i}>· {s}</li>
        ))}
        {listing.signals.length > 2 && (
          <li className="text-ink-muted">+{listing.signals.length - 2} more</li>
        )}
      </ul>
      <span className="mt-1 mono text-base font-medium text-ink-primary">
        {fmtPrice(listing.priceCents)}
      </span>
    </button>
  );
}

function DetailModal({
  listing,
  onClose,
}: {
  listing: MarketplaceListing;
  onClose: () => void;
}): JSX.Element {
  const archetype = ARCHETYPE_REGISTRY.find((a) => a.id === listing.archetypeId);
  const dialogRef = useRef<HTMLDivElement>(null);
  // Focus-trap the dialog, close on Escape, and restore focus to the opener on
  // close — a keyboard user could otherwise tab out into the grid behind it and
  // had no Escape affordance.
  useFocusTrap(true, dialogRef, onClose);
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Profile listing details"
        onClick={(e) => e.stopPropagation()}
        className="flex w-full max-w-md flex-col gap-4 rounded-lg border border-surface-divider bg-surface-raised p-6"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-base font-medium text-ink-primary">
              {archetype?.displayLabel ?? 'Unknown device'}
            </h3>
            <p className="mt-0.5 text-xs text-ink-muted">{fmtAge(listing.ageDays)}</p>
          </div>
          <div className="flex shrink-0 items-start gap-2">
            <span
              className={`rounded-full border px-2 py-0.5 text-2xs font-medium ${WARMTH_CLASSES[listing.warmthTier]}`}
            >
              {WARMTH_LABEL[listing.warmthTier]}
            </span>
            <button
              type="button"
              aria-label="Close"
              onClick={onClose}
              className="-mr-1 -mt-1 rounded p-1 text-ink-muted hover:text-ink-primary"
            >
              ✕
            </button>
          </div>
        </div>

        <ul className="flex flex-col gap-1.5 rounded-md bg-surface-inset px-3 py-2.5 text-sm text-ink-secondary">
          {listing.signals.map((s, i) => (
            <li key={i}>· {s}</li>
          ))}
        </ul>

        <div className="flex items-center justify-between">
          <span className="mono text-lg font-medium text-ink-primary">
            {fmtPrice(listing.priceCents)}
          </span>
        </div>

        <button
          type="button"
          disabled
          title="Marketplace purchases aren't available yet"
          className="w-full cursor-not-allowed rounded-md bg-surface-inset px-4 py-2 text-sm font-medium text-ink-muted"
        >
          Buy — coming soon
        </button>
        <p className="text-2xs text-ink-muted">
          This is a preview of the upcoming profile marketplace. Purchases will mint the profile
          straight into your account once the catalog and balance system are live.
        </p>

        <button
          type="button"
          onClick={onClose}
          className="self-end text-xs text-ink-secondary hover:text-ink-primary"
        >
          Close
        </button>
      </div>
    </div>
  );
}
